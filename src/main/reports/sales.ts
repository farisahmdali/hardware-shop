import type { ReportImpl } from './engine';
import { showsProfit } from './engine';
import { daysBetween, periodKeys, periodLabel, periodSql } from './periods';
import { col, NOT_CANCELLED, productSales, SALES_NOTE, share } from './util';
import type { ReportRow } from '@shared/reports';

const byPeriod: ReportImpl = ({ db, params: p }) => {
  const g = p.groupBy;
  const k = periodSql('i.business_date', g);
  const sales = new Map(
    (
      db
        .prepare(
          `SELECT ${k} AS k, COUNT(*) AS n, SUM(i.gross_total) AS gross, SUM(i.discount_total) AS disc, SUM(i.taxable_total) AS taxable,
                  SUM(i.cgst_total + i.sgst_total + i.igst_total) AS gst, SUM(i.grand_total) AS total
           FROM invoices i WHERE i.kind = 'SALE' AND i.business_date BETWEEN ? AND ? AND ${NOT_CANCELLED} GROUP BY k`,
        )
        .all(p.from, p.to) as { k: string; n: number; gross: number; disc: number; taxable: number; gst: number; total: number }[]
    ).map((r) => [r.k, r]),
  );
  const returns = new Map(
    (
      db
        .prepare(
          `SELECT ${periodSql('cn.business_date', g)} AS k, SUM(cn.total) AS total
           FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id
           WHERE i.kind = 'SALE' AND cn.business_date BETWEEN ? AND ? GROUP BY k`,
        )
        .all(p.from, p.to) as { k: string; total: number }[]
    ).map((r) => [r.k, r.total]),
  );
  const cancelled = new Map(
    (
      db
        .prepare(
          `SELECT ${k} AS k, COUNT(*) AS n FROM invoices i JOIN invoice_cancellations x ON x.invoice_id = i.id
           WHERE i.kind = 'SALE' AND i.business_date BETWEEN ? AND ? GROUP BY k`,
        )
        .all(p.from, p.to) as { k: string; n: number }[]
    ).map((r) => [r.k, r.n]),
  );
  const rows: ReportRow[] = periodKeys(p.from, p.to, g).map((key) => {
    const s = sales.get(key);
    const ret = returns.get(key) ?? 0;
    return {
      cells: {
        period: periodLabel(key, g),
        invoices: s?.n ?? 0,
        gross: s?.gross ?? 0,
        discount: s?.disc ?? 0,
        taxable: s?.taxable ?? 0,
        gst: s?.gst ?? 0,
        total: s?.total ?? 0,
        returns: ret,
        net: (s?.total ?? 0) - ret,
        cancelled: cancelled.get(key) ?? 0,
      },
    };
  });
  const net = rows.reduce((a, r) => a + (r.cells.net as number), 0);
  const count = rows.reduce((a, r) => a + (r.cells.invoices as number), 0);
  return {
    columns: [
      col('period', 'Period', 'text'),
      col('invoices', 'Invoices', 'int', true),
      col('gross', 'Gross', 'money', true),
      col('discount', 'Discounts', 'money', true),
      col('taxable', 'Taxable value', 'money', true),
      col('gst', 'GST', 'money', true),
      col('total', 'Invoiced', 'money', true),
      col('returns', 'Returns', 'money', true),
      col('net', 'Net sales', 'money', true),
      col('cancelled', 'Cancelled', 'int', true),
    ],
    rows,
    summary: [
      { label: 'Net sales', value: net, kind: 'money', hint: 'Invoiced less returns, including GST' },
      { label: 'Invoices', value: count, kind: 'int' },
      { label: 'Average bill', value: count ? Math.round(rows.reduce((a, r) => a + (r.cells.total as number), 0) / count) : 0, kind: 'money' },
      { label: 'Discounts given', value: rows.reduce((a, r) => a + (r.cells.discount as number), 0), kind: 'money' },
    ],
    notes: [
      SALES_NOTE,
      'Cancelled invoices are left out (their count is shown). Returns are counted on the day of the credit note.',
      'Sales are not money collected: see “Payments received by method”. Sales are not profit: see “Income and profit summary”.',
    ],
  };
};

const byProduct: ReportImpl = ({ db, params: p, permissions, limit }) => {
  const profit = showsProfit(permissions);
  const rows = productSales(db, p.from, p.to, p.categoryId)
    .slice(0, limit + 1)
    .map(
      (r): ReportRow => ({
        link: { to: 'product', id: r.id },
        cells: {
          sku: r.sku,
          product: r.name,
          category: r.category,
          unit: r.unit,
          sold: r.soldQty,
          returned: r.returnedQty,
          netQty: r.soldQty - r.returnedQty,
          netTaxable: r.netTaxable,
          netTotal: r.netTotal,
          ...(profit ? { cost: r.cost, profit: r.netTaxable - r.cost, margin: share(r.netTaxable - r.cost, r.netTaxable) } : {}),
        },
      }),
    );
  return {
    columns: [
      col('sku', 'Code', 'code'),
      col('product', 'Product', 'text'),
      col('category', 'Category', 'text'),
      col('unit', 'Unit', 'text'),
      col('sold', 'Sold', 'qty'),
      col('returned', 'Returned', 'qty'),
      col('netQty', 'Net quantity', 'qty'),
      col('netTaxable', 'Net sales excl. GST', 'money', true),
      col('netTotal', 'Net sales incl. GST', 'money', true),
      ...(profit ? [col('cost', 'Cost of goods', 'money', true), col('profit', 'Gross profit', 'money', true), col('margin', 'Margin', 'percent')] : []),
    ],
    rows,
    notes: [SALES_NOTE, 'Categories are the products’ current categories.', ...(profit ? ['Cost of goods is the weighted-average cost when sold, less the cost of goods returned to stock.'] : [])],
  };
};

const byCategory: ReportImpl = ({ db, params: p, permissions }) => {
  const profit = showsProfit(permissions);
  const groups = new Map<string, { products: number; netTaxable: number; netTotal: number; cost: number }>();
  for (const r of productSales(db, p.from, p.to)) {
    const g = groups.get(r.category) ?? { products: 0, netTaxable: 0, netTotal: 0, cost: 0 };
    g.products += 1;
    g.netTaxable += r.netTaxable;
    g.netTotal += r.netTotal;
    g.cost += r.cost;
    groups.set(r.category, g);
  }
  const all = [...groups.values()].reduce((a, g) => a + g.netTotal, 0);
  const rows = [...groups.entries()]
    .sort((a, b) => b[1].netTotal - a[1].netTotal)
    .map(
      ([category, g]): ReportRow => ({
        cells: {
          category,
          products: g.products,
          netTaxable: g.netTaxable,
          netTotal: g.netTotal,
          share: share(g.netTotal, all),
          ...(profit ? { cost: g.cost, profit: g.netTaxable - g.cost, margin: share(g.netTaxable - g.cost, g.netTaxable) } : {}),
        },
      }),
    );
  return {
    columns: [
      col('category', 'Category', 'text'),
      col('products', 'Products sold', 'int', true),
      col('netTaxable', 'Net sales excl. GST', 'money', true),
      col('netTotal', 'Net sales incl. GST', 'money', true),
      col('share', 'Share', 'percent'),
      ...(profit ? [col('cost', 'Cost of goods', 'money', true), col('profit', 'Gross profit', 'money', true), col('margin', 'Margin', 'percent')] : []),
    ],
    rows,
    notes: [SALES_NOTE, 'Categories are the products’ current categories.'],
  };
};

const byCustomer: ReportImpl = ({ db, params: p, limit }) => {
  const rows = db
    .prepare(
      `WITH s AS (
         SELECT i.customer_id AS cid, COUNT(*) AS n, SUM(i.grand_total) AS total FROM invoices i
         WHERE i.kind = 'SALE' AND i.business_date BETWEEN ? AND ? AND ${NOT_CANCELLED} GROUP BY i.customer_id),
       r AS (
         SELECT cn.customer_id AS cid, SUM(cn.total) AS total FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id
         WHERE i.kind = 'SALE' AND cn.business_date BETWEEN ? AND ? GROUP BY cn.customer_id),
       o AS (SELECT customer_id AS cid, SUM(outstanding) AS owed FROM v_receivables WHERE cancelled = 0 AND outstanding > 0 GROUP BY customer_id),
       ids AS (SELECT cid FROM s UNION SELECT cid FROM r)
       SELECT c.id, c.name, c.phone, c.is_walkin, COALESCE(s.n, 0) AS n, COALESCE(s.total, 0) AS total, COALESCE(r.total, 0) AS returns,
              COALESCE(o.owed, 0) AS owed
       FROM ids JOIN customers c ON c.id = ids.cid LEFT JOIN s ON s.cid = c.id LEFT JOIN r ON r.cid = c.id LEFT JOIN o ON o.cid = c.id
       ORDER BY COALESCE(s.total, 0) - COALESCE(r.total, 0) DESC LIMIT ?`,
    )
    .all(p.from, p.to, p.from, p.to, limit + 1) as { id: number; name: string; phone: string; is_walkin: number; n: number; total: number; returns: number; owed: number }[];
  return {
    columns: [
      col('customer', 'Customer', 'text'),
      col('phone', 'Phone', 'text'),
      col('invoices', 'Invoices', 'int', true),
      col('total', 'Invoiced', 'money', true),
      col('returns', 'Returns', 'money', true),
      col('net', 'Net sales', 'money', true),
      col('owed', 'Owes now', 'money', true),
    ],
    rows: rows.map((r) => ({
      link: r.is_walkin ? undefined : { to: 'customer' as const, id: r.id },
      cells: { customer: r.is_walkin ? 'Walk-in customers' : r.name, phone: r.phone, invoices: r.n, total: r.total, returns: r.returns, net: r.total - r.returns, owed: r.owed },
    })),
    notes: [SALES_NOTE, '“Owes now” is everything the customer owes today, including older bills and rental bills.'],
  };
};

const byPaymentMethod: ReportImpl = ({ db, params: p }) => {
  const methods = db.prepare('SELECT id, name FROM payment_methods ORDER BY sort_order, name').all() as { id: number; name: string }[];
  const sum = (sql: string) =>
    new Map((db.prepare(sql).all(p.from, p.to) as { m: number; n: number; amount: number }[]).map((r) => [r.m, r]));
  const received = sum(
    `SELECT method_id AS m, COUNT(*) AS n, SUM(amount) AS amount FROM payments
     WHERE party_type = 'CUSTOMER' AND direction = 'IN' AND business_date BETWEEN ? AND ? GROUP BY method_id`,
  );
  const refunds = sum(
    `SELECT method_id AS m, COUNT(*) AS n, SUM(amount) AS amount FROM payments
     WHERE party_type = 'CUSTOMER' AND direction = 'OUT' AND business_date BETWEEN ? AND ? GROUP BY method_id`,
  );
  const reversed = (direction: 'IN' | 'OUT') =>
    new Map(
      (
        db
          .prepare(
            `SELECT p.method_id AS m, COUNT(*) AS n, SUM(p.amount) AS amount FROM payment_reversals r JOIN payments p ON p.id = r.payment_id
             WHERE p.party_type = 'CUSTOMER' AND p.direction = ? AND r.business_date BETWEEN ? AND ? GROUP BY p.method_id`,
          )
          .all(direction, p.from, p.to) as { m: number; n: number; amount: number }[]
      ).map((r) => [r.m, r.amount]),
    );
  const revIn = reversed('IN');
  const revOut = reversed('OUT');
  const rows = methods
    .map((m) => {
      const inAmt = received.get(m.id)?.amount ?? 0;
      const outAmt = refunds.get(m.id)?.amount ?? 0;
      const ri = revIn.get(m.id) ?? 0;
      const ro = revOut.get(m.id) ?? 0;
      return { m, cells: { method: m.name, payments: received.get(m.id)?.n ?? 0, received: inAmt, reversed: ri, refunds: outAmt - ro, net: inAmt - ri - (outAmt - ro) } };
    })
    .filter((r) => r.cells.received || r.cells.reversed || r.cells.refunds)
    .map((r) => ({ cells: r.cells }));
  const net = rows.reduce((a, r) => a + r.cells.net, 0);
  return {
    columns: [
      col('method', 'Method', 'text'),
      col('payments', 'Payments', 'int', true),
      col('received', 'Received', 'money', true),
      col('reversed', 'Reversed', 'money', true),
      col('refunds', 'Refunds paid', 'money', true),
      col('net', 'Net received', 'money', true),
    ],
    rows,
    summary: [{ label: 'Net received from customers', value: net, kind: 'money' }],
    notes: [
      'Money received from customers: at the counter, against bills and for rental charges.',
      'A reversed payment or refund is counted on the day it was reversed. Rental security deposits are not included (see “Deposit movements”).',
    ],
  };
};

function invoiceStatus(r: { cancelled: number; outstanding: number; grand_total: number; due_date: string }, today: string): string {
  if (r.cancelled) return 'Cancelled';
  if (r.outstanding <= 0) return 'Paid';
  const s = r.outstanding < r.grand_total ? 'Part paid' : 'Unpaid';
  return r.due_date < today ? `${s}, overdue` : s;
}

const invoices: ReportImpl = ({ db, params: p, today, limit }) => {
  const rows = db
    .prepare(
      `SELECT i.id, i.invoice_no, i.business_date, i.kind, i.customer_name, i.grand_total, i.due_date, b.settled, b.outstanding, b.cancelled
       FROM invoices i JOIN v_invoice_balances b ON b.invoice_id = i.id
       WHERE i.business_date BETWEEN ? AND ? AND (? IS NULL OR i.customer_id = ?) AND (? = 'ALL' OR i.kind = ?)
       ORDER BY i.business_date, i.id LIMIT ?`,
    )
    .all(p.from, p.to, p.customerId ?? null, p.customerId ?? null, p.option, p.option, limit + 1) as {
    id: number;
    invoice_no: string;
    business_date: string;
    kind: string;
    customer_name: string;
    grand_total: number;
    due_date: string;
    settled: number;
    outstanding: number;
    cancelled: number;
  }[];
  return {
    columns: [
      col('invoice', 'Invoice', 'code'),
      col('date', 'Date', 'date'),
      col('type', 'Type', 'text'),
      col('customer', 'Customer', 'text'),
      col('status', 'Status', 'text'),
      col('total', 'Total', 'money', true),
      col('paid', 'Paid', 'money', true),
      col('balance', 'Balance', 'money', true),
      col('cancelledAmount', 'Cancelled', 'money', true),
    ],
    rows: rows.map((r) => ({
      link: { to: 'invoice' as const, id: r.id },
      cells: {
        invoice: r.invoice_no,
        date: r.business_date,
        type: r.kind === 'RENTAL' ? 'Rental bill' : 'Sale',
        customer: r.customer_name,
        status: invoiceStatus(r, today),
        total: r.cancelled ? null : r.grand_total,
        paid: r.cancelled ? null : r.settled,
        balance: r.cancelled ? null : r.outstanding,
        cancelledAmount: r.cancelled ? r.grand_total : null,
      },
    })),
    notes: ['Cancelled invoices are listed with their amount under “Cancelled” only, so they do not add to the totals.'],
  };
};

const discounts: ReportImpl = ({ db, params: p, limit }) => {
  const rows = db
    .prepare(
      `SELECT i.id, i.invoice_no, i.business_date, i.kind, i.customer_name, i.gross_total, i.discount_total, i.grand_total, u.username
       FROM invoices i LEFT JOIN users u ON u.id = i.user_id
       WHERE i.discount_total > 0 AND i.business_date BETWEEN ? AND ? AND ${NOT_CANCELLED}
       ORDER BY i.business_date, i.id LIMIT ?`,
    )
    .all(p.from, p.to, limit + 1) as {
    id: number;
    invoice_no: string;
    business_date: string;
    kind: string;
    customer_name: string;
    gross_total: number;
    discount_total: number;
    grand_total: number;
    username: string | null;
  }[];
  const gross = rows.reduce((a, r) => a + r.gross_total, 0);
  const disc = rows.reduce((a, r) => a + r.discount_total, 0);
  return {
    columns: [
      col('invoice', 'Invoice', 'code'),
      col('date', 'Date', 'date'),
      col('type', 'Type', 'text'),
      col('customer', 'Customer', 'text'),
      col('gross', 'Gross', 'money', true),
      col('discount', 'Discount', 'money', true),
      col('rate', 'Discount %', 'percent'),
      col('total', 'Invoice total', 'money', true),
      col('user', 'Given by', 'text'),
    ],
    rows: rows.map((r) => ({
      link: { to: 'invoice' as const, id: r.id },
      cells: {
        invoice: r.invoice_no,
        date: r.business_date,
        type: r.kind === 'RENTAL' ? 'Rental bill' : 'Sale',
        customer: r.customer_name,
        gross: r.gross_total,
        discount: r.discount_total,
        rate: share(r.discount_total, r.gross_total),
        total: r.grand_total,
        user: r.username ?? '',
      },
    })),
    summary: [
      { label: 'Discounts given', value: disc, kind: 'money' },
      { label: 'Average discount', value: share(disc, gross) ?? 0, kind: 'percent', hint: 'Of the gross amount on these invoices' },
    ],
    notes: ['Cancelled invoices are left out.'],
  };
};

const returns: ReportImpl = ({ db, params: p, limit }) => {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT 'CN' AS t, cn.business_date AS d, cn.id AS sort_id, cn.credit_note_no AS doc, i.invoice_no AS invoice, i.id AS invoice_id,
                c.id AS customer_id, c.name AS customer, cn.reason, cn.settlement, cn.total AS credit, NULL AS refund
         FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id JOIN customers c ON c.id = cn.customer_id
         WHERE cn.business_date BETWEEN ? AND ? AND (? IS NULL OR cn.customer_id = ?)
         UNION ALL
         SELECT 'RF', p.business_date, p.id, p.payment_no, NULL, NULL, c.id, c.name, p.notes, NULL, NULL, p.amount
         FROM payments p JOIN customers c ON c.id = p.party_id
         WHERE p.party_type = 'CUSTOMER' AND p.direction = 'OUT' AND p.business_date BETWEEN ? AND ? AND (? IS NULL OR p.party_id = ?)
           AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id))
       ORDER BY d, t, sort_id LIMIT ?`,
    )
    .all(p.from, p.to, p.customerId ?? null, p.customerId ?? null, p.from, p.to, p.customerId ?? null, p.customerId ?? null, limit + 1) as {
    t: 'CN' | 'RF';
    d: string;
    doc: string;
    invoice: string | null;
    invoice_id: number | null;
    customer_id: number;
    customer: string;
    reason: string;
    settlement: string | null;
    credit: number | null;
    refund: number | null;
  }[];
  const credits = rows.filter((r) => r.t === 'CN');
  return {
    columns: [
      col('date', 'Date', 'date'),
      col('doc', 'Document', 'code'),
      col('type', 'Type', 'text'),
      col('invoice', 'Invoice', 'code'),
      col('customer', 'Customer', 'text'),
      col('reason', 'Reason', 'text'),
      col('settled', 'Settled as', 'text'),
      col('credit', 'Returned value', 'money', true),
      col('refund', 'Refund paid', 'money', true),
    ],
    rows: rows.map((r) => ({
      link: r.invoice_id ? { to: 'invoice' as const, id: r.invoice_id } : { to: 'customer' as const, id: r.customer_id },
      cells: {
        date: r.d,
        doc: r.doc,
        type: r.t === 'CN' ? 'Goods returned' : 'Refund paid',
        invoice: r.invoice ?? '',
        customer: r.customer,
        reason: r.reason,
        settled: r.t === 'CN' ? (r.settlement === 'REFUND' ? 'Refund' : 'Customer credit') : '',
        credit: r.credit,
        refund: r.refund,
      },
    })),
    summary: [
      { label: 'Goods returned', value: credits.reduce((a, r) => a + (r.credit ?? 0), 0), kind: 'money', hint: `${credits.length} credit notes` },
      { label: 'Refunds paid', value: rows.reduce((a, r) => a + (r.refund ?? 0), 0), kind: 'money' },
    ],
    notes: [
      'A return settled as a refund appears twice: once as the goods returned and once as the refund paid. The two columns are not added together.',
      'Refunds that were later reversed are left out.',
    ],
  };
};

const cancelled: ReportImpl = ({ db, params: p, limit }) => {
  const rows = db
    .prepare(
      `SELECT i.id, i.invoice_no, i.business_date, x.business_date AS cancelled_on, i.kind, i.customer_name, i.grand_total, x.reason, u.username
       FROM invoice_cancellations x JOIN invoices i ON i.id = x.invoice_id LEFT JOIN users u ON u.id = x.user_id
       WHERE x.business_date BETWEEN ? AND ? ORDER BY x.id LIMIT ?`,
    )
    .all(p.from, p.to, limit + 1) as {
    id: number;
    invoice_no: string;
    business_date: string;
    cancelled_on: string;
    kind: string;
    customer_name: string;
    grand_total: number;
    reason: string;
    username: string | null;
  }[];
  return {
    columns: [
      col('invoice', 'Invoice', 'code'),
      col('date', 'Invoice date', 'date'),
      col('cancelledOn', 'Cancelled on', 'date'),
      col('type', 'Type', 'text'),
      col('customer', 'Customer', 'text'),
      col('total', 'Amount', 'money', true),
      col('reason', 'Reason', 'text'),
      col('user', 'Cancelled by', 'text'),
    ],
    rows: rows.map((r) => ({
      link: { to: 'invoice' as const, id: r.id },
      cells: {
        invoice: r.invoice_no,
        date: r.business_date,
        cancelledOn: r.cancelled_on,
        type: r.kind === 'RENTAL' ? 'Rental bill' : 'Sale',
        customer: r.customer_name,
        total: r.grand_total,
        reason: r.reason,
        user: r.username ?? '',
      },
    })),
  };
};

/** Unpaid invoices and opening balances as of today, optionally only the overdue ones. */
const outstanding: ReportImpl = ({ db, params: p, today, limit }) => {
  const overdue = p.option === 'OVERDUE';
  const rows = db
    .prepare(
      `SELECT r.doc_type, r.doc_id, r.doc_no, r.business_date, r.due_date, r.amount, r.outstanding, c.id AS customer_id, c.name, c.phone
       FROM v_receivables r JOIN customers c ON c.id = r.customer_id
       WHERE r.cancelled = 0 AND r.outstanding > 0 AND (? IS NULL OR r.customer_id = ?) AND (? = 0 OR r.due_date < ?)
       ORDER BY r.due_date, r.business_date, r.doc_id LIMIT ?`,
    )
    .all(p.customerId ?? null, p.customerId ?? null, overdue ? 1 : 0, today, limit + 1) as {
    doc_type: 'INVOICE' | 'ADJUSTMENT';
    doc_id: number;
    doc_no: string;
    business_date: string;
    due_date: string;
    amount: number;
    outstanding: number;
    customer_id: number;
    name: string;
    phone: string;
  }[];
  return {
    columns: [
      col('doc', 'Bill', 'code'),
      col('customer', 'Customer', 'text'),
      col('phone', 'Phone', 'text'),
      col('date', 'Bill date', 'date'),
      col('due', 'Due date', 'date'),
      col('late', 'Days overdue', 'int'),
      col('amount', 'Amount', 'money', true),
      col('paid', 'Paid', 'money', true),
      col('outstanding', 'Still owed', 'money', true),
    ],
    rows: rows.map((r) => ({
      link: r.doc_type === 'INVOICE' ? { to: 'invoice' as const, id: r.doc_id } : { to: 'customer' as const, id: r.customer_id },
      cells: {
        doc: r.doc_no,
        customer: r.name,
        phone: r.phone,
        date: r.business_date,
        due: r.due_date,
        late: Math.max(0, daysBetween(r.due_date, today)),
        amount: r.amount,
        paid: r.amount - r.outstanding,
        outstanding: r.outstanding,
      },
    })),
    notes: ['Includes sales invoices, rental bills and opening balances. Unused customer credit is not deducted here (see “Customer balances”).'],
  };
};

export const salesReports: Record<string, ReportImpl> = {
  'sales.byPeriod': byPeriod,
  'sales.byProduct': byProduct,
  'sales.byCategory': byCategory,
  'sales.byCustomer': byCustomer,
  'sales.byPaymentMethod': byPaymentMethod,
  'sales.invoices': invoices,
  'sales.discounts': discounts,
  'sales.returns': returns,
  'sales.cancelled': cancelled,
  'sales.outstanding': outstanding,
};
