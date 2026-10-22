import { mulDivRound } from './money';

/**
 * Rental pricing. Shared by the rental screens (live quotes) and the main process (what is billed).
 *
 * Time is measured in minutes from the moment of issue ("a day" is a rolling 24 hours).
 * A grace period is subtracted before rounding, so returning a drill 40 minutes after
 * the day ends with a 60-minute grace costs one day, not one day and an hour.
 *
 * Modes:
 *   CHEAPEST    — the lowest-cost combination of the item's rates that covers the time,
 *                 e.g. 9 days = 1 week + 2 days if that is cheaper than 9 days.
 *   CHOSEN_UNIT — only the rate chosen at issue, rounded up to whole units.
 *   DAILY       — the day rate, rounded up to whole days.
 */

export type RateUnit = 'HOUR' | 'DAY' | 'WEEK' | 'MONTH' | 'CUSTOM';
export type PricingMode = 'CHEAPEST' | 'CHOSEN_UNIT' | 'DAILY';

export const UNIT_MINUTES: Record<Exclude<RateUnit, 'CUSTOM'>, number> = {
  HOUR: 60,
  DAY: 1440,
  WEEK: 10_080,
  MONTH: 43_200,
};

export const UNIT_LABELS: Record<RateUnit, string> = { HOUR: 'hour', DAY: 'day', WEEK: 'week', MONTH: '30 days', CUSTOM: 'period' };

export interface RentalRate {
  unit: RateUnit;
  /** Length of one unit in minutes (fixed for standard units; set for CUSTOM). */
  unitMinutes: number;
  /** Price per unit, paise. */
  price: number;
  /** Optional display name for custom periods, e.g. "Half day". */
  label?: string;
}

export interface PriceOptions {
  mode: PricingMode;
  graceMinutes: number;
  /** For CHOSEN_UNIT: which rate unit to use. */
  chosenUnit?: RateUnit;
}

export interface PricePart {
  label: string;
  count: number;
  unitPrice: number;
  amount: number;
}

export interface RentalPrice {
  durationMinutes: number;
  chargeableMinutes: number;
  parts: PricePart[];
  total: number;
  /** Plain-language calculation, shown before confirming and stored with the charge. */
  explanation: string;
}

/** Longest rental the engine prices in one go: about two years. */
const MAX_MINUTES = 2 * 366 * 1440;

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

export function rateLabel(r: RentalRate): string {
  return r.label?.trim() || (r.unit === 'CUSTOM' ? `${r.unitMinutes / 60} hours` : UNIT_LABELS[r.unit]);
}

export function describeDuration(minutes: number): string {
  if (minutes <= 0) return '0 minutes';
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return [d && `${d} day${d === 1 ? '' : 's'}`, h && `${h} hour${h === 1 ? '' : 's'}`, m && `${m} min`].filter(Boolean).join(' ');
}

export function minutesBetween(fromIso: string, toIso: string): number {
  return Math.max(0, Math.ceil((Date.parse(toIso) - Date.parse(fromIso)) / 60_000));
}

function plural(count: number, label: string): string {
  if (count === 1) return `1 ${label}`;
  if (/^\d/.test(label)) return `${count} × ${label}`;
  return `${count} ${label}${label.endsWith('s') ? '' : 's'}`;
}

/** Prices a rental of `durationMinutes` with the item's active rates. */
export function priceRental(rates: RentalRate[], durationMinutes: number, opts: PriceOptions): RentalPrice {
  const usable = rates.filter((r) => r.price >= 0 && r.unitMinutes > 0);
  if (usable.length === 0) throw new Error('This item has no rental rates.');
  if (durationMinutes > MAX_MINUTES) throw new Error('Rentals longer than two years cannot be priced in one go.');

  const smallest = Math.min(...usable.map((r) => r.unitMinutes));
  // Grace forgives a little lateness past a whole unit; there is always at least one smallest unit.
  const chargeable = Math.max(1, durationMinutes - Math.max(0, opts.graceMinutes));

  let chosen: { rate: RentalRate; count: number }[];
  if (opts.mode === 'CHEAPEST') {
    chosen = cheapestCombination(usable, chargeable);
  } else {
    const unit = opts.mode === 'DAILY' ? 'DAY' : opts.chosenUnit;
    const rate = usable.find((r) => r.unit === unit) ?? (opts.mode === 'DAILY' ? undefined : usable[0]);
    if (!rate) throw new Error('This item has no day rate, which daily pricing needs.');
    chosen = [{ rate, count: Math.max(1, Math.ceil(chargeable / rate.unitMinutes)) }];
  }

  const parts = chosen
    .filter((c) => c.count > 0)
    .sort((a, b) => b.rate.unitMinutes - a.rate.unitMinutes)
    .map((c) => ({ label: rateLabel(c.rate), count: c.count, unitPrice: c.rate.price, amount: c.count * c.rate.price }));
  const total = parts.reduce((a, p) => a + p.amount, 0);

  // Mention the grace period only when it actually lowered the price.
  const graceHelped =
    opts.graceMinutes > 0 &&
    durationMinutes > smallest &&
    chargeable < durationMinutes &&
    priceRental(rates, durationMinutes, { ...opts, graceMinutes: 0 }).total > total;
  const graceNote = graceHelped ? ` (after ${opts.graceMinutes} minutes grace)` : '';
  const explanation = `${describeDuration(durationMinutes)}${graceNote}: ${parts
    .map((p) => `${plural(p.count, p.label)} × ₹${(p.unitPrice / 100).toFixed(2)}`)
    .join(' + ')}`;
  return { durationMinutes, chargeableMinutes: chargeable, parts, total, explanation };
}

/**
 * Exact minimum-cost cover: an unbounded knapsack over steps of the rates' common
 * granularity (usually one hour), allowing the combination to run over the time
 * when that is cheaper (e.g. a week rate for 6 days).
 */
function cheapestCombination(rates: RentalRate[], minutes: number): { rate: RentalRate; count: number }[] {
  const step = rates.reduce((g, r) => gcd(g, r.unitMinutes), rates[0]!.unitMinutes);
  const n = Math.ceil(minutes / step);
  const sizes = rates.map((r) => r.unitMinutes / step);
  const cost = new Float64Array(n + 1);
  const pick = new Int16Array(n + 1).fill(-1);
  for (let i = 1; i <= n; i++) {
    let best = Infinity;
    let bestRate = -1;
    for (let r = 0; r < rates.length; r++) {
      const c = rates[r]!.price + cost[Math.max(0, i - sizes[r]!)]!;
      // Ties go to the larger unit, which reads more naturally on the bill.
      if (c < best || (c === best && bestRate >= 0 && sizes[r]! > sizes[bestRate]!)) {
        best = c;
        bestRate = r;
      }
    }
    cost[i] = best;
    pick[i] = bestRate;
  }
  const counts = rates.map(() => 0);
  for (let i = n; i > 0; ) {
    const r = pick[i]!;
    counts[r]! += 1;
    i = Math.max(0, i - sizes[r]!);
  }
  return rates.map((rate, i) => ({ rate, count: counts[i]! }));
}

export type LateFeeMode = 'SAME_RATES' | 'FIXED_PER_DAY' | 'MULTIPLIER';

export interface LateFeeOptions extends PriceOptions {
  lateFeeMode: LateFeeMode;
  /** Paise per started day late, for FIXED_PER_DAY. */
  lateFeePerDay: number;
  /** Multiplier on the extra time charge, in basis points (15000 = 1.5×), for MULTIPLIER. */
  lateMultiplierBp: number;
}

export interface LateFee {
  lateMinutes: number;
  amount: number;
  explanation: string;
}

/**
 * Charge for keeping an item past its due time. `billedMinutes` is the period already
 * charged (original booking plus extensions); `actualMinutes` is from issue to return.
 */
export function lateFee(rates: RentalRate[], billedMinutes: number, actualMinutes: number, opts: LateFeeOptions): LateFee {
  const lateMinutes = Math.max(0, actualMinutes - billedMinutes);
  if (lateMinutes <= opts.graceMinutes) {
    return { lateMinutes, amount: 0, explanation: lateMinutes > 0 ? `Returned within the ${opts.graceMinutes}-minute grace period` : 'Returned on time' };
  }
  if (opts.lateFeeMode === 'FIXED_PER_DAY') {
    const days = Math.ceil((lateMinutes - opts.graceMinutes) / 1440);
    return {
      lateMinutes,
      amount: days * opts.lateFeePerDay,
      explanation: `${describeDuration(lateMinutes)} late: ${plural(days, 'day')} × ₹${(opts.lateFeePerDay / 100).toFixed(2)} late fee`,
    };
  }
  const full = priceRental(rates, actualMinutes, opts);
  const billed = priceRental(rates, billedMinutes, { ...opts, graceMinutes: 0 });
  const extra = Math.max(0, full.total - billed.total);
  if (opts.lateFeeMode === 'MULTIPLIER') {
    const amount = mulDivRound(extra, opts.lateMultiplierBp, 10_000);
    return {
      lateMinutes,
      amount,
      explanation: `${describeDuration(lateMinutes)} late: (${full.explanation}) − ₹${(billed.total / 100).toFixed(2)} already charged, × ${opts.lateMultiplierBp / 10_000}`,
    };
  }
  return {
    lateMinutes,
    amount: extra,
    explanation: `${describeDuration(lateMinutes)} late: ${full.explanation}, less ₹${(billed.total / 100).toFixed(2)} already charged`,
  };
}
