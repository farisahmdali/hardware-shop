import { migrate, pendingMigrations, schemaVersion } from '../db/migrator';
import { SYSTEM_ACTOR } from '../db/tx';
import type { AppEnv } from './env';
import { createBackup } from './backup';

/**
 * Brings the database up to this version of the application. An existing database is first
 * copied to a verified PRE_MIGRATION backup; if that backup cannot be made, nothing is changed.
 * Each migration then runs in its own transaction. Returns the versions applied.
 */
export async function upgradeDatabase(env: AppEnv): Promise<number[]> {
  const pending = pendingMigrations(env.db);
  if (pending.length === 0) return [];
  if (schemaVersion(env.db) > 0) {
    env.logger.info(`Backing up before applying migrations ${pending.map((m) => m.version).join(', ')}`);
    await createBackup(env, SYSTEM_ACTOR, 'PRE_MIGRATION');
  }
  const applied = migrate(env.db);
  env.logger.info(`Applied migrations: ${applied.join(', ')}`);
  return applied;
}
