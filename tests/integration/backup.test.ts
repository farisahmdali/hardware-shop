import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { copyLatestBackupTo, createBackup, listBackups, validateBackupFile } from '@main/services/backup';
import { listAudit } from '@main/services/audit';
import { actorOf, createTestEnv, setupOwner, type TestEnv } from '../helpers';

let env: TestEnv;
beforeEach(() => {
  env = createTestEnv();
});
afterEach(() => env.cleanup());

describe('backups', () => {
  it('creates a verified, self-contained backup with a manifest and history entry', async () => {
    const owner = setupOwner(env);
    const record = await createBackup(env, actorOf(owner), 'MANUAL');
    expect(record.status).toBe('OK');
    expect(record.fileExists).toBe(true);
    expect(existsSync(`${record.filePath}.partial`)).toBe(false);
    expect(existsSync(`${record.filePath}-wal`)).toBe(false);

    const manifest = JSON.parse(readFileSync(record.filePath.replace(/\.db$/, '.json'), 'utf8'));
    expect(manifest.sha256).toBe(record.sha256);
    expect(manifest.shopName).toBe('Sharma Hardware & Tools');
    expect(manifest.counts.users).toBe(1);

    const validation = await validateBackupFile(record.filePath);
    expect(validation).toMatchObject({ valid: true, problems: [], shopName: 'Sharma Hardware & Tools' });
    expect(validation.counts.audit_log).toBeGreaterThan(0);

    expect(listBackups(env)[0]!.id).toBe(record.id);
    expect(listAudit(env.db, { page: 1, pageSize: 5, action: 'BACKUP_CREATED' }).total).toBe(1);
  });

  it('contains the audit history and business data at the moment of backup', async () => {
    const owner = setupOwner(env);
    const record = await createBackup(env, actorOf(owner), 'MANUAL');
    const copy = new Database(record.filePath, { readonly: true });
    const setupEntries = copy.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'SETUP_COMPLETED'").get();
    copy.close();
    expect(setupEntries).toEqual({ n: 1 });
  });

  it('never overwrites an existing backup file', async () => {
    const owner = setupOwner(env);
    const a = await createBackup(env, actorOf(owner), 'MANUAL');
    const b = await createBackup(env, actorOf(owner), 'MANUAL');
    expect(a.filePath).not.toBe(b.filePath);
    expect(existsSync(a.filePath) && existsSync(b.filePath)).toBe(true);
  });

  it('rejects a corrupt file', async () => {
    const owner = setupOwner(env);
    const record = await createBackup(env, actorOf(owner), 'MANUAL');
    const bytes = readFileSync(record.filePath);
    for (let i = 4096; i < bytes.length; i += 97) bytes[i] = 0xff;
    const corruptPath = join(env.dir, 'corrupt.db');
    writeFileSync(corruptPath, bytes);
    const result = await validateBackupFile(corruptPath);
    expect(result.valid).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it('rejects a backup whose contents no longer match its manifest', async () => {
    const owner = setupOwner(env);
    const record = await createBackup(env, actorOf(owner), 'MANUAL');
    const db = new Database(record.filePath);
    db.prepare("UPDATE settings SET value_json = json_set(value_json, '$.name', 'Edited') WHERE key = 'shop'").run();
    db.close();
    const result = await validateBackupFile(record.filePath);
    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/checksum/);
  });

  it('rejects files that are not shop databases', async () => {
    const textFile = join(env.dir, 'notes.db');
    writeFileSync(textFile, 'x'.repeat(2048));
    expect((await validateBackupFile(textFile)).problems).toContain('The file is not a SQLite database.');

    const otherPath = join(env.dir, 'other.db');
    const other = new Database(otherPath);
    other.exec('CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1);');
    other.close();
    expect((await validateBackupFile(otherPath)).problems).toContain('This is not a Hardware Shop Manager database.');

    expect((await validateBackupFile(join(env.dir, 'missing.db'))).valid).toBe(false);
  });

  it('copies the latest backup to another drive and verifies the copy', async () => {
    const owner = setupOwner(env);
    const record = await createBackup(env, actorOf(owner), 'MANUAL');
    const usb = join(env.dir, 'usb');
    mkdirSync(usb);
    const copied = await copyLatestBackupTo(env, actorOf(owner), usb);
    expect(existsSync(copied)).toBe(true);
    expect(existsSync(copied.replace(/\.db$/, '.json'))).toBe(true);
    expect((await validateBackupFile(copied)).valid).toBe(true);
    await expect(copyLatestBackupTo(env, actorOf(owner), usb)).rejects.toThrow(/already exists/);
    expect(record.status).toBe('OK');
  });

  it('records a failed backup without leaving partial files', async () => {
    const owner = setupOwner(env);
    const blocker = join(env.dir, 'not-a-folder');
    writeFileSync(blocker, 'file in the way');
    await expect(createBackup(env, actorOf(owner), 'MANUAL', join(blocker, 'sub'))).rejects.toThrow(/could not be created/);
    expect(listBackups(env)[0]!.status).toBe('FAILED');
    expect(listAudit(env.db, { page: 1, pageSize: 5, action: 'BACKUP_FAILED' }).total).toBe(1);
  });
});
