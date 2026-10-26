import { formatMoney } from './money';
import { formatQty } from './qty';
import { formatDate, formatDateTime } from './time';
import type { ReportCell, ReportCellKind } from './reports';

/** A report cell as text, the same on screen, in PDFs and in printouts: ₹1,234.50 · 2.5 · 25.34% · 26 Oct 2026. */
export function formatReportCell(kind: ReportCellKind, v: ReportCell): string {
  if (v === null || v === '') return '';
  if (typeof v === 'string') {
    if (kind === 'date') return formatDate(v);
    if (kind === 'datetime') return formatDateTime(v);
    return v;
  }
  switch (kind) {
    case 'money':
      return formatMoney(v);
    case 'qty':
      return formatQty(v);
    case 'percent':
      return `${(v / 100).toFixed(2)}%`;
    case 'int':
      return v.toLocaleString('en-IN');
    default:
      return String(v);
  }
}

export const NUMERIC_KINDS: ReadonlySet<ReportCellKind> = new Set(['money', 'qty', 'int', 'percent']);
