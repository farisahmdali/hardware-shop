import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { getCustomer, walkInCustomerId } from '@main/services/customers';
import { runIntegrityChecks } from '@main/services/integrity';
import { reversePayment, receivePayment } from '@main/services/payments';
import { createPurchase, createSupplierReturn, getPurchase } from '@main/services/purchases';
import { extendRental, getRental } from '@main/services/rentals';
import { cancelInvoice, createCreditNote, finalizeSale, getInvoice, type FinalizeInput } from '@main/services/sales';
import { adjustStock } from '@main/services/stock';
import { paySupplier } from '@main/services/supplierPayments';
import { AppError } from '@shared/errors';
import { ShopData, OWNER_PERMS, rupees, units, type PricedProduct } from '../support/shop';
import { actorOf, createTestEnv, setupOwner, type TestEnv } from '../helpers';

/** Small, fast, seedable random numbers, so a failing sequence can be replayed exactly. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let env: TestEnv;
afterEach(() => env?.cleanup());

/** The operation has nothing to act on yet (e.g. a supplier return before any purchase). */
class NothingToDo extends Error {}

/** Row counts of everything an operation writes; a refused operation must leave all of them unchanged. */
const COUNTED = [
  'invoices', 'invoice_lines', 'invoice_cancellations', 'credit_notes', 'payments', 'allocations', 'payment_reversals',
  'stock_movements', 'ledger_entries', 'audit_log', 'purchases', 'debit_notes', 'rental_agreements', 'rental_items', 'deposit_transactions',
  'supplier_allocations', 'expenses', 'doc_sequences', 'idempotency_keys',
];
const counts = () => Object.fromEntries(COUNTED.map((t) => [t, (env.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));
const sumSeq = () => (env.db.prepare('SELECT COALESCE(SUM(next_value), 0) AS n FROM doc_sequences').get() as { n: number }).n;

/** Every document number of one kind, e.g. INV/2026-27/00001 ... must run 1, 2, 3 ... with no gaps or repeats. */
function expectGapFree(table: string, column: string) {
  const byPrefix = new Map<string, number[]>();
  for (const { no } of env.db.prepare(`SELECT ${column} AS no FROM ${table}`).all() as { no: string }[]) {
    const m = /^(.*\/)(\d+)$/.exec(no)!;
    byPrefix.set(m[1]!, [...(byPrefix.get(m[1]!) ?? []), Number(m[2])]);
  }
  for (const [prefix, numbers] of byPrefix) {
    numbers.sort((a, b) => a - b);
    expect({ prefix, numbers }).toEqual({ prefix, numbers: numbers.map((_, i) => i + 1) });
  }
}

function runSequence(seed: number, steps: number) {
  env = createTestEnv();
  const random = mulberry32(seed);
  const pick = <T,>(xs: T[]): T => {
    if (xs.length === 0) throw new NothingToDo();
    return xs[Math.floor(random() * xs.length)]!;
  };
  const between = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
  const shop = new ShopData(env, actorOf(setupOwner(env)));
  const now = () => env.clock.now().toISOString();

  const products: PricedProduct[] = Array.from({ length: 10 }, (_, i) =>
    shop.product(`Item ${i + 1}`, { price: rupees(between(20, 900)), cost: rupees(between(10, 500)), qty: units(between(0, 15)) }),
  );
  const customers = Array.from({ length: 5 }, (_, i) => shop.customer(`Customer ${i + 1}`, `98220${String(i).padStart(5, '0')}`).id);
  const walkIn = walkInCustomerId(env.db);
  const suppliers = [shop.supplier('Pune Tools').id, shop.supplier('Unregistered dealer', '').id];
  const drills = shop.rentalProduct('Impact drill', 4, rupees(300), rupees(1500));

  const sales: FinalizeInput[] = [];
  const outcomes: Record<string, { done: number; refused: number }> = {};
  const ids = (sql: string, ...args: unknown[]) => (env.db.prepare(sql).all(...args) as { id: number }[]).map((r) => r.id);

  const operations: [string, number, () => void][] = [
    ['sale', 30, () => {
      const customer = random() < 0.5 ? walkIn : pick(customers);
      const lines = Array.from({ length: between(1, 3) }, () => ({ p: pick(products), qty: units(between(1, 4)) }));
      const unique = [...new Map(lines.map((l) => [l.p.id, l])).values()];
      const pay = customer === walkIn ? 'all' : pick(['all', 'none', rupees(between(50, 500))] as const);
      const input = shop.saleInput(customer, unique, pay, pick([shop.cash, shop.upi]));
      finalizeSale(env, shop.actor, OWNER_PERMS, input);
      sales.push(input);
    }],
    ['payment', 10, () => {
      const customer = pick(customers);
      const owed = Math.max(0, getCustomer(env.db, customer, shop.today()).balance);
      receivePayment(env, shop.actor, shop.paymentInput(customer, Math.max(rupees(10), Math.min(owed, rupees(between(10, 3000))))));
    }],
    ['return', 6, () => {
      const invoiceId = pick(ids("SELECT id FROM invoices WHERE kind = 'SALE'"));
      const inv = getInvoice(env.db, invoiceId, true, shop.today());
      const line = pick(inv.lines);
      const walk = inv.customerId === walkIn;
      createCreditNote(env, shop.actor, {
        requestId: randomUUID(),
        invoiceId,
        lines: [{ invoiceLineId: line.id, qty: units(1), restock: random() < 0.7 }],
        reason: 'Customer returned it',
        settlement: walk || random() < 0.3 ? 'REFUND' : 'CREDIT',
        refundMethodId: shop.cash,
      });
    }],
    ['cancel', 4, () => cancelInvoice(env, shop.actor, { id: pick(ids("SELECT id FROM invoices WHERE kind = 'SALE'")), reason: 'Billed by mistake', requestId: randomUUID() })],
    ['reverse payment', 3, () =>
      reversePayment(env, shop.actor, { id: pick(ids("SELECT p.id FROM payments p WHERE p.direction = 'IN' AND p.purpose = 'RECEIPT' AND p.party_type = 'CUSTOMER' AND p.party_id != ?", walkIn)), reason: 'Cheque bounced' })],
    ['stock adjustment', 6, () => {
      const kind = pick(['RECEIPT', 'ADJUST_OUT', 'DAMAGE'] as const);
      adjustStock(env, shop.actor, { requestId: randomUUID(), productId: pick(products).id, kind, qty: units(between(1, 5)), unitCost: kind === 'RECEIPT' ? rupees(between(10, 500)) : undefined, reason: 'Counted again' }, true);
    }],
    ['purchase', 6, () => {
      const lines = [...new Map(Array.from({ length: between(1, 3) }, () => [pick(products).id, { productId: 0, qty: units(between(1, 10)), cost: rupees(between(10, 500)) }])).entries()].map(([id, l]) => ({ ...l, productId: id }));
      createPurchase(env, shop.actor, shop.purchaseInput(pick(suppliers), lines, random() < 0.5 ? rupees(between(100, 3000)) : 0));
    }],
    ['supplier payment', 3, () =>
      paySupplier(env, shop.actor, { requestId: randomUUID(), supplierId: pick(suppliers), amount: rupees(between(100, 2000)), methodId: shop.upi, reference: '', notes: '', allocations: [] })],
    ['supplier return', 2, () => {
      const purchaseId = pick(ids('SELECT id FROM purchases'));
      const line = pick(getPurchase(env.db, purchaseId, shop.today()).lines);
      createSupplierReturn(env, shop.actor, { requestId: randomUUID(), purchaseId, lines: [{ purchaseLineId: line.id, qty: units(1) }], reason: 'Faulty', settlement: 'ADJUST', reference: '' });
    }],
    ['rental', 5, () => {
      const free = ids("SELECT id FROM rental_assets WHERE status = 'AVAILABLE' AND rental_product_id = ?", drills.id);
      shop.rent(pick(customers), [pick(free.length ? free : drills.assetIds)], between(1, 5), random() < 0.8 ? rupees(1500) : 0);
    }],
    ['rental return', 4, () => shop.returnAndSettle(pick(ids("SELECT id FROM rental_agreements WHERE status IN ('ACTIVE', 'PARTIALLY_RETURNED')")))],
    ['rental extension', 2, () => {
      const id = pick(ids("SELECT id FROM rental_agreements WHERE status = 'ACTIVE'"));
      const r = getRental(env.db, id, now());
      extendRental(env, shop.actor, { requestId: randomUUID(), id, version: r.version, newExpectedReturnAt: new Date(new Date(r.expectedReturnAt).getTime() + 2 * 86_400_000).toISOString(), reason: 'Customer asked', payments: [] });
    }],
    ['expense', 3, () => shop.expense(rupees(between(50, 2000)), 'Tea and snacks')],
  ];
  const totalWeight = operations.reduce((a, [, w]) => a + w, 0);

  for (let step = 1; step <= steps; step++) {
    env.clock.advanceMinutes(between(1, 240));
    let roll = random() * totalWeight;
    const [name, , run] = operations.find(([, w]) => (roll -= w) < 0)!;
    const outcome = (outcomes[name] ??= { done: 0, refused: 0 });
    const before = counts();
    try {
      run();
      outcome.done++;
    } catch (e) {
      if (e instanceof NothingToDo) {
        expect(counts()).toEqual(before);
        continue;
      }
      // Picking a random target (e.g. cancelling an invoice that has returns, selling more than is in
      // stock) is often refused; a refusal must be a business message and must change nothing.
      if (!(e instanceof AppError) || !['BUSINESS_RULE', 'VALIDATION'].includes(e.code)) {
        throw new Error(`Seed ${seed}, step ${step} (${name}) failed unexpectedly: ${(e as Error).stack}`);
      }
      expect({ step, name, counts: counts() }).toEqual({ step, name, counts: before });
      outcome.refused++;
    }
    if (step % 50 === 0) expect({ step, issues: runIntegrityChecks(env.db).issues }).toEqual({ step, issues: [] });
  }

  // Sending the same sale again (a double click, a retry after a timeout) never makes a second bill.
  const before = { ...counts(), seq: sumSeq() };
  for (const input of sales.slice(-10)) finalizeSale(env, shop.actor, OWNER_PERMS, input);
  expect({ ...counts(), seq: sumSeq() }).toEqual(before);

  expect(runIntegrityChecks(env.db).issues).toEqual([]);
  expectGapFree('invoices', 'invoice_no');
  expectGapFree('payments', 'payment_no');
  expectGapFree('credit_notes', 'credit_note_no');
  expectGapFree('purchases', 'purchase_no');
  expectGapFree('rental_agreements', 'rental_no');
  expectGapFree('expenses', 'expense_no');
  // No stock went below zero along the way.
  expect(env.db.prepare('SELECT COUNT(*) AS n FROM stock_movements WHERE qty_after < 0').get()).toEqual({ n: 0 });
  return outcomes;
}

describe('a long random sequence of shop operations', () => {
  it.each([20261021, 7, 424242])('keeps stock, money, numbering and history consistent (seed %i)', (seed) => {
    const outcomes = runSequence(seed, 400);
    // The sequence really exercised the shop: every kind of operation went through at least once.
    for (const [name, o] of Object.entries(outcomes)) expect({ name, done: o.done > 0 }).toEqual({ name, done: true });
    expect(Object.keys(outcomes).length).toBe(13);
  }, 120_000);
});
