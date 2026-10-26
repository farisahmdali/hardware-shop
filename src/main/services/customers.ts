import type { Db } from '../db/connection';
import { transact, type Actor, type Tx } from '../db/tx';
import type { AppEnv } from './env';
import { applyCreditFifo, availableCredit } from './allocations';
import { postLedger } from './ledger';
import { getAllSettings } from './settings';
import { toFtsQuery } from './products';
import { AppError, ErrorCodes } from '@shared/errors';
import { formatMoney } from '@shared/money';
import { businessDateOf, fiscalYearOf } from '@shared/time';
import type { CustomerDetail, CustomerLedger, CustomerRow, LedgerRow, Paged } from '@shared/contracts';

export interface CustomerFields {
  name: string;
  phone: string;
  address: string;
  businessName: string;
  gstin: string;
  stateCode: string;
  creditDays: number | null;
  creditLimit: number;
  notes: string;
}

interface CustomerRecord {
  id: number;
  code: string;
  name: string;
  phone: string;
  address: string;
  business_name: string;
  gstin: string;
  state_code: string;
  credit_days: number | null;
  credit_limit: number;
  notes: string;
  is_walkin: number;
  is_active: number;
  created_at: string;
  updated_at: string;
  version: number;
  balance: number;
  overdue: number;
}

export function walkInCustomerId(db: Db): number {
  return (db.prepare('SELECT id FROM customers WHERE is_walkin = 1').get() as { id: number }).id;
}

function arAccountId(db: Db): number {
  return (db.prepare("SELECT id FROM accounts WHERE code = 'AR'").get() as { id: number }).id;
}

const SETTLED_INVOICE = "COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.target_type = 'INVOICE' AND a.target_id = i.id), 0)";
const SETTLED_ADJUSTMENT = "COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.target_type = 'ADJUSTMENT' AND a.target_id = b.id), 0)";

/**
 * Customer columns plus the ledger balance and overdue amount, both derived from records. Each is
 * worked out per customer row (by index), only for the customers the query returns; summing
 * every customer's history first made the list take over a second on a large shop. The walk-in
 * customer never has a balance (walk-in sales are paid in full and its returns refunded; the
 * data check confirms it), and its history is the largest, so it is not summed.
 */
function customerSelect(db: Db, asOf: string): { sql: string; params: unknown[] } {
  return {
    // Filters may use the aliases balance and overdue (SQLite resolves them in WHERE). Overdue is
    // v_receivables (open, uncancelled bills and positive adjustments past their due date) written
    // against the tables: SQLite cannot narrow the view to one customer inside a per-row
    // subquery, and `+` keeps it from scanning every bill by due date instead of by customer.
    sql: `SELECT c.*,
        CASE WHEN c.is_walkin = 1 THEN 0 ELSE COALESCE((SELECT SUM(l.debit - l.credit) FROM ledger_entries l
          WHERE l.party_type = 'CUSTOMER' AND l.party_id = c.id AND l.account_id = ?), 0) END AS balance,
        CASE WHEN c.is_walkin = 1 THEN 0 ELSE
          COALESCE((SELECT SUM(i.grand_total - ${SETTLED_INVOICE}) FROM invoices i
            WHERE i.customer_id = c.id AND +i.due_date < ? AND i.grand_total > ${SETTLED_INVOICE}
              AND NOT EXISTS (SELECT 1 FROM invoice_cancellations x WHERE x.invoice_id = i.id)), 0)
          + COALESCE((SELECT SUM(b.amount - ${SETTLED_ADJUSTMENT}) FROM balance_adjustments b
            WHERE b.customer_id = c.id AND b.amount > 0 AND +b.business_date < ? AND b.amount > ${SETTLED_ADJUSTMENT}), 0)
        END AS overdue
      FROM customers c`,
    params: [arAccountId(db), asOf, asOf],
  };
}

const toRow = (r: CustomerRecord): CustomerRow => ({
  id: r.id,
  code: r.code,
  name: r.name,
  phone: r.phone,
  businessName: r.business_name,
  gstin: r.gstin,
  stateCode: r.state_code,
  balance: r.balance,
  overdue: r.overdue,
  isActive: r.is_active === 1,
  isWalkin: r.is_walkin === 1,
});

export function listCustomers(
  db: Db,
  f: { search?: string; filter: 'ALL' | 'OWES' | 'OVERDUE' | 'CREDIT'; active: 'ACTIVE' | 'INACTIVE' | 'ALL'; includeWalkin: boolean; page: number; pageSize: number },
  asOf: string,
): Paged<CustomerRow> {
  const base = customerSelect(db, asOf);
  const where: string[] = [];
  const params: unknown[] = [];
  if (!f.includeWalkin) where.push('c.is_walkin = 0');
  if (f.active !== 'ALL') where.push(`c.is_active = ${f.active === 'ACTIVE' ? 1 : 0}`);
  if (f.filter === 'OWES') where.push('balance > 0');
  if (f.filter === 'CREDIT') where.push('balance < 0');
  if (f.filter === 'OVERDUE') where.push('overdue > 0');
  const order: string[] = [];
  const orderParams: unknown[] = [];
  if (f.search) {
    const fts = toFtsQuery(f.search);
    const digits = f.search.replace(/\D/g, '');
    const parts: string[] = [];
    if (fts) {
      parts.push('c.id IN (SELECT rowid FROM customers_fts WHERE customers_fts MATCH ?)');
      params.push(fts);
    }
    if (digits.length >= 4) {
      parts.push("replace(replace(c.phone, ' ', ''), '-', '') LIKE ?");
      params.push(`%${digits}%`);
    }
    parts.push('c.code = ?');
    params.push(f.search);
    where.push(`(${parts.join(' OR ')})`);
    order.push('(c.code = ?) DESC');
    orderParams.push(f.search);
  }
  order.push('c.is_walkin DESC', 'c.name COLLATE NOCASE', 'c.id');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM (${base.sql} ${clause})`).get(...base.params, ...params) as { n: number }).n;
  const rows = db
    .prepare(`${base.sql} ${clause} ORDER BY ${order.join(', ')} LIMIT ? OFFSET ?`)
    .all(...base.params, ...params, ...orderParams, f.pageSize, (f.page - 1) * f.pageSize) as CustomerRecord[];
  return { rows: rows.map(toRow), total, page: f.page, pageSize: f.pageSize };
}

function loadCustomer(db: Db, id: number, asOf: string): CustomerRecord {
  const base = customerSelect(db, asOf);
  const r = db.prepare(`${base.sql} WHERE c.id = ?`).get(...base.params, id) as CustomerRecord | undefined;
  if (!r) throw new AppError(ErrorCodes.NOT_FOUND, 'Customer not found.');
  return r;
}

export function getCustomer(db: Db, id: number, asOf: string): CustomerDetail {
  const r = loadCustomer(db, id, asOf);
  // The walk-in customer never owes or holds credit (see customerSelect); its history is not summed.
  const walkIn = r.is_walkin === 1;
  const outstanding = walkIn
    ? 0
    : (
        db
          .prepare('SELECT COALESCE(SUM(outstanding), 0) AS n FROM v_receivables WHERE customer_id = ? AND cancelled = 0 AND outstanding > 0')
          .get(id) as { n: number }
      ).n;
  const stats = db
    .prepare('SELECT COUNT(*) AS n, MAX(business_date) AS last FROM invoices WHERE customer_id = ?')
    .get(id) as { n: number; last: string | null };
  return {
    ...toRow(r),
    address: r.address,
    creditDays: r.credit_days,
    effectiveCreditDays: r.credit_days ?? getAllSettings(db).receivables.defaultCreditDays,
    creditLimit: r.credit_limit,
    notes: r.notes,
    outstanding,
    availableCredit: walkIn ? 0 : availableCredit(db, id),
    invoiceCount: stats.n,
    lastInvoiceDate: stats.last,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: r.version,
  };
}

function auditSnapshot(db: Db, id: number) {
  const r = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as CustomerRecord;
  return {
    code: r.code,
    name: r.name,
    phone: r.phone,
    address: r.address,
    businessName: r.business_name,
    gstin: r.gstin,
    stateCode: r.state_code,
    creditDays: r.credit_days,
    creditLimit: r.credit_limit,
    notes: r.notes,
    isActive: r.is_active === 1,
  };
}

function warnDuplicatePhone(tx: Tx, phone: string, exceptId?: number): void {
  if (!phone) return;
  const dup = tx.db
    .prepare('SELECT name FROM customers WHERE phone = ? AND id != ? AND is_active = 1')
    .get(phone, exceptId ?? -1) as { name: string } | undefined;
  if (dup) throw new AppError(ErrorCodes.CONFLICT, `${dup.name} already uses the phone number ${phone}.`);
}

export function createCustomer(
  env: AppEnv,
  actor: Actor,
  input: CustomerFields & { requestId: string; openingBalance: number },
): CustomerDetail {
  const id = transact(env, actor, (tx) =>
    tx.once(input.requestId, 'customers.create', () => {
      warnDuplicatePhone(tx, input.phone);
      const code = tx.nextCode('CUSTOMER', 'C', 5, 'customers', 'code');
      const newId = Number(
        tx.db
          .prepare(
            `INSERT INTO customers (code, name, phone, address, business_name, gstin, state_code, credit_days, credit_limit,
               notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            code,
            input.name,
            input.phone,
            input.address,
            input.businessName,
            input.gstin,
            input.stateCode || (input.gstin ? input.gstin.slice(0, 2) : ''),
            input.creditDays,
            input.creditLimit,
            input.notes,
            tx.nowIso,
            tx.nowIso,
          ).lastInsertRowid,
      );
      tx.audit({ module: 'customers', entityType: 'customer', entityId: newId, action: 'CREATE', after: auditSnapshot(tx.db, newId) });
      if (input.openingBalance !== 0) {
        insertAdjustment(tx, newId, 'OPENING', input.openingBalance, 'Opening balance when the customer was added');
      }
      return newId;
    }),
  );
  return getCustomer(env.db, id, businessDateOf(env.clock.now()));
}

export function updateCustomer(
  env: AppEnv,
  actor: Actor,
  input: CustomerFields & { id: number; version: number; reason?: string },
): CustomerDetail {
  transact(env, actor, (tx) => {
    const current = tx.db.prepare('SELECT is_walkin FROM customers WHERE id = ?').get(input.id) as { is_walkin: number } | undefined;
    if (!current) throw new AppError(ErrorCodes.NOT_FOUND, 'Customer not found.');
    if (current.is_walkin) throw new AppError(ErrorCodes.BUSINESS_RULE, 'The walk-in customer cannot be edited.');
    warnDuplicatePhone(tx, input.phone, input.id);
    const before = auditSnapshot(tx.db, input.id);
    const result = tx.db
      .prepare(
        `UPDATE customers SET name = ?, phone = ?, address = ?, business_name = ?, gstin = ?, state_code = ?, credit_days = ?,
           credit_limit = ?, notes = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`,
      )
      .run(
        input.name,
        input.phone,
        input.address,
        input.businessName,
        input.gstin,
        input.stateCode || (input.gstin ? input.gstin.slice(0, 2) : ''),
        input.creditDays,
        input.creditLimit,
        input.notes,
        tx.nowIso,
        input.id,
        input.version,
      );
    tx.expectOneChange(result.changes, 'This customer');
    const after = auditSnapshot(tx.db, input.id);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      tx.audit({ module: 'customers', entityType: 'customer', entityId: input.id, action: 'UPDATE', before, after, reason: input.reason ?? null });
    }
  });
  return getCustomer(env.db, input.id, businessDateOf(env.clock.now()));
}

export function setCustomerActive(
  env: AppEnv,
  actor: Actor,
  input: { id: number; version: number; isActive: boolean; reason: string },
): CustomerDetail {
  transact(env, actor, (tx) => {
    const c = tx.db.prepare('SELECT is_walkin FROM customers WHERE id = ?').get(input.id) as { is_walkin: number } | undefined;
    if (!c) throw new AppError(ErrorCodes.NOT_FOUND, 'Customer not found.');
    if (c.is_walkin) throw new AppError(ErrorCodes.BUSINESS_RULE, 'The walk-in customer cannot be deactivated.');
    const result = tx.db
      .prepare('UPDATE customers SET is_active = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
      .run(input.isActive ? 1 : 0, tx.nowIso, input.id, input.version);
    tx.expectOneChange(result.changes, 'This customer');
    tx.audit({
      module: 'customers',
      entityType: 'customer',
      entityId: input.id,
      action: input.isActive ? 'REACTIVATE' : 'DEACTIVATE',
      before: { isActive: !input.isActive },
      after: { isActive: input.isActive },
      reason: input.reason,
    });
  });
  return getCustomer(env.db, input.id, businessDateOf(env.clock.now()));
}

// ---------- Balance adjustments ----------

function insertAdjustment(tx: Tx, customerId: number, kind: 'OPENING' | 'ADJUSTMENT', amount: number, reason: string): number {
  const id = Number(
    tx.db
      .prepare(
        `INSERT INTO balance_adjustments (customer_id, kind, amount, reason, created_at, business_date, user_id, txn_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(customerId, kind, amount, reason, tx.nowIso, tx.businessDate, tx.actor.userId, tx.txnRef).lastInsertRowid,
  );
  const counter = kind === 'OPENING' ? 'OWNER_EQUITY' : 'BALANCE_ADJUSTMENTS';
  const abs = Math.abs(amount);
  postLedger(tx, {
    refType: 'BALANCE_ADJUSTMENT',
    refId: id,
    memo: `${kind === 'OPENING' ? 'Opening balance' : 'Balance adjustment'}: ${reason}`,
    lines:
      amount > 0
        ? [
            { account: 'AR', debit: abs, partyType: 'CUSTOMER', partyId: customerId },
            { account: counter, credit: abs },
          ]
        : [
            { account: counter, debit: abs },
            { account: 'AR', credit: abs, partyType: 'CUSTOMER', partyId: customerId },
          ],
  });
  tx.audit({
    module: 'customers',
    entityType: 'customer',
    entityId: customerId,
    action: kind === 'OPENING' ? 'OPENING_BALANCE' : 'BALANCE_ADJUSTED',
    after: { amount, adjustmentId: id },
    reason,
    relatedType: 'balance_adjustment',
    relatedId: id,
  });
  // A credit settles the oldest unpaid bills; a new amount owed is settled by any credit already held.
  applyCreditFifo(tx, customerId);
  return id;
}

export function adjustBalance(
  env: AppEnv,
  actor: Actor,
  input: { requestId: string; customerId: number; kind: 'OPENING' | 'ADJUSTMENT'; amount: number; reason: string },
): CustomerDetail {
  transact(env, actor, (tx) =>
    tx.once(input.requestId, 'customers.adjustBalance', () => {
      const c = tx.db.prepare('SELECT is_walkin FROM customers WHERE id = ?').get(input.customerId) as { is_walkin: number } | undefined;
      if (!c) throw new AppError(ErrorCodes.NOT_FOUND, 'Customer not found.');
      if (c.is_walkin) throw new AppError(ErrorCodes.BUSINESS_RULE, 'The walk-in customer cannot carry a balance.');
      return insertAdjustment(tx, input.customerId, input.kind, input.amount, input.reason);
    }),
  );
  return getCustomer(env.db, input.customerId, businessDateOf(env.clock.now()));
}

// ---------- Ledger ----------

const LEDGER_DOCS = `
  CASE l.ref_type
    WHEN 'INVOICE' THEN (SELECT invoice_no FROM invoices WHERE id = l.ref_id)
    WHEN 'INVOICE_CANCEL' THEN (SELECT invoice_no FROM invoices WHERE id = l.ref_id)
    WHEN 'CREDIT_NOTE' THEN (SELECT credit_note_no FROM credit_notes WHERE id = l.ref_id)
    WHEN 'BALANCE_ADJUSTMENT' THEN 'ADJ-' || l.ref_id
    ELSE (SELECT payment_no FROM payments WHERE id = l.ref_id)
  END`;

const DESCRIPTIONS: Record<string, string> = {
  INVOICE: 'Sale invoice',
  INVOICE_CANCEL: 'Invoice cancelled',
  PAYMENT: 'Payment received',
  REFUND: 'Refund paid',
  PAYMENT_REVERSAL: 'Payment reversed',
  CREDIT_NOTE: 'Credit note (goods returned)',
  BALANCE_ADJUSTMENT: 'Balance adjustment',
};

const LEDGER_LIMIT = 5000;

/** The customer's account from the ledger: every amount owed and settled, with a running balance. */
export function customerLedger(db: Db, customerId: number, range: { from?: string; to?: string }, asOf: string): CustomerLedger {
  loadCustomer(db, customerId, asOf);
  const todayDate = asOf;
  const fy = fiscalYearOf(todayDate);
  const from = range.from ?? `${fy.slice(0, 4)}-04-01`;
  const to = range.to ?? todayDate;
  const ar = arAccountId(db);
  const opening = (
    db
      .prepare(
        `SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries
         WHERE account_id = ? AND party_type = 'CUSTOMER' AND party_id = ? AND business_date < ?`,
      )
      .get(ar, customerId, from) as { b: number }
  ).b;
  const raw = db
    .prepare(
      `SELECT l.occurred_at, l.business_date, l.ref_type, l.ref_id, l.memo, SUM(l.debit) AS debit, SUM(l.credit) AS credit,
              ${LEDGER_DOCS} AS doc_no
       FROM ledger_entries l
       WHERE l.account_id = ? AND l.party_type = 'CUSTOMER' AND l.party_id = ? AND l.business_date BETWEEN ? AND ?
       GROUP BY l.txn_ref, l.ref_type, l.ref_id
       ORDER BY l.occurred_at, l.id
       LIMIT ?`,
    )
    .all(ar, customerId, from, to, LEDGER_LIMIT + 1) as {
    occurred_at: string;
    business_date: string;
    ref_type: string;
    ref_id: string;
    memo: string | null;
    debit: number;
    credit: number;
    doc_no: string | null;
  }[];
  const truncated = raw.length > LEDGER_LIMIT;
  let balance = opening;
  let totalDebit = 0;
  let totalCredit = 0;
  const rows: LedgerRow[] = raw.slice(0, LEDGER_LIMIT).map((r) => {
    balance += r.debit - r.credit;
    totalDebit += r.debit;
    totalCredit += r.credit;
    return {
      occurredAt: r.occurred_at,
      businessDate: r.business_date,
      refType: r.ref_type,
      refId: r.ref_id,
      docNo: r.doc_no ?? '',
      description: r.ref_type === 'BALANCE_ADJUSTMENT' && r.memo ? r.memo : (DESCRIPTIONS[r.ref_type] ?? r.ref_type),
      debit: r.debit,
      credit: r.credit,
      balance,
    };
  });
  return { from, to, openingBalance: opening, rows, closingBalance: balance, totalDebit, totalCredit, truncated };
}

/** One-line description of a customer's position, used in messages. */
export function describeBalance(balance: number): string {
  if (balance > 0) return `owes ${formatMoney(balance)}`;
  if (balance < 0) return `has ${formatMoney(-balance)} credit`;
  return 'has no balance';
}
