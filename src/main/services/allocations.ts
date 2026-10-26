import type { Db } from '../db/connection';
import type { Tx } from '../db/tx';
import { AppError, ErrorCodes } from '@shared/errors';

export type SourceType = 'PAYMENT' | 'CREDIT_NOTE' | 'ADJUSTMENT' | 'DEPOSIT';
export type TargetType = 'INVOICE' | 'ADJUSTMENT' | 'REFUND';

export interface OpenReceivable {
  docType: 'INVOICE' | 'ADJUSTMENT';
  docId: number;
  docNo: string;
  businessDate: string;
  outstanding: number;
}

export interface CreditSource {
  sourceType: SourceType;
  sourceId: number;
  businessDate: string;
  unallocated: number;
}

/** Amounts the customer still owes, oldest first. */
export function openReceivables(db: Db, customerId: number, only?: { type: 'INVOICE' | 'ADJUSTMENT'; id: number }): OpenReceivable[] {
  const select = `SELECT doc_type AS docType, doc_id AS docId, doc_no AS docNo, business_date AS businessDate, outstanding
     FROM v_receivables WHERE customer_id = ? AND cancelled = 0 AND outstanding > 0`;
  // One document is looked up directly: a customer's full list can be long (the walk-in customer has every counter sale).
  if (only) return db.prepare(`${select} AND doc_type = ? AND doc_id = ?`).all(customerId, only.type, only.id) as OpenReceivable[];
  return db.prepare(`${select} ORDER BY business_date, doc_type, doc_id`).all(customerId) as OpenReceivable[];
}

/** Unused payments, credit notes and credit adjustments, oldest first. */
export function creditSources(db: Db, customerId: number, only?: { type: SourceType; id: number }): CreditSource[] {
  const select = `SELECT source_type AS sourceType, source_id AS sourceId, business_date AS businessDate, unallocated
     FROM v_credit_sources WHERE customer_id = ? AND reversed = 0 AND unallocated > 0`;
  if (only) return db.prepare(`${select} AND source_type = ? AND source_id = ?`).all(customerId, only.type, only.id) as CreditSource[];
  return db.prepare(`${select} ORDER BY business_date, source_type, source_id`).all(customerId) as CreditSource[];
}

export function availableCredit(db: Db, customerId: number): number {
  return creditSources(db, customerId).reduce((a, s) => a + s.unallocated, 0);
}

export function receivableOutstanding(db: Db, docType: 'INVOICE' | 'ADJUSTMENT', docId: number): number {
  const row = db
    .prepare('SELECT outstanding, cancelled FROM v_receivables WHERE doc_type = ? AND doc_id = ?')
    .get(docType, docId) as { outstanding: number; cancelled: number } | undefined;
  if (!row) throw new AppError(ErrorCodes.NOT_FOUND, 'That bill was not found.');
  return row.cancelled ? 0 : row.outstanding;
}

export function allocate(
  tx: Tx,
  source: { type: SourceType; id: number },
  target: { type: TargetType; id: number },
  amount: number,
  reason?: string,
): void {
  if (amount === 0) return;
  tx.db
    .prepare(
      `INSERT INTO allocations (source_type, source_id, target_type, target_id, amount, reason, created_at, user_id, txn_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(source.type, source.id, target.type, target.id, amount, reason ?? null, tx.nowIso, tx.actor.userId, tx.txnRef);
}

/**
 * Settles open receivables with available credit, oldest first on both sides.
 * Optionally limited to particular sources or targets. Returns the amount applied.
 */
export function applyCreditFifo(
  tx: Tx,
  customerId: number,
  opts: { onlySource?: { type: SourceType; id: number }; onlyTarget?: { type: 'INVOICE' | 'ADJUSTMENT'; id: number }; limit?: number } = {},
): number {
  const sources = creditSources(tx.db, customerId, opts.onlySource);
  const targets = openReceivables(tx.db, customerId, opts.onlyTarget);
  let budget = opts.limit ?? Number.MAX_SAFE_INTEGER;
  let applied = 0;
  let si = 0;
  const remaining = sources.map((s) => s.unallocated);
  for (const t of targets) {
    let need = t.outstanding;
    while (need > 0 && si < sources.length && budget > 0) {
      const take = Math.min(need, remaining[si]!, budget);
      if (take > 0) {
        allocate(tx, { type: sources[si]!.sourceType, id: sources[si]!.sourceId }, { type: t.docType, id: t.docId }, take);
        need -= take;
        remaining[si]! -= take;
        budget -= take;
        applied += take;
      }
      if (remaining[si] === 0) si++;
    }
    if (si >= sources.length || budget <= 0) break;
  }
  return applied;
}

/** Releases every allocation made to a target (e.g. a cancelled invoice), returning the money to its sources. */
export function releaseTarget(tx: Tx, target: { type: TargetType; id: number }, reason: string): number {
  const rows = tx.db
    .prepare(
      `SELECT source_type, source_id, SUM(amount) AS net FROM allocations
       WHERE target_type = ? AND target_id = ? GROUP BY source_type, source_id HAVING net != 0`,
    )
    .all(target.type, target.id) as { source_type: SourceType; source_id: number; net: number }[];
  let released = 0;
  for (const r of rows) {
    allocate(tx, { type: r.source_type, id: r.source_id }, target, -r.net, reason);
    released += r.net;
  }
  return released;
}

/** Releases every allocation made from a source (e.g. a reversed payment), reopening what it had settled. */
export function releaseSource(tx: Tx, source: { type: SourceType; id: number }, reason: string): number {
  const rows = tx.db
    .prepare(
      `SELECT target_type, target_id, SUM(amount) AS net FROM allocations
       WHERE source_type = ? AND source_id = ? GROUP BY target_type, target_id HAVING net != 0`,
    )
    .all(source.type, source.id) as { target_type: TargetType; target_id: number; net: number }[];
  let released = 0;
  for (const r of rows) {
    allocate(tx, source, { type: r.target_type, id: r.target_id }, -r.net, reason);
    released += r.net;
  }
  return released;
}

/** Net amount a source has passed to refunds; such money cannot be released by reversing the source. */
export function refundedFromSource(db: Db, source: { type: SourceType; id: number }): number {
  return (
    db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS n FROM allocations
         WHERE source_type = ? AND source_id = ? AND target_type = 'REFUND'`,
      )
      .get(source.type, source.id) as { n: number }
  ).n;
}
