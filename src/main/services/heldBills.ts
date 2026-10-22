import type { Db } from '../db/connection';
import { transact, type Actor } from '../db/tx';
import type { AppEnv } from './env';
import { AppError, ErrorCodes } from '@shared/errors';
import type { CartDraft, HeldBillRow } from '@shared/contracts';

/** Parked bills at the counter. They are drafts, not financial records, so they are not audited and may be deleted. */
export function listHeldBills(db: Db): HeldBillRow[] {
  return (
    db
      .prepare(
        `SELECT h.*, c.name AS customer_name, c.is_walkin, u.username FROM held_bills h
         LEFT JOIN customers c ON c.id = h.customer_id LEFT JOIN users u ON u.id = h.user_id ORDER BY h.id DESC`,
      )
      .all() as { id: number; label: string; cart_json: string; created_at: string; customer_name: string | null; is_walkin: number | null; username: string | null }[]
  ).map((h) => {
    const cart = JSON.parse(h.cart_json) as CartDraft;
    return {
      id: h.id,
      label: h.label,
      customerName: h.is_walkin ? cart.walkInName || null : h.customer_name,
      lineCount: cart.lines.length,
      createdAt: h.created_at,
      username: h.username,
      cart,
    };
  });
}

export function saveHeldBill(env: AppEnv, actor: Actor, input: { label: string; cart: CartDraft }): HeldBillRow {
  const id = transact(env, actor, (tx) => {
    if ((tx.db.prepare('SELECT COUNT(*) AS n FROM held_bills').get() as { n: number }).n >= 50) {
      throw new AppError(ErrorCodes.BUSINESS_RULE, 'There are already 50 held bills. Finish or delete some first.');
    }
    return Number(
      tx.db
        .prepare('INSERT INTO held_bills (label, customer_id, cart_json, created_at, user_id) VALUES (?, ?, ?, ?, ?)')
        .run(input.label, input.cart.customerId, JSON.stringify(input.cart), tx.nowIso, tx.actor.userId).lastInsertRowid,
    );
  });
  return listHeldBills(env.db).find((h) => h.id === id)!;
}

export function deleteHeldBill(env: AppEnv, actor: Actor, id: number): void {
  transact(env, actor, (tx) => {
    tx.db.prepare('DELETE FROM held_bills WHERE id = ?').run(id);
  });
}
