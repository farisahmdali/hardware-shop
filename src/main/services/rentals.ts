import type { Db } from '../db/connection';
import { transact, type Actor, type Tx } from '../db/tx';
import type { AppEnv } from './env';
import { allocate, applyCreditFifo } from './allocations';
import { postLedger, type AccountCode } from './ledger';
import { insertPayment, methodAccount } from './payments';
import { getAllSettings } from './settings';
import { finalizeSaleTx, reserveInvoiceId, writeInvoice, type FinalizeInput, type SalesPermissions } from './sales';
import { activeRates, changeAssetStatus } from './rentalCatalog';
import { AppError, ErrorCodes } from '@shared/errors';
import { computeBill, type Discount } from '@shared/billing';
import { formatMoney, mulDivRound } from '@shared/money';
import { formatDateTime } from '@shared/time';
import {
  lateFee,
  minutesBetween,
  priceRental,
  type PriceOptions,
  type RateUnit,
  type RentalPrice,
  type RentalRate,
} from '@shared/rentalPricing';
import type {
  AssetCondition,
  BillTotals,
  ChargeQuoteItem,
  Paged,
  RentalDetail,
  RentalQuote,
  RentalRow,
  RentalStatus,
  RentalSummary,
} from '@shared/contracts';

export interface Pricing {
  pricingMode: 'CHEAPEST' | 'CHOSEN_UNIT' | 'DAILY';
  graceMinutes: number;
  lateFeeMode: 'SAME_RATES' | 'FIXED_PER_DAY' | 'MULTIPLIER';
  lateFeePerDay: number;
  lateMultiplierBp: number;
  billing: 'AT_ISSUE' | 'AT_RETURN';
  chosenUnit?: RateUnit;
}

interface AgreementRecord {
  id: number;
  rental_no: string;
  customer_id: number;
  customer_name: string;
  customer_phone: string;
  status: RentalStatus;
  start_at: string;
  original_expected_return_at: string;
  expected_return_at: string;
  pricing_json: string;
  terms: string;
  notes: string;
  linked_invoice_id: number | null;
  created_at: string;
  created_by: number | null;
  issued_at: string | null;
  closed_at: string | null;
  closed_by: number | null;
  close_note: string | null;
  version: number;
}

interface ItemRecord {
  id: number;
  agreement_id: number;
  asset_id: number;
  rental_product_id: number;
  product_name: string;
  asset_tag: string;
  rates_json: string;
  sac_code: string;
  gst_rate_bp: number;
  price_includes_tax: number;
  deposit_amount: number;
  status: 'RESERVED' | 'OUT' | 'RETURNED' | 'CANCELLED';
  condition_at_issue: string | null;
  issued_at: string | null;
  returned_at: string | null;
  return_condition: string | null;
  return_notes: string | null;
}

interface CustomerRecord {
  id: number;
  name: string;
  phone: string;
  address: string;
  gstin: string;
  state_code: string;
  credit_days: number | null;
  is_walkin: number;
  is_active: number;
}

const ACCOUNT_FOR: Record<ChargeType, AccountCode> = {
  BASE: 'RENTAL_INCOME',
  EXTENSION: 'RENTAL_INCOME',
  OTHER: 'RENTAL_INCOME',
  LATE_FEE: 'LATE_FEE_INCOME',
  DAMAGE: 'DAMAGE_INCOME',
};
type ChargeType = 'BASE' | 'EXTENSION' | 'LATE_FEE' | 'DAMAGE' | 'OTHER';

export function currentPricing(db: Db, chosenUnit?: RateUnit): Pricing {
  const r = getAllSettings(db).rental;
  return {
    pricingMode: r.pricingMode,
    graceMinutes: r.graceMinutes,
    lateFeeMode: r.lateFeeMode,
    lateFeePerDay: r.lateFeePerDay,
    lateMultiplierBp: r.lateMultiplierBp,
    billing: r.billing,
    ...(chosenUnit ? { chosenUnit } : {}),
  };
}

const priceOpts = (p: Pricing): PriceOptions => ({ mode: p.pricingMode, graceMinutes: p.graceMinutes, chosenUnit: p.chosenUnit });
const ratesOf = (i: ItemRecord): RentalRate[] => JSON.parse(i.rates_json) as RentalRate[];
const pricingOf = (a: AgreementRecord): Pricing => JSON.parse(a.pricing_json) as Pricing;

function loadAgreement(db: Db, id: number): AgreementRecord {
  const a = db.prepare('SELECT * FROM rental_agreements WHERE id = ?').get(id) as AgreementRecord | undefined;
  if (!a) throw new AppError(ErrorCodes.NOT_FOUND, 'Rental not found.');
  return a;
}

function itemsOf(db: Db, agreementId: number): ItemRecord[] {
  return db.prepare('SELECT * FROM rental_items WHERE agreement_id = ? ORDER BY id').all(agreementId) as ItemRecord[];
}

function loadCustomer(db: Db, id: number): CustomerRecord {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as CustomerRecord | undefined;
  if (!c) throw new AppError(ErrorCodes.NOT_FOUND, 'Customer not found.');
  return c;
}

function bumpAgreement(tx: Tx, a: AgreementRecord, set: Partial<Pick<AgreementRecord, 'status' | 'start_at' | 'expected_return_at' | 'issued_at' | 'closed_at' | 'closed_by' | 'close_note' | 'linked_invoice_id'>>): void {
  const cols = Object.keys(set);
  const result = tx.db
    .prepare(`UPDATE rental_agreements SET ${cols.map((c) => `${c} = ?`).join(', ')}, version = version + 1 WHERE id = ? AND version = ?`)
    .run(...Object.values(set), a.id, a.version);
  tx.expectOneChange(result.changes, `Rental ${a.rental_no}`);
  a.version += 1;
  Object.assign(a, set);
}

function assertVersion(a: AgreementRecord, version: number): void {
  if (a.version !== version) throw new AppError(ErrorCodes.STALE_RECORD, `Rental ${a.rental_no} was changed by someone else. Reload and try again.`);
}

// ---------- Billing helpers ----------

interface ChargeDraft {
  itemId: number | null;
  type: ChargeType;
  description: string;
  price?: RentalPrice;
  explanation: string;
  amount: number;
  sku: string;
  sacCode: string;
  gstRateBp: number;
  priceIncludesTax: boolean;
  extra?: Record<string, unknown>;
}

function checkDiscount(perms: SalesPermissions, grossTotal: number, discountTotal: number): void {
  if (discountTotal <= 0) return;
  if (!perms.permissions.includes('sales.discount')) {
    throw new AppError(ErrorCodes.PERMISSION_DENIED, 'You do not have permission to give discounts.');
  }
  const limit = mulDivRound(grossTotal, perms.maxDiscountBp, 10_000);
  if (discountTotal > limit) {
    throw new AppError(ErrorCodes.BUSINESS_RULE, `The discount of ${formatMoney(discountTotal)} is above your limit of ${perms.maxDiscountBp / 100}%.`);
  }
}

function billPreview(db: Db, customer: CustomerRecord | null, drafts: Pick<ChargeDraft, 'amount' | 'gstRateBp' | 'priceIncludesTax'>[], discount: Discount | null): BillTotals {
  const s = getAllSettings(db);
  const billable = drafts.filter((d) => d.amount > 0);
  if (billable.length === 0) {
    return { grossTotal: 0, discountTotal: 0, taxableTotal: 0, cgstTotal: 0, sgstTotal: 0, igstTotal: 0, roundOff: 0, grandTotal: 0 };
  }
  const interstate = !!customer && !customer.is_walkin && customer.state_code !== '' && customer.state_code !== s.shop.stateCode;
  const b = computeBill(
    billable.map((d) => ({ unitPrice: d.amount, qty: 1000, gstRateBp: d.gstRateBp, priceIncludesTax: d.priceIncludesTax })),
    { interstate, gstRegistered: s.tax.gstRegistered, roundTotal: s.tax.roundInvoiceTotal, billDiscount: discount },
  );
  return {
    grossTotal: b.grossTotal,
    discountTotal: b.discountTotal,
    taxableTotal: b.taxableTotal,
    cgstTotal: b.cgstTotal,
    sgstTotal: b.sgstTotal,
    igstTotal: b.igstTotal,
    roundOff: b.roundOff,
    grandTotal: b.grandTotal,
  };
}

/**
 * Records the charges and bills the non-zero ones on one rental invoice. Charges and
 * invoice lines point at each other, so both ids are reserved before writing.
 */
function billCharges(
  tx: Tx,
  a: AgreementRecord,
  customer: CustomerRecord,
  drafts: ChargeDraft[],
  opts: { requestId: string; discount?: Discount | null; perms?: SalesPermissions; expectedTotal?: number; notes?: string },
): { invoiceId: number; invoiceNo: string; grandTotal: number } | null {
  const insertCharge = tx.db.prepare(
    `INSERT INTO rental_charges (id, agreement_id, item_id, type, description, calc_json, amount, invoice_id, created_at, user_id, txn_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const nextChargeId = () => (tx.db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM rental_charges').get() as { id: number }).id;
  const calc = (d: ChargeDraft) => JSON.stringify({ explanation: d.explanation, parts: d.price?.parts ?? null, ...d.extra });
  const billable = drafts.filter((d) => d.amount > 0);

  if (billable.length === 0) {
    for (const d of drafts) insertCharge.run(nextChargeId(), a.id, d.itemId, d.type, d.description, calc(d), d.amount, null, tx.nowIso, tx.actor.userId, tx.txnRef);
    if (opts.expectedTotal !== undefined && opts.expectedTotal !== 0) {
      throw new AppError(ErrorCodes.CONFLICT, 'Nothing is billed now, but a bill total was expected. Review and try again.');
    }
    return null;
  }

  const preview = billPreview(tx.db, customer, billable, opts.discount ?? null);
  if (opts.discount) checkDiscount(opts.perms ?? { permissions: [], maxDiscountBp: 0 }, preview.grossTotal, preview.discountTotal);
  if (opts.expectedTotal !== undefined && opts.expectedTotal !== preview.grandTotal) {
    throw new AppError(
      ErrorCodes.CONFLICT,
      `The rental charges come to ${formatMoney(preview.grandTotal)}, not ${formatMoney(opts.expectedTotal)}. Review and try again.`,
    );
  }

  const invoiceId = reserveInvoiceId(tx);
  const firstCharge = nextChargeId();
  const chargeIds = billable.map((_, i) => firstCharge + i);
  const { invoiceNo, bill } = writeInvoice(tx, {
    id: invoiceId,
    kind: 'RENTAL',
    requestId: opts.requestId,
    customer,
    billDiscount: opts.discount ?? null,
    notes: opts.notes ?? `Rental ${a.rental_no}`,
    rentalAgreementId: a.id,
    lines: billable.map((d, i) => ({
      lineKind: 'RENTAL_CHARGE' as const,
      productId: null,
      rentalChargeId: chargeIds[i],
      sku: d.sku,
      name: d.description,
      hsnCode: d.sacCode,
      unitCode: 'NOS',
      qty: 1000,
      unitPrice: d.amount,
      priceIncludesTax: d.priceIncludesTax,
      gstRateBp: d.gstRateBp,
      discount: null,
      revenueAccount: ACCOUNT_FOR[d.type],
    })),
  });
  billable.forEach((d, i) =>
    insertCharge.run(chargeIds[i], a.id, d.itemId, d.type, d.description, calc(d), d.amount, invoiceId, tx.nowIso, tx.actor.userId, tx.txnRef),
  );
  // Zero charges (e.g. a waived late fee) are kept for the record without an invoice line.
  for (const d of drafts.filter((x) => x.amount <= 0)) {
    insertCharge.run(nextChargeId(), a.id, d.itemId, d.type, d.description, calc(d), 0, null, tx.nowIso, tx.actor.userId, tx.txnRef);
  }
  return { invoiceId, invoiceNo, grandTotal: bill.grandTotal };
}

/** Records payments and applies them to the given invoices in order; anything left settles the oldest open bills. */
function payTowards(
  tx: Tx,
  customerId: number,
  payments: { methodId: number; amount: number; reference: string }[],
  invoiceIds: number[],
  requestId: string,
  note: string,
): number {
  if (payments.length === 0) return 0;
  const outstanding = (id: number) =>
    (tx.db.prepare('SELECT outstanding FROM v_invoice_balances WHERE invoice_id = ?').get(id) as { outstanding: number }).outstanding;
  const due = invoiceIds.reduce((a, id) => a + outstanding(id), 0);
  const total = payments.reduce((a, p) => a + p.amount, 0);
  if (total > due) throw new AppError(ErrorCodes.VALIDATION, `The payments (${formatMoney(total)}) are more than the ${formatMoney(due)} due.`);
  payments.forEach((p, i) => {
    const paymentId = insertPayment(tx, {
      requestId: `${requestId}:pay${i}`,
      direction: 'IN',
      purpose: 'RECEIPT',
      customerId,
      amount: p.amount,
      methodId: p.methodId,
      reference: p.reference,
      notes: note,
    });
    let left = p.amount;
    for (const id of invoiceIds) {
      const take = Math.min(left, outstanding(id));
      if (take > 0) {
        allocate(tx, { type: 'PAYMENT', id: paymentId }, { type: 'INVOICE', id }, take);
        left -= take;
      }
    }
    if (left > 0) applyCreditFifo(tx, customerId, { onlySource: { type: 'PAYMENT', id: paymentId } });
  });
  return total;
}

/** Security deposit movements. A deposit is a liability to the customer, never income. */
function depositEntry(
  tx: Tx,
  a: AgreementRecord,
  e: { type: 'COLLECT' | 'REFUND' | 'APPLY'; amount: number; methodId?: number; reference?: string; reason: string },
): number {
  if (e.amount <= 0) return 0;
  const method = e.type === 'APPLY' ? null : methodAccount(tx.db, e.methodId ?? 0);
  const id = Number(
    tx.db
      .prepare(
        `INSERT INTO deposit_transactions (agreement_id, customer_id, type, amount, method_id, reference_no, reason, created_at, business_date, user_id, txn_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.id, a.customer_id, e.type, e.amount, e.type === 'APPLY' ? null : e.methodId, e.reference ?? '', e.reason, tx.nowIso, tx.businessDate, tx.actor.userId, tx.txnRef)
      .lastInsertRowid,
  );
  const party = { partyType: 'CUSTOMER' as const, partyId: a.customer_id };
  const lines =
    e.type === 'COLLECT'
      ? [
          { account: method!.code, debit: e.amount },
          { account: 'DEPOSIT_LIABILITY' as const, credit: e.amount, ...party },
        ]
      : e.type === 'REFUND'
        ? [
            { account: 'DEPOSIT_LIABILITY' as const, debit: e.amount, ...party },
            { account: method!.code, credit: e.amount },
          ]
        : [
            { account: 'DEPOSIT_LIABILITY' as const, debit: e.amount, ...party },
            { account: 'AR' as const, credit: e.amount, ...party },
          ];
  postLedger(tx, { refType: `DEPOSIT_${e.type}`, refId: id, memo: `Deposit ${e.type.toLowerCase()} for ${a.rental_no}: ${e.reason}`, lines });
  return id;
}

function depositHeld(db: Db, agreementId: number): number {
  return (db.prepare('SELECT held FROM v_deposit_balances WHERE agreement_id = ?').get(agreementId) as { held: number } | undefined)?.held ?? 0;
}

function rentalInvoiceIds(db: Db, agreementId: number): number[] {
  return (db.prepare("SELECT id FROM invoices WHERE rental_agreement_id = ? AND kind = 'RENTAL' ORDER BY id").all(agreementId) as { id: number }[]).map((r) => r.id);
}

function rentalOutstanding(db: Db, agreementId: number): number {
  return (
    db
      .prepare(
        `SELECT COALESCE(SUM(b.outstanding), 0) AS n FROM v_invoice_balances b JOIN invoices i ON i.id = b.invoice_id
         WHERE i.rental_agreement_id = ? AND i.kind = 'RENTAL'`,
      )
      .get(agreementId) as { n: number }
  ).n;
}

// ---------- Availability ----------

interface AssetForRental {
  id: number;
  asset_tag: string;
  status: string;
  condition: AssetCondition;
  rental_product_id: number;
  product_name: string;
  product_active: number;
  deposit_amount: number;
  sac_code: string;
  gst_rate_bp: number;
  price_includes_tax: number;
}

function loadAssets(db: Db, ids: number[]): AssetForRental[] {
  if (new Set(ids).size !== ids.length) throw new AppError(ErrorCodes.VALIDATION, 'The same unit was chosen twice.');
  const stmt = db.prepare(
    `SELECT a.id, a.asset_tag, a.status, a.condition, a.rental_product_id, p.name AS product_name, p.is_active AS product_active,
            p.deposit_amount, p.sac_code, p.gst_rate_bp, p.price_includes_tax
     FROM rental_assets a JOIN rental_products p ON p.id = a.rental_product_id WHERE a.id = ?`,
  );
  return ids.map((id) => {
    const a = stmt.get(id) as AssetForRental | undefined;
    if (!a) throw new AppError(ErrorCodes.NOT_FOUND, 'A chosen rental unit no longer exists.');
    return a;
  });
}

/** Refuses a unit that is booked for any part of [start, end), or is still out past its due time. */
function assertFree(db: Db, assetId: number, assetTag: string, start: string, end: string, nowIso: string, exceptItemId?: number): void {
  const clash = db
    .prepare(
      `SELECT ra.rental_no, ra.customer_name, b.start_at, b.end_at, i.status FROM asset_bookings b
       JOIN rental_items i ON i.id = b.rental_item_id JOIN rental_agreements ra ON ra.id = i.agreement_id
       WHERE b.asset_id = ? AND b.released_at IS NULL AND b.rental_item_id != ?
         AND b.start_at < ? AND (b.end_at > ? OR (i.status = 'OUT' AND ? > b.end_at))
       LIMIT 1`,
    )
    .get(assetId, exceptItemId ?? -1, end, start, nowIso) as
    | { rental_no: string; customer_name: string; start_at: string; end_at: string; status: string }
    | undefined;
  if (clash) {
    throw new AppError(
      ErrorCodes.BUSINESS_RULE,
      clash.status === 'OUT' && nowIso > clash.end_at
        ? `${assetTag} is still out with ${clash.customer_name} (${clash.rental_no}), overdue since ${formatDateTime(clash.end_at)}.`
        : `${assetTag} is booked by ${clash.customer_name} (${clash.rental_no}) from ${formatDateTime(clash.start_at)} to ${formatDateTime(clash.end_at)}.`,
    );
  }
}

export function availableAssets(db: Db, productId: number, start: string, end: string, nowIso: string): number[] {
  const assets = db
    .prepare("SELECT id, asset_tag, status FROM rental_assets WHERE rental_product_id = ? AND status NOT IN ('RETIRED') ORDER BY asset_tag")
    .all(productId) as { id: number; asset_tag: string; status: string }[];
  const issuingNow = start <= nowIso;
  return assets
    .filter((a) => {
      if (issuingNow && a.status !== 'AVAILABLE') return false;
      try {
        assertFree(db, a.id, a.asset_tag, start, end, nowIso);
        return true;
      } catch {
        return false;
      }
    })
    .map((a) => a.id);
}

// ---------- Quotes ----------

function baseCharges(assets: AssetForRental[], rates: Map<number, RentalRate[]>, minutes: number, pricing: Pricing): ChargeDraft[] {
  return assets.map((a) => {
    const price = priceRental(rates.get(a.rental_product_id)!, minutes, priceOpts(pricing));
    return {
      itemId: null,
      type: 'BASE',
      description: `${a.product_name} (${a.asset_tag}) — rental`,
      price,
      explanation: price.explanation,
      amount: price.total,
      sku: a.asset_tag,
      sacCode: a.sac_code,
      gstRateBp: a.gst_rate_bp,
      priceIncludesTax: a.price_includes_tax === 1,
    };
  });
}

function ratesFor(db: Db, assets: AssetForRental[]): Map<number, RentalRate[]> {
  const m = new Map<number, RentalRate[]>();
  for (const a of assets) {
    if (!m.has(a.rental_product_id)) {
      const rates = activeRates(db, a.rental_product_id).map(({ unit, unitMinutes, price, label }) => ({ unit, unitMinutes, price, label }));
      if (rates.length === 0) throw new AppError(ErrorCodes.BUSINESS_RULE, `${a.product_name} has no rental rates.`);
      m.set(a.rental_product_id, rates);
    }
  }
  return m;
}

export function quoteRental(
  db: Db,
  input: { customerId?: number; assetIds: number[]; startAt?: string; expectedReturnAt: string; reserve: boolean; chosenUnit?: RateUnit; discount: Discount | null },
  nowIso: string,
): RentalQuote {
  const pricing = currentPricing(db, input.chosenUnit);
  const start = input.reserve && input.startAt ? new Date(input.startAt).toISOString() : nowIso;
  const end = new Date(input.expectedReturnAt).toISOString();
  if (end <= start) throw new AppError(ErrorCodes.VALIDATION, 'The return time must be after the start time.');
  const assets = loadAssets(db, input.assetIds);
  const rates = ratesFor(db, assets);
  const minutes = minutesBetween(start, end);
  const drafts = baseCharges(assets, rates, minutes, pricing);
  const customer = input.customerId ? loadCustomer(db, input.customerId) : null;
  const billNowDrafts = input.reserve || pricing.billing === 'AT_RETURN' ? [] : drafts;
  return {
    durationMinutes: minutes,
    items: assets.map((a, i) => ({
      assetId: a.id,
      assetTag: a.asset_tag,
      productName: a.product_name,
      price: drafts[i]!.price!,
      depositAmount: a.deposit_amount,
      gstRateBp: a.gst_rate_bp,
      priceIncludesTax: a.price_includes_tax === 1,
    })),
    billNow: billPreview(db, customer, billNowDrafts, input.discount),
    depositTotal: assets.reduce((s, a) => s + a.deposit_amount, 0),
    billing: pricing.billing,
    pricingMode: pricing.pricingMode,
    graceMinutes: pricing.graceMinutes,
  };
}

// ---------- Create / issue ----------

export interface CreateRentalInput {
  requestId: string;
  customerId: number;
  assetIds: number[];
  reserve: boolean;
  startAt?: string;
  expectedReturnAt: string;
  chosenUnit?: RateUnit;
  discount: Discount | null;
  expectedChargesTotal: number;
  deposit: { amount: number; methodId?: number; reference: string };
  payments: { methodId: number; amount: number; reference: string }[];
  notes: string;
  terms: string;
  saleLines: { productId: number; qty: number; discount: Discount | null; expectedUnitPrice: number }[];
  expectedSaleTotal: number;
}

/** Puts reserved units in the customer's hands: asset status, billing (if billed at issue), deposit and payments. */
function issueItems(
  tx: Tx,
  a: AgreementRecord,
  customer: CustomerRecord,
  perms: SalesPermissions,
  input: { requestId: string; discount: Discount | null; expectedChargesTotal: number; deposit: { amount: number; methodId?: number; reference: string }; payments: CreateRentalInput['payments'] },
  extraInvoiceIds: number[] = [],
): { invoiceNo: string | null } {
  const pricing = pricingOf(a);
  const items = itemsOf(tx.db, a.id).filter((i) => i.status === 'RESERVED');
  for (const i of items) {
    const asset = tx.db.prepare('SELECT status, condition FROM rental_assets WHERE id = ?').get(i.asset_id) as { status: string; condition: AssetCondition };
    if (asset.status !== 'AVAILABLE') {
      throw new AppError(ErrorCodes.BUSINESS_RULE, `${i.asset_tag} cannot be issued: it is ${asset.status.toLowerCase().replace(/_/g, ' ')}.`);
    }
    tx.db
      .prepare("UPDATE rental_items SET status = 'OUT', issued_at = ?, condition_at_issue = ? WHERE id = ?")
      .run(tx.nowIso, asset.condition, i.id);
    changeAssetStatus(tx, i.asset_id, 'RENTED', { event: 'ISSUED', notes: `${a.rental_no} to ${a.customer_name}`, refType: 'RENTAL', refId: a.id });
  }

  let invoice: { invoiceId: number; invoiceNo: string } | null = null;
  if (pricing.billing === 'AT_ISSUE') {
    const minutes = minutesBetween(a.start_at, a.expected_return_at);
    const drafts: ChargeDraft[] = items.map((i) => {
      const price = priceRental(ratesOf(i), minutes, priceOpts(pricing));
      return {
        itemId: i.id,
        type: 'BASE',
        description: `${i.product_name} (${i.asset_tag}) — rental`,
        price,
        explanation: price.explanation,
        amount: price.total,
        sku: i.asset_tag,
        sacCode: i.sac_code,
        gstRateBp: i.gst_rate_bp,
        priceIncludesTax: i.price_includes_tax === 1,
      };
    });
    invoice = billCharges(tx, a, customer, drafts, {
      requestId: `${input.requestId}:rent`,
      discount: input.discount,
      perms,
      expectedTotal: input.expectedChargesTotal,
      notes: `Rental ${a.rental_no}: ${formatDateTime(a.start_at)} to ${formatDateTime(a.expected_return_at)}`,
    });
  } else if (input.expectedChargesTotal !== 0) {
    throw new AppError(ErrorCodes.CONFLICT, 'Rental charges are billed on return, so nothing is due now. Review and try again.');
  }

  if (input.deposit.amount > 0) {
    if (!input.deposit.methodId) throw new AppError(ErrorCodes.VALIDATION, 'Choose how the deposit is paid.');
    depositEntry(tx, a, { type: 'COLLECT', amount: input.deposit.amount, methodId: input.deposit.methodId, reference: input.deposit.reference, reason: 'Security deposit at issue' });
  }
  payTowards(tx, a.customer_id, input.payments, [...extraInvoiceIds, ...(invoice ? [invoice.invoiceId] : [])], input.requestId, `Paid for rental ${a.rental_no}`);
  return { invoiceNo: invoice?.invoiceNo ?? null };
}

export function createRental(env: AppEnv, actor: Actor, perms: SalesPermissions, input: CreateRentalInput) {
  return transact(env, actor, (tx) =>
    tx.once(input.requestId, 'rentals.create', () => {
      const customer = loadCustomer(tx.db, input.customerId);
      if (customer.is_walkin) throw new AppError(ErrorCodes.BUSINESS_RULE, 'Rentals need a registered customer, so the shop can contact them and track the items.');
      if (!customer.is_active) throw new AppError(ErrorCodes.BUSINESS_RULE, `${customer.name} is inactive.`);

      const start = input.reserve ? new Date(input.startAt ?? '').toISOString() : tx.nowIso;
      if (input.reserve && (!input.startAt || start <= tx.nowIso)) {
        throw new AppError(ErrorCodes.VALIDATION, 'A reservation needs a future start time. To hand items over now, issue the rental instead.');
      }
      const end = new Date(input.expectedReturnAt).toISOString();
      if (end <= start) throw new AppError(ErrorCodes.VALIDATION, 'The return time must be after the start time.');

      const assets = loadAssets(tx.db, input.assetIds);
      const rates = ratesFor(tx.db, assets);
      for (const a of assets) {
        if (!a.product_active) throw new AppError(ErrorCodes.BUSINESS_RULE, `${a.product_name} is no longer offered for rent.`);
        if (a.status === 'RETIRED') throw new AppError(ErrorCodes.BUSINESS_RULE, `${a.asset_tag} has been retired.`);
        if (!input.reserve && a.status !== 'AVAILABLE') {
          throw new AppError(ErrorCodes.BUSINESS_RULE, `${a.asset_tag} is not available: it is ${a.status.toLowerCase().replace(/_/g, ' ')}.`);
        }
        assertFree(tx.db, a.id, a.asset_tag, start, end, tx.nowIso);
      }

      const pricing = currentPricing(tx.db, input.chosenUnit);
      const rentalNo = tx.nextDocNumber('RENTAL');
      const settings = getAllSettings(tx.db);
      const agreementId = Number(
        tx.db
          .prepare(
            `INSERT INTO rental_agreements (rental_no, client_request_id, customer_id, customer_name, customer_phone, status, start_at,
               original_expected_return_at, expected_return_at, pricing_json, terms, notes, created_at, created_by, issued_at)
             VALUES (?, ?, ?, ?, ?, 'RESERVED', ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            rentalNo,
            input.requestId,
            customer.id,
            customer.name,
            customer.phone,
            start,
            end,
            end,
            JSON.stringify(pricing),
            input.terms || settings.rental.terms,
            input.notes,
            tx.nowIso,
            tx.actor.userId,
          ).lastInsertRowid,
      );
      const insertItem = tx.db.prepare(
        `INSERT INTO rental_items (agreement_id, asset_id, rental_product_id, product_name, asset_tag, rates_json, sac_code, gst_rate_bp,
           price_includes_tax, deposit_amount, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RESERVED')`,
      );
      const insertBooking = tx.db.prepare('INSERT INTO asset_bookings (asset_id, rental_item_id, start_at, end_at) VALUES (?, ?, ?, ?)');
      for (const a of assets) {
        const itemId = Number(
          insertItem.run(
            agreementId,
            a.id,
            a.rental_product_id,
            a.product_name,
            a.asset_tag,
            JSON.stringify(rates.get(a.rental_product_id)),
            a.sac_code,
            a.gst_rate_bp,
            a.price_includes_tax,
            a.deposit_amount,
          ).lastInsertRowid,
        );
        insertBooking.run(a.id, itemId, start, end);
      }
      const agreement = loadAgreement(tx.db, agreementId);

      // Products sold in the same visit go on a linked sales invoice; the rental's payments cover both.
      let sale: { invoiceId: number; invoiceNo: string } | null = null;
      if (input.saleLines.length > 0) {
        if (input.reserve) throw new AppError(ErrorCodes.BUSINESS_RULE, 'Products can be sold with a rental when it is issued, not when it is reserved.');
        const saleInput: FinalizeInput = {
          requestId: `${input.requestId}:sale`,
          customerId: customer.id,
          walkInName: '',
          walkInPhone: '',
          lines: input.saleLines,
          billDiscount: null,
          payments: [],
          useCredit: 0,
          notes: `Sold with rental ${rentalNo}`,
          expectedGrandTotal: input.expectedSaleTotal,
        };
        sale = finalizeSaleTx(tx, perms, saleInput, { linkedRentalId: agreementId });
        bumpAgreement(tx, agreement, { linked_invoice_id: sale.invoiceId });
      }

      let invoiceNo: string | null = null;
      if (input.reserve) {
        if (input.payments.length > 0 || input.deposit.amount > 0 || input.expectedChargesTotal !== 0) {
          throw new AppError(ErrorCodes.BUSINESS_RULE, 'Charges and the deposit are taken when a reservation is issued.');
        }
        for (const a of assets) {
          tx.db
            .prepare('INSERT INTO asset_events (asset_id, event, notes, ref_type, ref_id, user_id, occurred_at, txn_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(a.id, 'RESERVED', `${rentalNo} for ${customer.name} from ${formatDateTime(start)}`, 'RENTAL', String(agreementId), tx.actor.userId, tx.nowIso, tx.txnRef);
        }
      } else {
        bumpAgreement(tx, agreement, { status: 'ACTIVE', issued_at: tx.nowIso });
        invoiceNo = issueItems(tx, agreement, customer, perms, input, sale ? [sale.invoiceId] : []).invoiceNo;
      }

      tx.audit({
        module: 'rentals',
        entityType: 'rental',
        entityId: agreementId,
        action: input.reserve ? 'RESERVE' : 'ISSUE',
        after: {
          rentalNo,
          customer: customer.name,
          units: assets.map((a) => a.asset_tag),
          startAt: start,
          expectedReturnAt: end,
          pricingMode: pricing.pricingMode,
          billing: pricing.billing,
          depositAmount: input.deposit.amount,
          rentalInvoice: invoiceNo,
          saleInvoice: sale?.invoiceNo ?? null,
        },
      });
      return { id: agreementId, rentalNo, invoiceNo, saleInvoiceNo: sale?.invoiceNo ?? null };
    }),
  );
}

export function issueReserved(
  env: AppEnv,
  actor: Actor,
  perms: SalesPermissions,
  input: { requestId: string; id: number; version: number; discount: Discount | null; expectedChargesTotal: number; deposit: CreateRentalInput['deposit']; payments: CreateRentalInput['payments'] },
): void {
  transact(env, actor, (tx) =>
    tx.once(input.requestId, 'rentals.issueReserved', () => {
      const a = loadAgreement(tx.db, input.id);
      assertVersion(a, input.version);
      if (a.status !== 'RESERVED') throw new AppError(ErrorCodes.BUSINESS_RULE, `${a.rental_no} is not a reservation.`);
      if (a.expected_return_at <= tx.nowIso) {
        throw new AppError(ErrorCodes.BUSINESS_RULE, 'The reserved return time has passed. Cancel this reservation and make a new rental.');
      }
      // The rental runs from the moment it is handed over.
      for (const i of itemsOf(tx.db, a.id)) {
        assertFree(tx.db, i.asset_id, i.asset_tag, tx.nowIso, a.expected_return_at, tx.nowIso, i.id);
        tx.db.prepare('UPDATE asset_bookings SET start_at = ? WHERE rental_item_id = ?').run(tx.nowIso, i.id);
      }
      bumpAgreement(tx, a, { status: 'ACTIVE', start_at: tx.nowIso, issued_at: tx.nowIso });
      const { invoiceNo } = issueItems(tx, a, loadCustomer(tx.db, a.customer_id), perms, input);
      tx.audit({ module: 'rentals', entityType: 'rental', entityId: a.id, action: 'ISSUE', after: { rentalNo: a.rental_no, fromReservation: true, rentalInvoice: invoiceNo, depositAmount: input.deposit.amount } });
      return a.id;
    }),
  );
}

export function cancelReservation(env: AppEnv, actor: Actor, input: { id: number; version: number; reason: string }): void {
  transact(env, actor, (tx) => {
    const a = loadAgreement(tx.db, input.id);
    assertVersion(a, input.version);
    if (a.status !== 'RESERVED') throw new AppError(ErrorCodes.BUSINESS_RULE, 'Only reservations can be cancelled. Items already out are returned instead.');
    for (const i of itemsOf(tx.db, a.id)) {
      tx.db.prepare("UPDATE rental_items SET status = 'CANCELLED' WHERE id = ?").run(i.id);
      tx.db.prepare('UPDATE asset_bookings SET released_at = ? WHERE rental_item_id = ?').run(tx.nowIso, i.id);
      tx.db
        .prepare('INSERT INTO asset_events (asset_id, event, notes, ref_type, ref_id, user_id, occurred_at, txn_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(i.asset_id, 'RESERVATION_CANCELLED', `${a.rental_no}: ${input.reason}`, 'RENTAL', String(a.id), tx.actor.userId, tx.nowIso, tx.txnRef);
    }
    bumpAgreement(tx, a, { status: 'CANCELLED', closed_at: tx.nowIso, closed_by: tx.actor.userId, close_note: input.reason });
    tx.audit({ module: 'rentals', entityType: 'rental', entityId: a.id, action: 'CANCEL', before: { status: 'RESERVED' }, after: { status: 'CANCELLED' }, reason: input.reason });
  });
}

// ---------- Extensions ----------

function extensionDrafts(a: AgreementRecord, items: ItemRecord[], newEnd: string): ChargeDraft[] {
  const pricing = pricingOf(a);
  const oldMinutes = minutesBetween(a.start_at, a.expected_return_at);
  const newMinutes = minutesBetween(a.start_at, newEnd);
  return items.map((i) => {
    const before = priceRental(ratesOf(i), oldMinutes, { ...priceOpts(pricing), graceMinutes: 0 });
    const after = priceRental(ratesOf(i), newMinutes, { ...priceOpts(pricing), graceMinutes: 0 });
    const amount = Math.max(0, after.total - before.total);
    return {
      itemId: i.id,
      type: 'EXTENSION' as const,
      description: `${i.product_name} (${i.asset_tag}) — extension to ${formatDateTime(newEnd)}`,
      price: after,
      explanation: `New period ${after.explanation}, less ${formatMoney(before.total)} already charged`,
      amount,
      sku: i.asset_tag,
      sacCode: i.sac_code,
      gstRateBp: i.gst_rate_bp,
      priceIncludesTax: i.price_includes_tax === 1,
    };
  });
}

export function quoteExtension(db: Db, id: number, newExpectedReturnAt: string) {
  const a = loadAgreement(db, id);
  const newEnd = new Date(newExpectedReturnAt).toISOString();
  if (newEnd <= a.expected_return_at) throw new AppError(ErrorCodes.VALIDATION, 'The new return time must be later than the current one.');
  const out = itemsOf(db, id).filter((i) => i.status === 'OUT');
  const pricing = pricingOf(a);
  const drafts = pricing.billing === 'AT_ISSUE' ? extensionDrafts(a, out, newEnd) : [];
  return {
    items: drafts.map((d, i) => ({ itemId: out[i]!.id, assetTag: out[i]!.asset_tag, productName: out[i]!.product_name, amount: d.amount, explanation: d.explanation })),
    bill: billPreview(db, loadCustomer(db, a.customer_id), drafts, null),
    billing: pricing.billing,
  };
}

export function extendRental(
  env: AppEnv,
  actor: Actor,
  input: { requestId: string; id: number; version: number; newExpectedReturnAt: string; reason: string; payments: CreateRentalInput['payments'] },
): void {
  transact(env, actor, (tx) =>
    tx.once(input.requestId, 'rentals.extend', () => {
      const a = loadAgreement(tx.db, input.id);
      assertVersion(a, input.version);
      if (a.status !== 'ACTIVE' && a.status !== 'PARTIALLY_RETURNED') throw new AppError(ErrorCodes.BUSINESS_RULE, 'Only rentals that are out can be extended.');
      const newEnd = new Date(input.newExpectedReturnAt).toISOString();
      if (newEnd <= a.expected_return_at) throw new AppError(ErrorCodes.VALIDATION, 'The new return time must be later than the current one.');
      const out = itemsOf(tx.db, a.id).filter((i) => i.status === 'OUT');
      for (const i of out) {
        assertFree(tx.db, i.asset_id, i.asset_tag, a.expected_return_at, newEnd, tx.nowIso, i.id);
        tx.db.prepare('UPDATE asset_bookings SET end_at = ? WHERE rental_item_id = ?').run(newEnd, i.id);
      }
      const customer = loadCustomer(tx.db, a.customer_id);
      const previous = a.expected_return_at;
      const invoice =
        pricingOf(a).billing === 'AT_ISSUE'
          ? billCharges(tx, a, customer, extensionDrafts(a, out, newEnd), { requestId: `${input.requestId}:ext`, notes: `Extension of ${a.rental_no}: ${input.reason}` })
          : null;
      tx.db
        .prepare('INSERT INTO rental_extensions (agreement_id, previous_expected, new_expected, reason, invoice_id, created_at, user_id, txn_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(a.id, previous, newEnd, input.reason, invoice?.invoiceId ?? null, tx.nowIso, tx.actor.userId, tx.txnRef);
      bumpAgreement(tx, a, { expected_return_at: newEnd });
      payTowards(tx, a.customer_id, input.payments, invoice ? [invoice.invoiceId] : [], input.requestId, `Paid for extension of ${a.rental_no}`);
      tx.audit({
        module: 'rentals',
        entityType: 'rental',
        entityId: a.id,
        action: 'EXTEND',
        before: { expectedReturnAt: previous },
        after: { expectedReturnAt: newEnd, invoice: invoice?.invoiceNo ?? null, extraAmount: invoice?.grandTotal ?? 0 },
        reason: input.reason,
      });
      return a.id;
    }),
  );
}

// ---------- Returns ----------

function returnTimeOf(input: string | undefined, nowIso: string, startIso: string): string {
  const t = input ? new Date(input).toISOString() : nowIso;
  if (t > new Date(Date.parse(nowIso) + 60_000).toISOString()) throw new AppError(ErrorCodes.VALIDATION, 'The return time cannot be in the future.');
  if (t < startIso) throw new AppError(ErrorCodes.VALIDATION, 'The return time cannot be before the rental started.');
  return t;
}

/** Late fee (and, when billed on return, the rental itself) for each item being returned. */
function returnDrafts(a: AgreementRecord, items: ItemRecord[], returnedAt: string): { late: ChargeDraft[]; base: ChargeDraft[]; lateMinutes: number[] } {
  const pricing = pricingOf(a);
  const billed = minutesBetween(a.start_at, a.expected_return_at);
  const actual = minutesBetween(a.start_at, returnedAt);
  const late: ChargeDraft[] = [];
  const base: ChargeDraft[] = [];
  const lateMinutes: number[] = [];
  for (const i of items) {
    const rates = ratesOf(i);
    const fee = lateFee(rates, billed, actual, { ...priceOpts(pricing), lateFeeMode: pricing.lateFeeMode, lateFeePerDay: pricing.lateFeePerDay, lateMultiplierBp: pricing.lateMultiplierBp });
    lateMinutes.push(fee.lateMinutes);
    const common = { itemId: i.id, sku: i.asset_tag, sacCode: i.sac_code, gstRateBp: i.gst_rate_bp, priceIncludesTax: i.price_includes_tax === 1 };
    late.push({ ...common, type: 'LATE_FEE', description: `${i.product_name} (${i.asset_tag}) — late return`, explanation: fee.explanation, amount: fee.amount, extra: { lateMinutes: fee.lateMinutes } });
    if (pricing.billing === 'AT_RETURN') {
      const price = priceRental(rates, Math.min(actual, billed), priceOpts(pricing));
      base.push({ ...common, type: 'BASE', description: `${i.product_name} (${i.asset_tag}) — rental`, price, explanation: price.explanation, amount: price.total });
    }
  }
  return { late, base, lateMinutes };
}

export function quoteReturn(db: Db, id: number, itemIds: number[], returnedAtInput: string | undefined, nowIso: string) {
  const a = loadAgreement(db, id);
  const items = itemsOf(db, id).filter((i) => itemIds.includes(i.id) && i.status === 'OUT');
  const returnedAt = returnTimeOf(returnedAtInput, nowIso, a.start_at);
  const d = returnDrafts(a, items, returnedAt);
  return {
    items: items.map((i, k) => ({
      itemId: i.id,
      assetTag: i.asset_tag,
      productName: i.product_name,
      amount: d.late[k]!.amount + (d.base[k]?.amount ?? 0),
      explanation: [d.base[k]?.explanation && `Rental: ${d.base[k]!.explanation}`, d.late[k]!.amount > 0 ? `Late: ${d.late[k]!.explanation}` : d.late[k]!.explanation]
        .filter(Boolean)
        .join(' · '),
      lateMinutes: d.lateMinutes[k],
    })),
    billing: pricingOf(a).billing,
  };
}

export interface ReturnItemInput {
  itemId: number;
  condition: AssetCondition;
  notes: string;
  nextStatus: 'AVAILABLE' | 'AWAITING_INSPECTION' | 'DAMAGED' | 'MAINTENANCE';
  damageCharge: number;
  damageReason: string;
  lateFeeOverride?: number;
  lateFeeReason: string;
}

export function returnItems(
  env: AppEnv,
  actor: Actor,
  perms: SalesPermissions,
  input: { requestId: string; id: number; version: number; returnedAt?: string; items: ReturnItemInput[]; payments: CreateRentalInput['payments'] },
): void {
  transact(env, actor, (tx) =>
    tx.once(input.requestId, 'rentals.return', () => {
      const a = loadAgreement(tx.db, input.id);
      assertVersion(a, input.version);
      if (a.status !== 'ACTIVE' && a.status !== 'PARTIALLY_RETURNED') throw new AppError(ErrorCodes.BUSINESS_RULE, `${a.rental_no} has no items out.`);
      const returnedAt = returnTimeOf(input.returnedAt, tx.nowIso, a.start_at);
      const all = itemsOf(tx.db, a.id);
      const chosen = input.items.map((r) => {
        const item = all.find((i) => i.id === r.itemId);
        if (!item || item.status !== 'OUT') throw new AppError(ErrorCodes.BUSINESS_RULE, 'A chosen item is not out on this rental.');
        if (r.condition === 'DAMAGED' && r.nextStatus === 'AVAILABLE') {
          throw new AppError(ErrorCodes.BUSINESS_RULE, `${item.asset_tag} is damaged, so it cannot go straight back into the available stock.`);
        }
        if (r.damageCharge > 0 && r.damageReason.trim().length < 3) throw new AppError(ErrorCodes.VALIDATION, `Describe the damage to ${item.asset_tag}.`);
        return { r, item };
      });
      const d = returnDrafts(a, chosen.map((c) => c.item), returnedAt);

      const drafts: ChargeDraft[] = [...d.base];
      chosen.forEach(({ r, item }, k) => {
        const late = d.late[k]!;
        if (r.lateFeeOverride !== undefined && r.lateFeeOverride !== late.amount) {
          if (r.lateFeeOverride > late.amount) throw new AppError(ErrorCodes.VALIDATION, 'A late fee can be reduced or waived, not increased.');
          if (!perms.permissions.includes('rentals.depositDeduct')) {
            throw new AppError(ErrorCodes.PERMISSION_DENIED, 'You do not have permission to waive late fees.');
          }
          if (r.lateFeeReason.trim().length < 3) throw new AppError(ErrorCodes.VALIDATION, `Give a reason for waiving the late fee on ${item.asset_tag}.`);
          late.extra = { ...late.extra, calculatedAmount: late.amount, waivedReason: r.lateFeeReason };
          late.explanation = `${late.explanation}. Reduced from ${formatMoney(late.amount)}: ${r.lateFeeReason}`;
          late.amount = r.lateFeeOverride;
        }
        if (late.amount > 0 || late.extra?.calculatedAmount) drafts.push(late);
        if (r.damageCharge > 0) {
          drafts.push({
            itemId: item.id,
            type: 'DAMAGE',
            description: `${item.product_name} (${item.asset_tag}) — damage`,
            explanation: r.damageReason,
            amount: r.damageCharge,
            sku: item.asset_tag,
            sacCode: item.sac_code,
            gstRateBp: item.gst_rate_bp,
            priceIncludesTax: item.price_includes_tax === 1,
          });
        }
        tx.db
          .prepare("UPDATE rental_items SET status = 'RETURNED', returned_at = ?, return_condition = ?, return_notes = ? WHERE id = ?")
          .run(returnedAt, r.condition, r.notes, item.id);
        tx.db.prepare('UPDATE asset_bookings SET released_at = ? WHERE rental_item_id = ?').run(tx.nowIso, item.id);
        changeAssetStatus(tx, item.asset_id, r.nextStatus, {
          event: 'RETURNED',
          condition: r.condition,
          notes: [`${a.rental_no} returned by ${a.customer_name}`, r.notes].filter(Boolean).join(': '),
          refType: 'RENTAL',
          refId: a.id,
        });
      });

      const invoice = billCharges(tx, a, loadCustomer(tx.db, a.customer_id), drafts, { requestId: `${input.requestId}:ret`, notes: `Return on ${a.rental_no}` });
      const stillOut = itemsOf(tx.db, a.id).some((i) => i.status === 'OUT');
      bumpAgreement(tx, a, { status: stillOut ? 'PARTIALLY_RETURNED' : 'RETURNED' });
      payTowards(tx, a.customer_id, input.payments, rentalInvoiceIds(tx.db, a.id), input.requestId, `Paid on return of ${a.rental_no}`);
      tx.audit({
        module: 'rentals',
        entityType: 'rental',
        entityId: a.id,
        action: 'RETURN',
        after: {
          returnedAt,
          units: chosen.map(({ r, item }, k) => ({ unit: item.asset_tag, condition: r.condition, nextStatus: r.nextStatus, lateMinutes: d.lateMinutes[k] })),
          chargesAmount: invoice?.grandTotal ?? 0,
          invoice: invoice?.invoiceNo ?? null,
          status: stillOut ? 'PARTIALLY_RETURNED' : 'RETURNED',
        },
      });
      return a.id;
    }),
  );
}

// ---------- Deposit settlement and closing ----------

export function settleDeposit(
  env: AppEnv,
  actor: Actor,
  perms: SalesPermissions,
  input: { requestId: string; id: number; applyAmount: number; applyReason: string; refundAmount: number; refundMethodId?: number; refundReference: string },
): void {
  transact(env, actor, (tx) =>
    tx.once(input.requestId, 'rentals.settleDeposit', () => {
      const a = loadAgreement(tx.db, input.id);
      if (a.status === 'RESERVED' || a.status === 'CANCELLED' || a.status === 'CLOSED') throw new AppError(ErrorCodes.BUSINESS_RULE, 'This rental has no deposit to settle.');
      const held = depositHeld(tx.db, a.id);
      if (input.applyAmount + input.refundAmount === 0) throw new AppError(ErrorCodes.VALIDATION, 'Enter an amount to use or refund.');
      if (input.applyAmount + input.refundAmount > held) throw new AppError(ErrorCodes.BUSINESS_RULE, `Only ${formatMoney(held)} of deposit is held.`);
      if (input.applyAmount > 0) {
        if (!perms.permissions.includes('rentals.depositDeduct')) throw new AppError(ErrorCodes.PERMISSION_DENIED, 'You do not have permission to deduct from deposits.');
        if (input.applyReason.trim().length < 3) throw new AppError(ErrorCodes.VALIDATION, 'Give a reason for using the deposit.');
        const owed = rentalOutstanding(tx.db, a.id);
        if (input.applyAmount > owed) throw new AppError(ErrorCodes.BUSINESS_RULE, `Only ${formatMoney(owed)} of rental charges is unpaid.`);
        const depositId = depositEntry(tx, a, { type: 'APPLY', amount: input.applyAmount, reason: input.applyReason });
        let left = input.applyAmount;
        for (const invoiceId of rentalInvoiceIds(tx.db, a.id)) {
          const open = (tx.db.prepare('SELECT outstanding FROM v_invoice_balances WHERE invoice_id = ?').get(invoiceId) as { outstanding: number }).outstanding;
          const take = Math.min(left, open);
          if (take > 0) {
            allocate(tx, { type: 'DEPOSIT', id: depositId }, { type: 'INVOICE', id: invoiceId }, take);
            left -= take;
          }
        }
      }
      if (input.refundAmount > 0) {
        if (!input.refundMethodId) throw new AppError(ErrorCodes.VALIDATION, 'Choose how the deposit is refunded.');
        depositEntry(tx, a, { type: 'REFUND', amount: input.refundAmount, methodId: input.refundMethodId, reference: input.refundReference, reason: 'Deposit refunded' });
      }
      tx.audit({
        module: 'rentals',
        entityType: 'rental',
        entityId: a.id,
        action: 'DEPOSIT_SETTLED',
        before: { depositHeldAmount: held },
        after: { appliedAmount: input.applyAmount, refundedAmount: input.refundAmount, depositHeldAmount: held - input.applyAmount - input.refundAmount },
        reason: input.applyReason || null,
      });
      return a.id;
    }),
  );
}

export function closeRental(env: AppEnv, actor: Actor, input: { id: number; version: number; note: string; acceptOutstanding: boolean }): void {
  transact(env, actor, (tx) => {
    const a = loadAgreement(tx.db, input.id);
    assertVersion(a, input.version);
    if (a.status !== 'RETURNED') throw new AppError(ErrorCodes.BUSINESS_RULE, 'Every item must be returned before the rental can be closed.');
    const pending = tx.db
      .prepare("SELECT a.asset_tag FROM rental_items i JOIN rental_assets a ON a.id = i.asset_id WHERE i.agreement_id = ? AND a.status = 'AWAITING_INSPECTION'")
      .get(a.id) as { asset_tag: string } | undefined;
    if (pending) throw new AppError(ErrorCodes.BUSINESS_RULE, `${pending.asset_tag} is still awaiting inspection. Inspect it before closing.`);
    const held = depositHeld(tx.db, a.id);
    if (held > 0) throw new AppError(ErrorCodes.BUSINESS_RULE, `${formatMoney(held)} of deposit is still held. Use it for charges or refund it first.`);
    const owed = rentalOutstanding(tx.db, a.id);
    if (owed > 0 && !input.acceptOutstanding) {
      throw new AppError(ErrorCodes.BUSINESS_RULE, `${formatMoney(owed)} of rental charges is unpaid. Confirm to close and keep it on the customer's account.`, { outstanding: owed });
    }
    bumpAgreement(tx, a, { status: 'CLOSED', closed_at: tx.nowIso, closed_by: tx.actor.userId, close_note: input.note });
    tx.audit({ module: 'rentals', entityType: 'rental', entityId: a.id, action: 'CLOSE', after: { status: 'CLOSED', unpaidAmount: owed }, reason: input.note || null });
  });
}

// ---------- Queries ----------

interface RentalListRecord extends AgreementRecord {
  item_count: number;
  out_count: number;
  items_summary: string;
  deposit_held: number;
  outstanding: number;
  created_by_name: string | null;
  closed_by_name: string | null;
}

const LIST_SELECT = `
  SELECT ra.*,
    (SELECT COUNT(*) FROM rental_items i WHERE i.agreement_id = ra.id AND i.status != 'CANCELLED') AS item_count,
    (SELECT COUNT(*) FROM rental_items i WHERE i.agreement_id = ra.id AND i.status = 'OUT') AS out_count,
    (SELECT group_concat(i.product_name || ' ' || i.asset_tag, ', ') FROM rental_items i WHERE i.agreement_id = ra.id) AS items_summary,
    COALESCE((SELECT held FROM v_deposit_balances d WHERE d.agreement_id = ra.id), 0) AS deposit_held,
    COALESCE((SELECT SUM(b.outstanding) FROM v_invoice_balances b JOIN invoices iv ON iv.id = b.invoice_id
              WHERE iv.rental_agreement_id = ra.id AND iv.kind = 'RENTAL'), 0) AS outstanding,
    cu.username AS created_by_name, cl.username AS closed_by_name
  FROM rental_agreements ra
  LEFT JOIN users cu ON cu.id = ra.created_by
  LEFT JOIN users cl ON cl.id = ra.closed_by`;

function toRentalRow(r: RentalListRecord, nowIso: string): RentalRow {
  const out = r.status === 'ACTIVE' || r.status === 'PARTIALLY_RETURNED';
  const overdueMinutes = out && r.expected_return_at < nowIso ? minutesBetween(r.expected_return_at, nowIso) : 0;
  return {
    id: r.id,
    rentalNo: r.rental_no,
    customerId: r.customer_id,
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
    status: r.status,
    startAt: r.start_at,
    expectedReturnAt: r.expected_return_at,
    itemsSummary: r.items_summary ?? '',
    itemCount: r.item_count,
    outCount: r.out_count,
    overdue: overdueMinutes > 0,
    overdueMinutes,
    depositHeld: r.deposit_held,
    outstanding: r.outstanding,
    createdAt: r.created_at,
  };
}

export function listRentals(
  db: Db,
  f: { filter: string; customerId?: number; search?: string; page: number; pageSize: number },
  nowIso: string,
): Paged<RentalRow> {
  const where: string[] = [];
  const params: unknown[] = [];
  const filters: Record<string, string> = {
    OPEN: "ra.status IN ('RESERVED', 'ACTIVE', 'PARTIALLY_RETURNED', 'RETURNED')",
    ACTIVE: "ra.status IN ('ACTIVE', 'PARTIALLY_RETURNED')",
    OVERDUE: "ra.status IN ('ACTIVE', 'PARTIALLY_RETURNED') AND ra.expected_return_at < ?",
    RESERVED: "ra.status = 'RESERVED'",
    RETURNED: "ra.status = 'RETURNED'",
    CLOSED: "ra.status = 'CLOSED'",
    CANCELLED: "ra.status = 'CANCELLED'",
  };
  if (f.filter !== 'ALL') {
    where.push(filters[f.filter]!);
    if (f.filter === 'OVERDUE') params.push(nowIso);
  }
  if (f.customerId) {
    where.push('ra.customer_id = ?');
    params.push(f.customerId);
  }
  if (f.search) {
    const like = `%${f.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(
      "(ra.rental_no LIKE ? ESCAPE '\\' OR ra.customer_name LIKE ? ESCAPE '\\' OR ra.customer_phone LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM rental_items i WHERE i.agreement_id = ra.id AND (i.asset_tag LIKE ? ESCAPE '\\' OR i.product_name LIKE ? ESCAPE '\\')))",
    );
    params.push(like, like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM rental_agreements ra ${clause}`).get(...params) as { n: number }).n;
  const order = f.filter === 'RESERVED' ? 'ra.start_at' : f.filter === 'CLOSED' || f.filter === 'ALL' ? 'ra.id DESC' : 'ra.expected_return_at';
  const rows = db
    .prepare(`${LIST_SELECT} ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, f.pageSize, (f.page - 1) * f.pageSize) as RentalListRecord[];
  return { rows: rows.map((r) => toRentalRow(r, nowIso)), total, page: f.page, pageSize: f.pageSize };
}

export function getRental(db: Db, id: number, nowIso: string): RentalDetail {
  const r = db.prepare(`${LIST_SELECT} WHERE ra.id = ?`).get(id) as RentalListRecord | undefined;
  if (!r) throw new AppError(ErrorCodes.NOT_FOUND, 'Rental not found.');
  const items = db
    .prepare('SELECT i.*, a.serial_no FROM rental_items i JOIN rental_assets a ON a.id = i.asset_id WHERE i.agreement_id = ? ORDER BY i.id')
    .all(id) as (ItemRecord & { serial_no: string })[];
  const charges = db
    .prepare(
      `SELECT c.*, i.asset_tag, iv.invoice_no, u.username FROM rental_charges c
       LEFT JOIN rental_items i ON i.id = c.item_id LEFT JOIN invoices iv ON iv.id = c.invoice_id LEFT JOIN users u ON u.id = c.user_id
       WHERE c.agreement_id = ? ORDER BY c.id`,
    )
    .all(id) as { id: number; type: ChargeType; item_id: number | null; asset_tag: string | null; description: string; calc_json: string; amount: number; invoice_id: number | null; invoice_no: string | null; created_at: string; username: string | null }[];
  const extensions = db
    .prepare(
      `SELECT e.*, iv.invoice_no, u.username FROM rental_extensions e LEFT JOIN invoices iv ON iv.id = e.invoice_id
       LEFT JOIN users u ON u.id = e.user_id WHERE e.agreement_id = ? ORDER BY e.id`,
    )
    .all(id) as { id: number; previous_expected: string; new_expected: string; reason: string; invoice_no: string | null; created_at: string; username: string | null }[];
  const deposits = db
    .prepare(
      `SELECT d.*, m.name AS method_name, u.username FROM deposit_transactions d LEFT JOIN payment_methods m ON m.id = d.method_id
       LEFT JOIN users u ON u.id = d.user_id WHERE d.agreement_id = ? ORDER BY d.id`,
    )
    .all(id) as { id: number; type: 'COLLECT' | 'APPLY' | 'REFUND'; amount: number; method_name: string | null; reference_no: string; reason: string; created_at: string; username: string | null }[];
  const bal = db.prepare('SELECT * FROM v_deposit_balances WHERE agreement_id = ?').get(id) as { collected: number; applied: number; refunded: number; held: number };
  const invoices = db
    .prepare(
      `SELECT i.id, i.invoice_no, i.grand_total, i.issued_at, b.outstanding FROM invoices i JOIN v_invoice_balances b ON b.invoice_id = i.id
       WHERE i.rental_agreement_id = ? AND i.kind = 'RENTAL' ORDER BY i.id`,
    )
    .all(id) as { id: number; invoice_no: string; grand_total: number; issued_at: string; outstanding: number }[];
  const linked = r.linked_invoice_id
    ? (db.prepare('SELECT id, invoice_no FROM invoices WHERE id = ?').get(r.linked_invoice_id) as { id: number; invoice_no: string })
    : null;
  const pricing = JSON.parse(r.pricing_json) as Pricing;
  return {
    ...toRentalRow(r, nowIso),
    originalExpectedReturnAt: r.original_expected_return_at,
    terms: r.terms,
    notes: r.notes,
    pricing: {
      pricingMode: pricing.pricingMode,
      graceMinutes: pricing.graceMinutes,
      lateFeeMode: pricing.lateFeeMode,
      lateFeePerDay: pricing.lateFeePerDay,
      lateMultiplierBp: pricing.lateMultiplierBp,
      billing: pricing.billing,
    },
    linkedInvoice: linked ? { id: linked.id, invoiceNo: linked.invoice_no } : null,
    items: items.map((i) => ({
      id: i.id,
      assetId: i.asset_id,
      assetTag: i.asset_tag,
      productName: i.product_name,
      serialNo: i.serial_no,
      status: i.status,
      conditionAtIssue: i.condition_at_issue,
      issuedAt: i.issued_at,
      returnedAt: i.returned_at,
      returnCondition: i.return_condition,
      returnNotes: i.return_notes,
      depositAmount: i.deposit_amount,
      rates: ratesOf(i),
    })),
    charges: charges.map((c) => ({
      id: c.id,
      type: c.type,
      itemId: c.item_id,
      assetTag: c.asset_tag,
      description: c.description,
      explanation: (JSON.parse(c.calc_json) as { explanation?: string }).explanation ?? '',
      amount: c.amount,
      invoiceId: c.invoice_id,
      invoiceNo: c.invoice_no,
      createdAt: c.created_at,
      username: c.username,
    })),
    extensions: extensions.map((e) => ({
      id: e.id,
      previousExpected: e.previous_expected,
      newExpected: e.new_expected,
      reason: e.reason,
      invoiceNo: e.invoice_no,
      createdAt: e.created_at,
      username: e.username,
    })),
    deposit: {
      collected: bal.collected,
      applied: bal.applied,
      refunded: bal.refunded,
      held: bal.held,
      transactions: deposits.map((d) => ({
        id: d.id,
        type: d.type,
        amount: d.amount,
        methodName: d.method_name,
        reference: d.reference_no,
        reason: d.reason,
        createdAt: d.created_at,
        username: d.username,
      })),
    },
    invoices: invoices.map((i) => ({ id: i.id, invoiceNo: i.invoice_no, grandTotal: i.grand_total, outstanding: i.outstanding, issuedAt: i.issued_at })),
    issuedAt: r.issued_at,
    closedAt: r.closed_at,
    closedBy: r.closed_by_name,
    closeNote: r.close_note,
    createdBy: r.created_by_name,
    version: r.version,
  };
}

export function rentalSummary(db: Db, nowIso: string, todayEndIso: string): RentalSummary {
  const s = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status IN ('ACTIVE', 'PARTIALLY_RETURNED') THEN 1 ELSE 0 END), 0) AS active,
         COALESCE(SUM(CASE WHEN status IN ('ACTIVE', 'PARTIALLY_RETURNED') AND expected_return_at < ? THEN 1 ELSE 0 END), 0) AS overdue,
         COALESCE(SUM(CASE WHEN status IN ('ACTIVE', 'PARTIALLY_RETURNED') AND expected_return_at >= ? AND expected_return_at < ? THEN 1 ELSE 0 END), 0) AS due_today,
         COALESCE(SUM(CASE WHEN status = 'RESERVED' THEN 1 ELSE 0 END), 0) AS reserved
       FROM rental_agreements`,
    )
    .get(nowIso, nowIso, todayEndIso) as { active: number; overdue: number; due_today: number; reserved: number };
  const held = (db.prepare('SELECT COALESCE(SUM(held), 0) AS h FROM v_deposit_balances').get() as { h: number }).h;
  const units = db
    .prepare(
      `SELECT COALESCE(SUM(status = 'RENTED'), 0) AS out_, COALESCE(SUM(status = 'AVAILABLE'), 0) AS avail,
              COALESCE(SUM(status = 'AWAITING_INSPECTION'), 0) AS insp FROM rental_assets`,
    )
    .get() as { out_: number; avail: number; insp: number };
  const unpaid = (
    db
      .prepare(
        `SELECT COALESCE(SUM(b.outstanding), 0) AS u FROM invoices i JOIN v_invoice_balances b ON b.invoice_id = i.id
         WHERE i.kind = 'RENTAL' AND b.cancelled = 0 AND b.outstanding > 0`,
      )
      .get() as { u: number }
  ).u;
  return {
    active: s.active,
    overdue: s.overdue,
    reserved: s.reserved,
    dueToday: s.due_today,
    depositsHeld: held,
    unitsOut: units.out_,
    unitsAvailable: units.avail,
    awaitingInspection: units.insp,
    chargesUnpaid: unpaid,
  };
}
