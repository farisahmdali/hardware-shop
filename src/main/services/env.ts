import type { DbEnv } from '../db/tx';

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
}
