import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transact } from '@main/db/tx';
import { createRentalProduct, getRentalProduct, assetHistory, setAssetStatus, updateRentalProduct } from '@main/services/rentalCatalog';
import {
  cancelReservation,
  closeRental,
  createRental,
  extendRental,
  getRental,
  issueReserved,
  listRentals,
  quoteExtension,
  quoteRental,
  quoteReturn,
  rentalSummary,
  returnItems,
  settleDeposit,
  type CreateRentalInput,
  type ReturnItemInput,
} from '@main/services/rentals';
import { createCustomer, getCustomer, walkInCustomerId } from '@main/services/customers';
import { createProduct } from '@main/services/products';
import { getInvoice } from '@main/services/sales';
import { accountBalance } from '@main/services/ledger';
import { listPaymentMethods } from '@main/services/payments';
import { updateSettingsSection, getAllSettings } from '@main/services/settings';
import { runIntegrityChecks } from '@main/services/integrity';
import { listAudit } from '@main/services/audit';
import { ALL_PERMISSIONS } from '@shared/permissions';
import type { RentalProductDetail } from '@shared/contracts';
import { actorOf, createTestEnv, setupOwner, type TestEnv } from '../helpers';

let env: TestEnv;
let actor: { userId: number | null; username: string | null };
let drill: RentalProductDetail;
let customerId: number;
let cash: number;
let upi: number;
const OWNER = { permissions: ALL_PERMISSIONS, maxDiscountBp: 10_000 };
const STAFF = { permissions: ['rentals.issue', 'rentals.return', 'payments.receive'] as never[], maxDiscountBp: 0 };
const H = 3_600_000;
const D = 24 * H;
const now = () => env.clock.now().toISOString();
const at = (ms: number) => new Date(env.clock.now().getTime() + ms).toISOString();
const healthy = () => expect(runIntegrityChecks(env.db).issues).toEqual([]);
const rental = (id: number) => getRental(env.db, id, now());

function rent(assetIds: number[], overrides: Partial<CreateRentalInput> = {}) {
  const base: CreateRentalInput = {
    requestId: randomUUID(),
    customerId,
    assetIds,
    reserve: false,
    expectedReturnAt: at(2 * D),
    discount: null,
    expectedChargesTotal: 0,
    deposit: { amount: 0, reference: '' },
    payments: [],
    notes: '',
    terms: '',
    saleLines: [],
    expectedSaleTotal: 0,
    ...overrides,
  };
  if (overrides.expectedChargesTotal === undefined) {
    base.expectedChargesTotal = quoteRental(
      env.db,
      { customerId: base.customerId, assetIds, startAt: base.startAt, expectedReturnAt: base.expectedReturnAt, reserve: base.reserve, chosenUnit: base.chosenUnit, discount: base.discount },
      now(),
    ).billNow.grandTotal;
  }
  return createRental(env, actor, OWNER, base);
}

const back = (id: number, items: Partial<ReturnItemInput>[], opts: { returnedAt?: string; perms?: typeof OWNER } = {}) => {
  const r = rental(id);
  return returnItems(env, actor, opts.perms ?? OWNER, {
    requestId: randomUUID(),
    id,
    version: r.version,
    returnedAt: opts.returnedAt,
    payments: [],
    items: items.map((i) => ({
      itemId: i.itemId ?? r.items.find((x) => x.status === 'OUT')!.id,
      condition: 'GOOD',
      notes: '',
      nextStatus: 'AVAILABLE',
      damageCharge: 0,
      damageReason: '',
      lateFeeReason: '',
      ...i,
    })),
  });
};

beforeEach(() => {
  env = createTestEnv();
  actor = actorOf(setupOwner(env));
  const id = createRentalProduct(env, actor, {
    requestId: randomUUID(),
    name: 'Impact drill 13 mm',
    categoryId: null,
    brand: 'Bosch',
    model: 'GSB 13',
    description: '',
    depositAmount: 200000,
    sacCode: '997319',
    gstRateBp: 1800,
    priceIncludesTax: true,
    notes: '',
    rates: [
      { unit: 'HOUR', label: '', price: 5000 },
      { unit: 'DAY', label: '', price: 30000 },
      { unit: 'WEEK', label: '', price: 150000 },
    ],
    units: 3,
    serials: ['SN-1', 'SN-2', 'SN-3'],
    purchaseCost: 450000,
    purchaseDate: '2026-01-10',
  });
  drill = getRentalProduct(env.db, id, true, now());
  customerId = createCustomer(env, actor, {
    requestId: randomUUID(),
    name: 'Ramesh Builders',
    phone: '9822012345',
    address: '',
    businessName: '',
    gstin: '',
    stateCode: '',
    creditDays: null,
    creditLimit: 0,
    notes: '',
    openingBalance: 0,
  }).id;
  const methods = listPaymentMethods(env.db, false);
  cash = methods.find((m) => m.kind === 'CASH')!.id;
  upi = methods.find((m) => m.kind === 'UPI')!.id;
});
afterEach(() => env.cleanup());

describe('rental items and units', () => {
  it('creates an item with rates and tagged units, each with an event trail', () => {
    expect(drill).toMatchObject({ code: 'RI-001', unitsTotal: 3, unitsAvailable: 3 });
    expect(drill.assets.map((a) => [a.assetTag, a.serialNo])).toEqual([
      ['RI-001-01', 'SN-1'],
      ['RI-001-02', 'SN-2'],
      ['RI-001-03', 'SN-3'],
    ]);
    expect(drill.rates.map((r) => r.displayLabel)).toEqual(['hour', 'day', 'week']);
    expect(assetHistory(env.db, drill.assets[0]!.id).events[0]!.event).toBe('ADDED');
  });

  it('keeps rental rates fixed for rentals already made when rates change', () => {
    const r = rent([drill.assets[0]!.id], { expectedReturnAt: at(D) });
    updateRentalProduct(env, actor, { ...drill, sacCode: '997319', notes: '', description: '', rates: [{ unit: 'DAY', label: '', price: 40000 }], id: drill.id, version: drill.version });
    env.clock.advanceMinutes(60 * 24 * 2);
    const late = back(r.id, [{}]);
    expect(late).toBeUndefined();
    const charges = rental(r.id).charges;
    // Late by a day: priced with the original ₹300 day rate.
    expect(charges.find((c) => c.type === 'LATE_FEE')!.amount).toBe(30000);
    expect(listAudit(env.db, { page: 1, pageSize: 5, action: 'RATES_CHANGED' }).total).toBe(1);
  });
});

describe('issuing', () => {
  it('issues a unit: asset rented, base charge invoiced, deposit held as a liability, payment applied', () => {
    const r = rent([drill.assets[0]!.id], {
      expectedReturnAt: at(9 * D),
      deposit: { amount: 200000, methodId: cash, reference: '' },
      payments: [{ methodId: upi, amount: 100000, reference: 'UPI-1' }],
    });
    expect(r).toMatchObject({ rentalNo: 'RNT/2026-27/00001', invoiceNo: 'RINV/2026-27/00001' });
    const d = rental(r.id);
    expect(d.status).toBe('ACTIVE');
    expect(d.items[0]).toMatchObject({ status: 'OUT', conditionAtIssue: 'GOOD' });
    expect(d.charges[0]).toMatchObject({ type: 'BASE', amount: 210000, explanation: '9 days: 1 week × ₹1500.00 + 2 days × ₹300.00' });
    expect(d.deposit).toMatchObject({ collected: 200000, held: 200000 });
    expect(d.outstanding).toBe(110000);
    expect(getRentalProduct(env.db, drill.id, true, now()).assets[0]!.status).toBe('RENTED');
    const inv = getInvoice(env.db, d.invoices[0]!.id, true, now().slice(0, 10));
    expect(inv).toMatchObject({ kind: 'RENTAL', grandTotal: 210000 });
    expect(accountBalance(env.db, 'RENTAL_INCOME')).toBe(-inv.taxableTotal);
    expect(accountBalance(env.db, 'DEPOSIT_LIABILITY')).toBe(-200000);
    expect(accountBalance(env.db, 'CASH')).toBe(200000);
    // The deposit is not income and does not reduce what the customer owes.
    expect(getCustomer(env.db, customerId, now().slice(0, 10)).balance).toBe(110000);
    healthy();
  });

  it('refuses walk-in customers, unavailable units and stale totals', () => {
    expect(() => rent([drill.assets[0]!.id], { customerId: walkInCustomerId(env.db) })).toThrow(/registered customer/);
    const unit = getRentalProduct(env.db, drill.id, true, now()).assets[1]!;
    setAssetStatus(env, actor, { id: unit.id, version: unit.version, status: 'MAINTENANCE', condition: 'FAIR', reason: 'Chuck replacement' });
    expect(() => rent([unit.id])).toThrow(/not available: it is maintenance/);
    expect(() => rent([drill.assets[0]!.id], { expectedChargesTotal: 1 })).toThrow(/come to/);
    healthy();
  });

  it('never books the same unit twice', () => {
    const a = drill.assets[0]!.id;
    rent([a]);
    expect(() => rent([a])).toThrow(/not available: it is rented/);
    // Database-level guard: an overlapping booking row is refused even outside the service.
    expect(() =>
      env.db
        .prepare(
          `INSERT INTO asset_bookings (asset_id, rental_item_id, start_at, end_at) VALUES (?, (SELECT MAX(id) FROM rental_items), ?, ?)`,
        )
        .run(a, now(), at(D)),
    ).toThrow(/ASSET_DOUBLE_BOOKED|UNIQUE/);
    healthy();
  });

  it('sells products on a linked invoice paid together with the rental', () => {
    const blades = createProduct(
      env,
      actor,
      {
        requestId: randomUUID(),
        sku: '',
        name: 'Masonry drill bit set',
        categoryId: null,
        brandId: null,
        unitId: (env.db.prepare("SELECT id FROM units WHERE code = 'SET'").get() as { id: number }).id,
        description: '',
        hsnCode: '8207',
        gstRateBp: 1800,
        priceIncludesTax: true,
        purchasePrice: 24000,
        sellingPrice: 38000,
        minStockQty: 0,
        preferredSupplierId: null,
        notes: '',
        openingQty: 10_000,
      },
      true,
    );
    const r = rent([drill.assets[0]!.id], {
      expectedReturnAt: at(D),
      saleLines: [{ productId: blades.id, qty: 1000, discount: null, expectedUnitPrice: 38000 }],
      expectedSaleTotal: 38000,
      payments: [{ methodId: cash, amount: 68000, reference: '' }],
    });
    expect(r.saleInvoiceNo).toBe('INV/2026-27/00001');
    const d = rental(r.id);
    expect(d.linkedInvoice?.invoiceNo).toBe('INV/2026-27/00001');
    expect(d.outstanding).toBe(0);
    expect(getInvoice(env.db, d.linkedInvoice!.id, true, now().slice(0, 10)).status).toBe('PAID');
    healthy();
  });
});

describe('reservations', () => {
  it('reserves future dates, blocks overlaps and issues on the day', () => {
    const unit = drill.assets[0]!.id;
    const res = rent([unit], { reserve: true, startAt: at(3 * D), expectedReturnAt: at(5 * D) });
    expect(rental(res.id).status).toBe('RESERVED');
    // A rental now that would run into the reservation is refused; a shorter one fits.
    expect(() => rent([unit], { expectedReturnAt: at(4 * D) })).toThrow(/booked by Ramesh Builders/);
    const short = rent([unit], { expectedReturnAt: at(2 * D) });
    back(short.id, [{}]);

    env.clock.advanceMinutes(3 * 24 * 60);
    const r = rental(res.id);
    issueReserved(env, actor, OWNER, {
      requestId: randomUUID(),
      id: res.id,
      version: r.version,
      discount: null,
      expectedChargesTotal: 60000,
      deposit: { amount: 200000, methodId: cash, reference: '' },
      payments: [{ methodId: cash, amount: 60000, reference: '' }],
    });
    expect(rental(res.id)).toMatchObject({ status: 'ACTIVE', outstanding: 0 });
    healthy();
  });

  it('cancels a reservation and frees the unit', () => {
    const unit = drill.assets[0]!.id;
    const res = rent([unit], { reserve: true, startAt: at(D), expectedReturnAt: at(3 * D) });
    cancelReservation(env, actor, { id: res.id, version: rental(res.id).version, reason: 'Customer changed plans' });
    expect(rental(res.id).status).toBe('CANCELLED');
    expect(() => env.db.prepare("UPDATE rental_agreements SET notes = 'x' WHERE id = ?").run(res.id)).toThrow(/IMMUTABLE/);
    rent([unit], { expectedReturnAt: at(3 * D) });
    healthy();
  });
});

describe('extensions, overdue and returns', () => {
  it('extends a rental, charging only the extra time, and records the old and new dates', () => {
    const r = rent([drill.assets[0]!.id], { expectedReturnAt: at(5 * D) });
    const quote = quoteExtension(env.db, r.id, at(7 * D));
    // 5 days = ₹1,500 (a week is the same price as 5 days); 7 days = 1 week = ₹1,500, so no extra.
    expect(quote.bill.grandTotal).toBe(0);
    const q2 = quoteExtension(env.db, r.id, at(9 * D));
    expect(q2.items[0]!.amount).toBe(60000);
    const before = rental(r.id);
    extendRental(env, actor, { requestId: randomUUID(), id: r.id, version: before.version, newExpectedReturnAt: at(9 * D), reason: 'Job delayed', payments: [] });
    const after = rental(r.id);
    expect(after.extensions[0]).toMatchObject({ previousExpected: before.expectedReturnAt, newExpected: after.expectedReturnAt, reason: 'Job delayed' });
    expect(after.originalExpectedReturnAt).toBe(before.expectedReturnAt);
    expect(after.invoices).toHaveLength(2);
    healthy();
  });

  it('refuses an extension into another booking', () => {
    const unit = drill.assets[0]!.id;
    const r = rent([unit], { expectedReturnAt: at(2 * D) });
    rent([unit], { reserve: true, startAt: at(3 * D), expectedReturnAt: at(4 * D) });
    expect(() =>
      extendRental(env, actor, { requestId: randomUUID(), id: r.id, version: rental(r.id).version, newExpectedReturnAt: at(3 * D + 2 * H), reason: 'More days', payments: [] }),
    ).toThrow(/booked by/);
  });

  it('flags overdue rentals and charges late fees with the same rates', () => {
    const r = rent([drill.assets[0]!.id], { expectedReturnAt: at(D) });
    env.clock.advanceMinutes(30 * 60);
    expect(rental(r.id)).toMatchObject({ overdue: true, overdueMinutes: 360 });
    expect(listRentals(env.db, { filter: 'OVERDUE', page: 1, pageSize: 10 }, now()).total).toBe(1);
    expect(rentalSummary(env.db, now(), at(H)).overdue).toBe(1);
    const q = quoteReturn(env.db, r.id, [rental(r.id).items[0]!.id], undefined, now());
    // 30 hours: 1 day + 5 hours after grace... cheapest is 1 day + 5 hours = ₹550 vs 2 days ₹600 → ₹250 late.
    expect(q.items[0]!.amount).toBe(25000);
    back(r.id, [{}]);
    expect(rental(r.id).charges.find((c) => c.type === 'LATE_FEE')!.amount).toBe(25000);
    expect(accountBalance(env.db, 'LATE_FEE_INCOME')).toBeLessThan(0);
    healthy();
  });

  it('does not charge a late fee within the grace period', () => {
    const r = rent([drill.assets[0]!.id], { expectedReturnAt: at(D) });
    env.clock.advanceMinutes(24 * 60 + 40);
    back(r.id, [{}]);
    expect(rental(r.id).charges.some((c) => c.type === 'LATE_FEE')).toBe(false);
  });

  it('lets an authorised user waive a late fee with a reason', () => {
    const r = rent([drill.assets[0]!.id], { expectedReturnAt: at(D) });
    env.clock.advanceMinutes(3 * 24 * 60);
    expect(() => back(r.id, [{ lateFeeOverride: 0, lateFeeReason: 'Rain delay' }], { perms: STAFF as never })).toThrow(/permission to waive/);
    back(r.id, [{ lateFeeOverride: 0, lateFeeReason: 'Rain delay' }]);
    const fee = rental(r.id).charges.find((c) => c.type === 'LATE_FEE')!;
    expect(fee.amount).toBe(0);
    expect(fee.explanation).toContain('Rain delay');
  });

  it('records a damaged return: charge invoiced, unit out of service, deposit used and the rest refunded', () => {
    const r = rent([drill.assets[0]!.id, drill.assets[1]!.id], {
      expectedReturnAt: at(D),
      deposit: { amount: 400000, methodId: cash, reference: '' },
    });
    const items = rental(r.id).items;
    back(r.id, [{ itemId: items[0]!.id }]);
    expect(rental(r.id).status).toBe('PARTIALLY_RETURNED');
    back(r.id, [{ itemId: items[1]!.id, condition: 'DAMAGED', nextStatus: 'DAMAGED', damageCharge: 120000, damageReason: 'Cracked housing' }]);
    let d = rental(r.id);
    expect(d.status).toBe('RETURNED');
    expect(getRentalProduct(env.db, drill.id, true, now()).assets[1]).toMatchObject({ status: 'DAMAGED', condition: 'DAMAGED' });
    expect(accountBalance(env.db, 'DAMAGE_INCOME')).toBeLessThan(0);
    const owed = d.outstanding; // two days of rent + damage
    expect(owed).toBe(60000 + 120000);

    expect(() => closeRental(env, actor, { id: r.id, version: d.version, note: '', acceptOutstanding: true })).toThrow(/deposit is still held/);
    expect(() =>
      settleDeposit(env, actor, STAFF as never, { requestId: randomUUID(), id: r.id, applyAmount: owed, applyReason: 'Charges', refundAmount: 0, refundMethodId: cash, refundReference: '' }),
    ).toThrow(/permission to deduct/);
    settleDeposit(env, actor, OWNER, {
      requestId: randomUUID(),
      id: r.id,
      applyAmount: owed,
      applyReason: 'Rent and damage',
      refundAmount: 400000 - owed,
      refundMethodId: cash,
      refundReference: '',
    });
    d = rental(r.id);
    expect(d.deposit).toMatchObject({ collected: 400000, applied: owed, refunded: 400000 - owed, held: 0 });
    expect(d.outstanding).toBe(0);
    expect(accountBalance(env.db, 'DEPOSIT_LIABILITY')).toBe(0);
    expect(accountBalance(env.db, 'CASH')).toBe(owed);
    closeRental(env, actor, { id: r.id, version: d.version, note: 'All settled', acceptOutstanding: false });
    expect(rental(r.id).status).toBe('CLOSED');
    healthy();
  });

  it('will not close while a unit awaits inspection or charges are unpaid without confirmation', () => {
    const r = rent([drill.assets[0]!.id], { expectedReturnAt: at(D) });
    back(r.id, [{ nextStatus: 'AWAITING_INSPECTION' }]);
    expect(() => closeRental(env, actor, { id: r.id, version: rental(r.id).version, note: '', acceptOutstanding: true })).toThrow(/awaiting inspection/);
    const unit = getRentalProduct(env.db, drill.id, true, now()).assets[0]!;
    setAssetStatus(env, actor, { id: unit.id, version: unit.version, status: 'AVAILABLE', condition: 'GOOD', reason: 'Inspected, works fine' });
    expect(assetHistory(env.db, unit.id).events[0]!.event).toBe('INSPECTED');
    expect(() => closeRental(env, actor, { id: r.id, version: rental(r.id).version, note: '', acceptOutstanding: false })).toThrow(/unpaid/);
    closeRental(env, actor, { id: r.id, version: rental(r.id).version, note: 'Customer will pay next week', acceptOutstanding: true });
    expect(getCustomer(env.db, customerId, now().slice(0, 10)).balance).toBe(30000);
    healthy();
  });

  it('bills everything on return when the shop chooses that policy', () => {
    const s = getAllSettings(env.db).rental;
    transact(env, actor, (tx) => updateSettingsSection(tx, 'rental', { ...s, billing: 'AT_RETURN' }));
    const r = rent([drill.assets[0]!.id], { expectedReturnAt: at(3 * D) });
    expect(r.invoiceNo).toBeNull();
    env.clock.advanceMinutes(26 * 60);
    back(r.id, [{}]);
    // Returned early after 26 hours: 1 day + 2 hours, but 1 hour is grace → 1 day + 1 hour = ₹350.
    expect(rental(r.id).charges.find((c) => c.type === 'BASE')!.amount).toBe(35000);
    healthy();
  });

  it('keeps a complete history of the rental and each unit', () => {
    const r = rent([drill.assets[0]!.id], { expectedReturnAt: at(D), deposit: { amount: 200000, methodId: cash, reference: '' } });
    extendRental(env, actor, { requestId: randomUUID(), id: r.id, version: rental(r.id).version, newExpectedReturnAt: at(2 * D), reason: 'More work', payments: [] });
    back(r.id, [{}]);
    const actions = listAudit(env.db, { page: 1, pageSize: 20, entityType: 'rental', entityId: String(r.id) }).rows.map((x) => x.action);
    expect(actions).toEqual(['RETURN', 'EXTEND', 'ISSUE']);
    const events = assetHistory(env.db, drill.assets[0]!.id).events.map((e) => e.event);
    expect(events).toEqual(['RETURNED', 'ISSUED', 'ADDED']);
    expect(() => env.db.prepare('UPDATE rental_charges SET amount = 0').run()).toThrow(/IMMUTABLE/);
    expect(() => env.db.prepare('DELETE FROM deposit_transactions').run()).toThrow(/IMMUTABLE/);
  });

  it('applies a rental request only once', () => {
    const requestId = randomUUID();
    const a = rent([drill.assets[0]!.id], { requestId });
    const b = rent([drill.assets[0]!.id], { requestId });
    expect(b).toEqual(a);
    expect(listRentals(env.db, { filter: 'ALL', page: 1, pageSize: 10 }, now()).total).toBe(1);
  });
});
