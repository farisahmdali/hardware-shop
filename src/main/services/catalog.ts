import type { Db } from '../db/connection';
import { transact, type Actor, type Tx } from '../db/tx';
import type { AppEnv } from './env';
import { AppError, ErrorCodes } from '@shared/errors';
import type { BrandRow, CatalogData, CategoryRow, SupplierRef, UnitRow } from '@shared/contracts';

interface CategoryRecord {
  id: number;
  kind: CategoryRow['kind'];
  name: string;
  is_active: number;
  version: number;
  usage: number;
}

interface BrandRecord {
  id: number;
  name: string;
  is_active: number;
  version: number;
  usage: number;
}

interface UnitRecord {
  id: number;
  code: string;
  name: string;
  allow_decimal: number;
  is_active: number;
  version: number;
  usage: number;
}

const toCategory = (r: CategoryRecord): CategoryRow => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  isActive: r.is_active === 1,
  version: r.version,
  usageCount: r.usage,
});
const toBrand = (r: BrandRecord): BrandRow => ({
  id: r.id,
  name: r.name,
  isActive: r.is_active === 1,
  version: r.version,
  usageCount: r.usage,
});
const toUnit = (r: UnitRecord): UnitRow => ({
  id: r.id,
  code: r.code,
  name: r.name,
  allowDecimal: r.allow_decimal === 1,
  isActive: r.is_active === 1,
  version: r.version,
  usageCount: r.usage,
});

const CATEGORY_SQL = `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS usage FROM categories c`;
const BRAND_SQL = `SELECT b.*, (SELECT COUNT(*) FROM products p WHERE p.brand_id = b.id) AS usage FROM brands b`;
const UNIT_SQL = `SELECT u.*, (SELECT COUNT(*) FROM products p WHERE p.unit_id = u.id) AS usage FROM units u`;

export function getCatalog(db: Db): CatalogData {
  return {
    categories: (db.prepare(`${CATEGORY_SQL} ORDER BY c.kind, c.name`).all() as CategoryRecord[]).map(toCategory),
    brands: (db.prepare(`${BRAND_SQL} ORDER BY b.name`).all() as BrandRecord[]).map(toBrand),
    units: (db.prepare(`${UNIT_SQL} ORDER BY u.name`).all() as UnitRecord[]).map(toUnit),
    suppliers: (
      db.prepare('SELECT id, code, name, phone, is_active FROM suppliers ORDER BY name').all() as {
        id: number;
        code: string;
        name: string;
        phone: string;
        is_active: number;
      }[]
    ).map((s) => ({ id: s.id, code: s.code, name: s.name, phone: s.phone, isActive: s.is_active === 1 })),
  };
}

function snapshot(r: Record<string, unknown>) {
  const { usage: _usage, created_at: _c, updated_at: _u, version: _v, ...rest } = r;
  return rest;
}

/** Shared create/update logic for simple named master records, with audit and optimistic locking. */
function saveNamed<T extends { id: number }>(
  tx: Tx,
  opts: {
    table: 'categories' | 'brands';
    entityType: string;
    select: string;
    id?: number;
    version?: number;
    fields: Record<string, string | number>;
    duplicateCheck: { sql: string; params: unknown[] };
    label: string;
  },
): T {
  const dup = tx.db.prepare(opts.duplicateCheck.sql).get(...opts.duplicateCheck.params) as { id: number } | undefined;
  if (dup && dup.id !== opts.id) throw new AppError(ErrorCodes.CONFLICT, `${opts.label} already exists.`);
  const cols = Object.keys(opts.fields);
  let id = opts.id;
  if (id === undefined) {
    id = Number(
      tx.db
        .prepare(
          `INSERT INTO ${opts.table} (${cols.join(', ')}, created_at, updated_at) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`,
        )
        .run(...Object.values(opts.fields), tx.nowIso, tx.nowIso).lastInsertRowid,
    );
    const after = tx.db.prepare(`${opts.select} WHERE x.id = ?`).get(id) as Record<string, unknown>;
    tx.audit({ module: 'products', entityType: opts.entityType, entityId: id, action: 'CREATE', after: snapshot(after) });
  } else {
    const before = tx.db.prepare(`${opts.select} WHERE x.id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!before) throw new AppError(ErrorCodes.NOT_FOUND, `${opts.entityType} not found.`);
    const result = tx.db
      .prepare(
        `UPDATE ${opts.table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ?, version = version + 1
         WHERE id = ? AND version = ?`,
      )
      .run(...Object.values(opts.fields), tx.nowIso, id, opts.version ?? -1);
    tx.expectOneChange(result.changes, `This ${opts.entityType}`);
    const after = tx.db.prepare(`${opts.select} WHERE x.id = ?`).get(id) as Record<string, unknown>;
    tx.audit({
      module: 'products',
      entityType: opts.entityType,
      entityId: id,
      action: before.is_active === 1 && after.is_active === 0 ? 'DEACTIVATE' : 'UPDATE',
      before: snapshot(before),
      after: snapshot(after),
    });
  }
  return { id } as T;
}

export function saveCategory(
  env: AppEnv,
  actor: Actor,
  input: { id?: number; name: string; isActive: boolean; version?: number },
): CategoryRow {
  return transact(env, actor, (tx) => {
    const { id } = saveNamed(tx, {
      table: 'categories',
      entityType: 'category',
      select: 'SELECT x.* FROM categories x',
      id: input.id,
      version: input.version,
      fields: input.id ? { name: input.name, is_active: input.isActive ? 1 : 0 } : { kind: 'PRODUCT', name: input.name, is_active: input.isActive ? 1 : 0 },
      duplicateCheck: { sql: "SELECT id FROM categories WHERE kind = 'PRODUCT' AND name = ?", params: [input.name] },
      label: `The category "${input.name}"`,
    });
    return toCategory(tx.db.prepare(`${CATEGORY_SQL} WHERE c.id = ?`).get(id) as CategoryRecord);
  });
}

export function saveBrand(
  env: AppEnv,
  actor: Actor,
  input: { id?: number; name: string; isActive: boolean; version?: number },
): BrandRow {
  return transact(env, actor, (tx) => {
    const { id } = saveNamed(tx, {
      table: 'brands',
      entityType: 'brand',
      select: 'SELECT x.* FROM brands x',
      id: input.id,
      version: input.version,
      fields: { name: input.name, is_active: input.isActive ? 1 : 0 },
      duplicateCheck: { sql: 'SELECT id FROM brands WHERE name = ?', params: [input.name] },
      label: `The brand "${input.name}"`,
    });
    return toBrand(tx.db.prepare(`${BRAND_SQL} WHERE b.id = ?`).get(id) as BrandRecord);
  });
}

export function saveUnit(
  env: AppEnv,
  actor: Actor,
  input: { id?: number; code: string; name: string; allowDecimal: boolean; isActive: boolean; version?: number },
): UnitRow {
  const code = input.code.toUpperCase();
  return transact(env, actor, (tx) => {
    const dup = tx.db.prepare('SELECT id FROM units WHERE code = ?').get(code) as { id: number } | undefined;
    if (dup && dup.id !== input.id) throw new AppError(ErrorCodes.CONFLICT, `The unit code ${code} already exists.`);
    if (input.id === undefined) {
      const id = Number(
        tx.db
          .prepare('INSERT INTO units (code, name, allow_decimal, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(code, input.name, input.allowDecimal ? 1 : 0, input.isActive ? 1 : 0, tx.nowIso, tx.nowIso).lastInsertRowid,
      );
      const after = tx.db.prepare(`${UNIT_SQL} WHERE u.id = ?`).get(id) as UnitRecord;
      tx.audit({ module: 'products', entityType: 'unit', entityId: id, action: 'CREATE', after: snapshot({ ...after }) });
      return toUnit(after);
    }
    const before = tx.db.prepare(`${UNIT_SQL} WHERE u.id = ?`).get(input.id) as UnitRecord | undefined;
    if (!before) throw new AppError(ErrorCodes.NOT_FOUND, 'Unit not found.');
    if (before.allow_decimal === 1 && !input.allowDecimal) {
      const fractional = tx.db
        .prepare(
          `SELECT p.name FROM products p JOIN stock_balances b ON b.product_id = p.id
           WHERE p.unit_id = ? AND (b.qty % 1000 != 0 OR p.min_stock_qty % 1000 != 0) LIMIT 1`,
        )
        .get(input.id) as { name: string } | undefined;
      if (fractional) {
        throw new AppError(
          ErrorCodes.BUSINESS_RULE,
          `${fractional.name} has a fractional quantity in ${before.code}, so this unit must keep allowing decimals.`,
        );
      }
    }
    const result = tx.db
      .prepare(
        `UPDATE units SET code = ?, name = ?, allow_decimal = ?, is_active = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND version = ?`,
      )
      .run(code, input.name, input.allowDecimal ? 1 : 0, input.isActive ? 1 : 0, tx.nowIso, input.id, input.version ?? -1);
    tx.expectOneChange(result.changes, 'This unit');
    const after = tx.db.prepare(`${UNIT_SQL} WHERE u.id = ?`).get(input.id) as UnitRecord;
    tx.audit({
      module: 'products',
      entityType: 'unit',
      entityId: input.id,
      action: before.is_active === 1 && after.is_active === 0 ? 'DEACTIVATE' : 'UPDATE',
      before: snapshot({ ...before }),
      after: snapshot({ ...after }),
    });
    return toUnit(after);
  });
}

/** Minimal supplier creation so products can name a preferred supplier; the full supplier module comes with purchases. */
export function quickAddSupplier(env: AppEnv, actor: Actor, input: { name: string; phone: string }): SupplierRef {
  return transact(env, actor, (tx) => {
    const existing = tx.db.prepare('SELECT id FROM suppliers WHERE name = ? COLLATE NOCASE').get(input.name);
    if (existing) throw new AppError(ErrorCodes.CONFLICT, `A supplier named "${input.name}" already exists.`);
    const code = tx.nextCode('SUPPLIER', 'S', 4, 'suppliers', 'code');
    const id = Number(
      tx.db
        .prepare('INSERT INTO suppliers (code, name, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(code, input.name, input.phone, tx.nowIso, tx.nowIso).lastInsertRowid,
    );
    tx.audit({ module: 'suppliers', entityType: 'supplier', entityId: id, action: 'CREATE', after: { code, ...input } });
    return { id, code, name: input.name, phone: input.phone, isActive: true };
  });
}

/** Finds or creates a product category / brand by name (used by imports). */
export function ensureNamed(tx: Tx, table: 'categories' | 'brands', name: string): number {
  const found =
    table === 'categories'
      ? (tx.db.prepare("SELECT id FROM categories WHERE kind = 'PRODUCT' AND name = ?").get(name) as { id: number } | undefined)
      : (tx.db.prepare('SELECT id FROM brands WHERE name = ?').get(name) as { id: number } | undefined);
  if (found) return found.id;
  const id = Number(
    (table === 'categories'
      ? tx.db
          .prepare("INSERT INTO categories (kind, name, created_at, updated_at) VALUES ('PRODUCT', ?, ?, ?)")
          .run(name, tx.nowIso, tx.nowIso)
      : tx.db.prepare('INSERT INTO brands (name, created_at, updated_at) VALUES (?, ?, ?)').run(name, tx.nowIso, tx.nowIso)
    ).lastInsertRowid,
  );
  tx.audit({
    module: 'products',
    entityType: table === 'categories' ? 'category' : 'brand',
    entityId: id,
    action: 'CREATE',
    after: { name },
    reason: 'Created by product import',
  });
  return id;
}
