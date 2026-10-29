import { formatMoney } from './money';
import { formatQty } from './qty';
import { formatDateTime } from './time';
import { MOVEMENT_TYPES } from './stock';

/** How recorded history is described to people: action names, field names, values and changes. */

export const pretty = (s: string): string => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

const ACTION_LABELS: Record<string, string> = {
  EDIT: 'Edited',
  DENIED: 'Refused: no permission',
  BACKUP_PRUNED: 'Old backups removed',
  BACKUP_RESTORED: 'Data restored from a backup',
  RESTORE_FAILED: 'Restore failed',
  AI_SCAN: "Supplier's bill read by AI",
  AI_SCAN_FAILED: "Reading a supplier's bill failed",
  AI_KEY_SET: 'OpenRouter API key saved',
  AI_KEY_REPLACED: 'OpenRouter API key replaced',
  AI_KEY_REMOVED: 'OpenRouter API key removed',
  ITEM_NAME_FORGOTTEN: "Supplier's item name forgotten",
};

export function actionLabel(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  if (action.startsWith('STOCK_')) {
    const type = action.slice(6) as keyof typeof MOVEMENT_TYPES;
    if (MOVEMENT_TYPES[type]) return `Stock: ${MOVEMENT_TYPES[type].label.toLowerCase()}`;
  }
  return pretty(action);
}


/** Human labels for field names that appear in recorded before/after values. */
const FIELD_LABELS: Record<string, string> = {
  sku: 'Product code',
  name: 'Name',
  category: 'Category',
  brand: 'Brand',
  unit: 'Unit',
  hsnCode: 'HSN code',
  gstRateBp: 'GST rate',
  priceIncludesTax: 'Price includes GST',
  pricesIncludeTax: 'Prices include GST',
  purchasePrice: 'Purchase price',
  sellingPrice: 'Selling price',
  minStockQty: 'Minimum stock',
  preferredSupplier: 'Preferred supplier',
  description: 'Description',
  notes: 'Notes',
  isActive: 'Active',
  qty: 'Quantity',
  qtyChange: 'Quantity change',
  value: 'Stock value',
  unitCost: 'Cost per unit',
  movementId: 'Stock movement #',
  gstRegistered: 'GST registered',
  roundInvoiceTotal: 'Round invoice totals',
  allowNegativeOverride: 'Allow negative stock override',
  defaultCreditDays: 'Default credit days',
  ageingBuckets: 'Ageing buckets',
  requireLogin: 'Require sign-in',
  theme: 'Theme',
  stateCode: 'State code',
  gstin: 'GSTIN',
  displayName: 'Name',
  username: 'Username',
  roleId: 'Role',
  permissions: 'Permissions',
  maxDiscountBp: 'Maximum discount',
  openingStock: 'Opening stock',
  'openingStock.qty': 'Opening stock',
  'openingStock.unitCost': 'Opening cost per unit',
  allow_decimal: 'Decimals allowed',
  is_active: 'Active',
  code: 'Code',
  invoiceNo: 'Invoice number',
  customer: 'Customer',
  items: 'Items',
  grossTotal: 'Gross amount',
  discountTotal: 'Discount',
  grandTotal: 'Invoice total',
  paidAmount: 'Paid at the counter',
  creditUsedAmount: 'Paid from credit',
  outstandingAmount: 'Left to pay',
  payments: 'Payments',
  creditNoteNo: 'Credit note',
  totalAmount: 'Credit note total',
  appliedToInvoiceAmount: 'Applied to the invoice',
  refundedAmount: 'Refunded',
  releasedAmount: 'Payments released',
  stockReturned: 'Items returned to stock',
  status: 'Status',
  paymentNo: 'Receipt number',
  method: 'Method',
  reference: 'Reference',
  amount: 'Amount',
  businessName: 'Business name',
  phone: 'Phone',
  address: 'Address',
  creditDays: 'Credit days',
  creditLimit: 'Credit limit',
  rentalNo: 'Rental number',
  units: 'Units',
  startAt: 'Starts',
  expectedReturnAt: 'Due back',
  returnedAt: 'Returned',
  pricingMode: 'Pricing',
  billing: 'Billing',
  depositAmount: 'Deposit',
  rentalInvoice: 'Rental bill',
  saleInvoice: 'Sales invoice',
  extraAmount: 'Extra charge',
  chargesAmount: 'Charges billed',
  depositHeldAmount: 'Deposit held',
  appliedAmount: 'Deposit used',
  unpaidAmount: 'Left unpaid',
  fromReservation: 'From a reservation',
  purchaseNo: 'Purchase number',
  supplier: 'Supplier',
  supplierInvoiceNo: 'Supplier bill number',
  stockValueAdded: 'Stock value added',
  inputGstClaimed: 'Input GST claimed',
  advanceUsedAmount: 'Paid from advance',
  appliedToBillAmount: 'Set against the bill',
  stockRemovedValue: 'Stock value removed',
  stockAdjustmentAmount: 'Stock adjustment',
  debitNoteNo: 'Debit note',
  expenseNo: 'Expense number',
  expenseDate: 'Date paid',
  payee: 'Paid to',
  entryNo: 'Entry number',
  expectedAmount: 'Expected in drawer',
  countedAmount: 'Counted',
  differenceAmount: 'Difference',
  supplierInvoiceDate: 'Supplier bill date',
  ratesIncludeGst: 'Rates include GST',
  freightAmount: 'Freight / other charges',
  freightNote: 'What the charges are for',
  roundOffAmount: 'Round-off',
  fileName: 'File',
  folder: 'Folder',
  sizeBytes: 'Size (bytes)',
  sha256: 'Checksum',
  message: 'Message',
  backupCreatedAt: 'Backup taken',
  preRestoreBackup: 'Copy of the data before restoring',
  schemaVersion: 'Data version',
  migrationsApplied: 'Upgrades applied',
  problemsFound: 'Problems found by the data check',
  problem: 'Problem',
  files: 'Files',
  count: 'Number',
  permission: 'Needed permission',
  format: 'Format',
  rows: 'Rows',
  filters: 'Filters',
  report: 'Report',
  period: 'Period',
  fileSizeKb: 'File size (KB)',
  model: 'AI model',
  seconds: 'Time taken (seconds)',
  itemsRead: 'Items read',
  itemsMatched: 'Items matched to products',
  aiUsage: 'AI tokens used',
  costUsd: 'OpenRouter cost (US$)',
  apiKey: 'API key',
  filledFromScannedBill: 'Filled from scanned bill',
  itemNamesRemembered: "Supplier's item names remembered",
  itemName: "Supplier's item name",
  product: 'Product',
  enabled: 'Switched on',
  monthlyScanLimit: 'Bill scans allowed per month',
};

export function fieldLabel(key: string): string {
  // Items of a bill are recorded by product: "items.Claw hammer (P-000001)".
  if (key.startsWith('items.')) return `Item: ${key.slice(6)}`;
  return FIELD_LABELS[key] ?? key;
}

const MONEY_KEYS = /(price|cost|value|amount|total|balance|limit)$/i;
/** Amounts in paise whose names do not end like one. */
const MONEY_FIELDS = new Set(['stockValueAdded', 'inputGstClaimed']);
const QTY_KEYS = /(qty|qtychange|^system|^counted|difference)$/i;

/** Formats a recorded value using its field name: paise as rupees, milli-units as quantities, basis points as %. */
export function formatFieldValue(key: string, value: unknown): string | null {
  const leaf = key.split('.').pop() ?? key;
  if (typeof value === 'string' && /At$/.test(leaf) && /^\d{4}-\d{2}-\d{2}T/.test(value)) return formatDateTime(value);
  if (typeof value !== 'number') return null;
  if (/Bp$/.test(leaf)) return `${value / 100}%`;
  if (leaf === 'movementId') return String(value);
  if (MONEY_KEYS.test(leaf) || MONEY_FIELDS.has(leaf)) return formatMoney(value);
  if (QTY_KEYS.test(leaf)) return formatQty(value);
  return null;
}

type Flat = Record<string, unknown>;

/** Nested recorded values as dotted keys: { openingStock: { qty } } → { 'openingStock.qty' }. */
export function flattenValues(value: unknown, prefix = '', out: Flat = {}): Flat {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flattenValues(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out[prefix] = value;
  }
  return out;
}

/** One recorded value as text, formatted by its field name. */
export function showValue(key: string, v: unknown): string {
  if (v === undefined) return '—';
  if (v === null || v === '') return '(empty)';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ') : '(none)';
  return formatFieldValue(key, v) ?? String(v);
}

/** What changed, in one line for exports: "Selling price: ₹450.00 → ₹480.00; Name: Hammer". */
export function describeChanges(before: unknown, after: unknown): string {
  const b = flattenValues(before);
  const a = flattenValues(after);
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const parts: string[] = [];
  for (const k of keys) {
    const inB = k in b;
    const inA = k in a;
    if (inB && inA && JSON.stringify(b[k]) === JSON.stringify(a[k])) continue;
    if (inB && inA) parts.push(`${fieldLabel(k)}: ${showValue(k, b[k])} → ${showValue(k, a[k])}`);
    else if (inA) {
      // A new record's empty fields say nothing.
      if (a[k] !== null && a[k] !== '') parts.push(`${fieldLabel(k)}: ${showValue(k, a[k])}`);
    }
    else parts.push(`${fieldLabel(k)}: was ${showValue(k, b[k])}`);
  }
  return parts.join('; ');
}
