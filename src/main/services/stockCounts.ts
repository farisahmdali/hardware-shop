import type { Db } from '../db/connection';
import { transact, type Actor } from '../db/tx';
import type { AppEnv } from './env';
import { recordMovement } from './stock';
import { toFtsQuery } from './products';
import { AppError, ErrorCodes } from '@shared/errors';
import { QTY_SCALE } from '@shared/qty';
import type { Paged, StockCountLine, StockCountRow } from '@shared/contracts';

interface CountRecord {
  id: number;
  count_no: string;
  status: StockCountRow['status'];
  category_name: string | null;
  notes: string;
  started_at: string;
  started_by_name: string | null;
  closed_at: string | null;
  closed_by_name: string | null;
  close_reason: string | null;
  line_count: number;
  counted_count: number;
  variance_count: number;
  version: number;
}

// Open counts compare with the live balance; closed counts with the balance recorded at finalization.
const COUNT_SELECT = `
  SELECT sc.*, c.name AS category_name, us.username AS started_by_name, uc.username AS closed_by_name,
    (SELECT COUNT(*) FROM stock_count_lines l WHERE l.count_id = sc.id) AS line_count,
    (SELECT COUNT(*) FROM stock_count_lines l WHERE l.count_id = sc.id AND l.counted_qty IS NOT NULL) AS counted_count,
    (SELECT COUNT(*) FROM stock_count_lines l JOIN stock_balances b ON b.product_id = l.product_id
       WHERE l.count_id = sc.id AND l.counted_qty IS NOT NULL
         AND l.counted_qty != CASE WHEN sc.status = 'OPEN' THEN b.qty ELSE COALESCE(l.final_system_qty, l.counted_qty) END
    ) AS variance_count
  FROM stock_counts sc
  LEFT JOIN categories c ON c.id = sc.category_id
  LEFT JOIN users us ON us.id = sc.started_by
  LEFT JOIN users uc ON uc.id = sc.closed_by`;

const toRow = (r: CountRecord): StockCountRow => ({
  id: r.id,
  countNo: r.count_no,
  status: r.status,
  categoryName: r.category_name,
  notes: r.notes,
  startedAt: r.started_at,
  startedBy: r.started_by_name,
  closedAt: r.closed_at,
  closedBy: r.closed_by_name,
  closeReason: r.close_reason,
  lineCount: r.line_count,
  countedCount: r.counted_count,
  varianceCount: r.variance_count,
  version: r.version,
});

export function listCounts(db: Db): StockCountRow[] {
  return (db.prepare(`${COUNT_SELECT} ORDER BY sc.id DESC LIMIT 200`).all() as CountRecord[]).map(toRow);
}

export function getCount(db: Db, id: number): StockCountRow {
  const r = db.prepare(`${COUNT_SELECT} WHERE sc.id = ?`).get(id) as CountRecord | undefined;
  if (!r) throw new AppError(ErrorCodes.NOT_FOUND, 'Stock count not found.');
  return toRow(r);
}

export function countLines(
  db: Db,
  f: { id: number; search?: string; show: 'ALL' | 'UNCOUNTED' | 'COUNTED' | 'VARIANCE'; page: number; pageSize: number },
): Paged<StockCountLine> {
  const count = getCount(db, f.id);
  const current = count.status === 'OPEN' ? 'b.qty' : 'COALESCE(l.final_system_qty, b.qty)';
  const where = ['l.count_id = ?'];
  const params: unknown[] = [f.id];
  if (f.show === 'UNCOUNTED') where.push('l.counted_qty IS NULL');
  if (f.show === 'COUNTED') where.push('l.counted_qty IS NOT NULL');
  if (f.show === 'VARIANCE') where.push(`l.counted_qty IS NOT NULL AND l.counted_qty != ${current}`);
  const fts = f.search ? toFtsQuery(f.search) : null;
  if (fts) {
    where.push('(l.product_id IN (SELECT rowid FROM products_fts WHERE products_fts MATCH ?) OR p.sku = ?)');
    params.push(fts, f.search);
  }
  const from = `FROM stock_count_lines l JOIN products p ON p.id = l.product_id JOIN units u ON u.id = p.unit_id
                JOIN stock_balances b ON b.product_id = l.product_id WHERE ${where.join(' AND ')}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT l.product_id, p.sku, p.name, u.code AS unit_code, u.allow_decimal, l.system_qty, ${current} AS current_qty,
              l.counted_qty, l.note
       ${from} ORDER BY p.name COLLATE NOCASE, p.id LIMIT ? OFFSET ?`,
    )
    .all(...params, f.pageSize, (f.page - 1) * f.pageSize) as {
    product_id: number;
    sku: string;
    name: string;
    unit_code: string;
    allow_decimal: number;
    system_qty: number;
    current_qty: number;
    counted_qty: number | null;
    note: string;
  }[];
  return {
    rows: rows.map((r) => ({
      productId: r.product_id,
      sku: r.sku,
      name: r.name,
      unitCode: r.unit_code,
      allowDecimal: r.allow_decimal === 1,
      systemQty: r.system_qty,
      currentQty: r.current_qty,
      countedQty: r.counted_qty,
      variance: r.counted_qty === null ? null : r.counted_qty - r.current_qty,
      note: r.note,
    })),
    total,
    page: f.page,
    pageSize: f.pageSize,
  };
}

/** Starts a count covering every active product (or one category), snapshotting the system quantities. */
export function createCount(env: AppEnv, actor: Actor, input: { categoryId: number | null; notes: string; requestId: string }): StockCountRow {
  const id = transact(env, actor, (tx) =>
    tx.once(input.requestId, 'stockCounts.create', () => {
      const open = tx.db.prepare("SELECT count_no FROM stock_counts WHERE status = 'OPEN'").get() as { count_no: string } | undefined;
      if (open) {
        throw new AppError(ErrorCodes.BUSINESS_RULE, `Stock count ${open.count_no} is still open. Finish or cancel it first.`);
      }
      const countNo = tx.nextDocNumber('STOCK_COUNT');
      const countId = Number(
        tx.db
          .prepare('INSERT INTO stock_counts (count_no, category_id, notes, started_at, started_by) VALUES (?, ?, ?, ?, ?)')
          .run(countNo, input.categoryId, input.notes, tx.nowIso, tx.actor.userId).lastInsertRowid,
      );
      const lines = tx.db
        .prepare(
          `INSERT INTO stock_count_lines (count_id, product_id, system_qty)
           SELECT ?, p.id, b.qty FROM products p JOIN stock_balances b ON b.product_id = p.id
           WHERE p.is_active = 1 AND (? IS NULL OR p.category_id = ?)`,
        )
        .run(countId, input.categoryId, input.categoryId).changes;
      if (lines === 0) throw new AppError(ErrorCodes.BUSINESS_RULE, 'There are no active products to count.');
      tx.audit({
        module: 'stock',
        entityType: 'stock_count',
        entityId: countId,
        action: 'CREATE',
        after: { countNo, categoryId: input.categoryId, products: lines, notes: input.notes },
      });
      return countId;
    }),
  );
  return getCount(env.db, id);
}

/** Saves counted quantities on an open count. Draft entries are not business records, so they are not audited one by one. */
export function saveCountLines(
  env: AppEnv,
  actor: Actor,
  input: { id: number; lines: { productId: number; countedQty: number | null; note: string }[] },
): { saved: number } {
  return transact(env, actor, (tx) => {
    const count = getCount(tx.db, input.id);
    if (count.status !== 'OPEN') throw new AppError(ErrorCodes.BUSINESS_RULE, 'This stock count is closed.');
    const unitOf = tx.db.prepare(
      'SELECT u.allow_decimal, p.name FROM products p JOIN units u ON u.id = p.unit_id WHERE p.id = ?',
    );
    const update = tx.db.prepare(
      `UPDATE stock_count_lines SET counted_qty = ?, note = ?, updated_at = ?, updated_by = ?
       WHERE count_id = ? AND product_id = ?`,
    );
    let saved = 0;
    for (const line of input.lines) {
      const unit = unitOf.get(line.productId) as { allow_decimal: number; name: string } | undefined;
      if (unit && !unit.allow_decimal && line.countedQty !== null && line.countedQty % QTY_SCALE !== 0) {
        throw new AppError(ErrorCodes.VALIDATION, `${unit.name} is counted in whole units.`);
      }
      saved += update.run(line.countedQty, line.note, tx.nowIso, tx.actor.userId, input.id, line.productId).changes;
    }
    return { saved };
  });
}

/**
 * Closes the count. Every counted product whose quantity differs from the stock
 * level at this moment gets a RECONCILE movement for the difference, all in one transaction.
 */
export function finalizeCount(
  env: AppEnv,
  actor: Actor,
  input: { id: number; version: number; reason: string; requestId: string },
): StockCountRow {
  transact(env, actor, (tx) =>
    tx.once(input.requestId, 'stockCounts.finalize', () => {
      const count = getCount(tx.db, input.id);
      if (count.status !== 'OPEN') throw new AppError(ErrorCodes.BUSINESS_RULE, 'This stock count is already closed.');
      if (count.version !== input.version) {
        throw new AppError(ErrorCodes.STALE_RECORD, 'This stock count was changed by someone else. Reload and try again.');
      }
      if (count.countedCount === 0) throw new AppError(ErrorCodes.BUSINESS_RULE, 'Enter at least one counted quantity first.');

      const lines = tx.db
        .prepare(
          `SELECT l.id, l.product_id, l.counted_qty, b.qty, p.name FROM stock_count_lines l
           JOIN stock_balances b ON b.product_id = l.product_id JOIN products p ON p.id = l.product_id
           WHERE l.count_id = ? AND l.counted_qty IS NOT NULL`,
        )
        .all(input.id) as { id: number; product_id: number; counted_qty: number; qty: number; name: string }[];
      const setLine = tx.db.prepare('UPDATE stock_count_lines SET final_system_qty = ?, movement_id = ? WHERE id = ?');
      const variances: { product: string; system: number; counted: number; difference: number; costValue: number }[] = [];
      for (const l of lines) {
        let movementId: number | null = null;
        const diff = l.counted_qty - l.qty;
        if (diff !== 0) {
          const m = recordMovement(tx, {
            productId: l.product_id,
            type: 'RECONCILE',
            qtyChange: diff,
            reason: `Stock count ${count.countNo}: ${input.reason}`,
            refType: 'STOCK_COUNT',
            refId: input.id,
            // A count can correct a negative balance back up; it never creates one.
            allowNegative: false,
          });
          movementId = m.id;
          variances.push({ product: l.name, system: l.qty, counted: l.counted_qty, difference: diff, costValue: m.costValue });
        }
        setLine.run(l.qty, movementId, l.id);
      }
      tx.db
        .prepare(
          `UPDATE stock_counts SET status = 'FINALIZED', closed_at = ?, closed_by = ?, close_reason = ?, version = version + 1
           WHERE id = ? AND status = 'OPEN'`,
        )
        .run(tx.nowIso, tx.actor.userId, input.reason, input.id);
      tx.audit({
        module: 'stock',
        entityType: 'stock_count',
        entityId: input.id,
        action: 'FINALIZE',
        after: { countNo: count.countNo, counted: lines.length, adjusted: variances.length, variances: variances.slice(0, 200) },
        reason: input.reason,
      });
      return input.id;
    }),
  );
  return getCount(env.db, input.id);
}

export function cancelCount(env: AppEnv, actor: Actor, input: { id: number; version: number; reason: string }): StockCountRow {
  transact(env, actor, (tx) => {
    const count = getCount(tx.db, input.id);
    if (count.status !== 'OPEN') throw new AppError(ErrorCodes.BUSINESS_RULE, 'This stock count is already closed.');
    const result = tx.db
      .prepare(
        `UPDATE stock_counts SET status = 'CANCELLED', closed_at = ?, closed_by = ?, close_reason = ?, version = version + 1
         WHERE id = ? AND version = ?`,
      )
      .run(tx.nowIso, tx.actor.userId, input.reason, input.id, input.version);
    tx.expectOneChange(result.changes, 'This stock count');
    tx.audit({ module: 'stock', entityType: 'stock_count', entityId: input.id, action: 'CANCEL', reason: input.reason, after: { countNo: count.countNo } });
  });
  return getCount(env.db, input.id);
}
