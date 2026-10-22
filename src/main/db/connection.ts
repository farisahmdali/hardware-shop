import Database from 'better-sqlite3';

export type Db = Database.Database;

/** Identifies a SQLite file as belonging to this application ("HWS1"). */
export const APPLICATION_ID = 0x48575331;

export interface OpenOptions {
  readonly?: boolean;
}

/**
 * Opens the shop database with the settings every connection must use:
 * WAL journaling, full fsync on commit (a committed sale survives power loss),
 * enforced foreign keys and a busy timeout for the report worker.
 */
export function openDatabase(file: string, opts: OpenOptions = {}): Db {
  const db = new Database(file, { readonly: opts.readonly ?? false, fileMustExist: opts.readonly ?? false });
  if (!opts.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -32000');
  return db;
}

export function tableExists(db: Db, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}
