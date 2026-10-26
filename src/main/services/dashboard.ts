import type { Db } from '../db/connection';
import { incomeFigures } from '../reports/financial';
import { daysBetween, addDays } from '../reports/periods';
import type { Permission } from '@shared/permissions';
import type { DashboardChange, DashboardPeriod, DashboardRecent, DashboardTransaction } from '@shared/contracts';

const NOT_CANCELLED = 'NOT EXISTS (SELECT 1 FROM invoice_cancellations x WHERE x.invoice_id = i.id)';

/** Billed amounts per day: invoices of one kind (not cancelled) less credit notes on that kind. */
function billedByDay(db: Db, kind: 'SALE' | 'RENTAL', from: string, to: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of db
    .prepare(`SELECT i.business_date AS d, SUM(i.grand_total) AS t FROM invoices i WHERE i.kind = ? AND i.business_date BETWEEN ? AND ? AND ${NOT_CANCELLED} GROUP BY d`)
    .all(kind, from, to) as { d: string; t: number }[]) {
    out.set(r.d, r.t);
  }
  for (const r of db
    .prepare(
      `SELECT cn.business_date AS d, SUM(cn.total) AS t FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id
       WHERE i.kind = ? AND cn.business_date BETWEEN ? AND ? GROUP BY d`,
    )
    .all(kind, from, to) as { d: string; t: number }[]) {
    out.set(r.d, (out.get(r.d) ?? 0) - r.t);
  }
  return out;
}

/**
 * The dashboard's figures for a period. Sales, rental billing, money collected, deposits,
 * expenses and profit are separate figures, worked out separately, and never added together.
 */
export function dashboardPeriod(db: Db, from: string, to: string, permissions: readonly Permission[]): DashboardPeriod {
  const has = (p: Permission) => permissions.includes(p);
  const sales = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(i.grand_total), 0) AS t FROM invoices i WHERE i.kind = 'SALE' AND i.business_date BETWEEN ? AND ? AND ${NOT_CANCELLED}`)
    .get(from, to) as { n: number; t: number };
  const credited = (kind: 'SALE' | 'RENTAL') =>
    (
      db
        .prepare('SELECT COALESCE(SUM(cn.total), 0) AS t FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id WHERE i.kind = ? AND cn.business_date BETWEEN ? AND ?')
        .get(kind, from, to) as { t: number }
    ).t;
  const rental = (
    db.prepare(`SELECT COALESCE(SUM(i.grand_total), 0) AS t FROM invoices i WHERE i.kind = 'RENTAL' AND i.business_date BETWEEN ? AND ? AND ${NOT_CANCELLED}`).get(from, to) as {
      t: number;
    }
  ).t;
  const salesReturns = credited('SALE');

  const byMethod = db
    .prepare(
      `SELECT m.name, SUM(x.amount) AS amount FROM (
         SELECT p.method_id, p.amount FROM payments p
         WHERE p.party_type = 'CUSTOMER' AND p.direction = 'IN' AND p.business_date BETWEEN ? AND ?
         UNION ALL
         SELECT p.method_id, -p.amount FROM payment_reversals r JOIN payments p ON p.id = r.payment_id
         WHERE p.party_type = 'CUSTOMER' AND p.direction = 'IN' AND r.business_date BETWEEN ? AND ?) x
       JOIN payment_methods m ON m.id = x.method_id GROUP BY m.id HAVING SUM(x.amount) != 0 ORDER BY m.sort_order`,
    )
    .all(from, to, from, to) as { name: string; amount: number }[];
  const refunds = (
    db
      .prepare(
        `SELECT COALESCE(SUM(p.amount), 0) - COALESCE((SELECT SUM(q.amount) FROM payment_reversals r JOIN payments q ON q.id = r.payment_id
                 WHERE q.party_type = 'CUSTOMER' AND q.direction = 'OUT' AND r.business_date BETWEEN ? AND ?), 0) AS t
         FROM payments p WHERE p.party_type = 'CUSTOMER' AND p.direction = 'OUT' AND p.business_date BETWEEN ? AND ?`,
      )
      .get(from, to, from, to) as { t: number }
  ).t;
  const deposits = db
    .prepare(
      `SELECT COALESCE(SUM(CASE type WHEN 'COLLECT' THEN amount ELSE 0 END), 0) AS collected,
              COALESCE(SUM(CASE type WHEN 'COLLECT' THEN 0 ELSE amount END), 0) AS released
       FROM deposit_transactions WHERE business_date BETWEEN ? AND ?`,
    )
    .get(from, to) as { collected: number; released: number };

  const seeExpenses = has('expenses.manage') || has('reports.financial');
  const figures = has('reports.financial') || seeExpenses ? incomeFigures(db, from, to) : null;

  let daily: DashboardPeriod['daily'] = null;
  if (daysBetween(from, to) <= 62) {
    const s = billedByDay(db, 'SALE', from, to);
    const r = billedByDay(db, 'RENTAL', from, to);
    daily = [];
    for (let d = from; d <= to; d = addDays(d, 1)) daily.push({ date: d, sales: s.get(d) ?? 0, rental: r.get(d) ?? 0 });
  }

  return {
    from,
    to,
    sales: { invoices: sales.n, total: sales.t - salesReturns, returns: salesReturns },
    rentalBilled: rental - credited('RENTAL'),
    collected: byMethod.reduce((a, m) => a + m.amount, 0),
    refunds,
    collectedByMethod: byMethod,
    deposits,
    expenses: seeExpenses && figures ? figures.costs.expenses : null,
    profit:
      has('reports.financial') && figures
        ? { revenue: figures.revenue, cogs: figures.cogs, gross: figures.gross, running: figures.running, net: figures.net }
        : null,
    daily,
  };
}

/** Actions worth the owner's attention on the dashboard: corrections, overrides, write-offs, denials. */
const SIGNIFICANT = [
  'CANCEL',
  'REVERSE',
  'VOID',
  'DENIED',
  'PRICE_CHANGE',
  'BALANCE_ADJUSTED',
  'OPENING_BALANCE',
  'NEGATIVE_STOCK_OVERRIDE',
  'STOCK_DAMAGE',
  'STOCK_LOSS',
  'CASH_SHORT',
  'CASH_OVER',
  'DEACTIVATE',
  'PERMISSIONS_CHANGED',
  'SECRET_RESET',
  'RATES_CHANGED',
  'SUPPLIER_RETURN',
  'BACKUP_RESTORED',
  'ACCOUNT_LOCKED',
];

export function dashboardRecent(db: Db, permissions: readonly Permission[]): DashboardRecent {
  const has = (p: Permission) => permissions.includes(p);
  const parts = [
    `SELECT CASE i.kind WHEN 'RENTAL' THEN 'RENTAL_BILL' ELSE 'SALE' END AS kind, i.id, i.invoice_no AS docNo, i.issued_at AS at,
            i.customer_name AS party, i.grand_total AS amount,
            EXISTS (SELECT 1 FROM invoice_cancellations x WHERE x.invoice_id = i.id) AS cancelled
     FROM invoices i ORDER BY i.id DESC LIMIT 12`,
    `SELECT CASE p.direction WHEN 'IN' THEN 'PAYMENT' ELSE 'REFUND' END, p.party_id, p.payment_no, p.received_at, c.name, p.amount,
            EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)
     FROM payments p JOIN customers c ON c.id = p.party_id WHERE p.party_type = 'CUSTOMER' ORDER BY p.id DESC LIMIT 12`,
  ];
  if (has('purchases.manage') || has('suppliers.pay') || has('reports.financial')) {
    parts.push(
      `SELECT 'PURCHASE', p.id, p.purchase_no, p.received_at, p.supplier_name, p.grand_total,
              EXISTS (SELECT 1 FROM purchase_cancellations c WHERE c.purchase_id = p.id)
       FROM purchases p ORDER BY p.id DESC LIMIT 12`,
    );
  }
  if (has('expenses.manage') || has('reports.financial')) {
    parts.push(
      `SELECT 'EXPENSE', e.id, e.expense_no, e.created_at, e.description, e.amount, e.status = 'VOID'
       FROM expenses e ORDER BY e.id DESC LIMIT 12`,
    );
  }
  const transactions = (
    db.prepare(`SELECT * FROM (${parts.map((p) => `SELECT * FROM (${p})`).join(' UNION ALL ')}) ORDER BY at DESC LIMIT 12`).all() as (Omit<
      DashboardTransaction,
      'cancelled'
    > & { cancelled: number })[]
  ).map((t) => ({ ...t, cancelled: t.cancelled === 1 }));

  const changes = has('audit.view')
    ? (db
        .prepare(
          `SELECT id, occurred_at AS at, username, module, entity_type AS entityType, entity_id AS entityId, action, reason
           FROM audit_log WHERE action IN (${SIGNIFICANT.map(() => '?').join(', ')}) OR (module = 'settings' AND action = 'UPDATE')
           ORDER BY id DESC LIMIT 10`,
        )
        .all(...SIGNIFICANT) as DashboardChange[])
    : null;
  return { transactions, changes };
}
