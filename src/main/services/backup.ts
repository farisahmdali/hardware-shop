import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { APPLICATION_ID, tableExists } from '../db/connection';
import { LATEST_SCHEMA_VERSION, pendingMigrations, schemaVersion } from '../db/migrator';
import { transact, type Actor } from '../db/tx';
import type { AppEnv } from './env';
import { getAllSettings } from './settings';
import { AppError, ErrorCodes } from '@shared/errors';
import type { BackupKind, BackupRecord, BackupValidation } from '@shared/contracts';
import { DEFAULT_TIMEZONE } from '@shared/time';

const MANIFEST_FORMAT = 'hardware-shop-backup';
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

/** Tables counted in manifests and validation reports, when present in the schema. */
const COUNTED_TABLES = [
  'users',
  'audit_log',
  'products',
  'stock_movements',
  'customers',
  'invoices',
  'payments',
  'ledger_entries',
  'rental_agreements',
  'purchases',
  'expenses',
];

export interface BackupManifest {
  format: typeof MANIFEST_FORMAT;
  formatVersion: 1;
  kind: BackupKind;
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  shopName: string;
  sha256: string;
  sizeBytes: number;
  counts: Record<string, number>;
}

export function backupDirectory(env: AppEnv): string {
  return getAllSettings(env.db).backup.folder ?? env.paths.defaultBackupDir;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return hash.digest('hex');
}

function timestampForFileName(d: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: DEFAULT_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}${parts.second}`;
}

function countRows(db: Database.Database): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of COUNTED_TABLES) {
    if (tableExists(db, t)) counts[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  }
  return counts;
}

/**
 * Inspects a database file this process controls (it may be opened read-write).
 * Never call this on a user-selected file directly; use validateBackupFile, which works on a copy.
 */
function inspectDatabase(path: string): Omit<BackupValidation, 'filePath' | 'sizeBytes' | 'createdAt' | 'appVersion'> {
  const problems: string[] = [];
  let db: Database.Database | null = null;
  try {
    db = new Database(path, { fileMustExist: true });
    const integrity = db.pragma('integrity_check') as { integrity_check: string }[];
    if (integrity[0]?.integrity_check !== 'ok') problems.push('The file is damaged (SQLite integrity check failed).');
    if ((db.pragma('foreign_key_check') as unknown[]).length > 0) problems.push('Some records reference missing records.');
    if ((db.pragma('application_id', { simple: true }) as number) !== APPLICATION_ID) {
      problems.push('This is not a Hardware Shop Manager database.');
      return { valid: false, problems, schemaVersion: null, shopName: null, counts: {} };
    }
    const version = schemaVersion(db);
    if (version < 1 || version > LATEST_SCHEMA_VERSION) {
      problems.push(
        version > LATEST_SCHEMA_VERSION
          ? `The backup was made by a newer version of the application (schema ${version}).`
          : 'The backup has no schema version.',
      );
    } else {
      try {
        pendingMigrations(db);
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    let shopName: string | null = null;
    if (tableExists(db, 'settings')) {
      const row = db.prepare("SELECT value_json FROM settings WHERE key = 'shop'").get() as { value_json: string } | undefined;
      shopName = row ? ((JSON.parse(row.value_json) as { name?: string }).name ?? null) : null;
    }
    return { valid: problems.length === 0, problems, schemaVersion: version, shopName, counts: countRows(db) };
  } catch (e) {
    problems.push(`The file could not be read as a database: ${(e as Error).message}`);
    return { valid: false, problems, schemaVersion: null, shopName: null, counts: {} };
  } finally {
    db?.close();
  }
}

async function hasSqliteHeader(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(SQLITE_HEADER.length);
    await handle.read(buf, 0, buf.length, 0);
    return buf.equals(SQLITE_HEADER);
  } finally {
    await handle.close();
  }
}

async function readManifest(dbPath: string): Promise<BackupManifest | null> {
  const manifestPath = dbPath.replace(/\.db$/i, '.json');
  if (manifestPath === dbPath || !existsSync(manifestPath)) return null;
  try {
    const m = JSON.parse(await readFile(manifestPath, 'utf8')) as BackupManifest;
    return m.format === MANIFEST_FORMAT ? m : null;
  } catch {
    return null;
  }
}

/**
 * Validates any backup file without touching it: the file is copied to a private
 * temporary location and every check runs against the copy.
 */
export async function validateBackupFile(filePath: string): Promise<BackupValidation> {
  const base: BackupValidation = {
    filePath,
    valid: false,
    problems: [],
    schemaVersion: null,
    createdAt: null,
    appVersion: null,
    shopName: null,
    sizeBytes: 0,
    counts: {},
  };
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return { ...base, problems: ['The file does not exist or cannot be opened.'] };
  }
  base.sizeBytes = size;
  if (size < 512 || !(await hasSqliteHeader(filePath))) {
    return { ...base, problems: ['The file is not a SQLite database.'] };
  }

  const manifest = await readManifest(filePath);
  const problems: string[] = [];
  if (manifest) {
    const actual = await sha256File(filePath);
    if (actual !== manifest.sha256) problems.push('The file does not match its manifest checksum; it may be incomplete or altered.');
  }

  const workDir = join(tmpdir(), `hws-validate-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });
  const copy = join(workDir, 'candidate.db');
  try {
    await copyFile(filePath, copy);
    const inspected = inspectDatabase(copy);
    return {
      ...base,
      ...inspected,
      problems: [...problems, ...inspected.problems],
      valid: inspected.valid && problems.length === 0,
      createdAt: manifest?.createdAt ?? null,
      appVersion: manifest?.appVersion ?? null,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

interface BackupHistoryRecord {
  id: number;
  created_at: string;
  kind: BackupKind;
  file_name: string;
  file_path: string;
  size_bytes: number | null;
  sha256: string | null;
  schema_version: number | null;
  status: 'OK' | 'FAILED';
  message: string | null;
  username: string | null;
}

function toRecord(r: BackupHistoryRecord): BackupRecord {
  return {
    id: r.id,
    createdAt: r.created_at,
    kind: r.kind,
    fileName: r.file_name,
    filePath: r.file_path,
    sizeBytes: r.size_bytes,
    sha256: r.sha256,
    schemaVersion: r.schema_version,
    status: r.status,
    message: r.message,
    username: r.username,
    fileExists: existsSync(r.file_path),
  };
}

export function listBackups(env: AppEnv, limit = 200): BackupRecord[] {
  const rows = env.db
    .prepare(
      `SELECT b.*, u.username FROM backup_history b LEFT JOIN users u ON u.id = b.user_id
       ORDER BY b.id DESC LIMIT ?`,
    )
    .all(limit) as BackupHistoryRecord[];
  return rows.map(toRecord);
}

/**
 * Creates a consistent, verified backup using SQLite's online backup API (safe while
 * the app is in use), then records it in the backup history and audit log.
 * The file only appears under its final name once it has passed verification.
 */
export async function createBackup(env: AppEnv, actor: Actor, kind: BackupKind, targetDir?: string): Promise<BackupRecord> {
  const dir = targetDir ?? backupDirectory(env);
  const now = env.clock.now();
  let fileName = `HardwareShop_${timestampForFileName(now)}_${kind.toLowerCase().replace('_', '-')}.db`;
  let finalPath = join(dir, fileName);
  for (let n = 2; existsSync(finalPath); n++) {
    fileName = fileName.replace(/(_\d+)?\.db$/, `_${n}.db`);
    finalPath = join(dir, fileName);
  }
  const partialPath = `${finalPath}.partial`;

  const record = (status: 'OK' | 'FAILED', details: Partial<BackupHistoryRecord>): BackupRecord =>
    transact(env, actor, (tx) => {
      const id = Number(
        tx.db
          .prepare(
            `INSERT INTO backup_history (created_at, kind, file_name, file_path, size_bytes, sha256, schema_version,
               status, message, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            tx.nowIso,
            kind,
            fileName,
            finalPath,
            details.size_bytes ?? null,
            details.sha256 ?? null,
            details.schema_version ?? null,
            status,
            details.message ?? null,
            actor.userId,
          ).lastInsertRowid,
      );
      tx.audit({
        module: 'backup',
        entityType: 'backup',
        entityId: id,
        action: status === 'OK' ? 'BACKUP_CREATED' : 'BACKUP_FAILED',
        after: { kind, fileName, folder: dir, sizeBytes: details.size_bytes, sha256: details.sha256, message: details.message },
      });
      const row = tx.db
        .prepare('SELECT b.*, u.username FROM backup_history b LEFT JOIN users u ON u.id = b.user_id WHERE b.id = ?')
        .get(id) as BackupHistoryRecord;
      return toRecord(row);
    });

  try {
    await mkdir(dir, { recursive: true });
    await env.db.backup(partialPath);

    // Make the copy self-contained: no -wal/-shm side files are needed to read it.
    const copy = new Database(partialPath, { fileMustExist: true });
    copy.pragma('journal_mode = DELETE');
    copy.close();

    const inspected = inspectDatabase(partialPath);
    if (!inspected.valid) throw new Error(`Verification failed: ${inspected.problems.join(' ')}`);

    const sha256 = await sha256File(partialPath);
    const sizeBytes = (await stat(partialPath)).size;
    const manifest: BackupManifest = {
      format: MANIFEST_FORMAT,
      formatVersion: 1,
      kind,
      createdAt: now.toISOString(),
      appVersion: env.appVersion,
      schemaVersion: inspected.schemaVersion ?? 0,
      shopName: inspected.shopName ?? '',
      sha256,
      sizeBytes,
      counts: inspected.counts,
    };
    await writeFile(finalPath.replace(/\.db$/, '.json'), JSON.stringify(manifest, null, 2), 'utf8');
    await rename(partialPath, finalPath);
    env.logger.info(`Backup created: ${finalPath}`);
    return record('OK', { size_bytes: sizeBytes, sha256, schema_version: manifest.schemaVersion });
  } catch (e) {
    await rm(partialPath, { force: true }).catch(() => undefined);
    const message = (e as Error).message;
    env.logger.error(`Backup failed: ${message}`);
    try {
      record('FAILED', { message });
    } catch (recordError) {
      env.logger.error('Could not record the failed backup', recordError);
    }
    throw new AppError(ErrorCodes.IO, `The backup could not be created: ${message}`);
  }
}

/** Copies the newest verified backup (and its manifest) to another folder, e.g. a USB drive, and re-verifies the copy. */
export async function copyLatestBackupTo(env: AppEnv, actor: Actor, destDir: string): Promise<string> {
  const latest = listBackups(env).find((b) => b.status === 'OK' && b.fileExists);
  if (!latest) throw new AppError(ErrorCodes.NOT_FOUND, 'There is no backup to copy yet. Create a backup first.');
  const dest = join(destDir, basename(latest.filePath));
  if (existsSync(dest)) throw new AppError(ErrorCodes.CONFLICT, `${basename(dest)} already exists in that folder.`);
  await copyFile(latest.filePath, dest);
  const manifestSrc = latest.filePath.replace(/\.db$/, '.json');
  if (existsSync(manifestSrc)) await copyFile(manifestSrc, dest.replace(/\.db$/, '.json'));
  const copiedHash = await sha256File(dest);
  if (latest.sha256 && copiedHash !== latest.sha256) {
    await rm(dest, { force: true });
    throw new AppError(ErrorCodes.IO, 'The copied file did not match the original. The drive may be faulty or full.');
  }
  transact(env, actor, (tx) =>
    tx.audit({
      module: 'backup',
      entityType: 'backup',
      entityId: latest.id,
      action: 'BACKUP_COPIED',
      after: { fileName: latest.fileName, destination: dirname(dest) },
    }),
  );
  return dest;
}
