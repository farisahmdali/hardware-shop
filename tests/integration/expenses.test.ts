import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountBalance } from '@main/services/ledger';
import { createCustomer } from '@main/services/customers';
import { listPaymentMethods, receivePayment, savePaymentMethod } from '@main/services/payments';
import { runIntegrityChecks } from '@main/services/integrity';
import { listAudit } from '@main/services/audit';
import { createExpense, expenseSummary, getExpense, listExpenseCategories, listExpenses, saveExpenseCategory, updateExpense, voidExpense } from '@main/services/expenses';
import { addCashEntry, cashDay, countCash, listCashCounts, reverseCashEntry } from '@main/services/cash';
import { createSupplier } from '@main/services/suppliers';
import { paySupplier } from '@main/services/supplierPayments';
import { businessDateOf } from '@shared/time';
import { actorOf, createTestEnv, setupOwner, type TestEnv } from '../helpers';

let env: TestEnv;
let actor: { userId: number | null; username: string | null };
let cash: number;
let upi: number;
let rent: number;
let electricity: number;
const rupees = (r: number) => r * 100;
const today = () => businessDateOf(env.clock.now(), env.timeZone);

function expense(amount: number, opts: { methodId?: number; categoryId?: number; date?: string; description?: string } = {}) {
  return createExpense(env, actor, {
    requestId: randomUUID(),
    categoryId: opts.categoryId ?? rent,
    description: opts.description ?? 'October shop rent',
    amount,
    expenseDate: opts.date ?? today(),
    methodId: opts.methodId ?? cash,
    payee: 'Landlord',
    reference: '',
    notes: '',
  });
}

/** Cash received from a customer, so the drawer has something in it. */
function takeCash(amount: number) {
  const c = createCustomer(env, actor, {
    requestId: randomUUID(),
    name: `Customer ${randomUUID().slice(0, 6)}`,
    phone: '',
    address: '',
    businessName: '',
    gstin: '',
    stateCode: '',
    creditDays: null,
    creditLimit: 0,
    notes: '',
    openingBalance: amount,
  });
  receivePayment(env, actor, { requestId: randomUUID(), customerId: c.id, amount, methodId: cash, reference: '', notes: '', allocations: [] });
}

function expectHealthy() {
  expect(runIntegrityChecks(env.db).issues).toEqual([]);
}

beforeEach(() => {
  env = createTestEnv();
  actor = actorOf(setupOwner(env));
  const methods = listPaymentMethods(env.db, false);
  cash = methods.find((m) => m.kind === 'CASH')!.id;
  upi = methods.find((m) => m.kind === 'UPI')!.id;
  const categories = listExpenseCategories(env.db, false);
  rent = categories.find((c) => c.name === 'Shop rent')!.id;
  electricity = categories.find((c) => c.name === 'Electricity')!.id;
});

afterEach(() => env.cleanup());

describe('expenses', () => {
  it('records an expense against the account the money came from', () => {
    const e = expense(rupees(500));
    expect(e.expenseNo).toMatch(/^EXP\//);
    expect(accountBalance(env.db, 'OPERATING_EXPENSES')).toBe(rupees(500));
    expect(accountBalance(env.db, 'CASH')).toBe(rupees(-500));
    expense(rupees(200), { methodId: upi, categoryId: electricity, description: 'Meter bill' });
    expect(accountBalance(env.db, 'UPI')).toBe(rupees(-200));
    expect(listExpenses(env.db, { status: 'ACTIVE', page: 1, pageSize: 10 })).toMatchObject({ total: 2, totalAmount: rupees(700) });
    expect(expenseSummary(env.db, today())).toMatchObject({ today: rupees(700), month: rupees(700) });
    expectHealthy();
  });

  it('a correction reverses the original on its own date and posts the corrected one', () => {
    env.clock.set('2026-10-20T06:00:00.000Z');
    const e = expense(rupees(500), { date: '2026-10-19' });
    expect(cashDay(env, '2026-10-19').outflows).toEqual([{ key: 'EXPENSES', label: 'Expenses', amount: rupees(500), count: 1 }]);

    const fixed = updateExpense(env, actor, {
      id: e.id,
      version: e.version,
      categoryId: electricity,
      description: 'Electricity bill',
      amount: rupees(450),
      expenseDate: '2026-10-18',
      methodId: upi,
      payee: 'MSEB',
      reference: 'UTR5',
      notes: '',
      reason: 'Entered against the wrong day and method',
    });
    expect(fixed).toMatchObject({ amount: rupees(450), expenseDate: '2026-10-18', edited: true, categoryName: 'Electricity' });
    // The cash book no longer shows it on the 19th, and cash is untouched.
    expect(cashDay(env, '2026-10-19').outflows).toEqual([]);
    expect(accountBalance(env.db, 'CASH')).toBe(0);
    expect(accountBalance(env.db, 'UPI')).toBe(rupees(-450));
    expect(accountBalance(env.db, 'OPERATING_EXPENSES')).toBe(rupees(450));
    const audit = listAudit(env.db, { entityType: 'expense', entityId: String(e.id), page: 1, pageSize: 10 }).rows;
    expect(audit.find((a) => a.action === 'UPDATE')).toMatchObject({ reason: 'Entered against the wrong day and method' });
    expect(() => updateExpense(env, actor, { ...fixed, id: e.id, version: e.version, reason: 'stale' } as never)).toThrow(/changed by someone else/);
    expectHealthy();
  });

  it('voids an expense without deleting it, and a void expense cannot change', () => {
    const e = expense(rupees(300));
    const v = voidExpense(env, actor, { id: e.id, version: e.version, reason: 'Paid from home, not the shop' });
    expect(v.status).toBe('VOID');
    expect(accountBalance(env.db, 'OPERATING_EXPENSES')).toBe(0);
    expect(accountBalance(env.db, 'CASH')).toBe(0);
    expect(() => voidExpense(env, actor, { id: e.id, version: v.version, reason: 'again' })).toThrow(/already void/);
    expect(() => env.db.prepare("UPDATE expenses SET amount = 1 WHERE id = ?").run(e.id)).toThrow(/IMMUTABLE/);
    expect(() => env.db.prepare('DELETE FROM expenses WHERE id = ?').run(e.id)).toThrow(/IMMUTABLE/);
    expect(listExpenses(env.db, { status: 'ACTIVE', page: 1, pageSize: 10 }).total).toBe(0);
    expect(listExpenses(env.db, { status: 'VOID', page: 1, pageSize: 10 }).rows[0]?.voidReason).toBe('Paid from home, not the shop');
    expectHealthy();
  });

  it('refuses future dates and retired categories, and stays reversible after a method is retired', () => {
    expect(() => expense(rupees(100), { date: '2099-01-01' })).toThrow(/future/);
    const old = saveExpenseCategory(env, actor, { name: 'Diwali decoration', isActive: true });
    const e = expense(rupees(100), { categoryId: old.id });
    saveExpenseCategory(env, actor, { id: old.id, name: 'Diwali decoration', isActive: false, version: old.version });
    expect(() => expense(rupees(100), { categoryId: old.id })).toThrow(/no longer in use/);
    expect(listExpenseCategories(env.db, false).some((c) => c.id === old.id)).toBe(false);

    const cashMethod = listPaymentMethods(env.db, true).find((m) => m.id === cash)!;
    savePaymentMethod(env, actor, { ...cashMethod, isActive: false });
    voidExpense(env, actor, { id: e.id, version: getExpense(env.db, e.id).version, reason: 'Recorded by mistake' });
    expectHealthy();
  });
});

describe('cash', () => {
  it('builds the day from the ledger: opening, money in and out by kind, expected closing', () => {
    env.clock.set('2026-10-20T05:00:00.000Z');
    addCashEntry(env, actor, { requestId: randomUUID(), type: 'CASH_IN', amount: rupees(2000), reason: 'Opening float' });
    env.clock.set('2026-10-21T05:00:00.000Z');
    takeCash(rupees(5000));
    addCashEntry(env, actor, { requestId: randomUUID(), type: 'BANK_DEPOSIT', amount: rupees(3000), reason: 'Deposited at SBI' });
    addCashEntry(env, actor, { requestId: randomUUID(), type: 'DRAWING', amount: rupees(500), reason: 'Household' });
    expense(rupees(250), { description: 'Tea and snacks' });
    const supplier = createSupplier(env, actor, {
      requestId: randomUUID(),
      name: 'Local supplier',
      phone: '',
      address: '',
      businessName: '',
      gstin: '',
      stateCode: '',
      creditDays: null,
      notes: '',
      openingBalance: rupees(1000),
    });
    paySupplier(env, actor, { requestId: randomUUID(), supplierId: supplier.id, amount: rupees(1000), methodId: cash, reference: '', notes: '', allocations: [] });

    const day = cashDay(env);
    expect(day.isToday).toBe(true);
    expect(day.opening).toBe(rupees(2000));
    expect(day.inflows).toEqual([{ key: 'CUSTOMER_PAYMENTS', label: 'Payments from customers', amount: rupees(5000), count: 1 }]);
    expect(day.outflows.map((f) => [f.key, f.amount])).toEqual([
      ['BANK_DEPOSIT', rupees(3000)],
      ['SUPPLIER_PAYMENTS', rupees(1000)],
      ['DRAWING', rupees(500)],
      ['EXPENSES', rupees(250)],
    ]);
    expect(day.closing).toBe(rupees(2000 + 5000 - 3000 - 500 - 250 - 1000));
    expect(day.closing).toBe(accountBalance(env.db, 'CASH'));
    expect(day.entries.map((e) => e.type)).toEqual(['BANK_DEPOSIT', 'DRAWING']);
    expect(day.otherMethods).toEqual([{ methodName: 'Bank account', received: rupees(3000), paid: 0 }]);
    expect(cashDay(env, '2026-10-22').opening).toBe(day.closing);
    expectHealthy();
  });

  it('a count records over or short against the records, and needs a reason when it differs', () => {
    takeCash(rupees(1000));
    expect(() => countCash(env, actor, { requestId: randomUUID(), counted: rupees(950), denominations: null, note: '' })).toThrow(/short by ₹50.00/);
    expect(() => countCash(env, actor, { requestId: randomUUID(), counted: rupees(950), denominations: { '500': 1, '100': 5 }, note: 'x' })).toThrow(/add up to ₹1,000.00/);
    const c = countCash(env, actor, { requestId: randomUUID(), counted: rupees(950), denominations: { '500': 1, '200': 2, '50': 1 }, note: 'Change given wrongly' });
    expect(c).toMatchObject({ expected: rupees(1000), counted: rupees(950), difference: rupees(-50), denominations: { '500': 1, '200': 2, '50': 1 } });
    expect(accountBalance(env.db, 'CASH')).toBe(rupees(950));
    expect(accountBalance(env.db, 'CASH_OVER_SHORT')).toBe(rupees(50));
    const exact = countCash(env, actor, { requestId: randomUUID(), counted: rupees(950), denominations: null, note: '' });
    expect(exact.difference).toBe(0);
    expect(cashDay(env).counts).toHaveLength(2);
    expect(cashDay(env).outflows).toEqual([{ key: 'COUNT_DIFFERENCES', label: 'Count differences (over / short)', amount: rupees(50), count: 1 }]);
    expect(listCashCounts(env.db, { page: 1, pageSize: 10 }).total).toBe(2);
    expect(() => env.db.prepare('UPDATE cash_counts SET counted = 0').run()).toThrow(/IMMUTABLE/);
    expectHealthy();
  });

  it('will not take out more cash than the records show, and reverses entries', () => {
    expect(() => addCashEntry(env, actor, { requestId: randomUUID(), type: 'DRAWING', amount: rupees(100), reason: 'Lunch' })).toThrow(/only ₹0.00/);
    const add = addCashEntry(env, actor, { requestId: randomUUID(), type: 'CASH_IN', amount: rupees(1000), reason: 'Float' });
    expect(add.entryNo).toMatch(/^CSH\//);
    const draw = addCashEntry(env, actor, { requestId: randomUUID(), type: 'DRAWING', amount: rupees(800), reason: 'Lunch' });
    // Undoing the ₹1,000 added would leave the drawer negative.
    expect(() => reverseCashEntry(env, actor, { id: add.id, reason: 'Wrong' })).toThrow(/only ₹200.00/);
    const r = reverseCashEntry(env, actor, { id: draw.id, reason: 'Entered twice' });
    expect(r.reversal?.reason).toBe('Entered twice');
    expect(accountBalance(env.db, 'CASH')).toBe(rupees(1000));
    expect(() => reverseCashEntry(env, actor, { id: draw.id, reason: 'again' })).toThrow(/already been reversed/);
    // The reversed drawing nets out of the day's cash book.
    expect(cashDay(env).outflows).toEqual([]);
    expectHealthy();
  });
});
