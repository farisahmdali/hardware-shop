import ExcelJS from 'exceljs';
import { paiseToDecimalString } from '@shared/money';
import { qtyToDecimalString } from '@shared/qty';
import { formatDateTime } from '@shared/time';
import { formatReportCell, NUMERIC_KINDS } from '@shared/reportFormat';
import type { ReportCell, ReportColumn, ReportResult, ReportRow } from '@shared/reports';
import { safeCell, toCsv } from '../services/tabular';

export const displayCell = formatReportCell;

/** A cell as a plain value for CSV: rupees with 2 decimals, quantities as decimals, dates as YYYY-MM-DD. */
function csvCell(kind: ReportColumn['kind'], v: ReportCell): string | number {
  if (v === null) return '';
  if (typeof v === 'string') return kind === 'datetime' ? formatDateTime(v) : v;
  switch (kind) {
    case 'money':
      return paiseToDecimalString(v);
    case 'qty':
      return qtyToDecimalString(v);
    case 'percent':
      return (v / 100).toFixed(2);
    default:
      return v;
  }
}

function allRows(r: ReportResult): ReportRow[] {
  return r.totals ? [...r.rows, { style: 'total', cells: r.totals }] : r.rows;
}

export function reportToCsv(r: ReportResult): string {
  return toCsv(
    r.columns.map((c) => (c.kind === 'money' ? `${c.label} (₹)` : c.kind === 'percent' ? `${c.label} (%)` : c.label)),
    allRows(r).map((row) => r.columns.map((c) => csvCell(c.kind, row.cells[c.key] ?? null))),
  );
}

const XLSX_FORMATS: Partial<Record<ReportColumn['kind'], string>> = {
  money: '#,##,##0.00;[Red]-#,##,##0.00',
  qty: '#,##0.###',
  percent: '0.00"%"',
  int: '#,##0',
  date: 'dd-mmm-yyyy',
};

function xlsxCell(kind: ReportColumn['kind'], v: ReportCell): ExcelJS.CellValue {
  if (v === null) return null;
  if (typeof v === 'string') {
    if (kind === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00Z`);
    if (kind === 'datetime') return formatDateTime(v);
    return safeCell(v);
  }
  switch (kind) {
    case 'money':
      return v / 100;
    case 'qty':
      return v / 1000;
    case 'percent':
      return v / 100;
    default:
      return v;
  }
}

/** An Excel workbook: title, period and filters, a frozen header, typed numbers and dates, totals and notes. */
export async function reportToXlsx(r: ReportResult, shopName: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Hardware Shop Manager';
  wb.created = new Date(r.generatedAt);
  const ws = wb.addWorksheet(r.title.slice(0, 31).replace(/[\\/*?:[\]]/g, ' '), { views: [{ state: 'frozen', ySplit: 4 }] });
  ws.addRow([`${shopName} · ${r.title}`]).font = { bold: true, size: 13 };
  ws.addRow([`${r.subtitle} · generated ${formatDateTime(r.generatedAt)}`]).font = { italic: true, color: { argb: 'FF555555' } };
  ws.addRow([]);
  const header = ws.addRow(r.columns.map((c) => c.label));
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  for (const row of allRows(r)) {
    const added = ws.addRow(r.columns.map((c) => xlsxCell(c.kind, row.cells[c.key] ?? null)));
    if (row.style) added.font = { bold: true, italic: row.style === 'section' };
  }
  r.columns.forEach((c, i) => {
    const column = ws.getColumn(i + 1);
    const fmt = XLSX_FORMATS[c.kind];
    if (fmt) column.numFmt = fmt;
    const longest = Math.max(c.label.length, ...r.rows.slice(0, 200).map((row) => displayCell(c.kind, row.cells[c.key] ?? null).length));
    column.width = Math.min(48, Math.max(10, longest + 2));
  });
  if (r.notes.length) {
    ws.addRow([]);
    for (const n of r.notes) ws.addRow([n]).font = { italic: true, color: { argb: 'FF555555' } };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A self-contained printable page (A4, landscape for wide reports). No scripts, no external resources. */
export function reportToHtml(r: ReportResult, shop: { name: string; address: string[] }, landscape: boolean): string {
  const align = (c: ReportColumn) => (NUMERIC_KINDS.has(c.kind) ? ' class="r"' : '');
  const rows = allRows(r)
    .map(
      (row) =>
        `<tr${row.style ? ` class="${row.style}"` : ''}>${r.columns
          .map((c) => `<td${align(c)}>${esc(displayCell(c.kind, row.cells[c.key] ?? null))}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  const summary = r.summary.length
    ? `<div class="summary">${r.summary
        .map(
          (s) =>
            `<div class="box"><div class="muted">${esc(s.label)}</div><div class="big">${esc(displayCell(s.kind === 'money' ? 'money' : s.kind, s.value))}</div>${
              s.hint ? `<div class="muted">${esc(s.hint)}</div>` : ''
            }</div>`,
        )
        .join('')}</div>`
    : '';
  const css = `
    @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 10mm; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: 'Segoe UI', Arial, sans-serif; color: #111; font-size: 10px; line-height: 1.3; }
    h1 { font-size: 16px; margin: 0; } .muted { color: #555; } .r { text-align: right; white-space: nowrap; }
    .head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #111; padding-bottom: 6px; margin-bottom: 8px; }
    .summary { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; } .box { border: 1px solid #bbb; padding: 4px 8px; min-width: 120px; }
    .big { font-size: 13px; font-weight: 700; }
    table { border-collapse: collapse; width: 100%; }
    th { background: #eee; text-align: left; font-weight: 600; border-bottom: 1px solid #999; padding: 3px 4px; }
    td { border-bottom: 1px solid #ddd; padding: 2px 4px; vertical-align: top; }
    thead { display: table-header-group; } tr { page-break-inside: avoid; }
    tr.section td { font-weight: 700; background: #f6f6f6; padding-top: 6px; }
    tr.subtotal td { font-weight: 600; border-top: 1px solid #999; }
    tr.total td { font-weight: 700; border-top: 1.5px solid #111; }
    .notes { margin-top: 8px; } .notes p { margin: 2px 0; }`;
  const body = `
    <div class="head">
      <div><h1>${esc(r.title)}</h1><div>${esc(r.subtitle)}</div></div>
      <div class="r"><div style="font-weight:600">${esc(shop.name)}</div>${shop.address.map((a) => `<div class="muted">${esc(a)}</div>`).join('')}
        <div class="muted">Printed ${esc(formatDateTime(r.generatedAt))}</div></div>
    </div>
    ${summary}
    <table><thead><tr>${r.columns.map((c) => `<th${align(c)}>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${
      rows || `<tr><td colspan="${r.columns.length}" class="muted">Nothing in this period.</td></tr>`
    }</tbody></table>
    ${r.notes.length ? `<div class="notes">${r.notes.map((n) => `<p class="muted">${esc(n)}</p>`).join('')}</div>` : ''}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${esc(
    r.title,
  )}</title><style>${css}</style></head><body>${body}</body></html>`;
}

/** A file name such as "sales-by-product_2026-10-01_2026-10-26". */
export function reportFileName(r: ReportResult, from?: string, to?: string): string {
  const slug = r.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return [slug, from, to].filter(Boolean).join('_');
}
