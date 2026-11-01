import { describe, expect, it } from 'vitest';
import { matchPreset } from '../../src/renderer/src/features/reports/ranges';

describe('the period shown in the selector', () => {
  it('names a period by its preset, or custom', () => {
    expect(matchPreset('2026-10-01', '2026-10-15', undefined, '2026-10-15')).toBe('month');
    expect(matchPreset('2026-10-15', '2026-10-15', undefined, '2026-10-15')).toBe('today');
    expect(matchPreset('2026-10-03', '2026-10-09', undefined, '2026-10-15')).toBe('custom');
  });

  it('keeps the period chosen when two cover the same days', () => {
    // On the 1st, "This month" is only today; on a Monday, so is "This week".
    expect(matchPreset('2026-11-01', '2026-11-01', 'month', '2026-11-01')).toBe('month');
    expect(matchPreset('2026-11-02', '2026-11-02', 'week', '2026-11-02')).toBe('week');
    expect(matchPreset('2026-11-01', '2026-11-01', 'today', '2026-11-01')).toBe('today');
    // A choice the dates no longer match is not kept.
    expect(matchPreset('2026-11-01', '2026-11-01', 'lastMonth', '2026-11-01')).toBe('today');
  });
});
