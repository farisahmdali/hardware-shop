import type { Db } from '../db/connection';
import { transact, type Actor, type Tx } from '../db/tx';
import type { AppEnv } from './env';
import { AppError, ErrorCodes } from '@shared/errors';
import { rateLabel, UNIT_MINUTES, type RateUnit, type RentalRate } from '@shared/rentalPricing';
import type { AssetCondition, AssetHistory, AssetRow, AssetStatus, Paged, RentalProductDetail, RentalProductRow, RentalRateView } from '@shared/contracts';

export interface RateInput {
  unit: RateUnit;
  unitMinutes?: number;
  label: string;
  price: number;
}

export interface RentalProductFields {
  name: string;
  categoryId: number | null;
  brand: string;
  model: string;
  description: string;
  depositAmount: number;
  sacCode: string;
  gstRateBp: number;
  priceIncludesTax: boolean;
  notes: string;
  rates: RateInput[];
}

interface ProductRecord {
  id: number;
  code: string;
  name: string;
  category_id: number | null;
  category_name: string | null;
  brand: string;
  model: string;
  description: string;
  deposit_amount: number;
  sac_code: string;
  gst_rate_bp: number;
  price_includes_tax: number;
  notes: string;
  is_active: number;
  created_at: string;
  updated_at: string;
  version: number;
  units_total: number;
  units_available: number;
  units_out: number;
}

const PRODUCT_SELECT = `
  SELECT p.*, c.name AS category_name,
    (SELECT COUNT(*) FROM rental_assets a WHERE a.rental_product_id = p.id AND a.status != 'RETIRED') AS units_total,
    (SELECT COUNT(*) FROM rental_assets a WHERE a.rental_product_id = p.id AND a.status = 'AVAILABLE') AS units_available,
    (SELECT COUNT(*) FROM rental_assets a WHERE a.rental_product_id = p.id AND a.status = 'RENTED') AS units_out
  FROM rental_products p LEFT JOIN categories c ON c.id = p.category_id`;

export function activeRates(db: Db, productId: number): RentalRateView[] {
  return (
    db
      .prepare('SELECT id, unit, unit_minutes, label, price FROM rental_rates WHERE rental_product_id = ? AND retired_at IS NULL ORDER BY unit_minutes')
      .all(productId) as { id: number; unit: RateUnit; unit_minutes: number; label: string; price: number }[]
  ).map((r) => {
    const rate: RentalRate = { unit: r.unit, unitMinutes: r.unit_minutes, price: r.price, label: r.label || undefined };
    return { id: r.id, ...rate, displayLabel: rateLabel(rate) };
  });
}

function toProductRow(db: Db, r: ProductRecord): RentalProductRow {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    categoryId: r.category_id,
    categoryName: r.category_name,
    brand: r.brand,
    model: r.model,
    depositAmount: r.deposit_amount,
    gstRateBp: r.gst_rate_bp,
    priceIncludesTax: r.price_includes_tax === 1,
    isActive: r.is_active === 1,
    rates: activeRates(db, r.id),
    unitsTotal: r.units_total,
    unitsAvailable: r.units_available,
    unitsOut: r.units_out,
    unitsUnavailable: r.units_total - r.units_available - r.units_out,
  };
}

export function listRentalProducts(db: Db, f: { search?: string; active: 'ACTIVE' | 'INACTIVE' | 'ALL' }): RentalProductRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.active !== 'ALL') where.push(`p.is_active = ${f.active === 'ACTIVE' ? 1 : 0}`);
  if (f.search) {
    const like = `%${f.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push("(p.name LIKE ? ESCAPE '\\' OR p.code LIKE ? ESCAPE '\\' OR p.brand LIKE ? ESCAPE '\\' OR p.model LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  const rows = db
    .prepare(`${PRODUCT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.name COLLATE NOCASE`)
    .all(...params) as ProductRecord[];
  return rows.map((r) => toProductRow(db, r));
}

export function getRentalProduct(db: Db, id: number, canSeeCost: boolean, nowIso: string): RentalProductDetail {
  const r = db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(id) as ProductRecord | undefined;
  if (!r) throw new AppError(ErrorCodes.NOT_FOUND, 'Rental item not found.');
  return {
    ...toProductRow(db, r),
    description: r.description,
    sacCode: r.sac_code,
    notes: r.notes,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    assets: listAssets(db, { productId: id, status: 'ALL', page: 1, pageSize: 200 }, canSeeCost, nowIso).rows,
  };
}

function normaliseRates(rates: RateInput[]): { unit: RateUnit; unitMinutes: number; label: string; price: number }[] {
  return rates.map((r) => ({
    unit: r.unit,
    unitMinutes: r.unit === 'CUSTOM' ? r.unitMinutes! : UNIT_MINUTES[r.unit],
    label: r.unit === 'CUSTOM' ? r.label : '',
    price: r.price,
  }));
}

function validateCategory(tx: Tx, categoryId: number | null): void {
  if (categoryId === null) return;
  const c = tx.db.prepare('SELECT kind FROM categories WHERE id = ?').get(categoryId) as { kind: string } | undefined;
  if (!c || c.kind !== 'RENTAL') throw new AppError(ErrorCodes.VALIDATION, 'Choose a rental category.');
}

/** Replaces the active rates when they differ; old rates are retired, not deleted, so history keeps them. */
function saveRates(tx: Tx, productId: number, rates: RateInput[]): { before: unknown; after: unknown } | null {
  const next = normaliseRates(rates);
  const current = activeRates(tx.db, productId).map((r) => ({ unit: r.unit, unitMinutes: r.unitMinutes, label: r.label ?? '', price: r.price }));
  const key = (xs: typeof next) => JSON.stringify([...xs].sort((a, b) => a.unitMinutes - b.unitMinutes || a.unit.localeCompare(b.unit)));
  if (key(current) === key(next)) return null;
  tx.db.prepare('UPDATE rental_rates SET retired_at = ? WHERE rental_product_id = ? AND retired_at IS NULL').run(tx.nowIso, productId);
  const insert = tx.db.prepare(
    'INSERT INTO rental_rates (rental_product_id, unit, unit_minutes, label, price, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const r of next) insert.run(productId, r.unit, r.unitMinutes, r.label, r.price, tx.nowIso);
  return { before: current, after: next };
}

function nextAssetTag(tx: Tx, productId: number, code: string): string {
  const exists = tx.db.prepare('SELECT 1 FROM rental_assets WHERE asset_tag = ?');
  let n = (tx.db.prepare('SELECT COUNT(*) AS n FROM rental_assets WHERE rental_product_id = ?').get(productId) as { n: number }).n + 1;
  for (;;) {
    const tag = `${code}-${String(n).padStart(2, '0')}`;
    if (!exists.get(tag)) return tag;
    n++;
  }
}

export function assetEvent(
  tx: Tx,
  assetId: number,
  e: { event: string; from?: string | null; to?: string | null; condition?: string | null; notes?: string | null; refType?: string; refId?: number | string },
): void {
  tx.db
    .prepare(
      `INSERT INTO asset_events (asset_id, event, from_status, to_status, condition, notes, ref_type, ref_id, user_id, occurred_at, txn_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      assetId,
      e.event,
      e.from ?? null,
      e.to ?? null,
      e.condition ?? null,
      e.notes ?? null,
      e.refType ?? null,
      e.refId === undefined ? null : String(e.refId),
      tx.actor.userId,
      tx.nowIso,
      tx.txnRef,
    );
}

function insertAssets(tx: Tx, productId: number, count: number, serials: string[], purchaseCost: number, purchaseDate: string | null): number[] {
  const p = tx.db.prepare('SELECT code FROM rental_products WHERE id = ?').get(productId) as { code: string } | undefined;
  if (!p) throw new AppError(ErrorCodes.NOT_FOUND, 'Rental item not found.');
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const tag = nextAssetTag(tx, productId, p.code);
    const id = Number(
      tx.db
        .prepare(
          `INSERT INTO rental_assets (asset_tag, rental_product_id, serial_no, purchase_cost, purchase_date, condition, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'GOOD', 'AVAILABLE', ?, ?)`,
        )
        .run(tag, productId, serials[i] ?? '', purchaseCost, purchaseDate, tx.nowIso, tx.nowIso).lastInsertRowid,
    );
    assetEvent(tx, id, { event: 'ADDED', to: 'AVAILABLE', condition: 'GOOD', notes: serials[i] ? `Serial ${serials[i]}` : null });
    ids.push(id);
  }
  return ids;
}

function productSnapshot(db: Db, id: number) {
  const r = db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(id) as ProductRecord;
  return {
    code: r.code,
    name: r.name,
    category: r.category_name,
    brand: r.brand,
    model: r.model,
    description: r.description,
    depositAmount: r.deposit_amount,
    sacCode: r.sac_code,
    gstRateBp: r.gst_rate_bp,
    priceIncludesTax: r.price_includes_tax === 1,
    notes: r.notes,
    isActive: r.is_active === 1,
  };
}

export function createRentalProduct(
  env: AppEnv,
  actor: Actor,
  input: RentalProductFields & { requestId: string; units: number; serials: string[]; purchaseCost: number; purchaseDate: string | null },
): number {
  return transact(env, actor, (tx) =>
    tx.once(input.requestId, 'rentalProducts.create', () => {
      validateCategory(tx, input.categoryId);
      const code = tx.nextCode('RENTAL_ITEM', 'RI', 3, 'rental_products', 'code');
      const id = Number(
        tx.db
          .prepare(
            `INSERT INTO rental_products (code, name, category_id, brand, model, description, deposit_amount, sac_code, gst_rate_bp,
               price_includes_tax, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            code,
            input.name,
            input.categoryId,
            input.brand,
            input.model,
            input.description,
            input.depositAmount,
            input.sacCode,
            input.gstRateBp,
            input.priceIncludesTax ? 1 : 0,
            input.notes,
            tx.nowIso,
            tx.nowIso,
          ).lastInsertRowid,
      );
      saveRates(tx, id, input.rates);
      insertAssets(tx, id, input.units, input.serials, input.purchaseCost, input.purchaseDate);
      tx.audit({
        module: 'rentals',
        entityType: 'rental_product',
        entityId: id,
        action: 'CREATE',
        after: { ...productSnapshot(tx.db, id), rates: normaliseRates(input.rates), units: input.units },
      });
      return id;
    }),
  );
}

export function updateRentalProduct(
  env: AppEnv,
  actor: Actor,
  input: RentalProductFields & { id: number; version: number; reason?: string },
): void {
  transact(env, actor, (tx) => {
    validateCategory(tx, input.categoryId);
    const before = productSnapshot(tx.db, input.id);
    const result = tx.db
      .prepare(
        `UPDATE rental_products SET name = ?, category_id = ?, brand = ?, model = ?, description = ?, deposit_amount = ?, sac_code = ?,
           gst_rate_bp = ?, price_includes_tax = ?, notes = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`,
      )
      .run(
        input.name,
        input.categoryId,
        input.brand,
        input.model,
        input.description,
        input.depositAmount,
        input.sacCode,
        input.gstRateBp,
        input.priceIncludesTax ? 1 : 0,
        input.notes,
        tx.nowIso,
        input.id,
        input.version,
      );
    tx.expectOneChange(result.changes, 'This rental item');
    const after = productSnapshot(tx.db, input.id);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      tx.audit({ module: 'rentals', entityType: 'rental_product', entityId: input.id, action: 'UPDATE', before, after, reason: input.reason ?? null });
    }
    const rates = saveRates(tx, input.id, input.rates);
    if (rates) {
      tx.audit({
        module: 'rentals',
        entityType: 'rental_product',
        entityId: input.id,
        action: 'RATES_CHANGED',
        before: { rates: rates.before },
        after: { rates: rates.after },
        reason: input.reason ?? 'Rates changed; existing rentals keep the rates they were made with',
      });
    }
  });
}

export function setRentalProductActive(env: AppEnv, actor: Actor, input: { id: number; version: number; isActive: boolean; reason: string }): void {
  transact(env, actor, (tx) => {
    const result = tx.db
      .prepare('UPDATE rental_products SET is_active = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
      .run(input.isActive ? 1 : 0, tx.nowIso, input.id, input.version);
    tx.expectOneChange(result.changes, 'This rental item');
    tx.audit({
      module: 'rentals',
      entityType: 'rental_product',
      entityId: input.id,
      action: input.isActive ? 'REACTIVATE' : 'DEACTIVATE',
      after: { isActive: input.isActive },
      reason: input.reason,
    });
  });
}

export function addAssets(
  env: AppEnv,
  actor: Actor,
  input: { requestId: string; productId: number; count: number; serials: string[]; purchaseCost: number; purchaseDate: string | null },
): void {
  transact(env, actor, (tx) =>
    tx.once(input.requestId, 'rentalAssets.add', () => {
      const ids = insertAssets(tx, input.productId, input.count, input.serials, input.purchaseCost, input.purchaseDate);
      tx.audit({ module: 'rentals', entityType: 'rental_product', entityId: input.productId, action: 'UNITS_ADDED', after: { count: input.count, assetIds: ids } });
      return ids.length;
    }),
  );
}

// ---------- Assets ----------

interface AssetRecord {
  id: number;
  asset_tag: string;
  rental_product_id: number;
  product_name: string;
  serial_no: string;
  purchase_cost: number;
  purchase_date: string | null;
  condition: AssetCondition;
  status: AssetStatus;
  notes: string;
  version: number;
  cur_agreement_id: number | null;
  cur_rental_no: string | null;
  cur_customer: string | null;
  cur_expected: string | null;
  next_agreement_id: number | null;
  next_rental_no: string | null;
  next_customer: string | null;
  next_start: string | null;
}

const ASSET_SELECT = `
  SELECT a.*, p.name AS product_name,
    cur.agreement_id AS cur_agreement_id, cur.rental_no AS cur_rental_no, cur.customer_name AS cur_customer, cur.expected_return_at AS cur_expected,
    nxt.agreement_id AS next_agreement_id, nxt.rental_no AS next_rental_no, nxt.customer_name AS next_customer, nxt.start_at AS next_start
  FROM rental_assets a
  JOIN rental_products p ON p.id = a.rental_product_id
  LEFT JOIN (
    SELECT i.asset_id, ra.id AS agreement_id, ra.rental_no, ra.customer_name, ra.expected_return_at
    FROM rental_items i JOIN rental_agreements ra ON ra.id = i.agreement_id WHERE i.status = 'OUT'
  ) cur ON cur.asset_id = a.id
  LEFT JOIN (
    SELECT i.asset_id, ra.id AS agreement_id, ra.rental_no, ra.customer_name, MIN(ra.start_at) AS start_at
    FROM rental_items i JOIN rental_agreements ra ON ra.id = i.agreement_id WHERE i.status = 'RESERVED' GROUP BY i.asset_id
  ) nxt ON nxt.asset_id = a.id`;

function toAssetRow(r: AssetRecord, canSeeCost: boolean, nowIso: string): AssetRow {
  return {
    id: r.id,
    assetTag: r.asset_tag,
    productId: r.rental_product_id,
    productName: r.product_name,
    serialNo: r.serial_no,
    purchaseCost: canSeeCost ? r.purchase_cost : null,
    purchaseDate: r.purchase_date,
    condition: r.condition,
    status: r.status,
    notes: r.notes,
    version: r.version,
    currentRental: r.cur_agreement_id
      ? { agreementId: r.cur_agreement_id, rentalNo: r.cur_rental_no!, customerName: r.cur_customer!, expectedReturnAt: r.cur_expected!, overdue: r.cur_expected! < nowIso }
      : null,
    nextReservation: r.next_agreement_id
      ? { agreementId: r.next_agreement_id, rentalNo: r.next_rental_no!, customerName: r.next_customer!, startAt: r.next_start! }
      : null,
  };
}

export function listAssets(
  db: Db,
  f: { productId?: number; status: string; search?: string; page: number; pageSize: number },
  canSeeCost: boolean,
  nowIso: string,
): Paged<AssetRow> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.productId) {
    where.push('a.rental_product_id = ?');
    params.push(f.productId);
  }
  if (f.status === 'OVERDUE') {
    where.push("a.status = 'RENTED' AND cur.expected_return_at < ?");
    params.push(nowIso);
  } else if (f.status !== 'ALL') {
    where.push('a.status = ?');
    params.push(f.status);
  } else {
    where.push("a.status != 'RETIRED'");
  }
  if (f.search) {
    const like = `%${f.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push("(a.asset_tag LIKE ? ESCAPE '\\' OR a.serial_no LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\' OR cur.customer_name LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM (${ASSET_SELECT} ${clause})`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`${ASSET_SELECT} ${clause} ORDER BY p.name COLLATE NOCASE, a.asset_tag LIMIT ? OFFSET ?`)
    .all(...params, f.pageSize, (f.page - 1) * f.pageSize) as AssetRecord[];
  return { rows: rows.map((r) => toAssetRow(r, canSeeCost, nowIso)), total, page: f.page, pageSize: f.pageSize };
}

export function getAsset(db: Db, id: number, canSeeCost: boolean, nowIso: string): AssetRow {
  const r = db.prepare(`${ASSET_SELECT} WHERE a.id = ?`).get(id) as AssetRecord | undefined;
  if (!r) throw new AppError(ErrorCodes.NOT_FOUND, 'Rental unit not found.');
  return toAssetRow(r, canSeeCost, nowIso);
}

export function updateAsset(
  env: AppEnv,
  actor: Actor,
  input: { id: number; version: number; serialNo: string; purchaseCost: number; purchaseDate: string | null; notes: string; reason?: string },
): void {
  transact(env, actor, (tx) => {
    const before = tx.db.prepare('SELECT serial_no, purchase_cost, purchase_date, notes FROM rental_assets WHERE id = ?').get(input.id);
    if (!before) throw new AppError(ErrorCodes.NOT_FOUND, 'Rental unit not found.');
    const result = tx.db
      .prepare(
        `UPDATE rental_assets SET serial_no = ?, purchase_cost = ?, purchase_date = ?, notes = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND version = ?`,
      )
      .run(input.serialNo, input.purchaseCost, input.purchaseDate, input.notes, tx.nowIso, input.id, input.version);
    tx.expectOneChange(result.changes, 'This rental unit');
    const after = tx.db.prepare('SELECT serial_no, purchase_cost, purchase_date, notes FROM rental_assets WHERE id = ?').get(input.id);
    tx.audit({ module: 'rentals', entityType: 'rental_asset', entityId: input.id, action: 'UPDATE', before, after, reason: input.reason ?? null });
  });
}

/** Moves a unit between statuses inside a transaction, keeping its event trail. */
export function changeAssetStatus(
  tx: Tx,
  assetId: number,
  to: AssetStatus,
  e: { event: string; condition?: AssetCondition; notes?: string | null; refType?: string; refId?: number },
): void {
  const a = tx.db.prepare('SELECT status, condition FROM rental_assets WHERE id = ?').get(assetId) as { status: AssetStatus; condition: AssetCondition };
  tx.db
    .prepare('UPDATE rental_assets SET status = ?, condition = ?, updated_at = ?, version = version + 1 WHERE id = ?')
    .run(to, e.condition ?? a.condition, tx.nowIso, assetId);
  assetEvent(tx, assetId, { event: e.event, from: a.status, to, condition: e.condition ?? a.condition, notes: e.notes, refType: e.refType, refId: e.refId });
}

/** Manual status changes: inspection, repair, damage, retirement. Rented units change only through rentals. */
export function setAssetStatus(
  env: AppEnv,
  actor: Actor,
  input: { id: number; version: number; status: 'AVAILABLE' | 'DAMAGED' | 'MAINTENANCE' | 'RETIRED'; condition: AssetCondition; reason: string },
): void {
  transact(env, actor, (tx) => {
    const a = tx.db.prepare('SELECT status, condition, version, asset_tag FROM rental_assets WHERE id = ?').get(input.id) as
      | { status: AssetStatus; condition: AssetCondition; version: number; asset_tag: string }
      | undefined;
    if (!a) throw new AppError(ErrorCodes.NOT_FOUND, 'Rental unit not found.');
    if (a.version !== input.version) throw new AppError(ErrorCodes.STALE_RECORD, 'This unit was changed by someone else. Reload and try again.');
    if (a.status === 'RENTED') throw new AppError(ErrorCodes.BUSINESS_RULE, `${a.asset_tag} is out on rent. Record its return first.`);
    if (input.status === 'AVAILABLE' && input.condition === 'DAMAGED') {
      throw new AppError(ErrorCodes.BUSINESS_RULE, 'A damaged unit cannot be made available. Repair it first or mark it damaged.');
    }
    if (input.status === 'RETIRED') {
      const reserved = tx.db.prepare("SELECT 1 FROM rental_items WHERE asset_id = ? AND status = 'RESERVED'").get(input.id);
      if (reserved) throw new AppError(ErrorCodes.BUSINESS_RULE, `${a.asset_tag} has a reservation. Cancel it before retiring the unit.`);
    }
    const event = a.status === 'AWAITING_INSPECTION' ? 'INSPECTED' : input.status === 'RETIRED' ? 'RETIRED' : 'STATUS_CHANGED';
    changeAssetStatus(tx, input.id, input.status, { event, condition: input.condition, notes: input.reason });
    tx.audit({
      module: 'rentals',
      entityType: 'rental_asset',
      entityId: input.id,
      action: event,
      before: { status: a.status, condition: a.condition },
      after: { status: input.status, condition: input.condition },
      reason: input.reason,
    });
  });
}

export function assetHistory(db: Db, id: number): AssetHistory {
  return {
    events: (
      db
        .prepare(
          `SELECT e.*, u.username FROM asset_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.asset_id = ? ORDER BY e.id DESC LIMIT 500`,
        )
        .all(id) as { id: number; event: string; from_status: string | null; to_status: string | null; condition: string | null; notes: string | null; ref_type: string | null; ref_id: string | null; username: string | null; occurred_at: string }[]
    ).map((e) => ({
      id: e.id,
      event: e.event,
      fromStatus: e.from_status,
      toStatus: e.to_status,
      condition: e.condition,
      notes: e.notes,
      refType: e.ref_type,
      refId: e.ref_id,
      username: e.username,
      occurredAt: e.occurred_at,
    })),
    rentals: (
      db
        .prepare(
          `SELECT ra.id, ra.rental_no, ra.customer_name, i.issued_at, i.returned_at, i.return_condition, i.status
           FROM rental_items i JOIN rental_agreements ra ON ra.id = i.agreement_id WHERE i.asset_id = ? ORDER BY ra.id DESC LIMIT 200`,
        )
        .all(id) as { id: number; rental_no: string; customer_name: string; issued_at: string | null; returned_at: string | null; return_condition: string | null; status: string }[]
    ).map((r) => ({
      agreementId: r.id,
      rentalNo: r.rental_no,
      customerName: r.customer_name,
      issuedAt: r.issued_at,
      returnedAt: r.returned_at,
      returnCondition: r.return_condition,
      status: r.status,
    })),
  };
}
