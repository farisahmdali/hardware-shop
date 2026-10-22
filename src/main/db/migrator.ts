import { createHash } from 'node:crypto';
import { APPLICATION_ID, tableExists, type Db } from './connection';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

const files = import.meta.glob('./migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

function checksumOf(sql: string): string {
  // Normalise line endings so a git checkout with CRLF does not look like an edited migration.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/** All bundled migrations, ordered by their numeric prefix (001_, 002_, ...). */
export const MIGRATIONS: Migration[] = Object.entries(files)
  .map(([path, sql]) => {
    const file = path.split('/').pop()!;
    const m = /^(\d+)_(.+)\.sql$/.exec(file);
    if (!m) throw new Error(`Migration file name must look like 001_name.sql: ${file}`);
    return { version: Number(m[1]), name: m[2]!, sql, checksum: checksumOf(sql) };
  })
  .sort((a, b) => a.version - b.version);

MIGRATIONS.forEach((m, i) => {
  if (m.version !== i + 1) throw new Error(`Migrations must be numbered consecutively; found ${m.version} at ${i + 1}`);
});

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export function schemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/**
 * Confirms the file is a database this application can open and returns the
 * migrations still to apply. Refuses foreign files, databases written by a newer
 * version of the app, and databases whose applied migrations were altered.
 */
export function pendingMigrations(db: Db): Migration[] {
  const appId = db.pragma('application_id', { simple: true }) as number;
  const version = schemaVersion(db);
  const hasTables = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get();

  if (appId !== APPLICATION_ID) {
    if (appId !== 0 || hasTables) {
      throw new MigrationError('This file is not a Hardware Shop Manager database.');
    }
    return MIGRATIONS;
  }
  if (version > LATEST_SCHEMA_VERSION) {
    throw new MigrationError(
      `The database was created by a newer version of the application (schema ${version}, this version supports ${LATEST_SCHEMA_VERSION}). Install the newer version to open it.`,
    );
  }
  if (tableExists(db, 'schema_migrations')) {
    const applied = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as {
      version: number;
      checksum: string;
    }[];
    for (const row of applied) {
      const known = MIGRATIONS[row.version - 1];
      if (!known || known.checksum !== row.checksum) {
        throw new MigrationError(`Applied migration ${row.version} does not match this application build.`);
      }
    }
  }
  return MIGRATIONS.filter((m) => m.version > version);
}

/** Applies pending migrations, each in its own transaction. Returns the versions applied. */
export function migrate(db: Db, now: () => string = () => new Date().toISOString()): number[] {
  const pending = pendingMigrations(db);
  if (pending.length === 0) return [];

  if ((db.pragma('application_id', { simple: true }) as number) === 0) {
    db.pragma(`application_id = ${APPLICATION_ID}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const applied: number[] = [];
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(
        m.version,
        m.name,
        m.checksum,
        now(),
      );
      db.pragma(`user_version = ${m.version}`);
    }).immediate();
    applied.push(m.version);
  }

  const fkProblems = db.pragma('foreign_key_check') as unknown[];
  if (fkProblems.length > 0) {
    throw new MigrationError(`Foreign key check failed after migration: ${JSON.stringify(fkProblems.slice(0, 5))}`);
  }
  return applied;
}
