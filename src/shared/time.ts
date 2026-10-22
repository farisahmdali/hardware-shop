export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = dateFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dateFormatters.set(timeZone, f);
  }
  return f;
}

/** The shop-local calendar date (YYYY-MM-DD) of an instant. Daily reports group by this. */
export function businessDateOf(instant: Date | string, timeZone = DEFAULT_TIMEZONE): string {
  return dateFormatter(timeZone).format(typeof instant === 'string' ? new Date(instant) : instant);
}

/** Indian financial year (April–March) label for a business date, e.g. "2026-27". */
export function fiscalYearOf(businessDate: string): string {
  const [y, m] = businessDate.split('-').map(Number) as [number, number];
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const displayDateTime = new Intl.DateTimeFormat('en-IN', {
  timeZone: DEFAULT_TIMEZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const displayDate = new Intl.DateTimeFormat('en-IN', {
  timeZone: DEFAULT_TIMEZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? displayDateTime.format(new Date(iso)) : '';
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  // A bare YYYY-MM-DD is a calendar date, not an instant; pin it to local midday so it never shifts.
  const instant = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00+05:30` : value;
  return displayDate.format(new Date(instant));
}
