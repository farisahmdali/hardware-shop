import type { Db } from '../db/connection';
import type { Tx } from '../db/tx';
import { AppError, ErrorCodes } from '@shared/errors';

/**
 * The supplier side mirror of ./allocations: what the shop has paid or been credited (sources)
 * linked to what it owes (targets). Kept in its own table so customer and supplier
 * balances are never netted against each other.
 */
export type SupplierSourceType = 'PAYMENT' | 'DEBIT_NOTE' | 'ADJUSTMENT';
export type SupplierTargetType = 'PURCHASE' | 'ADJUSTMENT' | 'REFUND';

export interface OpenPayable {
  docType: 'PURCHASE' | 'ADJUSTMENT';
  docId: number;
  docNo: string;
  billDate: string;
  outstanding: number;
}

export interface SupplierCredit {
  sourceType: SupplierSourceType;
  sourceId: number;
  businessDate: string;
  unallocated: number;
}

/** Amounts the shop still owes the supplier, oldest bill first. */
export function openPayables(db: Db, supplierId: number): OpenPayable[] {
  return db
    .prepare(
      `SELECT doc_type AS docType, doc_id AS docId, doc_no AS docNo, bill_date AS billDate, outstanding
       FROM v_payables WHERE supplier_id = ? AND cancelled = 0 AND outstanding > 0
       ORDER BY bill_date, doc_type, doc_id`,
    )
    .all(supplierId) as OpenPayable[];
}

/** Unused payments, debit notes and corrections in the shop's favour, oldest first. */
export function supplierCredits(db: Db, supplierId: number): SupplierCredit[] {
  return db
    .prepare(
      `SELECT source_type AS sourceType, source_id AS sourceId, business_date AS businessDate, unallocated
       FROM v_supplier_credits WHERE supplier_id = ? AND reversed = 0 AND unallocated > 0
       ORDER BY business_date, source_type, source_id`,
    )
    .all(supplierId) as SupplierCredit[];
}

export function availableSupplierCredit(db: Db, supplierId: number): number {
  return supplierCredits(db, supplierId).reduce((a, s) => a + s.unallocated, 0);
}

export function payableOutstanding(db: Db, docType: 'PURCHASE' | 'ADJUSTMENT', docId: number): number {
  const row = db
    .prepare('SELECT outstanding, cancelled FROM v_payables WHERE doc_type = ? AND doc_id = ?')
    .get(docType, docId) as { outstanding: number; cancelled: number } | undefined;
  if (!row) throw new AppError(ErrorCodes.NOT_FOUND, 'That bill was not found.');
  return row.cancelled ? 0 : row.outstanding;
}

export function allocateSupplier(
  tx: Tx,
  source: { type: SupplierSourceType; id: number },
  target: { type: SupplierTargetType; id: number },
  amount: number,
  reason?: string,
): void {
  if (amount === 0) return;
  tx.db
    .prepare(
      `INSERT INTO supplier_allocations (source_type, source_id, target_type, target_id, amount, reason, created_at, user_id, txn_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(source.type, source.id, target.type, target.id, amount, reason ?? null, tx.nowIso, tx.actor.userId, tx.txnRef);
}

/**
 * Settles open payables with available supplier credit, oldest first on both sides.
 * Optionally limited to particular sources or targets. Returns the amount applied.
 */
export function applySupplierCreditFifo(
  tx: Tx,
  supplierId: number,
  opts: { onlySource?: { type: SupplierSourceType; id: number }; onlyTarget?: { type: 'PURCHASE' | 'ADJUSTMENT'; id: number } } = {},
): number {
  let sources = supplierCredits(tx.db, supplierId);
  if (opts.onlySource) sources = sources.filter((s) => s.sourceType === opts.onlySource!.type && s.sourceId === opts.onlySource!.id);
  let targets = openPayables(tx.db, supplierId);
  if (opts.onlyTarget) targets = targets.filter((t) => t.docType === opts.onlyTarget!.type && t.docId === opts.onlyTarget!.id);
  let applied = 0;
  let si = 0;
  const remaining = sources.map((s) => s.unallocated);
  for (const t of targets) {
    let need = t.outstanding;
    while (need > 0 && si < sources.length) {
      const take = Math.min(need, remaining[si]!);
      if (take > 0) {
        allocateSupplier(tx, { type: sources[si]!.sourceType, id: sources[si]!.sourceId }, { type: t.docType, id: t.docId }, take);
        need -= take;
        remaining[si]! -= take;
        applied += take;
      }
      if (remaining[si] === 0) si++;
    }
    if (si >= sources.length) break;
  }
  return applied;
}

/** Releases every allocation made to a target (e.g. a cancelled purchase), returning the money to its sources. */
export function releaseSupplierTarget(tx: Tx, target: { type: SupplierTargetType; id: number }, reason: string): number {
  const rows = tx.db
    .prepare(
      `SELECT source_type, source_id, SUM(amount) AS net FROM supplier_allocations
       WHERE target_type = ? AND target_id = ? GROUP BY source_type, source_id HAVING net != 0`,
    )
    .all(target.type, target.id) as { source_type: SupplierSourceType; source_id: number; net: number }[];
  let released = 0;
  for (const r of rows) {
    allocateSupplier(tx, { type: r.source_type, id: r.source_id }, target, -r.net, reason);
    released += r.net;
  }
  return released;
}

/** Releases every allocation made from a source (e.g. a reversed payment), reopening what it had settled. */
export function releaseSupplierSource(tx: Tx, source: { type: SupplierSourceType; id: number }, reason: string): number {
  const rows = tx.db
    .prepare(
      `SELECT target_type, target_id, SUM(amount) AS net FROM supplier_allocations
       WHERE source_type = ? AND source_id = ? GROUP BY target_type, target_id HAVING net != 0`,
    )
    .all(source.type, source.id) as { target_type: SupplierTargetType; target_id: number; net: number }[];
  let released = 0;
  for (const r of rows) {
    allocateSupplier(tx, source, { type: r.target_type, id: r.target_id }, -r.net, reason);
    released += r.net;
  }
  return released;
}

/** Net amount a source has passed to refunds received; it cannot be released by reversing the source. */
export function refundedFromSupplierSource(db: Db, source: { type: SupplierSourceType; id: number }): number {
  return (
    db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS n FROM supplier_allocations
         WHERE source_type = ? AND source_id = ? AND target_type = 'REFUND'`,
      )
      .get(source.type, source.id) as { n: number }
  ).n;
}
