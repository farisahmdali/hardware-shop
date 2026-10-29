import { describe, expect, it } from 'vitest';
import { extractJson, gstRateFrom, parseBillDate, parseDecimal, readBillAnswer, stateCodeFrom, toPaise, UnreadableAnswer } from '@main/services/ai/billRead';

const opts = { shopGstin: '27AAPFU0939F1ZV', today: '2026-10-29' };
const answer = (o: Record<string, unknown> = {}) => ({
  isBill: true,
  supplier: { name: 'Mehta Traders', gstin: '29AAACR5055K1Z3', address: 'Bengaluru', phone: '080 2222 3333', state: 'Karnataka' },
  billNumber: 'MT/2026/0412',
  billDate: '12-10-2026',
  ratesIncludeGst: false,
  items: [
    { description: 'SS Butt Hinge 4"', hsn: '8302', quantity: 24, unit: 'NOS', rate: 82, discountPercent: null, discountAmount: null, gstPercent: 18, amount: 1968 },
    { description: 'Fevicol SH 1kg', hsn: '3506', quantity: '6', unit: 'Nos', rate: '₹ 1,240.00', discountPercent: 5, discountAmount: null, gstPercent: 18, amount: '7,068.00' },
  ],
  billDiscountPercent: null,
  billDiscountAmount: null,
  freight: 150,
  freightNote: 'Transport',
  roundOff: -0.44,
  grandTotal: 10817,
  ...o,
});

describe('parsing values from a bill', () => {
  it('reads amounts as printed', () => {
    expect(parseDecimal('₹ 1,23,456.50')).toBe(123456.5);
    expect(parseDecimal('Rs. 450/-')).toBe(450);
    expect(parseDecimal('(12.40)')).toBe(-12.4);
    expect(parseDecimal('0.44-')).toBe(-0.44);
    expect(parseDecimal(18)).toBe(18);
    expect(parseDecimal('abc')).toBeNull();
    expect(parseDecimal(null)).toBeNull();
    expect(toPaise('1,240.005')).toBe(124001);
  });

  it('reads dates day first and refuses dates that do not exist', () => {
    expect(parseBillDate('12-10-2026')).toBe('2026-10-12');
    expect(parseBillDate('05/03/26')).toBe('2026-03-05');
    expect(parseBillDate('5.3.2026')).toBe('2026-03-05');
    expect(parseBillDate('2026-10-12')).toBe('2026-10-12');
    expect(parseBillDate('12 Oct 2026')).toBe('2026-10-12');
    expect(parseBillDate('12-Oct-26')).toBe('2026-10-12');
    expect(parseBillDate('3rd March, 2026')).toBe('2026-03-03');
    expect(parseBillDate('October 12, 2026')).toBe('2026-10-12');
    expect(parseBillDate('31-02-2026')).toBeNull();
    expect(parseBillDate('13-13-2026')).toBeNull();
    expect(parseBillDate('')).toBeNull();
  });

  it('takes GST as a valid slab, doubling CGST or SGST printed alone', () => {
    expect(gstRateFrom(18)).toEqual({ bp: 1800, halved: false });
    expect(gstRateFrom('28%')).toEqual({ bp: 2800, halved: false });
    expect(gstRateFrom(9)).toEqual({ bp: 1800, halved: true });
    expect(gstRateFrom(2.5)).toEqual({ bp: 500, halved: true });
    expect(gstRateFrom(0)).toEqual({ bp: 0, halved: false });
    expect(gstRateFrom(17)).toEqual({ bp: null, halved: false });
  });

  it('finds the state from the GSTIN, or from the state name', () => {
    expect(stateCodeFrom('29AAACR5055K1Z3', '')).toBe('29');
    expect(stateCodeFrom('', 'Tamil Nadu')).toBe('33');
    expect(stateCodeFrom('', 'Atlantis')).toBe('');
  });

  it('finds the JSON in an answer wrapped in prose or a code block', () => {
    expect(extractJson('Here it is:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('{"a":{"b":2}} thanks')).toEqual({ a: { b: 2 } });
    expect(() => extractJson('no json here')).toThrow(UnreadableAnswer);
    expect(() => extractJson('{"a": }')).toThrow(UnreadableAnswer);
  });
});

describe('reading the answer', () => {
  it('converts a bill into checked values', () => {
    const r = readBillAnswer(answer(), opts);
    expect(r.supplier).toEqual({ name: 'Mehta Traders', gstin: '29AAACR5055K1Z3', stateCode: '29', phone: '080 2222 3333', address: 'Bengaluru' });
    expect(r.billNo).toBe('MT/2026/0412');
    expect(r.billDate).toBe('2026-10-12');
    expect(r.pricesIncludeTax).toBe(false);
    expect(r.lines).toEqual([
      { text: 'SS Butt Hinge 4"', hsnCode: '8302', unitText: 'NOS', qty: 24_000, rate: 8200, discountBp: 0, gstRateBp: 1800, printedAmount: 196_800 },
      { text: 'Fevicol SH 1kg', hsnCode: '3506', unitText: 'Nos', qty: 6000, rate: 124_000, discountBp: 500, gstRateBp: 1800, printedAmount: 706_800 },
    ]);
    expect(r.additionalCosts).toBe(15_000);
    expect(r.additionalCostsNote).toBe('Transport');
    expect(r.roundOff).toBe(-44);
    expect(r.printedTotal).toBe(1_081_700);
    expect(r.warnings).toEqual([]);
  });

  it("does not take the shop's own GSTIN for the supplier's, and flags an invalid one", () => {
    expect(readBillAnswer(answer({ supplier: { name: 'X', gstin: opts.shopGstin } }), opts).supplier.gstin).toBe('');
    const bad = readBillAnswer(answer({ supplier: { name: 'X', gstin: '29AAACR5055K1Z9' } }), opts);
    expect(bad.supplier.gstin).toBe('');
    expect(bad.warnings[0]).toMatch(/not a valid GSTIN/);
  });

  it('warns about what it could not read, and never invents it', () => {
    const r = readBillAnswer(
      answer({
        billDate: '2027-01-05',
        items: [
          { description: 'Wire', quantity: null, rate: null, amount: null, gstPercent: 9 },
          { description: 'Tape', quantity: 2, rate: null, amount: 300, gstPercent: 'x' },
        ],
      }),
      opts,
    );
    expect(r.billDate).toBeNull();
    expect(r.lines[0]).toMatchObject({ qty: 0, rate: 0, gstRateBp: 1800 });
    expect(r.lines[1]).toMatchObject({ qty: 2000, rate: 15_000, gstRateBp: 0 });
    expect(r.warnings).toEqual([
      'The bill date read (2027-01-05) is in the future. Check it.',
      'Item 1 (Wire): the quantity could not be read.',
      'Item 1 (Wire): the rate could not be read.',
      'Some GST rates were printed as CGST or SGST alone; the full rate (CGST + SGST) is used.',
      'The GST rate of 1 item could not be read; check the GST column.',
    ]);
  });

  it("spreads a discount on the whole bill over the items", () => {
    const r = readBillAnswer(answer({ billDiscountPercent: 2 }), opts);
    expect(r.lines.map((l) => l.discountBp)).toEqual([200, 690]);
    expect(r.warnings).toContain("The bill's overall discount (2%) has been added to each item's discount.");
  });

  it('refuses something that is not a bill, and an answer without the fields', () => {
    expect(() => readBillAnswer(answer({ isBill: false }), opts)).toThrow('NOT_A_BILL');
    expect(() => readBillAnswer({ items: 'lots' }, opts)).toThrow(UnreadableAnswer);
  });
});
