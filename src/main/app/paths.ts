import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { AppPaths } from '../services/env';

/**
 * All business data lives under %APPDATA%\HardwareShop (or HWS_DATA_DIR, used by
 * end-to-end tests). The installer never deletes this folder, so upgrades and
 * reinstalls keep the shop's data.
 */
export function resolvePaths(): AppPaths {
  const dataDir = process.env.HWS_DATA_DIR || join(app.getPath('appData'), 'HardwareShop');
  mkdirSync(join(dataDir, 'data'), { recursive: true });
  app.setPath('userData', join(dataDir, 'electron'));
  return {
    dataDir,
    databasePath: join(dataDir, 'data', 'shop.db'),
    defaultBackupDir: process.env.HWS_DATA_DIR
      ? join(dataDir, 'backups')
      : join(app.getPath('documents'), 'HardwareShop Backups'),
  };
}
