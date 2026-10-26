import { z } from 'zod';
import type { Permission } from './permissions';

/**
 * The report catalogue, shared by the main process (which runs and authorises reports) and the
 * renderer (which lists them and builds their filters). Every report returns the same table
 * shape, so one screen, one exporter and one print layout serve them all.
 */

export type ReportGroup = 'SALES' | 'INVENTORY' | 'RENTALS' | 'FINANCIAL' | 'PARTIES';

export const REPORT_GROUPS: { id: ReportGroup; title: string; description: string }[] = [
  { id: 'SALES', title: 'Sales', description: 'Product sales, invoices, discounts, returns and cancellations' },
  { id: 'INVENTORY', title: 'Stock', description: 'Stock levels, valuation, movements, purchases and losses' },
  { id: 'RENTALS', title: 'Rentals', description: 'Rentals out, returns due, rental income, utilisation and deposits' },
  { id: 'FINANCIAL', title: 'Money and profit', description: 'Income, cost of goods, gross profit, expenses, cash, GST and liabilities' },
  { id: 'PARTIES', title: 'Customers and suppliers', description: 'Statements, payment history, balances and ageing' },
];

/**
 * Who may run a report:
 * - view: anyone with report access (no costs shown)
 * - cost: report access plus permission to see purchase costs
 * - purchasing: roles that record purchases or pay suppliers
 * - expenses / cash: roles that manage expenses / the cash drawer
 * - financial: financial reports permission
 * The financial permission opens everything.
 */
export type ReportLevel = 'view' | 'cost' | 'purchasing' | 'expenses' | 'cash' | 'financial';

export type ReportParamKey = 'range' | 'asOf' | 'groupBy' | 'customer' | 'supplier' | 'category' | 'rentalProduct' | 'option';

export type DefaultRange = 'today' | 'month' | 'year' | 'next7' | 'last30';

export interface ReportDef {
  id: string;
  groups: ReportGroup[];
  title: string;
  description: string;
  level: ReportLevel;
  params: ReportParamKey[];
  defaultRange?: DefaultRange;
  /** Choices for the report's own filter, with its label. */
  option?: { label: string; choices: { value: string; label: string }[]; default: string };
  /** A customer or supplier must be chosen before the report runs. */
  requires?: 'customer' | 'supplier';
  /** Reports with a fixed layout (summaries) are not re-sorted by column. */
  sortable?: boolean;
  /** Printed sideways when the table is wide. */
  landscape?: boolean;
}

const periodHint = 'Grouped by the day the document was dated.';

export const REPORTS: ReportDef[] = [
  // ---------- A. Sales ----------
  {
    id: 'sales.byPeriod',
    groups: ['SALES'],
    title: 'Sales by day, week or month',
    description: `Product sales invoices, discounts, GST and returns for each period. ${periodHint}`,
    level: 'view',
    params: ['range', 'groupBy'],
    defaultRange: 'month',
    sortable: false,
    landscape: true,
  },
  { id: 'sales.byProduct', groups: ['SALES'], title: 'Sales by product', description: 'Quantity and value of each product sold, net of returns.', level: 'view', params: ['range', 'category'], defaultRange: 'month', landscape: true },
  { id: 'sales.byCategory', groups: ['SALES'], title: 'Sales by category', description: 'Product sales grouped by category, net of returns.', level: 'view', params: ['range'], defaultRange: 'month' },
  { id: 'sales.byCustomer', groups: ['SALES'], title: 'Sales by customer', description: 'Invoices, sales and what is still owed, per customer.', level: 'view', params: ['range'], defaultRange: 'month' },
  {
    id: 'sales.byPaymentMethod',
    groups: ['SALES', 'FINANCIAL'],
    title: 'Payments received by method',
    description: 'Money received from customers and refunds paid, by cash, UPI, card, bank and cheque.',
    level: 'view',
    params: ['range'],
    defaultRange: 'month',
  },
  {
    id: 'sales.invoices',
    groups: ['SALES'],
    title: 'Invoice register',
    description: 'Every invoice in the period with its status, total, payments and balance.',
    level: 'view',
    params: ['range', 'customer', 'option'],
    defaultRange: 'month',
    option: {
      label: 'Invoices',
      default: 'ALL',
      choices: [
        { value: 'ALL', label: 'All invoices' },
        { value: 'SALE', label: 'Sales invoices' },
        { value: 'RENTAL', label: 'Rental bills' },
      ],
    },
    landscape: true,
  },
  { id: 'sales.discounts', groups: ['SALES'], title: 'Discounts given', description: 'Invoices with a discount, how much and by whom.', level: 'view', params: ['range'], defaultRange: 'month' },
  {
    id: 'sales.returns',
    groups: ['SALES', 'FINANCIAL'],
    title: 'Returns and refunds',
    description: 'Credit notes for returned goods and refunds paid to customers.',
    level: 'view',
    params: ['range', 'customer'],
    defaultRange: 'month',
    landscape: true,
  },
  { id: 'sales.cancelled', groups: ['SALES'], title: 'Cancelled invoices', description: 'Invoices cancelled in the period, with the reason and who cancelled them.', level: 'view', params: ['range'], defaultRange: 'month', landscape: true },
  {
    id: 'sales.outstanding',
    groups: ['SALES', 'PARTIES', 'FINANCIAL'],
    title: 'Unpaid invoices',
    description: 'Invoices and opening balances customers still owe, as of today.',
    level: 'view',
    params: ['customer', 'option'],
    option: {
      label: 'Show',
      default: 'ALL',
      choices: [
        { value: 'ALL', label: 'All unpaid' },
        { value: 'OVERDUE', label: 'Overdue only' },
      ],
    },
  },

  // ---------- B. Stock ----------
  {
    id: 'stock.levels',
    groups: ['INVENTORY'],
    title: 'Current stock',
    description: 'Quantity in stock for each product, with minimum levels.',
    level: 'view',
    params: ['category', 'option'],
    option: {
      label: 'Show',
      default: 'ALL',
      choices: [
        { value: 'ALL', label: 'All active products' },
        { value: 'LOW', label: 'Low stock' },
        { value: 'OUT', label: 'Out of stock' },
        { value: 'IN_STOCK', label: 'In stock' },
      ],
    },
  },
  { id: 'stock.low', groups: ['INVENTORY'], title: 'Low stock', description: 'Active products at or below their minimum stock.', level: 'view', params: ['category'] },
  { id: 'stock.out', groups: ['INVENTORY'], title: 'Out of stock', description: 'Active products with none left.', level: 'view', params: ['category'] },
  {
    id: 'stock.valuation',
    groups: ['INVENTORY', 'FINANCIAL'],
    title: 'Stock valuation',
    description: 'Stock value at moving weighted-average cost, on any date. Selling prices are shown for comparison only.',
    level: 'cost',
    params: ['asOf', 'category'],
  },
  {
    id: 'stock.movements',
    groups: ['INVENTORY'],
    title: 'Stock movement history',
    description: 'Every change to stock in the period, with the document and person behind it.',
    level: 'view',
    params: ['range', 'category', 'option'],
    defaultRange: 'month',
    option: {
      label: 'Type',
      default: 'ALL',
      choices: [
        { value: 'ALL', label: 'All movements' },
        { value: 'IN', label: 'Stock in' },
        { value: 'OUT', label: 'Stock out' },
        { value: 'SALE', label: 'Sales' },
        { value: 'PURCHASE', label: 'Purchases' },
        { value: 'RETURNS', label: 'Returns' },
      ],
    },
    landscape: true,
  },
  { id: 'stock.purchases', groups: ['INVENTORY'], title: 'Purchase history', description: 'Purchase bills by bill date, with GST, totals and what is still owed.', level: 'purchasing', params: ['range', 'supplier'], defaultRange: 'month', landscape: true },
  { id: 'stock.losses', groups: ['INVENTORY'], title: 'Damaged and lost stock', description: 'Stock written off as damaged or lost, with the reason.', level: 'view', params: ['range', 'category'], defaultRange: 'month' },
  {
    id: 'stock.adjustments',
    groups: ['INVENTORY'],
    title: 'Stock adjustments',
    description: 'Corrections, stock counts and stock received without a bill.',
    level: 'view',
    params: ['range', 'category'],
    defaultRange: 'month',
    landscape: true,
  },
  { id: 'stock.supplierReturns', groups: ['INVENTORY'], title: 'Goods returned to suppliers', description: 'Debit notes item by item.', level: 'purchasing', params: ['range', 'supplier'], defaultRange: 'month' },

  // ---------- C. Rentals ----------
  { id: 'rentals.active', groups: ['RENTALS'], title: 'Rentals out now', description: 'Rentals with units still with the customer.', level: 'view', params: ['customer'], landscape: true },
  { id: 'rentals.overdue', groups: ['RENTALS'], title: 'Overdue rentals', description: 'Units past their due-back time and not yet returned.', level: 'view', params: [] },
  { id: 'rentals.expectedReturns', groups: ['RENTALS'], title: 'Due back', description: 'Units out on rent that are due back in the period.', level: 'view', params: ['range'], defaultRange: 'next7' },
  {
    id: 'rentals.revenueByPeriod',
    groups: ['RENTALS', 'FINANCIAL'],
    title: 'Rental income by period',
    description: 'Rental charges, late fees and damage charges billed in each period, excluding GST. Deposits are not income.',
    level: 'view',
    params: ['range', 'groupBy'],
    defaultRange: 'month',
    sortable: false,
  },
  { id: 'rentals.revenueByItem', groups: ['RENTALS'], title: 'Rental income by item', description: 'Billed rental income for each rental item, excluding GST.', level: 'view', params: ['range'], defaultRange: 'month' },
  { id: 'rentals.revenueByCustomer', groups: ['RENTALS'], title: 'Rental income by customer', description: 'Rental bills per customer and what is still owed.', level: 'view', params: ['range'], defaultRange: 'month' },
  {
    id: 'rentals.utilization',
    groups: ['RENTALS'],
    title: 'Rental utilisation',
    description: 'How much of the time each item’s units were out on rent in the period.',
    level: 'view',
    params: ['range'],
    defaultRange: 'month',
  },
  { id: 'rentals.availability', groups: ['RENTALS'], title: 'Unit availability', description: 'Units of each rental item by status right now.', level: 'view', params: [], landscape: true },
  {
    id: 'rentals.units',
    groups: ['RENTALS'],
    title: 'Rental units by status',
    description: 'Physical units with their status and condition.',
    level: 'view',
    params: ['rentalProduct', 'option'],
    option: {
      label: 'Status',
      default: 'ALL',
      choices: [
        { value: 'ALL', label: 'All units' },
        { value: 'DAMAGED', label: 'Damaged' },
        { value: 'MAINTENANCE', label: 'Under maintenance' },
        { value: 'AWAITING_INSPECTION', label: 'Awaiting inspection' },
        { value: 'AVAILABLE', label: 'Available' },
        { value: 'RENTED', label: 'Out on rent' },
        { value: 'RESERVED', label: 'Reserved' },
        { value: 'RETIRED', label: 'Retired' },
      ],
    },
  },
  { id: 'rentals.damaged', groups: ['RENTALS'], title: 'Damaged rental units', description: 'Units marked damaged.', level: 'view', params: ['rentalProduct'] },
  { id: 'rentals.maintenance', groups: ['RENTALS'], title: 'Units under maintenance', description: 'Units sent for maintenance.', level: 'view', params: ['rentalProduct'] },
  { id: 'rentals.outstanding', groups: ['RENTALS'], title: 'Unpaid rental charges', description: 'Rental bills customers still owe.', level: 'view', params: ['customer'] },
  { id: 'rentals.lateFees', groups: ['RENTALS'], title: 'Late fees', description: 'Late fees charged, including any reduced or waived.', level: 'view', params: ['range'], defaultRange: 'month', landscape: true },
  { id: 'rentals.damageCharges', groups: ['RENTALS'], title: 'Damage charges', description: 'Damage charged on return.', level: 'view', params: ['range'], defaultRange: 'month', landscape: true },
  {
    id: 'rentals.deposits',
    groups: ['RENTALS'],
    title: 'Deposit movements',
    description: 'Security deposits collected, used for charges and refunded.',
    level: 'view',
    params: ['range', 'option'],
    defaultRange: 'month',
    option: {
      label: 'Type',
      default: 'ALL',
      choices: [
        { value: 'ALL', label: 'All movements' },
        { value: 'COLLECT', label: 'Collected' },
        { value: 'APPLY', label: 'Used for charges (deductions)' },
        { value: 'REFUND', label: 'Refunded' },
      ],
    },
  },
  {
    id: 'rentals.depositsHeld',
    groups: ['RENTALS', 'FINANCIAL'],
    title: 'Deposits held',
    description: 'Security deposits the shop is holding now. They are owed back to customers, not income.',
    level: 'view',
    params: [],
  },

  // ---------- D. Money and profit ----------
  {
    id: 'finance.income',
    groups: ['FINANCIAL'],
    title: 'Income and profit summary',
    description: 'Revenue, cost of goods sold, gross profit, expenses and an estimated net profit for the period, from the accounts.',
    level: 'financial',
    params: ['range'],
    defaultRange: 'month',
    sortable: false,
  },
  {
    id: 'finance.monthly',
    groups: ['FINANCIAL'],
    title: 'Monthly revenue and gross profit',
    description: 'Sales and rental revenue, cost of goods sold and gross profit for each month.',
    level: 'financial',
    params: ['range'],
    defaultRange: 'year',
    sortable: false,
    landscape: true,
  },
  {
    id: 'finance.grossProfit',
    groups: ['FINANCIAL'],
    title: 'Cost of goods sold and gross profit',
    description: 'For each product or category: net sales, cost of goods sold at weighted-average cost, and gross margin.',
    level: 'financial',
    params: ['range', 'category', 'option'],
    defaultRange: 'month',
    option: {
      label: 'By',
      default: 'PRODUCT',
      choices: [
        { value: 'PRODUCT', label: 'Product' },
        { value: 'CATEGORY', label: 'Category' },
      ],
    },
    landscape: true,
  },
  {
    id: 'finance.methodsDaily',
    groups: ['FINANCIAL'],
    title: 'Daily payment-method summary',
    description: 'Money in and out of cash, UPI, card, bank and cheque accounts, day by day.',
    level: 'financial',
    params: ['range'],
    defaultRange: 'month',
    sortable: false,
  },
  {
    id: 'finance.cash',
    groups: ['FINANCIAL'],
    title: 'Cash collection summary',
    description: 'For each day: opening cash, cash in, cash out, expected closing and the count.',
    level: 'cash',
    params: ['range'],
    defaultRange: 'month',
    sortable: false,
    landscape: true,
  },
  {
    id: 'finance.expenses',
    groups: ['FINANCIAL'],
    title: 'Operating expenses',
    description: 'Expenses by date, by category or by month. Purchases of stock are not expenses.',
    level: 'expenses',
    params: ['range', 'option'],
    defaultRange: 'month',
    option: {
      label: 'Show',
      default: 'DETAIL',
      choices: [
        { value: 'DETAIL', label: 'Each expense' },
        { value: 'CATEGORY', label: 'By category' },
        { value: 'MONTH', label: 'By month' },
      ],
    },
  },
  {
    id: 'finance.gst',
    groups: ['FINANCIAL'],
    title: 'GST summary',
    description: 'Output GST on sales and rentals, and input GST on purchases, by rate and HSN/SAC.',
    level: 'financial',
    params: ['range'],
    defaultRange: 'month',
    sortable: false,
    landscape: true,
  },
  {
    id: 'finance.customerCredit',
    groups: ['FINANCIAL'],
    title: 'Customer credit held',
    description: 'Advances, unused returns and credits customers can still use or have refunded.',
    level: 'financial',
    params: [],
  },
  {
    id: 'finance.adjustments',
    groups: ['FINANCIAL'],
    title: 'Financial adjustments',
    description: 'Customer and supplier balance adjustments and cash count differences, with reasons.',
    level: 'financial',
    params: ['range'],
    defaultRange: 'month',
    landscape: true,
  },

  // ---------- E. Customers and suppliers ----------
  {
    id: 'parties.customerStatement',
    groups: ['PARTIES'],
    title: 'Customer statement',
    description: 'Every bill, payment and credit for one customer with a running balance.',
    level: 'view',
    params: ['customer', 'range'],
    defaultRange: 'year',
    requires: 'customer',
    sortable: false,
  },
  { id: 'parties.customerPayments', groups: ['PARTIES'], title: 'Customer payment history', description: 'Payments received and refunds paid.', level: 'view', params: ['range', 'customer'], defaultRange: 'month' },
  {
    id: 'parties.customerBalances',
    groups: ['PARTIES', 'FINANCIAL'],
    title: 'Customer balances',
    description: 'Every customer who owes money or has credit, with overdue amounts.',
    level: 'view',
    params: [],
  },
  {
    id: 'parties.customerAgeing',
    groups: ['PARTIES', 'FINANCIAL'],
    title: 'Customer payment ageing',
    description: 'What each customer owes, by how long it has been owed.',
    level: 'view',
    params: [],
    landscape: true,
  },
  {
    id: 'parties.supplierStatement',
    groups: ['PARTIES'],
    title: 'Supplier statement',
    description: 'Every bill, payment and return for one supplier with a running balance.',
    level: 'purchasing',
    params: ['supplier', 'range'],
    defaultRange: 'year',
    requires: 'supplier',
    sortable: false,
  },
  { id: 'parties.supplierPayments', groups: ['PARTIES'], title: 'Supplier payment history', description: 'Payments made to suppliers and refunds received.', level: 'purchasing', params: ['range', 'supplier'], defaultRange: 'month' },
  {
    id: 'parties.supplierBalances',
    groups: ['PARTIES', 'FINANCIAL'],
    title: 'Supplier balances',
    description: 'What the shop owes each supplier, by how long it has been owed.',
    level: 'purchasing',
    params: [],
    landscape: true,
  },
];

export const REPORT_IDS = REPORTS.map((r) => r.id) as [string, ...string[]];

export function reportDef(id: string): ReportDef | undefined {
  return REPORTS.find((r) => r.id === id);
}

export function canRunReport(def: Pick<ReportDef, 'level'>, permissions: readonly Permission[]): boolean {
  const has = (p: Permission) => permissions.includes(p);
  if (has('reports.financial')) return true;
  switch (def.level) {
    case 'view':
      return has('reports.view');
    case 'cost':
      return has('reports.view') && (has('products.manage') || has('stock.adjust'));
    case 'purchasing':
      return has('purchases.manage') || has('suppliers.pay');
    case 'expenses':
      return has('expenses.manage');
    case 'cash':
      return has('cash.reconcile');
    case 'financial':
      return false;
  }
}

// ---------- Parameters ----------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date');
const id = z.number().int().positive();

export const reportParamsSchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    groupBy: z.enum(['day', 'week', 'month']).default('day'),
    customerId: id.optional(),
    supplierId: id.optional(),
    categoryId: id.optional(),
    rentalProductId: id.optional(),
    option: z.string().max(40).optional(),
  })
  .refine((p) => !p.from || !p.to || p.from <= p.to, { message: 'The start date is after the end date', path: ['from'] });

export type ReportParams = z.output<typeof reportParamsSchema>;

// ---------- Results ----------

/** money: paise · qty: thousandths of a unit · percent: basis points (2534 = 25.34%) · int: a count */
export type ReportCellKind = 'text' | 'code' | 'money' | 'qty' | 'int' | 'percent' | 'date' | 'datetime';

export interface ReportColumn {
  key: string;
  label: string;
  kind: ReportCellKind;
  /** Summed into the totals row. */
  total?: boolean;
}

export type ReportCell = string | number | null;

export type ReportLinkTarget = 'invoice' | 'customer' | 'supplier' | 'product' | 'purchase' | 'rental' | 'rentalProduct';

export interface ReportRow {
  cells: Record<string, ReportCell>;
  /** Heading, subtotal and total rows of structured reports such as the income summary. */
  style?: 'section' | 'subtotal' | 'total';
  link?: { to: ReportLinkTarget; id: number };
}

export interface ReportSummaryItem {
  label: string;
  value: number;
  kind: 'money' | 'int' | 'qty' | 'percent';
  hint?: string;
}

export interface ReportResult {
  reportId: string;
  title: string;
  /** Period and filters in words, e.g. "1 Oct 2026 – 26 Oct 2026 · Category: Power tools". */
  subtitle: string;
  generatedAt: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: Record<string, ReportCell> | null;
  summary: ReportSummaryItem[];
  notes: string[];
  /** More rows matched than could be shown; narrow the period or filters. */
  truncated: boolean;
  rowLimit: number;
}

export const REPORT_ROW_LIMIT = 10_000;
