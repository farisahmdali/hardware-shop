import { z } from 'zod';
import { command, type Paged } from './define';
import { discountSchema } from './sales';
import { GST_RATES_BP } from '../stock';
import type { RentalPrice, RentalRate, RateUnit } from '../rentalPricing';

// ---------- Types returned to the renderer ----------

export type AssetStatus = 'AVAILABLE' | 'RESERVED' | 'RENTED' | 'AWAITING_INSPECTION' | 'DAMAGED' | 'MAINTENANCE' | 'RETIRED';
export type AssetCondition = 'NEW' | 'GOOD' | 'FAIR' | 'POOR' | 'DAMAGED';
export type RentalStatus = 'RESERVED' | 'ACTIVE' | 'PARTIALLY_RETURNED' | 'RETURNED' | 'CLOSED' | 'CANCELLED';

export interface RentalRateView extends RentalRate {
  id: number;
  displayLabel: string;
}

export interface RentalProductRow {
  id: number;
  code: string;
  name: string;
  categoryId: number | null;
  categoryName: string | null;
  brand: string;
  model: string;
  depositAmount: number;
  gstRateBp: number;
  priceIncludesTax: boolean;
  isActive: boolean;
  rates: RentalRateView[];
  unitsTotal: number;
  unitsAvailable: number;
  unitsOut: number;
  unitsUnavailable: number;
}

export interface RentalProductDetail extends RentalProductRow {
  description: string;
  sacCode: string;
  notes: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  assets: AssetRow[];
}

export interface AssetRow {
  id: number;
  assetTag: string;
  productId: number;
  productName: string;
  serialNo: string;
  /** Null when the user may not see costs. */
  purchaseCost: number | null;
  purchaseDate: string | null;
  condition: AssetCondition;
  status: AssetStatus;
  notes: string;
  version: number;
  currentRental: { agreementId: number; rentalNo: string; customerName: string; expectedReturnAt: string; overdue: boolean } | null;
  nextReservation: { agreementId: number; rentalNo: string; customerName: string; startAt: string } | null;
}

export interface AssetHistory {
  events: {
    id: number;
    event: string;
    fromStatus: string | null;
    toStatus: string | null;
    condition: string | null;
    notes: string | null;
    refType: string | null;
    refId: string | null;
    username: string | null;
    occurredAt: string;
  }[];
  rentals: { agreementId: number; rentalNo: string; customerName: string; issuedAt: string | null; returnedAt: string | null; returnCondition: string | null; status: string }[];
}

export interface QuoteItem {
  assetId: number;
  assetTag: string;
  productName: string;
  price: RentalPrice;
  depositAmount: number;
  gstRateBp: number;
  priceIncludesTax: boolean;
}

export interface BillTotals {
  grossTotal: number;
  discountTotal: number;
  taxableTotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  roundOff: number;
  grandTotal: number;
}

export interface RentalQuote {
  durationMinutes: number;
  items: QuoteItem[];
  /** What is billed now (zero for reservations and when billing happens on return). */
  billNow: BillTotals;
  depositTotal: number;
  billing: 'AT_ISSUE' | 'AT_RETURN';
  pricingMode: string;
  graceMinutes: number;
}

export interface RentalRow {
  id: number;
  rentalNo: string;
  customerId: number;
  customerName: string;
  customerPhone: string;
  status: RentalStatus;
  startAt: string;
  expectedReturnAt: string;
  itemsSummary: string;
  itemCount: number;
  outCount: number;
  overdue: boolean;
  overdueMinutes: number;
  depositHeld: number;
  /** Unpaid rental charges on this agreement's invoices. */
  outstanding: number;
  createdAt: string;
}

export interface RentalItemView {
  id: number;
  assetId: number;
  assetTag: string;
  productName: string;
  serialNo: string;
  status: 'RESERVED' | 'OUT' | 'RETURNED' | 'CANCELLED';
  conditionAtIssue: string | null;
  issuedAt: string | null;
  returnedAt: string | null;
  returnCondition: string | null;
  returnNotes: string | null;
  depositAmount: number;
  rates: RentalRate[];
}

export interface ChargeView {
  id: number;
  type: 'BASE' | 'EXTENSION' | 'LATE_FEE' | 'DAMAGE' | 'OTHER';
  itemId: number | null;
  assetTag: string | null;
  description: string;
  explanation: string;
  amount: number;
  invoiceId: number | null;
  invoiceNo: string | null;
  createdAt: string;
  username: string | null;
}

export interface DepositView {
  collected: number;
  applied: number;
  refunded: number;
  held: number;
  transactions: { id: number; type: 'COLLECT' | 'APPLY' | 'REFUND'; amount: number; methodName: string | null; reference: string; reason: string; createdAt: string; username: string | null }[];
}

export interface RentalDetail extends RentalRow {
  originalExpectedReturnAt: string;
  terms: string;
  notes: string;
  pricing: { pricingMode: string; graceMinutes: number; lateFeeMode: string; lateFeePerDay: number; lateMultiplierBp: number; billing: 'AT_ISSUE' | 'AT_RETURN' };
  linkedInvoice: { id: number; invoiceNo: string } | null;
  items: RentalItemView[];
  charges: ChargeView[];
  extensions: { id: number; previousExpected: string; newExpected: string; reason: string; invoiceNo: string | null; createdAt: string; username: string | null }[];
  deposit: DepositView;
  invoices: { id: number; invoiceNo: string; grandTotal: number; outstanding: number; issuedAt: string }[];
  issuedAt: string | null;
  closedAt: string | null;
  closedBy: string | null;
  closeNote: string | null;
  createdBy: string | null;
  version: number;
}

export interface ChargeQuoteItem {
  itemId: number;
  assetTag: string;
  productName: string;
  amount: number;
  explanation: string;
  lateMinutes?: number;
}

export interface RentalSummary {
  active: number;
  overdue: number;
  reserved: number;
  dueToday: number;
  depositsHeld: number;
  unitsOut: number;
  unitsAvailable: number;
  awaitingInspection: number;
}

// ---------- Input schemas ----------

const id = z.number().int().positive();
const version = z.number().int().positive();
const paise = z.number().int().min(0).max(1_000_000_000_00);
const requestId = z.string().uuid();
const text = (max: number) => z.string().trim().max(max).default('');
const reasonRequired = z.string().trim().min(3, 'Please give a reason (at least 3 characters)').max(500);
const isoInstant = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date and time');
const paymentLine = z.object({ methodId: id, amount: z.number().int().positive(), reference: text(60) });
const conditionSchema = z.enum(['NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED']);

export const rateInputSchema = z
  .object({
    unit: z.enum(['HOUR', 'DAY', 'WEEK', 'MONTH', 'CUSTOM']),
    /** Required for CUSTOM; ignored for standard units. */
    unitMinutes: z.number().int().min(15).max(366 * 1440).optional(),
    label: text(40),
    price: paise,
  })
  .refine((r) => r.unit !== 'CUSTOM' || !!r.unitMinutes, { message: 'A custom period needs its length', path: ['unitMinutes'] });

export const rentalProductFields = z.object({
  name: z.string().trim().min(1, 'Name is required').max(160),
  categoryId: id.nullable(),
  brand: text(80),
  model: text(80),
  description: text(1000),
  depositAmount: paise,
  sacCode: z
    .string()
    .trim()
    .regex(/^(\d{4}|\d{6}|\d{8})?$/, 'SAC/HSN must be 4, 6 or 8 digits')
    .default('997319'),
  gstRateBp: z.number().int().refine((v) => (GST_RATES_BP as readonly number[]).includes(v), 'Choose a GST rate'),
  priceIncludesTax: z.boolean(),
  notes: text(1000),
  rates: z
    .array(rateInputSchema)
    .min(1, 'Add at least one rate')
    .max(8)
    .refine((rs) => new Set(rs.filter((r) => r.unit !== 'CUSTOM').map((r) => r.unit)).size === rs.filter((r) => r.unit !== 'CUSTOM').length, 'Each standard rate unit may appear once'),
});

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const depositInput = z.object({ amount: paise, methodId: id.optional(), reference: text(60) });
const saleLine = z.object({
  productId: id,
  qty: z.number().int().positive(),
  discount: discountSchema.default(null),
  expectedUnitPrice: paise,
});

export const rentalCommands = {
  'rentalProducts.list': command<RentalProductRow[]>()(
    z.object({ search: z.string().trim().max(100).optional(), active: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).default('ACTIVE') }),
  ),
  'rentalProducts.get': command<RentalProductDetail>()(z.object({ id })),
  'rentalProducts.create': command<RentalProductDetail>()(
    rentalProductFields.extend({
      requestId,
      units: z.number().int().min(0).max(50).default(1),
      serials: z.array(z.string().trim().max(60)).max(50).default([]),
      purchaseCost: paise.default(0),
      purchaseDate: dateOnly.nullable().default(null),
    }),
  ),
  'rentalProducts.update': command<RentalProductDetail>()(rentalProductFields.extend({ id, version, reason: z.string().trim().max(500).optional() })),
  'rentalProducts.setActive': command<RentalProductDetail>()(z.object({ id, version, isActive: z.boolean(), reason: reasonRequired })),

  'rentalAssets.list': command<Paged<AssetRow>>()(
    z.object({
      productId: id.optional(),
      status: z.enum(['ALL', 'AVAILABLE', 'RENTED', 'AWAITING_INSPECTION', 'DAMAGED', 'MAINTENANCE', 'RETIRED', 'OVERDUE']).default('ALL'),
      search: z.string().trim().max(100).optional(),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(5).max(200).default(100),
    }),
  ),
  'rentalAssets.add': command<RentalProductDetail>()(
    z.object({
      requestId,
      productId: id,
      count: z.number().int().min(1).max(50),
      serials: z.array(z.string().trim().max(60)).max(50).default([]),
      purchaseCost: paise.default(0),
      purchaseDate: dateOnly.nullable().default(null),
    }),
  ),
  'rentalAssets.update': command<AssetRow>()(
    z.object({ id, version, serialNo: text(60), purchaseCost: paise, purchaseDate: dateOnly.nullable(), notes: text(1000), reason: z.string().trim().max(500).optional() }),
  ),
  'rentalAssets.setStatus': command<AssetRow>()(
    z.object({ id, version, status: z.enum(['AVAILABLE', 'DAMAGED', 'MAINTENANCE', 'RETIRED']), condition: conditionSchema, reason: reasonRequired }),
  ),
  'rentalAssets.history': command<AssetHistory>()(z.object({ id })),

  'rentals.available': command<AssetRow[]>()(z.object({ productId: id, startAt: isoInstant, endAt: isoInstant })),
  'rentals.quote': command<RentalQuote>()(
    z.object({
      customerId: id.optional(),
      assetIds: z.array(id).min(1).max(30),
      startAt: isoInstant.optional(),
      expectedReturnAt: isoInstant,
      reserve: z.boolean().default(false),
      chosenUnit: z.enum(['HOUR', 'DAY', 'WEEK', 'MONTH', 'CUSTOM']).optional(),
      discount: discountSchema.default(null),
    }),
  ),
  'rentals.create': command<{ id: number; rentalNo: string; invoiceNo: string | null; saleInvoiceNo: string | null }>()(
    z.object({
      requestId,
      customerId: id,
      assetIds: z.array(id).min(1, 'Choose at least one item').max(30),
      reserve: z.boolean().default(false),
      /** Required for reservations; issued rentals start now. */
      startAt: isoInstant.optional(),
      expectedReturnAt: isoInstant,
      chosenUnit: z.enum(['HOUR', 'DAY', 'WEEK', 'MONTH', 'CUSTOM']).optional(),
      discount: discountSchema.default(null),
      /** Grand total the user saw for the rental charges billed now; refused if different. */
      expectedChargesTotal: paise,
      deposit: depositInput,
      payments: z.array(paymentLine).max(6).default([]),
      notes: text(500),
      terms: text(2000),
      /** Products sold in the same transaction, on a linked sales invoice. */
      saleLines: z.array(saleLine).max(100).default([]),
      expectedSaleTotal: paise.default(0),
    }),
  ),
  'rentals.issueReserved': command<RentalDetail>()(
    z.object({
      requestId,
      id,
      version,
      discount: discountSchema.default(null),
      expectedChargesTotal: paise,
      deposit: depositInput,
      payments: z.array(paymentLine).max(6).default([]),
    }),
  ),
  'rentals.cancelReservation': command<RentalDetail>()(z.object({ id, version, reason: reasonRequired })),
  'rentals.extendQuote': command<{ items: ChargeQuoteItem[]; bill: BillTotals; billing: 'AT_ISSUE' | 'AT_RETURN' }>()(
    z.object({ id, newExpectedReturnAt: isoInstant }),
  ),
  'rentals.extend': command<RentalDetail>()(
    z.object({
      requestId,
      id,
      version,
      newExpectedReturnAt: isoInstant,
      reason: reasonRequired,
      payments: z.array(paymentLine).max(6).default([]),
    }),
  ),
  'rentals.returnQuote': command<{ items: ChargeQuoteItem[]; billing: 'AT_ISSUE' | 'AT_RETURN' }>()(
    z.object({ id, itemIds: z.array(id).min(1), returnedAt: isoInstant.optional() }),
  ),
  'rentals.return': command<RentalDetail>()(
    z.object({
      requestId,
      id,
      version,
      returnedAt: isoInstant.optional(),
      items: z
        .array(
          z.object({
            itemId: id,
            condition: conditionSchema,
            notes: text(500),
            nextStatus: z.enum(['AVAILABLE', 'AWAITING_INSPECTION', 'DAMAGED', 'MAINTENANCE']),
            damageCharge: paise.default(0),
            damageReason: text(300),
            /** A lower late fee than calculated (waiver); needs permission and a reason. */
            lateFeeOverride: paise.optional(),
            lateFeeReason: text(300),
          }),
        )
        .min(1, 'Choose at least one item to return'),
      payments: z.array(paymentLine).max(6).default([]),
    }),
  ),
  'rentals.settleDeposit': command<RentalDetail>()(
    z.object({
      requestId,
      id,
      applyAmount: paise.default(0),
      applyReason: text(300),
      refundAmount: paise.default(0),
      refundMethodId: id.optional(),
      refundReference: text(60),
    }),
  ),
  'rentals.close': command<RentalDetail>()(z.object({ id, version, note: text(500), acceptOutstanding: z.boolean().default(false) })),
  'rentals.list': command<Paged<RentalRow>>()(
    z.object({
      filter: z.enum(['OPEN', 'ACTIVE', 'OVERDUE', 'RESERVED', 'RETURNED', 'CLOSED', 'CANCELLED', 'ALL']).default('OPEN'),
      customerId: id.optional(),
      search: z.string().trim().max(100).optional(),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(5).max(200).default(50),
    }),
  ),
  'rentals.get': command<RentalDetail>()(z.object({ id })),
  'rentals.summary': command<RentalSummary>()(z.object({})),
};

export type { RateUnit };
