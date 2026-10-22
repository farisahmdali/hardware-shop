import { join } from 'node:path';
import log from 'electron-log/main';
import type { Logger } from '../services/env';

/** Technical log written to <data dir>/logs/main.log (rotated at 5 MB). Business history lives in the database. */
export function createLogger(dataDir: string): Logger {
  log.transports.file.resolvePathFn = () => join(dataDir, 'logs', 'main.log');
  log.transports.file.maxSize = 5 * 1024 * 1024;
  log.transports.console.level = process.env.NODE_ENV === 'production' ? false : 'info';
  log.errorHandler.startCatching({ showDialog: false });
  return {
    info: (message, ...meta) => log.info(message, ...meta),
    warn: (message, ...meta) => log.warn(message, ...meta),
    error: (message, ...meta) => log.error(message, ...meta),
  };
}
