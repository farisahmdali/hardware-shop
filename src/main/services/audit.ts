import type { Db } from '../db/connection';
import type { AuditRow, Paged } from '@shared/contracts';

export interface AuditFilter {
  page: number;
  pageSize: number;
  module?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  userId?: number;
  /** Inclusive lower bound, ISO instant. */
  from?: string;
  /** Exclusive upper bound, ISO instant. */
  to?: string;
  search?: string;
}

interface AuditRecord {
  id: number;
  occurred_at: string;
  user_id: number | null;
  username: string | null;
  module: string;
  entity_type: string;
  entity_id: string | null;
  action: string;
  before_json: string | null;
  after_json: string | null;
  reason: string | null;
  txn_ref: string | null;
  related_type: string | null;
  related_id: string | null;
}

const toRow = (r: AuditRecord): AuditRow => ({
  id: r.id,
  occurredAt: r.occurred_at,
  userId: r.user_id,
  username: r.username,
  module: r.module,
  entityType: r.entity_type,
  entityId: r.entity_id,
  action: r.action,
  before: r.before_json ? JSON.parse(r.before_json) : null,
  after: r.after_json ? JSON.parse(r.after_json) : null,
  reason: r.reason,
  txnRef: r.txn_ref,
  relatedType: r.related_type,
  relatedId: r.related_id,
});

export function listAudit(db: Db, f: AuditFilter): Paged<AuditRow> {
  const where: string[] = [];
  const params: unknown[] = [];
  const eq = (column: string, value: unknown) => {
    if (value === undefined || value === '') return;
    where.push(`${column} = ?`);
    params.push(value);
  };
  eq('module', f.module);
  eq('entity_type', f.entityType);
  eq('entity_id', f.entityId);
  eq('action', f.action);
  eq('user_id', f.userId);
  if (f.from) {
    where.push('occurred_at >= ?');
    params.push(f.from);
  }
  if (f.to) {
    where.push('occurred_at < ?');
    params.push(f.to);
  }
  if (f.search) {
    const like = `%${f.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(
      `(entity_id = ? OR related_id = ? OR txn_ref = ? OR reason LIKE ? ESCAPE '\\'
        OR after_json LIKE ? ESCAPE '\\' OR before_json LIKE ? ESCAPE '\\')`,
    );
    params.push(f.search, f.search, f.search, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${clause}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, f.pageSize, (f.page - 1) * f.pageSize) as AuditRecord[];
  return { rows: rows.map(toRow), total, page: f.page, pageSize: f.pageSize };
}

export function auditFacets(db: Db) {
  const distinct = (column: string) =>
    (db.prepare(`SELECT DISTINCT ${column} AS v FROM audit_log ORDER BY v`).all() as { v: string }[]).map((r) => r.v);
  return { modules: distinct('module'), actions: distinct('action'), entityTypes: distinct('entity_type') };
}
