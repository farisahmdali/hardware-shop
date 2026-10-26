import type { Db } from '../db/connection';
import { transact, type Actor, type Tx } from '../db/tx';
import type { AppEnv } from './env';
import {
  allocateSupplier,
  applySupplierCreditFifo,
  payableOutstanding,
  refundedFromSupplierSource,
  releaseSupplierSource,
  releaseSupplierTarget,
  supplierCredits,
} from './supplierAllocations';
import { postLedger, type AccountCode } from './ledger';
import { methodAccount } from './payments';
import { getAllSettings } from './settings';
import { AppError, ErrorCodes } from '@shared/errors';
import { formatMoney } from '@shared/money';
import type { Paged, PayableRow, PayablesAgeing, PayablesSummary, SupplierPaymentRow } from '@shared/contracts';

export interface SupplierPaymentInsert {
  requestId: string;
  /** OUT: the shop pays the supplier. IN: the supplier refunds the shop. */
  direction: 'IN' | 'OUT';
  supplierId: number;
  amount: number;
  methodId: number;
  reference: string;
  notes: string;
}

/** Records money paid to (or refunded by) a supplier with its ledger entry. Allocation is up to the caller. */
export function insertSupplierPayment(tx: Tx, p: SupplierPaymentInsert): number {
  const method = methodAccount(tx.db, p.methodId);
  const out = p.direction === 'OUT';
  const paymentNo = tx.nextDocNumber(out ? 'SUPPLIER_PAYMENT' : 'SUPPLIER_REFUND');
  const id = Number(
    tx.db
      .prepare(
        `INSERT INTO payments (payment_no, client_request_id, direction, purpose, party_type, party_id, amount, method_id,
           reference_no, notes, received_at, business_date, user_id, txn_ref)
         VALUES (?, ?, ?, ?, 'SUPPLIER', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        paymentNo,
        p.requestId,
        p.direction,
        out ? 'SUPPLIER_PAYMENT' : 'SUPPLIER_REFUND',
        p.supplierId,
        p.amount,
        p.methodId,
        p.reference,
        p.notes,
        tx.nowIso,
        tx.businessDate,
        tx.actor.userId,
        tx.txnRef,
      ).lastInsertRowid,
  );
  const party = { partyType: 'SUPPLIER' as const, partyId: p.supplierId };
  postLedger(tx, {
    refType: out ? 'SUPPLIER_PAYMENT' : 'SUPPLIER_REFUND',
    refId: id,
    memo: `${out ? 'Paid to supplier' : 'Refund from supplier'} ${paymentNo} (${method.name})`,
    lines: out
      ? [
          { account: 'AP', debit: p.amount, ...party },
          { account: method.code, credit: p.amount },
        ]
      : [
          { account: method.code, debit: p.amount },
          { account: 'AP', credit: p.amount, ...party },
        ],
  });
  tx.audit({
    module: 'suppliers',
    entityType: 'supplier_payment',
    entityId: id,
    action: out ? 'SUPPLIER_PAID' : 'SUPPLIER_REFUND_RECEIVED',
    after: { paymentNo, supplierId: p.supplierId, amount: p.amount, method: method.name, reference: p.reference, notes: p.notes },
    relatedType: 'supplier',
    relatedId: p.supplierId,
  });
  return id;
}

function assertSupplier(db: Db, supplierId: number): void {
  if (!db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(supplierId)) throw new AppError(ErrorCodes.NOT_FOUND, 'Supplier not found.');
}

export function paySupplier(
  env: AppEnv,
  actor: Actor,
  input: {
    requestId: string;
    supplierId: number;
    amount: number;
    methodId: number;
    reference: string;
    notes: string;
    allocations: { docType: 'PURCHASE' | 'ADJUSTMENT'; docId: number; amount: number }[];
  },
): SupplierPaymentRow {
  const id = transact(env, actor, (tx) =>
    tx.once(input.requestId, 'supplierPayments.create', () => {
      assertSupplier(tx.db, input.supplierId);
      const chosen = input.allocations.reduce((a, x) => a + x.amount, 0);
      if (chosen > input.amount) throw new AppError(ErrorCodes.VALIDATION, 'The amounts applied to bills are more than the payment.');
      const paymentId = insertSupplierPayment(tx, { ...input, direction: 'OUT' });
      for (const a of input.allocations) {
        const owner = tx.db.prepare('SELECT supplier_id FROM v_payables WHERE doc_type = ? AND doc_id = ?').get(a.docType, a.docId) as
          | { supplier_id: number }
          | undefined;
        if (!owner || owner.supplier_id !== input.supplierId) throw new AppError(ErrorCodes.VALIDATION, 'A chosen bill belongs to another supplier.');
        const open = payableOutstanding(tx.db, a.docType, a.docId);
        if (a.amount > open) throw new AppError(ErrorCodes.VALIDATION, `Only ${formatMoney(open)} is still owed on one of the chosen bills.`);
        allocateSupplier(tx, { type: 'PAYMENT', id: paymentId }, { type: a.docType, id: a.docId }, a.amount);
      }
      // Whatever is left settles the oldest open bills; any remainder stays as an advance with the supplier.
      applySupplierCreditFifo(tx, input.supplierId, { onlySource: { type: 'PAYMENT', id: paymentId } });
      return paymentId;
    }),
  );
  return getSupplierPayment(env.db, id);
}

/** Money the supplier pays back out of an advance or a debit note. */
export function refundFromSupplier(
  env: AppEnv,
  actor: Actor,
  input: { requestId: string; supplierId: number; amount: number; methodId: number; reference: string; reason: string },
): SupplierPaymentRow {
  const id = transact(env, actor, (tx) =>
    tx.once(input.requestId, 'supplierPayments.refund', () => {
      assertSupplier(tx.db, input.supplierId);
      return receiveSupplierRefundTx(tx, input);
    }),
  );
  return getSupplierPayment(env.db, id);
}

export function receiveSupplierRefundTx(
  tx: Tx,
  input: { requestId: string; supplierId: number; amount: number; methodId: number; reference: string; reason: string },
  onlySource?: { type: 'DEBIT_NOTE'; id: number },
): number {
  const sources = supplierCredits(tx.db, input.supplierId).filter(
    (s) => !onlySource || (s.sourceType === onlySource.type && s.sourceId === onlySource.id),
  );
  const credit = sources.reduce((a, s) => a + s.unallocated, 0);
  if (input.amount > credit) {
    throw new AppError(ErrorCodes.BUSINESS_RULE, `Only ${formatMoney(credit)} is available to be refunded by this supplier.`);
  }
  const refundId = insertSupplierPayment(tx, {
    requestId: input.requestId,
    direction: 'IN',
    supplierId: input.supplierId,
    amount: input.amount,
    methodId: input.methodId,
    reference: input.reference,
    notes: input.reason,
  });
  let left = input.amount;
  for (const s of sources) {
    if (left === 0) break;
    const take = Math.min(left, s.unallocated);
    allocateSupplier(tx, { type: s.sourceType, id: s.sourceId }, { type: 'REFUND', id: refundId }, take);
    left -= take;
  }
  return refundId;
}

/** Reverses a supplier payment or refund: mirror ledger entry, release of what it settled, reversal record. */
export function reverseSupplierPaymentTx(tx: Tx, paymentId: number, reason: string): void {
  const p = tx.db.prepare("SELECT * FROM payments WHERE id = ? AND party_type = 'SUPPLIER'").get(paymentId) as
    | { id: number; payment_no: string; direction: 'IN' | 'OUT'; party_id: number; amount: number; method_id: number }
    | undefined;
  if (!p) throw new AppError(ErrorCodes.NOT_FOUND, 'Supplier payment not found.');
  if (tx.db.prepare('SELECT 1 FROM payment_reversals WHERE payment_id = ?').get(paymentId)) {
    throw new AppError(ErrorCodes.BUSINESS_RULE, `${p.payment_no} has already been reversed.`);
  }
  if (p.direction === 'OUT') {
    if (refundedFromSupplierSource(tx.db, { type: 'PAYMENT', id: paymentId }) > 0) {
      throw new AppError(ErrorCodes.BUSINESS_RULE, `Part of ${p.payment_no} was refunded by the supplier. Reverse that refund first.`);
    }
    releaseSupplierSource(tx, { type: 'PAYMENT', id: paymentId }, `Payment reversed: ${reason}`);
  } else {
    releaseSupplierTarget(tx, { type: 'REFUND', id: paymentId }, `Refund reversed: ${reason}`);
  }
  tx.db
    .prepare('INSERT INTO payment_reversals (payment_id, reason, user_id, reversed_at, business_date, txn_ref) VALUES (?, ?, ?, ?, ?, ?)')
    .run(paymentId, reason, tx.actor.userId, tx.nowIso, tx.businessDate, tx.txnRef);
  const method = tx.db
    .prepare('SELECT a.code FROM payment_methods m JOIN accounts a ON a.id = m.account_id WHERE m.id = ?')
    .get(p.method_id) as { code: AccountCode };
  const party = { partyType: 'SUPPLIER' as const, partyId: p.party_id };
  postLedger(tx, {
    refType: 'SUPPLIER_PAYMENT_REVERSAL',
    refId: paymentId,
    memo: `${p.payment_no} reversed: ${reason}`,
    lines:
      p.direction === 'OUT'
        ? [
            { account: method.code, debit: p.amount },
            { account: 'AP', credit: p.amount, ...party },
          ]
        : [
            { account: 'AP', debit: p.amount, ...party },
            { account: method.code, credit: p.amount },
          ],
  });
  tx.audit({
    module: 'suppliers',
    entityType: 'supplier_payment',
    entityId: paymentId,
    action: 'REVERSE',
    before: { status: 'RECORDED', amount: p.amount },
    after: { status: 'REVERSED' },
    reason,
    relatedType: 'supplier',
    relatedId: p.party_id,
  });
}

export function reverseSupplierPayment(env: AppEnv, actor: Actor, input: { id: number; reason: string }): SupplierPaymentRow {
  transact(env, actor, (tx) => reverseSupplierPaymentTx(tx, input.id, input.reason));
  return getSupplierPayment(env.db, input.id);
}

export function applySupplierCredit(env: AppEnv, actor: Actor, input: { supplierId: number; requestId: string }): number {
  return transact(env, actor, (tx) =>
    tx.once(input.requestId, 'supplierPayments.applyCredit', () => {
      assertSupplier(tx.db, input.supplierId);
      const applied = applySupplierCreditFifo(tx, input.supplierId);
      if (applied > 0) {
        tx.audit({ module: 'suppliers', entityType: 'supplier', entityId: input.supplierId, action: 'CREDIT_APPLIED', after: { amount: applied } });
      }
      return applied;
    }),
  );
}

// ---------- Queries ----------

interface SupplierPaymentRecord {
  id: number;
  payment_no: string;
  direction: 'IN' | 'OUT';
  party_id: number;
  supplier_name: string;
  amount: number;
  method_name: string;
  method_kind: string;
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
  SELECT p.*, s.name AS supplier_name, m.name AS method_name, m.kind AS method_kind, u.username,
         r.reversed_at, r.reason AS reversal_reason, ru.username AS reversed_by
  FROM payments p
  JOIN suppliers s ON s.id = p.party_id
  JOIN payment_methods m ON m.id = p.method_id
  LEFT JOIN users u ON u.id = p.user_id
  LEFT JOIN payment_reversals r ON r.payment_id = p.id
  LEFT JOIN users ru ON ru.id = r.user_id`;

function toPaymentRow(db: Db, r: SupplierPaymentRecord): SupplierPaymentRow {
  const applied = db
    .prepare(
      `SELECT a.target_type AS docType, a.target_id AS docId, SUM(a.amount) AS amount,
              CASE a.target_type WHEN 'PURCHASE' THEN (SELECT purchase_no FROM purchases WHERE id = a.target_id)
                WHEN 'REFUND' THEN (SELECT payment_no FROM payments WHERE id = a.target_id)
                ELSE 'Opening balance' END AS docNo
       FROM supplier_allocations a WHERE a.source_type = 'PAYMENT' AND a.source_id = ?
       GROUP BY a.target_type, a.target_id HAVING SUM(a.amount) != 0`,
    )
    .all(r.id) as { docType: string; docId: number; amount: number; docNo: string }[];
  const allocated = applied.reduce((a, x) => a + x.amount, 0);
  return {
    id: r.id,
    paymentNo: r.payment_no,
    direction: r.direction,
    supplierId: r.party_id,
    supplierName: r.supplier_name,
    amount: r.amount,
    methodName: r.method_name,
    methodKind: r.method_kind,
    reference: r.reference_no,
    notes: r.notes,
    paidAt: r.received_at,
    businessDate: r.business_date,
    username: r.username,
    reversal: r.reversed_at ? { at: r.reversed_at, reason: r.reversal_reason ?? '', username: r.reversed_by } : null,
    appliedTo: applied,
    unallocated: r.direction === 'OUT' && !r.reversed_at ? r.amount - allocated : 0,
  };
}

export function getSupplierPayment(db: Db, id: number): SupplierPaymentRow {
  const r = db.prepare(`${PAYMENT_SELECT} WHERE p.id = ? AND p.party_type = 'SUPPLIER'`).get(id) as SupplierPaymentRecord | undefined;
  if (!r) throw new AppError(ErrorCodes.NOT_FOUND, 'Supplier payment not found.');
  return toPaymentRow(db, r);
}

export function listSupplierPayments(
  db: Db,
  f: { supplierId?: number; direction: 'ALL' | 'IN' | 'OUT'; methodId?: number; from?: string; to?: string; search?: string; page: number; pageSize: number },
): Paged<SupplierPaymentRow> {
  const where = ["p.party_type = 'SUPPLIER'"];
  const params: unknown[] = [];
  if (f.supplierId) {
    where.push('p.party_id = ?');
    params.push(f.supplierId);
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
    where.push("(p.payment_no LIKE ? ESCAPE '\\' OR p.reference_no LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  const clause = `WHERE ${where.join(' AND ')}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM payments p JOIN suppliers s ON s.id = p.party_id ${clause}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`${PAYMENT_SELECT} ${clause} ORDER BY p.id DESC LIMIT ? OFFSET ?`)
    .all(...params, f.pageSize, (f.page - 1) * f.pageSize) as SupplierPaymentRecord[];
  return { rows: rows.map((r) => toPaymentRow(db, r)), total, page: f.page, pageSize: f.pageSize };
}

// ---------- Payables ----------

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function listPayables(
  db: Db,
  f: { supplierId?: number; filter: 'ALL' | 'OVERDUE' | 'DUE_SOON' | 'PARTIAL' | 'UNPAID'; search?: string; page: number; pageSize: number },
  asOf: string,
): Paged<PayableRow> {
  const where = ['r.cancelled = 0', 'r.outstanding > 0'];
  const params: unknown[] = [];
  if (f.supplierId) {
    where.push('r.supplier_id = ?');
    params.push(f.supplierId);
  }
  if (f.filter === 'OVERDUE') {
    where.push('r.due_date < ?');
    params.push(asOf);
  }
  if (f.filter === 'DUE_SOON') {
    where.push('r.due_date BETWEEN ? AND ?');
    params.push(asOf, addDays(asOf, 7));
  }
  if (f.filter === 'PARTIAL') where.push('r.outstanding < r.amount');
  if (f.filter === 'UNPAID') where.push('r.outstanding = r.amount');
  if (f.search) {
    const like = `%${f.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push("(r.doc_no LIKE ? ESCAPE '\\' OR r.supplier_invoice_no LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  const from = `FROM v_payables r JOIN suppliers s ON s.id = r.supplier_id WHERE ${where.join(' AND ')}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT r.*, s.name AS supplier_name, s.phone ${from} ORDER BY r.due_date, r.bill_date, r.doc_id LIMIT ? OFFSET ?`)
    .all(...params, f.pageSize, (f.page - 1) * f.pageSize) as {
    doc_type: 'PURCHASE' | 'ADJUSTMENT';
    doc_id: number;
    doc_no: string;
    supplier_invoice_no: string;
    supplier_id: number;
    supplier_name: string;
    phone: string;
    bill_date: string;
    due_date: string;
    amount: number;
    outstanding: number;
  }[];
  return {
    rows: rows.map((r) => ({
      docType: r.doc_type,
      docId: r.doc_id,
      docNo: r.doc_no,
      supplierInvoiceNo: r.supplier_invoice_no,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      phone: r.phone,
      billDate: r.bill_date,
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

/** What the shop owes each supplier, split into ageing buckets by days since the bill date. */
export function payablesAgeing(db: Db, asOf: string, search?: string): PayablesAgeing {
  const limits = getAllSettings(db).receivables.ageingBuckets;
  const labels = limits.map((l, i) => `${i === 0 ? 0 : limits[i - 1]! + 1}–${l} days`).concat(`Over ${limits[limits.length - 1]} days`);
  const open = db
    .prepare(
      `SELECT r.supplier_id, s.name, s.phone, r.bill_date, r.outstanding
       FROM v_payables r JOIN suppliers s ON s.id = r.supplier_id
       WHERE r.cancelled = 0 AND r.outstanding > 0 ${search ? 'AND (s.name LIKE ? OR s.phone LIKE ?)' : ''}`,
    )
    .all(...(search ? [`%${search}%`, `%${search}%`] : [])) as { supplier_id: number; name: string; phone: string; bill_date: string; outstanding: number }[];
  const credits = new Map(
    (
      db
        .prepare('SELECT supplier_id, SUM(unallocated) AS credit FROM v_supplier_credits WHERE reversed = 0 AND unallocated > 0 GROUP BY supplier_id')
        .all() as { supplier_id: number; credit: number }[]
    ).map((r) => [r.supplier_id, r.credit]),
  );
  const bySupplier = new Map<number, PayablesAgeing['rows'][number]>();
  for (const r of open) {
    let row = bySupplier.get(r.supplier_id);
    if (!row) {
      row = { supplierId: r.supplier_id, supplierName: r.name, phone: r.phone, buckets: labels.map(() => 0), outstanding: 0, credit: 0, balance: 0 };
      bySupplier.set(r.supplier_id, row);
    }
    const age = daysBetween(r.bill_date, asOf);
    const idx = limits.findIndex((l) => age <= l);
    row.buckets[idx === -1 ? limits.length : idx]! += r.outstanding;
    row.outstanding += r.outstanding;
  }
  const rows = [...bySupplier.values()]
    .map((r) => {
      r.credit = credits.get(r.supplierId) ?? 0;
      r.balance = r.outstanding - r.credit;
      return r;
    })
    .sort((a, b) => b.outstanding - a.outstanding);
  return {
    bucketLabels: labels,
    rows,
    totals: {
      buckets: labels.map((_, i) => rows.reduce((a, r) => a + r.buckets[i]!, 0)),
      outstanding: rows.reduce((a, r) => a + r.outstanding, 0),
      credit: rows.reduce((a, r) => a + r.credit, 0),
      balance: rows.reduce((a, r) => a + r.balance, 0),
    },
  };
}

export function payablesSummary(db: Db, asOf: string): PayablesSummary {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(outstanding), 0) AS outstanding,
              COALESCE(SUM(CASE WHEN due_date < ? THEN outstanding ELSE 0 END), 0) AS overdue,
              COALESCE(SUM(CASE WHEN due_date BETWEEN ? AND ? THEN outstanding ELSE 0 END), 0) AS soon,
              COUNT(DISTINCT supplier_id) AS suppliers
       FROM v_payables WHERE cancelled = 0 AND outstanding > 0`,
    )
    .get(asOf, asOf, addDays(asOf, 7)) as { outstanding: number; overdue: number; soon: number; suppliers: number };
  const advances = (
    db.prepare('SELECT COALESCE(SUM(unallocated), 0) AS c FROM v_supplier_credits WHERE reversed = 0 AND unallocated > 0').get() as { c: number }
  ).c;
  return { outstanding: r.outstanding, overdue: r.overdue, dueInSevenDays: r.soon, suppliersOwed: r.suppliers, advances };
}

