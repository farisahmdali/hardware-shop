import type { Db } from '../db/connection';
import { AppError, ErrorCodes } from '@shared/errors';
import type { Permission } from '@shared/permissions';
import {
  REPORT_ROW_LIMIT,
  reportDef,
  reportParamsSchema,
  type DefaultRange,
  type ReportColumn,
  type ReportDef,
  type ReportParams,
  type ReportResult,
  type ReportRow,
  type ReportSummaryItem,
} from '@shared/reports';
import { formatDate } from '@shared/time';
import { addDays } from './periods';

export interface ReportContext {
  db: Db;
  params: ReportParams & { from: string; to: string };
  /** Today in the shop's time zone (YYYY-MM-DD). */
  today: string;
  nowIso: string;
  permissions: readonly Permission[];
  /** Rows beyond this are cut off and the result is marked truncated. */
  limit: number;
}

export interface ReportOutput {
  columns: ReportColumn[];
  rows: ReportRow[];
  summary?: ReportSummaryItem[];
  notes?: string[];
  /** Extra words for the subtitle, e.g. "As of 26 Oct 2026". */
  subtitle?: string[];
  /** Totals are not meaningful (mixed units, structured layout). */
  noTotals?: boolean;
}

export type ReportImpl = (c: ReportContext) => ReportOutput;

export interface RunContext {
  today: string;
  nowIso: string;
  permissions: readonly Permission[];
  limit?: number;
}

const registry = new Map<string, ReportImpl>();

export function registerReports(impls: Record<string, ReportImpl>): void {
  for (const [id, impl] of Object.entries(impls)) {
    if (!reportDef(id)) throw new Error(`Report ${id} is not in the catalogue`);
    registry.set(id, impl);
  }
}

export function hasReportImpl(id: string): boolean {
  return registry.has(id);
}

/** The period a report covers when none is chosen. */
export function defaultRange(range: DefaultRange | undefined, today: string): { from: string; to: string } {
  switch (range) {
    case 'today':
      return { from: today, to: today };
    case 'next7':
      return { from: today, to: addDays(today, 7) };
    case 'last30':
      return { from: addDays(today, -29), to: today };
    case 'year': {
      const [y, m] = today.split('-').map(Number) as [number, number];
      return { from: `${m >= 4 ? y : y - 1}-04-01`, to: today };
    }
    case 'month':
    default:
      return { from: `${today.slice(0, 7)}-01`, to: today };
  }
}

/** True when the caller may see purchase costs and margins inside a report. */
export function showsCost(perms: readonly Permission[]): boolean {
  return perms.includes('reports.financial') || perms.includes('products.manage') || perms.includes('stock.adjust');
}

export function showsProfit(perms: readonly Permission[]): boolean {
  return perms.includes('reports.financial');
}

function filterWords(db: Db, def: ReportDef, p: ReportParams): string[] {
  const words: string[] = [];
  const name = (sql: string, id: number) => (db.prepare(sql).get(id) as { name: string } | undefined)?.name ?? `#${id}`;
  if (p.customerId && def.params.includes('customer')) words.push(`Customer: ${name('SELECT name FROM customers WHERE id = ?', p.customerId)}`);
  if (p.supplierId && def.params.includes('supplier')) words.push(`Supplier: ${name('SELECT name FROM suppliers WHERE id = ?', p.supplierId)}`);
  if (p.categoryId && def.params.includes('category')) words.push(`Category: ${name('SELECT name FROM categories WHERE id = ?', p.categoryId)}`);
  if (p.rentalProductId && def.params.includes('rentalProduct')) {
    words.push(`Item: ${name('SELECT name FROM rental_products WHERE id = ?', p.rentalProductId)}`);
  }
  if (def.option && p.option && p.option !== def.option.default) {
    const choice = def.option.choices.find((c) => c.value === p.option);
    if (choice) words.push(`${def.option.label}: ${choice.label}`);
  }
  if (def.params.includes('groupBy')) words.push(`By ${p.groupBy}`);
  return words;
}

/**
 * Runs one report against the database. Every report is a read; nothing is written.
 * Totals are summed over the data rows shown, and a result cut off at the row limit says so.
 */
export function runReport(db: Db, reportId: string, rawParams: unknown, run: RunContext): ReportResult {
  const def = reportDef(reportId);
  const impl = registry.get(reportId);
  if (!def || !impl) throw new AppError(ErrorCodes.NOT_FOUND, 'That report does not exist.');
  const parsed = reportParamsSchema.parse(rawParams ?? {});
  const range = defaultRange(def.defaultRange, run.today);
  const params = {
    ...parsed,
    from: parsed.from ?? (def.params.includes('range') ? range.from : run.today),
    to: parsed.to ?? (def.params.includes('range') ? range.to : run.today),
    option: def.option ? (def.option.choices.some((c) => c.value === parsed.option) ? parsed.option : def.option.default) : undefined,
  };
  if (def.requires === 'customer' && !params.customerId) throw new AppError(ErrorCodes.VALIDATION, 'Choose a customer for this report.');
  if (def.requires === 'supplier' && !params.supplierId) throw new AppError(ErrorCodes.VALIDATION, 'Choose a supplier for this report.');
  const limit = Math.min(run.limit ?? REPORT_ROW_LIMIT, REPORT_ROW_LIMIT);

  const out = impl({ db, params, today: run.today, nowIso: run.nowIso, permissions: run.permissions, limit });
  const truncated = out.rows.length > limit;
  const rows = truncated ? out.rows.slice(0, limit) : out.rows;

  let totals: ReportResult['totals'] = null;
  const summed = out.columns.filter((c) => c.total);
  if (!out.noTotals && summed.length > 0 && rows.some((r) => !r.style)) {
    totals = {};
    const label = out.columns.find((c) => !c.total && (c.kind === 'text' || c.kind === 'code' || c.kind === 'date'));
    if (label) totals[label.key] = 'Total';
    for (const c of summed) {
      totals[c.key] = rows.reduce((a, r) => a + (r.style ? 0 : typeof r.cells[c.key] === 'number' ? (r.cells[c.key] as number) : 0), 0);
    }
  }

  const period = def.params.includes('range')
    ? params.from === params.to
      ? formatDate(params.from)
      : `${formatDate(params.from)} – ${formatDate(params.to)}`
    : def.params.includes('asOf')
      ? `As of ${formatDate(params.to)}`
      : `As of ${formatDate(run.today)}`;
  const notes = [...(out.notes ?? [])];
  if (truncated) notes.unshift(`Only the first ${limit.toLocaleString('en-IN')} rows are shown and totalled. Choose a shorter period or a filter to see the rest.`);

  return {
    reportId,
    title: def.title,
    subtitle: [period, ...(out.subtitle ?? []), ...filterWords(db, def, params)].join(' · '),
    generatedAt: run.nowIso,
    columns: out.columns,
    rows,
    totals,
    summary: out.summary ?? [],
    notes,
    truncated,
    rowLimit: limit,
  };
}
