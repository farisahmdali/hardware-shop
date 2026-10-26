import type { ReportImpl } from './engine';
import { showsCost } from './engine';
import { col, share } from './util';
import { mulDivRound } from '@shared/money';
import { QTY_SCALE } from '@shared/qty';
import { MOVEMENT_TYPES, stockStatus, type MovementType } from '@shared/stock';
import type { ReportRow } from '@shared/reports';

const STATUS_LABEL = { IN_STOCK: 'In stock', LOW: 'Low', OUT: 'Out of stock' } as const;

const STATUS_SQL: Record<string, string> = {
  ALL: '1 = 1',
  LOW: 'b.qty > 0 AND p.min_stock_qty > 0 AND b.qty <= p.min_stock_qty',
  OUT: 'b.qty <= 0',
  IN_STOCK: 'b.qty > 0',
};

function levels(forced?: 'LOW' | 'OUT'): ReportImpl {
  return ({ db, params: p, permissions, limit }) => {
    const cost = showsCost(permissions);
    const status = forced ?? p.option ?? 'ALL';
    const rows = db
      .prepare(
        `SELECT p.id, p.sku, p.name, COALESCE(c.name, '') AS category, u.code AS unit, b.qty, b.value, p.min_stock_qty, p.selling_price
         FROM products p JOIN stock_balances b ON b.product_id = p.id JOIN units u ON u.id = p.unit_id LEFT JOIN categories c ON c.id = p.category_id
         WHERE p.is_active = 1 AND (? IS NULL OR p.category_id = ?) AND ${STATUS_SQL[status] ?? STATUS_SQL.ALL}
         ORDER BY p.name COLLATE NOCASE LIMIT ?`,
      )
      .all(p.categoryId ?? null, p.categoryId ?? null, limit + 1) as {
      id: number;
      sku: string;
      name: string;
      category: string;
      unit: string;
      qty: number;
      value: number;
      min_stock_qty: number;
      selling_price: number;
    }[];
    const st = (r: (typeof rows)[number]) => stockStatus(r.qty, r.min_stock_qty);
    return {
      columns: [
        col('sku', 'Code', 'code'),
        col('product', 'Product', 'text'),
        col('category', 'Category', 'text'),
        col('qty', 'In stock', 'qty'),
        col('unit', 'Unit', 'text'),
        col('min', 'Minimum', 'qty'),
        col('status', 'Status', 'text'),
        ...(cost ? [col('avgCost', 'Average cost', 'money'), col('value', 'Stock value', 'money', true)] : []),
        col('price', 'Selling price', 'money'),
        col('retail', 'Retail value', 'money', true),
      ],
      rows: rows.map((r) => ({
        link: { to: 'product' as const, id: r.id },
        cells: {
          sku: r.sku,
          product: r.name,
          category: r.category,
          qty: r.qty,
          unit: r.unit,
          min: r.min_stock_qty,
          status: STATUS_LABEL[st(r)],
          ...(cost ? { avgCost: r.qty > 0 ? mulDivRound(r.value, QTY_SCALE, r.qty) : null, value: r.value } : {}),
          price: r.selling_price,
          retail: r.qty > 0 ? mulDivRound(r.qty, r.selling_price, QTY_SCALE) : 0,
        },
      })),
      summary: [
        { label: 'Products', value: rows.length, kind: 'int' },
        { label: 'Low stock', value: rows.filter((r) => st(r) === 'LOW').length, kind: 'int' },
        { label: 'Out of stock', value: rows.filter((r) => st(r) === 'OUT').length, kind: 'int' },
      ],
      notes: [
        'Active products only. “Low” means at or below the minimum set on the product.',
        'Retail value uses current selling prices, which may include GST. It is not what the stock cost.',
      ],
    };
  };
}

/** Stock value on a date: each product's balance after its last movement on or before that date. */
const valuation: ReportImpl = ({ db, params: p, limit }) => {
  const rows = db
    .prepare(
      `SELECT p.id, p.sku, p.name, COALESCE(c.name, '') AS category, u.code AS unit, p.selling_price, m.qty_after AS qty, m.value_after AS value
       FROM (SELECT product_id, MAX(id) AS mid FROM stock_movements WHERE business_date <= ? GROUP BY product_id) x
       JOIN stock_movements m ON m.id = x.mid
       JOIN products p ON p.id = x.product_id JOIN units u ON u.id = p.unit_id LEFT JOIN categories c ON c.id = p.category_id
       WHERE (m.qty_after != 0 OR m.value_after != 0) AND (? IS NULL OR p.category_id = ?)
       ORDER BY m.value_after DESC, p.name LIMIT ?`,
    )
    .all(p.to, p.categoryId ?? null, p.categoryId ?? null, limit + 1) as {
    id: number;
    sku: string;
    name: string;
    category: string;
    unit: string;
    selling_price: number;
    qty: number;
    value: number;
  }[];
  const total = rows.reduce((a, r) => a + r.value, 0);
  const retail = rows.reduce((a, r) => a + (r.qty > 0 ? mulDivRound(r.qty, r.selling_price, QTY_SCALE) : 0), 0);
  return {
    columns: [
      col('sku', 'Code', 'code'),
      col('product', 'Product', 'text'),
      col('category', 'Category', 'text'),
      col('qty', 'Quantity', 'qty'),
      col('unit', 'Unit', 'text'),
      col('avgCost', 'Average cost', 'money'),
      col('value', 'Stock value', 'money', true),
      col('share', 'Share of value', 'percent'),
      col('retail', 'Retail value (today’s prices)', 'money', true),
    ],
    rows: rows.map((r) => ({
      link: { to: 'product' as const, id: r.id },
      cells: {
        sku: r.sku,
        product: r.name,
        category: r.category,
        qty: r.qty,
        unit: r.unit,
        avgCost: r.qty > 0 ? mulDivRound(r.value, QTY_SCALE, r.qty) : null,
        value: r.value,
        share: share(r.value, total),
        retail: r.qty > 0 ? mulDivRound(r.qty, r.selling_price, QTY_SCALE) : 0,
      },
    })),
    summary: [
      { label: 'Stock value at cost', value: total, kind: 'money' },
      { label: 'Products in stock', value: rows.filter((r) => r.qty > 0).length, kind: 'int' },
      { label: 'Retail value', value: retail, kind: 'money', hint: 'At today’s selling prices' },
    ],
    notes: [
      'Valued at moving weighted-average cost: what the stock cost to buy, never its selling price.',
      'For today, the total equals the inventory account in the books (Data health checks this). Deactivated products that still hold stock are included.',
    ],
  };
};

const DOC_SQL = `CASE m.ref_type
  WHEN 'INVOICE' THEN (SELECT invoice_no FROM invoices WHERE id = m.ref_id)
  WHEN 'PURCHASE' THEN (SELECT purchase_no FROM purchases WHERE id = m.ref_id)
  WHEN 'DEBIT_NOTE' THEN (SELECT debit_note_no FROM debit_notes WHERE id = m.ref_id)
  WHEN 'CREDIT_NOTE' THEN (SELECT credit_note_no FROM credit_notes WHERE id = m.ref_id)
  WHEN 'STOCK_COUNT' THEN (SELECT count_no FROM stock_counts WHERE id = m.ref_id)
  ELSE '' END`;

interface MovementRecord {
  id: number;
  product_id: number;
  sku: string;
  name: string;
  unit: string;
  type: MovementType;
  qty_change: number;
  qty_after: number;
  cost_value: number;
  reason: string | null;
  ref_type: string | null;
  ref_id: string | null;
  doc: string | null;
  occurred_at: string;
  business_date: string;
  username: string | null;
}

function movementRows(
  c: Parameters<ReportImpl>[0],
  typeSql: string,
  typeParams: unknown[] = [],
): MovementRecord[] {
  const p = c.params;
  return c.db
    .prepare(
      `SELECT m.id, m.product_id, p.sku, p.name, u.code AS unit, m.type, m.qty_change, m.qty_after, m.cost_value, m.reason, m.ref_type, m.ref_id,
              ${DOC_SQL} AS doc, m.occurred_at, m.business_date, us.username
       FROM stock_movements m JOIN products p ON p.id = m.product_id JOIN units u ON u.id = p.unit_id LEFT JOIN users us ON us.id = m.user_id
       WHERE m.business_date BETWEEN ? AND ? AND (? IS NULL OR p.category_id = ?) AND ${typeSql}
       ORDER BY m.id LIMIT ?`,
    )
    .all(p.from, p.to, p.categoryId ?? null, p.categoryId ?? null, ...typeParams, c.limit + 1) as MovementRecord[];
}

const movementLink = (m: MovementRecord): ReportRow['link'] =>
  m.ref_type === 'INVOICE' && m.ref_id
    ? { to: 'invoice', id: Number(m.ref_id) }
    : m.ref_type === 'PURCHASE' && m.ref_id
      ? { to: 'purchase', id: Number(m.ref_id) }
      : { to: 'product', id: m.product_id };

const TYPE_FILTERS: Record<string, string> = {
  ALL: '1 = 1',
  IN: 'm.qty_change > 0',
  OUT: 'm.qty_change < 0',
  SALE: "m.type IN ('SALE', 'SALE_CANCEL')",
  PURCHASE: "m.type IN ('PURCHASE', 'PURCHASE_CANCEL')",
  RETURNS: "m.type IN ('CUSTOMER_RETURN', 'SUPPLIER_RETURN')",
};

const movements: ReportImpl = (c) => {
  const cost = showsCost(c.permissions);
  const rows = movementRows(c, TYPE_FILTERS[c.params.option ?? 'ALL'] ?? TYPE_FILTERS.ALL!);
  return {
    columns: [
      col('when', 'When', 'datetime'),
      col('product', 'Product', 'text'),
      col('type', 'Movement', 'text'),
      col('change', 'Change', 'qty'),
      col('after', 'Balance', 'qty'),
      col('unit', 'Unit', 'text'),
      ...(cost ? [col('value', 'Value change', 'money', true)] : []),
      col('doc', 'Document', 'code'),
      col('reason', 'Reason', 'text'),
      col('user', 'By', 'text'),
    ],
    rows: rows.map((m) => ({
      link: movementLink(m),
      cells: {
        when: m.occurred_at,
        product: `${m.name} (${m.sku})`,
        type: MOVEMENT_TYPES[m.type].label,
        change: m.qty_change,
        after: m.qty_after,
        unit: m.unit,
        ...(cost ? { value: m.cost_value } : {}),
        doc: m.doc ?? '',
        reason: m.reason ?? '',
        user: m.username ?? 'system',
      },
    })),
    notes: ['Quantities are in each product’s own unit, so they are not totalled.'],
  };
};

const losses: ReportImpl = (c) => {
  const cost = showsCost(c.permissions);
  const rows = movementRows(c, "m.type IN ('DAMAGE', 'LOSS')");
  return {
    columns: [
      col('date', 'Date', 'date'),
      col('product', 'Product', 'text'),
      col('type', 'Written off as', 'text'),
      col('qty', 'Quantity', 'qty'),
      col('unit', 'Unit', 'text'),
      ...(cost ? [col('value', 'Value lost', 'money', true)] : []),
      col('reason', 'Reason', 'text'),
      col('user', 'Recorded by', 'text'),
    ],
    rows: rows.map((m) => ({
      link: { to: 'product' as const, id: m.product_id },
      cells: {
        date: m.business_date,
        product: `${m.name} (${m.sku})`,
        type: m.type === 'DAMAGE' ? 'Damaged' : 'Lost / missing',
        qty: -m.qty_change,
        unit: m.unit,
        ...(cost ? { value: -m.cost_value } : {}),
        reason: m.reason ?? '',
        user: m.username ?? 'system',
      },
    })),
    summary: cost ? [{ label: 'Value written off', value: rows.reduce((a, m) => a - m.cost_value, 0), kind: 'money', hint: 'At weighted-average cost' }] : [],
  };
};

const adjustments: ReportImpl = (c) => {
  const cost = showsCost(c.permissions);
  const rows = movementRows(c, "m.type IN ('OPENING', 'RECEIPT', 'ADJUST_IN', 'ADJUST_OUT', 'RECONCILE')");
  return {
    columns: [
      col('date', 'Date', 'date'),
      col('product', 'Product', 'text'),
      col('type', 'Type', 'text'),
      col('change', 'Change', 'qty'),
      col('unit', 'Unit', 'text'),
      ...(cost ? [col('value', 'Value change', 'money', true)] : []),
      col('doc', 'Stock count', 'code'),
      col('reason', 'Reason', 'text'),
      col('user', 'By', 'text'),
    ],
    rows: rows.map((m) => ({
      link: { to: 'product' as const, id: m.product_id },
      cells: {
        date: m.business_date,
        product: `${m.name} (${m.sku})`,
        type: MOVEMENT_TYPES[m.type].label,
        change: m.qty_change,
        unit: m.unit,
        ...(cost ? { value: m.cost_value } : {}),
        doc: m.doc ?? '',
        reason: m.reason ?? '',
        user: m.username ?? 'system',
      },
    })),
    notes: ['Opening stock, stock received without a purchase bill, corrections and stock count differences.'],
  };
};

const purchases: ReportImpl = ({ db, params: p, today, limit }) => {
  const rows = db
    .prepare(
      `SELECT p.id, p.purchase_no, p.supplier_invoice_no, p.supplier_invoice_date, p.due_date, s.name AS supplier,
              (SELECT COUNT(*) FROM purchase_lines l WHERE l.purchase_id = p.id) AS items,
              p.taxable_total, p.cgst_total + p.sgst_total + p.igst_total AS gst, p.additional_costs, p.grand_total,
              b.outstanding, b.cancelled, COALESCE((SELECT SUM(d.total) FROM debit_notes d WHERE d.purchase_id = p.id), 0) AS returned
       FROM purchases p JOIN suppliers s ON s.id = p.supplier_id JOIN v_purchase_balances b ON b.purchase_id = p.id
       WHERE p.supplier_invoice_date BETWEEN ? AND ? AND (? IS NULL OR p.supplier_id = ?)
       ORDER BY p.supplier_invoice_date, p.id LIMIT ?`,
    )
    .all(p.from, p.to, p.supplierId ?? null, p.supplierId ?? null, limit + 1) as {
    id: number;
    purchase_no: string;
    supplier_invoice_no: string;
    supplier_invoice_date: string;
    due_date: string;
    supplier: string;
    items: number;
    taxable_total: number;
    gst: number;
    additional_costs: number;
    grand_total: number;
    outstanding: number;
    cancelled: number;
    returned: number;
  }[];
  const status = (r: (typeof rows)[number]) =>
    r.cancelled ? 'Cancelled' : r.outstanding <= 0 ? 'Paid' : `${r.outstanding < r.grand_total ? 'Part paid' : 'Unpaid'}${r.due_date < today ? ', overdue' : ''}`;
  return {
    columns: [
      col('purchase', 'Purchase', 'code'),
      col('bill', 'Their bill', 'code'),
      col('date', 'Bill date', 'date'),
      col('supplier', 'Supplier', 'text'),
      col('items', 'Items', 'int'),
      col('taxable', 'Taxable value', 'money', true),
      col('gst', 'GST', 'money', true),
      col('charges', 'Freight etc.', 'money', true),
      col('total', 'Total', 'money', true),
      col('returned', 'Returned', 'money', true),
      col('owed', 'To pay', 'money', true),
      col('status', 'Status', 'text'),
    ],
    rows: rows.map((r) => ({
      link: { to: 'purchase' as const, id: r.id },
      cells: {
        purchase: r.purchase_no,
        bill: r.supplier_invoice_no,
        date: r.supplier_invoice_date,
        supplier: r.supplier,
        items: r.items,
        taxable: r.cancelled ? null : r.taxable_total,
        gst: r.cancelled ? null : r.gst,
        charges: r.cancelled ? null : r.additional_costs,
        total: r.cancelled ? null : r.grand_total,
        returned: r.cancelled ? null : r.returned,
        owed: r.cancelled ? null : r.outstanding,
        status: status(r),
      },
    })),
    notes: ['By the date on the supplier’s bill. Cancelled purchases are listed without amounts.'],
  };
};

const supplierReturns: ReportImpl = ({ db, params: p, limit }) => {
  const rows = db
    .prepare(
      `SELECT d.debit_note_no, d.business_date, d.purchase_id, d.reason, s.name AS supplier, l.name AS product, l.sku, l.unit_code,
              dl.qty, dl.line_total, dl.cost_value
       FROM debit_note_lines dl JOIN debit_notes d ON d.id = dl.debit_note_id JOIN purchase_lines l ON l.id = dl.purchase_line_id
       JOIN suppliers s ON s.id = d.supplier_id
       WHERE d.business_date BETWEEN ? AND ? AND (? IS NULL OR d.supplier_id = ?)
       ORDER BY d.id, dl.id LIMIT ?`,
    )
    .all(p.from, p.to, p.supplierId ?? null, p.supplierId ?? null, limit + 1) as {
    debit_note_no: string;
    business_date: string;
    purchase_id: number;
    reason: string;
    supplier: string;
    product: string;
    sku: string;
    unit_code: string;
    qty: number;
    line_total: number;
    cost_value: number;
  }[];
  return {
    columns: [
      col('date', 'Date', 'date'),
      col('doc', 'Debit note', 'code'),
      col('supplier', 'Supplier', 'text'),
      col('product', 'Product', 'text'),
      col('qty', 'Quantity', 'qty'),
      col('unit', 'Unit', 'text'),
      col('credit', 'Credited by supplier', 'money', true),
      col('cost', 'Stock value removed', 'money', true),
      col('reason', 'Reason', 'text'),
    ],
    rows: rows.map((r) => ({
      link: { to: 'purchase' as const, id: r.purchase_id },
      cells: {
        date: r.business_date,
        doc: r.debit_note_no,
        supplier: r.supplier,
        product: `${r.product} (${r.sku})`,
        qty: r.qty,
        unit: r.unit_code,
        credit: r.line_total,
        cost: r.cost_value,
        reason: r.reason,
      },
    })),
    notes: ['The credit is the share of the original bill, including GST. Stock leaves at the current average cost; the difference is a stock adjustment.'],
  };
};

export const stockReports: Record<string, ReportImpl> = {
  'stock.levels': levels(),
  'stock.low': levels('LOW'),
  'stock.out': levels('OUT'),
  'stock.valuation': valuation,
  'stock.movements': movements,
  'stock.purchases': purchases,
  'stock.losses': losses,
  'stock.adjustments': adjustments,
  'stock.supplierReturns': supplierReturns,
};
