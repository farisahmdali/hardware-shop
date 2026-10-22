import { describe, expect, it } from 'vitest';
import { applyBasisPoints, formatMoney, mulDivRound, paiseToDecimalString, parseMoney, roundToRupee } from '@shared/money';
import { formatQty, parseQty } from '@shared/qty';
import { businessDateOf, fiscalYearOf } from '@shared/time';
import { formatDocNumber } from '@shared/docNumbers';
import { isValidGstin } from '@shared/gstStates';

describe('money', () => {
  it('parses user input into exact paise', () => {
    expect(parseMoney('1,234.50')).toBe(123450);
    expect(parseMoney('₹ 99')).toBe(9900);
    expect(parseMoney('12.5')).toBe(1250);
    expect(parseMoney('0.07')).toBe(7);
    expect(parseMoney('Rs. 10')).toBe(1000);
    expect(parseMoney('-5.25')).toBe(-525);
  });

  it('rejects ambiguous or invalid amounts', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('1.234')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('1e3')).toBeNull();
  });

  it('formats with Indian digit grouping', () => {
    expect(formatMoney(12345678)).toBe('₹1,23,456.78');
    expect(formatMoney(5)).toBe('₹0.05');
    expect(formatMoney(-150000)).toBe('-₹1,500.00');
    expect(formatMoney(100, { symbol: false })).toBe('1.00');
    expect(paiseToDecimalString(-1205)).toBe('-12.05');
  });

  it('rounds halves away from zero without floating point error', () => {
    expect(mulDivRound(5, 1, 2)).toBe(3);
    expect(mulDivRound(-5, 1, 2)).toBe(-3);
    expect(mulDivRound(4, 1, 3)).toBe(1);
    // 0.1 + 0.2 style traps: 18% of ₹10.05 = 180.9 paise -> 181
    expect(applyBasisPoints(1005, 1800)).toBe(181);
    expect(roundToRupee(12350)).toBe(12400);
    expect(roundToRupee(12349)).toBe(12300);
    expect(mulDivRound(Number.MAX_SAFE_INTEGER, 10_000, 10_000)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('refuses non-integer inputs', () => {
    expect(() => mulDivRound(1.5, 1, 1)).toThrow();
  });
});

describe('quantities', () => {
  it('stores up to three decimals exactly', () => {
    expect(parseQty('2.5', true)).toBe(2500);
    expect(parseQty('0.125', true)).toBe(125);
    expect(parseQty('3', false)).toBe(3000);
    expect(parseQty('3.000', false)).toBe(3000);
  });
  it('rejects decimals for whole-number units', () => {
    expect(parseQty('2.5', false)).toBeNull();
    expect(parseQty('1.0001', true)).toBeNull();
    expect(parseQty('-1', true)).toBeNull();
  });
  it('formats compactly', () => {
    expect(formatQty(2500)).toBe('2.5');
    expect(formatQty(1_250_000)).toBe('1,250');
    expect(formatQty(-125)).toBe('-0.125');
  });
});

describe('dates and numbering', () => {
  it('uses the shop-local calendar date', () => {
    // 20:00 UTC on 21 Oct is 01:30 on 22 Oct in India.
    expect(businessDateOf('2026-10-21T20:00:00Z')).toBe('2026-10-22');
    expect(businessDateOf('2026-10-21T18:29:59Z')).toBe('2026-10-21');
  });
  it('maps dates to the April–March financial year', () => {
    expect(fiscalYearOf('2026-03-31')).toBe('2025-26');
    expect(fiscalYearOf('2026-04-01')).toBe('2026-27');
    expect(fiscalYearOf('2099-12-31')).toBe('2099-00');
  });
  it('formats document numbers', () => {
    expect(formatDocNumber('INV', '2026-27', 42)).toBe('INV/2026-27/00042');
  });
});

describe('GSTIN', () => {
  it('validates the check character', () => {
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
    expect(isValidGstin('27AAPFU0939F1ZX')).toBe(false);
    expect(isValidGstin('27AAPFU0939F1Z')).toBe(false);
  });
});
