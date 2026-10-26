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
  reuseStatements(db);
  return db;
}

/**
 * better-sqlite3 keeps every prepared statement, with its native memory, until the connection
 * is closed; preparing the same SQL on every request made memory grow without limit while the
 * application stayed open (about 2.7 KB per call, measured). Each distinct SQL text is therefore
 * prepared once per connection and reused. Sharing is safe because statements here only run to
 * completion (get/all/run): none is iterated or switched to pluck/raw/expand mode.
 */
function reuseStatements(db: Db): void {
  const prepared = new Map<string, Database.Statement>();
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    let statement = prepared.get(sql);
    if (!statement) {
      statement = prepare(sql);
      prepared.set(sql, statement);
    }
    return statement;
  }) as Db['prepare'];
}

export function tableExists(db: Db, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}
