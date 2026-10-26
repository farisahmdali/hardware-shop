import { copyFileSync, existsSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { openDatabase } from '@main/db/connection';
import { LATEST_SCHEMA_VERSION, schemaVersion } from '@main/db/migrator';
import { listBackups, validateBackupFile } from '@main/services/backup';
import { runIntegrityChecks } from '@main/services/integrity';
import { upgradeDatabase } from '@main/services/upgrade';
import { createTestEnv, snapshotTables, type TestEnv } from '../helpers';

/**
 * Upgrades a COPY of a real shop database, to check before a release that a shop's own data
 * upgrades cleanly. The original file is only read. Skipped unless a file is given:
 *
 *   $env:HWS_UPGRADE_FROM = "$env:APPDATA\HardwareShop\data\shop.db"; npm test -- upgradeCopy
 *
 * Close the application first, so the copy is complete.
 */
const source = process.env.HWS_UPGRADE_FROM;
let env: TestEnv | undefined;
afterEach(() => env?.cleanup());

it.skipIf(!source)('upgrades a copy of the given shop database, keeping every record', async () => {
  env = createTestEnv();
  env.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(source + suffix)) copyFileSync(source + suffix, env.paths.databasePath + suffix);
  }
  env.db = openDatabase(env.paths.databasePath);
  const from = schemaVersion(env.db);
  const kept = ['schema_migrations', 'backup_history', 'audit_log'];
  const before = snapshotTables(env.db, kept);
  const historyBefore = (env.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;

  const applied = await upgradeDatabase(env);
  expect(applied).toEqual(Array.from({ length: LATEST_SCHEMA_VERSION - from }, (_, i) => from + 1 + i));
  expect(schemaVersion(env.db)).toBe(LATEST_SCHEMA_VERSION);

  // Every existing row is still there, unchanged. Migrations may add rows (e.g. a new permission for a role).
  const after = snapshotTables(env.db, kept);
  for (const [table, rows] of Object.entries(before)) {
    const now = new Set(after[table] as string[]);
    expect({ table, missingOrChanged: (rows as string[]).filter((r) => !now.has(r)) }).toEqual({ table, missingOrChanged: [] });
  }
  expect((env.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n).toBeGreaterThanOrEqual(historyBefore);
  if (applied.length) {
    const backup = listBackups(env)[0]!;
    expect(backup).toMatchObject({ kind: 'PRE_MIGRATION', status: 'OK', schemaVersion: from });
    expect((await validateBackupFile(backup.filePath)).valid).toBe(true);
  }
  expect(runIntegrityChecks(env.db).issues).toEqual([]);
});
