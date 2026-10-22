import { randomUUID } from 'node:crypto';
import type { Db } from './connection';
import { DocTypes, formatDocNumber, type DocType } from '@shared/docNumbers';
import { businessDateOf, fiscalYearOf, DEFAULT_TIMEZONE } from '@shared/time';
import { AppError, ErrorCodes } from '@shared/errors';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Who is performing an operation. `userId` is null only for system actions (setup, scheduled backups). */
export interface Actor {
  userId: number | null;
  username: string | null;
}

export const SYSTEM_ACTOR: Actor = { userId: null, username: 'system' };

export interface DbEnv {
  db: Db;
  clock: Clock;
  timeZone?: string;
}

export interface AuditEntry {
  module: string;
  entityType: string;
  entityId?: string | number | null;
  action: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  relatedType?: string | null;
  relatedId?: string | number | null;
}

const SENSITIVE_KEY = /secret|password|passcode|hash|pin$|^pin|token/i;

/** Strips credentials and other secrets before a value is written to the audit log. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v);
    return out;
  }
  return value;
}

const toJson = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(redact(value)));
const toText = (value: string | number | null | undefined): string | null =>
  value === undefined || value === null ? null : String(value);

/**
 * One unit of work. Every row written through a Tx — business records, stock
 * movements, ledger entries and audit entries — commits or rolls back together,
 * and shares one `txnRef` so related changes can be traced as a group.
 */
export class Tx {
  readonly txnRef = randomUUID();
  readonly nowIso: string;
  readonly businessDate: string;

  constructor(
    readonly db: Db,
    /** Mutable only so first-run setup can attribute its writes to the owner account it just created. */
    public actor: Actor,
    now: Date,
    timeZone: string,
  ) {
    this.nowIso = now.toISOString();
    this.businessDate = businessDateOf(now, timeZone);
  }

  audit(entry: AuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (occurred_at, user_id, username, module, entity_type, entity_id, action,
           before_json, after_json, reason, txn_ref, related_type, related_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.nowIso,
        this.actor.userId,
        this.actor.username,
        entry.module,
        entry.entityType,
        toText(entry.entityId),
        entry.action,
        toJson(entry.before),
        toJson(entry.after),
        entry.reason ?? null,
        this.txnRef,
        entry.relatedType ?? null,
        toText(entry.relatedId),
      );
  }

  /** Issues the next gap-free document number; rolled back with the transaction if it fails. */
  nextDocNumber(docType: DocType): string {
    const fy = fiscalYearOf(this.businessDate);
    const row = this.db
      .prepare(
        `INSERT INTO doc_sequences (doc_type, fiscal_year, next_value) VALUES (?, ?, 2)
         ON CONFLICT (doc_type, fiscal_year) DO UPDATE SET next_value = next_value + 1
         RETURNING next_value - 1 AS value`,
      )
      .get(docType, fy) as { value: number };
    return formatDocNumber(DocTypes[docType].prefix, fy, row.value);
  }

  /**
   * Issues the next master-data code such as P-000123, skipping any value already
   * taken in `table.column` (users may type their own codes).
   */
  nextCode(series: string, prefix: string, width: number, table: string, column: string): string {
    const exists = this.db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`);
    const next = this.db.prepare(
      `INSERT INTO doc_sequences (doc_type, fiscal_year, next_value) VALUES (?, '-', 2)
       ON CONFLICT (doc_type, fiscal_year) DO UPDATE SET next_value = next_value + 1
       RETURNING next_value - 1 AS value`,
    );
    for (;;) {
      const { value } = next.get(series) as { value: number };
      const code = `${prefix}-${String(value).padStart(width, '0')}`;
      if (!exists.get(code)) return code;
    }
  }

  /**
   * Runs `fn` at most once per idempotency key. A retried request (double click,
   * resubmission after an error) gets the stored result of the first run.
   */
  once<T>(key: string, command: string, fn: () => T): T {
    const existing = this.db
      .prepare('SELECT command, result_json FROM idempotency_keys WHERE key = ?')
      .get(key) as { command: string; result_json: string } | undefined;
    if (existing) {
      if (existing.command !== command) {
        throw new AppError(ErrorCodes.CONFLICT, 'This request id was already used for a different operation.');
      }
      return JSON.parse(existing.result_json) as T;
    }
    const result = fn();
    this.db
      .prepare('INSERT INTO idempotency_keys (key, command, result_json, created_at) VALUES (?, ?, ?, ?)')
      .run(key, command, JSON.stringify(result ?? null), this.nowIso);
    return result;
  }

  /** Optimistic-lock helper: throws STALE_RECORD unless exactly one row was updated. */
  expectOneChange(changes: number, what: string): void {
    if (changes !== 1) {
      throw new AppError(
        ErrorCodes.STALE_RECORD,
        `${what} was changed by someone else or no longer exists. Reload and try again.`,
      );
    }
  }
}

/**
 * Runs `fn` inside a BEGIN IMMEDIATE transaction. If `fn` throws, nothing it wrote
 * (including audit entries and document numbers) is kept.
 */
export function transact<T>(env: DbEnv, actor: Actor, fn: (tx: Tx) => T): T {
  const run = env.db.transaction(() => {
    const tx = new Tx(env.db, actor, env.clock.now(), env.timeZone ?? DEFAULT_TIMEZONE);
    const result = fn(tx);
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      throw new Error('transact() callbacks must be synchronous');
    }
    return result;
  });
  return run.immediate();
}
