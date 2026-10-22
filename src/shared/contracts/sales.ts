import { z } from 'zod';
import { command, type Paged } from './define';
import { GST_STATE_CODES, isValidGstin } from '../gstStates';

// ---------- Types returned to the renderer ----------

export type InvoiceStatus = 'PAID' | 'PARTIAL' | 'UNPAID' | 'CANCELLED';

export interface CustomerRow {
  id: number;
  code: string;
  name: string;
  phone: string;
  businessName: string;
  gstin: string;
  stateCode: string;
  /** What the customer owes (positive) or has in credit (negative), from the ledger. */
  balance: number;
  overdue: number;
  isActive: boolean;
  isWalkin: boolean;
}

export interface CustomerDetail extends CustomerRow {
  address: string;
  creditDays: number | null;
  effectiveCreditDays: number;
  creditLimit: number;
  notes: string;
  /** Open amounts on invoices and opening balances. */
  outstanding: number;
  /** Unused payments, credit notes and credits that can settle future bills or be refunded. */
  availableCredit: number;
  invoiceCount: number;
  lastInvoiceDate: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface LedgerRow {
  occurredAt: string;
  businessDate: string;
  refType: string;
  refId: string;
  docNo: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface CustomerLedger {
  from: string;
  to: string;
  openingBalance: number;
  rows: LedgerRow[];
  closingBalance: number;
  totalDebit: number;
  totalCredit: number;
  truncated: boolean;
}

export interface PaymentMethodRow {
  id: number;
  name: string;
  kind: 'CASH' | 'UPI' | 'CARD' | 'BANK' | 'CHEQUE' | 'OTHER';
  isActive: boolean;
  sortOrder: number;
  version: number;
}

export interface InvoiceRow {
  id: number;
  invoiceNo: string;
  issuedAt: string;
  businessDate: string;
  dueDate: string;
  customerId: number;
  customerName: string;
  isWalkin: boolean;
  grandTotal: number;
  outstanding: number;
  status: InvoiceStatus;
  overdue: boolean;
  lineCount: number;
  username: string | null;
}

export interface InvoiceLineDetail {
  id: number;
  lineNo: number;
  productId: number | null;
  sku: string;
  name: string;
  hsnCode: string;
  unitCode: string;
  allowDecimal: boolean;
  qty: number;
  returnedQty: number;
  unitPrice: number;
  priceIncludesTax: boolean;
  gross: number;
  discount: number;
  taxable: number;
  gstRateBp: number;
  cgst: number;
  sgst: number;
  igst: number;
  lineTotal: number;
  /** Null when the user may not see costs. */
  costValue: number | null;
}

export interface SettlementRow {
  kind: 'PAYMENT' | 'CREDIT_NOTE' | 'ADJUSTMENT';
  sourceId: number;
  docNo: string;
  date: string;
  methodName: string | null;
  amount: number;
  reversed: boolean;
}

export interface CreditNoteSummary {
  id: number;
  creditNoteNo: string;
  issuedAt: string;
  total: number;
  settlement: 'CREDIT' | 'REFUND';
  reason: string;
  username: string | null;
}

export interface InvoiceDetail extends InvoiceRow {
  kind: 'SALE' | 'RENTAL';
  /** The rental agreement this bill belongs to (rental charges, or products sold with a rental). */
  rentalAgreementId: number | null;
  customerPhone: string;
  customerAddress: string;
  customerGstin: string;
  customerStateCode: string;
  shopStateCode: string;
  isInterstate: boolean;
  gstRegistered: boolean;
  grossTotal: number;
  discountTotal: number;
  taxableTotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  roundOff: number;
  costTotal: number | null;
  notes: string;
  lines: InvoiceLineDetail[];
  settlements: SettlementRow[];
  creditNotes: CreditNoteSummary[];
  cancellation: { at: string; reason: string; username: string | null } | null;
}

export interface PaymentRow {
  id: number;
  paymentNo: string;
  direction: 'IN' | 'OUT';
  purpose: string;
  customerId: number;
  customerName: string;
  amount: number;
  methodName: string;
  methodKind: PaymentMethodRow['kind'];
  reference: string;
  notes: string;
  receivedAt: string;
  businessDate: string;
  username: string | null;
  reversal: { at: string; reason: string; username: string | null } | null;
  /** Document numbers this payment settled. */
  appliedTo: { docType: string; docId: number; docNo: string; amount: number }[];
  unallocated: number;
}

export interface ReceivableRow {
  docType: 'INVOICE' | 'ADJUSTMENT';
  docId: number;
  docNo: string;
  customerId: number;
  customerName: string;
  phone: string;
  businessDate: string;
  dueDate: string;
  amount: number;
  outstanding: number;
  daysOverdue: number;
  status: 'UNPAID' | 'PARTIAL';
}

export interface AgeingRow {
  customerId: number;
  customerName: string;
  phone: string;
  /** Outstanding per ageing bucket, by days past the invoice date. Last bucket is open-ended. */
  buckets: number[];
  outstanding: number;
  credit: number;
  balance: number;
}

export interface AgeingReport {
  bucketLabels: string[];
  rows: AgeingRow[];
  totals: { buckets: number[]; outstanding: number; credit: number; balance: number };
}

export interface CartDraft {
  customerId: number | null;
  walkInName: string;
  walkInPhone: string;
  lines: { productId: number; qty: number; discount: DiscountInput }[];
  billDiscount: DiscountInput;
  notes: string;
}

export interface HeldBillRow {
  id: number;
  label: string;
  customerName: string | null;
  lineCount: number;
  createdAt: string;
  username: string | null;
  cart: CartDraft;
}

export interface SalesSummary {
  todayTotal: number;
  todayCount: number;
  monthTotal: number;
  monthCount: number;
  /** Money received today by payment method, net of refunds paid today. */
  collectedToday: { methodName: string; kind: string; amount: number }[];
}

export type DocumentKind = 'INVOICE' | 'CREDIT_NOTE' | 'RECEIPT' | 'STATEMENT' | 'RENTAL_AGREEMENT';
export type Paper = 'A4' | 'THERMAL_80' | 'THERMAL_58';

// ---------- Input schemas ----------

const id = z.number().int().positive();
const version = z.number().int().positive();
const paise = z.number().int().min(0).max(1_000_000_000_00);
const requestId = z.string().uuid();
const text = (max: number) => z.string().trim().max(max).default('');
const reasonRequired = z.string().trim().min(3, 'Please give a reason (at least 3 characters)').max(500);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const discountSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('AMOUNT'), value: paise }),
    z.object({ type: z.literal('PERCENT'), valueBp: z.number().int().min(0).max(10_000) }),
  ])
  .nullable();
export type DiscountInput = z.infer<typeof discountSchema>;

export const customerFields = z.object({
  name: z.string().trim().min(1, 'Customer name is required').max(120),
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
  creditLimit: paise.default(0),
  notes: text(1000),
});

const pageInput = {
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(5).max(200).default(50),
};

const paymentLine = z.object({ methodId: id, amount: z.number().int().positive(), reference: text(60) });

export const salesCommands = {
  'customers.list': command<Paged<CustomerRow>>()(
    z.object({
      search: z.string().trim().max(100).optional(),
      filter: z.enum(['ALL', 'OWES', 'OVERDUE', 'CREDIT']).default('ALL'),
      active: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).default('ACTIVE'),
      includeWalkin: z.boolean().default(false),
      ...pageInput,
    }),
  ),
  'customers.get': command<CustomerDetail>()(z.object({ id })),
  'customers.create': command<CustomerDetail>()(customerFields.extend({ requestId, openingBalance: z.number().int().default(0) })),
  'customers.update': command<CustomerDetail>()(customerFields.extend({ id, version, reason: z.string().trim().max(500).optional() })),
  'customers.setActive': command<CustomerDetail>()(z.object({ id, version, isActive: z.boolean(), reason: reasonRequired })),
  'customers.ledger': command<CustomerLedger>()(z.object({ id, from: isoDate.optional(), to: isoDate.optional() })),
  'customers.adjustBalance': command<CustomerDetail>()(
    z.object({
      requestId,
      customerId: id,
      kind: z.enum(['OPENING', 'ADJUSTMENT']),
      /** Positive: the customer owes more. Negative: a credit to the customer. */
      amount: z.number().int().refine((v) => v !== 0, 'Enter an amount'),
      reason: reasonRequired,
    }),
  ),

  'paymentMethods.list': command<PaymentMethodRow[]>()(z.object({ includeInactive: z.boolean().default(false) })),
  'paymentMethods.save': command<PaymentMethodRow>()(
    z.object({
      id: id.optional(),
      name: z.string().trim().min(1).max(40),
      kind: z.enum(['CASH', 'UPI', 'CARD', 'BANK', 'CHEQUE', 'OTHER']),
      isActive: z.boolean().default(true),
      sortOrder: z.number().int().min(0).max(999).default(10),
      version: version.optional(),
    }),
  ),

  'sales.finalize': command<{ invoiceId: number; invoiceNo: string; grandTotal: number; outstanding: number }>()(
    z.object({
      requestId,
      customerId: id,
      walkInName: text(120),
      walkInPhone: text(20),
      lines: z
        .array(
          z.object({
            productId: id,
            qty: z.number().int().positive(),
            discount: discountSchema.default(null),
            /** The price the cashier saw; the sale is refused if the product price has changed since. */
            expectedUnitPrice: paise,
          }),
        )
        .min(1, 'Add at least one item')
        .max(300),
      billDiscount: discountSchema.default(null),
      payments: z.array(paymentLine).max(6).default([]),
      /** Amount of the customer's existing credit to use against this bill. */
      useCredit: paise.default(0),
      notes: text(500),
      expectedGrandTotal: paise,
      /** Set only when selling more than is in stock under an authorised override. */
      negativeStockReason: z.string().trim().max(500).optional(),
    }),
  ),

  'sales.summary': command<SalesSummary>()(z.object({})),

  'invoices.list': command<Paged<InvoiceRow>>()(
    z.object({
      search: z.string().trim().max(100).optional(),
      customerId: id.optional(),
      status: z.enum(['ALL', 'PAID', 'PARTIAL', 'UNPAID', 'OPEN', 'OVERDUE', 'CANCELLED']).default('ALL'),
      from: isoDate.optional(),
      to: isoDate.optional(),
      ...pageInput,
    }),
  ),
  'invoices.get': command<InvoiceDetail>()(z.object({ id })),
  'invoices.cancel': command<InvoiceDetail>()(z.object({ id, reason: reasonRequired, requestId })),

  'creditNotes.create': command<{ creditNoteId: number; creditNoteNo: string; total: number }>()(
    z.object({
      requestId,
      invoiceId: id,
      lines: z
        .array(z.object({ invoiceLineId: id, qty: z.number().int().positive(), restock: z.boolean() }))
        .min(1, 'Choose at least one item to return'),
      reason: reasonRequired,
      settlement: z.enum(['CREDIT', 'REFUND']),
      refundMethodId: id.optional(),
    }),
  ),

  'payments.receive': command<PaymentRow>()(
    z.object({
      requestId,
      customerId: id,
      amount: z.number().int().positive('Enter an amount'),
      methodId: id,
      reference: text(60),
      notes: text(300),
      /** Specific documents to settle; when empty the oldest open amounts are settled first. */
      allocations: z
        .array(z.object({ docType: z.enum(['INVOICE', 'ADJUSTMENT']), docId: id, amount: z.number().int().positive() }))
        .default([]),
    }),
  ),
  'payments.refund': command<PaymentRow>()(
    z.object({
      requestId,
      customerId: id,
      amount: z.number().int().positive('Enter an amount'),
      methodId: id,
      reference: text(60),
      reason: reasonRequired,
    }),
  ),
  'payments.reverse': command<PaymentRow>()(z.object({ id, reason: reasonRequired })),
  'payments.get': command<PaymentRow>()(z.object({ id })),
  'payments.list': command<Paged<PaymentRow>>()(
    z.object({
      customerId: id.optional(),
      direction: z.enum(['ALL', 'IN', 'OUT']).default('ALL'),
      methodId: id.optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
      search: z.string().trim().max(60).optional(),
      ...pageInput,
    }),
  ),
  'payments.applyCredit': command<CustomerDetail>()(z.object({ customerId: id, requestId })),

  'receivables.list': command<Paged<ReceivableRow>>()(
    z.object({
      customerId: id.optional(),
      filter: z.enum(['ALL', 'OVERDUE', 'PARTIAL', 'UNPAID']).default('ALL'),
      search: z.string().trim().max(100).optional(),
      ...pageInput,
    }),
  ),
  'receivables.ageing': command<AgeingReport>()(z.object({ search: z.string().trim().max(100).optional() })),
  'receivables.summary': command<{ outstanding: number; overdue: number; customersOwing: number; credit: number }>()(z.object({})),

  'heldBills.list': command<HeldBillRow[]>()(z.object({})),
  'heldBills.save': command<HeldBillRow>()(
    z.object({
      label: z.string().trim().min(1).max(60),
      cart: z.object({
        customerId: id.nullable(),
        walkInName: text(120),
        walkInPhone: text(20),
        lines: z.array(z.object({ productId: id, qty: z.number().int().positive(), discount: discountSchema.default(null) })).max(300),
        billDiscount: discountSchema.default(null),
        notes: text(500),
      }),
    }),
  ),
  'heldBills.delete': command<null>()(z.object({ id })),

  'print.render': command<{ html: string; title: string }>()(
    z.object({
      kind: z.enum(['INVOICE', 'CREDIT_NOTE', 'RECEIPT', 'STATEMENT', 'RENTAL_AGREEMENT']),
      id,
      paper: z.enum(['A4', 'THERMAL_80', 'THERMAL_58']).default('A4'),
      from: isoDate.optional(),
      to: isoDate.optional(),
    }),
  ),
  'print.pdf': command<{ path: string } | null>()(
    z.object({
      kind: z.enum(['INVOICE', 'CREDIT_NOTE', 'RECEIPT', 'STATEMENT', 'RENTAL_AGREEMENT']),
      id,
      paper: z.enum(['A4', 'THERMAL_80', 'THERMAL_58']).default('A4'),
      from: isoDate.optional(),
      to: isoDate.optional(),
    }),
  ),
  'print.send': command<{ printed: boolean }>()(
    z.object({
      kind: z.enum(['INVOICE', 'CREDIT_NOTE', 'RECEIPT', 'STATEMENT', 'RENTAL_AGREEMENT']),
      id,
      paper: z.enum(['A4', 'THERMAL_80', 'THERMAL_58']).default('A4'),
      from: isoDate.optional(),
      to: isoDate.optional(),
    }),
  ),
};
