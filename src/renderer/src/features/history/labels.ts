import { formatMoney } from '@shared/money';
import { formatQty } from '@shared/qty';
import { formatDateTime } from '@shared/time';
import { MOVEMENT_TYPES } from '@shared/stock';

export const pretty = (s: string): string => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export function actionLabel(action: string): string {
  if (action.startsWith('STOCK_')) {
    const type = action.slice(6) as keyof typeof MOVEMENT_TYPES;
    if (MOVEMENT_TYPES[type]) return `Stock: ${MOVEMENT_TYPES[type].label.toLowerCase()}`;
  }
  return pretty(action);
}

export function actionTone(action: string): 'danger' | 'warning' | 'success' | 'neutral' | 'info' {
  if (action.includes('FAILED') || action === 'DENIED' || action.includes('LOCKED') || action === 'STOCK_DAMAGE' || action === 'STOCK_LOSS')
    return 'danger';
  if (action.includes('DELETE') || action.includes('DEACTIVATE') || action.includes('CANCEL') || action.includes('REVERS'))
    return 'warning';
  if (action === 'PRICE_CHANGE') return 'info';
  if (action === 'CREATE' || action.includes('CREATED') || action === 'IMPORT' || action === 'ISSUE') return 'success';
  if (action === 'RETURN' || action === 'EXTEND' || action === 'RESERVE') return 'info';
  return 'neutral';
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
};

export function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key;
}

const MONEY_KEYS = /(price|cost|value|amount|total|balance|limit)$/i;
const QTY_KEYS = /(qty|qtychange|^system|^counted|difference)$/i;

/** Formats a recorded value using its field name: paise as rupees, milli-units as quantities, basis points as %. */
export function formatFieldValue(key: string, value: unknown): string | null {
  const leaf = key.split('.').pop() ?? key;
  if (typeof value === 'string' && /At$/.test(leaf) && /^\d{4}-\d{2}-\d{2}T/.test(value)) return formatDateTime(value);
  if (typeof value !== 'number') return null;
  if (/Bp$/.test(leaf)) return `${value / 100}%`;
  if (leaf === 'movementId') return String(value);
  if (MONEY_KEYS.test(leaf)) return formatMoney(value);
  if (QTY_KEYS.test(leaf)) return formatQty(value);
  return null;
}
