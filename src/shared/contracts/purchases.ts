import { z } from 'zod';
import { command, type Paged } from './define';
import { discountSchema, type CustomerLedger } from './sales';
import { GST_STATE_CODES, isValidGstin } from '../gstStates';

// ---------- Types returned to the renderer ----------

export interface SupplierRow {
  id: number;
  code: string;
  name: string;
  phone: string;
  businessName: string;
  gstin: string;
  stateCode: string;
  /** What the shop owes the supplier (positive) or has paid in advance (negative), from the ledger. */
  balance: number;
  overdue: number;
  isActive: boolean;
}

export interface SupplierDetail extends SupplierRow {
  address: string;
  creditDays: number | null;
  effectiveCreditDays: number;
  notes: string;
  /** Open amounts on purchases and opening balances. */
  outstanding: number;
  /** Advances and debit notes not yet used against a bill. */
  availableCredit: number;
  purchaseCount: number;
  lastPurchaseDate: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** Running supplier account. Credits are what the shop owes; the balance is positive when the shop owes. */
export type SupplierLedger = CustomerLedger;

/** REPLACED: an earlier version of a bill that was edited; the newer version counts instead. */
export type PurchaseStatus = 'PAID' | 'PARTIAL' | 'UNPAID' | 'CANCELLED' | 'REPLACED';

export interface PurchaseRow {
  id: number;
  purchaseNo: string;
  supplierId: number;
  supplierName: string;
  supplierInvoiceNo: string;
  supplierInvoiceDate: string;
  businessDate: string;
  dueDate: string;
  itemCount: number;
  grandTotal: number;
  outstanding: number;
  returnedTotal: number;
  status: PurchaseStatus;
  overdue: boolean;
  username: string | null;
}

export interface PurchaseLineDetail {
  id: number;
  lineNo: number;
  productId: number;
  sku: string;
  name: string;
  hsnCode: string;
  unitCode: string;
  allowDecimal: boolean;
  qty: number;
  returnedQty: number;
  unitCost: number;
  gross: number;
  lineDiscount: number;
  billDiscount: number;
  taxable: number;
  gstRateBp: number;
  cgst: number;
  sgst: number;
  igst: number;
  lineTotal: number;
  additionalCost: number;
  /** Stock value added by this line, and per unit. */
  landedValue: number;
  landedUnitCost: number;
}

export interface DebitNoteSummary {
  id: number;
  debitNoteNo: string;
  issuedAt: string;
  total: number;
  settlement: 'ADJUST' | 'REFUND';
  reason: string;
  username: string | null;
}

export interface PurchaseSettlement {
  kind: 'PAYMENT' | 'DEBIT_NOTE' | 'ADJUSTMENT';
  id: number;
  docNo: string;
  amount: number;
  at: string;
}

export interface PurchaseDetail extends PurchaseRow {
  supplierGstin: string;
  supplierStateCode: string;
  isInterstate: boolean;
  pricesIncludeTax: boolean;
  itcClaimed: boolean;
  grossTotal: number;
  discountTotal: number;
  taxableTotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  additionalCosts: number;
  additionalCostsNote: string;
  roundOff: number;
  inventoryValue: number;
  notes: string;
  receivedAt: string;
  lines: PurchaseLineDetail[];
  settlements: PurchaseSettlement[];
  debitNotes: DebitNoteSummary[];
  cancellation: { at: string; reason: string; username: string | null } | null;
  /** This version's number; 1 is the bill as first entered. */
  version: number;
  /** Every version of this bill, oldest first (just this one when it was never edited). */
  versions: PurchaseVersion[];
  /** Set on an earlier version: the edit that replaced it. */
  replacedBy: { id: number; purchaseNo: string; at: string; username: string | null; reason: string } | null;
}

export interface PurchaseVersion {
  id: number;
  purchaseNo: string;
  version: number;
  /** When this version was saved: entered (version 1) or edited. */
  savedAt: string;
  username: string | null;
  /** Why the bill was edited into this version; null for the first. */
  reason: string | null;
}

export interface SupplierPaymentRow {
  id: number;
  paymentNo: string;
  /** OUT: paid to the supplier. IN: money refunded by the supplier. */
  direction: 'IN' | 'OUT';
  supplierId: number;
  supplierName: string;
  amount: number;
  methodName: string;
  methodKind: string;
  reference: string;
  notes: string;
  paidAt: string;
  businessDate: string;
  username: string | null;
  reversal: { at: string; reason: string; username: string | null } | null;
  appliedTo: { docType: string; docId: number; docNo: string; amount: number }[];
  /** Advance not yet set against a bill. */
  unallocated: number;
}

export interface PayableRow {
  docType: 'PURCHASE' | 'ADJUSTMENT';
  docId: number;
  docNo: string;
  supplierInvoiceNo: string;
  supplierId: number;
  supplierName: string;
  phone: string;
  billDate: string;
  dueDate: string;
  amount: number;
  outstanding: number;
  daysOverdue: number;
  status: 'PARTIAL' | 'UNPAID';
}

export interface PayablesSummary {
  outstanding: number;
  overdue: number;
  dueInSevenDays: number;
  suppliersOwed: number;
  advances: number;
}

export interface PayablesAgeing {
  bucketLabels: string[];
  rows: { supplierId: number; supplierName: string; phone: string; buckets: number[]; outstanding: number; credit: number; balance: number }[];
  totals: { buckets: number[]; outstanding: number; credit: number; balance: number };
}

// ---------- Input schemas ----------

const id = z.number().int().positive();
const version = z.number().int().positive();
const paise = z.number().int().min(0).max(1_000_000_000_00);
const requestId = z.string().uuid();
const text = (max: number) => z.string().trim().max(max).default('');
const reasonRequired = z.string().trim().min(3, 'Please give a reason (at least 3 characters)').max(500);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date');
const paymentLine = z.object({ methodId: id, amount: z.number().int().positive(), reference: text(60) });

const pageInput = {
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(5).max(200).default(50),
};

export const supplierFields = z.object({
  name: z.string().trim().min(1, 'Supplier name is required').max(120),
  phone: z
    .string()
    .trim()
    .max(20)
    .refine((v) => v === '' || /^[+0-9][0-9 -]{5,18}$/.test(v), 'Enter a valid phone number')
    .default(''),
  address: text(300),
  businessName: text(120),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => v === '' || isValidGstin(v), 'GSTIN is not valid')
    .default(''),
  stateCode: z
    .string()
    .refine((v) => v === '' || GST_STATE_CODES.includes(v), 'Choose a state')
    .default(''),
  creditDays: z.number().int().min(0).max(365).nullable().default(null),
  notes: text(1000),
});

export const purchaseLineInput = z.object({
  productId: id,
  qty: z.number().int().positive('Enter a quantity'),
  /** Rate per unit as on the supplier's bill. */
  unitCost: paise,
  gstRateBp: z.number().int().min(0).max(10_000),
  discount: discountSchema.default(null),
});


/** A supplier's bill as entered; shared by entering and editing a purchase. */
const purchaseBillInput = z.object({
  supplierId: id,
  supplierInvoiceNo: text(40),
  supplierInvoiceDate: isoDate,
  pricesIncludeTax: z.boolean().default(false),
  lines: z.array(purchaseLineInput).min(1, 'Add at least one item').max(300),
  billDiscount: discountSchema.default(null),
  additionalCosts: paise.default(0),
  additionalCostsNote: text(120),
  /** Difference to match the supplier's bill total (positive adds to the total). */
  roundOff: z.number().int().min(-10_000).max(10_000).default(0),
  notes: text(500),
  /** Also set each product's purchase price to the new landed cost per unit. */
  updatePurchasePrices: z.boolean().default(true),
  expectedGrandTotal: paise,
});

export const purchaseCommands = {
  'suppliers.list': command<Paged<SupplierRow>>()(
    z.object({
      search: z.string().trim().max(100).optional(),
      filter: z.enum(['ALL', 'OWED', 'OVERDUE', 'ADVANCE']).default('ALL'),
      active: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).default('ACTIVE'),
      ...pageInput,
    }),
  ),
  'suppliers.get': command<SupplierDetail>()(z.object({ id })),
  'suppliers.create': command<SupplierDetail>()(supplierFields.extend({ requestId, openingBalance: z.number().int().default(0) })),
  'suppliers.update': command<SupplierDetail>()(supplierFields.extend({ id, version, reason: z.string().trim().max(500).optional() })),
  'suppliers.setActive': command<SupplierDetail>()(z.object({ id, version, isActive: z.boolean(), reason: reasonRequired })),
  'suppliers.ledger': command<SupplierLedger>()(z.object({ id, from: isoDate.optional(), to: isoDate.optional() })),
  'suppliers.adjustBalance': command<SupplierDetail>()(
    z.object({
      requestId,
      supplierId: id,
      kind: z.enum(['OPENING', 'ADJUSTMENT']),
      /** Positive: the shop owes the supplier more. Negative: in the shop's favour. */
      amount: z.number().int().refine((v) => v !== 0, 'Enter an amount'),
      reason: reasonRequired,
    }),
  ),

  'purchases.create': command<{ purchaseId: number; purchaseNo: string; grandTotal: number; outstanding: number }>()(
    purchaseBillInput.extend({
      requestId,
      /** Paid to the supplier now, at the time of entry. */
      payments: z.array(paymentLine).max(6).default([]),
    }),
  ),
  'purchases.list': command<Paged<PurchaseRow>>()(
    z.object({
      search: z.string().trim().max(100).optional(),
      supplierId: id.optional(),
      productId: id.optional(),
      status: z.enum(['ALL', 'PAID', 'PARTIAL', 'UNPAID', 'OPEN', 'OVERDUE', 'CANCELLED', 'REPLACED']).default('ALL'),
      from: isoDate.optional(),
      to: isoDate.optional(),
      ...pageInput,
    }),
  ),
  'purchases.get': command<PurchaseDetail>()(z.object({ id })),
  'purchases.cancel': command<PurchaseDetail>()(z.object({ id, reason: reasonRequired, requestId })),
  /** Saves a corrected version of a bill; the version edited is kept and marked replaced. */
  'purchases.edit': command<{ purchaseId: number; purchaseNo: string; grandTotal: number; outstanding: number }>()(
    purchaseBillInput.extend({ requestId, id, reason: reasonRequired }),
  ),

  'supplierReturns.create': command<{ debitNoteId: number; debitNoteNo: string; total: number }>()(
    z.object({
      requestId,
      purchaseId: id,
      lines: z.array(z.object({ purchaseLineId: id, qty: z.number().int().positive() })).min(1, 'Choose at least one item to return'),
      reason: reasonRequired,
      settlement: z.enum(['ADJUST', 'REFUND']),
      refundMethodId: id.optional(),
      reference: text(60),
    }),
  ),

  'supplierPayments.create': command<SupplierPaymentRow>()(
    z.object({
      requestId,
      supplierId: id,
      amount: z.number().int().positive('Enter an amount'),
      methodId: id,
      reference: text(60),
      notes: text(300),
      /** Specific bills to settle; when empty the oldest open bills are settled first. */
      allocations: z
        .array(z.object({ docType: z.enum(['PURCHASE', 'ADJUSTMENT']), docId: id, amount: z.number().int().positive() }))
        .default([]),
    }),
  ),
  'supplierPayments.refund': command<SupplierPaymentRow>()(
    z.object({
      requestId,
      supplierId: id,
      amount: z.number().int().positive('Enter an amount'),
      methodId: id,
      reference: text(60),
      reason: reasonRequired,
    }),
  ),
  'supplierPayments.reverse': command<SupplierPaymentRow>()(z.object({ id, reason: reasonRequired })),
  'supplierPayments.applyCredit': command<SupplierDetail>()(z.object({ supplierId: id, requestId })),
  'supplierPayments.list': command<Paged<SupplierPaymentRow>>()(
    z.object({
      supplierId: id.optional(),
      direction: z.enum(['ALL', 'IN', 'OUT']).default('ALL'),
      methodId: id.optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
      search: z.string().trim().max(60).optional(),
      ...pageInput,
    }),
  ),

  'payables.list': command<Paged<PayableRow>>()(
    z.object({
      supplierId: id.optional(),
      filter: z.enum(['ALL', 'OVERDUE', 'DUE_SOON', 'PARTIAL', 'UNPAID']).default('ALL'),
      search: z.string().trim().max(100).optional(),
      ...pageInput,
    }),
  ),
  'payables.ageing': command<PayablesAgeing>()(z.object({ search: z.string().trim().max(100).optional() })),
  'payables.summary': command<PayablesSummary>()(z.object({})),
};
