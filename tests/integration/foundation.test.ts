import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from '@main/db/connection';
import { LATEST_SCHEMA_VERSION, migrate, MIGRATIONS, MigrationError, pendingMigrations, schemaVersion } from '@main/db/migrator';
import { SYSTEM_ACTOR, transact } from '@main/db/tx';
import { listAudit } from '@main/services/audit';
import { getAllSettings, updateSettingsSection } from '@main/services/settings';
import { runIntegrityChecks } from '@main/services/integrity';
import { actorOf, createTestEnv, setupOwner, type TestEnv } from '../helpers';

let env: TestEnv;
beforeEach(() => {
  env = createTestEnv();
});
afterEach(() => env.cleanup());

describe('migrations', () => {
  it('creates the latest schema with the application id', () => {
    expect(schemaVersion(env.db)).toBe(LATEST_SCHEMA_VERSION);
    expect(pendingMigrations(env.db)).toEqual([]);
    expect(migrate(env.db)).toEqual([]);
  });

  it('seeds reference data', () => {
    const count = (t: string) => (env.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect(count('roles')).toBe(4);
    expect(count('units')).toBeGreaterThanOrEqual(10);
    expect(count('payment_methods')).toBe(5);
    expect(count('accounts')).toBeGreaterThan(20);
  });

  it('refuses a SQLite file that belongs to another application', () => {
    const path = join(env.dir, 'foreign.db');
    const foreign = new Database(path);
    foreign.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY)');
    expect(() => pendingMigrations(foreign)).toThrow(MigrationError);
    foreign.close();
  });

  it('refuses a database written by a newer version', () => {
    env.db.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    expect(() => pendingMigrations(env.db)).toThrow(/newer version/);
  });

  it('detects an applied migration that was altered', () => {
    env.db.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1").run();
    expect(() => pendingMigrations(env.db)).toThrow(/does not match/);
  });

  it('keeps existing data when the database is reopened and migrated again', () => {
    setupOwner(env);
    env.db.close();
    const reopened = openDatabase(env.paths.databasePath);
    expect(migrate(reopened)).toEqual([]);
    expect((reopened.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(1);
    env.db = reopened;
  });
});

describe('upgrading an existing database', () => {
  it('applies later migrations to a populated older database without losing data', () => {
    const path = join(env.dir, 'old.db');
    const old = openDatabase(path);
    // Build a database exactly as the first release left it: only migration 1 applied.
    old.pragma('application_id = 1213682481');
    old.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    old.exec(MIGRATIONS[0]!.sql);
    old.prepare('INSERT INTO schema_migrations VALUES (1, ?, ?, ?)').run(MIGRATIONS[0]!.name, MIGRATIONS[0]!.checksum, 'x');
    old.pragma('user_version = 1');
    const oldEnv = { ...env, db: old };
    setupOwner(oldEnv);
    const auditBefore = listAudit(old, { page: 1, pageSize: 10 }).total;

    expect(pendingMigrations(old).map((m) => m.version)).toEqual(MIGRATIONS.slice(1).map((m) => m.version));
    migrate(old);
    expect(schemaVersion(old)).toBe(LATEST_SCHEMA_VERSION);
    expect(listAudit(old, { page: 1, pageSize: 10 }).total).toBe(auditBefore);
    expect((old.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(1);
    expect(runIntegrityChecks(old).issues).toEqual([]);
    old.close();
  });
});

describe('transactions', () => {
  it('rolls back every write, including audit entries and document numbers, when a step fails', () => {
    const auditBefore = listAudit(env.db, { page: 1, pageSize: 50 }).total;
    expect(() =>
      transact(env, SYSTEM_ACTOR, (tx) => {
        tx.nextDocNumber('INVOICE');
        tx.audit({ module: 'test', entityType: 'thing', entityId: 1, action: 'CREATE' });
        env.db.prepare("INSERT INTO brands (name, created_at, updated_at) VALUES ('Bosch', 'x', 'x')").run();
        throw new Error('simulated failure halfway through');
      }),
    ).toThrow('simulated failure');
    expect(listAudit(env.db, { page: 1, pageSize: 50 }).total).toBe(auditBefore);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM brands').get()).toEqual({ n: 0 });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM doc_sequences').get()).toEqual({ n: 0 });
  });

  it('issues gap-free numbers per financial year', () => {
    const issue = () => transact(env, SYSTEM_ACTOR, (tx) => tx.nextDocNumber('INVOICE'));
    expect(issue()).toBe('INV/2026-27/00001');
    expect(issue()).toBe('INV/2026-27/00002');
    expect(() =>
      transact(env, SYSTEM_ACTOR, (tx) => {
        tx.nextDocNumber('INVOICE');
        throw new Error('abort');
      }),
    ).toThrow();
    expect(issue()).toBe('INV/2026-27/00003');
    env.clock.set('2027-04-01T05:00:00.000Z');
    expect(issue()).toBe('INV/2027-28/00001');
    expect(transact(env, SYSTEM_ACTOR, (tx) => tx.nextDocNumber('RECEIPT'))).toBe('RCPT/2027-28/00001');
  });

  it('runs an idempotent command only once and returns the first result on retry', () => {
    let runs = 0;
    const submit = () =>
      transact(env, SYSTEM_ACTOR, (tx) =>
        tx.once('req-123', 'sales.finalize', () => {
          runs++;
          return { invoiceNo: tx.nextDocNumber('INVOICE') };
        }),
      );
    const first = submit();
    const second = submit();
    expect(runs).toBe(1);
    expect(second).toEqual(first);
    expect(() =>
      transact(env, SYSTEM_ACTOR, (tx) => tx.once('req-123', 'payments.receive', () => ({}))),
    ).toThrow(/different operation/);
  });

  it('rejects async callbacks', () => {
    expect(() => transact(env, SYSTEM_ACTOR, (async () => 1) as never)).toThrow(/synchronous/);
  });
});

describe('audit log', () => {
  it('cannot be edited or deleted', () => {
    transact(env, SYSTEM_ACTOR, (tx) => tx.audit({ module: 'test', entityType: 'x', action: 'CREATE' }));
    expect(() => env.db.prepare("UPDATE audit_log SET action = 'HIDDEN'").run()).toThrow(/IMMUTABLE/);
    expect(() => env.db.prepare('DELETE FROM audit_log').run()).toThrow(/IMMUTABLE/);
  });

  it('records before and after values with the responsible user, and redacts secrets', () => {
    const session = setupOwner(env);
    const actor = actorOf(session);
    env.clock.advanceMinutes(5);
    transact(env, actor, (tx) =>
      updateSettingsSection(tx, 'tax', { gstRegistered: true, pricesIncludeTax: false, roundInvoiceTotal: true }, 'Supplier quotes are ex-GST'),
    );
    const entry = listAudit(env.db, { page: 1, pageSize: 10, entityType: 'settings', entityId: 'tax' }).rows[0]!;
    expect(entry.action).toBe('UPDATE');
    expect(entry.username).toBe('owner');
    expect(entry.reason).toBe('Supplier quotes are ex-GST');
    expect(entry.occurredAt).toBe('2026-10-21T04:35:00.000Z');
    expect((entry.before as { pricesIncludeTax: boolean }).pricesIncludeTax).toBe(true);
    expect((entry.after as { pricesIncludeTax: boolean }).pricesIncludeTax).toBe(false);

    transact(env, actor, (tx) =>
      tx.audit({ module: 'test', entityType: 'x', action: 'CREATE', after: { name: 'a', secret: '1234', nested: { passwordHash: 'h' } } }),
    );
    const raw = env.db.prepare("SELECT after_json FROM audit_log WHERE module = 'test'").get() as { after_json: string };
    expect(raw.after_json).not.toContain('1234');
    expect(raw.after_json).not.toContain('"h"');
    const allAudit = env.db.prepare('SELECT before_json, after_json FROM audit_log').all();
    expect(JSON.stringify(allAudit)).not.toContain('scrypt$');
  });

  it('does not write an audit entry when nothing changed', () => {
    setupOwner(env);
    const before = listAudit(env.db, { page: 1, pageSize: 10 }).total;
    const current = getAllSettings(env.db).tax;
    transact(env, SYSTEM_ACTOR, (tx) => updateSettingsSection(tx, 'tax', current));
    expect(listAudit(env.db, { page: 1, pageSize: 10 }).total).toBe(before);
  });

  it('survives closing and reopening the database', () => {
    setupOwner(env);
    const total = listAudit(env.db, { page: 1, pageSize: 10 }).total;
    env.db.close();
    env.db = openDatabase(env.paths.databasePath);
    expect(listAudit(env.db, { page: 1, pageSize: 10 }).total).toBe(total);
  });
});

describe('integrity checks', () => {
  it('pass on a healthy database', () => {
    setupOwner(env);
    const report = runIntegrityChecks(env.db);
    expect(report.issues).toEqual([]);
    expect(report.checksRun).toContain('sqlite-integrity');
  });

  it('report a missing protection trigger', () => {
    env.db.exec('DROP TRIGGER audit_log_no_delete');
    const report = runIntegrityChecks(env.db, { quickOnly: true });
    expect(report.issues.map((i) => i.check)).toContain('immutability-triggers');
  });

  it('report invalid stored settings', () => {
    env.db
      .prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('backup', ?, 'x')")
      .run(JSON.stringify({ intervalHours: 0 }));
    expect(runIntegrityChecks(env.db, { quickOnly: true }).issues.map((i) => i.check)).toContain('settings');
  });
});
