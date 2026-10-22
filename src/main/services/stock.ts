import type { Db } from '../db/connection';
import { transact, type Actor, type Tx } from '../db/tx';
import type { AppEnv } from './env';
import { postLedger, type AccountCode } from './ledger';
import { AppError, ErrorCodes } from '@shared/errors';
import { mulDivRound } from '@shared/money';
import { formatQty, QTY_SCALE } from '@shared/qty';
import { MOVEMENT_TYPES, type ManualAdjustment, type MovementType } from '@shared/stock';
import type { MovementRow, Paged, StockSummary } from '@shared/contracts';

export interface MovementInput {
  productId: number;
  type: MovementType;
  /** Signed change in milli-units. */
  qtyChange: number;
  /** Cost per whole unit (paise) for stock coming in at a known cost. Otherwise the current average is used. */
  unitCost?: number;
  reason?: string | null;
  refType?: string | null;
  refId?: string | number | null;
  /** Permit the balance to go below zero (authorised override; needs a reason). */
  allowNegative?: boolean;
  /**
   * Account on the other side of the inventory value change. Omit for the default of the
   * movement type; pass null when the caller posts the ledger entry itself.
   */
  counterAccount?: AccountCode | null;
  /** Write an audit entry for this movement (manual operations). Document-driven movements are audited by the document. */
  audit?: boolean;
  /**
   * Exact signed value change, for stock coming back at the cost it left with
   * (cancelled sales, customer returns), so reversals restore value to the paisa.
   */
  costValue?: number;
}

export interface RecordedMovement {
  id: number;
  qtyBefore: number;
  qtyAfter: number;
  costValue: number;
  unitCost: number;
}

const DEFAULT_COUNTER: Partial<Record<MovementType, AccountCode>> = {
  OPENING: 'OWNER_EQUITY',
  RECEIPT: 'OWNER_EQUITY',
  ADJUST_IN: 'INVENTORY_LOSS',
  ADJUST_OUT: 'INVENTORY_LOSS',
  DAMAGE: 'INVENTORY_LOSS',
  LOSS: 'INVENTORY_LOSS',
  RECONCILE: 'INVENTORY_LOSS',
  SALE: 'COGS',
  SALE_CANCEL: 'COGS',
  CUSTOMER_RETURN: 'COGS',
};

interface ProductStock {
  qty: number;
  value: number;
  purchase_price: number;
  allow_decimal: number;
  unit_code: string;
  name: string;
}

function productStock(db: Db, productId: number): ProductStock {
  const row = db
    .prepare(
      `SELECT b.qty, b.value, p.purchase_price, p.name, u.allow_decimal, u.code AS unit_code
       FROM products p JOIN stock_balances b ON b.product_id = p.id JOIN units u ON u.id = p.unit_id
       WHERE p.id = ?`,
    )
    .get(productId) as ProductStock | undefined;
  if (!row) throw new AppError(ErrorCodes.NOT_FOUND, 'Product not found.');
  return row;
}

/**
 * Inventory value change for a movement under moving weighted-average costing.
 *
 * - Incoming stock with a known cost adds qty × cost; without one it comes in at the current average.
 * - Outgoing stock leaves at the current average: value × qtyOut / qtyOnHand.
 * - When the balance reaches exactly zero, all remaining value is removed so no stray paise remain.
 * - After an authorised negative balance, the next receipt resets the average to the incoming cost.
 */
export function costOfMovement(
  balance: { qty: number; value: number },
  qtyChange: number,
  opts: { unitCost?: number; fallbackUnitCost: number },
): number {
  const { qty, value } = balance;
  const qtyAfter = qty + qtyChange;
  if (qtyAfter === 0) return -value;

  if (qtyChange > 0) {
    const unitCost =
      opts.unitCost ?? (qty > 0 ? mulDivRound(value, QTY_SCALE, qty) : opts.fallbackUnitCost);
    if (qty < 0) {
      const newValue = qtyAfter > 0 ? mulDivRound(qtyAfter, unitCost, QTY_SCALE) : -mulDivRound(-qtyAfter, unitCost, QTY_SCALE);
      return newValue - value;
    }
    if (opts.unitCost === undefined && qty > 0) return mulDivRound(value, qtyChange, qty);
    return mulDivRound(qtyChange, unitCost, QTY_SCALE);
  }

  const out = -qtyChange;
  if (qty <= 0) return -mulDivRound(out, opts.fallbackUnitCost, QTY_SCALE);
  if (out <= qty) return -mulDivRound(value, out, qty);
  // Going below zero (override): what is on hand leaves at its value, the shortfall at the average cost.
  const average = mulDivRound(value, QTY_SCALE, qty);
  return -(value + mulDivRound(out - qty, average, QTY_SCALE));
}

/**
 * Records one stock movement and its inventory-value ledger entry. The database
 * triggers update stock_balances from the movement and refuse a movement that does
 * not start from the current balance, so balances can never drift from the ledger.
 */
export function recordMovement(tx: Tx, input: MovementInput): RecordedMovement {
  if (!Number.isSafeInteger(input.qtyChange) || input.qtyChange === 0) {
    throw new AppError(ErrorCodes.VALIDATION, 'The quantity must not be zero.');
  }
  const p = productStock(tx.db, input.productId);
  if (!p.allow_decimal && input.qtyChange % QTY_SCALE !== 0) {
    throw new AppError(ErrorCodes.VALIDATION, `${p.name} is counted in whole ${p.unit_code}; decimals are not allowed.`);
  }
  const qtyAfter = p.qty + input.qtyChange;
  if (qtyAfter < 0 && !input.allowNegative) {
    throw new AppError(
      ErrorCodes.BUSINESS_RULE,
      `Not enough stock of ${p.name}: ${formatQty(p.qty)} ${p.unit_code} available, ${formatQty(-input.qtyChange)} requested.`,
      { available: p.qty, requested: -input.qtyChange },
    );
  }
  const costValue =
    input.costValue ??
    costOfMovement(p, input.qtyChange, {
      unitCost: input.unitCost,
      fallbackUnitCost: p.purchase_price,
    });
  const unitCost = input.unitCost ?? mulDivRound(Math.abs(costValue), QTY_SCALE, Math.abs(input.qtyChange));

  const id = Number(
    tx.db
      .prepare(
        `INSERT INTO stock_movements (product_id, type, qty_before, qty_change, qty_after, unit_cost, cost_value,
           value_before, value_after, negative_override, reason, ref_type, ref_id, user_id, occurred_at, business_date, txn_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.productId,
        input.type,
        p.qty,
        input.qtyChange,
        qtyAfter,
        unitCost,
        costValue,
        p.value,
        p.value + costValue,
        qtyAfter < 0 ? 1 : 0,
        input.reason ?? null,
        input.refType ?? null,
        input.refId === undefined || input.refId === null ? null : String(input.refId),
        tx.actor.userId,
        tx.nowIso,
        tx.businessDate,
        tx.txnRef,
      ).lastInsertRowid,
  );

  const counter = input.counterAccount === undefined ? DEFAULT_COUNTER[input.type] : input.counterAccount;
  if (counter === undefined) throw new Error(`No ledger account mapping for movement type ${input.type}`);
  if (counter !== null && costValue !== 0) {
    const amount = Math.abs(costValue);
    postLedger(tx, {
      refType: 'STOCK_MOVEMENT',
      refId: id,
      memo: `${MOVEMENT_TYPES[input.type].label}: ${p.name}`,
      lines:
        costValue > 0
          ? [
              { account: 'INVENTORY', debit: amount },
              { account: counter, credit: amount },
            ]
          : [
              { account: counter, debit: amount },
              { account: 'INVENTORY', credit: amount },
            ],
    });
  }

  if (input.audit) {
    tx.audit({
      module: 'stock',
      entityType: 'product',
      entityId: input.productId,
      action: `STOCK_${input.type}`,
      before: { qty: p.qty, value: p.value },
      after: { qty: qtyAfter, value: p.value + costValue, qtyChange: input.qtyChange, unitCost, movementId: id },
      reason: input.reason ?? null,
      relatedType: 'stock_movement',
      relatedId: id,
    });
  }
  return { id, qtyBefore: p.qty, qtyAfter, costValue, unitCost };
}

// ---------- Manual adjustments ----------

const SIGN: Record<ManualAdjustment, 1 | -1> = { RECEIPT: 1, ADJUST_IN: 1, ADJUST_OUT: -1, DAMAGE: -1, LOSS: -1 };

export function adjustStock(
  env: AppEnv,
  actor: Actor,
  input: { requestId: string; productId: number; kind: ManualAdjustment; qty: number; unitCost?: number; reason: string },
  canSeeCost: boolean,
): MovementRow {
  const movementId = transact(env, actor, (tx) =>
    tx.once(input.requestId, 'stock.adjust', () => {
      const product = productStock(tx.db, input.productId);
      const unitCost = input.kind === 'RECEIPT' ? (input.unitCost ?? product.purchase_price) : undefined;
      return recordMovement(tx, {
        productId: input.productId,
        type: input.kind,
        qtyChange: SIGN[input.kind] * input.qty,
        unitCost,
        reason: input.reason || null,
        refType: 'MANUAL',
        audit: true,
      }).id;
    }),
  );
  return getMovement(env.db, movementId, canSeeCost);
}

// ---------- Queries ----------

interface MovementRecord {
  id: number;
  product_id: number;
  sku: string;
  name: string;
  unit_code: string;
  type: MovementType;
  qty_before: number;
  qty_change: number;
  qty_after: number;
  unit_cost: number;
  cost_value: number;
  reason: string | null;
  ref_type: string | null;
  ref_id: string | null;
  username: string | null;
  occurred_at: string;
  negative_override: number;
}

const MOVEMENT_SELECT = `
  SELECT m.*, p.sku, p.name, u.code AS unit_code, us.username
  FROM stock_movements m
  JOIN products p ON p.id = m.product_id
  JOIN units u ON u.id = p.unit_id
  LEFT JOIN users us ON us.id = m.user_id`;

const toMovementRow = (r: MovementRecord, canSeeCost: boolean): MovementRow => ({
  id: r.id,
  productId: r.product_id,
  sku: r.sku,
  productName: r.name,
  unitCode: r.unit_code,
  type: r.type,
  qtyBefore: r.qty_before,
  qtyChange: r.qty_change,
  qtyAfter: r.qty_after,
  unitCost: canSeeCost ? r.unit_cost : null,
  costValue: canSeeCost ? r.cost_value : null,
  reason: r.reason,
  refType: r.ref_type,
  refId: r.ref_id,
  username: r.username,
  occurredAt: r.occurred_at,
  negativeOverride: r.negative_override === 1,
});

export function getMovement(db: Db, id: number, canSeeCost: boolean): MovementRow {
  const row = db.prepare(`${MOVEMENT_SELECT} WHERE m.id = ?`).get(id) as MovementRecord | undefined;
  if (!row) throw new AppError(ErrorCodes.NOT_FOUND, 'Stock movement not found.');
  return toMovementRow(row, canSeeCost);
}

export function listMovements(
  db: Db,
  f: { productId?: number; type?: MovementType; from?: string; to?: string; page: number; pageSize: number },
  canSeeCost: boolean,
): Paged<MovementRow> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.productId) {
    where.push('m.product_id = ?');
    params.push(f.productId);
  }
  if (f.type) {
    where.push('m.type = ?');
    params.push(f.type);
  }
  if (f.from) {
    where.push('m.business_date >= ?');
    params.push(f.from);
  }
  if (f.to) {
    where.push('m.business_date <= ?');
    params.push(f.to);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM stock_movements m ${clause}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`${MOVEMENT_SELECT} ${clause} ORDER BY m.id DESC LIMIT ? OFFSET ?`)
    .all(...params, f.pageSize, (f.page - 1) * f.pageSize) as MovementRecord[];
  return { rows: rows.map((r) => toMovementRow(r, canSeeCost)), total, page: f.page, pageSize: f.pageSize };
}

export function stockSummary(db: Db, canSeeCost: boolean): StockSummary {
  const s = db
    .prepare(
      // Value includes deactivated products that still hold stock; the alert counts cover active products only.
      `SELECT
         COALESCE(SUM(p.is_active), 0) AS active,
         COALESCE(SUM(b.value), 0) AS value,
         COALESCE(SUM(CASE WHEN b.qty > 0 THEN (b.qty * p.selling_price + 500) / 1000 ELSE 0 END), 0) AS retail,
         COALESCE(SUM(CASE WHEN p.is_active = 1 AND b.qty > 0 AND p.min_stock_qty > 0 AND b.qty <= p.min_stock_qty
                      THEN 1 ELSE 0 END), 0) AS low,
         COALESCE(SUM(CASE WHEN p.is_active = 1 AND b.qty <= 0 THEN 1 ELSE 0 END), 0) AS out
       FROM products p JOIN stock_balances b ON b.product_id = p.id`,
    )
    .get() as { active: number; value: number; retail: number; low: number; out: number };
  const recent = db.prepare(`${MOVEMENT_SELECT} ORDER BY m.id DESC LIMIT 8`).all() as MovementRecord[];
  return {
    activeProducts: s.active,
    inventoryValue: canSeeCost ? s.value : null,
    retailValue: s.retail,
    lowStock: s.low,
    outOfStock: s.out,
    recentMovements: recent.map((r) => toMovementRow(r, canSeeCost)),
  };
}
