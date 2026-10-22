import type { Db } from '../db/connection';
import { APPLICATION_ID } from '../db/connection';
import { LATEST_SCHEMA_VERSION, schemaVersion } from '../db/migrator';
import { settingsSchemas, SETTINGS_SECTIONS } from '@shared/settings';
import type { IntegrityIssue, IntegrityReport } from '@shared/contracts';

export interface IntegrityCheck {
  name: string;
  /** Quick checks also run at every startup; slow ones only on demand and in tests. */
  quick: boolean;
  run(db: Db): IntegrityIssue[];
}

/**
 * Tables whose rows may never be changed or removed. Each must carry
 * `<table>_no_update` and `<table>_no_delete` triggers. Later phases append to this list.
 */
export const IMMUTABLE_TABLES = [
  'audit_log',
  'stock_movements',
  'stock_balances',
  'ledger_entries',
  'invoices',
  'invoice_lines',
  'invoice_cancellations',
  'credit_notes',
  'credit_note_lines',
  'payments',
  'payment_reversals',
  'balance_adjustments',
  'allocations',
  'asset_events',
  'rental_charges',
  'rental_extensions',
  'deposit_transactions',
];

/** Other triggers that enforce business rules and must be present. */
export const REQUIRED_TRIGGERS = [
  'products_no_delete',
  'stock_movements_check',
  'stock_movements_apply',
  'stock_count_lines_locked',
  'stock_counts_closed',
  'stock_count_lines_no_delete',
  'customers_no_delete',
  'asset_bookings_no_overlap',
  'asset_bookings_no_overlap_update',
  'asset_bookings_no_delete',
  'rental_agreements_closed',
  'rental_agreements_no_delete',
  'rental_items_no_delete',
  'rental_products_no_delete',
  'rental_assets_no_delete',
];

const issue = (check: string, message: string, details?: unknown): IntegrityIssue => ({
  check,
  severity: 'error',
  message,
  details,
});

const checks: IntegrityCheck[] = [
  {
    name: 'sqlite-integrity',
    quick: false,
    run(db) {
      const rows = db.pragma('integrity_check') as { integrity_check: string }[];
      return rows[0]?.integrity_check === 'ok'
        ? []
        : [{ check: 'sqlite-integrity', severity: 'error', message: 'SQLite reported file damage.', details: rows.slice(0, 20) }];
    },
  },
  {
    name: 'sqlite-quick-check',
    quick: true,
    run(db) {
      const rows = db.pragma('quick_check') as { quick_check: string }[];
      return rows[0]?.quick_check === 'ok'
        ? []
        : [{ check: 'sqlite-quick-check', severity: 'error', message: 'SQLite reported file damage.', details: rows.slice(0, 20) }];
    },
  },
  {
    name: 'foreign-keys',
    quick: true,
    run(db) {
      const rows = db.pragma('foreign_key_check') as unknown[];
      return rows.length === 0
        ? []
        : [{ check: 'foreign-keys', severity: 'error', message: `${rows.length} rows reference missing records.`, details: rows.slice(0, 20) }];
    },
  },
  {
    name: 'schema',
    quick: true,
    run(db) {
      const issues: IntegrityIssue[] = [];
      if ((db.pragma('application_id', { simple: true }) as number) !== APPLICATION_ID) {
        issues.push({ check: 'schema', severity: 'error', message: 'The database is missing its application identifier.' });
      }
      const version = schemaVersion(db);
      if (version !== LATEST_SCHEMA_VERSION) {
        issues.push({ check: 'schema', severity: 'error', message: `Schema version ${version}; expected ${LATEST_SCHEMA_VERSION}.` });
      }
      return issues;
    },
  },
  {
    name: 'immutability-triggers',
    quick: true,
    run(db) {
      const triggers = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]).map((r) => r.name),
      );
      const expected = [...IMMUTABLE_TABLES.flatMap((t) => [`${t}_no_update`, `${t}_no_delete`]), ...REQUIRED_TRIGGERS];
      return expected
        .filter((name) => !triggers.has(name))
        .map((name) => issue('immutability-triggers', `Protection trigger ${name} is missing; protected records could be altered.`));
    },
  },
  {
    name: 'stock-balances',
    quick: true,
    run(db) {
      const rows = db
        .prepare(
          `SELECT p.id, p.name, b.qty, b.value, COALESCE(m.q, 0) AS movement_qty, COALESCE(m.v, 0) AS movement_value
           FROM products p
           LEFT JOIN stock_balances b ON b.product_id = p.id
           LEFT JOIN (SELECT product_id, SUM(qty_change) AS q, SUM(cost_value) AS v FROM stock_movements GROUP BY product_id) m
             ON m.product_id = p.id
           WHERE b.product_id IS NULL OR b.qty != COALESCE(m.q, 0) OR b.value != COALESCE(m.v, 0)
           LIMIT 50`,
        )
        .all() as { name: string }[];
      return rows.length
        ? [issue('stock-balances', `${rows.length} product(s) have stock that does not match their stock movements.`, rows)]
        : [];
    },
  },
  {
    name: 'stock-chain',
    quick: false,
    run(db) {
      const rows = db
        .prepare(
          `SELECT id, product_id, qty_before, prev_qty, value_before, prev_value FROM (
             SELECT id, product_id, qty_before, value_before,
               LAG(qty_after, 1, 0) OVER (PARTITION BY product_id ORDER BY id) AS prev_qty,
               LAG(value_after, 1, 0) OVER (PARTITION BY product_id ORDER BY id) AS prev_value
             FROM stock_movements)
           WHERE qty_before != prev_qty OR value_before != prev_value
           LIMIT 50`,
        )
        .all();
      return rows.length ? [issue('stock-chain', `${rows.length} stock movement(s) do not follow on from the previous one.`, rows)] : [];
    },
  },
  {
    name: 'ledger-balanced',
    quick: true,
    run(db) {
      const rows = db
        .prepare(
          `SELECT txn_ref, SUM(debit) - SUM(credit) AS difference FROM ledger_entries
           GROUP BY txn_ref HAVING difference != 0 LIMIT 50`,
        )
        .all();
      return rows.length ? [issue('ledger-balanced', `${rows.length} ledger transaction(s) do not balance.`, rows)] : [];
    },
  },
  {
    name: 'invoice-totals',
    quick: false,
    run(db) {
      const rows = db
        .prepare(
          `SELECT i.id, i.invoice_no FROM invoices i
           JOIN (SELECT invoice_id, SUM(taxable) AS t, SUM(cgst) AS c, SUM(sgst) AS s, SUM(igst) AS g, SUM(line_total) AS lt,
                        SUM(line_discount + bill_discount) AS d, SUM(gross) AS gr
                 FROM invoice_lines GROUP BY invoice_id) l ON l.invoice_id = i.id
           WHERE l.t != i.taxable_total OR l.c != i.cgst_total OR l.s != i.sgst_total OR l.g != i.igst_total
              OR l.lt + i.round_off != i.grand_total OR l.d != i.discount_total OR l.gr != i.gross_total
           LIMIT 50`,
        )
        .all();
      return rows.length ? [issue('invoice-totals', `${rows.length} invoice(s) do not add up to their lines.`, rows)] : [];
    },
  },
  {
    name: 'allocations',
    quick: true,
    run(db) {
      const sources = db
        .prepare('SELECT source_type, source_id, amount, unallocated FROM v_credit_sources WHERE unallocated < 0 OR unallocated > amount LIMIT 50')
        .all();
      const targets = db
        .prepare('SELECT doc_type, doc_id, amount, outstanding FROM v_receivables WHERE cancelled = 0 AND (outstanding < 0 OR outstanding > amount) LIMIT 50')
        .all();
      const cancelled = db
        .prepare(
          `SELECT ib.invoice_id FROM v_invoice_balances ib WHERE ib.cancelled = 1 AND ib.settled != 0 LIMIT 50`,
        )
        .all();
      const issues: IntegrityIssue[] = [];
      if (sources.length) issues.push(issue('allocations', `${sources.length} payment(s) or credit(s) are applied beyond their amount.`, sources));
      if (targets.length) issues.push(issue('allocations', `${targets.length} bill(s) are settled beyond their amount.`, targets));
      if (cancelled.length) issues.push(issue('allocations', `${cancelled.length} cancelled invoice(s) still hold payments.`, cancelled));
      return issues;
    },
  },
  {
    name: 'customer-balances',
    quick: true,
    run(db) {
      // Ledger balance = open bills − unused credit, for every customer.
      const rows = db
        .prepare(
          `SELECT c.id, c.name, COALESCE(l.balance, 0) AS ledger, COALESCE(r.open, 0) - COALESCE(s.credit, 0) AS documents
           FROM customers c
           LEFT JOIN (SELECT party_id, SUM(debit - credit) AS balance FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
                      WHERE a.code = 'AR' AND le.party_type = 'CUSTOMER' GROUP BY party_id) l ON l.party_id = c.id
           LEFT JOIN (SELECT customer_id, SUM(outstanding) AS open FROM v_receivables WHERE cancelled = 0 GROUP BY customer_id) r
             ON r.customer_id = c.id
           LEFT JOIN (SELECT customer_id, SUM(unallocated) AS credit FROM v_credit_sources WHERE reversed = 0 GROUP BY customer_id) s
             ON s.customer_id = c.id
           WHERE COALESCE(l.balance, 0) != COALESCE(r.open, 0) - COALESCE(s.credit, 0)
              OR (c.is_walkin = 1 AND COALESCE(l.balance, 0) != 0)
           LIMIT 50`,
        )
        .all();
      return rows.length
        ? [issue('customer-balances', `${rows.length} customer balance(s) do not match their bills and payments.`, rows)]
        : [];
    },
  },
  {
    name: 'rental-assets',
    quick: true,
    run(db) {
      const issues: IntegrityIssue[] = [];
      const overlaps = db
        .prepare(
          `SELECT a.asset_id, a.id AS booking, b.id AS other FROM asset_bookings a JOIN asset_bookings b
             ON b.asset_id = a.asset_id AND b.id > a.id AND b.released_at IS NULL
           WHERE a.released_at IS NULL AND a.start_at < b.end_at AND a.end_at > b.start_at LIMIT 50`,
        )
        .all();
      if (overlaps.length) issues.push(issue('rental-assets', `${overlaps.length} rental unit(s) are double-booked.`, overlaps));
      const mismatched = db
        .prepare(
          `SELECT a.id, a.asset_tag, a.status FROM rental_assets a
           WHERE (a.status = 'RENTED') != EXISTS (SELECT 1 FROM rental_items i WHERE i.asset_id = a.id AND i.status = 'OUT') LIMIT 50`,
        )
        .all();
      if (mismatched.length) issues.push(issue('rental-assets', `${mismatched.length} rental unit(s) have a status that does not match their rentals.`, mismatched));
      return issues;
    },
  },
  {
    name: 'deposit-ledger',
    quick: true,
    run(db) {
      const { held } = db.prepare('SELECT COALESCE(SUM(held), 0) AS held FROM v_deposit_balances').get() as { held: number };
      const { ledger } = db
        .prepare(
          `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS ledger FROM ledger_entries l
           JOIN accounts a ON a.id = l.account_id WHERE a.code = 'DEPOSIT_LIABILITY'`,
        )
        .get() as { ledger: number };
      const negative = db.prepare('SELECT agreement_id, held FROM v_deposit_balances WHERE held < 0 LIMIT 50').all();
      const issues: IntegrityIssue[] = [];
      if (held !== ledger) issues.push(issue('deposit-ledger', 'Deposits held do not match the deposit liability in the ledger.', { held, ledger }));
      if (negative.length) issues.push(issue('deposit-ledger', `${negative.length} rental(s) have used or refunded more deposit than was collected.`, negative));
      return issues;
    },
  },
  {
    name: 'inventory-ledger',
    quick: true,
    run(db) {
      const { stock } = db.prepare('SELECT COALESCE(SUM(value), 0) AS stock FROM stock_balances').get() as { stock: number };
      const { ledger } = db
        .prepare(
          `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS ledger FROM ledger_entries l
           JOIN accounts a ON a.id = l.account_id WHERE a.code = 'INVENTORY'`,
        )
        .get() as { ledger: number };
      return stock === ledger
        ? []
        : [issue('inventory-ledger', 'The stock value does not match the inventory account in the ledger.', { stock, ledger })];
    },
  },
  {
    name: 'settings',
    quick: true,
    run(db) {
      const rows = db.prepare('SELECT key, value_json FROM settings').all() as { key: string; value_json: string }[];
      return rows.flatMap((r) => {
        if (!SETTINGS_SECTIONS.includes(r.key as never)) return [];
        const parsed = settingsSchemas[r.key as keyof typeof settingsSchemas].safeParse(JSON.parse(r.value_json));
        return parsed.success
          ? []
          : [{ check: 'settings', severity: 'warning' as const, message: `Settings section "${r.key}" has invalid values; defaults are used.` }];
      });
    },
  },
];

export function runIntegrityChecks(db: Db, opts: { quickOnly?: boolean } = {}): IntegrityReport {
  const started = Date.now();
  const selected = checks.filter((c) => (opts.quickOnly ? c.quick : c.name !== 'sqlite-quick-check'));
  const issues: IntegrityIssue[] = [];
  for (const check of selected) {
    try {
      issues.push(...check.run(db));
    } catch (e) {
      issues.push({ check: check.name, severity: 'error', message: `Check failed to run: ${(e as Error).message}` });
    }
  }
  return {
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    checksRun: selected.map((c) => c.name),
    issues,
  };
}
