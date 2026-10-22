/**
 * Money is always an integer number of paise (1 rupee = 100 paise).
 * Never store or add rupee values as floating point numbers.
 */
export type Paise = number;

export function assertPaise(value: number, label = 'amount'): Paise {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a whole number of paise, got ${value}`);
  }
  return value;
}

/**
 * Computes round(a * b / c), rounding halves away from zero, using BigInt so
 * the intermediate product cannot lose precision.
 */
export function mulDivRound(a: number, b: number, c: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(c)) {
    throw new RangeError('mulDivRound expects safe integers');
  }
  if (c === 0) throw new RangeError('mulDivRound division by zero');
  const num = BigInt(a) * BigInt(b);
  const den = BigInt(c);
  const negative = num < 0n !== den < 0n;
  const absNum = num < 0n ? -num : num;
  const absDen = den < 0n ? -den : den;
  let q = absNum / absDen;
  if ((absNum % absDen) * 2n >= absDen) q += 1n;
  const result = Number(negative ? -q : q);
  if (!Number.isSafeInteger(result)) throw new RangeError('mulDivRound overflow');
  return result;
}

/** Rounds paise to the nearest whole rupee (halves away from zero). */
export function roundToRupee(paise: Paise): Paise {
  return mulDivRound(paise, 1, 100) * 100;
}

/** Applies a rate in basis points (1800 = 18%) to an amount, rounded half-up. */
export function applyBasisPoints(paise: Paise, basisPoints: number): Paise {
  return mulDivRound(paise, basisPoints, 10_000);
}

export function sumPaise(values: readonly Paise[]): Paise {
  let total = 0;
  for (const v of values) total += assertPaise(v);
  return assertPaise(total, 'total');
}

const MONEY_PATTERN = /^(-)?(\d{1,13})(?:\.(\d{1,2}))?$/;

/**
 * Parses a user-entered rupee amount ("1,234.50", "₹ 99", "12.5") into paise.
 * Returns null for anything that is not a valid amount with at most 2 decimals.
 */
export function parseMoney(input: string): Paise | null {
  const cleaned = input.replace(/^\s*(Rs\.?|INR)/i, '').replace(/[₹,\s]/g, '');
  if (cleaned === '') return null;
  const m = MONEY_PATTERN.exec(cleaned);
  if (!m) return null;
  const value = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(value)) return null;
  return m[1] ? -value : value;
}

const groupFormatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** Formats paise for display using Indian digit grouping, e.g. ₹1,23,456.78. */
export function formatMoney(paise: Paise, opts: { symbol?: boolean } = {}): string {
  assertPaise(paise);
  const abs = Math.abs(paise);
  // Integer arithmetic keeps the text exact; Intl only inserts the digit grouping.
  const rupees = groupFormatter.format(Math.trunc(abs / 100));
  const text = `${opts.symbol === false ? '' : '₹'}${rupees}.${String(abs % 100).padStart(2, '0')}`;
  return paise < 0 ? `-${text}` : text;
}

/** Converts paise to a plain decimal string ("1234.50") for inputs and exports. */
export function paiseToDecimalString(paise: Paise): string {
  assertPaise(paise);
  const abs = Math.abs(paise);
  return `${paise < 0 ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
