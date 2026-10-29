/**
 * What the AI model is asked for when reading a supplier's bill, and turning its answer into
 * checked values. The model's answer is never trusted as is: every amount, quantity, rate, date and
 * GSTIN is parsed and validated here, and anything doubtful becomes a warning for the person
 * checking the bill.
 */
import { z } from 'zod';
import { GST_RATES_BP } from '@shared/stock';
import { GST_STATES, isValidGstin } from '@shared/gstStates';

export const BILL_PROMPT = `You read purchase bills (tax invoices) that Indian hardware suppliers give to a hardware shop.
Read the attached bill and return its contents as JSON in the requested format. Rules:
- "supplier" is the SELLER who issued the bill, not the buyer ("Bill to", "Buyer", "Consignee" is the shop; ignore the buyer's details).
- Copy text exactly as printed. Do not invent anything: use null for anything not printed or unreadable.
- Numbers as plain numbers without currency symbols or thousands separators (e.g. 1234.5).
- "items": one entry per item line, in order. "quantity" and "unit" as printed (NOS, PCS, BOX, KG, MTR, ...).
  "rate" is the price per unit as printed. "amount" is the line amount as printed.
  "gstPercent" is the TOTAL GST rate of the line (CGST + SGST, or IGST), e.g. 18 for CGST 9% + SGST 9%.
  "discountPercent" / "discountAmount": the line's discount, if any.
- "ratesIncludeGst": true only if the item rates already include GST (e.g. "rate incl. tax"); usual tax invoices list rates before GST.
- "billDiscountPercent" / "billDiscountAmount": a discount on the whole bill (cash discount, trade discount), not on one line.
- "freight": transport, freight, cartage, packing or loading charges added to the bill; "freightNote" what they are for.
- "roundOff": the round-off printed (negative if it reduces the total).
- "grandTotal": the final bill amount payable.
- "billDate" as printed (Indian bills are day-month-year).
- "isBill": false if the image is not a purchase bill or invoice.`;

const nullable = (type: 'string' | 'number' | 'boolean') => ({ type: [type, 'null'] });

/** JSON schema of the answer, for models that support structured output. */
export const BILL_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'isBill', 'supplier', 'billNumber', 'billDate', 'ratesIncludeGst', 'items',
    'billDiscountPercent', 'billDiscountAmount', 'freight', 'freightNote', 'roundOff', 'grandTotal',
  ],
  properties: {
    isBill: { type: 'boolean' },
    supplier: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'gstin', 'address', 'phone', 'state'],
      properties: { name: nullable('string'), gstin: nullable('string'), address: nullable('string'), phone: nullable('string'), state: nullable('string') },
    },
    billNumber: nullable('string'),
    billDate: nullable('string'),
    ratesIncludeGst: nullable('boolean'),
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'hsn', 'quantity', 'unit', 'rate', 'discountPercent', 'discountAmount', 'gstPercent', 'amount'],
        properties: {
          description: { type: 'string' },
          hsn: nullable('string'),
          quantity: nullable('number'),
          unit: nullable('string'),
          rate: nullable('number'),
          discountPercent: nullable('number'),
          discountAmount: nullable('number'),
          gstPercent: nullable('number'),
          amount: nullable('number'),
        },
      },
    },
    billDiscountPercent: nullable('number'),
    billDiscountAmount: nullable('number'),
    freight: nullable('number'),
    freightNote: nullable('string'),
    roundOff: nullable('number'),
    grandTotal: nullable('number'),
  },
} as const;

// The model may answer numbers as strings ("1,234.00", "₹ 450/-"); they are parsed below.
const loose = z.union([z.number(), z.string(), z.boolean(), z.null()]).optional();
const answerSchema = z.object({
  isBill: loose,
  supplier: z
    .object({ name: loose, gstin: loose, address: loose, phone: loose, state: loose })
    .partial()
    .nullable()
    .optional(),
  billNumber: loose,
  billDate: loose,
  ratesIncludeGst: loose,
  items: z
    .array(
      z
        .object({
          description: loose,
          hsn: loose,
          quantity: loose,
          unit: loose,
          rate: loose,
          discountPercent: loose,
          discountAmount: loose,
          gstPercent: loose,
          amount: loose,
        })
        .partial(),
    )
    .nullable()
    .optional(),
  billDiscountPercent: loose,
  billDiscountAmount: loose,
  freight: loose,
  freightNote: loose,
  roundOff: loose,
  grandTotal: loose,
});

// ---------- Parsing values ----------

export function parseDecimal(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  let t = value.trim().replace(/^(rs\.?|inr|₹)\s*/i, '').replace(/[₹,\s]/g, '').replace(/\/-$/, '');
  let negative = false;
  if (/^\(.*\)$/.test(t)) {
    negative = true;
    t = t.slice(1, -1);
  }
  if (t.endsWith('-') && !t.startsWith('-')) {
    negative = true;
    t = t.slice(0, -1);
  }
  const m = /^[-+]?\d*\.?\d+/.exec(t);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

export const toPaise = (value: unknown): number | null => {
  const n = parseDecimal(value);
  return n === null ? null : Math.round(n * 100);
};

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : typeof value === 'number' ? String(value) : '');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A bill date as printed (day first, as in India) to yyyy-mm-dd; null when it is not a real date. */
export function parseBillDate(value: unknown): string | null {
  const t = text(value, 40).toLowerCase();
  if (!t) return null;
  let y: number, m: number, d: number;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(t))) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})$/.exec(t))) [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})(?:st|nd|rd|th)?[-/. ]*([a-z]{3,9})[-/., ]*(\d{2,4})$/.exec(t))) {
    d = Number(r[1]);
    m = MONTHS.indexOf(r[2]!.slice(0, 3)) + 1;
    y = Number(r[3]);
  } else if ((r = /^([a-z]{3,9})[-/. ]*(\d{1,2})(?:st|nd|rd|th)?[-/., ]*(\d{4})$/.exec(t))) {
    m = MONTHS.indexOf(r[1]!.slice(0, 3)) + 1;
    d = Number(r[2]);
    y = Number(r[3]);
  } else return null;
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || y < 2000 || y > 2100) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** A GST rate as a valid slab in basis points. CGST or SGST alone (half a slab) is doubled. */
export function gstRateFrom(value: unknown): { bp: number | null; halved: boolean } {
  const n = parseDecimal(value);
  if (n === null) return { bp: null, halved: false };
  const bp = Math.round(n * 100);
  const valid = GST_RATES_BP as readonly number[];
  if (valid.includes(bp)) return { bp, halved: false };
  if (valid.includes(bp * 2)) return { bp: bp * 2, halved: true };
  return { bp: null, halved: false };
}

export function stateCodeFrom(gstin: string, state: string): string {
  if (gstin) return gstin.slice(0, 2);
  const t = state.toLowerCase().replace(/[^a-z]/g, '');
  if (!t) return '';
  return GST_STATES.find((s) => s.name.toLowerCase().replace(/[^a-z]/g, '') === t)?.code ?? '';
}

// ---------- The answer ----------

export interface ReadLine {
  text: string;
  hsnCode: string;
  unitText: string;
  /** Milli-units; 0 when it could not be read. */
  qty: number;
  rate: number;
  discountBp: number;
  gstRateBp: number;
  printedAmount: number | null;
}

export interface ReadBill {
  supplier: { name: string; gstin: string; stateCode: string; phone: string; address: string };
  billNo: string;
  billDate: string | null;
  pricesIncludeTax: boolean;
  lines: ReadLine[];
  additionalCosts: number;
  additionalCostsNote: string;
  roundOff: number;
  printedTotal: number | null;
  warnings: string[];
}

export class UnreadableAnswer extends Error {}

/** The JSON object in a model's answer, which may be wrapped in a code block or prose. */
export function extractJson(answer: string): unknown {
  const t = answer.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const body = fenced ? fenced[1]! : t;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new UnreadableAnswer('The answer contains no JSON object.');
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new UnreadableAnswer('The answer is not valid JSON.');
  }
}

export const MAX_LINES = 300;

/** Checks and converts the model's answer. `shopGstin` keeps the shop's own GSTIN from being taken for the supplier's. */
export function readBillAnswer(raw: unknown, opts: { shopGstin: string; today: string }): ReadBill {
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) throw new UnreadableAnswer('The answer does not have the expected fields.');
  const a = parsed.data;
  if (a.isBill === false) throw new UnreadableAnswer('NOT_A_BILL');
  const warnings: string[] = [];

  let gstin = text(a.supplier?.gstin, 20).toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (gstin && !isValidGstin(gstin)) {
    warnings.push(`The supplier's GSTIN on the bill (${gstin}) is not a valid GSTIN. Check it.`);
    gstin = '';
  } else if (gstin && opts.shopGstin && gstin === opts.shopGstin.toUpperCase()) {
    gstin = ''; // the shop's own GSTIN, printed in the buyer's details
  }

  let billDate = parseBillDate(a.billDate);
  if (a.billDate && !billDate) warnings.push(`The bill date "${text(a.billDate, 40)}" could not be read. Enter it.`);
  if (billDate && billDate > opts.today) {
    warnings.push(`The bill date read (${billDate}) is in the future. Check it.`);
    billDate = null;
  }

  let halved = false;
  let gstUnread = 0;
  const items = (a.items ?? []).slice(0, MAX_LINES);
  if ((a.items ?? []).length > MAX_LINES) warnings.push(`The bill has more than ${MAX_LINES} items; only the first ${MAX_LINES} were read.`);
  const lines: ReadLine[] = [];
  items.forEach((it, i) => {
    const description = text(it.description, 200);
    const qtyN = parseDecimal(it.quantity);
    let rate = toPaise(it.rate);
    const amount = toPaise(it.amount);
    if (!description && rate === null && amount === null) return;
    const qty = qtyN !== null && qtyN > 0 ? Math.round(qtyN * 1000) : 0;
    let discountBp = 0;
    const dPct = parseDecimal(it.discountPercent);
    const dAmt = toPaise(it.discountAmount);
    if (rate === null && amount !== null && qty > 0) rate = Math.round((amount * 1000) / qty);
    if (dPct !== null && dPct > 0 && dPct < 100) discountBp = Math.round(dPct * 100);
    else if (dAmt !== null && dAmt > 0 && rate && qty) discountBp = Math.min(10_000, Math.round((dAmt * 10_000 * 1000) / (rate * qty)));
    const gst = gstRateFrom(it.gstPercent);
    halved ||= gst.halved;
    if (gst.bp === null && it.gstPercent !== null && it.gstPercent !== undefined) gstUnread++;
    const n = i + 1;
    if (!qty) warnings.push(`Item ${n} (${description || 'no description'}): the quantity could not be read.`);
    if (rate === null || rate < 0) warnings.push(`Item ${n} (${description || 'no description'}): the rate could not be read.`);
    lines.push({
      text: description || `Item ${n}`,
      hsnCode: text(it.hsn, 12).replace(/\D/g, '').slice(0, 8),
      unitText: text(it.unit, 12),
      qty,
      rate: Math.max(0, rate ?? 0),
      discountBp,
      gstRateBp: gst.bp ?? 0,
      printedAmount: amount,
    });
  });
  if (halved) warnings.push('Some GST rates were printed as CGST or SGST alone; the full rate (CGST + SGST) is used.');
  if (gstUnread) warnings.push(`The GST rate of ${gstUnread} item${gstUnread > 1 ? 's' : ''} could not be read; check the GST column.`);

  // A discount on the whole bill is spread over the items as an extra percentage.
  const billPct = parseDecimal(a.billDiscountPercent);
  const billAmt = toPaise(a.billDiscountAmount);
  const net = (l: ReadLine) => Math.round(((l.rate * l.qty) / 1000) * (1 - l.discountBp / 10_000));
  const itemsTotal = lines.reduce((s, l) => s + net(l), 0);
  let extraBp = 0;
  if (billPct !== null && billPct > 0 && billPct < 100) extraBp = Math.round(billPct * 100);
  else if (billAmt !== null && billAmt > 0 && itemsTotal > 0) extraBp = Math.round((billAmt * 10_000) / itemsTotal);
  if (extraBp > 0 && extraBp < 10_000) {
    for (const l of lines) l.discountBp = Math.round(10_000 - ((10_000 - l.discountBp) * (10_000 - extraBp)) / 10_000);
    warnings.push(`The bill's overall discount (${extraBp / 100}%) has been added to each item's discount.`);
  }

  const freight = toPaise(a.freight);
  const roundOff = toPaise(a.roundOff) ?? 0;
  const supplierName = text(a.supplier?.name, 120);
  if (!supplierName && !gstin) warnings.push("The supplier's name could not be read.");
  return {
    supplier: {
      name: supplierName,
      gstin,
      stateCode: stateCodeFrom(gstin, text(a.supplier?.state, 60)),
      phone: text(a.supplier?.phone, 20),
      address: text(a.supplier?.address, 300),
    },
    billNo: text(a.billNumber, 40),
    billDate,
    pricesIncludeTax: a.ratesIncludeGst === true,
    lines,
    additionalCosts: freight !== null && freight > 0 ? freight : 0,
    additionalCostsNote: freight ? text(a.freightNote, 120) || 'Freight / other charges on the bill' : '',
    roundOff: Math.abs(roundOff) <= 10_000 ? roundOff : 0,
    printedTotal: toPaise(a.grandTotal),
    warnings,
  };
}
