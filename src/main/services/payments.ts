import type { Db } from '../db/connection';
import { transact, type Actor, type Tx } from '../db/tx';
import type { AppEnv } from './env';
import {
  allocate,
  applyCreditFifo,
  availableCredit,
  creditSources,
  receivableOutstanding,
  refundedFromSource,
  releaseSource,
  releaseTarget,
} from './allocations';
import { postLedger, type AccountCode } from './ledger';
import { getAllSettings } from './settings';
import { AppError, ErrorCodes } from '@shared/errors';
import { formatMoney } from '@shared/money';
import type { AgeingReport, Paged, PaymentMethodRow, PaymentRow, ReceivableRow } from '@shared/contracts';

// ---------- Payment methods ----------

const KIND_ACCOUNT: Record<PaymentMethodRow['kind'], AccountCode> = {
  CASH: 'CASH',
  UPI: 'UPI',
  CARD: 'CARD',
  BANK: 'BANK',
  CHEQUE: 'CHEQUE',
  OTHER: 'BANK',
};

export function listPaymentMethods(db: Db, includeInactive: boolean): PaymentMethodRow[] {
  return (
    db
      .prepare(
        `SELECT id, name, kind, is_active, sort_order, version FROM payment_methods
         ${includeInactive ? '' : 'WHERE is_active = 1'} ORDER BY sort_order, name`,
      )
      .all() as { id: number; name: string; kind: PaymentMethodRow['kind']; is_active: number; sort_order: number; version: number }[]
  ).map((m) => ({ id: m.id, name: m.name, kind: m.kind, isActive: m.is_active === 1, sortOrder: m.sort_order, version: m.version }));
}

export function savePaymentMethod(
  env: AppEnv,
  actor: Actor,
  input: { id?: number; name: string; kind: PaymentMethodRow['kind']; isActive: boolean; sortOrder: number; version?: number },
): PaymentMethodRow {
  return transact(env, actor, (tx) => {
    const dup = tx.db.prepare('SELECT id FROM payment_methods WHERE name = ?').get(input.name) as { id: number } | undefined;
    if (dup && dup.id !== input.id) throw new AppError(ErrorCodes.CONFLICT, `A payment method named ${input.name} already exists.`);
    const accountId = (tx.db.prepare('SELECT id FROM accounts WHERE code = ?').get(KIND_ACCOUNT[input.kind]) as { id: number }).id;
    let id = input.id;
    const select = 'SELECT name, kind, is_active AS isActive, sort_order AS sortOrder FROM payment_methods WHERE id = ?';
    if (id === undefined) {
      id = Number(
        tx.db
          .prepare(
            'INSERT INTO payment_methods (name, kind, account_id, is_active, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(input.name, input.kind, accountId, input.isActive ? 1 : 0, input.sortOrder, tx.nowIso, tx.nowIso).lastInsertRowid,
      );
      tx.audit({ module: 'settings', entityType: 'payment_method', entityId: id, action: 'CREATE', after: tx.db.prepare(select).get(id) });
    } else {
      const before = tx.db.prepare(select).get(id);
      if (!before) throw new AppError(ErrorCodes.NOT_FOUND, 'Payment method not found.');
      const used = tx.db.prepare('SELECT 1 FROM payments WHERE method_id = ? LIMIT 1').get(id);
      const currentKind = (tx.db.prepare('SELECT kind FROM payment_methods WHERE id = ?').get(id) as { kind: string }).kind;
      if (used && currentKind !== input.kind) {
        throw new AppError(ErrorCodes.BUSINESS_RULE, 'This method has been used for payments, so its type cannot change. Add a new method instead.');
      }
      const result = tx.db
        .prepare(
          `UPDATE payment_methods SET name = ?, kind = ?, account_id = ?, is_active = ?, sort_order = ?, updated_at = ?,
             version = version + 1 WHERE id = ? AND version = ?`,
        )
        .run(input.name, input.kind, accountId, input.isActive ? 1 : 0, input.sortOrder, tx.nowIso, id, input.version ?? -1);
      tx.expectOneChange(result.changes, 'This payment method');
      tx.audit({ module: 'settings', entityType: 'payment_method', entityId: id, action: 'UPDATE', before, after: tx.db.prepare(select).get(id) });
    }
    return listPaymentMethods(tx.db, true).find((m) => m.id === id)!;
  });
}

// ---------- Recording payments ----------

export function methodAccount(db: Db, methodId: number): { code: AccountCode; name: string } {
  const m = db
    .prepare('SELECT a.code, m.name, m.is_active FROM payment_methods m JOIN accounts a ON a.id = m.account_id WHERE m.id = ?')
    .get(methodId) as { code: AccountCode; name: string; is_active: number } | undefined;
  if (!m) throw new AppError(ErrorCodes.VALIDATION, 'Choose a payment method.');
  if (!m.is_active) throw new AppError(ErrorCodes.BUSINESS_RULE, `${m.name} is no longer in use.`);
  return m;
}

export interface PaymentInsert {
  requestId: string;
  direction: 'IN' | 'OUT';
  purpose: 'RECEIPT' | 'REFUND';
  customerId: number;
  amount: number;
  methodId: number;
  reference: string;
  notes: string;
}

/** Records a customer payment or refund with its ledger entry. Allocation is up to the caller. */
export function insertPayment(tx: Tx, p: PaymentInsert): number {
  const method = methodAccount(tx.db, p.methodId);
  const paymentNo = tx.nextDocNumber(p.direction === 'IN' ? 'RECEIPT' : 'REFUND');
  const id = Number(
    tx.db
      .prepare(
        `INSERT INTO payments (payment_no, client_request_id, direction, purpose, party_type, party_id, amount, method_id,
           reference_no, notes, received_at, business_date, user_id, txn_ref)
         VALUES (?, ?, ?, ?, 'CUSTOMER', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(paymentNo, p.requestId, p.direction, p.purpose, p.customerId, p.amount, p.methodId, p.reference, p.notes, tx.nowIso, tx.businessDate, tx.actor.userId, tx.txnRef)
      .lastInsertRowid,
  );
  postLedger(tx, {
    refType: p.direction === 'IN' ? 'PAYMENT' : 'REFUND',
    refId: id,
    memo: `${p.direction === 'IN' ? 'Payment received' : 'Refund paid'} ${paymentNo} (${method.name})`,
    lines:
      p.direction === 'IN'
        ? [
            { account: method.code, debit: p.amount },
            { account: 'AR', credit: p.amount, partyType: 'CUSTOMER', partyId: p.customerId },
          ]
        : [
            { account: 'AR', debit: p.amount, partyType: 'CUSTOMER', partyId: p.customerId },
            { account: method.code, credit: p.amount },
          ],
  });
  tx.audit({
    module: 'payments',
    entityType: 'payment',
    entityId: id,
    action: p.direction === 'IN' ? 'PAYMENT_RECEIVED' : 'REFUND_PAID',
    after: { paymentNo, customerId: p.customerId, amount: p.amount, method: method.name, reference: p.reference, notes: p.notes },
    relatedType: 'customer',
    relatedId: p.customerId,
  });
  return id;
}

function assertAccountCustomer(db: Db, customerId: number): void {
  const c = db.prepare('SELECT is_walkin, name FROM customers WHERE id = ?').get(customerId) as { is_walkin: number; name: string } | undefined;
  if (!c) throw new AppError(ErrorCodes.NOT_FOUND, 'Customer not found.');
  if (c.is_walkin) throw new AppError(ErrorCodes.BUSINESS_RULE, 'The walk-in customer has no account. Choose a customer.');
}

export function receivePayment(
  env: AppEnv,
  actor: Actor,
  input: {
    requestId: string;
    customerId: number;
    amount: number;
    methodId: number;
    reference: string;
    notes: string;
    allocations: { docType: 'INVOICE' | 'ADJUSTMENT'; docId: number; amount: number }[];
  },
): PaymentRow {
  const id = transact(env, actor, (tx) =>
    tx.once(input.requestId, 'payments.receive', () => {
      assertAccountCustomer(tx.db, input.customerId);
      const chosen = input.allocations.reduce((a, x) => a + x.amount, 0);
      if (chosen > input.amount) throw new AppError(ErrorCodes.VALIDATION, 'The amounts applied to bills are more than the payment.');
      const paymentId = insertPayment(tx, { ...input, direction: 'IN', purpose: 'RECEIPT' });
      for (const a of input.allocations) {
        const owner = tx.db
          .prepare('SELECT customer_id FROM v_receivables WHERE doc_type = ? AND doc_id = ?')
          .get(a.docType, a.docId) as { customer_id: number } | undefined;
        if (!owner || owner.customer_id !== input.customerId) throw new AppError(ErrorCodes.VALIDATION, 'A chosen bill belongs to another customer.');
        const open = receivableOutstanding(tx.db, a.docType, a.docId);
        if (a.amount > open) throw new AppError(ErrorCodes.VALIDATION, `Only ${formatMoney(open)} is still owed on one of the chosen bills.`);
        allocate(tx, { type: 'PAYMENT', id: paymentId }, { type: a.docType, id: a.docId }, a.amount);
      }
      // Whatever is left settles the oldest open bills; any remainder stays as advance credit.
      applyCreditFifo(tx, input.customerId, { onlySource: { type: 'PAYMENT', id: paymentId } });
      return paymentId;
    }),
  );
  return getPayment(env.db, id);
}

export function refundCustomer(
  env: AppEnv,
  actor: Actor,
  input: { requestId: string; customerId: number; amount: number; methodId: number; reference: string; reason: string },
): PaymentRow {
  const id = transact(env, actor, (tx) =>
    tx.once(input.requestId, 'payments.refund', () => {
      assertAccountCustomer(tx.db, input.customerId);
      const credit = availableCredit(tx.db, input.customerId);
      if (input.amount > credit) {
        throw new AppError(ErrorCodes.BUSINESS_RULE, `Only ${formatMoney(credit)} of credit is available to refund.`);
      }
      const refundId = insertPayment(tx, {
        requestId: input.requestId,
        direction: 'OUT',
        purpose: 'REFUND',
        customerId: input.customerId,
        amount: input.amount,
        methodId: input.methodId,
        reference: input.reference,
        notes: input.reason,
      });
      let left = input.amount;
      for (const s of creditSources(tx.db, input.customerId)) {
        if (left === 0) break;
        const take = Math.min(left, s.unallocated);
        allocate(tx, { type: s.sourceType, id: s.sourceId }, { type: 'REFUND', id: refundId }, take);
        left -= take;
      }
      return refundId;
    }),
  );
  return getPayment(env.db, id);
}

/**
 * Reverses a payment or refund inside an existing transaction: mirror ledger entry,
 * release of everything it settled, and a reversal record. The original is kept.
 */
export function reversePaymentTx(tx: Tx, paymentId: number, reason: string): void {
  const p = tx.db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) as
    | { id: number; payment_no: string; direction: 'IN' | 'OUT'; party_id: number; amount: number; method_id: number }
    | undefined;
  if (!p) throw new AppError(ErrorCodes.NOT_FOUND, 'Payment not found.');
  if (tx.db.prepare('SELECT 1 FROM payment_reversals WHERE payment_id = ?').get(paymentId)) {
    throw new AppError(ErrorCodes.BUSINESS_RULE, `${p.payment_no} has already been reversed.`);
  }
  if (p.direction === 'IN') {
    if (refundedFromSource(tx.db, { type: 'PAYMENT', id: paymentId }) > 0) {
      throw new AppError(ErrorCodes.BUSINESS_RULE, `Part of ${p.payment_no} was refunded. Reverse the refund first.`);
    }
    releaseSource(tx, { type: 'PAYMENT', id: paymentId }, `Payment reversed: ${reason}`);
  } else {
    releaseTarget(tx, { type: 'REFUND', id: paymentId }, `Refund reversed: ${reason}`);
  }
  tx.db
    .prepare('INSERT INTO payment_reversals (payment_id, reason, user_id, reversed_at, business_date, txn_ref) VALUES (?, ?, ?, ?, ?, ?)')
    .run(paymentId, reason, tx.actor.userId, tx.nowIso, tx.businessDate, tx.txnRef);
  const method = tx.db
    .prepare('SELECT a.code FROM payment_methods m JOIN accounts a ON a.id = m.account_id WHERE m.id = ?')
    .get(p.method_id) as { code: AccountCode };
  postLedger(tx, {
    refType: 'PAYMENT_REVERSAL',
    refId: paymentId,
    memo: `${p.payment_no} reversed: ${reason}`,
    lines:
      p.direction === 'IN'
        ? [
            { account: 'AR', debit: p.amount, partyType: 'CUSTOMER', partyId: p.party_id },
            { account: method.code, credit: p.amount },
          ]
        : [
            { account: method.code, debit: p.amount },
            { account: 'AR', credit: p.amount, partyType: 'CUSTOMER', partyId: p.party_id },
          ],
  });
  tx.audit({
    module: 'payments',
    entityType: 'payment',
    entityId: paymentId,
    action: 'REVERSE',
    before: { status: 'RECORDED', amount: p.amount },
    after: { status: 'REVERSED' },
    reason,
    relatedType: 'customer',
    relatedId: p.party_id,
  });
}

export function reversePayment(env: AppEnv, actor: Actor, input: { id: number; reason: string }): PaymentRow {
  transact(env, actor, (tx) => {
    const p = tx.db
      .prepare('SELECT c.is_walkin FROM payments p JOIN customers c ON c.id = p.party_id WHERE p.id = ? AND p.party_type = ?')
      .get(input.id, 'CUSTOMER') as { is_walkin: number } | undefined;
    if (!p) throw new AppError(ErrorCodes.NOT_FOUND, 'Payment not found.');
    if (p.is_walkin) {
      throw new AppError(ErrorCodes.BUSINESS_RULE, 'Walk-in payments are reversed by cancelling the invoice they paid for.');
    }
    reversePaymentTx(tx, input.id, input.reason);
  });
  return getPayment(env.db, input.id);
}

export function applyCustomerCredit(env: AppEnv, actor: Actor, input: { customerId: number; requestId: string }): number {
  return transact(env, actor, (tx) =>
    tx.once(input.requestId, 'payments.applyCredit', () => {
      assertAccountCustomer(tx.db, input.customerId);
      const applied = applyCreditFifo(tx, input.customerId);
      if (applied > 0) {
        tx.audit({ module: 'payments', entityType: 'customer', entityId: input.customerId, action: 'CREDIT_APPLIED', after: { amount: applied } });
      }
      return applied;
    }),
  );
}

// ---------- Queries ----------

interface PaymentRecord {
  id: number;
  payment_no: string;
  direction: 'IN' | 'OUT';
  purpose: string;
  party_id: number;
  customer_name: string;
  amount: number;
  method_name: string;
  method_kind: PaymentMethodRow['kind'];
  reference_no: string;
  notes: string;
  received_at: string;
  business_date: string;
  username: string | null;
  reversed_at: string | null;
  reversal_reason: string | null;
  reversed_by: string | null;
}

const PAYMENT_SELECT = `
  SELECT p.*, c.name AS customer_name, m.name AS method_name, m.kind AS method_kind, u.username,
         r.reversed_at, r.reason AS reversal_reason, ru.username AS reversed_by
  FROM payments p
  JOIN customers c ON c.id = p.party_id
  JOIN payment_methods m ON m.id = p.method_id
  LEFT JOIN users u ON u.id = p.user_id
  LEFT JOIN payment_reversals r ON r.payment_id = p.id
  LEFT JOIN users ru ON ru.id = r.user_id`;

function toPaymentRow(db: Db, r: PaymentRecord): PaymentRow {
  const applied = (
    db
      .prepare(
        `SELECT a.target_type AS docType, a.target_id AS docId, SUM(a.amount) AS amount,
                CASE a.target_type WHEN 'INVOICE' THEN (SELECT invoice_no FROM invoices WHERE id = a.target_id)
                  WHEN 'REFUND' THEN (SELECT payment_no FROM payments WHERE id = a.target_id)
                  ELSE 'Opening balance' END AS docNo
         FROM allocations a WHERE a.source_type = 'PAYMENT' AND a.source_id = ?
         GROUP BY a.target_type, a.target_id HAVING SUM(a.amount) != 0`,
      )
      .all(r.id) as { docType: string; docId: number; amount: number; docNo: string }[]
  );
  const allocated = applied.reduce((a, x) => a + x.amount, 0);
  return {
    id: r.id,
    paymentNo: r.payment_no,
    direction: r.direction,
    purpose: r.purpose,
    customerId: r.party_id,
    customerName: r.customer_name,
    amount: r.amount,
    methodName: r.method_name,
    methodKind: r.method_kind,
    reference: r.reference_no,
    notes: r.notes,
    receivedAt: r.received_at,
    businessDate: r.business_date,
    username: r.username,
    reversal: r.reversed_at ? { at: r.reversed_at, reason: r.reversal_reason ?? '', username: r.reversed_by } : null,
    appliedTo: applied,
    unallocated: r.direction === 'IN' && !r.reversed_at ? r.amount - allocated : 0,
  };
}

export function getPayment(db: Db, id: number): PaymentRow {
  const r = db.prepare(`${PAYMENT_SELECT} WHERE p.id = ? AND p.party_type = 'CUSTOMER'`).get(id) as PaymentRecord | undefined;
  if (!r) throw new AppError(ErrorCodes.NOT_FOUND, 'Payment not found.');
  return toPaymentRow(db, r);
}

export function listPayments(
  db: Db,
  f: { customerId?: number; direction: 'ALL' | 'IN' | 'OUT'; methodId?: number; from?: string; to?: string; search?: string; page: number; pageSize: number },
): Paged<PaymentRow> {
  const where = ["p.party_type = 'CUSTOMER'"];
  const params: unknown[] = [];
  if (f.customerId) {
    where.push('p.party_id = ?');
    params.push(f.customerId);
  }
  if (f.direction !== 'ALL') {
    where.push('p.direction = ?');
    params.push(f.direction);
  }
  if (f.methodId) {
    where.push('p.method_id = ?');
    params.push(f.methodId);
  }
  if (f.from) {
    where.push('p.business_date >= ?');
    params.push(f.from);
  }
  if (f.to) {
    where.push('p.business_date <= ?');
    params.push(f.to);
  }
  if (f.search) {
    const like = `%${f.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push("(p.payment_no LIKE ? ESCAPE '\\' OR p.reference_no LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  const clause = `WHERE ${where.join(' AND ')}`;
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM payments p JOIN customers c ON c.id = p.party_id ${clause}`).get(...params) as { n: number }
  ).n;
  const rows = db
    .prepare(`${PAYMENT_SELECT} ${clause} ORDER BY p.id DESC LIMIT ? OFFSET ?`)
    .all(...params, f.pageSize, (f.page - 1) * f.pageSize) as PaymentRecord[];
  return { rows: rows.map((r) => toPaymentRow(db, r)), total, page: f.page, pageSize: f.pageSize };
}

// ---------- Receivables ----------

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function listReceivables(
  db: Db,
  f: { customerId?: number; filter: 'ALL' | 'OVERDUE' | 'PARTIAL' | 'UNPAID'; search?: string; page: number; pageSize: number },
  asOf: string,
): Paged<ReceivableRow> {
  const where = ['r.cancelled = 0', 'r.outstanding > 0'];
  const params: unknown[] = [];
  if (f.customerId) {
    where.push('r.customer_id = ?');
    params.push(f.customerId);
  }
  if (f.filter === 'OVERDUE') {
    where.push('r.due_date < ?');
    params.push(asOf);
  }
  if (f.filter === 'PARTIAL') where.push('r.outstanding < r.amount');
  if (f.filter === 'UNPAID') where.push('r.outstanding = r.amount');
  if (f.search) {
    const like = `%${f.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push("(r.doc_no LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  const from = `FROM v_receivables r JOIN customers c ON c.id = r.customer_id WHERE ${where.join(' AND ')}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT r.*, c.name AS customer_name, c.phone ${from} ORDER BY r.due_date, r.business_date, r.doc_id LIMIT ? OFFSET ?`,
    )
    .all(...params, f.pageSize, (f.page - 1) * f.pageSize) as {
    doc_type: 'INVOICE' | 'ADJUSTMENT';
    doc_id: number;
    doc_no: string;
    customer_id: number;
    customer_name: string;
    phone: string;
    business_date: string;
    due_date: string;
    amount: number;
    outstanding: number;
  }[];
  return {
    rows: rows.map((r) => ({
      docType: r.doc_type,
      docId: r.doc_id,
      docNo: r.doc_no,
      customerId: r.customer_id,
      customerName: r.customer_name,
      phone: r.phone,
      businessDate: r.business_date,
      dueDate: r.due_date,
      amount: r.amount,
      outstanding: r.outstanding,
      daysOverdue: Math.max(0, daysBetween(r.due_date, asOf)),
      status: r.outstanding < r.amount ? 'PARTIAL' : 'UNPAID',
    })),
    total,
    page: f.page,
    pageSize: f.pageSize,
  };
}

/** Outstanding per customer split into ageing buckets by days since the bill date. */
export function ageingReport(db: Db, asOf: string, search?: string): AgeingReport {
  const limits = getAllSettings(db).receivables.ageingBuckets;
  const labels = limits.map((l, i) => `${i === 0 ? 0 : limits[i - 1]! + 1}–${l} days`).concat(`Over ${limits[limits.length - 1]} days`);
  const open = db
    .prepare(
      `SELECT r.customer_id, c.name, c.phone, r.business_date, r.outstanding
       FROM v_receivables r JOIN customers c ON c.id = r.customer_id
       WHERE r.cancelled = 0 AND r.outstanding > 0 ${search ? "AND (c.name LIKE ? OR c.phone LIKE ?)" : ''}`,
    )
    .all(...(search ? [`%${search}%`, `%${search}%`] : [])) as { customer_id: number; name: string; phone: string; business_date: string; outstanding: number }[];
  const credits = new Map(
    (
      db
        .prepare(
          `SELECT customer_id, SUM(unallocated) AS credit FROM v_credit_sources WHERE reversed = 0 AND unallocated > 0 GROUP BY customer_id`,
        )
        .all() as { customer_id: number; credit: number }[]
    ).map((r) => [r.customer_id, r.credit]),
  );
  const byCustomer = new Map<number, AgeingReport['rows'][number]>();
  for (const r of open) {
    let row = byCustomer.get(r.customer_id);
    if (!row) {
      row = { customerId: r.customer_id, customerName: r.name, phone: r.phone, buckets: labels.map(() => 0), outstanding: 0, credit: 0, balance: 0 };
      byCustomer.set(r.customer_id, row);
    }
    const age = daysBetween(r.business_date, asOf);
    const idx = limits.findIndex((l) => age <= l);
    row.buckets[idx === -1 ? limits.length : idx]! += r.outstanding;
    row.outstanding += r.outstanding;
  }
  const rows = [...byCustomer.values()]
    .map((r) => {
      r.credit = credits.get(r.customerId) ?? 0;
      r.balance = r.outstanding - r.credit;
      return r;
    })
    .sort((a, b) => b.outstanding - a.outstanding);
  const totals = {
    buckets: labels.map((_, i) => rows.reduce((a, r) => a + r.buckets[i]!, 0)),
    outstanding: rows.reduce((a, r) => a + r.outstanding, 0),
    credit: rows.reduce((a, r) => a + r.credit, 0),
    balance: rows.reduce((a, r) => a + r.balance, 0),
  };
  return { bucketLabels: labels, rows, totals };
}

export function receivablesSummary(db: Db, asOf: string) {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(outstanding), 0) AS outstanding,
              COALESCE(SUM(CASE WHEN due_date < ? THEN outstanding ELSE 0 END), 0) AS overdue,
              COUNT(DISTINCT customer_id) AS customers
       FROM v_receivables WHERE cancelled = 0 AND outstanding > 0`,
    )
    .get(asOf) as { outstanding: number; overdue: number; customers: number };
  const credit = (
    db.prepare('SELECT COALESCE(SUM(unallocated), 0) AS c FROM v_credit_sources WHERE reversed = 0 AND unallocated > 0').get() as { c: number }
  ).c;
  return { outstanding: r.outstanding, overdue: r.overdue, customersOwing: r.customers, credit };
}
