import type { DbEnv } from '../db/tx';
import type { DatabaseInspection } from '@shared/contracts';
import type { FetchLike } from './ai/openrouter';

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
  /** Reading supplier bills with an AI model; absent where it cannot work (some tests). */
  ai?: AiDeps;
}

/** Encrypts the OpenRouter key for this Windows user (Electron safeStorage); tests use a stand-in. */
export interface KeyCipher {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface AiDeps {
  cipher: KeyCipher;
  /** Can reach only OpenRouter (see app/security.ts). */
  fetch: FetchLike;
  /** OpenRouter's API address; a local stand-in server in end-to-end tests. */
  baseUrl?: string;
  /** Makes a large photo smaller before it is sent; null to send it as it is. */
  shrinkImage?(data: Buffer): { data: Buffer; mime: string } | null;
}
