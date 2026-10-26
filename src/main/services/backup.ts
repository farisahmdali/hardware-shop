import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { APPLICATION_ID, openDatabase, tableExists } from '../db/connection';
import { LATEST_SCHEMA_VERSION, migrate, pendingMigrations, schemaVersion } from '../db/migrator';
import { transact, type Actor } from '../db/tx';
import type { AppEnv, Logger } from './env';
import { runIntegrityChecks } from './integrity';
import { backupsToRemove } from './backupSchedule';
import { getAllSettings } from './settings';
import { AppError, ErrorCodes } from '@shared/errors';
import type { BackupKind, BackupRecord, BackupValidation, DatabaseInspection, IntegrityReport, RestoreSummary } from '@shared/contracts';
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
export function inspectDatabase(path: string): DatabaseInspection {
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
const inspect = (env: AppEnv | undefined, path: string): Promise<DatabaseInspection> =>
  env?.inspectFile ? env.inspectFile(path) : Promise.resolve(inspectDatabase(path));

export async function validateBackupFile(filePath: string, env?: AppEnv): Promise<BackupValidation> {
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
    const inspected = await inspect(env, copy);
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
  removed_at: string | null;
  removed_reason: string | null;
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
    removedAt: r.removed_at,
    removedReason: r.removed_reason,
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

    const inspected = await inspect(env, partialPath);
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

/**
 * Removes what a backup interrupted by a crash or power cut leaves in the backup folder: the
 * unfinished `.partial` copy (and its SQLite side files) and a manifest whose backup never got its
 * final name. Finished backups are never touched. Returns the names removed.
 */
export async function removeInterruptedBackups(env: AppEnv): Promise<string[]> {
  const dir = backupDirectory(env);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    const stray =
      /\.db\.partial(-journal|-wal|-shm)?$/.test(lower) ||
      (lower.startsWith('hardwareshop_') && lower.endsWith('.json') && !existsSync(join(dir, name.replace(/\.json$/i, '.db'))));
    if (!stray) continue;
    try {
      await rm(join(dir, name), { force: true });
      removed.push(name);
    } catch (e) {
      env.logger.warn(`Could not remove ${name} left by an interrupted backup: ${(e as Error).message}`);
    }
  }
  if (removed.length) env.logger.warn(`Removed files left by an interrupted backup: ${removed.join(', ')}`);
  return removed;
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

// ---------- Retention ----------

/**
 * Removes automatic backups the retention policy no longer needs (see backupsToRemove). The
 * history entry of each removed file is kept, marked removed, and the removal is recorded.
 */
export async function pruneBackups(env: AppEnv, actor: Actor): Promise<string[]> {
  const settings = getAllSettings(env.db).backup;
  const rows = listBackups(env, 5000);
  const ids = new Set(backupsToRemove(rows, env.clock.now(), settings, env.timeZone ?? DEFAULT_TIMEZONE));
  const removed: string[] = [];
  for (const b of rows.filter((r) => ids.has(r.id))) {
    try {
      await rm(b.filePath, { force: true });
      await rm(b.filePath.replace(/\.db$/, '.json'), { force: true });
      removed.push(b.fileName);
      transact(env, actor, (tx) =>
        tx.db
          .prepare('UPDATE backup_history SET removed_at = ?, removed_reason = ? WHERE id = ?')
          .run(tx.nowIso, `Older than the retention policy keeps (${settings.keepAutoCount} latest, one a day for ${settings.keepDailyDays} days)`, b.id),
      );
    } catch (e) {
      env.logger.warn(`Could not remove old backup ${b.filePath}: ${(e as Error).message}`);
    }
  }
  if (removed.length) {
    transact(env, actor, (tx) => tx.audit({ module: 'backup', entityType: 'backup', action: 'BACKUP_PRUNED', after: { files: removed, count: removed.length } }));
  }
  return removed;
}

// ---------- Restore ----------

/**
 * Adds to the backup history any verified backup found in these folders that the history does not
 * list, e.g. backups made after the moment a restored backup was taken, including the copy made just
 * before the restore.
 */
export async function reconcileBackupHistory(env: AppEnv, folders: string[]): Promise<number> {
  let added = 0;
  const known = new Set((env.db.prepare('SELECT file_path FROM backup_history').all() as { file_path: string }[]).map((r) => r.file_path.toLowerCase()));
  for (const folder of [...new Set(folders)]) {
    let names: string[];
    try {
      names = await readdir(folder);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => n.toLowerCase().endsWith('.json'))) {
      const dbPath = join(folder, name.replace(/\.json$/i, '.db'));
      if (known.has(dbPath.toLowerCase()) || !existsSync(dbPath)) continue;
      const manifest = await readManifest(dbPath);
      if (!manifest) continue;
      env.db
        .prepare(
          `INSERT INTO backup_history (created_at, kind, file_name, file_path, size_bytes, sha256, schema_version, status, message)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'OK', ?)`,
        )
        .run(manifest.createdAt, manifest.kind, basename(dbPath), dbPath, manifest.sizeBytes, manifest.sha256, manifest.schemaVersion, 'Found in the backup folder after a restore');
      known.add(dbPath.toLowerCase());
      added++;
    }
  }
  return added;
}

const stagedPath = (dbPath: string) => `${dbPath}.restoring`;
const previousPath = (dbPath: string) => `${dbPath}.before-restore`;

async function removeSideFiles(dbPath: string): Promise<void> {
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });
}

/**
 * Replaces the shop data with a backup:
 *  1. the backup is validated (a damaged, foreign or newer-version file is refused);
 *  2. a verified copy of the current data is saved first; if that fails nothing is restored;
 *  3. the backup is copied next to the database and checked against the original;
 *  4. the database is closed and the files swapped; the old file is kept beside it until the end;
 *  5. the restored database is opened, upgraded if it is from an older version, and checked;
 *  6. the backup history is completed from the backup folders and the restore is recorded.
 * The restore is all or nothing: if any of steps 4-6 fails, or the application stops part way,
 * the original database is put back (see recoverInterruptedRestore).
 */
export async function restoreBackup(
  env: AppEnv,
  actor: Actor,
  filePath: string,
  hooks: { beforeSwap(): Promise<void>; /** The data checks off the main thread, on the restored file. */ checks?(): Promise<IntegrityReport> },
): Promise<RestoreSummary> {
  // A refused or failed attempt is recorded in the data that stays in use.
  const refuse = (error: AppError): AppError => {
    try {
      transact(env, actor, (tx) =>
        tx.audit({ module: 'backup', entityType: 'backup', action: 'RESTORE_FAILED', after: { fileName: basename(filePath), folder: dirname(filePath), problem: error.message } }),
      );
    } catch (e) {
      env.logger.error('Could not record the failed restore', e);
    }
    return error;
  };

  const validation = await validateBackupFile(filePath, env);
  if (!validation.valid) {
    throw refuse(new AppError(ErrorCodes.BACKUP_INVALID, `This backup cannot be restored: ${validation.problems.join(' ')}`, { problems: validation.problems }));
  }
  let pre: BackupRecord;
  try {
    pre = await createBackup(env, actor, 'PRE_RESTORE');
  } catch (e) {
    throw refuse(new AppError(ErrorCodes.IO, `Nothing was restored, because a copy of the current data could not be saved first. ${(e as Error).message}`));
  }

  const dbPath = env.paths.databasePath;
  const staged = stagedPath(dbPath);
  const previous = previousPath(dbPath);
  await rm(staged, { force: true });
  await copyFile(filePath, staged);
  if ((await sha256File(staged)) !== (await sha256File(filePath))) {
    await rm(staged, { force: true });
    throw refuse(new AppError(ErrorCodes.IO, 'The backup could not be copied correctly. Nothing was restored.'));
  }

  await hooks.beforeSwap();
  env.db.close();
  await removeSideFiles(dbPath);
  await rm(previous, { force: true });
  await rename(dbPath, previous);
  let summary: RestoreSummary;
  try {
    await rename(staged, dbPath);
    env.db = openDatabase(dbPath);
    const migrationsApplied = migrate(env.db);
    await reconcileBackupHistory(env, [dirname(pre.filePath), backupDirectory(env)]);
    const issues = (hooks.checks ? await hooks.checks() : runIntegrityChecks(env.db)).issues;
    // The person restoring may not exist in the restored data (added after the backup was taken).
    const sameUser =
      actor.userId !== null && !!env.db.prepare('SELECT 1 FROM users WHERE id = ? AND username = ? COLLATE NOCASE').get(actor.userId, actor.username);
    transact(env, sameUser ? actor : { userId: null, username: actor.username }, (tx) =>
      tx.audit({
        module: 'backup',
        entityType: 'backup',
        action: 'BACKUP_RESTORED',
        after: {
          fileName: basename(filePath),
          folder: dirname(filePath),
          backupCreatedAt: validation.createdAt,
          preRestoreBackup: pre.fileName,
          schemaVersion: validation.schemaVersion,
          migrationsApplied,
          problemsFound: issues.length,
        },
      }),
    );
    summary = { restoredFrom: filePath, backupCreatedAt: validation.createdAt, preRestoreBackup: pre.filePath, migrationsApplied, issues };
  } catch (e) {
    env.logger.error('Restore failed; putting the original database back', e);
    if (env.db.open) env.db.close();
    await rm(dbPath, { force: true });
    await removeSideFiles(dbPath);
    await rename(previous, dbPath);
    env.db = openDatabase(dbPath);
    throw refuse(new AppError(ErrorCodes.IO, `The backup could not be restored, so your current data was put back unchanged. ${(e as Error).message}`));
  }
  // Only now is the restore complete; until here a restart would put the original back.
  await rm(previous, { force: true });
  env.logger.info(`Restored ${filePath}; previous data saved as ${pre.filePath}`);
  return summary;
}

/**
 * At startup: if the application stopped part way through a restore, the original database is
 * still beside the data file, so the restore did not finish (and was not recorded). Put the
 * original back. Leftover staging files are removed.
 */
export async function recoverInterruptedRestore(dbPath: string, logger: Logger): Promise<void> {
  const previous = previousPath(dbPath);
  if (existsSync(previous)) {
    await rm(dbPath, { force: true });
    await removeSideFiles(dbPath);
    await rename(previous, dbPath);
    logger.warn('A restore was interrupted; the original database was put back.');
  }
  await rm(stagedPath(dbPath), { force: true });
}
