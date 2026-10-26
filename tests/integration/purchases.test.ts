import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transact } from '@main/db/tx';
import { createProduct, getProduct } from '@main/services/products';
import { listMovements } from '@main/services/stock';
import { accountBalance } from '@main/services/ledger';
import { finalizeSale, type SalesPermissions } from '@main/services/sales';
import { listPaymentMethods } from '@main/services/payments';
import { getAllSettings, updateSettingsSection } from '@main/services/settings';
import { runIntegrityChecks } from '@main/services/integrity';
import { listAudit } from '@main/services/audit';
import { adjustSupplierBalance, createSupplier, getSupplier, listSuppliers, supplierLedger } from '@main/services/suppliers';
import { cancelPurchase, createPurchase, createSupplierReturn, getPurchase, listPurchases, type PurchaseInput } from '@main/services/purchases';
import {
  applySupplierCredit,
  listPayables,
  listSupplierPayments,
  payablesAgeing,
  payablesSummary,
  paySupplier,
  refundFromSupplier,
  reverseSupplierPayment,
} from '@main/services/supplierPayments';
import { renderDocument } from '@main/print/documents';
import { computeBill } from '@shared/billing';
import { claimsInputGst, computePurchase } from '@shared/purchasing';
import { ALL_PERMISSIONS } from '@shared/permissions';
import { businessDateOf } from '@shared/time';
import type { ProductDetail } from '@shared/contracts';
import { actorOf, createTestEnv, setupOwner, type TestEnv } from '../helpers';

let env: TestEnv;
let actor: { userId: number | null; username: string | null };
const OWNER: SalesPermissions = { permissions: ALL_PERMISSIONS, maxDiscountBp: 10_000 };
const LOCAL_GSTIN = '27AAPFU0939F1ZV';
const KARNATAKA_GSTIN = '29AAACR5055K1Z3';

let drill: ProductDetail;
let wire: ProductDetail;
let local: number;
let karnataka: number;
let unregistered: number;
let cash: number;
let upi: number;
let billNo = 0;
const today = () => businessDateOf(env.clock.now(), env.timeZone);
const rupees = (r: number) => r * 100;
const units = (n: number) => n * 1000;

const unitId = (code: string) => (env.db.prepare('SELECT id FROM units WHERE code = ?').get(code) as { id: number }).id;

function product(name: string, unit: string, cost: number, openingQty = 0) {
  return createProduct(
    env,
    actor,
    {
      requestId: randomUUID(),
      sku: '',
      name,
      categoryId: null,
      brandId: null,
      unitId: unitId(unit),
      description: '',
      hsnCode: '8467',
      gstRateBp: 1800,
      priceIncludesTax: true,
      purchasePrice: cost,
      sellingPrice: cost * 2,
      minStockQty: 0,
      preferredSupplierId: null,
      notes: '',
      openingQty,
    },
    true,
  );
}

function supplier(name: string, gstin: string, stateCode: string, openingBalance = 0, creditDays: number | null = 30) {
  return createSupplier(env, actor, {
    requestId: randomUUID(),
    name,
    phone: '',
    address: '',
    businessName: '',
    gstin,
    stateCode,
    creditDays,
    notes: '',
    openingBalance,
  }).id;
}

/** Builds a purchase the way the entry screen does: total from the shared calculation. */
function purchase(
  supplierId: number,
  lines: { p: ProductDetail; qty: number; cost: number; gst?: number }[],
  opts: Partial<PurchaseInput> = {},
) {
  const settings = getAllSettings(env.db);
  const s = env.db.prepare('SELECT gstin, state_code FROM suppliers WHERE id = ?').get(supplierId) as { gstin: string; state_code: string };
  const inputLines = lines.map((l) => ({ productId: l.p.id, qty: l.qty, unitCost: l.cost, gstRateBp: l.gst ?? 1800, discount: null }));
  const calc = computePurchase(inputLines, {
    pricesIncludeTax: opts.pricesIncludeTax ?? false,
    interstate: s.state_code !== '' && s.state_code !== settings.shop.stateCode,
    billDiscount: opts.billDiscount ?? null,
    additionalCosts: opts.additionalCosts ?? 0,
    roundOff: opts.roundOff ?? 0,
    itcClaimed: claimsInputGst({ claimInputGst: settings.purchases.claimInputGst, gstRegistered: settings.tax.gstRegistered }, s.gstin),
  });
  return createPurchase(env, actor, {
    requestId: randomUUID(),
    supplierId,
    supplierInvoiceNo: `B-${++billNo}`,
    supplierInvoiceDate: today(),
    pricesIncludeTax: false,
    lines: inputLines,
    billDiscount: null,
    additionalCosts: 0,
    additionalCostsNote: '',
    roundOff: 0,
    notes: '',
    payments: [],
    updatePurchasePrices: true,
    expectedGrandTotal: calc.grandTotal,
    ...opts,
  });
}

const stock = (p: ProductDetail) => getProduct(env.db, p.id, true);
const owed = (supplierId: number) => getSupplier(env.db, supplierId, today()).balance;
const outstanding = (purchaseId: number) => getPurchase(env.db, purchaseId, today()).outstanding;

function expectHealthy() {
  const report = runIntegrityChecks(env.db);
  expect(report.issues).toEqual([]);
}

beforeEach(() => {
  env = createTestEnv();
  actor = actorOf(setupOwner(env));
  drill = product('Impact drill 13 mm', 'PCS', rupees(900));
  wire = product('Copper wire 2.5 sq mm', 'M', rupees(30));
  local = supplier('Pune Tools Distributors', LOCAL_GSTIN, '27');
  karnataka = supplier('Bengaluru Electricals', KARNATAKA_GSTIN, '29');
  unregistered = supplier('Ramesh Traders', '', '');
  const methods = listPaymentMethods(env.db, false);
  cash = methods.find((m) => m.kind === 'CASH')!.id;
  upi = methods.find((m) => m.kind === 'UPI')!.id;
});

afterEach(() => env.cleanup());

describe('recording purchases', () => {
  it('receives stock at landed cost, keeps input GST out of cost and owes the supplier the bill total', () => {
    const r = purchase(local, [{ p: drill, qty: units(10), cost: rupees(1000) }], { additionalCosts: rupees(200), additionalCostsNote: 'Freight' });
    // 10 × ₹1,000 = ₹10,000 + CGST ₹900 + SGST ₹900 + freight ₹200.
    expect(r.grandTotal).toBe(rupees(12_000));
    expect(r.outstanding).toBe(rupees(12_000));
    expect(r.purchaseNo).toMatch(/^PUR\/\d{4}-\d{2}\/00001$/);

    const p = getPurchase(env.db, r.purchaseId, today());
    expect(p).toMatchObject({ cgstTotal: rupees(900), sgstTotal: rupees(900), igstTotal: 0, itcClaimed: true, inventoryValue: rupees(10_200), status: 'UNPAID' });
    expect(p.lines[0]).toMatchObject({ additionalCost: rupees(200), landedValue: rupees(10_200), landedUnitCost: rupees(1020) });

    const d = stock(drill);
    expect(d.qty).toBe(units(10));
    expect(d.stockValue).toBe(rupees(10_200));
    expect(d.purchasePrice).toBe(rupees(1020));
    expect(owed(local)).toBe(rupees(12_000));
    expect(accountBalance(env.db, 'INPUT_GST')).toBe(rupees(1800));
    expect(listMovements(env.db, { productId: drill.id, page: 1, pageSize: 10 }, true).rows[0]).toMatchObject({ type: 'PURCHASE', refType: 'PURCHASE', refId: String(r.purchaseId) });
    expect(listAudit(env.db, { entityType: 'product', entityId: String(drill.id), page: 1, pageSize: 10 }).rows.some((a) => a.action === 'COST_UPDATED')).toBe(true);
    expectHealthy();
  });

  it('charges IGST for another state and spreads freight by value', () => {
    const r = purchase(
      karnataka,
      [
        { p: drill, qty: units(2), cost: rupees(1000) },
        { p: wire, qty: units(100), cost: rupees(10) },
      ],
      { additionalCosts: rupees(300) },
    );
    const p = getPurchase(env.db, r.purchaseId, today());
    expect(p.isInterstate).toBe(true);
    expect(p.cgstTotal + p.sgstTotal).toBe(0);
    expect(p.igstTotal).toBe(rupees(540));
    // Taxable ₹2,000 and ₹1,000: freight splits ₹200 / ₹100.
    expect(p.lines.map((l) => l.additionalCost)).toEqual([rupees(200), rupees(100)]);
    expect(stock(wire).stockValue).toBe(rupees(1100));
    expectHealthy();
  });

  it('refuses GST on a bill from a supplier without a GSTIN, and never claims input GST for them', () => {
    expect(() => purchase(unregistered, [{ p: drill, qty: units(1), cost: rupees(500) }])).toThrow(/no GSTIN/);
    const r = purchase(unregistered, [{ p: drill, qty: units(1), cost: rupees(500), gst: 0 }]);
    expect(getPurchase(env.db, r.purchaseId, today()).itcClaimed).toBe(false);
    expect(r.grandTotal).toBe(rupees(500));
    expectHealthy();
  });

  it('adds GST to the stock cost when input tax credit is not claimed', () => {
    transact(env, actor, (tx) => updateSettingsSection(tx, 'purchases', { ...getAllSettings(env.db).purchases, claimInputGst: false }));
    const r = purchase(local, [{ p: drill, qty: units(10), cost: rupees(1000) }]);
    expect(getPurchase(env.db, r.purchaseId, today()).itcClaimed).toBe(false);
    expect(stock(drill).stockValue).toBe(rupees(11_800));
    expect(accountBalance(env.db, 'INPUT_GST')).toBe(0);
    expectHealthy();
  });

  it('accepts rates that include GST and a small round-off to match the supplier total', () => {
    const r = purchase(local, [{ p: drill, qty: units(3), cost: rupees(1180) }], { pricesIncludeTax: true, roundOff: 40 });
    const p = getPurchase(env.db, r.purchaseId, today());
    expect(p.taxableTotal).toBe(rupees(3000));
    expect(p.grandTotal).toBe(rupees(3540) + 40);
    expect(p.inventoryValue).toBe(rupees(3000));
    expect(accountBalance(env.db, 'ROUND_OFF')).toBe(40);
    expectHealthy();
  });

  it('refuses a repeated supplier bill number, a future date, a large round-off and a wrong total', () => {
    purchase(local, [{ p: drill, qty: units(1), cost: rupees(100) }], { supplierInvoiceNo: 'INV-77' });
    expect(() => purchase(local, [{ p: drill, qty: units(1), cost: rupees(100) }], { supplierInvoiceNo: 'inv-77' })).toThrow(/already recorded/);
    // Another supplier may use the same number.
    purchase(karnataka, [{ p: drill, qty: units(1), cost: rupees(100) }], { supplierInvoiceNo: 'INV-77' });
    expect(() => purchase(local, [{ p: drill, qty: units(1), cost: rupees(100) }], { supplierInvoiceDate: '2099-01-01' })).toThrow(/future/);
    expect(() => purchase(local, [{ p: drill, qty: units(1), cost: rupees(100) }], { roundOff: rupees(50) })).toThrow(/Round-off/);
    expect(() => purchase(local, [{ p: drill, qty: units(1), cost: rupees(100) }], { expectedGrandTotal: 1 })).toThrow(/works out to/);
    expectHealthy();
  });

  it('returns the first result for a repeated request', () => {
    const requestId = randomUUID();
    const make = () =>
      purchase(local, [{ p: drill, qty: units(4), cost: rupees(100) }], { requestId, supplierInvoiceNo: 'SAME' });
    const a = make();
    const b = make();
    expect(b).toEqual(a);
    expect(stock(drill).qty).toBe(units(4));
  });

  it('keeps purchases and their lines unchangeable', () => {
    const r = purchase(local, [{ p: drill, qty: units(1), cost: rupees(100) }]);
    expect(() => env.db.prepare('UPDATE purchases SET grand_total = 1 WHERE id = ?').run(r.purchaseId)).toThrow(/IMMUTABLE/);
    expect(() => env.db.prepare('DELETE FROM purchase_lines WHERE purchase_id = ?').run(r.purchaseId)).toThrow(/IMMUTABLE/);
    expect(() => env.db.prepare('DELETE FROM suppliers WHERE id = ?').run(local)).toThrow(/IMMUTABLE/);
  });
});

describe('paying suppliers', () => {
  it('pays at entry, settles the oldest bills first and uses an advance for the next bill', () => {
    env.clock.set('2026-10-01T04:30:00.000Z');
    const a = purchase(local, [{ p: drill, qty: units(5), cost: rupees(1000) }], { payments: [{ methodId: cash, amount: rupees(1000), reference: '' }] });
    expect(a.outstanding).toBe(rupees(5900 - 1000));
    env.clock.set('2026-10-05T04:30:00.000Z');
    const b = purchase(local, [{ p: wire, qty: units(100), cost: rupees(30) }], {});
    expect(owed(local)).toBe(rupees(4900 + 3540));

    paySupplier(env, actor, { requestId: randomUUID(), supplierId: local, amount: rupees(6000), methodId: upi, reference: 'UTR1', notes: '', allocations: [] });
    expect(outstanding(a.purchaseId)).toBe(0);
    expect(outstanding(b.purchaseId)).toBe(rupees(3540 - 1100));

    const pay = paySupplier(env, actor, { requestId: randomUUID(), supplierId: local, amount: rupees(3440), methodId: upi, reference: '', notes: '', allocations: [] });
    expect(outstanding(b.purchaseId)).toBe(0);
    expect(pay.unallocated).toBe(rupees(1000));
    expect(owed(local)).toBe(rupees(-1000));
    expect(getSupplier(env.db, local, today()).availableCredit).toBe(rupees(1000));

    const c = purchase(local, [{ p: drill, qty: units(1), cost: rupees(1500) }]);
    // ₹1,770 bill, ₹1,000 advance used automatically.
    expect(c.outstanding).toBe(rupees(770));
    expect(owed(local)).toBe(rupees(770));
    expect(accountBalance(env.db, 'CASH')).toBe(rupees(-1000));
    expect(accountBalance(env.db, 'UPI')).toBe(rupees(-9440));
    expectHealthy();
  });

  it('pays a chosen bill and refuses paying more than is owed on it', () => {
    const a = purchase(local, [{ p: drill, qty: units(1), cost: rupees(1000) }]);
    const b = purchase(local, [{ p: drill, qty: units(1), cost: rupees(2000) }]);
    expect(() =>
      paySupplier(env, actor, {
        requestId: randomUUID(),
        supplierId: local,
        amount: rupees(5000),
        methodId: cash,
        reference: '',
        notes: '',
        allocations: [{ docType: 'PURCHASE', docId: b.purchaseId, amount: rupees(3000) }],
      }),
    ).toThrow(/still owed/);
    paySupplier(env, actor, {
      requestId: randomUUID(),
      supplierId: local,
      amount: rupees(2360),
      methodId: cash,
      reference: '',
      notes: '',
      allocations: [{ docType: 'PURCHASE', docId: b.purchaseId, amount: rupees(2360) }],
    });
    expect(outstanding(b.purchaseId)).toBe(0);
    expect(outstanding(a.purchaseId)).toBe(rupees(1180));
    expect(listPayables(env.db, { filter: 'ALL', page: 1, pageSize: 10 }, today()).rows.map((r) => r.docId)).toEqual([a.purchaseId]);
    expectHealthy();
  });

  it('reversing a payment reopens the bills it paid', () => {
    const a = purchase(local, [{ p: drill, qty: units(1), cost: rupees(1000) }]);
    const pay = paySupplier(env, actor, { requestId: randomUUID(), supplierId: local, amount: rupees(1180), methodId: cash, reference: '', notes: '', allocations: [] });
    expect(outstanding(a.purchaseId)).toBe(0);
    const reversed = reverseSupplierPayment(env, actor, { id: pay.id, reason: 'Cheque bounced' });
    expect(reversed.reversal?.reason).toBe('Cheque bounced');
    expect(outstanding(a.purchaseId)).toBe(rupees(1180));
    expect(accountBalance(env.db, 'CASH')).toBe(0);
    expect(() => reverseSupplierPayment(env, actor, { id: pay.id, reason: 'again' })).toThrow(/already been reversed/);
    expectHealthy();
  });

  it('records an advance refunded by the supplier', () => {
    paySupplier(env, actor, { requestId: randomUUID(), supplierId: local, amount: rupees(2000), methodId: cash, reference: '', notes: 'Advance', allocations: [] });
    expect(() => refundFromSupplier(env, actor, { requestId: randomUUID(), supplierId: local, amount: rupees(2500), methodId: cash, reference: '', reason: 'Order cancelled' })).toThrow(/Only/);
    const r = refundFromSupplier(env, actor, { requestId: randomUUID(), supplierId: local, amount: rupees(2000), methodId: cash, reference: '', reason: 'Order cancelled' });
    expect(r.direction).toBe('IN');
    expect(r.paymentNo).toMatch(/^SRF\//);
    expect(owed(local)).toBe(0);
    expect(accountBalance(env.db, 'CASH')).toBe(0);
    expect(listSupplierPayments(env.db, { supplierId: local, direction: 'ALL', page: 1, pageSize: 10 }).total).toBe(2);
    expectHealthy();
  });

  it('uses an opening balance, shows it on the supplier account and in ageing', () => {
    const old = supplier('Old Supplier', '', '', rupees(5000));
    expect(owed(old)).toBe(rupees(5000));
    paySupplier(env, actor, { requestId: randomUUID(), supplierId: old, amount: rupees(2000), methodId: cash, reference: '', notes: '', allocations: [] });
    adjustSupplierBalance(env, actor, { requestId: randomUUID(), supplierId: old, kind: 'ADJUSTMENT', amount: rupees(-500), reason: 'Discount agreed on old dues' });
    expect(owed(old)).toBe(rupees(2500));
    const ledger = supplierLedger(env.db, old, {}, today());
    expect(ledger.closingBalance).toBe(rupees(2500));
    expect(ledger.rows.map((r) => r.description)).toEqual(['Opening balance: Carried over when the supplier was added', 'Payment made', 'Balance adjustment: Discount agreed on old dues']);
    const ageing = payablesAgeing(env.db, today());
    expect(ageing.rows.find((r) => r.supplierId === old)?.outstanding).toBe(rupees(2500));
    expect(payablesSummary(env.db, today())).toMatchObject({ outstanding: rupees(2500), suppliersOwed: 1 });
    expect(listSuppliers(env.db, { filter: 'OWED', active: 'ACTIVE', page: 1, pageSize: 10 }, today()).rows.map((s) => s.id)).toEqual([old]);
    expect(renderDocument(env.db, 'SUPPLIER_STATEMENT', old, 'A4', today()).html).toContain('SUPPLIER ACCOUNT');
    expectHealthy();
  });

  it('marks bills overdue after the supplier credit period', () => {
    const shortTerms = supplier('Cash and carry', LOCAL_GSTIN, '27', 0, 7);
    env.clock.set('2026-10-01T04:30:00.000Z');
    const r = purchase(shortTerms, [{ p: drill, qty: units(1), cost: rupees(100) }]);
    expect(getPurchase(env.db, r.purchaseId, '2026-10-08').dueDate).toBe('2026-10-08');
    env.clock.set('2026-10-09T04:30:00.000Z');
    expect(listPurchases(env.db, { status: 'OVERDUE', page: 1, pageSize: 10 }, today()).rows.map((p) => p.id)).toEqual([r.purchaseId]);
    expect(payablesSummary(env.db, today()).overdue).toBe(rupees(118));
    applySupplierCredit(env, actor, { supplierId: shortTerms, requestId: randomUUID() });
    expectHealthy();
  });
});

describe('cancelling purchases', () => {
  it('restores stock and its value exactly when nothing has happened since, and keeps payments as an advance', () => {
    drill = product('Angle grinder', 'PCS', rupees(100), units(5));
    const r = purchase(local, [{ p: drill, qty: units(10), cost: rupees(150) }], { payments: [{ methodId: cash, amount: rupees(500), reference: '' }] });
    expect(stock(drill).stockValue).toBe(rupees(500 + 1500));
    cancelPurchase(env, actor, { id: r.purchaseId, reason: 'Entered twice', requestId: randomUUID() });
    const d = stock(drill);
    expect(d.qty).toBe(units(5));
    expect(d.stockValue).toBe(rupees(500));
    const p = getPurchase(env.db, r.purchaseId, today());
    expect(p.status).toBe('CANCELLED');
    expect(p.cancellation?.reason).toBe('Entered twice');
    expect(owed(local)).toBe(rupees(-500));
    expect(accountBalance(env.db, 'INPUT_GST')).toBe(0);
    expect(accountBalance(env.db, 'INVENTORY_LOSS')).toBe(0);
    expect(() => cancelPurchase(env, actor, { id: r.purchaseId, reason: 'again', requestId: randomUUID() })).toThrow(/already cancelled/);
    // The bill number can be entered again once cancelled.
    purchase(local, [{ p: drill, qty: units(1), cost: rupees(150) }], { supplierInvoiceNo: p.supplierInvoiceNo });
    expectHealthy();
  });

  it('after later stock movements, removes stock at average cost and records the difference', () => {
    drill = product('Angle grinder', 'PCS', rupees(100), units(5));
    const r = purchase(local, [{ p: drill, qty: units(10), cost: rupees(160) }]);
    const bill = computeBill([{ unitPrice: rupees(400), qty: units(2), gstRateBp: 1800, priceIncludesTax: true }], {
      interstate: false,
      gstRegistered: true,
      roundTotal: true,
    });
    const walkIn = (env.db.prepare('SELECT id FROM customers WHERE is_walkin = 1').get() as { id: number }).id;
    env.db.prepare('UPDATE products SET selling_price = ? WHERE id = ?').run(rupees(400), drill.id);
    finalizeSale(env, actor, OWNER, {
      requestId: randomUUID(),
      customerId: walkIn,
      walkInName: '',
      walkInPhone: '',
      lines: [{ productId: drill.id, qty: units(2), discount: null, expectedUnitPrice: rupees(400) }],
      billDiscount: null,
      payments: [{ methodId: cash, amount: bill.grandTotal, reference: '' }],
      useCredit: 0,
      notes: '',
      expectedGrandTotal: bill.grandTotal,
    });
    // 15 at ₹2,100 → average ₹140; 2 sold leaves 13 worth ₹1,820.
    cancelPurchase(env, actor, { id: r.purchaseId, reason: 'Wrong supplier', requestId: randomUUID() });
    const d = stock(drill);
    expect(d.qty).toBe(units(3));
    expect(d.stockValue).toBe(rupees(420));
    // ₹1,600 came in, ₹1,400 went out: ₹200 recorded as a stock adjustment gain.
    expect(accountBalance(env.db, 'INVENTORY_LOSS')).toBe(rupees(-200));
    expectHealthy();
  });

  it('refuses to cancel when the stock has been sold, or after a return', () => {
    const r = purchase(local, [{ p: drill, qty: units(2), cost: rupees(100) }]);
    createSupplierReturn(env, actor, { requestId: randomUUID(), purchaseId: r.purchaseId, lines: [{ purchaseLineId: getPurchase(env.db, r.purchaseId, today()).lines[0]!.id, qty: units(1) }], reason: 'Damaged', settlement: 'ADJUST', reference: '' });
    expect(() => cancelPurchase(env, actor, { id: r.purchaseId, reason: 'Mistake', requestId: randomUUID() })).toThrow(/already returned/);

    const r2 = purchase(local, [{ p: wire, qty: units(50), cost: rupees(10) }]);
    env.db.prepare('UPDATE products SET selling_price = ? WHERE id = ?').run(rupees(20), wire.id);
    const walkIn = (env.db.prepare('SELECT id FROM customers WHERE is_walkin = 1').get() as { id: number }).id;
    const bill = computeBill([{ unitPrice: rupees(20), qty: units(10), gstRateBp: 1800, priceIncludesTax: true }], { interstate: false, gstRegistered: true, roundTotal: true });
    finalizeSale(env, actor, OWNER, {
      requestId: randomUUID(),
      customerId: walkIn,
      walkInName: '',
      walkInPhone: '',
      lines: [{ productId: wire.id, qty: units(10), discount: null, expectedUnitPrice: rupees(20) }],
      billDiscount: null,
      payments: [{ methodId: cash, amount: bill.grandTotal, reference: '' }],
      useCredit: 0,
      notes: '',
      expectedGrandTotal: bill.grandTotal,
    });
    expect(() => cancelPurchase(env, actor, { id: r2.purchaseId, reason: 'Mistake', requestId: randomUUID() })).toThrow(/already been sold/);
    expectHealthy();
  });
});

describe('supplier returns', () => {
  it('credits the supplier, reverses input GST and removes stock at average cost', () => {
    const r = purchase(local, [{ p: drill, qty: units(10), cost: rupees(1000) }]);
    const line = getPurchase(env.db, r.purchaseId, today()).lines[0]!;
    const dn = createSupplierReturn(env, actor, {
      requestId: randomUUID(),
      purchaseId: r.purchaseId,
      lines: [{ purchaseLineId: line.id, qty: units(2) }],
      reason: 'Two pieces arrived broken',
      settlement: 'ADJUST',
      reference: '',
    });
    expect(dn.debitNoteNo).toMatch(/^DN\//);
    expect(dn.total).toBe(rupees(2360));
    expect(outstanding(r.purchaseId)).toBe(rupees(11_800 - 2360));
    expect(owed(local)).toBe(rupees(9440));
    expect(accountBalance(env.db, 'INPUT_GST')).toBe(rupees(1800 - 360));
    expect(stock(drill)).toMatchObject({ qty: units(8), stockValue: rupees(8000) });

    const p = getPurchase(env.db, r.purchaseId, today());
    expect(p.lines[0]!.returnedQty).toBe(units(2));
    expect(p.debitNotes).toHaveLength(1);
    expect(p.returnedTotal).toBe(rupees(2360));
    expect(() =>
      createSupplierReturn(env, actor, { requestId: randomUUID(), purchaseId: r.purchaseId, lines: [{ purchaseLineId: line.id, qty: units(9) }], reason: 'More', settlement: 'ADJUST', reference: '' }),
    ).toThrow(/Only 8/);
    expect(renderDocument(env.db, 'DEBIT_NOTE', dn.debitNoteId, 'A4', today()).html).toContain('Two pieces arrived broken');
    expectHealthy();
  });

  it('returns in parts add up exactly to the bill line', () => {
    const r = purchase(local, [{ p: wire, qty: units(3), cost: 3333 }]);
    const line = getPurchase(env.db, r.purchaseId, today()).lines[0]!;
    let total = 0;
    for (let i = 0; i < 3; i++) {
      total += createSupplierReturn(env, actor, {
        requestId: randomUUID(),
        purchaseId: r.purchaseId,
        lines: [{ purchaseLineId: line.id, qty: units(1) }],
        reason: 'Faulty roll',
        settlement: 'ADJUST',
        reference: '',
      }).total;
    }
    expect(total).toBe(line.lineTotal);
    expect(outstanding(r.purchaseId)).toBe(0);
    expect(stock(wire)).toMatchObject({ qty: 0, stockValue: 0 });
    expectHealthy();
  });

  it('takes a refund from the supplier for goods already paid for', () => {
    const r = purchase(local, [{ p: drill, qty: units(2), cost: rupees(1000) }], { payments: [{ methodId: upi, amount: rupees(2360), reference: '' }] });
    const line = getPurchase(env.db, r.purchaseId, today()).lines[0]!;
    createSupplierReturn(env, actor, {
      requestId: randomUUID(),
      purchaseId: r.purchaseId,
      lines: [{ purchaseLineId: line.id, qty: units(1) }],
      reason: 'Wrong model',
      settlement: 'REFUND',
      refundMethodId: upi,
      reference: 'UTR99',
    });
    expect(owed(local)).toBe(0);
    expect(accountBalance(env.db, 'UPI')).toBe(rupees(-2360 + 1180));
    const payments = listSupplierPayments(env.db, { supplierId: local, direction: 'IN', page: 1, pageSize: 10 });
    expect(payments.rows[0]).toMatchObject({ amount: rupees(1180), reference: 'UTR99' });
    expectHealthy();
  });
});
