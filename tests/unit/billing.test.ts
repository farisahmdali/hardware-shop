import { describe, expect, it } from 'vitest';
import { amountInWords, computeBill, proportionalShare, spread, splitTax } from '@shared/billing';

const intra = { interstate: false, gstRegistered: true, roundTotal: false };

describe('GST calculation', () => {
  it('extracts GST from a tax-inclusive price so the customer pays the shelf price', () => {
    const r = computeBill([{ unitPrice: 45000, qty: 1000, gstRateBp: 1800, priceIncludesTax: true }], intra);
    expect(r.lines[0]).toMatchObject({ gross: 45000, taxable: 38136, cgst: 3432, sgst: 3432, igst: 0, lineTotal: 45000 });
    expect(r.grandTotal).toBe(45000);
  });

  it('adds GST to a tax-exclusive price', () => {
    const r = computeBill([{ unitPrice: 10000, qty: 3000, gstRateBp: 1800, priceIncludesTax: false }], intra);
    expect(r.lines[0]).toMatchObject({ taxable: 30000, cgst: 2700, sgst: 2700, lineTotal: 35400 });
  });

  it('uses IGST for a customer in another state', () => {
    const r = computeBill([{ unitPrice: 10000, qty: 1000, gstRateBp: 1800, priceIncludesTax: false }], { ...intra, interstate: true });
    expect(r).toMatchObject({ cgstTotal: 0, sgstTotal: 0, igstTotal: 1800, grandTotal: 11800 });
  });

  it('splits an odd paisa of tax between CGST and SGST without losing it', () => {
    expect(splitTax(181, false)).toEqual({ cgst: 91, sgst: 90, igst: 0 });
    const r = computeBill([{ unitPrice: 1005, qty: 1000, gstRateBp: 1800, priceIncludesTax: false }], intra);
    expect(r.cgstTotal + r.sgstTotal).toBe(181);
  });

  it('charges no GST for a shop that is not registered', () => {
    const r = computeBill([{ unitPrice: 45000, qty: 1000, gstRateBp: 1800, priceIncludesTax: true }], { ...intra, gstRegistered: false });
    expect(r).toMatchObject({ taxableTotal: 45000, cgstTotal: 0, sgstTotal: 0, grandTotal: 45000 });
  });

  it('handles fractional quantities', () => {
    // 2.5 m at ₹55.00 per metre
    const r = computeBill([{ unitPrice: 5500, qty: 2500, gstRateBp: 1800, priceIncludesTax: true }], intra);
    expect(r.lines[0]!.gross).toBe(13750);
    expect(r.grandTotal).toBe(13750);
  });
});

describe('discounts', () => {
  it('applies line discounts as an amount or a percentage, before tax', () => {
    const r = computeBill(
      [
        { unitPrice: 10000, qty: 1000, gstRateBp: 1800, priceIncludesTax: false, discount: { type: 'AMOUNT', value: 1000 } },
        { unitPrice: 20000, qty: 1000, gstRateBp: 1800, priceIncludesTax: false, discount: { type: 'PERCENT', valueBp: 1000 } },
      ],
      intra,
    );
    expect(r.lines.map((l) => l.taxable)).toEqual([9000, 18000]);
    expect(r.discountTotal).toBe(3000);
  });

  it('never discounts below zero', () => {
    const r = computeBill([{ unitPrice: 1000, qty: 1000, gstRateBp: 0, priceIncludesTax: true, discount: { type: 'AMOUNT', value: 5000 } }], intra);
    expect(r.lines[0]!.lineDiscount).toBe(1000);
    expect(r.grandTotal).toBe(0);
  });

  it('spreads a bill discount across lines exactly', () => {
    expect(spread(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(spread(0, [5, 5])).toEqual([0, 0]);
    const r = computeBill(
      [
        { unitPrice: 33333, qty: 1000, gstRateBp: 1800, priceIncludesTax: true },
        { unitPrice: 66667, qty: 1000, gstRateBp: 500, priceIncludesTax: true },
      ],
      { ...intra, billDiscount: { type: 'AMOUNT', value: 10001 } },
    );
    expect(r.lines.reduce((a, l) => a + l.billDiscount, 0)).toBe(10001);
    expect(r.grandTotal).toBe(100000 - 10001);
    expect(r.byRate.map((b) => b.gstRateBp)).toEqual([500, 1800]);
  });
});

describe('round-off', () => {
  it('rounds the total to the nearest rupee and records the difference', () => {
    const r = computeBill([{ unitPrice: 10050, qty: 1000, gstRateBp: 1800, priceIncludesTax: false }], { ...intra, roundTotal: true });
    // 100.50 + 18.09 = 118.59 -> 119.00
    expect(r).toMatchObject({ grandTotal: 11900, roundOff: 41 });
    expect(r.taxableTotal + r.cgstTotal + r.sgstTotal + r.igstTotal + r.roundOff).toBe(r.grandTotal);
  });

  it('rounds down when below half a rupee', () => {
    const r = computeBill([{ unitPrice: 10020, qty: 1000, gstRateBp: 0, priceIncludesTax: true }], { ...intra, roundTotal: true });
    expect(r).toMatchObject({ grandTotal: 10000, roundOff: -20 });
  });
});

describe('partial returns', () => {
  it('returns proportional amounts that add up exactly over several returns', () => {
    const amount = 10000;
    const parts = [proportionalShare(amount, 3000, 0, 1000), proportionalShare(amount, 3000, 1000, 1000), proportionalShare(amount, 3000, 2000, 1000)];
    expect(parts.reduce((a, b) => a + b, 0)).toBe(amount);
    expect(parts).toEqual([3333, 3334, 3333]);
  });
});

describe('amount in words', () => {
  it('uses lakh and crore', () => {
    expect(amountInWords(45000)).toBe('Rupees Four Hundred Fifty Only');
    expect(amountInWords(12345678)).toBe('Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only');
    expect(amountInWords(1_00_00_000_00)).toBe('Rupees One Crore Only');
    expect(amountInWords(0)).toBe('Rupees Zero Only');
  });
});
