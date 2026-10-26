import type { Db } from '../db/connection';
import { transact, type Actor } from '../db/tx';
import type { AppEnv } from './env';
import { accountBalance, postLedger, type LedgerLine } from './ledger';
import { AppError, ErrorCodes } from '@shared/errors';
import { formatMoney } from '@shared/money';
import { businessDateOf } from '@shared/time';
import type { CashCountRow, CashDay, CashEntryRow, CashEntryType, CashFlowLine, Paged } from '@shared/contracts';

const ENTRY_LABELS: Record<CashEntryType, string> = {
  CASH_IN: 'Cash added by the owner',
  DRAWING: 'Owner drawings',
  BANK_DEPOSIT: 'Deposited in the bank',
  BANK_WITHDRAWAL: 'Withdrawn from the bank',
};

/** Ledger lines of a cash entry: cash against owner's equity or the bank. */
function entryLines(type: CashEntryType, amount: number): LedgerLine[] {
  switch (type) {
    case 'CASH_IN':
      return [
        { account: 'CASH', debit: amount },
        { account: 'OWNER_EQUITY', credit: amount },
      ];
    case 'DRAWING':
      return [
        { account: 'OWNER_EQUITY', debit: amount },
        { account: 'CASH', credit: amount },
      ];
    case 'BANK_DEPOSIT':
      return [
        { account: 'BANK', debit: amount },
        { account: 'CASH', credit: amount },
      ];
    case 'BANK_WITHDRAWAL':
      return [
        { account: 'CASH', debit: amount },
        { account: 'BANK', credit: amount },
      ];
  }
}

const takesCash = (type: CashEntryType) => type === 'DRAWING' || type === 'BANK_DEPOSIT';

/** Cash the records say is in the drawer right now. */
export function expectedCash(db: Db): number {
  return accountBalance(db, 'CASH');
}

function assertCashAvailable(db: Db, amount: number): void {
  const cash = expectedCash(db);
  if (amount > cash) {
    throw new AppError(
      ErrorCodes.BUSINESS_RULE,
      `The records show only ${formatMoney(cash)} in the drawer. Count the cash first (a count corrects the expected amount), or record cash added.`,
    );
  }
}

export function addCashEntry(env: AppEnv, actor: Actor, input: { requestId: string; type: CashEntryType; amount: number; reason: string }): CashEntryRow {
  const id = transact(env, actor, (tx) =>
    tx.once(input.requestId, 'cash.addEntry', () => {
      if (takesCash(input.type)) assertCashAvailable(tx.db, input.amount);
      const entryNo = tx.nextDocNumber('CASH_ENTRY');
      const newId = Number(
        tx.db
          .prepare(
            `INSERT INTO cash_entries (entry_no, client_request_id, type, amount, reason, created_at, business_date, user_id, txn_ref)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(entryNo, input.requestId, input.type, input.amount, input.reason, tx.nowIso, tx.businessDate, tx.actor.userId, tx.txnRef).lastInsertRowid,
      );
      postLedger(tx, { refType: 'CASH_ENTRY', refId: newId, memo: `${entryNo} ${ENTRY_LABELS[input.type]}: ${input.reason}`, lines: entryLines(input.type, input.amount) });
      tx.audit({
        module: 'cash',
        entityType: 'cash_entry',
        entityId: newId,
        action: `CASH_${input.type}`,
        after: { entryNo, amount: input.amount },
        reason: input.reason,
      });
      return newId;
    }),
  );
  return getCashEntry(env.db, id);
}

export function reverseCashEntry(env: AppEnv, actor: Actor, input: { id: number; reason: string }): CashEntryRow {
  transact(env, actor, (tx) => {
    const e = tx.db.prepare('SELECT * FROM cash_entries WHERE id = ?').get(input.id) as
      | { id: number; entry_no: string; type: CashEntryType; amount: number }
      | undefined;
    if (!e) throw new AppError(ErrorCodes.NOT_FOUND, 'Cash entry not found.');
    if (tx.db.prepare('SELECT 1 FROM cash_entry_reversals WHERE cash_entry_id = ?').get(e.id)) {
      throw new AppError(ErrorCodes.BUSINESS_RULE, `${e.entry_no} has already been reversed.`);
    }
    // Undoing cash that came in takes it back out of the drawer.
    if (!takesCash(e.type)) assertCashAvailable(tx.db, e.amount);
    tx.db
      .prepare('INSERT INTO cash_entry_reversals (cash_entry_id, reason, user_id, reversed_at, business_date, txn_ref) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.id, input.reason, tx.actor.userId, tx.nowIso, tx.businessDate, tx.txnRef);
    postLedger(tx, {
      refType: 'CASH_ENTRY_REVERSAL',
      refId: e.id,
      memo: `${e.entry_no} reversed: ${input.reason}`,
      lines: entryLines(e.type, e.amount).map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
    });
    tx.audit({
      module: 'cash',
      entityType: 'cash_entry',
      entityId: e.id,
      action: 'REVERSE',
      before: { status: 'RECORDED', amount: e.amount },
      after: { status: 'REVERSED' },
      reason: input.reason,
    });
  });
  return getCashEntry(env.db, input.id);
}

/**
 * Records a count of the drawer. The difference from what the records expect is posted to
 * cash over/short, so the expected cash matches what is really there from now on. A
 * difference needs an explanation.
 */
export function countCash(
  env: AppEnv,
  actor: Actor,
  input: { requestId: string; counted: number; denominations: Record<string, number> | null; note: string },
): CashCountRow {
  const id = transact(env, actor, (tx) =>
    tx.once(input.requestId, 'cash.count', () => {
      if (input.denominations) {
        const total = Object.entries(input.denominations).reduce((a, [face, n]) => a + Number(face) * 100 * n, 0);
        if (total !== input.counted) {
          throw new AppError(ErrorCodes.VALIDATION, `The notes and coins add up to ${formatMoney(total)}, not ${formatMoney(input.counted)}.`);
        }
      }
      const expected = expectedCash(tx.db);
      const difference = input.counted - expected;
      if (difference !== 0 && input.note.trim().length < 3) {
        throw new AppError(
          ErrorCodes.VALIDATION,
          `The drawer is ${difference > 0 ? 'over' : 'short'} by ${formatMoney(Math.abs(difference))}. Explain the difference before saving.`,
        );
      }
      const newId = Number(
        tx.db
          .prepare(
            `INSERT INTO cash_counts (business_date, counted_at, expected, counted, difference, denominations_json, note, user_id, txn_ref)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            tx.businessDate,
            tx.nowIso,
            expected,
            input.counted,
            difference,
            input.denominations ? JSON.stringify(input.denominations) : null,
            input.note,
            tx.actor.userId,
            tx.txnRef,
          ).lastInsertRowid,
      );
      const abs = Math.abs(difference);
      postLedger(tx, {
        refType: 'CASH_COUNT',
        refId: newId,
        memo: `Cash count ${difference > 0 ? 'over' : 'short'}: ${input.note}`,
        lines:
          difference > 0
            ? [
                { account: 'CASH', debit: abs },
                { account: 'CASH_OVER_SHORT', credit: abs },
              ]
            : [
                { account: 'CASH_OVER_SHORT', debit: abs },
                { account: 'CASH', credit: abs },
              ],
      });
      tx.audit({
        module: 'cash',
        entityType: 'cash_count',
        entityId: newId,
        action: difference === 0 ? 'CASH_COUNTED' : difference > 0 ? 'CASH_OVER' : 'CASH_SHORT',
        after: { expectedAmount: expected, countedAmount: input.counted, differenceAmount: difference },
        reason: input.note || null,
      });
      return newId;
    }),
  );
  return getCashCount(env.db, id);
}

// ---------- Queries ----------

interface EntryRecord {
  id: number;
  entry_no: string;
  type: CashEntryType;
  amount: number;
  reason: string;
  created_at: string;
  business_date: string;
  username: string | null;
  reversed_at: string | null;
  reversal_reason: string | null;
  reversed_by: string | null;
}

const ENTRY_SELECT = `
  SELECT e.*, u.username, r.reversed_at, r.reason AS reversal_reason, ru.username AS reversed_by
  FROM cash_entries e
  LEFT JOIN users u ON u.id = e.user_id
  LEFT JOIN cash_entry_reversals r ON r.cash_entry_id = e.id
  LEFT JOIN users ru ON ru.id = r.user_id`;

const toEntry = (r: EntryRecord): CashEntryRow => ({
  id: r.id,
  entryNo: r.entry_no,
  type: r.type,
  amount: r.amount,
  reason: r.reason,
  createdAt: r.created_at,
  businessDate: r.business_date,
  username: r.username,
  reversal: r.reversed_at ? { at: r.reversed_at, reason: r.reversal_reason ?? '', username: r.reversed_by } : null,
});

export function getCashEntry(db: Db, id: number): CashEntryRow {
  const r = db.prepare(`${ENTRY_SELECT} WHERE e.id = ?`).get(id) as EntryRecord | undefined;
  if (!r) throw new AppError(ErrorCodes.NOT_FOUND, 'Cash entry not found.');
  return toEntry(r);
}

interface CountRecord {
  id: number;
  business_date: string;
  counted_at: string;
  expected: number;
  counted: number;
  difference: number;
  denominations_json: string | null;
  note: string;
  username: string | null;
}

const COUNT_SELECT = 'SELECT c.*, u.username FROM cash_counts c LEFT JOIN users u ON u.id = c.user_id';

const toCount = (r: CountRecord): CashCountRow => ({
  id: r.id,
  businessDate: r.business_date,
  countedAt: r.counted_at,
  expected: r.expected,
  counted: r.counted,
  difference: r.difference,
  denominations: r.denominations_json ? (JSON.parse(r.denominations_json) as Record<string, number>) : null,
  note: r.note,
  username: r.username,
});

export function getCashCount(db: Db, id: number): CashCountRow {
  const r = db.prepare(`${COUNT_SELECT} WHERE c.id = ?`).get(id) as CountRecord | undefined;
  if (!r) throw new AppError(ErrorCodes.NOT_FOUND, 'Cash count not found.');
  return toCount(r);
}

export function listCashCounts(db: Db, f: { from?: string; to?: string; page: number; pageSize: number }): Paged<CashCountRow> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.from) {
    where.push('c.business_date >= ?');
    params.push(f.from);
  }
  if (f.to) {
    where.push('c.business_date <= ?');
    params.push(f.to);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM cash_counts c ${clause}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`${COUNT_SELECT} ${clause} ORDER BY c.id DESC LIMIT ? OFFSET ?`)
    .all(...params, f.pageSize, (f.page - 1) * f.pageSize) as CountRecord[];
  return { rows: rows.map(toCount), total, page: f.page, pageSize: f.pageSize };
}

/** How each kind of ledger entry shows in the cash book. Reversals and corrections net with what they correct. */
const FLOW_KEYS: Record<string, { key: string; label: string }> = {
  PAYMENT: { key: 'CUSTOMER_PAYMENTS', label: 'Payments from customers' },
  PAYMENT_REVERSAL: { key: 'CUSTOMER_REVERSALS', label: 'Customer payments reversed' },
  REFUND: { key: 'CUSTOMER_REFUNDS', label: 'Refunds to customers' },
  DEPOSIT_COLLECT: { key: 'DEPOSITS_IN', label: 'Rental deposits collected' },
  DEPOSIT_REFUND: { key: 'DEPOSITS_OUT', label: 'Rental deposits refunded' },
  SUPPLIER_PAYMENT: { key: 'SUPPLIER_PAYMENTS', label: 'Paid to suppliers' },
  SUPPLIER_REFUND: { key: 'SUPPLIER_REFUNDS', label: 'Refunds from suppliers' },
  SUPPLIER_PAYMENT_REVERSAL: { key: 'SUPPLIER_REVERSALS', label: 'Supplier payments reversed' },
  EXPENSE: { key: 'EXPENSES', label: 'Expenses' },
  EXPENSE_CORRECTION: { key: 'EXPENSES', label: 'Expenses' },
  CASH_COUNT: { key: 'COUNT_DIFFERENCES', label: 'Count differences (over / short)' },
};

/** The cash drawer for one day, worked out from the ledger: opening, money in and out by kind, expected closing. */
export function cashDay(env: AppEnv, date?: string): CashDay {
  const db = env.db;
  const today = businessDateOf(env.clock.now(), env.timeZone);
  const day = date ?? today;
  const cashId = (db.prepare("SELECT id FROM accounts WHERE code = 'CASH'").get() as { id: number }).id;
  const opening = (
    db.prepare('SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries WHERE account_id = ? AND business_date < ?').get(cashId, day) as {
      b: number;
    }
  ).b;
  const rows = db
    .prepare(
      `SELECT l.ref_type, l.ref_id, l.txn_ref, SUM(l.debit) AS debit, SUM(l.credit) AS credit,
              (SELECT type FROM cash_entries e WHERE e.id = l.ref_id AND l.ref_type IN ('CASH_ENTRY', 'CASH_ENTRY_REVERSAL')) AS entry_type
       FROM ledger_entries l WHERE l.account_id = ? AND l.business_date = ?
       GROUP BY l.txn_ref, l.ref_type, l.ref_id`,
    )
    .all(cashId, day) as { ref_type: string; ref_id: string; txn_ref: string; debit: number; credit: number; entry_type: CashEntryType | null }[];

  // Counted by record, so an expense corrected once still counts as one expense.
  const flows = new Map<string, CashFlowLine & { refs: Set<string> }>();
  for (const r of rows) {
    const k = r.entry_type
      ? { key: r.entry_type, label: ENTRY_LABELS[r.entry_type] }
      : (FLOW_KEYS[r.ref_type] ?? { key: r.ref_type, label: r.ref_type.replace(/_/g, ' ').toLowerCase() });
    const f = flows.get(k.key) ?? { key: k.key, label: k.label, amount: 0, count: 0, refs: new Set<string>() };
    f.amount += r.debit - r.credit;
    f.refs.add(r.ref_id);
    f.count = f.refs.size;
    flows.set(k.key, f);
  }
  const all = [...flows.values()].filter((f) => f.amount !== 0).map(({ refs: _refs, ...f }) => f);
  const inflows = all.filter((f) => f.amount > 0).sort((a, b) => b.amount - a.amount);
  const outflows = all
    .filter((f) => f.amount < 0)
    .map((f) => ({ ...f, amount: -f.amount }))
    .sort((a, b) => b.amount - a.amount);
  const totalIn = inflows.reduce((a, f) => a + f.amount, 0);
  const totalOut = outflows.reduce((a, f) => a + f.amount, 0);

  const otherMethods = (
    db
      .prepare(
        `SELECT a.name, COALESCE(SUM(l.debit), 0) AS received, COALESCE(SUM(l.credit), 0) AS paid
         FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
         WHERE a.code IN ('UPI', 'CARD', 'BANK', 'CHEQUE') AND l.business_date = ?
         GROUP BY a.id ORDER BY a.name`,
      )
      .all(day) as { name: string; received: number; paid: number }[]
  ).map((r) => ({ methodName: r.name, received: r.received, paid: r.paid }));

  return {
    date: day,
    isToday: day === today,
    opening,
    inflows,
    outflows,
    totalIn,
    totalOut,
    closing: opening + totalIn - totalOut,
    counts: (db.prepare(`${COUNT_SELECT} WHERE c.business_date = ? ORDER BY c.id`).all(day) as CountRecord[]).map(toCount),
    entries: (db.prepare(`${ENTRY_SELECT} WHERE e.business_date = ? ORDER BY e.id`).all(day) as EntryRecord[]).map(toEntry),
    otherMethods,
  };
}
