import type { Db } from '../db/connection';
import type { AuditRow, Paged } from '@shared/contracts';

export interface AuditFilter {
  page: number;
  pageSize: number;
  module?: string;
  entityType?: string;
  entityId?: string;
  /** Entries about a record or linked to it (e.g. a customer's payments, a product's cost changes). */
  record?: { type: string; id: string };
  action?: string;
  userId?: number;
  /** Everything written in one transaction. */
  txnRef?: string;
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

/**
 * Records whose number, code or name matches the search text, as the record types the history
 * uses. Searching "claw hammer" then finds every entry about that product, not only those whose
 * stored values happen to contain the words. Arguments: x = exact value, l = LIKE pattern,
 * in the order of the query's placeholders.
 */
const NAMED: { type: string; sql: string; args: ('x' | 'l')[]; asRelated?: boolean }[] = [
  { type: 'product', sql: "SELECT id FROM products WHERE sku = ? COLLATE NOCASE OR name LIKE ? ESCAPE '!'", args: ['x', 'l'] },
  { type: 'customer', sql: "SELECT id FROM customers WHERE code = ? COLLATE NOCASE OR name LIKE ? ESCAPE '!' OR phone LIKE ? ESCAPE '!'", args: ['x', 'l', 'l'] },
  { type: 'supplier', sql: "SELECT id FROM suppliers WHERE code = ? COLLATE NOCASE OR name LIKE ? ESCAPE '!' OR phone LIKE ? ESCAPE '!'", args: ['x', 'l', 'l'] },
  { type: 'invoice', sql: 'SELECT id FROM invoices WHERE invoice_no = ? COLLATE NOCASE', args: ['x'] },
  { type: 'credit_note', sql: 'SELECT id FROM credit_notes WHERE credit_note_no = ? COLLATE NOCASE', args: ['x'], asRelated: true },
  { type: 'purchase', sql: 'SELECT id FROM purchases WHERE purchase_no = ? COLLATE NOCASE OR supplier_invoice_no = ? COLLATE NOCASE', args: ['x', 'x'] },
  { type: 'debit_note', sql: 'SELECT id FROM debit_notes WHERE debit_note_no = ? COLLATE NOCASE', args: ['x'], asRelated: true },
  { type: 'payment', sql: "SELECT id FROM payments WHERE party_type = 'CUSTOMER' AND payment_no = ? COLLATE NOCASE", args: ['x'] },
  { type: 'supplier_payment', sql: "SELECT id FROM payments WHERE party_type = 'SUPPLIER' AND payment_no = ? COLLATE NOCASE", args: ['x'] },
  { type: 'rental', sql: 'SELECT id FROM rental_agreements WHERE rental_no = ? COLLATE NOCASE', args: ['x'] },
  { type: 'rental_product', sql: "SELECT id FROM rental_products WHERE code = ? COLLATE NOCASE OR name LIKE ? ESCAPE '!'", args: ['x', 'l'] },
  { type: 'rental_asset', sql: 'SELECT id FROM rental_assets WHERE asset_tag = ? COLLATE NOCASE OR serial_no = ? COLLATE NOCASE', args: ['x', 'x'] },
  { type: 'expense', sql: "SELECT id FROM expenses WHERE expense_no = ? COLLATE NOCASE OR description LIKE ? ESCAPE '!'", args: ['x', 'l'] },
  { type: 'stock_count', sql: 'SELECT id FROM stock_counts WHERE count_no = ? COLLATE NOCASE', args: ['x'] },
  { type: 'cash_entry', sql: 'SELECT id FROM cash_entries WHERE entry_no = ? COLLATE NOCASE', args: ['x'] },
];

function namedMatches(db: Db, text: string): { type: string; ids: string[]; asRelated: boolean }[] {
  const like = `%${text.replace(/[%_!]/g, (c) => `!${c}`)}%`;
  const out: { type: string; ids: string[]; asRelated: boolean }[] = [];
  for (const n of NAMED) {
    const ids = (db.prepare(`${n.sql} LIMIT 50`).all(...n.args.map((a) => (a === 'x' ? text : like))) as { id: number }[]).map((r) => String(r.id));
    if (ids.length) out.push({ type: n.type, ids, asRelated: !!n.asRelated });
  }
  return out;
}

function whereClause(db: Db, f: Omit<AuditFilter, 'page' | 'pageSize'>): { clause: string; params: unknown[] } {
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
  eq('txn_ref', f.txnRef);
  if (f.record) {
    where.push('((entity_type = ? AND entity_id = ?) OR (related_type = ? AND related_id = ?))');
    params.push(f.record.type, f.record.id, f.record.type, f.record.id);
  }
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
    const parts = [
      'entity_id = ?',
      'related_id = ?',
      'txn_ref = ?',
      "reason LIKE ? ESCAPE '\\'",
      "after_json LIKE ? ESCAPE '\\'",
      "before_json LIKE ? ESCAPE '\\'",
      "username LIKE ? ESCAPE '\\'",
    ];
    params.push(f.search, f.search, f.search, like, like, like, like);
    for (const m of namedMatches(db, f.search)) {
      const marks = m.ids.map(() => '?').join(', ');
      parts.push(m.asRelated ? `(related_type = ? AND related_id IN (${marks}))` : `((entity_type = ? AND entity_id IN (${marks})) OR (related_type = ? AND related_id IN (${marks})))`);
      params.push(m.type, ...m.ids, ...(m.asRelated ? [] : [m.type, ...m.ids]));
    }
    where.push(`(${parts.join(' OR ')})`);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function listAudit(db: Db, f: AuditFilter): Paged<AuditRow> {
  const { clause, params } = whereClause(db, f);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${clause}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, f.pageSize, (f.page - 1) * f.pageSize) as AuditRecord[];
  return { rows: rows.map(toRow), total, page: f.page, pageSize: f.pageSize };
}

/** Matching entries for export, oldest first, up to `limit` (plus one, to tell whether more exist). */
export function auditForExport(db: Db, f: Omit<AuditFilter, 'page' | 'pageSize'>, limit: number): { rows: AuditRow[]; truncated: boolean } {
  const { clause, params } = whereClause(db, f);
  const rows = db.prepare(`SELECT * FROM (SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ?) ORDER BY id`).all(...params, limit + 1) as AuditRecord[];
  // The newest `limit` entries are kept when there are more.
  return { rows: rows.slice(rows.length > limit ? 1 : 0).map(toRow), truncated: rows.length > limit };
}

export function auditFacets(db: Db) {
  const distinct = (column: string) =>
    (db.prepare(`SELECT DISTINCT ${column} AS v FROM audit_log ORDER BY v`).all() as { v: string }[]).map((r) => r.v);
  const users = db
    .prepare(
      `SELECT a.user_id AS id, COALESCE(u.display_name, MAX(a.username)) AS name, MAX(a.username) AS username
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.user_id IS NOT NULL GROUP BY a.user_id ORDER BY name`,
    )
    .all() as { id: number; name: string; username: string }[];
  return { modules: distinct('module'), actions: distinct('action'), entityTypes: distinct('entity_type'), users };
}
