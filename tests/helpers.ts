import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPLICATION_ID, openDatabase, type Db } from '@main/db/connection';
import { MIGRATIONS, migrate } from '@main/db/migrator';
import type { Clock } from '@main/db/tx';
import { silentLogger, type AppEnv } from '@main/services/env';
import { completeSetup } from '@main/services/auth';
import type { SessionInfo } from '@shared/contracts';

export class TestClock implements Clock {
  constructor(private current = new Date('2026-10-21T04:30:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  set(iso: string): void {
    this.current = new Date(iso);
  }
  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }
}

export interface TestEnv extends AppEnv {
  clock: TestClock;
  dir: string;
  cleanup(): void;
}

/** A migrated database in a fresh temp folder, using the real SQLite engine. */
export function createTestEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'hws-test-'));
  const databasePath = join(dir, 'shop.db');
  const db = openDatabase(databasePath);
  migrate(db);
  const clock = new TestClock();
  const env: TestEnv = {
    db,
    clock,
    timeZone: 'Asia/Kolkata',
    dir,
    appVersion: '0.0.0-test',
    logger: silentLogger,
    paths: { dataDir: dir, databasePath, defaultBackupDir: join(dir, 'backups') },
    cleanup() {
      // Tests may swap in a reopened connection, so close whatever env.db is now.
      try {
        if (env.db.open) env.db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
  return env;
}

export const SHOP = {
  name: 'Sharma Hardware & Tools',
  addressLine1: '12 Market Road',
  addressLine2: '',
  city: 'Pune',
  pincode: '411001',
  stateCode: '27',
  phone: '9876543210',
  email: '',
  gstin: '',
  invoiceFooter: '',
};

export function setupOwner(env: AppEnv): SessionInfo {
  return completeSetup(env, {
    shop: SHOP,
    owner: { username: 'owner', displayName: 'Ravi Sharma', secret: '4321' },
  });
}

export const actorOf = (s: SessionInfo) => ({ userId: s.user.id, username: s.user.username });

/** A database as an older release left it: migrations 1..version applied, the way migrate() applies them. */
export function openDatabaseAtVersion(path: string, version: number): Db {
  const db = openDatabase(path);
  db.pragma(`application_id = ${APPLICATION_ID}`);
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const m of MIGRATIONS.slice(0, version)) {
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)').run(m.version, m.name, m.checksum, '2026-01-01T00:00:00.000Z');
      db.pragma(`user_version = ${m.version}`);
    }).immediate();
  }
  return db;
}

/** Every row of every table, for comparing a database before and after an operation. */
export function snapshotTables(db: Db, except: string[] = []): Record<string, unknown[]> {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
    .map((t) => t.name)
    .filter((t) => !except.includes(t) && !t.includes('_fts'));
  // Sorted in JavaScript: some tables have no rowid.
  const rows = (t: string) => db.prepare(`SELECT * FROM "${t}"`).all().map((r) => JSON.stringify(r)).sort();
  return Object.fromEntries(tables.map((t) => [t, rows(t)]));
}
