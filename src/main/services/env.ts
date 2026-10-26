import type { DbEnv } from '../db/tx';
import type { DatabaseInspection } from '@shared/contracts';

export interface AppPaths {
  dataDir: string;
  databasePath: string;
  defaultBackupDir: string;
}

export interface Logger {
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** Everything a service needs. Services never import Electron, so tests can build an AppEnv directly. */
export interface AppEnv extends DbEnv {
  paths: AppPaths;
  appVersion: string;
  logger: Logger;
  /**
   * Checks a whole database file (a backup being made or restored). On a large shop this takes
   * many seconds, so the application runs it in the background worker; without it (tests, and
   * the upgrade before the window opens) it runs here.
   */
  inspectFile?(path: string): Promise<DatabaseInspection>;
}
