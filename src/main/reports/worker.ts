import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../db/connection';
import { runReport, type RunContext } from './index';
import { inspectDatabase } from '../services/backup';
import { runIntegrityChecks } from '../services/integrity';
import { AppError, type ErrorPayload } from '@shared/errors';

/**
 * Background worker: runs reports and the slow data and backup checks on its own read-only
 * connection, so they never hold up billing. It can only read; the database refuses writes on
 * this connection. A backup file being checked is opened separately.
 */
export type WorkerRequest =
  | { id: number; kind: 'report'; reportId: string; params: unknown; run: RunContext }
  | { id: number; kind: 'integrity'; quickOnly: boolean }
  | { id: number; kind: 'inspect'; path: string };

export type WorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: ErrorPayload };

const databasePath = (workerData as { databasePath: string }).databasePath;
const db = openDatabase(databasePath, { readonly: true });
db.pragma('query_only = ON');

/**
 * The data checks get a connection of their own, opened for the check: a read-only connection
 * kept open while the application writes can hold an out-of-date picture of the product search
 * index, which SQLite's integrity check then reports as a mismatch.
 */
function checkData(quickOnly: boolean) {
  const fresh = openDatabase(databasePath, { readonly: true });
  try {
    fresh.pragma('query_only = ON');
    return runIntegrityChecks(fresh, { quickOnly });
  } finally {
    fresh.close();
  }
}

parentPort!.on('message', (msg: WorkerRequest) => {
  let response: WorkerResponse;
  try {
    const result =
      msg.kind === 'report'
        ? runReport(db, msg.reportId, msg.params, msg.run)
        : msg.kind === 'integrity'
          ? checkData(msg.quickOnly)
          : inspectDatabase(msg.path);
    response = { id: msg.id, ok: true, result };
  } catch (e) {
    response = {
      id: msg.id,
      ok: false,
      error:
        e instanceof AppError
          ? e.toPayload()
          : (e as { name?: string })?.name === 'ZodError'
            ? { code: 'VALIDATION', message: 'Some report filters are not valid.' }
            : { code: 'INTERNAL', message: `${msg.kind === 'report' ? 'The report could not be produced' : 'The check could not be completed'}: ${(e as Error).message}` },
    };
  }
  parentPort!.postMessage(response);
});
