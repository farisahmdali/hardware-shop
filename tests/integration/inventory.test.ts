import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transact } from '@main/db/tx';
import { createProduct, getProduct, listProducts, setProductActive, updateProduct } from '@main/services/products';
import { adjustStock, costOfMovement, listMovements, recordMovement, stockSummary } from '@main/services/stock';
import { accountBalance } from '@main/services/ledger';
import { cancelCount, countLines, createCount, finalizeCount, saveCountLines } from '@main/services/stockCounts';
import { quickAddSupplier, saveBrand, saveCategory, saveUnit, getCatalog } from '@main/services/catalog';
import { buildImportPreview, commitImport } from '@main/services/productIo';
import { parseCsv, toCsv } from '@main/services/tabular';
import { runIntegrityChecks } from '@main/services/integrity';
import { listAudit } from '@main/services/audit';
import type { ProductDetail, SessionInfo } from '@shared/contracts';
import { actorOf, createTestEnv, setupOwner, type TestEnv } from '../helpers';

let env: TestEnv;
let owner: SessionInfo;
let actor: { userId: number | null; username: string | null };

const unitId = (code: string) => (env.db.prepare('SELECT id FROM units WHERE code = ?').get(code) as { id: number }).id;
const categoryId = (name: string) =>
  (env.db.prepare("SELECT id FROM categories WHERE kind = 'PRODUCT' AND name = ?").get(name) as { id: number }).id;

function newProduct(overrides: Partial<Parameters<typeof createProduct>[2]> = {}) {
  return createProduct(
    env,
    actor,
    {
      requestId: randomUUID(),
      sku: '',
      name: 'Claw hammer 450 g',
      categoryId: categoryId('Hand tools'),
      brandId: null,
      unitId: unitId('PCS'),
      description: '',
      hsnCode: '8205',
      gstRateBp: 1800,
      priceIncludesTax: true,
      purchasePrice: 10000,
      sellingPrice: 15000,
      minStockQty: 5000,
      preferredSupplierId: null,
      notes: '',
      openingQty: 0,
      ...overrides,
    },
    true,
  );
}

const adjust = (productId: number, kind: 'RECEIPT' | 'ADJUST_IN' | 'ADJUST_OUT' | 'DAMAGE' | 'LOSS', qty: number, unitCost?: number, reason = 'Test adjustment') =>
  adjustStock(env, actor, { requestId: randomUUID(), productId, kind, qty, unitCost, reason }, true);

/** A product as editable fields (costs are visible to the owner in these tests). */
const editable = (p: ProductDetail) => ({ ...p, purchasePrice: p.purchasePrice ?? 0 });

const expectHealthy = () => expect(runIntegrityChecks(env.db).issues).toEqual([]);

beforeEach(() => {
  env = createTestEnv();
  owner = setupOwner(env);
  actor = actorOf(owner);
});
afterEach(() => env.cleanup());

describe('weighted-average costing', () => {
  it('values receipts at cost and issues at the running average', () => {
    expect(costOfMovement({ qty: 0, value: 0 }, 10_000, { unitCost: 10000, fallbackUnitCost: 0 })).toBe(100000);
    expect(costOfMovement({ qty: 10_000, value: 100000 }, 10_000, { unitCost: 13000, fallbackUnitCost: 0 })).toBe(130000);
    // 20 units worth ₹2,300 -> average ₹115; issuing 5 removes ₹575.
    expect(costOfMovement({ qty: 20_000, value: 230000 }, -5_000, { fallbackUnitCost: 0 })).toBe(-57500);
  });

  it('clears all remaining value when stock reaches zero', () => {
    // 3 units worth ₹10.00: issuing 1 at a time leaves no stray paisa.
    expect(costOfMovement({ qty: 3000, value: 1000 }, -1000, { fallbackUnitCost: 0 })).toBe(-333);
    expect(costOfMovement({ qty: 1000, value: 334 }, -1000, { fallbackUnitCost: 0 })).toBe(-334);
  });

  it('resets the average after an authorised negative balance', () => {
    expect(costOfMovement({ qty: -2000, value: -20000 }, 5000, { unitCost: 12000, fallbackUnitCost: 0 })).toBe(56000);
  });
});

describe('products', () => {
  it('creates a product with an automatic code, opening stock, ledger entry and history', () => {
    const p = newProduct({ openingQty: 20_000, openingUnitCost: 9500 });
    expect(p.sku).toBe('P-000001');
    expect(p.qty).toBe(20_000);
    expect(p.stockValue).toBe(190000);
    expect(p.averageCost).toBe(9500);
    expect(newProduct({ name: 'Second' }).sku).toBe('P-000002');

    const movements = listMovements(env.db, { productId: p.id, page: 1, pageSize: 10 }, true).rows;
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ type: 'OPENING', qtyBefore: 0, qtyChange: 20_000, qtyAfter: 20_000, costValue: 190000 });
    expect(accountBalance(env.db, 'INVENTORY')).toBe(190000);
    expect(accountBalance(env.db, 'OWNER_EQUITY')).toBe(-190000);

    const created = listAudit(env.db, { page: 1, pageSize: 5, entityType: 'product', entityId: String(p.id) }).rows[0]!;
    expect(created.action).toBe('CREATE');
    expect((created.after as { openingStock: { qty: number } }).openingStock.qty).toBe(20_000);
    expectHealthy();
  });

  it('accepts a custom code but never a duplicate', () => {
    newProduct({ sku: 'HAM-450' });
    expect(() => newProduct({ sku: 'ham-450' })).toThrow(/already used/);
    // The automatic sequence skips codes typed in by hand.
    newProduct({ sku: 'P-000001', name: 'Typed code' });
    expect(newProduct({ name: 'Auto' }).sku).toBe('P-000002');
  });

  it('does not run a create twice for the same request', () => {
    const requestId = randomUUID();
    const a = newProduct({ requestId, openingQty: 1000 });
    const b = newProduct({ requestId, openingQty: 1000 });
    expect(b.id).toBe(a.id);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM products').get()).toEqual({ n: 1 });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get()).toEqual({ n: 1 });
  });

  it('records price changes with before and after values without touching stock history', () => {
    const p = newProduct({ openingQty: 5000 });
    env.clock.advanceMinutes(10);
    updateProduct(env, actor, { ...editable(p), sellingPrice: 16500, version: p.version, reason: 'Supplier price rise' }, true);
    const entry = listAudit(env.db, { page: 1, pageSize: 5, entityType: 'product', entityId: String(p.id), action: 'PRICE_CHANGE' }).rows[0]!;
    expect(entry.username).toBe('owner');
    expect(entry.reason).toBe('Supplier price rise');
    expect((entry.before as { sellingPrice: number }).sellingPrice).toBe(15000);
    expect((entry.after as { sellingPrice: number }).sellingPrice).toBe(16500);
    const movement = listMovements(env.db, { productId: p.id, page: 1, pageSize: 5 }, true).rows[0]!;
    expect(movement.unitCost).toBe(10000);
  });

  it('rejects stale edits', () => {
    const p = newProduct();
    updateProduct(env, actor, { ...editable(p), name: 'Hammer A', version: p.version }, true);
    expect(() => updateProduct(env, actor, { ...editable(p), name: 'Hammer B', version: p.version }, true)).toThrow(/changed by someone else/);
  });

  it('deactivates instead of deleting', () => {
    const p = newProduct();
    const off = setProductActive(env, actor, { id: p.id, version: p.version, isActive: false, reason: 'Discontinued' }, true);
    expect(off.isActive).toBe(false);
    expect(() => env.db.prepare('DELETE FROM products WHERE id = ?').run(p.id)).toThrow(/IMMUTABLE/);
    expect(listProducts(env.db, { stock: 'ALL', active: 'ACTIVE', sort: 'name', dir: 'asc', page: 1, pageSize: 50 }, true).total).toBe(0);
  });

  it('hides costs from roles that may not see them', () => {
    const p = newProduct({ openingQty: 2000 });
    const hidden = getProduct(env.db, p.id, false);
    expect(hidden.purchasePrice).toBeNull();
    expect(hidden.stockValue).toBeNull();
    expect(hidden.averageCost).toBeNull();
    expect(stockSummary(env.db, false).inventoryValue).toBeNull();
  });
});

describe('stock movements', () => {
  it('keeps the weighted average through receipts and issues', () => {
    const p = newProduct({ openingQty: 10_000, openingUnitCost: 10000 });
    adjust(p.id, 'RECEIPT', 10_000, 13000);
    expect(getProduct(env.db, p.id, true)).toMatchObject({ qty: 20_000, stockValue: 230000, averageCost: 11500 });
    const damaged = adjust(p.id, 'DAMAGE', 5_000, undefined, 'Dropped from rack');
    expect(damaged.costValue).toBe(-57500);
    expect(getProduct(env.db, p.id, true)).toMatchObject({ qty: 15_000, stockValue: 172500 });
    expect(accountBalance(env.db, 'INVENTORY_LOSS')).toBe(57500);
    expect(accountBalance(env.db, 'INVENTORY')).toBe(172500);
    expectHealthy();
  });

  it('prevents removing more than is in stock', () => {
    const p = newProduct({ openingQty: 3000 });
    expect(() => adjust(p.id, 'LOSS', 4000)).toThrow(/Not enough stock/);
    expect(getProduct(env.db, p.id, true).qty).toBe(3000);
  });

  it('enforces whole numbers for counted units and allows decimals for metres', () => {
    const hammer = newProduct({ openingQty: 3000 });
    expect(() => adjust(hammer.id, 'ADJUST_IN', 1500)).toThrow(/whole/);
    const pipe = newProduct({ name: 'PVC pipe 1 in', unitId: unitId('M'), openingQty: 100_500 });
    adjust(pipe.id, 'ADJUST_OUT', 2_250, undefined, 'Offcut');
    expect(getProduct(env.db, pipe.id, true).qty).toBe(98_250);
  });

  it('requires a reason for corrections but not for receipts', async () => {
    const { contract } = await import('@shared/contracts');
    const schema = contract['stock.adjust'].input;
    const base = { requestId: randomUUID(), productId: 1, qty: 1000 };
    expect(schema.safeParse({ ...base, kind: 'DAMAGE', reason: '' }).success).toBe(false);
    expect(schema.safeParse({ ...base, kind: 'RECEIPT', reason: '' }).success).toBe(true);
  });

  it('applies an adjustment once even if the request is sent twice', () => {
    const p = newProduct({ openingQty: 10_000 });
    const requestId = randomUUID();
    const input = { requestId, productId: p.id, kind: 'DAMAGE' as const, qty: 1000, reason: 'Broken handle' };
    adjustStock(env, actor, input, true);
    adjustStock(env, actor, input, true);
    expect(getProduct(env.db, p.id, true).qty).toBe(9000);
  });

  it('records the user, time, reason and link for every movement', () => {
    const p = newProduct({ openingQty: 10_000 });
    env.clock.advanceMinutes(30);
    const m = adjust(p.id, 'LOSS', 1000, undefined, 'Missing after stock check');
    expect(m).toMatchObject({ username: 'owner', reason: 'Missing after stock check', refType: 'MANUAL', occurredAt: '2026-10-21T05:00:00.000Z' });
    const audit = listAudit(env.db, { page: 1, pageSize: 5, action: 'STOCK_LOSS' }).rows[0]!;
    expect(audit.relatedId).toBe(String(m.id));
  });

  it('cannot be altered, deleted or bypassed', () => {
    const p = newProduct({ openingQty: 10_000 });
    expect(() => env.db.prepare('UPDATE stock_movements SET qty_change = 1').run()).toThrow(/IMMUTABLE/);
    expect(() => env.db.prepare('DELETE FROM stock_movements').run()).toThrow(/IMMUTABLE/);
    expect(() => env.db.prepare('UPDATE stock_balances SET qty = 999999').run()).toThrow(/IMMUTABLE/);
    expect(() => env.db.prepare('UPDATE ledger_entries SET debit = 1').run()).toThrow(/IMMUTABLE/);
    // A movement that does not start from the current balance is refused by the database.
    expect(() =>
      env.db
        .prepare(
          `INSERT INTO stock_movements (product_id, type, qty_before, qty_change, qty_after, value_before, value_after,
             occurred_at, business_date, txn_ref) VALUES (?, 'ADJUST_IN', 0, 5000, 5000, 0, 0, 'x', 'x', 'x')`,
        )
        .run(p.id),
    ).toThrow(/STOCK_OUT_OF_SYNC/);
    expect(() =>
      transact(env, actor, (tx) => recordMovement(tx, { productId: p.id, type: 'LOSS', qtyChange: -20_000 })),
    ).toThrow(/Not enough stock/);
    expectHealthy();
  });

  it('is detected by the data health check if the database is tampered with outside the app', () => {
    const p = newProduct({ openingQty: 10_000 });
    env.db.exec('DROP TRIGGER stock_balances_no_update');
    env.db.prepare('UPDATE stock_balances SET qty = 999000 WHERE product_id = ?').run(p.id);
    const checks = runIntegrityChecks(env.db).issues.map((i) => i.check);
    expect(checks).toContain('stock-balances');
    expect(checks).toContain('immutability-triggers');
  });

  it('summarises stock value, low and out-of-stock counts', () => {
    newProduct({ name: 'Plenty', openingQty: 50_000 });
    newProduct({ name: 'Low', openingQty: 3_000 });
    newProduct({ name: 'Out' });
    const s = stockSummary(env.db, true);
    expect(s).toMatchObject({ activeProducts: 3, lowStock: 1, outOfStock: 1, inventoryValue: 530000 });
    // Retail value at selling price: 53 units × ₹150.
    expect(s.retailValue).toBe(795000);
  });
});

describe('search and filters', () => {
  it('finds products by words, prefixes, code and brand', () => {
    const bosch = saveBrand(env, actor, { name: 'Bosch', isActive: true });
    newProduct({ name: 'Impact drill 13 mm', brandId: bosch.id, sku: 'BOS-ID13' });
    newProduct({ name: 'Drill bit set 5 pc' });
    newProduct({ name: 'Claw hammer' });
    const search = (q: string) =>
      listProducts(env.db, { search: q, stock: 'ALL', active: 'ACTIVE', sort: 'name', dir: 'asc', page: 1, pageSize: 50 }, true).rows.map((r) => r.name);
    expect(search('dri')).toEqual(['Drill bit set 5 pc', 'Impact drill 13 mm']);
    expect(search('drill bosch')).toEqual(['Impact drill 13 mm']);
    expect(search('BOS-ID13')).toEqual(['Impact drill 13 mm']);
    expect(search('hammer claw')).toEqual(['Claw hammer']);
    expect(search('"; DROP TABLE products; --')).toEqual([]);
    // Renaming a brand updates the search index.
    saveBrand(env, actor, { id: bosch.id, name: 'Bosch Professional', isActive: true, version: bosch.version });
    expect(search('professional')).toEqual(['Impact drill 13 mm']);
  });

  it('filters by stock status and sorts by value', () => {
    newProduct({ name: 'A', openingQty: 50_000 });
    newProduct({ name: 'B', openingQty: 2_000 });
    newProduct({ name: 'C' });
    const list = (stock: 'LOW' | 'OUT' | 'LOW_OR_OUT' | 'IN_STOCK') =>
      listProducts(env.db, { stock, active: 'ACTIVE', sort: 'name', dir: 'asc', page: 1, pageSize: 50 }, true).rows.map((r) => r.name);
    expect(list('LOW')).toEqual(['B']);
    expect(list('OUT')).toEqual(['C']);
    expect(list('LOW_OR_OUT')).toEqual(['B', 'C']);
    expect(list('IN_STOCK')).toEqual(['A']);
    const byValue = listProducts(env.db, { stock: 'ALL', active: 'ACTIVE', sort: 'value', dir: 'desc', page: 1, pageSize: 50 }, true);
    expect(byValue.rows.map((r) => r.name)).toEqual(['A', 'B', 'C']);
  });
});

describe('catalogue', () => {
  it('manages categories, brands, units and suppliers with history', () => {
    const cat = saveCategory(env, actor, { name: 'Garden', isActive: true });
    expect(() => saveCategory(env, actor, { name: 'garden', isActive: true })).toThrow(/already exists/);
    saveCategory(env, actor, { id: cat.id, name: 'Garden tools', isActive: true, version: cat.version });
    const unit = saveUnit(env, actor, { code: 'dozen', name: 'Dozens', allowDecimal: false, isActive: true });
    expect(unit.code).toBe('DOZEN');
    const supplier = quickAddSupplier(env, actor, { name: 'Pune Tools Traders', phone: '9800000000' });
    expect(supplier.code).toBe('S-0001');
    expect(getCatalog(env.db).suppliers).toHaveLength(1);
    expect(listAudit(env.db, { page: 1, pageSize: 5, entityType: 'category', entityId: String(cat.id), action: 'UPDATE' }).total).toBe(1);
  });

  it('keeps decimals allowed on a unit whose products hold fractional stock', () => {
    newProduct({ name: 'Wire', unitId: unitId('M'), openingQty: 2_500 });
    const metres = getCatalog(env.db).units.find((u) => u.code === 'M')!;
    expect(() => saveUnit(env, actor, { ...metres, allowDecimal: false })).toThrow(/fractional/);
  });
});

describe('stock counts', () => {
  it('reconciles counted quantities against stock at the moment of finalizing', () => {
    const a = newProduct({ name: 'A', openingQty: 10_000 });
    const b = newProduct({ name: 'B', openingQty: 4_000 });
    const c = newProduct({ name: 'C', openingQty: 7_000 });
    const count = createCount(env, actor, { categoryId: null, notes: 'Month end', requestId: randomUUID() });
    expect(count.lineCount).toBe(3);
    expect(() => createCount(env, actor, { categoryId: null, notes: '', requestId: randomUUID() })).toThrow(/still open/);

    saveCountLines(env, actor, {
      id: count.id,
      lines: [
        { productId: a.id, countedQty: 9_000, note: '' },
        { productId: b.id, countedQty: 4_000, note: '' },
      ],
    });
    // Stock moves while counting: the count is compared with stock at finalization.
    adjust(a.id, 'DAMAGE', 1_000);
    const lines = countLines(env.db, { id: count.id, show: 'VARIANCE', page: 1, pageSize: 50 });
    expect(lines.total).toBe(0);

    const done = finalizeCount(env, actor, { id: count.id, version: count.version, reason: 'Month-end count', requestId: randomUUID() });
    expect(done.status).toBe('FINALIZED');
    expect(getProduct(env.db, a.id, true).qty).toBe(9_000);
    expect(getProduct(env.db, c.id, true).qty).toBe(7_000);
    expect(() =>
      saveCountLines(env, actor, { id: count.id, lines: [{ productId: c.id, countedQty: 1, note: '' }] }),
    ).toThrow(/closed/);
    expect(() => env.db.prepare('UPDATE stock_count_lines SET counted_qty = 1').run()).toThrow(/IMMUTABLE/);
    expectHealthy();
  });

  it('creates correction movements for differences', () => {
    const a = newProduct({ name: 'A', openingQty: 10_000 });
    const count = createCount(env, actor, { categoryId: null, notes: '', requestId: randomUUID() });
    saveCountLines(env, actor, { id: count.id, lines: [{ productId: a.id, countedQty: 12_000, note: 'Found in store room' }] });
    const before = countLines(env.db, { id: count.id, show: 'VARIANCE', page: 1, pageSize: 50 });
    expect(before.rows[0]).toMatchObject({ variance: 2_000 });
    const done = finalizeCount(env, actor, { id: count.id, version: count.version, reason: 'Annual count', requestId: randomUUID() });
    expect(done.varianceCount).toBe(1);
    const m = listMovements(env.db, { productId: a.id, type: 'RECONCILE', page: 1, pageSize: 5 }, true).rows[0]!;
    expect(m).toMatchObject({ qtyChange: 2_000, refType: 'STOCK_COUNT', refId: String(count.id) });
    expectHealthy();
  });

  it('can be cancelled without touching stock', () => {
    const a = newProduct({ name: 'A', openingQty: 10_000 });
    const count = createCount(env, actor, { categoryId: null, notes: '', requestId: randomUUID() });
    saveCountLines(env, actor, { id: count.id, lines: [{ productId: a.id, countedQty: 1_000, note: '' }] });
    cancelCount(env, actor, { id: count.id, version: count.version, reason: 'Started by mistake' });
    expect(getProduct(env.db, a.id, true).qty).toBe(10_000);
  });
});

describe('import and export', () => {
  const header = 'sku,name,category,brand,unit,hsn,gst_rate,price_includes_gst,purchase_price,selling_price,min_stock,opening_stock,supplier,description,notes';

  it('previews, reports row errors and imports only valid rows', () => {
    newProduct({ sku: 'EXISTING' });
    const csv = [
      header,
      ',Claw hammer,Hand tools,Stanley,PCS,8205,18,yes,310,450,5,20,,,',
      ',"Pipe, PVC 1 in",Plumbing,Supreme,metres,3917,18%,no,"38.50",55,50,200.5,,,',
      'EXISTING,Duplicate code,,,PCS,,,,,,,,,,',
      ',No unit,,,boxes of joy,,,,,,,,,,',
      ',Half a hammer,,,PCS,,,,,,,1.5,,,',
      ',Bad rate,,,PCS,,7,,,,,,,,',
      ',Bad price,,,PCS,,,,abc,,,,,,',
      ',Unknown supplier,,,PCS,,,,,,,,Nobody Ltd,,',
      ',New brand item,Garden,Falcon,PCS,,5,,100,150,,3,,,',
    ].join('\n');
    const preview = buildImportPreview(env.db, 'C:\\shop\\products.csv', parseCsv(csv));
    expect(preview).toMatchObject({ fileName: 'products.csv', totalRows: 9, validRows: 3, errorRows: 6 });
    const errors = Object.fromEntries(preview.rows.filter((r) => r.errors.length).map((r) => [r.line, r.errors.join('; ')]));
    expect(errors[4]).toMatch(/already exists/);
    expect(errors[5]).toMatch(/Unknown unit/);
    expect(errors[6]).toMatch(/whole PCS/);
    expect(errors[7]).toMatch(/not a valid slab/);
    expect(errors[8]).toMatch(/not a valid amount/);
    expect(errors[9]).toMatch(/does not exist/);
    expect(preview.newCategories).toEqual(['Garden']);
    expect(preview.newBrands.sort()).toEqual(['Falcon', 'Stanley', 'Supreme']);

    const requestId = randomUUID();
    expect(commitImport(env, actor, preview.token, requestId)).toEqual({ created: 3 });
    expect(commitImport(env, actor, preview.token, requestId)).toEqual({ created: 3 });
    const all = listProducts(env.db, { stock: 'ALL', active: 'ACTIVE', sort: 'name', dir: 'asc', page: 1, pageSize: 50 }, true).rows;
    const pipe = all.find((r) => r.name === 'Pipe, PVC 1 in')!;
    expect(pipe).toMatchObject({ unitCode: 'M', qty: 200_500, sellingPrice: 5500, purchasePrice: 3850, priceIncludesTax: false });
    expect(all.find((r) => r.name === 'New brand item')!.gstRateBp).toBe(500);
    expect(all).toHaveLength(4);
    expect(listAudit(env.db, { page: 1, pageSize: 5, action: 'IMPORT' }).total).toBe(1);
    expectHealthy();
  });

  it('rejects a file without the required columns', () => {
    expect(() => buildImportPreview(env.db, 'x.csv', parseCsv('title,price\nHammer,10'))).toThrow(/missing: name, unit/);
  });

  it('writes CSV that spreadsheets cannot execute and reads it back', () => {
    const csv = toCsv(['name', 'note'], [['=HYPERLINK("http://x")', 'a "quoted", value'], ['₹ price', 12.5]]);
    expect(csv.startsWith('\ufeff')).toBe(true);
    const rows = parseCsv(csv);
    expect(rows[1]).toEqual(["'=HYPERLINK(\"http://x\")", 'a "quoted", value']);
    expect(rows[2]).toEqual(['₹ price', '12.5']);
  });
});

describe('performance', () => {
  it('searches 30,000 products quickly', () => {
    const insert = env.db.prepare(
      `INSERT INTO products (sku, name, unit_id, hsn_code, gst_rate_bp, price_includes_tax, purchase_price, selling_price,
         min_stock_qty, created_at, updated_at) VALUES (?, ?, ?, '', 1800, 1, 100, 150, 0, 'x', 'x')`,
    );
    const words = ['drill', 'hammer', 'pipe', 'wire', 'socket', 'bulb', 'screw', 'nail', 'paint', 'brush', 'tape', 'valve'];
    const pcs = unitId('PCS');
    env.db.transaction(() => {
      for (let i = 0; i < 30_000; i++) {
        insert.run(`T-${i}`, `${words[i % 12]} ${words[(i * 7) % 12]} model ${i}`, pcs);
      }
    })();
    const filter = { stock: 'ALL' as const, active: 'ACTIVE' as const, sort: 'name' as const, dir: 'asc' as const, page: 1, pageSize: 50 };
    listProducts(env.db, { ...filter, search: 'warm up' }, true);
    const timings: number[] = [];
    for (const q of ['drill mod', 'pipe', 'T-29999', 'screw model 1']) {
      const start = performance.now();
      const result = listProducts(env.db, { ...filter, search: q }, true);
      timings.push(performance.now() - start);
      expect(result.total).toBeGreaterThan(0);
    }
    const start = performance.now();
    listProducts(env.db, { ...filter, stock: 'LOW_OR_OUT', sort: 'value', dir: 'desc' }, true);
    timings.push(performance.now() - start);
    console.log(`search timings (ms): ${timings.map((t) => t.toFixed(1)).join(', ')}`);
    expect(Math.max(...timings)).toBeLessThan(150);
  });
});
