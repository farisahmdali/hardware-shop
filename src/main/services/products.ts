import type { Db } from '../db/connection';
import { transact, type Actor, type Tx } from '../db/tx';
import type { AppEnv } from './env';
import { recordMovement } from './stock';
import { AppError, ErrorCodes } from '@shared/errors';
import { mulDivRound } from '@shared/money';
import { QTY_SCALE } from '@shared/qty';
import { stockStatus } from '@shared/stock';
import type { Paged, ProductDetail, ProductFilter, ProductListRow } from '@shared/contracts';

export interface ProductFieldsInput {
  sku: string;
  name: string;
  categoryId: number | null;
  brandId: number | null;
  unitId: number;
  description: string;
  hsnCode: string;
  gstRateBp: number;
  priceIncludesTax: boolean;
  purchasePrice: number;
  sellingPrice: number;
  minStockQty: number;
  preferredSupplierId: number | null;
  notes: string;
}

interface ProductRecord {
  id: number;
  sku: string;
  name: string;
  category_id: number | null;
  brand_id: number | null;
  description: string;
  unit_id: number;
  hsn_code: string;
  gst_rate_bp: number;
  price_includes_tax: number;
  purchase_price: number;
  selling_price: number;
  min_stock_qty: number;
  preferred_supplier_id: number | null;
  notes: string;
  is_active: number;
  created_at: string;
  updated_at: string;
  version: number;
  category_name: string | null;
  brand_name: string | null;
  unit_code: string;
  unit_name: string;
  allow_decimal: number;
  supplier_name: string | null;
  qty: number;
  value: number;
}

const SELECT = `
  SELECT p.*, c.name AS category_name, br.name AS brand_name, u.code AS unit_code, u.name AS unit_name,
         u.allow_decimal, s.name AS supplier_name, b.qty, b.value
  FROM products p
  JOIN stock_balances b ON b.product_id = p.id
  JOIN units u ON u.id = p.unit_id
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN brands br ON br.id = p.brand_id
  LEFT JOIN suppliers s ON s.id = p.preferred_supplier_id`;

function toListRow(r: ProductRecord, canSeeCost: boolean): ProductListRow {
  return {
    id: r.id,
    sku: r.sku,
    name: r.name,
    categoryName: r.category_name,
    brandName: r.brand_name,
    unitCode: r.unit_code,
    allowDecimal: r.allow_decimal === 1,
    gstRateBp: r.gst_rate_bp,
    priceIncludesTax: r.price_includes_tax === 1,
    sellingPrice: r.selling_price,
    purchasePrice: canSeeCost ? r.purchase_price : null,
    qty: r.qty,
    minStockQty: r.min_stock_qty,
    stockValue: canSeeCost ? r.value : null,
    status: stockStatus(r.qty, r.min_stock_qty),
    isActive: r.is_active === 1,
  };
}

function toDetail(r: ProductRecord, canSeeCost: boolean): ProductDetail {
  return {
    ...toListRow(r, canSeeCost),
    categoryId: r.category_id,
    brandId: r.brand_id,
    unitId: r.unit_id,
    unitName: r.unit_name,
    description: r.description,
    hsnCode: r.hsn_code,
    preferredSupplierId: r.preferred_supplier_id,
    supplierName: r.supplier_name,
    notes: r.notes,
    averageCost: canSeeCost && r.qty > 0 ? mulDivRound(r.value, QTY_SCALE, r.qty) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: r.version,
  };
}

function loadRecord(db: Db, id: number): ProductRecord {
  const r = db.prepare(`${SELECT} WHERE p.id = ?`).get(id) as ProductRecord | undefined;
  if (!r) throw new AppError(ErrorCodes.NOT_FOUND, 'Product not found.');
  return r;
}

export function getProduct(db: Db, id: number, canSeeCost: boolean): ProductDetail {
  return toDetail(loadRecord(db, id), canSeeCost);
}

/** Turns free text into an FTS5 prefix query: every word must match the start of some indexed word. */
export function toFtsQuery(search: string): string | null {
  const tokens = search
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  return tokens.length ? tokens.map((t) => `"${t}"*`).join(' ') : null;
}

const SORT_COLUMNS: Record<ProductFilter['sort'], string> = {
  name: 'p.name COLLATE NOCASE',
  sku: 'p.sku COLLATE NOCASE',
  qty: 'b.qty',
  value: 'b.value',
  price: 'p.selling_price',
  updated: 'p.updated_at',
};

export function listProducts(db: Db, f: Omit<ProductFilter, 'page' | 'pageSize'> & { page: number; pageSize: number }, canSeeCost: boolean): Paged<ProductListRow> {
  const where: string[] = [];
  const params: unknown[] = [];
  const order: string[] = [];
  const orderParams: unknown[] = [];

  if (f.active !== 'ALL') where.push(`p.is_active = ${f.active === 'ACTIVE' ? 1 : 0}`);
  if (f.categoryId) {
    where.push('p.category_id = ?');
    params.push(f.categoryId);
  }
  if (f.brandId) {
    where.push('p.brand_id = ?');
    params.push(f.brandId);
  }
  if (f.supplierId) {
    where.push('p.preferred_supplier_id = ?');
    params.push(f.supplierId);
  }
  const low = 'b.qty > 0 AND p.min_stock_qty > 0 AND b.qty <= p.min_stock_qty';
  if (f.stock === 'OUT') where.push('b.qty <= 0');
  if (f.stock === 'LOW') where.push(low);
  if (f.stock === 'LOW_OR_OUT') where.push(`(b.qty <= 0 OR (${low}))`);
  if (f.stock === 'IN_STOCK') where.push(`b.qty > 0 AND NOT (${low})`);

  const search = f.search?.trim();
  if (search) {
    const fts = toFtsQuery(search);
    if (fts) {
      where.push('(p.id IN (SELECT rowid FROM products_fts WHERE products_fts MATCH ?) OR p.sku = ?)');
      params.push(fts, search);
    } else {
      where.push('p.sku = ?');
      params.push(search);
    }
    // Exact code first, then names starting with the text.
    order.push('(p.sku = ?) DESC', "(p.name LIKE ? ESCAPE '\\') DESC");
    orderParams.push(search, `${search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
  }
  order.push(`${SORT_COLUMNS[f.sort]} ${f.dir === 'desc' ? 'DESC' : 'ASC'}`, 'p.id');

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM products p JOIN stock_balances b ON b.product_id = p.id ${clause}`)
      .get(...params) as { n: number }
  ).n;
  const rows = db
    .prepare(`${SELECT} ${clause} ORDER BY ${order.join(', ')} LIMIT ? OFFSET ?`)
    .all(...params, ...orderParams, f.pageSize, (f.page - 1) * f.pageSize) as ProductRecord[];
  return { rows: rows.map((r) => toListRow(r, canSeeCost)), total, page: f.page, pageSize: f.pageSize };
}

/** Iterates every product matching a filter, for exports. */
export function* iterateProducts(db: Db, f: Omit<ProductFilter, 'page' | 'pageSize'>, canSeeCost: boolean) {
  const pageSize = 200;
  for (let page = 1; ; page++) {
    const batch = listProducts(db, { ...f, page, pageSize }, canSeeCost);
    for (const row of batch.rows) yield getProduct(db, row.id, canSeeCost);
    if (page * pageSize >= batch.total) return;
  }
}

// ---------- Validation shared by create, update and import ----------

function validateReferences(tx: Tx, input: ProductFieldsInput): { allowDecimal: boolean } {
  const unit = tx.db.prepare('SELECT allow_decimal, is_active, code FROM units WHERE id = ?').get(input.unitId) as
    | { allow_decimal: number; is_active: number; code: string }
    | undefined;
  if (!unit) throw new AppError(ErrorCodes.VALIDATION, 'Choose a unit of measurement.');
  if (input.categoryId !== null) {
    const c = tx.db.prepare('SELECT kind FROM categories WHERE id = ?').get(input.categoryId) as { kind: string } | undefined;
    if (!c || c.kind !== 'PRODUCT') throw new AppError(ErrorCodes.VALIDATION, 'Choose a valid product category.');
  }
  if (input.brandId !== null && !tx.db.prepare('SELECT 1 FROM brands WHERE id = ?').get(input.brandId)) {
    throw new AppError(ErrorCodes.VALIDATION, 'Choose a valid brand.');
  }
  if (input.preferredSupplierId !== null && !tx.db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(input.preferredSupplierId)) {
    throw new AppError(ErrorCodes.VALIDATION, 'Choose a valid supplier.');
  }
  if (!unit.allow_decimal && input.minStockQty % QTY_SCALE !== 0) {
    throw new AppError(ErrorCodes.VALIDATION, `The minimum stock must be a whole number of ${unit.code}.`);
  }
  return { allowDecimal: unit.allow_decimal === 1 };
}

/** The product as recorded in the history: readable names alongside ids, no derived figures. */
function auditSnapshot(db: Db, id: number) {
  const r = loadRecord(db, id);
  return {
    sku: r.sku,
    name: r.name,
    category: r.category_name,
    brand: r.brand_name,
    unit: r.unit_code,
    hsnCode: r.hsn_code,
    gstRateBp: r.gst_rate_bp,
    priceIncludesTax: r.price_includes_tax === 1,
    purchasePrice: r.purchase_price,
    sellingPrice: r.selling_price,
    minStockQty: r.min_stock_qty,
    preferredSupplier: r.supplier_name,
    description: r.description,
    notes: r.notes,
    isActive: r.is_active === 1,
  };
}

const PRICE_FIELDS = new Set(['purchasePrice', 'sellingPrice', 'priceIncludesTax', 'gstRateBp']);

export function insertProduct(
  tx: Tx,
  input: ProductFieldsInput & { openingQty: number; openingUnitCost?: number },
  reason?: string,
): number {
  const { allowDecimal } = validateReferences(tx, input);
  if (!allowDecimal && input.openingQty % QTY_SCALE !== 0) {
    throw new AppError(ErrorCodes.VALIDATION, 'The opening stock must be a whole number for this unit.');
  }
  const sku = input.sku || tx.nextCode('PRODUCT', 'P', 6, 'products', 'sku');
  if (tx.db.prepare('SELECT 1 FROM products WHERE sku = ?').get(sku)) {
    throw new AppError(ErrorCodes.CONFLICT, `The product code ${sku} is already used by another product.`);
  }
  const id = Number(
    tx.db
      .prepare(
        `INSERT INTO products (sku, name, category_id, brand_id, description, unit_id, hsn_code, gst_rate_bp,
           price_includes_tax, purchase_price, selling_price, min_stock_qty, preferred_supplier_id, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sku,
        input.name,
        input.categoryId,
        input.brandId,
        input.description,
        input.unitId,
        input.hsnCode,
        input.gstRateBp,
        input.priceIncludesTax ? 1 : 0,
        input.purchasePrice,
        input.sellingPrice,
        input.minStockQty,
        input.preferredSupplierId,
        input.notes,
        tx.nowIso,
        tx.nowIso,
      ).lastInsertRowid,
  );
  let opening: { qty: number; unitCost: number; movementId: number } | undefined;
  if (input.openingQty > 0) {
    const unitCost = input.openingUnitCost ?? input.purchasePrice;
    const m = recordMovement(tx, {
      productId: id,
      type: 'OPENING',
      qtyChange: input.openingQty,
      unitCost,
      reason: 'Opening stock',
      refType: 'PRODUCT',
      refId: id,
    });
    opening = { qty: input.openingQty, unitCost, movementId: m.id };
  }
  tx.audit({
    module: 'products',
    entityType: 'product',
    entityId: id,
    action: 'CREATE',
    after: { ...auditSnapshot(tx.db, id), openingStock: opening ?? null },
    reason: reason ?? null,
  });
  return id;
}

export function createProduct(
  env: AppEnv,
  actor: Actor,
  input: ProductFieldsInput & { requestId: string; openingQty: number; openingUnitCost?: number },
  canSeeCost: boolean,
): ProductDetail {
  const id = transact(env, actor, (tx) => tx.once(input.requestId, 'products.create', () => insertProduct(tx, input)));
  return getProduct(env.db, id, canSeeCost);
}

export function updateProduct(
  env: AppEnv,
  actor: Actor,
  input: ProductFieldsInput & { id: number; version: number; reason?: string },
  canSeeCost: boolean,
): ProductDetail {
  transact(env, actor, (tx) => {
    const current = loadRecord(tx.db, input.id);
    validateReferences(tx, input);
    const sku = input.sku || current.sku;
    const clash = tx.db.prepare('SELECT id FROM products WHERE sku = ? AND id != ?').get(sku, input.id);
    if (clash) throw new AppError(ErrorCodes.CONFLICT, `The product code ${sku} is already used by another product.`);
    const before = auditSnapshot(tx.db, input.id);
    const result = tx.db
      .prepare(
        `UPDATE products SET sku = ?, name = ?, category_id = ?, brand_id = ?, description = ?, unit_id = ?, hsn_code = ?,
           gst_rate_bp = ?, price_includes_tax = ?, purchase_price = ?, selling_price = ?, min_stock_qty = ?,
           preferred_supplier_id = ?, notes = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND version = ?`,
      )
      .run(
        sku,
        input.name,
        input.categoryId,
        input.brandId,
        input.description,
        input.unitId,
        input.hsnCode,
        input.gstRateBp,
        input.priceIncludesTax ? 1 : 0,
        input.purchasePrice,
        input.sellingPrice,
        input.minStockQty,
        input.preferredSupplierId,
        input.notes,
        tx.nowIso,
        input.id,
        input.version,
      );
    tx.expectOneChange(result.changes, 'This product');
    if (current.unit_id !== input.unitId) {
      const unit = tx.db.prepare('SELECT allow_decimal FROM units WHERE id = ?').get(input.unitId) as { allow_decimal: number };
      if (!unit.allow_decimal && current.qty % QTY_SCALE !== 0) {
        throw new AppError(ErrorCodes.BUSINESS_RULE, 'The current stock has decimals, so the unit must allow decimals.');
      }
    }
    const after = auditSnapshot(tx.db, input.id);
    const changed = Object.keys(after).filter(
      (k) => JSON.stringify(before[k as keyof typeof before]) !== JSON.stringify(after[k as keyof typeof after]),
    );
    if (changed.length === 0) return;
    tx.audit({
      module: 'products',
      entityType: 'product',
      entityId: input.id,
      action: changed.every((k) => PRICE_FIELDS.has(k)) ? 'PRICE_CHANGE' : 'UPDATE',
      before,
      after,
      reason: input.reason ?? null,
    });
  });
  return getProduct(env.db, input.id, canSeeCost);
}

export function setProductActive(
  env: AppEnv,
  actor: Actor,
  input: { id: number; version: number; isActive: boolean; reason: string },
  canSeeCost: boolean,
): ProductDetail {
  transact(env, actor, (tx) => {
    const before = auditSnapshot(tx.db, input.id);
    const result = tx.db
      .prepare('UPDATE products SET is_active = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
      .run(input.isActive ? 1 : 0, tx.nowIso, input.id, input.version);
    tx.expectOneChange(result.changes, 'This product');
    tx.audit({
      module: 'products',
      entityType: 'product',
      entityId: input.id,
      action: input.isActive ? 'REACTIVATE' : 'DEACTIVATE',
      before: { isActive: before.isActive },
      after: { isActive: input.isActive },
      reason: input.reason,
    });
  });
  return getProduct(env.db, input.id, canSeeCost);
}
