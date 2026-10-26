import type { Db } from '../db/connection';
import type { ReportImpl } from './engine';
import { addDays, periodKeys, periodLabel } from './periods';
import { col, NOT_CANCELLED, productSales, share } from './util';
import { getAllSettings } from '../services/settings';
import type { ReportRow } from '@shared/reports';

/** Debit and credit totals per account over a range of business dates. */
function accountTotals(db: Db, from: string, to: string): (code: string) => { debit: number; credit: number } {
  const rows = db
    .prepare(
      `SELECT a.code, SUM(l.debit) AS debit, SUM(l.credit) AS credit FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
       WHERE l.business_date BETWEEN ? AND ? GROUP BY a.code`,
    )
    .all(from, to) as { code: string; debit: number; credit: number }[];
  const map = new Map(rows.map((r) => [r.code, r]));
  return (code) => map.get(code) ?? { debit: 0, credit: 0 };
}

const section = (item: string): ReportRow => ({ style: 'section', cells: { item, amount: null } });
const line = (item: string, amount: number): ReportRow => ({ cells: { item, amount } });
const subtotal = (item: string, amount: number): ReportRow => ({ style: 'subtotal', cells: { item, amount } });

export interface IncomeFigures {
  sales: number;
  returns: number;
  rental: number;
  late: number;
  damage: number;
  revenue: number;
  cogs: number;
  gross: number;
  costs: { expenses: number; stock: number; cash: number; adjustments: number; roundOff: number };
  running: number;
  net: number;
}

/** Revenue, cost of goods sold, gross profit, running costs and an estimated net profit, from the accounts. */
export function incomeFigures(db: Db, from: string, to: string): IncomeFigures & { acc: ReturnType<typeof accountTotals> } {
  const acc = accountTotals(db, from, to);
  const inc = (code: string) => acc(code).credit - acc(code).debit;
  const exp = (code: string) => acc(code).debit - acc(code).credit;
  const sales = inc('SALES');
  const returns = inc('SALES_RETURNS');
  const rental = inc('RENTAL_INCOME');
  const late = inc('LATE_FEE_INCOME');
  const damage = inc('DAMAGE_INCOME');
  const revenue = sales + returns + rental + late + damage;
  const cogs = exp('COGS');
  const costs = {
    expenses: exp('OPERATING_EXPENSES'),
    stock: exp('INVENTORY_LOSS'),
    cash: exp('CASH_OVER_SHORT'),
    adjustments: exp('BALANCE_ADJUSTMENTS'),
    roundOff: exp('ROUND_OFF'),
  };
  const running = Object.values(costs).reduce((a, b) => a + b, 0);
  return { acc, sales, returns, rental, late, damage, revenue, cogs, gross: revenue - cogs, costs, running, net: revenue - cogs - running };
}

const income: ReportImpl = ({ db, params: p }) => {
  const { acc, sales, returns, rental, late, damage, revenue, cogs, gross, costs, running, net } = incomeFigures(db, p.from, p.to);
  const inc = (code: string) => acc(code).credit - acc(code).debit;
  const exp = (code: string) => acc(code).debit - acc(code).credit;
  const gst = inc('OUTPUT_CGST') + inc('OUTPUT_SGST') + inc('OUTPUT_IGST');
  const stockBought = (
    db
      .prepare(
        `SELECT COALESCE(SUM(p.inventory_value), 0) AS v FROM purchases p
         WHERE p.business_date BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM purchase_cancellations c WHERE c.purchase_id = p.id)`,
      )
      .get(p.from, p.to) as { v: number }
  ).v;
  const deposits = db
    .prepare(
      `SELECT COALESCE(SUM(CASE type WHEN 'COLLECT' THEN amount ELSE 0 END), 0) AS collected,
              COALESCE(SUM(CASE type WHEN 'COLLECT' THEN 0 ELSE amount END), 0) AS released
       FROM deposit_transactions WHERE business_date BETWEEN ? AND ?`,
    )
    .get(p.from, p.to) as { collected: number; released: number };

  const rows: ReportRow[] = [
    section('Revenue (excluding GST)'),
    line('Product sales', sales),
    line('Less: goods returned', returns),
    line('Rental charges', rental),
    line('Late fees', late),
    line('Damage charges', damage),
    subtotal('Total revenue', revenue),
    section('Cost of goods sold'),
    line('Cost of the stock that was sold (weighted-average cost)', cogs),
    subtotal('Gross profit', gross),
    section('Running costs'),
    line('Operating expenses', costs.expenses),
    line('Stock damaged, lost or adjusted', costs.stock),
    line('Cash short (or over, if negative)', costs.cash),
    line('Balance adjustments', costs.adjustments),
    line('Round-off', costs.roundOff),
    subtotal('Total running costs', running),
    { style: 'total', cells: { item: 'Estimated net profit', amount: net } },
    section('For reference: not income or costs'),
    line('GST collected on bills (owed to the government)', gst),
    line('Input GST paid on purchases (recoverable)', exp('INPUT_GST')),
    line('Stock bought on purchase bills (becomes cost when sold)', stockBought),
    line('Security deposits collected (owed back to customers)', deposits.collected),
    line('Security deposits used or refunded', deposits.released),
  ];
  return {
    columns: [col('item', 'Item', 'text'), col('amount', 'Amount', 'money')],
    rows,
    noTotals: true,
    summary: [
      { label: 'Revenue', value: revenue, kind: 'money', hint: 'Excluding GST' },
      { label: 'Gross profit', value: gross, kind: 'money', hint: revenue ? `${((gross / revenue) * 100).toFixed(1)}% of revenue` : undefined },
      { label: 'Running costs', value: running, kind: 'money' },
      { label: 'Estimated net profit', value: net, kind: 'money' },
    ],
    notes: [
      'From the accounts. Sales and rentals count when billed; returns, cancellations and corrections count on the day they are made.',
      'Revenue is not money collected, and profit is not cash: customers may still owe part of what was billed.',
      'Purchases are not costs here. Stock bought becomes cost of goods sold only when it is sold, so it is never counted twice.',
      'An estimate: it covers only what has been recorded in the app (for example, rent paid but not entered as an expense is not included).',
    ],
  };
};

const monthly: ReportImpl = ({ db, params: p }) => {
  const rows = db
    .prepare(
      `SELECT substr(l.business_date, 1, 7) AS k, a.code, SUM(l.debit) AS debit, SUM(l.credit) AS credit
       FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
       WHERE l.business_date BETWEEN ? AND ?
         AND a.code IN ('SALES', 'SALES_RETURNS', 'RENTAL_INCOME', 'LATE_FEE_INCOME', 'DAMAGE_INCOME', 'COGS', 'OPERATING_EXPENSES',
                        'OUTPUT_CGST', 'OUTPUT_SGST', 'OUTPUT_IGST')
       GROUP BY k, a.code`,
    )
    .all(p.from, p.to) as { k: string; code: string; debit: number; credit: number }[];
  const by = new Map<string, Map<string, { debit: number; credit: number }>>();
  for (const r of rows) {
    const m = by.get(r.k) ?? new Map();
    m.set(r.code, r);
    by.set(r.k, m);
  }
  const out: ReportRow[] = periodKeys(p.from, p.to, 'month').map((key) => {
    const m = by.get(key);
    const inc = (code: string) => (m?.get(code)?.credit ?? 0) - (m?.get(code)?.debit ?? 0);
    const exp = (code: string) => -inc(code);
    const sales = inc('SALES') + inc('SALES_RETURNS');
    const rental = inc('RENTAL_INCOME') + inc('LATE_FEE_INCOME') + inc('DAMAGE_INCOME');
    const cogs = exp('COGS');
    const gross = sales + rental - cogs;
    return {
      cells: {
        month: periodLabel(key, 'month'),
        sales,
        rental,
        revenue: sales + rental,
        cogs,
        gross,
        margin: share(gross, sales + rental),
        expenses: exp('OPERATING_EXPENSES'),
        gst: inc('OUTPUT_CGST') + inc('OUTPUT_SGST') + inc('OUTPUT_IGST'),
      },
    };
  });
  return {
    columns: [
      col('month', 'Month', 'text'),
      col('sales', 'Product sales', 'money', true),
      col('rental', 'Rental income', 'money', true),
      col('revenue', 'Total revenue', 'money', true),
      col('cogs', 'Cost of goods sold', 'money', true),
      col('gross', 'Gross profit', 'money', true),
      col('margin', 'Gross margin', 'percent'),
      col('expenses', 'Operating expenses', 'money', true),
      col('gst', 'GST collected (not income)', 'money', true),
    ],
    rows: out,
    notes: ['From the accounts, excluding GST. Product sales are after returns. Rental income includes late fees and damage charges.'],
  };
};

const grossProfit: ReportImpl = ({ db, params: p, limit }) => {
  const sales = productSales(db, p.from, p.to, p.categoryId);
  const byCategory = p.option === 'CATEGORY';
  type Agg = { label: string; code: string; netQty: number | null; unit: string; netTaxable: number; cost: number; link?: ReportRow['link'] };
  let groups: Agg[];
  if (byCategory) {
    const m = new Map<string, Agg>();
    for (const r of sales) {
      const g = m.get(r.category) ?? { label: r.category, code: '', netQty: null, unit: '', netTaxable: 0, cost: 0 };
      g.netTaxable += r.netTaxable;
      g.cost += r.cost;
      m.set(r.category, g);
    }
    groups = [...m.values()];
  } else {
    groups = sales.map((r) => ({
      label: r.name,
      code: r.sku,
      netQty: r.soldQty - r.returnedQty,
      unit: r.unit,
      netTaxable: r.netTaxable,
      cost: r.cost,
      link: { to: 'product', id: r.id },
    }));
  }
  groups.sort((a, b) => b.netTaxable - b.cost - (a.netTaxable - a.cost));
  const totalSales = groups.reduce((a, g) => a + g.netTaxable, 0);
  const totalCost = groups.reduce((a, g) => a + g.cost, 0);
  return {
    columns: [
      ...(byCategory ? [col('label', 'Category', 'text')] : [col('code', 'Code', 'code'), col('label', 'Product', 'text'), col('netQty', 'Net quantity', 'qty'), col('unit', 'Unit', 'text')]),
      col('netTaxable', 'Net sales excl. GST', 'money', true),
      col('cost', 'Cost of goods sold', 'money', true),
      col('profit', 'Gross profit', 'money', true),
      col('margin', 'Margin', 'percent'),
    ],
    rows: groups.slice(0, limit + 1).map((g) => ({
      link: g.link,
      cells: {
        code: g.code,
        label: g.label,
        netQty: g.netQty,
        unit: g.unit,
        netTaxable: g.netTaxable,
        cost: g.cost,
        profit: g.netTaxable - g.cost,
        margin: share(g.netTaxable - g.cost, g.netTaxable),
      },
    })),
    summary: [
      { label: 'Net sales', value: totalSales, kind: 'money', hint: 'Excluding GST' },
      { label: 'Cost of goods sold', value: totalCost, kind: 'money' },
      { label: 'Gross profit', value: totalSales - totalCost, kind: 'money' },
      { label: 'Gross margin', value: share(totalSales - totalCost, totalSales) ?? 0, kind: 'percent' },
    ],
    notes: [
      'Product sales only, by invoice date with cancelled invoices left out, less returns in the period.',
      'Cost of goods sold is the moving weighted-average cost of each item when it was sold, less the cost of goods returned to stock.',
      'Damaged returns that did not go back to stock still count as cost.',
    ],
  };
};

const methodsDaily: ReportImpl = ({ db, params: p, limit }) => {
  const rows = db
    .prepare(
      `SELECT l.business_date AS d, a.name, SUM(l.debit) AS money_in, SUM(l.credit) AS money_out
       FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
       WHERE a.code IN ('CASH', 'UPI', 'CARD', 'BANK', 'CHEQUE') AND l.business_date BETWEEN ? AND ?
       GROUP BY d, a.id ORDER BY d, a.id LIMIT ?`,
    )
    .all(p.from, p.to, limit + 1) as { d: string; name: string; money_in: number; money_out: number }[];
  return {
    columns: [col('date', 'Date', 'date'), col('account', 'Account', 'text'), col('in', 'Money in', 'money', true), col('out', 'Money out', 'money', true), col('net', 'Net', 'money', true)],
    rows: rows.map((r) => ({ cells: { date: r.d, account: r.name, in: r.money_in, out: r.money_out, net: r.money_in - r.money_out } })),
    notes: [
      'Everything that moved money in each account: customer payments, deposits, supplier payments, expenses, refunds and transfers.',
      'A bank deposit of cash shows as money out of cash and money into the bank.',
    ],
  };
};

const cash: ReportImpl = ({ db, params: p }) => {
  const cashId = (db.prepare("SELECT id FROM accounts WHERE code = 'CASH'").get() as { id: number }).id;
  let balance = (
    db.prepare('SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries WHERE account_id = ? AND business_date < ?').get(cashId, p.from) as { b: number }
  ).b;
  const days = new Map(
    (
      db
        .prepare(
          `SELECT business_date AS d, SUM(debit) AS money_in, SUM(credit) AS money_out FROM ledger_entries
           WHERE account_id = ? AND business_date BETWEEN ? AND ? GROUP BY business_date`,
        )
        .all(cashId, p.from, p.to) as { d: string; money_in: number; money_out: number }[]
    ).map((r) => [r.d, r]),
  );
  const counts = new Map(
    (
      db
        .prepare(
          `SELECT c.business_date AS d, c.counted, c.difference, (SELECT COUNT(*) FROM cash_counts x WHERE x.business_date = c.business_date) AS n
           FROM cash_counts c WHERE c.business_date BETWEEN ? AND ?
             AND c.id = (SELECT MAX(id) FROM cash_counts y WHERE y.business_date = c.business_date)`,
        )
        .all(p.from, p.to) as { d: string; counted: number; difference: number; n: number }[]
    ).map((r) => [r.d, r]),
  );
  const rows: ReportRow[] = [];
  for (let d = p.from; d <= p.to; d = addDays(d, 1)) {
    const day = days.get(d);
    const count = counts.get(d);
    const opening = balance;
    balance += (day?.money_in ?? 0) - (day?.money_out ?? 0);
    rows.push({
      cells: {
        date: d,
        opening,
        in: day?.money_in ?? 0,
        out: day?.money_out ?? 0,
        closing: balance,
        counted: count?.counted ?? null,
        difference: count ? count.difference : null,
        counts: count?.n ?? 0,
      },
    });
    if (rows.length > 1000) break;
  }
  return {
    columns: [
      col('date', 'Date', 'date'),
      col('opening', 'Opening', 'money'),
      col('in', 'Cash in', 'money', true),
      col('out', 'Cash out', 'money', true),
      col('closing', 'Expected closing', 'money'),
      col('counted', 'Last count', 'money'),
      col('difference', 'Count difference', 'money', true),
      col('counts', 'Counts', 'int', true),
    ],
    rows,
    notes: [
      'From the cash account. A count difference is posted as cash over or short, so it is already included in cash in or out for that day.',
      '“Last count” and “Count difference” are from the last count made that day.',
    ],
  };
};

const expenses: ReportImpl = ({ db, params: p, limit }) => {
  const mode = p.option ?? 'DETAIL';
  const notes = ['Voided expenses are left out; corrected expenses show their corrected values.', 'Stock bought for sale is not an expense: it becomes cost of goods sold when sold.'];
  if (mode === 'CATEGORY' || mode === 'MONTH') {
    const key = mode === 'CATEGORY' ? 'c.name' : 'substr(e.expense_date, 1, 7)';
    const rows = db
      .prepare(
        `SELECT ${key} AS k, COUNT(*) AS n, SUM(e.amount) AS amount FROM expenses e JOIN categories c ON c.id = e.category_id
         WHERE e.status = 'ACTIVE' AND e.expense_date BETWEEN ? AND ? GROUP BY k ORDER BY ${mode === 'CATEGORY' ? 'amount DESC' : 'k'}`,
      )
      .all(p.from, p.to) as { k: string; n: number; amount: number }[];
    const total = rows.reduce((a, r) => a + r.amount, 0);
    return {
      columns: [col('group', mode === 'CATEGORY' ? 'Category' : 'Month', 'text'), col('count', 'Expenses', 'int', true), col('amount', 'Amount', 'money', true), col('share', 'Share', 'percent')],
      rows: rows.map((r) => ({ cells: { group: mode === 'MONTH' ? periodLabel(r.k, 'month') : r.k, count: r.n, amount: r.amount, share: share(r.amount, total) } })),
      summary: [{ label: 'Operating expenses', value: total, kind: 'money' }],
      notes,
    };
  }
  const rows = db
    .prepare(
      `SELECT e.expense_date, e.expense_no, c.name AS category, e.description, e.payee, m.name AS method, e.amount
       FROM expenses e JOIN categories c ON c.id = e.category_id JOIN payment_methods m ON m.id = e.method_id
       WHERE e.status = 'ACTIVE' AND e.expense_date BETWEEN ? AND ? ORDER BY e.expense_date, e.id LIMIT ?`,
    )
    .all(p.from, p.to, limit + 1) as { expense_date: string; expense_no: string; category: string; description: string; payee: string; method: string; amount: number }[];
  return {
    columns: [
      col('date', 'Date paid', 'date'),
      col('no', 'Expense', 'code'),
      col('category', 'Category', 'text'),
      col('description', 'What for', 'text'),
      col('payee', 'Paid to', 'text'),
      col('method', 'Paid by', 'text'),
      col('amount', 'Amount', 'money', true),
    ],
    rows: rows.map((r) => ({ cells: { date: r.expense_date, no: r.expense_no, category: r.category, description: r.description, payee: r.payee, method: r.method, amount: r.amount } })),
    summary: [{ label: 'Operating expenses', value: rows.reduce((a, r) => a + r.amount, 0), kind: 'money' }],
    notes,
  };
};

interface GstGroup {
  hsn: string;
  rate: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
}

function mergeGst(plus: GstGroup[], minus: GstGroup[]): GstGroup[] {
  const m = new Map<string, GstGroup>();
  for (const [rows, sign] of [
    [plus, 1],
    [minus, -1],
  ] as const) {
    for (const r of rows) {
      const k = `${r.hsn}|${r.rate}`;
      const g = m.get(k) ?? { hsn: r.hsn, rate: r.rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
      g.taxable += sign * r.taxable;
      g.cgst += sign * r.cgst;
      g.sgst += sign * r.sgst;
      g.igst += sign * r.igst;
      m.set(k, g);
    }
  }
  return [...m.values()].sort((a, b) => a.rate - b.rate || a.hsn.localeCompare(b.hsn));
}

const GST_SUM = 'SUM({t}.taxable) AS taxable, SUM({t}.cgst) AS cgst, SUM({t}.sgst) AS sgst, SUM({t}.igst) AS igst';

const gst: ReportImpl = ({ db, params: p }) => {
  const sum = (t: string) => GST_SUM.replace(/\{t\}/g, t);
  const output = mergeGst(
    db
      .prepare(
        `SELECT l.hsn_code AS hsn, l.gst_rate_bp AS rate, ${sum('l')} FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
         WHERE i.business_date BETWEEN ? AND ? AND ${NOT_CANCELLED} GROUP BY l.hsn_code, l.gst_rate_bp`,
      )
      .all(p.from, p.to) as GstGroup[],
    db
      .prepare(
        `SELECT l.hsn_code AS hsn, l.gst_rate_bp AS rate, ${sum('cl')} FROM credit_note_lines cl JOIN credit_notes cn ON cn.id = cl.credit_note_id
         JOIN invoice_lines l ON l.id = cl.invoice_line_id WHERE cn.business_date BETWEEN ? AND ? GROUP BY l.hsn_code, l.gst_rate_bp`,
      )
      .all(p.from, p.to) as GstGroup[],
  );
  const input = mergeGst(
    db
      .prepare(
        `SELECT l.hsn_code AS hsn, l.gst_rate_bp AS rate, ${sum('l')} FROM purchase_lines l JOIN purchases pu ON pu.id = l.purchase_id
         WHERE pu.itc_claimed = 1 AND pu.supplier_invoice_date BETWEEN ? AND ?
           AND NOT EXISTS (SELECT 1 FROM purchase_cancellations c WHERE c.purchase_id = pu.id)
         GROUP BY l.hsn_code, l.gst_rate_bp`,
      )
      .all(p.from, p.to) as GstGroup[],
    db
      .prepare(
        `SELECT l.hsn_code AS hsn, l.gst_rate_bp AS rate, ${sum('dl')} FROM debit_note_lines dl JOIN debit_notes d ON d.id = dl.debit_note_id
         JOIN purchase_lines l ON l.id = dl.purchase_line_id JOIN purchases pu ON pu.id = d.purchase_id
         WHERE pu.itc_claimed = 1 AND d.business_date BETWEEN ? AND ? GROUP BY l.hsn_code, l.gst_rate_bp`,
      )
      .all(p.from, p.to) as GstGroup[],
  );
  const tot = (gs: GstGroup[]) => gs.reduce((a, g) => ({ taxable: a.taxable + g.taxable, cgst: a.cgst + g.cgst, sgst: a.sgst + g.sgst, igst: a.igst + g.igst }), { taxable: 0, cgst: 0, sgst: 0, igst: 0 });
  const row = (g: GstGroup): ReportRow => ({ cells: { hsn: g.hsn || '(none)', rate: g.rate, taxable: g.taxable, cgst: g.cgst, sgst: g.sgst, igst: g.igst, tax: g.cgst + g.sgst + g.igst } });
  const o = tot(output);
  const i = tot(input);
  const heading = (hsn: string): ReportRow => ({ style: 'section', cells: { hsn, rate: null, taxable: null, cgst: null, sgst: null, igst: null, tax: null } });
  const rows: ReportRow[] = [
    heading('Output GST: sales and rental bills, less credit notes'),
    ...output.filter((g) => g.taxable || g.cgst || g.sgst || g.igst).map(row),
    { style: 'subtotal', cells: { hsn: 'Total output GST', rate: null, ...o, tax: o.cgst + o.sgst + o.igst } },
    heading('Input GST: purchase bills where GST is claimed, less debit notes'),
    ...input.filter((g) => g.taxable || g.cgst || g.sgst || g.igst).map(row),
    { style: 'subtotal', cells: { hsn: 'Total input GST', rate: null, ...i, tax: i.cgst + i.sgst + i.igst } },
    {
      style: 'total',
      cells: { hsn: 'Net GST (output − input)', rate: null, taxable: null, cgst: o.cgst - i.cgst, sgst: o.sgst - i.sgst, igst: o.igst - i.igst, tax: o.cgst + o.sgst + o.igst - (i.cgst + i.sgst + i.igst) },
    },
  ];
  const notes = [
    'A summary for your accountant, from the bills in the period: sales and rental invoices by invoice date (cancelled ones left out), credit notes by their date, purchase bills by the supplier’s bill date, and debit notes by their date.',
    'Input GST is listed only for bills where it is claimed (the supplier has a GSTIN and claiming is switched on). Check figures with your accountant before filing.',
  ];
  if (!getAllSettings(db).tax.gstRegistered) notes.unshift('The shop is set up as not GST registered, so bills carry no GST.');
  return {
    columns: [
      col('hsn', 'HSN / SAC', 'text'),
      col('rate', 'GST rate', 'percent'),
      col('taxable', 'Taxable value', 'money'),
      col('cgst', 'CGST', 'money'),
      col('sgst', 'SGST', 'money'),
      col('igst', 'IGST', 'money'),
      col('tax', 'Total GST', 'money'),
    ],
    rows,
    noTotals: true,
    summary: [
      { label: 'Output GST', value: o.cgst + o.sgst + o.igst, kind: 'money' },
      { label: 'Input GST', value: i.cgst + i.sgst + i.igst, kind: 'money' },
      { label: 'Net GST', value: o.cgst + o.sgst + o.igst - (i.cgst + i.sgst + i.igst), kind: 'money', hint: 'Estimate of GST payable' },
    ],
    notes,
  };
};

const customerCredit: ReportImpl = ({ db, limit }) => {
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.phone,
              SUM(CASE s.source_type WHEN 'PAYMENT' THEN s.unallocated ELSE 0 END) AS advances,
              SUM(CASE s.source_type WHEN 'CREDIT_NOTE' THEN s.unallocated ELSE 0 END) AS returns,
              SUM(CASE s.source_type WHEN 'ADJUSTMENT' THEN s.unallocated ELSE 0 END) AS credits,
              SUM(s.unallocated) AS total
       FROM v_credit_sources s JOIN customers c ON c.id = s.customer_id
       WHERE s.reversed = 0 AND s.unallocated > 0 GROUP BY c.id ORDER BY total DESC LIMIT ?`,
    )
    .all(limit + 1) as { id: number; name: string; phone: string; advances: number; returns: number; credits: number; total: number }[];
  return {
    columns: [
      col('customer', 'Customer', 'text'),
      col('phone', 'Phone', 'text'),
      col('advances', 'Advances paid', 'money', true),
      col('returns', 'Unused returns', 'money', true),
      col('credits', 'Credits given', 'money', true),
      col('total', 'Credit held', 'money', true),
    ],
    rows: rows.map((r) => ({ link: { to: 'customer' as const, id: r.id }, cells: { customer: r.name, phone: r.phone, advances: r.advances, returns: r.returns, credits: r.credits, total: r.total } })),
    notes: ['Credit is owed to the customer: it can settle their open bills or be refunded. Rental security deposits are separate (see “Deposits held”).'],
  };
};

const ADJ_TYPE: Record<string, string> = {
  'Customer:OPENING': 'Customer opening balance',
  'Customer:ADJUSTMENT': 'Customer balance correction',
  'Supplier:OPENING': 'Supplier opening balance',
  'Supplier:ADJUSTMENT': 'Supplier balance correction',
};

const adjustments: ReportImpl = ({ db, params: p, limit }) => {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT b.business_date AS d, b.created_at AS at, 'Customer' AS who, c.name AS party, c.id AS party_id, b.kind, b.amount, b.reason, u.username
         FROM balance_adjustments b JOIN customers c ON c.id = b.customer_id LEFT JOIN users u ON u.id = b.user_id
         WHERE b.business_date BETWEEN ? AND ?
         UNION ALL
         SELECT s.business_date, s.created_at, 'Supplier', sp.name, sp.id, s.kind, s.amount, s.reason, u.username
         FROM supplier_adjustments s JOIN suppliers sp ON sp.id = s.supplier_id LEFT JOIN users u ON u.id = s.user_id
         WHERE s.business_date BETWEEN ? AND ?
         UNION ALL
         SELECT cc.business_date, cc.counted_at, 'Cash', '', NULL, 'COUNT', cc.difference, cc.note, u.username
         FROM cash_counts cc LEFT JOIN users u ON u.id = cc.user_id
         WHERE cc.difference != 0 AND cc.business_date BETWEEN ? AND ?)
       ORDER BY at LIMIT ?`,
    )
    .all(p.from, p.to, p.from, p.to, p.from, p.to, limit + 1) as {
    d: string;
    who: 'Customer' | 'Supplier' | 'Cash';
    party: string;
    party_id: number | null;
    kind: string;
    amount: number;
    reason: string;
    username: string | null;
  }[];
  const effect = (r: (typeof rows)[number]) => {
    if (r.who === 'Cash') return r.amount > 0 ? 'Drawer over' : 'Drawer short';
    if (r.who === 'Customer') return r.amount > 0 ? 'Customer owes more' : 'Credit to the customer';
    return r.amount > 0 ? 'Shop owes the supplier more' : 'In the shop’s favour';
  };
  return {
    columns: [
      col('date', 'Date', 'date'),
      col('type', 'Adjustment', 'text'),
      col('party', 'Customer / supplier', 'text'),
      col('effect', 'Effect', 'text'),
      col('amount', 'Amount', 'money'),
      col('reason', 'Reason', 'text'),
      col('user', 'By', 'text'),
    ],
    rows: rows.map((r) => ({
      link: r.party_id ? { to: r.who === 'Customer' ? ('customer' as const) : ('supplier' as const), id: r.party_id } : undefined,
      cells: {
        date: r.d,
        type: r.who === 'Cash' ? 'Cash count difference' : ADJ_TYPE[`${r.who}:${r.kind}`]!,
        party: r.party,
        effect: effect(r),
        amount: Math.abs(r.amount),
        reason: r.reason,
        user: r.username ?? '',
      },
    })),
    notes: ['Each adjustment is a separate correction with its own reason; amounts are not added together because they work in different directions.'],
  };
};

export const financialReports: Record<string, ReportImpl> = {
  'finance.income': income,
  'finance.monthly': monthly,
  'finance.grossProfit': grossProfit,
  'finance.methodsDaily': methodsDaily,
  'finance.cash': cash,
  'finance.expenses': expenses,
  'finance.gst': gst,
  'finance.customerCredit': customerCredit,
  'finance.adjustments': adjustments,
};
