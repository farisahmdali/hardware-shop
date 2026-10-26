import type { Db } from '../db/connection';
import type { ReportCellKind, ReportColumn } from '@shared/reports';
import { mulDivRound } from '@shared/money';

export const col = (key: string, label: string, kind: ReportCellKind, total = false): ReportColumn => ({ key, label, kind, total });

/** Invoices that have not been cancelled; `i` is the invoices alias. */
export const NOT_CANCELLED = 'NOT EXISTS (SELECT 1 FROM invoice_cancellations x WHERE x.invoice_id = i.id)';

/** Share as basis points (2534 = 25.34%), or null when there is nothing to divide by. */
export function share(part: number, whole: number): number | null {
  return whole === 0 ? null : mulDivRound(part, 10_000, whole);
}

export interface ProductSalesRow {
  id: number;
  sku: string;
  name: string;
  categoryId: number | null;
  category: string;
  unit: string;
  soldQty: number;
  returnedQty: number;
  /** Excluding GST, after returns. */
  netTaxable: number;
  /** Including GST, after returns. */
  netTotal: number;
  /** Cost of goods sold at weighted-average cost, less the cost of goods returned to stock. */
  cost: number;
}

/**
 * Product sales in a period: lines of sales invoices dated in the period (cancelled invoices left out),
 * less goods returned on credit notes dated in the period. Rental bills are not product sales.
 */
export function productSales(db: Db, from: string, to: string, categoryId?: number): ProductSalesRow[] {
  return db
    .prepare(
      `WITH sold AS (
         SELECT l.product_id AS pid, SUM(l.qty) AS qty, SUM(l.taxable) AS taxable, SUM(l.line_total) AS total, SUM(l.cost_value) AS cost
         FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
         WHERE i.kind = 'SALE' AND l.product_id IS NOT NULL AND i.business_date BETWEEN ? AND ? AND ${NOT_CANCELLED}
         GROUP BY l.product_id),
       ret AS (
         SELECT l.product_id AS pid, SUM(cl.qty) AS qty, SUM(cl.taxable) AS taxable, SUM(cl.line_total) AS total, SUM(cl.cost_value) AS cost
         FROM credit_note_lines cl
         JOIN credit_notes cn ON cn.id = cl.credit_note_id
         JOIN invoice_lines l ON l.id = cl.invoice_line_id
         JOIN invoices i ON i.id = l.invoice_id
         WHERE i.kind = 'SALE' AND l.product_id IS NOT NULL AND cn.business_date BETWEEN ? AND ?
         GROUP BY l.product_id),
       ids AS (SELECT pid FROM sold UNION SELECT pid FROM ret)
       SELECT p.id, p.sku, p.name, p.category_id AS categoryId, COALESCE(c.name, 'Uncategorised') AS category, u.code AS unit,
              COALESCE(s.qty, 0) AS soldQty, COALESCE(r.qty, 0) AS returnedQty,
              COALESCE(s.taxable, 0) - COALESCE(r.taxable, 0) AS netTaxable,
              COALESCE(s.total, 0) - COALESCE(r.total, 0) AS netTotal,
              COALESCE(s.cost, 0) - COALESCE(r.cost, 0) AS cost
       FROM ids
       JOIN products p ON p.id = ids.pid
       JOIN units u ON u.id = p.unit_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN sold s ON s.pid = p.id
       LEFT JOIN ret r ON r.pid = p.id
       WHERE (? IS NULL OR p.category_id = ?)
       ORDER BY netTotal DESC, p.name`,
    )
    .all(from, to, from, to, categoryId ?? null, categoryId ?? null) as ProductSalesRow[];
}

/** Escapes a value for use in a LIKE pattern with ESCAPE '\'. */
export function likePattern(text: string): string {
  return `%${text.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
}

export const SALES_NOTE = 'Product sales only. Rental bills are in the rental reports.';
