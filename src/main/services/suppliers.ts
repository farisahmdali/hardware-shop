import type { Db } from '../db/connection';
import { transact, type Actor, type Tx } from '../db/tx';
import type { AppEnv } from './env';
import { applySupplierCreditFifo, availableSupplierCredit } from './supplierAllocations';
import { postLedger } from './ledger';
import { getAllSettings } from './settings';
import { AppError, ErrorCodes } from '@shared/errors';
import { businessDateOf, fiscalYearOf } from '@shared/time';
import type { LedgerRow, Paged, SupplierDetail, SupplierLedger, SupplierRow } from '@shared/contracts';

export interface SupplierFields {
  name: string;
  phone: string;
  address: string;
  businessName: string;
  gstin: string;
  stateCode: string;
  creditDays: number | null;
  notes: string;
}

interface SupplierRecord {
  id: number;
  code: string;
  name: string;
  phone: string;
  address: string;
  business_name: string;
  gstin: string;
  state_code: string;
  credit_days: number | null;
  notes: string;
  is_active: number;
  created_at: string;
  updated_at: string;
  version: number;
  balance: number;
  overdue: number;
}

export function apAccountId(db: Db): number {
  return (db.prepare("SELECT id FROM accounts WHERE code = 'AP'").get() as { id: number }).id;
}

/** Supplier columns plus what the shop owes (from the ledger) and how much of it is overdue. */
function supplierSelect(db: Db, asOf: string): { sql: string; params: unknown[] } {
  return {
    sql: `SELECT s.*, COALESCE(b.balance, 0) AS balance, COALESCE(o.overdue, 0) AS overdue
      FROM suppliers s
      LEFT JOIN (SELECT party_id, SUM(credit - debit) AS balance FROM ledger_entries
                 WHERE account_id = ? AND party_type = 'SUPPLIER' GROUP BY party_id) b ON b.party_id = s.id
      LEFT JOIN (SELECT supplier_id, SUM(outstanding) AS overdue FROM v_payables
                 WHERE cancelled = 0 AND outstanding > 0 AND due_date < ? GROUP BY supplier_id) o ON o.supplier_id = s.id`,
    params: [apAccountId(db), asOf],
  };
}

const toRow = (r: SupplierRecord): SupplierRow => ({
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
});

export function listSuppliers(
  db: Db,
  f: { search?: string; filter: 'ALL' | 'OWED' | 'OVERDUE' | 'ADVANCE'; active: 'ACTIVE' | 'INACTIVE' | 'ALL'; page: number; pageSize: number },
  asOf: string,
): Paged<SupplierRow> {
  const base = supplierSelect(db, asOf);
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.active !== 'ALL') where.push(`s.is_active = ${f.active === 'ACTIVE' ? 1 : 0}`);
  if (f.filter === 'OWED') where.push('COALESCE(b.balance, 0) > 0');
  if (f.filter === 'ADVANCE') where.push('COALESCE(b.balance, 0) < 0');
  if (f.filter === 'OVERDUE') where.push('COALESCE(o.overdue, 0) > 0');
  if (f.search) {
    const like = `%${f.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const digits = f.search.replace(/\D/g, '');
    const parts = ["s.name LIKE ? ESCAPE '\\'", "s.business_name LIKE ? ESCAPE '\\'", 's.code = ?', 's.gstin = ?'];
    params.push(like, like, f.search, f.search.toUpperCase());
    if (digits.length >= 4) {
      parts.push("replace(replace(s.phone, ' ', ''), '-', '') LIKE ?");
      params.push(`%${digits}%`);
    }
    where.push(`(${parts.join(' OR ')})`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM (${base.sql} ${clause})`).get(...base.params, ...params) as { n: number }).n;
  const rows = db
    .prepare(`${base.sql} ${clause} ORDER BY s.name COLLATE NOCASE, s.id LIMIT ? OFFSET ?`)
    .all(...base.params, ...params, f.pageSize, (f.page - 1) * f.pageSize) as SupplierRecord[];
  return { rows: rows.map(toRow), total, page: f.page, pageSize: f.pageSize };
}

function loadSupplier(db: Db, id: number, asOf: string): SupplierRecord {
  const base = supplierSelect(db, asOf);
  const r = db.prepare(`${base.sql} WHERE s.id = ?`).get(...base.params, id) as SupplierRecord | undefined;
  if (!r) throw new AppError(ErrorCodes.NOT_FOUND, 'Supplier not found.');
  return r;
}

export function supplierCreditDays(db: Db, supplier: { credit_days: number | null }): number {
  return supplier.credit_days ?? getAllSettings(db).purchases.defaultCreditDays;
}

export function getSupplier(db: Db, id: number, asOf: string): SupplierDetail {
  const r = loadSupplier(db, id, asOf);
  const outstanding = (
    db
      .prepare('SELECT COALESCE(SUM(outstanding), 0) AS n FROM v_payables WHERE supplier_id = ? AND cancelled = 0 AND outstanding > 0')
      .get(id) as { n: number }
  ).n;
  const stats = db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(p.supplier_invoice_date) AS last FROM purchases p
       LEFT JOIN purchase_cancellations c ON c.purchase_id = p.id WHERE p.supplier_id = ? AND c.id IS NULL`,
    )
    .get(id) as { n: number; last: string | null };
  return {
    ...toRow(r),
    address: r.address,
    creditDays: r.credit_days,
    effectiveCreditDays: supplierCreditDays(db, r),
    notes: r.notes,
    outstanding,
    availableCredit: availableSupplierCredit(db, id),
    purchaseCount: stats.n,
    lastPurchaseDate: stats.last,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: r.version,
  };
}

function auditSnapshot(db: Db, id: number) {
  const r = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as SupplierRecord;
  return {
    code: r.code,
    name: r.name,
    phone: r.phone,
    address: r.address,
    businessName: r.business_name,
    gstin: r.gstin,
    stateCode: r.state_code,
    creditDays: r.credit_days,
    notes: r.notes,
    isActive: r.is_active === 1,
  };
}

function assertUniqueName(tx: Tx, name: string, exceptId?: number): void {
  const dup = tx.db.prepare('SELECT id FROM suppliers WHERE name = ? COLLATE NOCASE AND id != ?').get(name, exceptId ?? -1);
  if (dup) throw new AppError(ErrorCodes.CONFLICT, `A supplier named "${name}" already exists.`);
}

const stateFrom = (input: SupplierFields) => input.stateCode || (input.gstin ? input.gstin.slice(0, 2) : '');

export function createSupplier(env: AppEnv, actor: Actor, input: SupplierFields & { requestId: string; openingBalance: number }): SupplierDetail {
  const id = transact(env, actor, (tx) =>
    tx.once(input.requestId, 'suppliers.create', () => {
      assertUniqueName(tx, input.name);
      const code = tx.nextCode('SUPPLIER', 'S', 4, 'suppliers', 'code');
      const newId = Number(
        tx.db
          .prepare(
            `INSERT INTO suppliers (code, name, phone, address, business_name, gstin, state_code, credit_days, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(code, input.name, input.phone, input.address, input.businessName, input.gstin, stateFrom(input), input.creditDays, input.notes, tx.nowIso, tx.nowIso)
          .lastInsertRowid,
      );
      tx.audit({ module: 'suppliers', entityType: 'supplier', entityId: newId, action: 'CREATE', after: auditSnapshot(tx.db, newId) });
      if (input.openingBalance !== 0) {
        insertSupplierAdjustment(tx, newId, 'OPENING', input.openingBalance, 'Carried over when the supplier was added');
      }
      return newId;
    }),
  );
  return getSupplier(env.db, id, businessDateOf(env.clock.now(), env.timeZone));
}

export function updateSupplier(env: AppEnv, actor: Actor, input: SupplierFields & { id: number; version: number; reason?: string }): SupplierDetail {
  transact(env, actor, (tx) => {
    if (!tx.db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(input.id)) throw new AppError(ErrorCodes.NOT_FOUND, 'Supplier not found.');
    assertUniqueName(tx, input.name, input.id);
    const before = auditSnapshot(tx.db, input.id);
    const result = tx.db
      .prepare(
        `UPDATE suppliers SET name = ?, phone = ?, address = ?, business_name = ?, gstin = ?, state_code = ?, credit_days = ?, notes = ?,
           updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`,
      )
      .run(input.name, input.phone, input.address, input.businessName, input.gstin, stateFrom(input), input.creditDays, input.notes, tx.nowIso, input.id, input.version);
    tx.expectOneChange(result.changes, 'This supplier');
    const after = auditSnapshot(tx.db, input.id);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      tx.audit({ module: 'suppliers', entityType: 'supplier', entityId: input.id, action: 'UPDATE', before, after, reason: input.reason ?? null });
    }
  });
  return getSupplier(env.db, input.id, businessDateOf(env.clock.now(), env.timeZone));
}

export function setSupplierActive(env: AppEnv, actor: Actor, input: { id: number; version: number; isActive: boolean; reason: string }): SupplierDetail {
  transact(env, actor, (tx) => {
    const result = tx.db
      .prepare('UPDATE suppliers SET is_active = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
      .run(input.isActive ? 1 : 0, tx.nowIso, input.id, input.version);
    tx.expectOneChange(result.changes, 'This supplier');
    tx.audit({
      module: 'suppliers',
      entityType: 'supplier',
      entityId: input.id,
      action: input.isActive ? 'REACTIVATE' : 'DEACTIVATE',
      before: { isActive: !input.isActive },
      after: { isActive: input.isActive },
      reason: input.reason,
    });
  });
  return getSupplier(env.db, input.id, businessDateOf(env.clock.now(), env.timeZone));
}

// ---------- Balance adjustments ----------

function insertSupplierAdjustment(tx: Tx, supplierId: number, kind: 'OPENING' | 'ADJUSTMENT', amount: number, reason: string): number {
  const id = Number(
    tx.db
      .prepare(
        `INSERT INTO supplier_adjustments (supplier_id, kind, amount, reason, created_at, business_date, user_id, txn_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(supplierId, kind, amount, reason, tx.nowIso, tx.businessDate, tx.actor.userId, tx.txnRef).lastInsertRowid,
  );
  const counter = kind === 'OPENING' ? 'OWNER_EQUITY' : 'BALANCE_ADJUSTMENTS';
  const abs = Math.abs(amount);
  const party = { partyType: 'SUPPLIER' as const, partyId: supplierId };
  postLedger(tx, {
    refType: 'SUPPLIER_ADJUSTMENT',
    refId: id,
    memo: `${kind === 'OPENING' ? 'Opening balance' : 'Balance adjustment'}: ${reason}`,
    lines:
      amount > 0
        ? [
            { account: counter, debit: abs },
            { account: 'AP', credit: abs, ...party },
          ]
        : [
            { account: 'AP', debit: abs, ...party },
            { account: counter, credit: abs },
          ],
  });
  tx.audit({
    module: 'suppliers',
    entityType: 'supplier',
    entityId: supplierId,
    action: kind === 'OPENING' ? 'OPENING_BALANCE' : 'BALANCE_ADJUSTED',
    after: { amount, adjustmentId: id },
    reason,
    relatedType: 'supplier_adjustment',
    relatedId: id,
  });
  // An amount in the shop's favour settles the oldest open bills; a new amount owed uses any advance already paid.
  applySupplierCreditFifo(tx, supplierId);
  return id;
}

export function adjustSupplierBalance(
  env: AppEnv,
  actor: Actor,
  input: { requestId: string; supplierId: number; kind: 'OPENING' | 'ADJUSTMENT'; amount: number; reason: string },
): SupplierDetail {
  transact(env, actor, (tx) =>
    tx.once(input.requestId, 'suppliers.adjustBalance', () => {
      if (!tx.db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(input.supplierId)) throw new AppError(ErrorCodes.NOT_FOUND, 'Supplier not found.');
      return insertSupplierAdjustment(tx, input.supplierId, input.kind, input.amount, input.reason);
    }),
  );
  return getSupplier(env.db, input.supplierId, businessDateOf(env.clock.now(), env.timeZone));
}

// ---------- Ledger ----------

const LEDGER_DOCS = `
  CASE l.ref_type
    WHEN 'PURCHASE' THEN (SELECT purchase_no FROM purchases WHERE id = l.ref_id)
    WHEN 'PURCHASE_CANCEL' THEN (SELECT purchase_no FROM purchases WHERE id = l.ref_id)
    WHEN 'PURCHASE_REVISED' THEN (SELECT purchase_no FROM purchases WHERE id = l.ref_id)
    WHEN 'DEBIT_NOTE' THEN (SELECT debit_note_no FROM debit_notes WHERE id = l.ref_id)
    WHEN 'SUPPLIER_ADJUSTMENT' THEN 'ADJ-' || l.ref_id
    ELSE (SELECT payment_no FROM payments WHERE id = l.ref_id)
  END`;

const DESCRIPTIONS: Record<string, string> = {
  PURCHASE: 'Purchase bill',
  PURCHASE_CANCEL: 'Purchase cancelled',
  PURCHASE_REVISED: 'Purchase edited: earlier version reversed',
  DEBIT_NOTE: 'Goods returned (debit note)',
  SUPPLIER_PAYMENT: 'Payment made',
  SUPPLIER_REFUND: 'Refund received',
  SUPPLIER_PAYMENT_REVERSAL: 'Payment reversed',
  SUPPLIER_ADJUSTMENT: 'Balance adjustment',
};

const LEDGER_LIMIT = 5000;

/** The supplier's account from the ledger. Credits are amounts the shop owes; debits are payments and returns. */
export function supplierLedger(db: Db, supplierId: number, range: { from?: string; to?: string }, asOf: string): SupplierLedger {
  loadSupplier(db, supplierId, asOf);
  const fy = fiscalYearOf(asOf);
  const from = range.from ?? `${fy.slice(0, 4)}-04-01`;
  const to = range.to ?? asOf;
  const ap = apAccountId(db);
  const opening = (
    db
      .prepare(
        `SELECT COALESCE(SUM(credit - debit), 0) AS b FROM ledger_entries
         WHERE account_id = ? AND party_type = 'SUPPLIER' AND party_id = ? AND business_date < ?`,
      )
      .get(ap, supplierId, from) as { b: number }
  ).b;
  const raw = db
    .prepare(
      `SELECT l.occurred_at, l.business_date, l.ref_type, l.ref_id, l.memo, SUM(l.debit) AS debit, SUM(l.credit) AS credit,
              ${LEDGER_DOCS} AS doc_no
       FROM ledger_entries l
       WHERE l.account_id = ? AND l.party_type = 'SUPPLIER' AND l.party_id = ? AND l.business_date BETWEEN ? AND ?
       GROUP BY l.txn_ref, l.ref_type, l.ref_id
       ORDER BY l.occurred_at, l.id
       LIMIT ?`,
    )
    .all(ap, supplierId, from, to, LEDGER_LIMIT + 1) as {
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
    balance += r.credit - r.debit;
    totalDebit += r.debit;
    totalCredit += r.credit;
    return {
      occurredAt: r.occurred_at,
      businessDate: r.business_date,
      refType: r.ref_type,
      refId: r.ref_id,
      docNo: r.doc_no ?? '',
      description: r.ref_type === 'SUPPLIER_ADJUSTMENT' && r.memo ? r.memo : (DESCRIPTIONS[r.ref_type] ?? r.ref_type),
      debit: r.debit,
      credit: r.credit,
      balance,
    };
  });
  return { from, to, openingBalance: opening, rows, closingBalance: balance, totalDebit, totalCredit, truncated };
}
