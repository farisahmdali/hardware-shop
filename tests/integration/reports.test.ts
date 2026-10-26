import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDispatcher } from '@main/ipc/dispatcher';
import { reportHandlers } from '@main/ipc/reportHandlers';
import type { DesktopUi } from '@main/ipc/systemHandlers';
import { inProcessRunner } from '@main/reports/runner';
import { runReport, hasReportImpl } from '@main/reports';
import { reportToCsv, reportToHtml, reportToXlsx } from '@main/reports/export';
import { buildSession, createUser, listRoles } from '@main/services/auth';
import { listAudit } from '@main/services/audit';
import { accountBalance, type AccountCode } from '@main/services/ledger';
import { createProduct } from '@main/services/products';
import { createCustomer, walkInCustomerId } from '@main/services/customers';
import { cancelInvoice, createCreditNote, finalizeSale, getInvoice } from '@main/services/sales';
import { listPaymentMethods, receivePayment } from '@main/services/payments';
import { createRentalProduct } from '@main/services/rentalCatalog';
import { createRental, getRental, quoteRental, returnItems, settleDeposit } from '@main/services/rentals';
import { createSupplier } from '@main/services/suppliers';
import { createPurchase, createSupplierReturn, getPurchase } from '@main/services/purchases';
import { paySupplier } from '@main/services/supplierPayments';
import { createExpense, listExpenseCategories } from '@main/services/expenses';
import { addCashEntry, countCash, expectedCash } from '@main/services/cash';
import { dashboardPeriod, dashboardRecent } from '@main/services/dashboard';
import { runIntegrityChecks } from '@main/services/integrity';
import { getAllSettings } from '@main/services/settings';
import { computeBill, type Discount } from '@shared/billing';
import { claimsInputGst, computePurchase } from '@shared/purchasing';
import { ALL_PERMISSIONS, type Permission } from '@shared/permissions';
import { REPORTS, canRunReport, reportDef, type ReportResult } from '@shared/reports';
import { businessDateOf } from '@shared/time';
import type { Result } from '@shared/errors';
import { actorOf, createTestEnv, setupOwner, type TestEnv } from '../helpers';

let env: TestEnv;
let actor: { userId: number | null; username: string | null };
let hammer: number;
let ramesh: number;
let supplier: number;
let cash: number;
let upi: number;
const OWNER = { permissions: ALL_PERMISSIONS, maxDiscountBp: 10_000 };
const rupees = (r: number) => r * 100;
const units = (n: number) => n * 1000;
const today = () => businessDateOf(env.clock.now(), env.timeZone);
const D = 86_400_000;
const at = (ms: number) => new Date(env.clock.now().getTime() + ms).toISOString();
const bal = (code: AccountCode) => accountBalance(env.db, code);
const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };

function run(id: string, params: Record<string, unknown> = {}, permissions: readonly Permission[] = ALL_PERMISSIONS, limit?: number): ReportResult {
  return runReport(env.db, id, { ...OCTOBER, ...params }, { today: today(), nowIso: env.clock.now().toISOString(), permissions, limit });
}

const summary = (r: ReportResult, label: string) => r.summary.find((s) => s.label === label)!.value;

function sell(customerId: number, qty: number, opts: { pay?: number; discount?: Discount } = {}) {
  const bill = computeBill([{ unitPrice: rupees(450), qty: units(qty), gstRateBp: 1800, priceIncludesTax: true, discount: opts.discount ?? null }], {
    interstate: false,
    gstRegistered: true,
    roundTotal: true,
  });
  return finalizeSale(env, actor, OWNER, {
    requestId: randomUUID(),
    customerId,
    walkInName: '',
    walkInPhone: '',
    lines: [{ productId: hammer, qty: units(qty), discount: opts.discount ?? null, expectedUnitPrice: rupees(450) }],
    billDiscount: null,
    payments: opts.pay === undefined ? [{ methodId: cash, amount: bill.grandTotal, reference: '' }] : opts.pay ? [{ methodId: cash, amount: opts.pay, reference: '' }] : [],
    useCredit: 0,
    notes: '',
    expectedGrandTotal: bill.grandTotal,
  });
}

function buy(qty: number, cost: number, pay = 0) {
  const settings = getAllSettings(env.db);
  const lines = [{ productId: hammer, qty: units(qty), unitCost: cost, gstRateBp: 1800, discount: null }];
  const calc = computePurchase(lines, {
    pricesIncludeTax: false,
    interstate: false,
    billDiscount: null,
    additionalCosts: rupees(60),
    roundOff: 0,
    itcClaimed: claimsInputGst({ claimInputGst: settings.purchases.claimInputGst, gstRegistered: settings.tax.gstRegistered }, '27AAPFU0939F1ZV'),
  });
  return createPurchase(env, actor, {
    requestId: randomUUID(),
    supplierId: supplier,
    supplierInvoiceNo: `PT-${randomUUID().slice(0, 4)}`,
    supplierInvoiceDate: today(),
    pricesIncludeTax: false,
    lines,
    billDiscount: null,
    additionalCosts: rupees(60),
    additionalCostsNote: 'Freight',
    roundOff: 0,
    notes: '',
    payments: pay ? [{ methodId: cash, amount: pay, reference: '' }] : [],
    updatePurchasePrices: true,
    expectedGrandTotal: calc.grandTotal,
  });
}

/** A month of shop activity touching every module, so every report has something to show. */
function buildShop() {
  hammer = createProduct(
    env,
    actor,
    {
      requestId: randomUUID(),
      sku: '',
      name: 'Claw hammer 450 g',
      categoryId: null,
      brandId: null,
      unitId: (env.db.prepare("SELECT id FROM units WHERE code = 'PCS'").get() as { id: number }).id,
      description: '',
      hsnCode: '8205',
      gstRateBp: 1800,
      priceIncludesTax: true,
      purchasePrice: rupees(310),
      sellingPrice: rupees(450),
      minStockQty: units(5),
      preferredSupplierId: null,
      notes: '',
      openingQty: units(20),
    },
    true,
  ).id;
  ramesh = createCustomer(env, actor, {
    requestId: randomUUID(),
    name: 'Ramesh Builders',
    phone: '9822012345',
    address: '',
    businessName: '',
    gstin: '',
    stateCode: '',
    creditDays: 15,
    creditLimit: 0,
    notes: '',
    openingBalance: 0,
  }).id;
  supplier = createSupplier(env, actor, {
    requestId: randomUUID(),
    name: 'Pune Tools Distributors',
    phone: '',
    address: '',
    businessName: '',
    gstin: '27AAPFU0939F1ZV',
    stateCode: '27',
    creditDays: 30,
    notes: '',
    openingBalance: 0,
  }).id;

  // Purchases and a supplier return.
  const purchase = buy(10, rupees(300), rupees(1000));
  createSupplierReturn(env, actor, {
    requestId: randomUUID(),
    purchaseId: purchase.purchaseId,
    lines: [{ purchaseLineId: getPurchase(env.db, purchase.purchaseId, today()).lines[0]!.id, qty: units(1) }],
    reason: 'Cracked handle',
    settlement: 'ADJUST',
    reference: '',
  });
  paySupplier(env, actor, { requestId: randomUUID(), supplierId: supplier, amount: rupees(500), methodId: upi, reference: '', notes: '', allocations: [] });

  // Sales: a cash sale, a discounted credit sale with a return, a cancelled sale, a payment.
  sell(walkInCustomerId(env.db), 2);
  const credit = sell(ramesh, 3, { pay: 0, discount: { type: 'PERCENT', valueBp: 1000 } });
  createCreditNote(env, actor, {
    requestId: randomUUID(),
    invoiceId: credit.invoiceId,
    lines: [{ invoiceLineId: getInvoice(env.db, credit.invoiceId, true, today()).lines[0]!.id, qty: units(1), restock: true }],
    reason: 'Wrong size',
    settlement: 'CREDIT',
  });
  const mistake = sell(walkInCustomerId(env.db), 1);
  cancelInvoice(env, actor, { id: mistake.invoiceId, reason: 'Billed twice', requestId: randomUUID() });
  receivePayment(env, actor, { requestId: randomUUID(), customerId: ramesh, amount: rupees(300), methodId: upi, reference: '', notes: '', allocations: [] });

  // Rentals: one returned late and damaged with the deposit settled, one still out with its deposit held.
  const drillId = createRentalProduct(env, actor, {
    requestId: randomUUID(),
    name: 'Impact drill 13 mm',
    categoryId: null,
    brand: 'Bosch',
    model: '',
    description: '',
    depositAmount: rupees(2000),
    sacCode: '997319',
    gstRateBp: 1800,
    priceIncludesTax: true,
    notes: '',
    rates: [{ unit: 'DAY', label: '', price: rupees(300) }],
    units: 2,
    serials: ['SN-1', 'SN-2'],
    purchaseCost: rupees(4500),
    purchaseDate: '2026-01-10',
  });
  const assets = env.db.prepare('SELECT id FROM rental_assets WHERE rental_product_id = ? ORDER BY id').all(drillId) as { id: number }[];
  const rent = (assetId: number, deposit: number) => {
    const quote = quoteRental(env.db, { customerId: ramesh, assetIds: [assetId], expectedReturnAt: at(2 * D), reserve: false, discount: null }, env.clock.now().toISOString());
    return createRental(env, actor, OWNER, {
      requestId: randomUUID(),
      customerId: ramesh,
      assetIds: [assetId],
      reserve: false,
      expectedReturnAt: at(2 * D),
      discount: null,
      expectedChargesTotal: quote.billNow.grandTotal,
      deposit: { amount: deposit, methodId: cash, reference: '' },
      payments: [],
      notes: '',
      terms: '',
      saleLines: [],
      expectedSaleTotal: 0,
    });
  };
  const first = rent(assets[0]!.id, rupees(2000));
  rent(assets[1]!.id, rupees(1000));
  env.clock.set('2026-10-24T06:00:00.000Z');
  const r = getRental(env.db, first.id, env.clock.now().toISOString());
  returnItems(env, actor, OWNER, {
    requestId: randomUUID(),
    id: first.id,
    version: r.version,
    payments: [],
    items: [
      { itemId: r.items[0]!.id, condition: 'DAMAGED', notes: '', nextStatus: 'DAMAGED', damageCharge: rupees(500), damageReason: 'Chuck broken', lateFeeReason: '' },
    ],
  });
  const owed = getRental(env.db, first.id, env.clock.now().toISOString()).outstanding;
  settleDeposit(env, actor, OWNER, { requestId: randomUUID(), id: first.id, applyAmount: owed, applyReason: 'Charges', refundAmount: rupees(2000) - owed, refundMethodId: cash, refundReference: '' });

  // Expenses and cash.
  const rent2 = listExpenseCategories(env.db, false).find((c) => c.name === 'Shop rent')!.id;
  createExpense(env, actor, { requestId: randomUUID(), categoryId: rent2, description: 'October rent', amount: rupees(5000), expenseDate: today(), methodId: cash, payee: '', reference: '', notes: '' });
  addCashEntry(env, actor, { requestId: randomUUID(), type: 'CASH_IN', amount: rupees(10_000), reason: 'Float' });
  countCash(env, actor, { requestId: randomUUID(), counted: expectedCash(env.db) - rupees(10), denominations: null, note: 'Change mistake' });
}

beforeEach(() => {
  env = createTestEnv();
  actor = actorOf(setupOwner(env));
  const methods = listPaymentMethods(env.db, false);
  cash = methods.find((m) => m.kind === 'CASH')!.id;
  upi = methods.find((m) => m.kind === 'UPI')!.id;
  buildShop();
  expect(runIntegrityChecks(env.db).issues).toEqual([]);
});

afterEach(() => env.cleanup());

const total = (r: ReportResult, key: string) => r.totals![key] as number;

describe('report catalogue', () => {
  it('runs every report, and every cell belongs to a column', () => {
    for (const def of REPORTS) {
      expect(hasReportImpl(def.id), def.id).toBe(true);
      const r = run(def.id, { customerId: def.requires === 'customer' ? ramesh : undefined, supplierId: def.requires === 'supplier' ? supplier : undefined });
      const keys = new Set(r.columns.map((c) => c.key));
      for (const row of r.rows) for (const k of Object.keys(row.cells)) expect(keys.has(k), `${def.id}: ${k}`).toBe(true);
      if (r.totals) for (const k of Object.keys(r.totals)) expect(keys.has(k), `${def.id} totals: ${k}`).toBe(true);
      expect(r.title).toBe(def.title);
      expect(r.truncated).toBe(false);
    }
  });

  it('applies the default period, refuses a missing customer, and marks cut-off results', () => {
    const r = runReport(env.db, 'sales.byPeriod', {}, { today: today(), nowIso: env.clock.now().toISOString(), permissions: ALL_PERMISSIONS });
    expect(r.subtitle).toMatch(/^01 Oct 2026 – 24 Oct 2026/);
    expect(r.rows).toHaveLength(24);
    expect(() => run('parties.customerStatement')).toThrow(/Choose a customer/);
    const cut = run('stock.movements', {}, ALL_PERMISSIONS, 2);
    expect(cut.truncated).toBe(true);
    expect(cut.rows).toHaveLength(2);
    expect(cut.notes[0]).toMatch(/Only the first 2 rows/);
  });

  it('decides who may run what', () => {
    const can = (id: string, perms: Permission[]) => canRunReport(reportDef(id)!, perms);
    const sales: Permission[] = ['sales.create', 'reports.view'];
    const inventory: Permission[] = ['products.manage', 'stock.adjust', 'purchases.manage', 'reports.view'];
    expect(can('sales.byProduct', sales)).toBe(true);
    expect(can('finance.income', sales)).toBe(false);
    expect(can('stock.valuation', sales)).toBe(false);
    expect(can('stock.valuation', inventory)).toBe(true);
    expect(can('stock.purchases', inventory)).toBe(true);
    expect(can('finance.expenses', ['expenses.manage'])).toBe(true);
    expect(can('finance.cash', ['cash.reconcile'])).toBe(true);
    expect(can('finance.income', ['expenses.manage', 'cash.reconcile'])).toBe(false);
    expect(REPORTS.every((d) => canRunReport(d, ['reports.financial']))).toBe(true);
  });

  it('hides costs and profit from users who may not see them', () => {
    const viewer: Permission[] = ['reports.view'];
    expect(run('sales.byProduct', {}, viewer).columns.map((c) => c.key)).not.toContain('cost');
    expect(run('sales.byProduct').columns.map((c) => c.key)).toContain('profit');
    expect(run('stock.levels', {}, viewer).columns.map((c) => c.key)).not.toContain('value');
    expect(run('stock.movements', {}, viewer).columns.map((c) => c.key)).not.toContain('value');
  });
});

describe('reports agree with the books', () => {
  it('stock valuation equals the inventory account', () => {
    const r = run('stock.valuation', { to: today() });
    expect(total(r, 'value')).toBe(bal('INVENTORY'));
    expect(summary(r, 'Stock value at cost')).toBe(bal('INVENTORY'));
  });

  it('a past valuation uses the stock as it was on that day', () => {
    const r = run('stock.valuation', { to: '2026-10-20' });
    expect(r.rows).toHaveLength(0);
  });

  it('the income summary matches the income and expense accounts', () => {
    const r = run('finance.income');
    const revenue = -(bal('SALES') + bal('SALES_RETURNS') + bal('RENTAL_INCOME') + bal('LATE_FEE_INCOME') + bal('DAMAGE_INCOME'));
    expect(summary(r, 'Revenue')).toBe(revenue);
    expect(summary(r, 'Gross profit')).toBe(revenue - bal('COGS'));
    const running = bal('OPERATING_EXPENSES') + bal('INVENTORY_LOSS') + bal('CASH_OVER_SHORT') + bal('BALANCE_ADJUSTMENTS') + bal('ROUND_OFF');
    expect(summary(r, 'Running costs')).toBe(running);
    expect(summary(r, 'Estimated net profit')).toBe(revenue - bal('COGS') - running);
    expect(r.rows.find((x) => x.cells.item === 'Operating expenses')?.cells.amount).toBe(rupees(5000));
  });

  it('gross profit by product matches sales revenue and cost of goods sold', () => {
    const r = run('finance.grossProfit');
    expect(total(r, 'netTaxable')).toBe(-(bal('SALES') + bal('SALES_RETURNS')));
    expect(total(r, 'cost')).toBe(bal('COGS'));
    expect(run('finance.grossProfit', { option: 'CATEGORY' }).totals!.profit).toBe(total(r, 'profit'));
    expect(run('finance.monthly').totals!.cogs).toBe(bal('COGS'));
  });

  it('sales by period agree with the dashboard and leave out the cancelled bill', () => {
    const r = run('sales.byPeriod');
    const d = dashboardPeriod(env.db, OCTOBER.from, OCTOBER.to, ALL_PERMISSIONS);
    expect(total(r, 'net')).toBe(d.sales.total);
    expect(total(r, 'invoices')).toBe(2);
    expect(total(r, 'cancelled')).toBe(1);
    expect(total(r, 'returns')).toBe(d.sales.returns);
    expect(run('sales.cancelled').rows[0]?.cells.reason).toBe('Billed twice');
    expect(run('sales.discounts').rows).toHaveLength(1);
    expect(run('sales.byCustomer').rows.map((x) => x.cells.customer)).toEqual(expect.arrayContaining(['Walk-in customers', 'Ramesh Builders']));
  });

  it('rental income by period, by item and in the accounts are the same', () => {
    const income = -(bal('RENTAL_INCOME') + bal('LATE_FEE_INCOME') + bal('DAMAGE_INCOME'));
    expect(total(run('rentals.revenueByPeriod'), 'total')).toBe(income);
    expect(total(run('rentals.revenueByItem'), 'total')).toBe(income);
    expect(total(run('rentals.revenueByItem'), 'damage')).toBe(-bal('DAMAGE_INCOME'));
    expect(run('rentals.damageCharges').rows[0]?.cells.details).toBe('Chuck broken');
    expect(run('rentals.lateFees').rows).toHaveLength(1);
    expect(run('rentals.active').rows).toHaveLength(1);
    expect(run('rentals.overdue').rows).toHaveLength(1);
    expect(run('rentals.damaged').rows).toHaveLength(1);
    expect(total(run('rentals.availability'), 'damaged')).toBe(1);
  });

  it('deposits held equal the deposit liability account', () => {
    const r = run('rentals.depositsHeld');
    expect(total(r, 'held')).toBe(-bal('DEPOSIT_LIABILITY'));
    expect(total(r, 'held')).toBe(rupees(1000));
    const moves = run('rentals.deposits');
    expect(total(moves, 'collected')).toBe(rupees(3000));
    expect(total(moves, 'collected') - total(moves, 'applied') - total(moves, 'refunded')).toBe(rupees(1000));
  });

  it('expenses, cash, payment methods and GST match their accounts', () => {
    expect(total(run('finance.expenses'), 'amount')).toBe(bal('OPERATING_EXPENSES'));
    expect(total(run('finance.expenses', { option: 'CATEGORY' }), 'amount')).toBe(bal('OPERATING_EXPENSES'));
    const cashDays = run('finance.cash', { to: today() });
    expect(cashDays.rows[cashDays.rows.length - 1]!.cells.closing).toBe(bal('CASH'));
    expect(total(cashDays, 'difference')).toBe(rupees(-10));
    const methods = run('finance.methodsDaily');
    expect(total(methods, 'net')).toBe(bal('CASH') + bal('UPI') + bal('CARD') + bal('BANK') + bal('CHEQUE'));
    const gst = run('finance.gst');
    expect(summary(gst, 'Output GST')).toBe(-(bal('OUTPUT_CGST') + bal('OUTPUT_SGST') + bal('OUTPUT_IGST')));
    expect(summary(gst, 'Input GST')).toBe(bal('INPUT_GST'));
  });

  it('customer and supplier balances match receivables and payables', () => {
    expect(total(run('parties.customerBalances'), 'balance')).toBe(bal('AR'));
    expect(total(run('parties.supplierBalances'), 'net')).toBe(-bal('AP'));
    const statement = run('parties.customerStatement', { customerId: ramesh });
    expect(statement.rows[statement.rows.length - 1]!.cells.balance).toBe(accountBalance(env.db, 'AR', { type: 'CUSTOMER', id: ramesh }));
    const supplierStatement = run('parties.supplierStatement', { supplierId: supplier });
    expect(supplierStatement.rows[supplierStatement.rows.length - 1]!.cells.balance).toBe(-bal('AP'));
    expect(total(run('sales.outstanding'), 'outstanding')).toBeGreaterThan(0);
    // Payment history leaves out reversed payments; the method summary shows them as received and then reversed.
    const methods = run('sales.byPaymentMethod');
    expect(total(run('parties.customerPayments'), 'paid')).toBe(total(methods, 'received') - total(methods, 'reversed'));
    expect(total(methods, 'reversed')).toBe(rupees(450));
  });

  it('stock reports show purchases, returns to suppliers and adjustments', () => {
    expect(run('stock.purchases').rows).toHaveLength(1);
    expect(run('stock.supplierReturns').rows[0]?.cells.reason).toBe('Cracked handle');
    expect(run('stock.adjustments').rows.map((r) => r.cells.type)).toContain('Opening stock');
    expect(run('stock.movements', { option: 'SALE' }).rows.every((r) => /Sale/.test(String(r.cells.type)))).toBe(true);
    expect(run('stock.levels').rows[0]?.cells.status).toBe('In stock');
  });
});

describe('exports', () => {
  it('writes CSV, Excel and printable pages from the same result', async () => {
    const r = run('sales.byPeriod', { groupBy: 'month' });
    const csv = reportToCsv(r);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Period,Invoices,Gross (₹)');
    expect(csv).toContain('Oct 2026,2,');
    expect(csv.trim().split('\r\n')).toHaveLength(3);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await reportToXlsx(r, 'Sharma Hardware')) as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    expect(String(ws.getCell('A1').value)).toContain('Sales by day, week or month');
    expect(ws.getRow(4).getCell(1).value).toBe('Period');
    expect(ws.getRow(5).getCell(9).value).toBe(total(r, 'net') / 100);

    const html = reportToHtml(r, { name: 'Sharma Hardware', address: [] }, true);
    expect(html).toContain('size: A4 landscape');
    expect(html).toContain('Net sales');
    expect(html).not.toMatch(/<script/i);
  });
});

describe('dashboard', () => {
  it('keeps sales, collections, deposits, expenses and profit separate, and hides what a role may not see', () => {
    const d = dashboardPeriod(env.db, OCTOBER.from, OCTOBER.to, ALL_PERMISSIONS);
    expect(d.deposits.collected).toBe(rupees(3000));
    expect(d.expenses).toBe(rupees(5000));
    expect(d.profit?.gross).toBe(summary(run('finance.income'), 'Gross profit'));
    expect(d.daily).toHaveLength(31);
    expect(d.collectedByMethod.find((m) => m.name === 'UPI')?.amount).toBe(rupees(300));
    const staff = dashboardPeriod(env.db, OCTOBER.from, OCTOBER.to, ['sales.create', 'reports.view']);
    expect(staff.profit).toBeNull();
    expect(staff.expenses).toBeNull();
    expect(staff.sales.total).toBe(d.sales.total);
  });

  it('lists recent transactions and significant changes', () => {
    const r = dashboardRecent(env.db, ALL_PERMISSIONS);
    expect(r.transactions.length).toBeGreaterThan(5);
    expect(r.transactions.map((t) => t.kind)).toEqual(expect.arrayContaining(['SALE', 'EXPENSE']));
    expect(r.changes?.some((c) => c.action === 'CANCEL' && c.reason === 'Billed twice')).toBe(true);
    expect(dashboardRecent(env.db, ['sales.create']).changes).toBeNull();
  });
});

describe('report commands', () => {
  it('refuses a report the role may not run and records the attempt', async () => {
    const sessions = new Map<number, number>();
    const ui: DesktopUi = { chooseFolder: async () => null, chooseFile: async () => null, chooseSaveFile: async () => null, openPath: async () => undefined };
    const dispatch = createDispatcher({
      env,
      handlers: reportHandlers(ui, { toPdf: async () => Buffer.from(''), print: async () => true }, inProcessRunner(() => env.db)),
      getSession: (id) => (sessions.has(id) ? buildSession(env.db, sessions.get(id)!) : null),
      setSessionUser: () => undefined,
    });
    const salesRole = listRoles(env.db).find((r) => r.code === 'SALES')!.id;
    const user = createUser(env, actor, { username: 'meena', displayName: 'Meena', roleId: salesRole, secret: '1234' });
    sessions.set(7, user.id);
    const ok = (await dispatch(7, 'reports.run', { reportId: 'sales.byProduct', params: OCTOBER })) as Result<ReportResult>;
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.data.columns.map((c) => c.key)).not.toContain('cost');
    const denied = await dispatch(7, 'reports.run', { reportId: 'finance.income', params: OCTOBER });
    expect(denied).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    const denial = listAudit(env.db, { action: 'DENIED', page: 1, pageSize: 10 }).rows[0];
    expect(denial).toMatchObject({ entityId: 'reports.run', username: 'meena' });
    expect(JSON.stringify(denial?.after)).toContain('finance.income');
    const bad = await dispatch(7, 'reports.run', { reportId: 'sales.byPeriod', params: { from: '2026-10-31', to: '2026-10-01' } });
    expect(bad).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });
});
