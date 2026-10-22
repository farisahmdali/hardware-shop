import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transact } from '@main/db/tx';
import { createProduct, getProduct, updateProduct } from '@main/services/products';
import { listMovements } from '@main/services/stock';
import { accountBalance } from '@main/services/ledger';
import { adjustBalance, createCustomer, customerLedger, getCustomer, walkInCustomerId } from '@main/services/customers';
import { cancelInvoice, createCreditNote, finalizeSale, getInvoice, listInvoices, type FinalizeInput, type SalesPermissions } from '@main/services/sales';
import {
  ageingReport,
  listPaymentMethods,
  listReceivables,
  receivablesSummary,
  receivePayment,
  refundCustomer,
  reversePayment,
} from '@main/services/payments';
import { updateSettingsSection } from '@main/services/settings';
import { getAllSettings } from '@main/services/settings';
import { runIntegrityChecks } from '@main/services/integrity';
import { listAudit } from '@main/services/audit';
import { computeBill } from '@shared/billing';
import { ALL_PERMISSIONS } from '@shared/permissions';
import type { ProductDetail } from '@shared/contracts';
import { actorOf, createTestEnv, setupOwner, type TestEnv } from '../helpers';

let env: TestEnv;
let actor: { userId: number | null; username: string | null };
const OWNER: SalesPermissions = { permissions: ALL_PERMISSIONS, maxDiscountBp: 10_000 };
const SALES_STAFF: SalesPermissions = { permissions: ['sales.create', 'sales.discount', 'payments.receive'], maxDiscountBp: 500 };

let hammer: ProductDetail;
let pipe: ProductDetail;
let cash: number;
let upi: number;
let walkIn: number;
const today = () => env.clock.now().toISOString().slice(0, 10);

const unitId = (code: string) => (env.db.prepare('SELECT id FROM units WHERE code = ?').get(code) as { id: number }).id;

function product(name: string, unit: string, price: number, cost: number, openingQty: number, includesTax = true) {
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
      hsnCode: '8205',
      gstRateBp: 1800,
      priceIncludesTax: includesTax,
      purchasePrice: cost,
      sellingPrice: price,
      minStockQty: 0,
      preferredSupplierId: null,
      notes: '',
      openingQty,
    },
    true,
  );
}

function customer(name: string, stateCode = '27') {
  return createCustomer(env, actor, {
    requestId: randomUUID(),
    name,
    phone: '',
    address: '',
    businessName: '',
    gstin: '',
    stateCode,
    creditDays: 15,
    creditLimit: 0,
    notes: '',
    openingBalance: 0,
  });
}

/** Builds a sale the way the counter screen does: prices from the product, total from the shared engine. */
function sale(
  customerId: number,
  lines: { p: ProductDetail; qty: number; discount?: FinalizeInput['lines'][number]['discount'] }[],
  opts: Partial<FinalizeInput> & { pay?: { methodId: number; amount: number }[]; perms?: SalesPermissions; interstate?: boolean } = {},
) {
  const settings = getAllSettings(env.db);
  const bill = computeBill(
    lines.map((l) => ({ unitPrice: l.p.sellingPrice, qty: l.qty, gstRateBp: l.p.gstRateBp, priceIncludesTax: l.p.priceIncludesTax, discount: l.discount ?? null })),
    { interstate: opts.interstate ?? false, gstRegistered: settings.tax.gstRegistered, roundTotal: settings.tax.roundInvoiceTotal, billDiscount: opts.billDiscount ?? null },
  );
  return finalizeSale(env, actor, opts.perms ?? OWNER, {
    requestId: opts.requestId ?? randomUUID(),
    customerId,
    walkInName: '',
    walkInPhone: '',
    lines: lines.map((l) => ({ productId: l.p.id, qty: l.qty, discount: l.discount ?? null, expectedUnitPrice: l.p.sellingPrice })),
    billDiscount: opts.billDiscount ?? null,
    payments: (opts.pay ?? []).map((p) => ({ ...p, reference: '' })),
    useCredit: opts.useCredit ?? 0,
    notes: '',
    expectedGrandTotal: opts.expectedGrandTotal ?? bill.grandTotal,
    negativeStockReason: opts.negativeStockReason,
  });
}

const healthy = () => expect(runIntegrityChecks(env.db).issues).toEqual([]);
const inv = (id: number) => getInvoice(env.db, id, true, today());
const cust = (id: number) => getCustomer(env.db, id, today());

beforeEach(() => {
  env = createTestEnv();
  actor = actorOf(setupOwner(env));
  hammer = product('Claw hammer', 'PCS', 45000, 31000, 20_000);
  pipe = product('PVC pipe 1 in', 'M', 5500, 3850, 100_000);
  const methods = listPaymentMethods(env.db, false);
  cash = methods.find((m) => m.kind === 'CASH')!.id;
  upi = methods.find((m) => m.kind === 'UPI')!.id;
  walkIn = walkInCustomerId(env.db);
});
afterEach(() => env.cleanup());

describe('counter sale', () => {
  it('finalizes a paid walk-in sale with stock, tax, cost and ledger entries', () => {
    // ₹900.00 + 2.5 m × ₹55.00 = ₹1,037.50, rounded to ₹1,038 with a 50 paise round-off.
    const r = sale(walkIn, [{ p: hammer, qty: 2000 }, { p: pipe, qty: 2500 }], { pay: [{ methodId: cash, amount: 103800 }] });
    expect(r).toMatchObject({ invoiceNo: 'INV/2026-27/00001', grandTotal: 103800, outstanding: 0 });
    const i = inv(r.invoiceId);
    expect(i.status).toBe('PAID');
    expect(i.lines.map((l) => l.taxable)).toEqual([76271, 11653]);
    expect(i.roundOff).toBe(50);
    expect(i.cgstTotal + i.sgstTotal).toBe(103800 - 76271 - 11653 - i.roundOff);
    expect(i.costTotal).toBe(62000 + 9625);

    expect(getProduct(env.db, hammer.id, true).qty).toBe(18_000);
    expect(getProduct(env.db, pipe.id, true).qty).toBe(97_500);
    const m = listMovements(env.db, { productId: hammer.id, type: 'SALE', page: 1, pageSize: 5 }, true).rows[0]!;
    expect(m).toMatchObject({ qtyChange: -2000, refType: 'INVOICE', refId: String(r.invoiceId) });

    expect(accountBalance(env.db, 'CASH')).toBe(103800);
expect(accountBalance(env.db, 'ROUND_OFF')).toBe(-50);
    expect(accountBalance(env.db, 'AR', { type: 'CUSTOMER', id: walkIn })).toBe(0);
    expect(accountBalance(env.db, 'SALES')).toBe(-(76271 + 11653));
    expect(accountBalance(env.db, 'COGS')).toBe(71625);
    expect(listAudit(env.db, { page: 1, pageSize: 5, entityType: 'invoice', entityId: String(r.invoiceId) }).rows[0]!.action).toBe('CREATE');
    healthy();
  });

  it('never creates the same invoice twice for a repeated request', () => {
    const requestId = randomUUID();
    const a = sale(walkIn, [{ p: hammer, qty: 1000 }], { requestId, pay: [{ methodId: cash, amount: 45000 }] });
    const b = sale(walkIn, [{ p: hammer, qty: 1000 }], { requestId, pay: [{ methodId: cash, amount: 45000 }] });
    expect(b).toEqual(a);
    expect(listInvoices(env.db, { status: 'ALL', page: 1, pageSize: 10 }, today()).total).toBe(1);
    expect(getProduct(env.db, hammer.id, true).qty).toBe(19_000);
    expect(accountBalance(env.db, 'CASH')).toBe(45000);
  });

  it('requires walk-in sales to be paid in full', () => {
    expect(() => sale(walkIn, [{ p: hammer, qty: 1000 }], { pay: [{ methodId: cash, amount: 40000 }] })).toThrow(/paid in full/);
    expect(getProduct(env.db, hammer.id, true).qty).toBe(20_000);
  });

  it('refuses a sale beyond available stock and leaves nothing behind', () => {
    expect(() => sale(walkIn, [{ p: hammer, qty: 15_000 }, { p: hammer, qty: 6_000 }], { pay: [{ methodId: cash, amount: 945000 }] })).toThrow(
      /Not enough stock of Claw hammer/,
    );
    expect(listInvoices(env.db, { status: 'ALL', page: 1, pageSize: 10 }, today()).total).toBe(0);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM doc_sequences WHERE doc_type = ?').get('INVOICE')).toEqual({ n: 0 });
    healthy();
  });

  it('allows an authorised negative-stock sale only with the setting, permission and a reason', () => {
    const c = customer('Builder');
    expect(() => sale(c.id, [{ p: hammer, qty: 21_000 }], { negativeStockReason: 'Stock arriving today' })).toThrow(/Not enough stock/);
    transact(env, actor, (tx) => updateSettingsSection(tx, 'stock', { allowNegativeOverride: true }));
    expect(() =>
      sale(c.id, [{ p: hammer, qty: 21_000 }], { negativeStockReason: 'Stock arriving today', perms: { ...SALES_STAFF } }),
    ).toThrow(/Not enough stock/);
    const r = sale(c.id, [{ p: hammer, qty: 21_000 }], { negativeStockReason: 'Stock arriving today' });
    expect(getProduct(env.db, hammer.id, true).qty).toBe(-1000);
    expect(listMovements(env.db, { productId: hammer.id, type: 'SALE', page: 1, pageSize: 5 }, true).rows[0]!.negativeOverride).toBe(true);
    expect(listAudit(env.db, { page: 1, pageSize: 5, action: 'NEGATIVE_STOCK_OVERRIDE' }).rows[0]!.reason).toBe('Stock arriving today');
    expect(r.outstanding).toBeGreaterThan(0);
    healthy();
  });

  it('refuses a sale if the price changed after the bill was built', () => {
    const stale = { ...hammer };
    updateProduct(env, actor, { ...hammer, purchasePrice: hammer.purchasePrice ?? 0, sellingPrice: 47500, version: hammer.version }, true);
    expect(() => sale(walkIn, [{ p: stale, qty: 1000 }], { pay: [{ methodId: cash, amount: 45000 }] })).toThrow(/price of Claw hammer changed/);
  });

  it('refuses a total that does not match the calculation', () => {
    expect(() => sale(walkIn, [{ p: hammer, qty: 1000 }], { expectedGrandTotal: 40000, pay: [{ methodId: cash, amount: 40000 }] })).toThrow(
      /bill total is/,
    );
  });

  it('keeps historical invoice prices when the product price changes', () => {
    const r = sale(walkIn, [{ p: hammer, qty: 1000 }], { pay: [{ methodId: cash, amount: 45000 }] });
    updateProduct(env, actor, { ...hammer, purchasePrice: hammer.purchasePrice ?? 0, sellingPrice: 50000, version: hammer.version }, true);
    expect(inv(r.invoiceId).lines[0]!.unitPrice).toBe(45000);
    expect(inv(r.invoiceId).grandTotal).toBe(45000);
  });

  it('cannot alter or delete issued invoices and payments', () => {
    sale(walkIn, [{ p: hammer, qty: 1000 }], { pay: [{ methodId: cash, amount: 45000 }] });
    expect(() => env.db.prepare('UPDATE invoices SET grand_total = 1').run()).toThrow(/IMMUTABLE/);
    expect(() => env.db.prepare('DELETE FROM invoice_lines').run()).toThrow(/IMMUTABLE/);
    expect(() => env.db.prepare('UPDATE payments SET amount = 1').run()).toThrow(/IMMUTABLE/);
    expect(() => env.db.prepare('DELETE FROM allocations').run()).toThrow(/IMMUTABLE/);
  });
});

describe('discounts and tax', () => {
  it('applies discounts within the role limit and refuses larger ones', () => {
    const r = sale(walkIn, [{ p: hammer, qty: 2000, discount: { type: 'PERCENT', valueBp: 500 } }], {
      perms: SALES_STAFF,
      pay: [{ methodId: cash, amount: 85500 }],
    });
    expect(inv(r.invoiceId)).toMatchObject({ discountTotal: 4500, grandTotal: 85500 });
    expect(() =>
      sale(walkIn, [{ p: hammer, qty: 1000, discount: { type: 'AMOUNT', value: 5000 } }], { perms: SALES_STAFF, pay: [{ methodId: cash, amount: 40000 }] }),
    ).toThrow(/above your limit of 5%/);
    expect(() =>
      sale(walkIn, [{ p: hammer, qty: 1000 }], {
        perms: { permissions: ['sales.create'], maxDiscountBp: 0 },
        billDiscount: { type: 'AMOUNT', value: 100 },
        pay: [{ methodId: cash, amount: 44900 }],
      }),
    ).toThrow(/permission to give discounts/);
  });

  it('charges IGST for a customer in another state', () => {
    const outOfState = customer('Goa Builders', '30');
    const r = sale(outOfState.id, [{ p: hammer, qty: 1000 }], { interstate: true });
    expect(inv(r.invoiceId)).toMatchObject({ isInterstate: true, cgstTotal: 0, sgstTotal: 0, igstTotal: 6864 });
    expect(accountBalance(env.db, 'OUTPUT_IGST')).toBe(-6864);
  });
});

describe('credit sales and payments', () => {
  it('records partial payment, due date, overdue status and later payments', () => {
    const c = customer('Ramesh Builders');
    const r = sale(c.id, [{ p: hammer, qty: 4000 }], { pay: [{ methodId: upi, amount: 50000 }] });
    let i = inv(r.invoiceId);
    expect(i).toMatchObject({ status: 'PARTIAL', outstanding: 130000, dueDate: '2026-11-05', overdue: false });
    expect(cust(c.id)).toMatchObject({ balance: 130000, outstanding: 130000 });

    env.clock.set('2026-11-20T05:00:00.000Z');
    expect(inv(r.invoiceId).overdue).toBe(true);
    expect(listReceivables(env.db, { filter: 'OVERDUE', page: 1, pageSize: 10 }, today()).rows[0]).toMatchObject({ docNo: i.invoiceNo, daysOverdue: 15 });

    receivePayment(env, actor, { requestId: randomUUID(), customerId: c.id, amount: 30000, methodId: cash, reference: '', notes: '', allocations: [] });
    receivePayment(env, actor, { requestId: randomUUID(), customerId: c.id, amount: 100000, methodId: cash, reference: 'final', notes: '', allocations: [] });
    i = inv(r.invoiceId);
    expect(i.status).toBe('PAID');
    expect(i.settlements.map((s) => s.amount)).toEqual([50000, 30000, 100000]);
    expect(cust(c.id).balance).toBe(0);
    expect(accountBalance(env.db, 'CASH')).toBe(130000);
    expect(accountBalance(env.db, 'UPI')).toBe(50000);
    healthy();
  });

  it('keeps an overpayment as advance credit and uses it on the next bill', () => {
    const c = customer('Advance Payer');
    receivePayment(env, actor, { requestId: randomUUID(), customerId: c.id, amount: 100000, methodId: cash, reference: '', notes: 'Advance', allocations: [] });
    expect(cust(c.id)).toMatchObject({ balance: -100000, availableCredit: 100000 });
    const r = sale(c.id, [{ p: hammer, qty: 1000 }], { useCredit: 45000 });
    expect(inv(r.invoiceId).status).toBe('PAID');
    expect(cust(c.id)).toMatchObject({ balance: -55000, availableCredit: 55000 });
    expect(() => sale(c.id, [{ p: hammer, qty: 2000 }], { useCredit: 90000 })).toThrow(/more than the bill total|Only/);
    healthy();
  });

  it('settles chosen bills first, then the oldest', () => {
    const c = customer('Two Bills');
    const a = sale(c.id, [{ p: hammer, qty: 1000 }]);
    env.clock.advanceMinutes(60 * 24);
    const b = sale(c.id, [{ p: hammer, qty: 1000 }]);
    receivePayment(env, actor, {
      requestId: randomUUID(),
      customerId: c.id,
      amount: 50000,
      methodId: cash,
      reference: '',
      notes: '',
      allocations: [{ docType: 'INVOICE', docId: b.invoiceId, amount: 45000 }],
    });
    expect(inv(b.invoiceId).status).toBe('PAID');
    expect(inv(a.invoiceId)).toMatchObject({ status: 'PARTIAL', outstanding: 40000 });
    healthy();
  });

  it('collects an opening balance before newer bills', () => {
    const c = customer('Old Customer');
    adjustBalance(env, actor, { requestId: randomUUID(), customerId: c.id, kind: 'OPENING', amount: 20000, reason: 'Balance from old ledger book' });
    const r = sale(c.id, [{ p: hammer, qty: 1000 }]);
    receivePayment(env, actor, { requestId: randomUUID(), customerId: c.id, amount: 30000, methodId: cash, reference: '', notes: '', allocations: [] });
    expect(listReceivables(env.db, { customerId: c.id, filter: 'ALL', page: 1, pageSize: 10 }, today()).rows).toEqual([
      expect.objectContaining({ docId: r.invoiceId, outstanding: 35000 }),
    ]);
    const ledger = customerLedger(env.db, c.id, {}, today());
    expect(ledger.rows.map((x) => x.description)).toEqual([
      'Opening balance: Balance from old ledger book',
      'Sale invoice',
      'Payment received',
    ]);
    expect(ledger.closingBalance).toBe(35000);
    healthy();
  });

  it('reverses a payment and reopens what it settled', () => {
    const c = customer('Bounced Cheque');
    const r = sale(c.id, [{ p: hammer, qty: 1000 }]);
    const p = receivePayment(env, actor, { requestId: randomUUID(), customerId: c.id, amount: 45000, methodId: cash, reference: 'CHQ 1234', notes: '', allocations: [] });
    expect(inv(r.invoiceId).status).toBe('PAID');
    const reversed = reversePayment(env, actor, { id: p.id, reason: 'Cheque bounced' });
    expect(reversed.reversal?.reason).toBe('Cheque bounced');
    expect(inv(r.invoiceId).status).toBe('UNPAID');
    expect(cust(c.id).balance).toBe(45000);
    expect(() => reversePayment(env, actor, { id: p.id, reason: 'Again' })).toThrow(/already been reversed/);
    healthy();
  });

  it('does not record the same payment twice', () => {
    const c = customer('Double Click');
    const requestId = randomUUID();
    const input = { requestId, customerId: c.id, amount: 10000, methodId: cash, reference: '', notes: '', allocations: [] };
    receivePayment(env, actor, input);
    receivePayment(env, actor, input);
    expect(accountBalance(env.db, 'CASH')).toBe(10000);
  });

  it('refunds account credit and blocks reversing a payment whose credit was refunded', () => {
    const c = customer('Refund Me');
    const p = receivePayment(env, actor, { requestId: randomUUID(), customerId: c.id, amount: 20000, methodId: cash, reference: '', notes: '', allocations: [] });
    expect(() =>
      refundCustomer(env, actor, { requestId: randomUUID(), customerId: c.id, amount: 30000, methodId: cash, reference: '', reason: 'Too much' }),
    ).toThrow(/Only ₹200.00/);
    const refund = refundCustomer(env, actor, { requestId: randomUUID(), customerId: c.id, amount: 15000, methodId: cash, reference: '', reason: 'Customer asked' });
    expect(refund.direction).toBe('OUT');
    expect(cust(c.id)).toMatchObject({ balance: -5000, availableCredit: 5000 });
    expect(accountBalance(env.db, 'CASH')).toBe(5000);
    expect(() => reversePayment(env, actor, { id: p.id, reason: 'x' })).toThrow(/Reverse the refund first/);
    reversePayment(env, actor, { id: refund.id, reason: 'Refund entered by mistake' });
    expect(cust(c.id).availableCredit).toBe(20000);
    healthy();
  });

  it('reports ageing buckets and totals', () => {
    const c = customer('Ageing');
    sale(c.id, [{ p: hammer, qty: 1000 }]);
    env.clock.set('2027-01-15T05:00:00.000Z');
    sale(c.id, [{ p: hammer, qty: 1000 }]);
    const report = ageingReport(env.db, today());
    expect(report.bucketLabels).toEqual(['0–30 days', '31–60 days', '61–90 days', 'Over 90 days']);
    expect(report.rows[0]!.buckets).toEqual([45000, 0, 45000, 0]);
    expect(receivablesSummary(env.db, today())).toMatchObject({ outstanding: 90000, customersOwing: 1 });
  });
});

describe('cancellations and returns', () => {
  it('cancels a walk-in sale: stock back at the same cost, revenue reversed, money handed back', () => {
    const r = sale(walkIn, [{ p: hammer, qty: 2000 }], { pay: [{ methodId: cash, amount: 90000 }] });
    const valueBefore = getProduct(env.db, hammer.id, true).stockValue;
    cancelInvoice(env, actor, { id: r.invoiceId, reason: 'Customer changed mind', requestId: randomUUID() });
    const i = inv(r.invoiceId);
    expect(i).toMatchObject({ status: 'CANCELLED', outstanding: 0 });
    expect(i.cancellation?.reason).toBe('Customer changed mind');
    expect(getProduct(env.db, hammer.id, true)).toMatchObject({ qty: 20_000 });
    expect(getProduct(env.db, hammer.id, true).stockValue).toBe((valueBefore ?? 0) + 62000);
    expect(accountBalance(env.db, 'SALES')).toBe(0);
    expect(accountBalance(env.db, 'COGS')).toBe(0);
    expect(accountBalance(env.db, 'CASH')).toBe(0);
    expect(() => cancelInvoice(env, actor, { id: r.invoiceId, reason: 'Again', requestId: randomUUID() })).toThrow(/already cancelled/);
    healthy();
  });

  it('turns payments on a cancelled credit-customer invoice into account credit', () => {
    const c = customer('Cancel Credit');
    const r = sale(c.id, [{ p: hammer, qty: 1000 }], { pay: [{ methodId: upi, amount: 20000 }] });
    cancelInvoice(env, actor, { id: r.invoiceId, reason: 'Wrong item billed', requestId: randomUUID() });
    expect(cust(c.id)).toMatchObject({ balance: -20000, availableCredit: 20000, outstanding: 0 });
    healthy();
  });

  it('processes a return with a credit note that reduces the open amount', () => {
    const c = customer('Return Partial');
    const r = sale(c.id, [{ p: hammer, qty: 3000 }]);
    const line = inv(r.invoiceId).lines[0]!;
    const cn = createCreditNote(env, actor, {
      requestId: randomUUID(),
      invoiceId: r.invoiceId,
      lines: [{ invoiceLineId: line.id, qty: 1000, restock: true }],
      reason: 'Wrong size',
      settlement: 'CREDIT',
    });
    expect(cn).toMatchObject({ creditNoteNo: 'CN/2026-27/00001', total: 45000 });
    expect(inv(r.invoiceId)).toMatchObject({ outstanding: 90000, status: 'PARTIAL' });
    expect(inv(r.invoiceId).lines[0]!.returnedQty).toBe(1000);
    expect(getProduct(env.db, hammer.id, true).qty).toBe(18_000);
    expect(accountBalance(env.db, 'SALES_RETURNS')).toBe(38136);
    healthy();
  });

  it('refunds a paid walk-in return and returns parts of a line exactly', () => {
    const r = sale(walkIn, [{ p: pipe, qty: 3000 }], { pay: [{ methodId: cash, amount: 16500 }] });
    const line = inv(r.invoiceId).lines[0]!;
    expect(() =>
      createCreditNote(env, actor, { requestId: randomUUID(), invoiceId: r.invoiceId, lines: [{ invoiceLineId: line.id, qty: 1000, restock: true }], reason: 'Extra', settlement: 'CREDIT' }),
    ).toThrow(/refund the money/);
    for (let i = 0; i < 3; i++) {
      createCreditNote(env, actor, {
        requestId: randomUUID(),
        invoiceId: r.invoiceId,
        lines: [{ invoiceLineId: line.id, qty: 1000, restock: i < 2 }],
        reason: i < 2 ? 'Not needed' : 'Damaged piece',
        settlement: 'REFUND',
        refundMethodId: cash,
      });
    }
    expect(() =>
      createCreditNote(env, actor, { requestId: randomUUID(), invoiceId: r.invoiceId, lines: [{ invoiceLineId: line.id, qty: 1, restock: false }], reason: 'More', settlement: 'REFUND', refundMethodId: cash }),
    ).toThrow(/Only 0 of PVC pipe/);
    const total = (env.db.prepare('SELECT SUM(total) AS t FROM credit_notes').get() as { t: number }).t;
    expect(total).toBe(inv(r.invoiceId).grandTotal - inv(r.invoiceId).roundOff);
    expect(accountBalance(env.db, 'CASH')).toBe(inv(r.invoiceId).roundOff);
    // Two metres went back on the shelf; the damaged one did not.
    expect(getProduct(env.db, pipe.id, true).qty).toBe(99_000);
    expect(() => cancelInvoice(env, actor, { id: r.invoiceId, reason: 'x', requestId: randomUUID() })).toThrow(/has returns/);
    healthy();
  });
});

describe('customers', () => {
  it('reports credit balances and blocks walk-in balances', () => {
    expect(() => adjustBalance(env, actor, { requestId: randomUUID(), customerId: walkIn, kind: 'ADJUSTMENT', amount: 100, reason: 'Test' })).toThrow(
      /walk-in/,
    );
    const c = customer('Credit Note Holder');
    adjustBalance(env, actor, { requestId: randomUUID(), customerId: c.id, kind: 'ADJUSTMENT', amount: -5000, reason: 'Goodwill credit' });
    expect(cust(c.id)).toMatchObject({ balance: -5000, availableCredit: 5000 });
    const r = sale(c.id, [{ p: hammer, qty: 1000 }]);
    // Credit is used automatically only when chosen at the counter; existing credit stays available.
    expect(inv(r.invoiceId).outstanding).toBe(45000);
    expect(cust(c.id).balance).toBe(40000);
    healthy();
  });
});

describe('printable documents', () => {
  it('renders invoice, receipt, credit note and statement without scripts', async () => {
    const { renderDocument } = await import('@main/print/documents');
    const c = customer('Print Customer');
    const r = sale(c.id, [{ p: hammer, qty: 2000 }], { pay: [{ methodId: upi, amount: 50000 }] });
    const line = inv(r.invoiceId).lines[0]!;
    const cn = createCreditNote(env, actor, {
      requestId: randomUUID(),
      invoiceId: r.invoiceId,
      lines: [{ invoiceLineId: line.id, qty: 1000, restock: true }],
      reason: 'Spare not needed',
      settlement: 'CREDIT',
    });
    const a4 = renderDocument(env.db, 'INVOICE', r.invoiceId, 'A4', today()).html;
    expect(a4).toContain('TAX INVOICE');
    expect(a4).toContain('INV/2026-27/00001');
    expect(a4).toContain('Rupees Nine Hundred Only');
    expect(a4).toContain('Intra-state supply');
    const receipt = renderDocument(env.db, 'RECEIPT', r.invoiceId, 'THERMAL_58', today()).html;
    expect(receipt).toContain('58mm');
    const note = renderDocument(env.db, 'CREDIT_NOTE', cn.creditNoteId, 'A4', today()).html;
    expect(note).toContain('CREDIT NOTE');
    const statement = renderDocument(env.db, 'STATEMENT', c.id, 'A4', today()).html;
    expect(statement).toContain('STATEMENT OF ACCOUNT');
    expect(statement).toContain('Print Customer');
    for (const html of [a4, receipt, note, statement]) expect(html).not.toMatch(/<script/i);
    // Customer-entered text is escaped.
    const evil = customer('<img src=x onerror=alert(1)>');
    expect(renderDocument(env.db, 'STATEMENT', evil.id, 'A4', today()).html).not.toContain('<img src=x');
  });
});
