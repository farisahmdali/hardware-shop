import { Worker } from 'node:worker_threads';
import workerPath from './worker?modulePath';
import type { Logger } from '../services/env';
import type { ReportRunner } from './runner';
import type { WorkerRequest, WorkerResponse } from './worker';
import type { DatabaseInspection, IntegrityReport } from '@shared/contracts';
import { AppError, ErrorCodes } from '@shared/errors';
import type { ReportResult } from '@shared/reports';

const REPORT_TIMEOUT_MS = 120_000;
// Checking every page of a large shop's database takes tens of seconds; allow plenty.
const CHECK_TIMEOUT_MS = 15 * 60_000;

type Job = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

/**
 * Starts the background worker on first use and keeps it for later work (reports, data checks,
 * backup checks). If it stops or a job takes too long, waiting requests fail with a clear
 * message and the next request starts a fresh worker.
 */
export function workerRunner(databasePath: string, logger: Logger): ReportRunner {
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve(r: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }>();

  const failAll = (message: string) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new AppError(ErrorCodes.INTERNAL, message));
      pending.delete(id);
    }
  };

  const start = (): Worker => {
    const w = new Worker(workerPath, { workerData: { databasePath } });
    w.on('message', (msg: WorkerResponse) => {
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new AppError(msg.error.code, msg.error.message, msg.error.details));
    });
    w.on('error', (e) => {
      logger.error('Report worker failed', e);
      failAll('The report could not be produced. Please try again.');
      worker = null;
    });
    w.on('exit', (code) => {
      if (code !== 0) logger.warn(`Report worker exited with code ${code}`);
      failAll('The report was interrupted. Please try again.');
      worker = null;
    });
    return w;
  };

  const request = <T,>(job: Job, timeoutMs: number, tooLong: string): Promise<T> => {
    worker ??= start();
    const w = worker;
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new AppError(ErrorCodes.INTERNAL, tooLong));
        // A stuck query would block later work too; start afresh next time.
        void w.terminate();
        if (worker === w) worker = null;
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer });
      w.postMessage({ id, ...job } as WorkerRequest);
    });
  };

  return {
    run: (reportId, params, run) =>
      request<ReportResult>({ kind: 'report', reportId, params, run }, REPORT_TIMEOUT_MS, 'The report took too long. Choose a shorter period and try again.'),
    integrity: (opts) => request<IntegrityReport>({ kind: 'integrity', quickOnly: !!opts.quickOnly }, CHECK_TIMEOUT_MS, 'The data check took too long.'),
    inspect: (path) => request<DatabaseInspection>({ kind: 'inspect', path }, CHECK_TIMEOUT_MS, 'Checking the database file took too long.'),
    async close() {
      const w = worker;
      worker = null;
      if (w) await w.terminate();
    },
  };
}
