import { mulDivRound, roundToRupee } from './money';

/**
 * The billing calculation, shared by the counter screen (live totals) and the main
 * process (the figures actually saved). All amounts are integer paise, quantities milli-units.
 *
 * Order of calculation for each line:
 *   gross        = unit price × quantity               (as entered: incl. or excl. GST)
 *   − line discount (amount, or % of gross)
 *   − share of the bill discount (spread by value, exact to the paisa)
 *   = net, from which the taxable value and GST are derived:
 *       price incl. GST: taxable = round(net × 100 / (100 + rate)), GST = net − taxable
 *       price excl. GST: taxable = net, GST = round(net × rate / 100)
 *   GST is split CGST = round(GST / 2), SGST = GST − CGST, or all IGST for another state.
 * The invoice total is the sum of line totals, optionally rounded to the rupee with an explicit round-off.
 */

export type Discount = { type: 'AMOUNT'; value: number } | { type: 'PERCENT'; valueBp: number };

export interface BillLineInput {
  unitPrice: number;
  qty: number;
  gstRateBp: number;
  priceIncludesTax: boolean;
  discount?: Discount | null;
}

export interface BillOptions {
  interstate: boolean;
  gstRegistered: boolean;
  roundTotal: boolean;
  billDiscount?: Discount | null;
}

export interface BillLineResult {
  gross: number;
  lineDiscount: number;
  billDiscount: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  lineTotal: number;
}

export interface BillResult {
  lines: BillLineResult[];
  grossTotal: number;
  discountTotal: number;
  taxableTotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  roundOff: number;
  grandTotal: number;
  /** Tax summary by GST rate, for the invoice footer. */
  byRate: { gstRateBp: number; taxable: number; cgst: number; sgst: number; igst: number }[];
}

function discountAmount(base: number, d: Discount | null | undefined): number {
  if (!d || base <= 0) return 0;
  const raw = d.type === 'AMOUNT' ? d.value : mulDivRound(base, d.valueBp, 10_000);
  return Math.max(0, Math.min(base, raw));
}

/** Splits `total` across `weights` in proportion, so the parts always add up exactly (largest remainder). */
export function spread(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || sum === 0) return weights.map(() => 0);
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  let remainder = total - parts.reduce((a, b) => a + b, 0);
  const order = weights
    .map((w, i) => ({ i, frac: (total * w) / sum - parts[i]! }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0; k = (k + 1) % order.length, remainder--) parts[order[k]!.i]! += 1;
  return parts;
}

export function splitTax(tax: number, interstate: boolean): { cgst: number; sgst: number; igst: number } {
  if (interstate) return { cgst: 0, sgst: 0, igst: tax };
  const cgst = mulDivRound(tax, 1, 2);
  return { cgst, sgst: tax - cgst, igst: 0 };
}

export function computeBill(inputs: BillLineInput[], opts: BillOptions): BillResult {
  const gross = inputs.map((l) => mulDivRound(l.unitPrice, l.qty, 1000));
  const lineDiscount = inputs.map((l, i) => discountAmount(gross[i]!, l.discount));
  const afterLine = gross.map((g, i) => g - lineDiscount[i]!);
  const billDiscountTotal = discountAmount(afterLine.reduce((a, b) => a + b, 0), opts.billDiscount);
  const billShare = spread(billDiscountTotal, afterLine);

  const lines: BillLineResult[] = inputs.map((l, i) => {
    const net = afterLine[i]! - billShare[i]!;
    let taxable = net;
    let tax = 0;
    if (opts.gstRegistered && l.gstRateBp > 0) {
      if (l.priceIncludesTax) {
        taxable = mulDivRound(net, 10_000, 10_000 + l.gstRateBp);
        tax = net - taxable;
      } else {
        tax = mulDivRound(net, l.gstRateBp, 10_000);
      }
    }
    const { cgst, sgst, igst } = splitTax(tax, opts.interstate);
    return {
      gross: gross[i]!,
      lineDiscount: lineDiscount[i]!,
      billDiscount: billShare[i]!,
      taxable,
      cgst,
      sgst,
      igst,
      lineTotal: taxable + cgst + sgst + igst,
    };
  });

  const sum = (f: (l: BillLineResult) => number) => lines.reduce((a, l) => a + f(l), 0);
  const exact = sum((l) => l.lineTotal);
  const grandTotal = opts.roundTotal ? roundToRupee(exact) : exact;

  const rates = new Map<number, { gstRateBp: number; taxable: number; cgst: number; sgst: number; igst: number }>();
  inputs.forEach((l, i) => {
    const rate = opts.gstRegistered ? l.gstRateBp : 0;
    const r = rates.get(rate) ?? { gstRateBp: rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    r.taxable += lines[i]!.taxable;
    r.cgst += lines[i]!.cgst;
    r.sgst += lines[i]!.sgst;
    r.igst += lines[i]!.igst;
    rates.set(rate, r);
  });

  return {
    lines,
    grossTotal: sum((l) => l.gross),
    discountTotal: sum((l) => l.lineDiscount + l.billDiscount),
    taxableTotal: sum((l) => l.taxable),
    cgstTotal: sum((l) => l.cgst),
    sgstTotal: sum((l) => l.sgst),
    igstTotal: sum((l) => l.igst),
    roundOff: grandTotal - exact,
    grandTotal,
    byRate: [...rates.values()].sort((a, b) => a.gstRateBp - b.gstRateBp),
  };
}

/**
 * The share of a line's amount that belongs to `qty` units returned, given `alreadyReturned`.
 * Uses cumulative rounding so returning a line in several parts adds up exactly to the original.
 */
export function proportionalShare(amount: number, totalQty: number, alreadyReturned: number, qty: number): number {
  return mulDivRound(amount, alreadyReturned + qty, totalQty) - mulDivRound(amount, alreadyReturned, totalQty);
}

// ---------- Amount in words (Indian numbering) ----------

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number): string {
  return n < 20 ? ONES[n]! : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
}

function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', rest ? belowHundred(rest) : ''].filter(Boolean).join(' ');
}

function integerWords(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;
  if (crore) parts.push(`${integerWords(crore)} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (rest) parts.push(belowThousand(rest));
  return parts.join(' ');
}

/** "Rupees One Thousand Two Hundred Fifty and Fifty Paise Only" */
export function amountInWords(paise: number): string {
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  return `${paise < 0 ? 'Minus ' : ''}Rupees ${integerWords(rupees)}${p ? ` and ${belowHundred(p)} Paise` : ''} Only`;
}
