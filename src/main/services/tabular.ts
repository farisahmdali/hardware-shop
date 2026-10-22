import ExcelJS from 'exceljs';

/** Parses RFC 4180 CSV (quoted fields, doubled quotes, CRLF or LF, optional UTF-8 BOM). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/**
 * Spreadsheet programs execute cells starting with = + - @ as formulas. Text values
 * are prefixed with an apostrophe so an exported file can never run a formula.
 */
export function safeCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export type Cell = string | number;

export function toCsv(header: string[], rows: Cell[][]): string {
  const lines = [header, ...rows].map((r) =>
    r.map((c) => csvField(typeof c === 'number' ? String(c) : safeCell(c))).join(','),
  );
  // BOM so Excel opens UTF-8 (₹, Hindi names) correctly.
  return `﻿${lines.join('\r\n')}\r\n`;
}

export async function toXlsx(sheetName: string, header: string[], rows: Cell[][], numberFormats: Record<number, string> = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Hardware Shop Manager';
  const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.addRow(header);
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(r.map((c) => (typeof c === 'number' ? c : safeCell(c))));
  header.forEach((h, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.min(40, Math.max(10, h.length + 2));
    const fmt = numberFormats[i];
    if (fmt) col.numFmt = fmt;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((t) => t.text).join('');
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
    if ('text' in value) return String(value.text);
  }
  return String(value);
}

/** Reads the first worksheet of an .xlsx file into rows of strings. */
export async function readXlsx(buffer: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows: string[][] = [];
  const width = ws.columnCount;
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    for (let c = 1; c <= width; c++) cells.push(cellText(row.getCell(c).value).trim());
    if (cells.some((c) => c !== '')) rows.push(cells);
  });
  return rows;
}
