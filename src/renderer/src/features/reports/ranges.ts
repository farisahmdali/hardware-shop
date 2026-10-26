import type { DefaultRange } from '@shared/reports';
import { businessDateOf } from '@shared/time';

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function fyStart(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return `${m >= 4 ? y : y - 1}-04-01`;
}

export interface RangePreset {
  key: string;
  label: string;
  from: string;
  to: string;
}

/** Common periods, in the shop's dates. Weeks start on Monday; the financial year on 1 April. */
export function rangePresets(today = businessDateOf(new Date())): RangePreset[] {
  const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const thisWeek = addDays(today, -weekday);
  const lastMonthEnd = addDays(monthStart(today), -1);
  const lastFyEnd = addDays(fyStart(today), -1);
  return [
    { key: 'today', label: 'Today', from: today, to: today },
    { key: 'yesterday', label: 'Yesterday', from: addDays(today, -1), to: addDays(today, -1) },
    { key: 'week', label: 'This week', from: thisWeek, to: today },
    { key: 'lastWeek', label: 'Last week', from: addDays(thisWeek, -7), to: addDays(thisWeek, -1) },
    { key: 'month', label: 'This month', from: monthStart(today), to: today },
    { key: 'lastMonth', label: 'Last month', from: monthStart(lastMonthEnd), to: lastMonthEnd },
    { key: 'last30', label: 'Last 30 days', from: addDays(today, -29), to: today },
    { key: 'year', label: 'This financial year', from: fyStart(today), to: today },
    { key: 'lastYear', label: 'Last financial year', from: fyStart(lastFyEnd), to: lastFyEnd },
    { key: 'next7', label: 'Next 7 days', from: today, to: addDays(today, 7) },
  ];
}

export function presetFor(range: DefaultRange | undefined, today = businessDateOf(new Date())): RangePreset {
  const all = rangePresets(today);
  return all.find((p) => p.key === (range ?? 'month')) ?? all.find((p) => p.key === 'month')!;
}

/** The preset matching a period, if any, so the selector shows "This month" rather than "Custom". */
export function matchPreset(from: string, to: string, today = businessDateOf(new Date())): string {
  return rangePresets(today).find((p) => p.from === from && p.to === to)?.key ?? 'custom';
}
