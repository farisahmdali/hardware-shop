import type { Db } from '../../db/connection';
import { transact, type Actor, type Tx } from '../../db/tx';
import type { AppEnv } from '../env';
import { itemKey } from './itemMatch';
import { AppError, ErrorCodes } from '@shared/errors';
import type { SupplierItemName } from '@shared/contracts';

/**
 * Remembers what the supplier calls each product, from the lines of a scanned bill being saved.
 * A name the person linked to a different product this time follows the new choice.
 */
export function rememberItemNames(tx: Tx, supplierId: number, lines: { productId: number; scannedText?: string }[]): number {
  if (!lines.some((l) => l.scannedText?.trim())) return 0;
  const upsert = tx.db.prepare(
    `INSERT INTO supplier_item_names (supplier_id, item_key, item_text, product_id, uses, first_used_at, last_used_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (supplier_id, item_key) DO UPDATE SET
       uses = CASE WHEN product_id = excluded.product_id THEN uses + 1 ELSE 1 END,
       product_id = excluded.product_id, item_text = excluded.item_text, last_used_at = excluded.last_used_at`,
  );
  let n = 0;
  for (const l of lines) {
    const text = l.scannedText?.trim();
    const key = text ? itemKey(text) : '';
    if (!text || !key) continue;
    upsert.run(supplierId, key, text, l.productId, tx.nowIso, tx.nowIso);
    n++;
  }
  return n;
}

export function listItemNames(db: Db, supplierId: number): SupplierItemName[] {
  const rows = db
    .prepare(
      `SELECT n.id, n.item_text, n.product_id, p.name AS product_name, p.sku, n.uses, n.last_used_at
       FROM supplier_item_names n JOIN products p ON p.id = n.product_id
       WHERE n.supplier_id = ? ORDER BY n.item_text COLLATE NOCASE`,
    )
    .all(supplierId) as { id: number; item_text: string; product_id: number; product_name: string; sku: string; uses: number; last_used_at: string }[];
  return rows.map((r) => ({
    id: r.id,
    itemText: r.item_text,
    productId: r.product_id,
    productName: r.product_name,
    sku: r.sku,
    uses: r.uses,
    lastUsedAt: r.last_used_at,
  }));
}

/** Forgets a link, e.g. one made by mistake; the next bill asks again. */
export function removeItemName(env: AppEnv, actor: Actor, input: { id: number; supplierId: number }): SupplierItemName[] {
  transact(env, actor, (tx) => {
    const row = tx.db
      .prepare(
        `SELECT n.item_text, p.name AS product_name, s.name AS supplier_name FROM supplier_item_names n
         JOIN products p ON p.id = n.product_id JOIN suppliers s ON s.id = n.supplier_id
         WHERE n.id = ? AND n.supplier_id = ?`,
      )
      .get(input.id, input.supplierId) as { item_text: string; product_name: string; supplier_name: string } | undefined;
    if (!row) throw new AppError(ErrorCodes.NOT_FOUND, 'That item name is no longer remembered.');
    tx.db.prepare('DELETE FROM supplier_item_names WHERE id = ?').run(input.id);
    tx.audit({
      module: 'suppliers',
      entityType: 'supplier',
      entityId: input.supplierId,
      action: 'ITEM_NAME_FORGOTTEN',
      before: { itemName: row.item_text, product: row.product_name },
    });
  });
  return listItemNames(env.db, input.supplierId);
}
