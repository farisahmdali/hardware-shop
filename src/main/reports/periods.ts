import { formatDate } from '@shared/time';

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Monday of the week a date falls in. */
export function weekStart(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((day + 6) % 7));
}

/** SQL expression giving the period key (day, Monday of the week, or YYYY-MM) of a YYYY-MM-DD column. */
export function periodSql(column: string, groupBy: 'day' | 'week' | 'month'): string {
  if (groupBy === 'month') return `substr(${column}, 1, 7)`;
  if (groupBy === 'week') return `date(${column}, '-' || ((CAST(strftime('%w', ${column}) AS INTEGER) + 6) % 7) || ' days')`;
  return column;
}

/** Every period key from `from` to `to`, so periods without activity still show as zero. */
export function periodKeys(from: string, to: string, groupBy: 'day' | 'week' | 'month'): string[] {
  const keys: string[] = [];
  if (groupBy === 'month') {
    let [y, m] = from.split('-').map(Number) as [number, number];
    const end = to.slice(0, 7);
    for (;;) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      keys.push(key);
      if (key >= end || keys.length > 600) break;
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return keys;
  }
  const step = groupBy === 'week' ? 7 : 1;
  for (let d = groupBy === 'week' ? weekStart(from) : from; d <= to && keys.length < 1000; d = addDays(d, step)) keys.push(d);
  return keys;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function periodLabel(key: string, groupBy: 'day' | 'week' | 'month'): string {
  if (groupBy === 'month') return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
  if (groupBy === 'week') return `Week of ${formatDate(key)}`;
  return formatDate(key);
}

/**
 * Start and end instants (UTC ISO) of a range of shop dates. The shop's time zone is India
 * (UTC+05:30, no daylight saving), the same zone business dates are recorded in.
 */
export function rangeInstants(from: string, to: string): { start: string; end: string } {
  return {
    start: new Date(`${from}T00:00:00+05:30`).toISOString(),
    end: new Date(`${addDays(to, 1)}T00:00:00+05:30`).toISOString(),
  };
}
