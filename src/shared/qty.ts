/**
 * Quantities are stored as integer milli-units (1 unit = 1000) so that
 * kilograms, metres and litres can carry up to three decimals exactly.
 */
export type MilliQty = number;

export const QTY_SCALE = 1000;

const QTY_PATTERN = /^(\d{1,12})(?:\.(\d{1,3}))?$/;

/** Parses a user-entered quantity. Returns null if invalid or if the unit does not allow decimals. */
export function parseQty(input: string, allowDecimal: boolean): MilliQty | null {
  const m = QTY_PATTERN.exec(input.replace(/[,\s]/g, ''));
  if (!m) return null;
  const fraction = Number((m[2] ?? '').padEnd(3, '0'));
  if (!allowDecimal && fraction !== 0) return null;
  const value = Number(m[1]) * QTY_SCALE + fraction;
  return Number.isSafeInteger(value) ? value : null;
}

const groupFormatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export function formatQty(milli: MilliQty): string {
  const abs = Math.abs(milli);
  const frac = abs % QTY_SCALE;
  const fracText = frac === 0 ? '' : `.${String(frac).padStart(3, '0').replace(/0+$/, '')}`;
  return `${milli < 0 ? '-' : ''}${groupFormatter.format(Math.trunc(abs / QTY_SCALE))}${fracText}`;
}

/** Converts a quantity to the plain decimal string used in inputs and exports ("2.5"). */
export function qtyToDecimalString(milli: MilliQty): string {
  return formatQty(milli).replace(/,/g, '');
}
