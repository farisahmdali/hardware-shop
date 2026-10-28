import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listAudit } from '@main/services/audit';
import { walkInCustomerId } from '@main/services/customers';
import { runIntegrityChecks } from '@main/services/integrity';
import { accountBalance } from '@main/services/ledger';
import { getProduct } from '@main/services/products';
import { cancelPurchase, createSupplierReturn, editPurchase, getPurchase, listPurchases, type PurchaseEditInput } from '@main/services/purchases';
import { getSupplier } from '@main/services/suppliers';
import { listMovements } from '@main/services/stock';
import { describeChanges } from '@shared/auditFormat';
import { ShopData, rupees, units, type PricedProduct } from '../support/shop';
import { actorOf, createTestEnv, setupOwner, type TestEnv } from '../helpers';

let env: TestEnv;
let shop: ShopData;
let drill: PricedProduct & { sku: string };
let pipe: PricedProduct & { sku: string };
let supplier: number;

beforeEach(() => {
  env = createTestEnv();
  shop = new ShopData(env, actorOf(setupOwner(env)));
  drill = shop.product('Drill bit 8 mm', { price: rupees(60), cost: rupees(30) });
  pipe = shop.product('PVC pipe 1 in', { price: rupees(55), cost: rupees(38), unit: 'M' });
  supplier = shop.supplier('Pune Tools').id;
});
afterEach(() => env.cleanup());

const healthy = () => expect(runIntegrityChecks(env.db).issues).toEqual([]);
const stock = (p: PricedProduct) => getProduct(env.db, p.id, true);
const owed = (id = supplier) => getSupplier(env.db, id, shop.today()).balance;

/** An edit of `id` to the given lines, keeping the rest of the bill as `base` had it. */
function editOf(id: number, base: ReturnType<ShopData['purchaseInput']>, lines: { productId: number; qty: number; cost: number }[], change: Partial<PurchaseEditInput> = {}): PurchaseEditInput {
  const next = shop.purchaseInput(change.supplierId ?? base.supplierId, lines);
  const { payments: _payments, ...fields } = { ...next, supplierInvoiceNo: base.supplierInvoiceNo, supplierInvoiceDate: base.supplierInvoiceDate };
  return { ...fields, requestId: randomUUID(), id, reason: 'Wrong rate entered', ...change };
}

describe('editing a purchase', () => {
  it('saves a corrected version, keeps the earlier one, and fixes stock, accounts and what is owed', () => {
    const first = shop.buy(supplier, [{ productId: drill.id, qty: units(10), cost: rupees(300) }], rupees(1000));
    const original = getPurchase(env.db, first.purchaseId, shop.today());
    expect(stock(drill).stockValue).toBe(rupees(3000));

    const edited = editPurchase(env, shop.actor, editOf(first.purchaseId, original as never, [{ productId: drill.id, qty: units(10), cost: rupees(280) }]));
    expect(edited.purchaseNo).toBe(`${first.purchaseNo}-R2`);

    // The earlier version is kept, unchanged, marked replaced; the new one counts.
    const old = getPurchase(env.db, first.purchaseId, shop.today());
    expect(old).toMatchObject({ status: 'REPLACED', grandTotal: original.grandTotal, version: 1, cancellation: null });
    expect(old.replacedBy).toMatchObject({ id: edited.purchaseId, purchaseNo: edited.purchaseNo, reason: 'Wrong rate entered' });
    const now = getPurchase(env.db, edited.purchaseId, shop.today());
    expect(now).toMatchObject({ version: 2, replacedBy: null, grandTotal: rupees(2800 * 1.18) });
    expect(now.versions.map((v) => [v.purchaseNo, v.version])).toEqual([
      [first.purchaseNo, 1],
      [edited.purchaseNo, 2],
    ]);
    expect(listPurchases(env.db, { status: 'ALL', page: 1, pageSize: 10 }, shop.today()).rows.map((r) => r.purchaseNo)).toEqual([edited.purchaseNo]);
    expect(listPurchases(env.db, { status: 'REPLACED', page: 1, pageSize: 10 }, shop.today()).rows.map((r) => r.purchaseNo)).toEqual([first.purchaseNo]);

    // Stock: same quantity, value at the corrected cost (nothing else happened, so exactly).
    expect(stock(drill)).toMatchObject({ qty: units(10), stockValue: rupees(2800) });
    expect(accountBalance(env.db, 'INVENTORY')).toBe(rupees(2800));
    expect(accountBalance(env.db, 'INVENTORY_LOSS')).toBe(0);
    expect(accountBalance(env.db, 'INPUT_GST')).toBe(rupees(2800 * 0.18));
    // The ₹1,000 paid at entry now settles the corrected bill.
    expect(now.settlements.map((x) => x.amount)).toEqual([rupees(1000)]);
    expect(now.outstanding).toBe(rupees(2800 * 1.18 - 1000));
    expect(owed()).toBe(now.outstanding);
    healthy();
  });

  it('records the edit in the history with what changed, who changed it and why', () => {
    const first = shop.buy(supplier, [{ productId: drill.id, qty: units(10), cost: rupees(300) }, { productId: pipe.id, qty: units(50), cost: rupees(38) }]);
    const base = getPurchase(env.db, first.purchaseId, shop.today());
    const edited = editPurchase(
      env,
      shop.actor,
      editOf(first.purchaseId, base as never, [{ productId: drill.id, qty: units(12), cost: rupees(300) }, { productId: pipe.id, qty: units(50), cost: rupees(38) }], {
        reason: 'Two more drill bits were on the bill',
        supplierInvoiceNo: 'TB-1001',
      }),
    );
    const entry = listAudit(env.db, { page: 1, pageSize: 5, action: 'EDIT' }).rows[0]!;
    expect(entry).toMatchObject({ entityType: 'purchase', entityId: String(edited.purchaseId), relatedType: 'purchase', relatedId: String(first.purchaseId), username: 'owner', reason: 'Two more drill bits were on the bill' });
    const changes = describeChanges(entry.before, entry.after);
    expect(changes).toContain('Item: Drill bit 8 mm (P-000001): 10 PCS at ₹300.00, GST 18% → 12 PCS at ₹300.00, GST 18%');
    expect(changes).toContain('Supplier bill number:');
    expect(changes).not.toContain('PVC pipe'); // unchanged lines are not listed as changes

    // The current version's history includes the first version's entries.
    const history = listAudit(env.db, { page: 1, pageSize: 50, record: { type: 'purchase', id: String(edited.purchaseId), alsoIds: [String(first.purchaseId)] } }).rows;
    expect(history.map((h) => h.action)).toEqual(expect.arrayContaining(['CREATE', 'EDIT']));
    // Searching the bill's number finds every version.
    expect(listAudit(env.db, { page: 1, pageSize: 50, search: first.purchaseNo }).rows.map((h) => h.action)).toEqual(expect.arrayContaining(['CREATE', 'EDIT']));
    healthy();
  });

  it('moves no stock when only the details of the bill change', () => {
    const first = shop.buy(supplier, [{ productId: drill.id, qty: units(10), cost: rupees(300) }]);
    const movements = () => listMovements(env.db, { productId: drill.id, page: 1, pageSize: 50 }, true).total;
    const before = movements();
    const base = getPurchase(env.db, first.purchaseId, shop.today());
    editPurchase(env, shop.actor, editOf(first.purchaseId, base as never, [{ productId: drill.id, qty: units(10), cost: rupees(300) }], { supplierInvoiceNo: 'TB-77', notes: 'Bill number corrected', reason: 'Typo in the bill number' }));
    expect(movements()).toBe(before);
    expect(stock(drill)).toMatchObject({ qty: units(10), stockValue: rupees(3000) });
    expect(accountBalance(env.db, 'INVENTORY_LOSS')).toBe(0);
    healthy();
  });

  it('after some goods were sold, corrects the stock at the average cost and refuses to bring in less than was sold', () => {
    const first = shop.buy(supplier, [{ productId: drill.id, qty: units(10), cost: rupees(300) }]);
    shop.sell(walkInCustomerId(env.db), [{ p: drill, qty: units(6) }]);
    const base = getPurchase(env.db, first.purchaseId, shop.today());

    expect(() => editPurchase(env, shop.actor, editOf(first.purchaseId, base as never, [{ productId: drill.id, qty: units(5), cost: rupees(300) }]))).toThrow(
      /6 PCS of Drill bit 8 mm from this bill has already been sold or used/,
    );
    const edited = editPurchase(env, shop.actor, editOf(first.purchaseId, base as never, [{ productId: drill.id, qty: units(8), cost: rupees(300) }]));
    expect(stock(drill).qty).toBe(units(2));
    expect(getPurchase(env.db, edited.purchaseId, shop.today()).grandTotal).toBe(rupees(2400 * 1.18));
    healthy(); // stock value equals the inventory account, the difference went to stock adjustments
  });

  it('can be edited again, always from the newest version', () => {
    const first = shop.buy(supplier, [{ productId: drill.id, qty: units(10), cost: rupees(300) }]);
    const v1 = getPurchase(env.db, first.purchaseId, shop.today());
    const v2 = editPurchase(env, shop.actor, editOf(first.purchaseId, v1 as never, [{ productId: drill.id, qty: units(10), cost: rupees(290) }]));
    const v3 = editPurchase(env, shop.actor, editOf(v2.purchaseId, v1 as never, [{ productId: drill.id, qty: units(10), cost: rupees(295) }], { reason: 'Rate confirmed with supplier' }));
    expect(v3.purchaseNo).toBe(`${first.purchaseNo}-R3`);
    const latest = getPurchase(env.db, v3.purchaseId, shop.today());
    expect(latest.versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(getPurchase(env.db, first.purchaseId, shop.today()).versions).toHaveLength(3);

    // Editing, cancelling or returning against an older version points to the newer one.
    expect(() => editPurchase(env, shop.actor, editOf(v2.purchaseId, v1 as never, [{ productId: drill.id, qty: units(1), cost: rupees(1) }]))).toThrow(
      new RegExp(`already been edited; the bill is now ${v3.purchaseNo.replace(/\//g, '\\/')}`),
    );
    expect(() => cancelPurchase(env, shop.actor, { id: v2.purchaseId, reason: 'x', requestId: randomUUID() })).toThrow(/was edited/);
    expect(stock(drill)).toMatchObject({ qty: units(10), stockValue: rupees(2950) });
    // The newest version can be cancelled like any bill.
    cancelPurchase(env, shop.actor, { id: v3.purchaseId, reason: 'Goods never arrived', requestId: randomUUID() });
    expect(stock(drill).qty).toBe(0);
    expect(owed()).toBe(0);
    healthy();
  });

  it('refuses edits that are not allowed, and nothing changes', () => {
    const a = shop.buy(supplier, [{ productId: drill.id, qty: units(10), cost: rupees(300) }]);
    const base = getPurchase(env.db, a.purchaseId, shop.today());
    // Nothing changed.
    expect(() => editPurchase(env, shop.actor, editOf(a.purchaseId, base as never, [{ productId: drill.id, qty: units(10), cost: rupees(300) }]))).toThrow(/Nothing on the bill was changed/);
    // Another bill already has that supplier bill number.
    const b = shop.buy(supplier, [{ productId: pipe.id, qty: units(5), cost: rupees(38) }]);
    const other = getPurchase(env.db, b.purchaseId, shop.today());
    expect(() =>
      editPurchase(env, shop.actor, editOf(a.purchaseId, base as never, [{ productId: drill.id, qty: units(10), cost: rupees(300) }], { supplierInvoiceNo: other.supplierInvoiceNo })),
    ).toThrow(/already recorded/);
    // Goods returned against it.
    createSupplierReturn(env, shop.actor, {
      requestId: randomUUID(),
      purchaseId: b.purchaseId,
      lines: [{ purchaseLineId: other.lines[0]!.id, qty: units(1) }],
      reason: 'Cracked',
      settlement: 'ADJUST',
      reference: '',
    });
    const otherAfter = getPurchase(env.db, b.purchaseId, shop.today());
    expect(() => editPurchase(env, shop.actor, editOf(b.purchaseId, otherAfter as never, [{ productId: pipe.id, qty: units(6), cost: rupees(38) }]))).toThrow(/returned to the supplier/);
    // Cancelled.
    cancelPurchase(env, shop.actor, { id: a.purchaseId, reason: 'Entered twice', requestId: randomUUID() });
    expect(() => editPurchase(env, shop.actor, editOf(a.purchaseId, base as never, [{ productId: drill.id, qty: units(9), cost: rupees(300) }]))).toThrow(/was cancelled/);
    expect(listAudit(env.db, { page: 1, pageSize: 5, action: 'EDIT' }).total).toBe(0);
    healthy();
  });

  it('applies the same edit only once', () => {
    const first = shop.buy(supplier, [{ productId: drill.id, qty: units(10), cost: rupees(300) }]);
    const base = getPurchase(env.db, first.purchaseId, shop.today());
    const input = editOf(first.purchaseId, base as never, [{ productId: drill.id, qty: units(11), cost: rupees(300) }]);
    const once = editPurchase(env, shop.actor, input);
    expect(editPurchase(env, shop.actor, input)).toEqual(once);
    expect(stock(drill).qty).toBe(units(11));
    healthy();
  });

  it('dates the corrected accounts on the bill’s own day, and can move the bill to another supplier', () => {
    const other = shop.supplier('Mumbai Hardware Traders', '27AAACM1234F1Z5').id;
    const first = shop.buy(supplier, [{ productId: drill.id, qty: units(10), cost: rupees(300) }], rupees(500));
    const billDay = shop.today();
    env.clock.advanceMinutes(3 * 24 * 60);
    const base = getPurchase(env.db, first.purchaseId, shop.today());
    const edited = editPurchase(env, shop.actor, editOf(first.purchaseId, base as never, [{ productId: drill.id, qty: units(10), cost: rupees(300) }], { supplierId: other, reason: 'Entered under the wrong supplier' }));
    const dates = env.db
      .prepare("SELECT DISTINCT business_date AS d FROM ledger_entries WHERE (ref_type = 'PURCHASE' AND ref_id = ?) OR (ref_type = 'PURCHASE_REVISED' AND ref_id = ?)")
      .all(String(edited.purchaseId), String(first.purchaseId)) as { d: string }[];
    expect(dates.map((r) => r.d)).toEqual([billDay]);
    expect(getPurchase(env.db, edited.purchaseId, shop.today()).businessDate).toBe(billDay);
    // The ₹500 paid stays with the first supplier as an advance; the other supplier is owed the bill.
    expect(owed(supplier)).toBe(-rupees(500));
    expect(owed(other)).toBe(rupees(3000 * 1.18));
    healthy();
  });
});
