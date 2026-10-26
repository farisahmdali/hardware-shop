import { writeFile } from 'node:fs/promises';
import type { HandlerMap } from './dispatcher';
import type { DesktopUi } from './systemHandlers';
import type { Printer } from './salesHandlers';
import { transact } from '../db/tx';
import { auditForExport } from '../services/audit';
import { getAllSettings } from '../services/settings';
import { reportToCsv, reportToHtml } from '../reports/export';
import { actionLabel, describeChanges, pretty } from '@shared/auditFormat';
import type { AuditRow } from '@shared/contracts';
import type { ReportResult } from '@shared/reports';
import { businessDateOf, formatDateTime } from '@shared/time';

const EXPORT_LIMIT = 10_000;

/** The history as a report table, so it exports and prints like every other report. */
export function historyAsReport(rows: AuditRow[], truncated: boolean, subtitle: string, nowIso: string): ReportResult {
  return {
    reportId: 'history',
    title: 'History & audit log',
    subtitle,
    generatedAt: nowIso,
    columns: [
      { key: 'entry', label: 'Entry', kind: 'int' },
      { key: 'when', label: 'When', kind: 'datetime' },
      { key: 'user', label: 'Who', kind: 'text' },
      { key: 'module', label: 'Module', kind: 'text' },
      { key: 'record', label: 'Record', kind: 'text' },
      { key: 'action', label: 'Action', kind: 'text' },
      { key: 'changes', label: 'What changed', kind: 'text' },
      { key: 'reason', label: 'Reason', kind: 'text' },
      { key: 'txn', label: 'Transaction', kind: 'code' },
    ],
    rows: rows.map((r) => ({
      cells: {
        entry: r.id,
        when: r.occurredAt,
        user: r.username ?? 'system',
        module: pretty(r.module),
        record: `${pretty(r.entityType)}${r.entityId ? ` #${r.entityId}` : ''}`,
        action: actionLabel(r.action),
        changes: describeChanges(r.before, r.after),
        reason: r.reason ?? '',
        txn: r.txnRef ?? '',
      },
    })),
    totals: null,
    summary: [],
    notes: truncated ? [`Only the newest ${EXPORT_LIMIT.toLocaleString('en-IN')} entries are included. Narrow the dates or filters for the rest.`] : [],
    truncated,
    rowLimit: EXPORT_LIMIT,
  };
}

export function historyHandlers(ui: DesktopUi, printer: Printer): HandlerMap {
  return {
    'audit.export': {
      access: 'audit.view',
      handle: async (input, ctx) => {
        const { format, ...filter } = input;
        const { rows, truncated } = auditForExport(ctx.env.db, filter, EXPORT_LIMIT);
        const now = ctx.env.clock.now();
        const words = [
          filter.from || filter.to ? `${filter.from ? formatDateTime(filter.from) : 'start'} – ${filter.to ? formatDateTime(filter.to) : 'now'}` : 'All dates',
          filter.module && `Module: ${pretty(filter.module)}`,
          filter.action && `Action: ${actionLabel(filter.action)}`,
          filter.search && `Search: “${filter.search}”`,
        ].filter(Boolean);
        const report = historyAsReport(rows, truncated, words.join(' · '), now.toISOString());
        const path = await ui.chooseSaveFile('Save the history', `history_${businessDateOf(now, ctx.env.timeZone)}.${format}`, format);
        if (!path) return null;
        const shop = getAllSettings(ctx.env.db).shop;
        await writeFile(path, format === 'csv' ? reportToCsv(report) : await printer.toPdf(reportToHtml(report, { name: shop.name, address: [shop.city].filter(Boolean) }, true), 'A4'));
        transact(ctx.env, ctx.actor, (tx) => tx.audit({ module: 'audit', entityType: 'history', action: 'EXPORT', after: { format, rows: rows.length, filters: words.join(' · ') } }));
        return { path };
      },
    },
  };
}
