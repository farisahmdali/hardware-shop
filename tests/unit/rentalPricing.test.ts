import { describe, expect, it } from 'vitest';
import { lateFee, priceRental, type LateFeeOptions, type RentalRate } from '@shared/rentalPricing';

const drill: RentalRate[] = [
  { unit: 'HOUR', unitMinutes: 60, price: 5000 },
  { unit: 'DAY', unitMinutes: 1440, price: 30000 },
  { unit: 'WEEK', unitMinutes: 10_080, price: 150000 },
];
const cheapest = { mode: 'CHEAPEST' as const, graceMinutes: 60 };
const H = 60;
const D = 1440;

describe('cheapest combination', () => {
  it('uses hours for short rentals until a day is cheaper', () => {
    expect(priceRental(drill, 3 * H, { ...cheapest, graceMinutes: 0 }).total).toBe(15000);
    // 7 hours at ₹50 = ₹350 is more than a day at ₹300.
    const r = priceRental(drill, 7 * H, { ...cheapest, graceMinutes: 0 });
    expect(r.total).toBe(30000);
    expect(r.parts).toEqual([{ label: 'day', count: 1, unitPrice: 30000, amount: 30000 }]);
  });

  it('combines a week and days', () => {
    const r = priceRental(drill, 9 * D, cheapest);
    expect(r.parts.map((p) => [p.label, p.count])).toEqual([
      ['week', 1],
      ['day', 2],
    ]);
    expect(r.total).toBe(210000);
    expect(r.explanation).toBe('9 days: 1 week × ₹1500.00 + 2 days × ₹300.00');
  });

  it('charges a week for 6 days when that is cheaper than 6 day rates', () => {
    expect(priceRental(drill, 6 * D, cheapest).total).toBe(150000);
  });

  it('forgives lateness within the grace period', () => {
    expect(priceRental(drill, D + 45, cheapest).total).toBe(30000);
    const late = priceRental(drill, D + 90, cheapest);
    expect(late.total).toBe(35000);
    expect(late.explanation).toContain('after 60 minutes grace');
  });

  it('always charges at least one unit', () => {
    expect(priceRental(drill, 10, cheapest).total).toBe(5000);
    expect(priceRental(drill, 0, cheapest).total).toBe(5000);
  });

  it('supports custom periods', () => {
    const halfDay: RentalRate[] = [...drill, { unit: 'CUSTOM', unitMinutes: 12 * H, price: 18000, label: 'Half day' }];
    expect(priceRental(halfDay, 10 * H, { ...cheapest, graceMinutes: 0 }).parts[0]).toMatchObject({ label: 'Half day', count: 1 });
  });

  it('refuses items without rates or absurd durations', () => {
    expect(() => priceRental([], D, cheapest)).toThrow(/no rental rates/);
    expect(() => priceRental(drill, 3 * 366 * D, cheapest)).toThrow(/two years/);
  });
});

describe('other modes', () => {
  it('rounds up whole units of the chosen rate', () => {
    expect(priceRental(drill, 9 * D, { mode: 'CHOSEN_UNIT', graceMinutes: 60, chosenUnit: 'DAY' }).total).toBe(270000);
    expect(priceRental(drill, 9 * D, { mode: 'CHOSEN_UNIT', graceMinutes: 60, chosenUnit: 'WEEK' }).total).toBe(300000);
  });

  it('charges started days in daily mode', () => {
    expect(priceRental(drill, 2 * D + 3 * H, { mode: 'DAILY', graceMinutes: 60 }).total).toBe(90000);
    expect(() => priceRental([drill[0]!], D, { mode: 'DAILY', graceMinutes: 0 })).toThrow(/day rate/);
  });
});

describe('late fees', () => {
  const base: LateFeeOptions = { ...cheapest, lateFeeMode: 'SAME_RATES', lateFeePerDay: 20000, lateMultiplierBp: 15000 };

  it('charges overdue time with the same rates, less what was already billed', () => {
    // Booked 1 week (₹1,500), returned after 8 days: 1 week + 1 day = ₹1,800, so ₹300 late.
    const f = lateFee(drill, 7 * D, 8 * D, base);
    expect(f).toMatchObject({ lateMinutes: D, amount: 30000 });
  });

  it('is zero within the grace period', () => {
    expect(lateFee(drill, D, D + 30, base).amount).toBe(0);
  });

  it('supports a fixed fee per started day and a multiplier', () => {
    // 2 days 2 hours late is 3 started days; 2 days 30 minutes is 2 once the grace period is applied.
    expect(lateFee(drill, D, 3 * D + 120, { ...base, lateFeeMode: 'FIXED_PER_DAY' }).amount).toBe(60000);
    expect(lateFee(drill, D, 3 * D + 30, { ...base, lateFeeMode: 'FIXED_PER_DAY' }).amount).toBe(40000);
    expect(lateFee(drill, 7 * D, 8 * D, { ...base, lateFeeMode: 'MULTIPLIER' }).amount).toBe(45000);
  });
});
