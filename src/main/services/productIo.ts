import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Db } from '../db/connection';
import { transact, type Actor } from '../db/tx';
import type { AppEnv } from './env';
import { ensureNamed } from './catalog';
import { getAllSettings } from './settings';
import { insertProduct, iterateProducts, type ProductFieldsInput } from './products';
import { parseCsv, readXlsx, toCsv, toXlsx, type Cell } from './tabular';
import { AppError, ErrorCodes } from '@shared/errors';
import { paiseToDecimalString, parseMoney } from '@shared/money';
import { parseQty, qtyToDecimalString } from '@shared/qty';
import { GST_RATES_BP } from '@shared/stock';
import type { ImportPreview, ProductFilter } from '@shared/contracts';

/** Import/export columns. The first header row of an import file must use these names (any case, spaces or underscores). */
export const IMPORT_COLUMNS = [
  'sku',
  'name',
  'category',
  'brand',
  'unit',
  'hsn',
  'gst_rate',
  'price_includes_gst',
  'purchase_price',
  'selling_price',
  'min_stock',
  'opening_stock',
  'supplier',
  'description',
  'notes',
] as const;

type Column = (typeof IMPORT_COLUMNS)[number];
const REQUIRED: Column[] = ['name', 'unit'];
const MAX_ROWS = 20_000;
const MAX_BYTES = 10 * 1024 * 1024;

const normaliseHeader = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z_]/g, '');

const YES = new Set(['yes', 'y', 'true', '1', 'incl', 'inclusive']);
const NO = new Set(['no', 'n', 'false', '0', 'excl', 'exclusive']);

interface ParsedRow {
  line: number;
  fields: ProductFieldsInput & { openingQty: number };
  categoryName: string;
  brandName: string;
  errors: string[];
}

interface PendingImport {
  fileName: string;
  rows: ParsedRow[];
  createdAt: number;
}

/** One pending import at a time, held in memory until confirmed (or for 30 minutes). */
const pending = new Map<string, PendingImport>();
const PENDING_TTL_MS = 30 * 60_000;

export async function readTable(filePath: string, contents: Buffer): Promise<string[][]> {
  if (contents.length > MAX_BYTES) throw new AppError(ErrorCodes.VALIDATION, 'The file is larger than 10 MB.');
  if (/\.xlsx$/i.test(filePath)) return readXlsx(contents);
  if (/\.csv$/i.test(filePath) || /\.txt$/i.test(filePath)) return parseCsv(contents.toString('utf8'));
  throw new AppError(ErrorCodes.VALIDATION, 'Choose a .csv or .xlsx file.');
}

/** Validates every row against the current catalogue without writing anything. */
export function buildImportPreview(db: Db, fileName: string, table: string[][]): ImportPreview {
  if (table.length < 2) throw new AppError(ErrorCodes.VALIDATION, 'The file has no product rows under the header row.');
  if (table.length - 1 > MAX_ROWS) throw new AppError(ErrorCodes.VALIDATION, `Import at most ${MAX_ROWS} products at a time.`);

  const header = table[0]!.map(normaliseHeader);
  const index = new Map<Column, number>();
  header.forEach((h, i) => {
    if ((IMPORT_COLUMNS as readonly string[]).includes(h)) index.set(h as Column, i);
  });
  const missing = REQUIRED.filter((c) => !index.has(c));
  if (missing.length) {
    throw new AppError(ErrorCodes.VALIDATION, `The header row is missing: ${missing.join(', ')}. Download the template to see the expected columns.`);
  }

  const units = db.prepare('SELECT id, code, name, allow_decimal, is_active FROM units').all() as {
    id: number;
    code: string;
    name: string;
    allow_decimal: number;
    is_active: number;
  }[];
  const suppliers = new Map(
    (db.prepare('SELECT id, name FROM suppliers').all() as { id: number; name: string }[]).map((s) => [s.name.toLowerCase(), s.id]),
  );
  const categories = new Map(
    (db.prepare("SELECT id, name FROM categories WHERE kind = 'PRODUCT'").all() as { id: number; name: string }[]).map((c) => [
      c.name.toLowerCase(),
      c.id,
    ]),
  );
  const brands = new Map(
    (db.prepare('SELECT id, name FROM brands').all() as { id: number; name: string }[]).map((b) => [b.name.toLowerCase(), b.id]),
  );
  const skuExists = db.prepare('SELECT 1 FROM products WHERE sku = ?');
  const defaultInclusive = getAllSettings(db).tax.pricesIncludeTax;

  const seenSkus = new Set<string>();
  const newCategories = new Set<string>();
  const newBrands = new Set<string>();
  const rows: ParsedRow[] = [];

  table.slice(1).forEach((cells, i) => {
    const get = (c: Column) => (index.has(c) ? (cells[index.get(c)!] ?? '').trim() : '');
    const errors: string[] = [];

    const sku = get('sku');
    if (sku) {
      if (!/^[A-Za-z0-9._/-]{1,40}$/.test(sku)) errors.push('Code may use only letters, digits and . _ / -');
      else if (seenSkus.has(sku.toLowerCase())) errors.push(`Code ${sku} appears twice in the file`);
      else if (skuExists.get(sku)) errors.push(`Code ${sku} already exists`);
      seenSkus.add(sku.toLowerCase());
    }

    const name = get('name');
    if (!name) errors.push('Name is missing');
    else if (name.length > 200) errors.push('Name is longer than 200 characters');

    const unitText = get('unit').toLowerCase();
    const unit = units.find((u) => u.code.toLowerCase() === unitText || u.name.toLowerCase() === unitText);
    if (!unit) errors.push(`Unknown unit "${get('unit')}"`);
    else if (!unit.is_active) errors.push(`Unit ${unit.code} is inactive`);
    const allowDecimal = unit?.allow_decimal === 1;

    const hsn = get('hsn').replace(/\s/g, '');
    if (hsn && !/^(\d{4}|\d{6}|\d{8})$/.test(hsn)) errors.push('HSN must be 4, 6 or 8 digits');

    const rateText = get('gst_rate').replace('%', '').trim();
    let gstRateBp = 1800;
    if (rateText) {
      const bp = Math.round(Number(rateText) * 100);
      if (!Number.isFinite(bp) || !(GST_RATES_BP as readonly number[]).includes(bp)) errors.push(`GST rate "${get('gst_rate')}" is not a valid slab`);
      else gstRateBp = bp;
    }

    const inclText = get('price_includes_gst').toLowerCase();
    let priceIncludesTax = defaultInclusive;
    if (inclText) {
      if (YES.has(inclText)) priceIncludesTax = true;
      else if (NO.has(inclText)) priceIncludesTax = false;
      else errors.push('price_includes_gst must be yes or no');
    }

    const money = (c: Column, label: string): number => {
      const t = get(c);
      if (!t) return 0;
      const v = parseMoney(t);
      if (v === null || v < 0) {
        errors.push(`${label} "${t}" is not a valid amount`);
        return 0;
      }
      return v;
    };
    const purchasePrice = money('purchase_price', 'Purchase price');
    const sellingPrice = money('selling_price', 'Selling price');

    const qty = (c: Column, label: string): number => {
      const t = get(c);
      if (!t) return 0;
      const v = parseQty(t, allowDecimal || !unit);
      if (v === null) {
        errors.push(`${label} "${t}" is not a valid quantity${unit && !allowDecimal ? ` (whole ${unit.code} only)` : ''}`);
        return 0;
      }
      return v;
    };
    const minStockQty = qty('min_stock', 'Minimum stock');
    const openingQty = qty('opening_stock', 'Opening stock');

    const supplierName = get('supplier');
    let preferredSupplierId: number | null = null;
    if (supplierName) {
      preferredSupplierId = suppliers.get(supplierName.toLowerCase()) ?? null;
      if (preferredSupplierId === null) errors.push(`Supplier "${supplierName}" does not exist; add it first or leave the column empty`);
    }

    const categoryName = get('category').slice(0, 80);
    if (categoryName && !categories.has(categoryName.toLowerCase())) newCategories.add(categoryName);
    const brandName = get('brand').slice(0, 80);
    if (brandName && !brands.has(brandName.toLowerCase())) newBrands.add(brandName);

    rows.push({
      line: i + 2,
      categoryName,
      brandName,
      errors,
      fields: {
        sku,
        name,
        categoryId: null,
        brandId: null,
        unitId: unit?.id ?? 0,
        description: get('description').slice(0, 1000),
        hsnCode: hsn,
        gstRateBp,
        priceIncludesTax,
        purchasePrice,
        sellingPrice,
        minStockQty,
        preferredSupplierId,
        notes: get('notes').slice(0, 1000),
        openingQty,
      },
    });
  });

  // Only rows without errors decide which new categories/brands would be created.
  const valid = rows.filter((r) => r.errors.length === 0);
  const usedNewCategories = [...newCategories].filter((c) => valid.some((r) => r.categoryName.toLowerCase() === c.toLowerCase()));
  const usedNewBrands = [...newBrands].filter((b) => valid.some((r) => r.brandName.toLowerCase() === b.toLowerCase()));

  pending.clear();
  const token = randomUUID();
  pending.set(token, { fileName, rows, createdAt: Date.now() });

  const withErrors = rows.filter((r) => r.errors.length > 0);
  return {
    token,
    fileName: basename(fileName),
    totalRows: rows.length,
    validRows: valid.length,
    errorRows: withErrors.length,
    rows: [...withErrors.slice(0, 300), ...valid.slice(0, 50)].map((r) => ({
      line: r.line,
      sku: r.fields.sku,
      name: r.fields.name,
      errors: r.errors,
    })),
    newCategories: usedNewCategories,
    newBrands: usedNewBrands,
  };
}

/** Creates every valid row from a previewed file in one transaction; rows with errors are skipped. */
export function commitImport(env: AppEnv, actor: Actor, token: string, requestId: string): { created: number } {
  return transact(env, actor, (tx) =>
    tx.once(requestId, 'products.importCommit', () => {
      const p = pending.get(token);
      if (!p || Date.now() - p.createdAt > PENDING_TTL_MS) {
        throw new AppError(ErrorCodes.BUSINESS_RULE, 'This import preview has expired. Choose the file again.');
      }
      const valid = p.rows.filter((r) => r.errors.length === 0);
      if (valid.length === 0) throw new AppError(ErrorCodes.BUSINESS_RULE, 'There are no valid rows to import.');
      const reason = `Imported from ${basename(p.fileName)}`;
      for (const r of valid) {
        insertProduct(
          tx,
          {
            ...r.fields,
            categoryId: r.categoryName ? ensureNamed(tx, 'categories', r.categoryName) : null,
            brandId: r.brandName ? ensureNamed(tx, 'brands', r.brandName) : null,
          },
          reason,
        );
      }
      tx.audit({
        module: 'products',
        entityType: 'product_import',
        entityId: null,
        action: 'IMPORT',
        after: { file: basename(p.fileName), created: valid.length, skipped: p.rows.length - valid.length },
      });
      pending.delete(token);
      return { created: valid.length };
    }),
  );
}

// ---------- Export ----------

const EXPORT_HEADER = [
  ...IMPORT_COLUMNS.filter((c) => c !== 'opening_stock'),
  'stock_qty',
  'stock_status',
  'average_cost',
  'stock_value',
  'active',
];

export async function exportProducts(
  db: Db,
  filter: Omit<ProductFilter, 'page' | 'pageSize'>,
  format: 'csv' | 'xlsx',
  canSeeCost: boolean,
): Promise<{ data: Buffer | string; rows: number }> {
  const rows: Cell[][] = [];
  const money = (p: number | null): Cell => (p === null ? '' : format === 'xlsx' ? p / 100 : paiseToDecimalString(p));
  const qty = (q: number): Cell => (format === 'xlsx' ? q / 1000 : qtyToDecimalString(q));
  for (const p of iterateProducts(db, filter, canSeeCost)) {
    rows.push([
      p.sku,
      p.name,
      p.categoryName ?? '',
      p.brandName ?? '',
      p.unitCode,
      p.hsnCode,
      p.gstRateBp / 100,
      p.priceIncludesTax ? 'yes' : 'no',
      money(p.purchasePrice),
      money(p.sellingPrice),
      qty(p.minStockQty),
      p.supplierName ?? '',
      p.description,
      p.notes,
      qty(p.qty),
      p.status === 'OUT' ? 'Out of stock' : p.status === 'LOW' ? 'Low' : 'In stock',
      money(p.averageCost),
      money(p.stockValue),
      p.isActive ? 'yes' : 'no',
    ]);
  }
  if (format === 'csv') return { data: toCsv(EXPORT_HEADER, rows), rows: rows.length };
  const moneyFmt = '#,##0.00';
  const qtyFmt = '#,##0.###';
  return {
    data: await toXlsx('Products', EXPORT_HEADER, rows, { 8: moneyFmt, 9: moneyFmt, 10: qtyFmt, 14: qtyFmt, 16: moneyFmt, 17: moneyFmt }),
    rows: rows.length,
  };
}

export async function importTemplate(format: 'csv' | 'xlsx'): Promise<Buffer | string> {
  const example: Cell[][] = [
    ['', 'Claw hammer 450 g', 'Hand tools', 'Stanley', 'PCS', '8205', '18', 'yes', '310.00', '450.00', '5', '20', '', '', ''],
    ['', 'PVC pipe 1 inch (per metre)', 'Plumbing', 'Supreme', 'M', '3917', '18', 'yes', '38.50', '55.00', '50', '200.5', '', '', ''],
  ];
  return format === 'csv' ? toCsv([...IMPORT_COLUMNS], example) : toXlsx('Products', [...IMPORT_COLUMNS], example);
}
