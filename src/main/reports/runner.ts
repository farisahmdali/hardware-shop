import type { Db } from '../db/connection';
import { runReport, type RunContext } from './index';
import { inspectDatabase } from '../services/backup';
import { runIntegrityChecks } from '../services/integrity';
import type { DatabaseInspection, IntegrityReport } from '@shared/contracts';
import type { ReportResult } from '@shared/reports';

/**
 * Runs slow read-only work somewhere: in the background worker in the app, so the window stays
 * responsive however large the shop's data, and in-process in tests.
 */
export interface ReportRunner {
  run(reportId: string, params: unknown, run: RunContext): Promise<ReportResult>;
  /** The data checks, on a read-only connection of the shop database. */
  integrity(opts: { quickOnly?: boolean }): Promise<IntegrityReport>;
  /** Checks a whole database file, such as a backup. */
  inspect(path: string): Promise<DatabaseInspection>;
  close(): Promise<void>;
}

export function inProcessRunner(db: () => Db): ReportRunner {
  return {
    run: async (reportId, params, run) => runReport(db(), reportId, params, run),
    integrity: async (opts) => runIntegrityChecks(db(), opts),
    inspect: async (path) => inspectDatabase(path),
    close: async () => {},
  };
}
