import { writeFile } from 'node:fs/promises';
import type { HandlerContext, HandlerMap } from './dispatcher';
import type { DesktopUi } from './systemHandlers';
import type { Printer } from './salesHandlers';
import { transact } from '../db/tx';
import { getAllSettings } from '../services/settings';
import { dashboardPeriod, dashboardRecent } from '../services/dashboard';
import type { ReportRunner } from '../reports/runner';
import { reportFileName, reportToCsv, reportToHtml, reportToXlsx } from '../reports/export';
import { AppError, ErrorCodes } from '@shared/errors';
import { businessDateOf } from '@shared/time';
import { canRunReport, reportDef, type ReportParams, type ReportResult } from '@shared/reports';

async function runChecked(ctx: HandlerContext, runner: ReportRunner, reportId: string, params: ReportParams): Promise<ReportResult> {
  const def = reportDef(reportId);
  if (!def) throw new AppError(ErrorCodes.NOT_FOUND, 'That report does not exist.');
  const permissions = ctx.session!.permissions;
  if (!canRunReport(def, permissions)) {
    throw new AppError(ErrorCodes.PERMISSION_DENIED, 'You do not have permission to see this report.', { permission: `report ${reportId} (${def.level})` });
  }
  const now = ctx.env.clock.now();
  return runner.run(reportId, params, { today: businessDateOf(now, ctx.env.timeZone), nowIso: now.toISOString(), permissions });
}

function shopFor(ctx: HandlerContext) {
  const s = getAllSettings(ctx.env.db).shop;
  return { name: s.name, address: [s.addressLine1, s.city].filter(Boolean) };
}

const isLandscape = (r: ReportResult) => !!reportDef(r.reportId)?.landscape || r.columns.length > 7;

export function reportHandlers(ui: DesktopUi, printer: Printer, runner: ReportRunner): HandlerMap {
  const audit = (ctx: HandlerContext, r: ReportResult, action: string, after: Record<string, unknown>) =>
    transact(ctx.env, ctx.actor, (tx) =>
      tx.audit({ module: 'reports', entityType: 'report', entityId: r.reportId, action, after: { report: r.title, period: r.subtitle, rows: r.rows.length, ...after } }),
    );

  return {
    'reports.run': { access: 'authenticated', handle: (input, ctx) => runChecked(ctx, runner, input.reportId, input.params) },
    'reports.export': {
      access: 'authenticated',
      handle: async (input, ctx) => {
        const r = await runChecked(ctx, runner, input.reportId, input.params);
        const name = `${reportFileName(r, input.params.from, input.params.to)}.${input.format}`;
        const path = await ui.chooseSaveFile(`Save ${r.title}`, name, input.format);
        if (!path) return null;
        const data =
          input.format === 'csv'
            ? reportToCsv(r)
            : input.format === 'xlsx'
              ? await reportToXlsx(r, shopFor(ctx).name)
              : await printer.toPdf(reportToHtml(r, shopFor(ctx), isLandscape(r)), 'A4');
        await writeFile(path, data);
        audit(ctx, r, 'EXPORT', { format: input.format });
        return { path };
      },
    },
    'reports.print': {
      access: 'authenticated',
      handle: async (input, ctx) => {
        const r = await runChecked(ctx, runner, input.reportId, input.params);
        const printed = await printer.print(reportToHtml(r, shopFor(ctx), isLandscape(r)), 'A4', { landscape: isLandscape(r) });
        if (printed) audit(ctx, r, 'PRINTED', {});
        return { printed };
      },
    },
    'dashboard.period': { access: 'authenticated', handle: (input, ctx) => dashboardPeriod(ctx.env.db, input.from, input.to, ctx.session!.permissions) },
    'dashboard.recent': { access: 'authenticated', handle: (_i, ctx) => dashboardRecent(ctx.env.db, ctx.session!.permissions) },
  };
}
