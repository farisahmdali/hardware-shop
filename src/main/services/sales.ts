import type { Db } from '../db/connection';
import { transact, type Actor, type Tx } from '../db/tx';
import type { AppEnv } from './env';
import { allocate, applyCreditFifo, availableCredit, releaseTarget } from './allocations';
import { postLedger, type AccountCode, type LedgerLine } from './ledger';
import { recordMovement } from './stock';
import { getAllSettings } from './settings';
import { insertPayment, reversePaymentTx } from './payments';
import { AppError, ErrorCodes } from '@shared/errors';
import { computeBill, proportionalShare, type Discount } from '@shared/billing';
import { formatMoney, mulDivRound } from '@shared/money';
import { formatQty, QTY_SCALE } from '@shared/qty';
import type { Permission } from '@shared/permissions';
import type {
  CreditNoteSummary,
  InvoiceDetail,
  InvoiceLineDetail,
  InvoiceRow,
  InvoiceStatus,
  Paged,
  SettlementRow,
} from '@shared/contracts';

export interface SalesPermissions {
  permissions: readonly Permission[];
  maxDiscountBp: number;
}

export interface FinalizeInput {
  requestId: string;
  customerId: number;
  walkInName: string;
  walkInPhone: string;
  lines: { productId: number; qty: number; discount: Discount | null; expectedUnitPrice: number }[];
  billDiscount: Discount | null;
  payments: { methodId: number; amount: number; reference: string }[];
  useCredit: number;
  notes: string;
  expectedGrandTotal: number;
  negativeStockReason?: string;
}

interface ProductForSale {
  id: number;
  sku: string;
  name: string;
  hsn_code: string;
  gst_rate_bp: number;
  price_includes_tax: number;
  selling_price: number;
  is_active: number;
  unit_code: string;
  allow_decimal: number;
  qty: number;
}

interface CustomerForSale {
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

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const TAX_ACCOUNTS: [keyof { cgst: 1; sgst: 1; igst: 1 }, AccountCode][] = [
  ['cgst', 'OUTPUT_CGST'],
  ['sgst', 'OUTPUT_SGST'],
  ['igst', 'OUTPUT_IGST'],
];

/** Output GST and round-off lines of an invoice's ledger entry. */
function taxAndRoundOffLines(t: { cgst: number; sgst: number; igst: number; roundOff: number }): LedgerLine[] {
  const lines: LedgerLine[] = [];
  for (const [k, acc] of TAX_ACCOUNTS) lines.push({ account: acc, credit: t[k] });
  if (t.roundOff > 0) lines.push({ account: 'ROUND_OFF', credit: t.roundOff });
  if (t.roundOff < 0) lines.push({ account: 'ROUND_OFF', debit: -t.roundOff });
  return lines;
}

/** Revenue-side ledger lines of an issued invoice, rebuilt from its stored lines (for reversals). */
function invoiceRevenueLines(tx: Tx, invoiceId: number, inv: { cgst_total: number; sgst_total: number; igst_total: number; round_off: number }): LedgerLine[] {
  const byAccount = tx.db
    .prepare(`SELECT COALESCE(revenue_account, 'SALES') AS account, SUM(taxable) AS taxable FROM invoice_lines WHERE invoice_id = ? GROUP BY 1`)
    .all(invoiceId) as { account: AccountCode; taxable: number }[];
  return [
    ...byAccount.map((r) => ({ account: r.account, credit: r.taxable })),
    ...taxAndRoundOffLines({ cgst: inv.cgst_total, sgst: inv.sgst_total, igst: inv.igst_total, roundOff: inv.round_off }),
  ];
}

/** Mirror image of a set of ledger lines (debits become credits), for reversals. */
function mirror(lines: LedgerLine[]): LedgerLine[] {
  return lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
}

/**
 * Finalizes a counter sale in one transaction: invoice number, invoice and line snapshots,
 * stock movements at average cost, revenue/tax/receivable ledger entries, payments and
 * their allocations, use of existing credit, and the history entry. Either all of it is
 * saved or none of it. A repeated request returns the first result.
 */
export function finalizeSale(env: AppEnv, actor: Actor, perms: SalesPermissions, input: FinalizeInput) {
  return transact(env, actor, (tx) => tx.once(input.requestId, 'sales.finalize', () => finalizeSaleTx(tx, perms, input)));
}

/**
 * The sale itself, inside an open transaction. Also used when products are sold together
 * with a rental, in which case the rental pays for both invoices.
 */
export function finalizeSaleTx(tx: Tx, perms: SalesPermissions, input: FinalizeInput, opts: { linkedRentalId?: number } = {}) {
  const settings = getAllSettings(tx.db);
  const customer = tx.db.prepare('SELECT * FROM customers WHERE id = ?').get(input.customerId) as CustomerForSale | undefined;
  if (!customer) throw new AppError(ErrorCodes.NOT_FOUND, 'Customer not found.');
  if (!customer.is_active) throw new AppError(ErrorCodes.BUSINESS_RULE, `${customer.name} is inactive.`);
  const walkIn = customer.is_walkin === 1;

  // ---- Products, prices, quantities ----
  const productStmt = tx.db.prepare(
    `SELECT p.id, p.sku, p.name, p.hsn_code, p.gst_rate_bp, p.price_includes_tax, p.selling_price, p.is_active,
            u.code AS unit_code, u.allow_decimal, b.qty
     FROM products p JOIN units u ON u.id = p.unit_id JOIN stock_balances b ON b.product_id = p.id WHERE p.id = ?`,
  );
  const products = input.lines.map((l) => {
    const p = productStmt.get(l.productId) as ProductForSale | undefined;
    if (!p) throw new AppError(ErrorCodes.NOT_FOUND, 'A product on the bill no longer exists.');
    if (!p.is_active) throw new AppError(ErrorCodes.BUSINESS_RULE, `${p.name} has been deactivated and cannot be sold.`);
    if (!p.allow_decimal && l.qty % QTY_SCALE !== 0) {
      throw new AppError(ErrorCodes.VALIDATION, `${p.name} is sold in whole ${p.unit_code}.`);
    }
    if (p.selling_price !== l.expectedUnitPrice) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        `The price of ${p.name} changed from ${formatMoney(l.expectedUnitPrice)} to ${formatMoney(p.selling_price)}. Review the bill and try again.`,
        { productId: p.id, price: p.selling_price },
      );
    }
    return p;
  });

  // ---- Stock availability (the same product may appear on several lines) ----
  const wanted = new Map<number, number>();
  input.lines.forEach((l) => wanted.set(l.productId, (wanted.get(l.productId) ?? 0) + l.qty));
  const short = products.filter((p, i) => products.findIndex((x) => x.id === p.id) === i && wanted.get(p.id)! > p.qty);
  let allowNegative = false;
  if (short.length > 0) {
    const canOverride =
      settings.stock.allowNegativeOverride && perms.permissions.includes('stock.overrideNegative') && !!input.negativeStockReason;
    if (!canOverride) {
      const p = short[0]!;
      throw new AppError(
        ErrorCodes.BUSINESS_RULE,
        `Not enough stock of ${p.name}: ${formatQty(p.qty)} ${p.unit_code} available, ${formatQty(wanted.get(p.id)!)} on the bill.`,
        { shortProductIds: short.map((s) => s.id) },
      );
    }
    if (input.negativeStockReason!.trim().length < 3) throw new AppError(ErrorCodes.VALIDATION, 'Give a reason for selling without stock.');
    allowNegative = true;
  }

  // ---- Amounts ----
  const interstate = !walkIn && customer.state_code !== '' && customer.state_code !== settings.shop.stateCode;
  const bill = computeBill(
    input.lines.map((l, i) => ({
      unitPrice: products[i]!.selling_price,
      qty: l.qty,
      gstRateBp: products[i]!.gst_rate_bp,
      priceIncludesTax: products[i]!.price_includes_tax === 1,
      discount: l.discount,
    })),
    {
      interstate,
      gstRegistered: settings.tax.gstRegistered,
      roundTotal: settings.tax.roundInvoiceTotal,
      billDiscount: input.billDiscount,
    },
  );
  if (bill.discountTotal > 0) {
    if (!perms.permissions.includes('sales.discount')) {
      throw new AppError(ErrorCodes.PERMISSION_DENIED, 'You do not have permission to give discounts.');
    }
    const limit = mulDivRound(bill.grossTotal, perms.maxDiscountBp, 10_000);
    if (bill.discountTotal > limit) {
      throw new AppError(
        ErrorCodes.BUSINESS_RULE,
        `The discount of ${formatMoney(bill.discountTotal)} is above your limit of ${perms.maxDiscountBp / 100}% (${formatMoney(limit)}).`,
      );
    }
  }
  if (bill.grandTotal !== input.expectedGrandTotal) {
    throw new AppError(
      ErrorCodes.CONFLICT,
      `The bill total is ${formatMoney(bill.grandTotal)}, not ${formatMoney(input.expectedGrandTotal)}. Review the bill and try again.`,
    );
  }

  // ---- Payments and credit ----
  const paid = input.payments.reduce((a, p) => a + p.amount, 0);
  if (input.useCredit > 0) {
    if (walkIn) throw new AppError(ErrorCodes.BUSINESS_RULE, 'The walk-in customer has no account credit.');
    const credit = availableCredit(tx.db, customer.id);
    if (input.useCredit > credit) {
      throw new AppError(ErrorCodes.BUSINESS_RULE, `Only ${formatMoney(credit)} of credit is available.`);
    }
  }
  if (paid + input.useCredit > bill.grandTotal) {
    throw new AppError(ErrorCodes.VALIDATION, 'The payments are more than the bill total. Enter the amount kept, not the cash handed over.');
  }
  if (walkIn && paid !== bill.grandTotal) {
    throw new AppError(
      ErrorCodes.BUSINESS_RULE,
      'A walk-in sale must be paid in full. Choose or add a customer to sell on credit.',
    );
  }

  // ---- Invoice: stock leaves first so each line records the cost it left at ----
  const invoiceId = reserveInvoiceId(tx);
  const movements = input.lines.map((l) =>
    recordMovement(tx, {
      productId: l.productId,
      type: 'SALE',
      qtyChange: -l.qty,
      reason: allowNegative && short.some((s) => s.id === l.productId) ? `Sold below zero: ${input.negativeStockReason}` : null,
      refType: 'INVOICE',
      refId: invoiceId,
      allowNegative,
    }),
  );
  const { invoiceNo } = writeInvoice(tx, {
    id: invoiceId,
    kind: 'SALE',
    requestId: input.requestId,
    customer,
    walkInName: input.walkInName,
    walkInPhone: input.walkInPhone,
    billDiscount: input.billDiscount,
    notes: input.notes,
    linkedRentalId: opts.linkedRentalId ?? null,
    lines: input.lines.map((l, i) => {
      const p = products[i]!;
      return {
        lineKind: 'PRODUCT' as const,
        productId: p.id,
        sku: p.sku,
        name: p.name,
        hsnCode: p.hsn_code,
        unitCode: p.unit_code,
        qty: l.qty,
        unitPrice: p.selling_price,
        priceIncludesTax: p.price_includes_tax === 1,
        gstRateBp: p.gst_rate_bp,
        discount: l.discount,
        revenueAccount: 'SALES' as const,
        costValue: -movements[i]!.costValue,
        movementId: movements[i]!.id,
      };
    }),
  });

  // ---- Payments at the counter ----
  const paymentIds = input.payments.map((p, i) => {
    const paymentId = insertPayment(tx, {
      requestId: `${input.requestId}:${i}`,
      direction: 'IN',
      purpose: 'RECEIPT',
      customerId: customer.id,
      amount: p.amount,
      methodId: p.methodId,
      reference: p.reference,
      notes: `Paid at the counter for ${invoiceNo}`,
    });
    allocate(tx, { type: 'PAYMENT', id: paymentId }, { type: 'INVOICE', id: invoiceId }, p.amount);
    return paymentId;
  });
  if (input.useCredit > 0) {
    applyCreditFifo(tx, customer.id, { onlyTarget: { type: 'INVOICE', id: invoiceId }, limit: input.useCredit });
  }

  const outstanding = bill.grandTotal - paid - input.useCredit;
  tx.audit({
    module: 'sales',
    entityType: 'invoice',
    entityId: invoiceId,
    action: 'CREATE',
    after: {
      invoiceNo,
      customer: walkIn ? input.walkInName || 'Walk-in customer' : customer.name,
      items: input.lines.length,
      grossTotal: bill.grossTotal,
      discountTotal: bill.discountTotal,
      grandTotal: bill.grandTotal,
      paidAmount: paid,
      creditUsedAmount: input.useCredit,
      outstandingAmount: outstanding,
      payments: paymentIds.length,
    },
    reason: allowNegative ? `Stock override: ${input.negativeStockReason}` : null,
  });
  if (allowNegative) {
    tx.audit({
      module: 'stock',
      entityType: 'invoice',
      entityId: invoiceId,
      action: 'NEGATIVE_STOCK_OVERRIDE',
      after: { products: short.map((s) => ({ product: s.name, available: s.qty, sold: wanted.get(s.id) })) },
      reason: input.negativeStockReason,
    });
  }
  return { invoiceId, invoiceNo, grandTotal: bill.grandTotal, outstanding };
}

// ---------- Writing invoices (sales and rentals) ----------

export interface InvoiceLineWrite {
  lineKind: 'PRODUCT' | 'RENTAL_CHARGE';
  productId: number | null;
  rentalChargeId?: number | null;
  sku: string;
  name: string;
  hsnCode: string;
  unitCode: string;
  qty: number;
  unitPrice: number;
  priceIncludesTax: boolean;
  gstRateBp: number;
  discount: Discount | null;
  /** Income account credited with this line's taxable value. */
  revenueAccount: AccountCode;
  costValue?: number;
  movementId?: number | null;
}

/** Invoices are immutable, so documents that must point at one (stock movements, charges) reserve its id first. */
export function reserveInvoiceId(tx: Tx): number {
  return (tx.db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM invoices').get() as { id: number }).id;
}

/**
 * Writes an invoice with its lines and the matching ledger entry: the customer owes the
 * total, each line's taxable value is credited to its income account, and output GST
 * and round-off are recorded. Returns the computed bill.
 */
export function writeInvoice(
  tx: Tx,
  p: {
    id?: number;
    kind: 'SALE' | 'RENTAL';
    requestId: string;
    customer: CustomerForSale;
    walkInName?: string;
    walkInPhone?: string;
    lines: InvoiceLineWrite[];
    billDiscount: Discount | null;
    notes: string;
    rentalAgreementId?: number | null;
    linkedInvoiceId?: number | null;
    linkedRentalId?: number | null;
  },
): { invoiceId: number; invoiceNo: string; bill: ReturnType<typeof computeBill> } {
  const settings = getAllSettings(tx.db);
  const walkIn = p.customer.is_walkin === 1;
  const interstate = !walkIn && p.customer.state_code !== '' && p.customer.state_code !== settings.shop.stateCode;
  const bill = computeBill(
    p.lines.map((l) => ({ unitPrice: l.unitPrice, qty: l.qty, gstRateBp: l.gstRateBp, priceIncludesTax: l.priceIncludesTax, discount: l.discount })),
    { interstate, gstRegistered: settings.tax.gstRegistered, roundTotal: settings.tax.roundInvoiceTotal, billDiscount: p.billDiscount },
  );
  const invoiceId = p.id ?? reserveInvoiceId(tx);
  const invoiceNo = tx.nextDocNumber(p.kind === 'SALE' ? 'INVOICE' : 'RENTAL_INVOICE');
  const creditDays = walkIn ? 0 : (p.customer.credit_days ?? settings.receivables.defaultCreditDays);
  const costTotal = p.lines.reduce((a, l) => a + (l.costValue ?? 0), 0);

  tx.db
    .prepare(
      `INSERT INTO invoices (id, invoice_no, client_request_id, kind, customer_id, customer_name, customer_phone, customer_address,
         customer_gstin, customer_state_code, shop_state_code, is_interstate, gst_registered, gross_total, discount_total,
         taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total, cost_total, issued_at, business_date, due_date,
         notes, user_id, rental_agreement_id, linked_invoice_id, txn_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      invoiceId,
      invoiceNo,
      p.requestId,
      p.kind,
      p.customer.id,
      walkIn ? p.walkInName || 'Walk-in customer' : p.customer.name,
      walkIn ? (p.walkInPhone ?? '') : p.customer.phone,
      walkIn ? '' : p.customer.address,
      walkIn ? '' : p.customer.gstin,
      walkIn ? '' : p.customer.state_code,
      settings.shop.stateCode,
      interstate ? 1 : 0,
      settings.tax.gstRegistered ? 1 : 0,
      bill.grossTotal,
      bill.discountTotal,
      bill.taxableTotal,
      bill.cgstTotal,
      bill.sgstTotal,
      bill.igstTotal,
      bill.roundOff,
      bill.grandTotal,
      costTotal,
      tx.nowIso,
      tx.businessDate,
      addDays(tx.businessDate, creditDays),
      p.notes,
      tx.actor.userId,
      p.rentalAgreementId ?? p.linkedRentalId ?? null,
      p.linkedInvoiceId ?? null,
      tx.txnRef,
    );
  const insertLine = tx.db.prepare(
    `INSERT INTO invoice_lines (invoice_id, line_no, line_kind, product_id, rental_charge_id, sku, name, hsn_code, unit_code, qty,
       unit_price, price_includes_tax, gross, line_discount, bill_discount, taxable, gst_rate_bp, cgst, sgst, igst, line_total,
       cost_value, movement_id, revenue_account)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  bill.lines.forEach((b, i) => {
    const l = p.lines[i]!;
    insertLine.run(
      invoiceId,
      i + 1,
      l.lineKind,
      l.productId,
      l.rentalChargeId ?? null,
      l.sku,
      l.name,
      l.hsnCode,
      l.unitCode,
      l.qty,
      l.unitPrice,
      l.priceIncludesTax ? 1 : 0,
      b.gross,
      b.lineDiscount,
      b.billDiscount,
      b.taxable,
      settings.tax.gstRegistered ? l.gstRateBp : 0,
      b.cgst,
      b.sgst,
      b.igst,
      b.lineTotal,
      l.costValue ?? 0,
      l.movementId ?? null,
      l.revenueAccount,
    );
  });

  const byAccount = new Map<AccountCode, number>();
  bill.lines.forEach((b, i) => byAccount.set(p.lines[i]!.revenueAccount, (byAccount.get(p.lines[i]!.revenueAccount) ?? 0) + b.taxable));
  postLedger(tx, {
    refType: 'INVOICE',
    refId: invoiceId,
    memo: `Invoice ${invoiceNo}`,
    lines: [
      { account: 'AR', debit: bill.grandTotal, partyType: 'CUSTOMER', partyId: p.customer.id },
      ...[...byAccount.entries()].map(([account, taxable]) => ({ account, credit: taxable })),
      ...taxAndRoundOffLines({ cgst: bill.cgstTotal, sgst: bill.sgstTotal, igst: bill.igstTotal, roundOff: bill.roundOff }),
    ],
  });
  return { invoiceId, invoiceNo, bill };
}

// ---------- Queries ----------

interface InvoiceRecord {
  id: number;
  invoice_no: string;
  kind: 'SALE' | 'RENTAL';
  rental_agreement_id: number | null;
  issued_at: string;
  business_date: string;
  due_date: string;
  customer_id: number;
  customer_name: string;
  customer_phone: string;
  customer_address: string;
  customer_gstin: string;
  customer_state_code: string;
  shop_state_code: string;
  is_interstate: number;
  gst_registered: number;
  gross_total: number;
  discount_total: number;
  taxable_total: number;
  cgst_total: number;
  sgst_total: number;
  igst_total: number;
  round_off: number;
  grand_total: number;
  cost_total: number;
  notes: string;
  is_walkin: number;
  outstanding: number;
  cancelled: number;
  line_count: number;
  username: string | null;
}

const INVOICE_SELECT = `
  SELECT i.*, c.is_walkin, ib.outstanding, ib.cancelled, u.username,
         (SELECT COUNT(*) FROM invoice_lines l WHERE l.invoice_id = i.id) AS line_count
  FROM invoices i
  JOIN customers c ON c.id = i.customer_id
  JOIN v_invoice_balances ib ON ib.invoice_id = i.id
  LEFT JOIN users u ON u.id = i.user_id`;

function statusOf(r: { cancelled: number; outstanding: number; grand_total: number }): InvoiceStatus {
  if (r.cancelled) return 'CANCELLED';
  if (r.outstanding <= 0) return 'PAID';
  return r.outstanding < r.grand_total ? 'PARTIAL' : 'UNPAID';
}

function toInvoiceRow(r: InvoiceRecord, asOf: string): InvoiceRow {
  const status = statusOf(r);
  return {
    id: r.id,
    invoiceNo: r.invoice_no,
    issuedAt: r.issued_at,
    businessDate: r.business_date,
    dueDate: r.due_date,
    customerId: r.customer_id,
    customerName: r.customer_name,
    isWalkin: r.is_walkin === 1,
    grandTotal: r.grand_total,
    outstanding: r.cancelled ? 0 : r.outstanding,
    status,
    overdue: (status === 'UNPAID' || status === 'PARTIAL') && r.due_date < asOf,
    lineCount: r.line_count,
    username: r.username,
  };
}

export function listInvoices(
  db: Db,
  f: {
    search?: string;
    customerId?: number;
    status: 'ALL' | 'PAID' | 'PARTIAL' | 'UNPAID' | 'OPEN' | 'OVERDUE' | 'CANCELLED';
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
  },
  asOf: string,
): Paged<InvoiceRow> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.customerId) {
    where.push('i.customer_id = ?');
    params.push(f.customerId);
  }
  if (f.from) {
    where.push('i.business_date >= ?');
    params.push(f.from);
  }
  if (f.to) {
    where.push('i.business_date <= ?');
    params.push(f.to);
  }
  if (f.search) {
    where.push("(i.invoice_no LIKE ? ESCAPE '\\' OR i.customer_name LIKE ? ESCAPE '\\' OR i.customer_phone LIKE ? ESCAPE '\\')");
    const like = `%${f.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    params.push(like, like, like);
  }
  const statusSql: Record<string, string> = {
    PAID: 'ib.cancelled = 0 AND ib.outstanding <= 0',
    PARTIAL: 'ib.cancelled = 0 AND ib.outstanding > 0 AND ib.outstanding < i.grand_total',
    UNPAID: 'ib.cancelled = 0 AND ib.outstanding > 0 AND ib.outstanding = i.grand_total',
    OPEN: 'ib.cancelled = 0 AND ib.outstanding > 0',
    OVERDUE: 'ib.cancelled = 0 AND ib.outstanding > 0 AND i.due_date < ?',
    CANCELLED: 'ib.cancelled = 1',
  };
  if (f.status !== 'ALL') {
    where.push(statusSql[f.status]!);
    if (f.status === 'OVERDUE') params.push(asOf);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM invoices i JOIN v_invoice_balances ib ON ib.invoice_id = i.id ${clause}`)
      .get(...params) as { n: number }
  ).n;
  const rows = db
    .prepare(`${INVOICE_SELECT} ${clause} ORDER BY i.id DESC LIMIT ? OFFSET ?`)
    .all(...params, f.pageSize, (f.page - 1) * f.pageSize) as InvoiceRecord[];
  return { rows: rows.map((r) => toInvoiceRow(r, asOf)), total, page: f.page, pageSize: f.pageSize };
}

export function getInvoice(db: Db, id: number, canSeeCost: boolean, asOf: string): InvoiceDetail {
  const r = db.prepare(`${INVOICE_SELECT} WHERE i.id = ?`).get(id) as InvoiceRecord | undefined;
  if (!r) throw new AppError(ErrorCodes.NOT_FOUND, 'Invoice not found.');
  const lines = db
    .prepare(
      `SELECT l.*, COALESCE(u.allow_decimal, 1) AS allow_decimal,
              COALESCE((SELECT SUM(cl.qty) FROM credit_note_lines cl WHERE cl.invoice_line_id = l.id), 0) AS returned_qty
       FROM invoice_lines l LEFT JOIN products p ON p.id = l.product_id LEFT JOIN units u ON u.id = p.unit_id
       WHERE l.invoice_id = ? ORDER BY l.line_no`,
    )
    .all(id) as {
    id: number;
    line_no: number;
    product_id: number | null;
    sku: string;
    name: string;
    hsn_code: string;
    unit_code: string;
    allow_decimal: number;
    qty: number;
    returned_qty: number;
    unit_price: number;
    price_includes_tax: number;
    gross: number;
    line_discount: number;
    bill_discount: number;
    taxable: number;
    gst_rate_bp: number;
    cgst: number;
    sgst: number;
    igst: number;
    line_total: number;
    cost_value: number;
  }[];
  const settlements = db
    .prepare(
      `SELECT a.source_type AS kind, a.source_id, SUM(a.amount) AS amount,
              CASE a.source_type
                WHEN 'PAYMENT' THEN (SELECT payment_no FROM payments WHERE id = a.source_id)
                WHEN 'CREDIT_NOTE' THEN (SELECT credit_note_no FROM credit_notes WHERE id = a.source_id)
                ELSE 'Credit adjustment' END AS doc_no,
              CASE a.source_type
                WHEN 'PAYMENT' THEN (SELECT received_at FROM payments WHERE id = a.source_id)
                WHEN 'CREDIT_NOTE' THEN (SELECT issued_at FROM credit_notes WHERE id = a.source_id)
                ELSE (SELECT created_at FROM balance_adjustments WHERE id = a.source_id) END AS date,
              CASE WHEN a.source_type = 'PAYMENT'
                THEN (SELECT m.name FROM payments p JOIN payment_methods m ON m.id = p.method_id WHERE p.id = a.source_id) END AS method_name,
              CASE WHEN a.source_type = 'PAYMENT'
                THEN EXISTS (SELECT 1 FROM payment_reversals pr WHERE pr.payment_id = a.source_id) ELSE 0 END AS reversed
       FROM allocations a WHERE a.target_type = 'INVOICE' AND a.target_id = ?
       GROUP BY a.source_type, a.source_id ORDER BY MIN(a.id)`,
    )
    .all(id) as { kind: SettlementRow['kind']; source_id: number; amount: number; doc_no: string; date: string; method_name: string | null; reversed: number }[];
  const creditNotes = db
    .prepare(
      `SELECT cn.id, cn.credit_note_no, cn.issued_at, cn.total, cn.settlement, cn.reason, u.username
       FROM credit_notes cn LEFT JOIN users u ON u.id = cn.user_id WHERE cn.invoice_id = ? ORDER BY cn.id`,
    )
    .all(id) as { id: number; credit_note_no: string; issued_at: string; total: number; settlement: 'CREDIT' | 'REFUND'; reason: string; username: string | null }[];
  const cancellation = db
    .prepare(
      `SELECT c.cancelled_at, c.reason, u.username FROM invoice_cancellations c LEFT JOIN users u ON u.id = c.user_id
       WHERE c.invoice_id = ?`,
    )
    .get(id) as { cancelled_at: string; reason: string; username: string | null } | undefined;

  return {
    ...toInvoiceRow(r, asOf),
    kind: r.kind,
    rentalAgreementId: r.rental_agreement_id,
    customerPhone: r.customer_phone,
    customerAddress: r.customer_address,
    customerGstin: r.customer_gstin,
    customerStateCode: r.customer_state_code,
    shopStateCode: r.shop_state_code,
    isInterstate: r.is_interstate === 1,
    gstRegistered: r.gst_registered === 1,
    grossTotal: r.gross_total,
    discountTotal: r.discount_total,
    taxableTotal: r.taxable_total,
    cgstTotal: r.cgst_total,
    sgstTotal: r.sgst_total,
    igstTotal: r.igst_total,
    roundOff: r.round_off,
    costTotal: canSeeCost ? r.cost_total : null,
    notes: r.notes,
    lines: lines.map(
      (l): InvoiceLineDetail => ({
        id: l.id,
        lineNo: l.line_no,
        productId: l.product_id,
        sku: l.sku,
        name: l.name,
        hsnCode: l.hsn_code,
        unitCode: l.unit_code,
        allowDecimal: l.allow_decimal === 1,
        qty: l.qty,
        returnedQty: l.returned_qty,
        unitPrice: l.unit_price,
        priceIncludesTax: l.price_includes_tax === 1,
        gross: l.gross,
        discount: l.line_discount + l.bill_discount,
        taxable: l.taxable,
        gstRateBp: l.gst_rate_bp,
        cgst: l.cgst,
        sgst: l.sgst,
        igst: l.igst,
        lineTotal: l.line_total,
        costValue: canSeeCost ? l.cost_value : null,
      }),
    ),
    settlements: settlements
      .filter((s) => s.amount !== 0)
      .map((s) => ({
        kind: s.kind,
        sourceId: s.source_id,
        docNo: s.doc_no,
        date: s.date,
        methodName: s.method_name,
        amount: s.amount,
        reversed: s.reversed === 1,
      })),
    creditNotes: creditNotes.map(
      (c): CreditNoteSummary => ({
        id: c.id,
        creditNoteNo: c.credit_note_no,
        issuedAt: c.issued_at,
        total: c.total,
        settlement: c.settlement,
        reason: c.reason,
        username: c.username,
      }),
    ),
    cancellation: cancellation ? { at: cancellation.cancelled_at, reason: cancellation.reason, username: cancellation.username } : null,
  };
}

// ---------- Cancellation ----------

/**
 * Cancels an invoice: stock comes back at exactly the cost it left with, revenue, GST and
 * the receivable are reversed, and any payments are released. For a walk-in sale the
 * payments are reversed (money handed back); for a registered customer they become
 * account credit that can be refunded or used.
 */
export function cancelInvoice(env: AppEnv, actor: Actor, input: { id: number; reason: string; requestId: string }): void {
  transact(env, actor, (tx) =>
    tx.once(input.requestId, 'invoices.cancel', () => {
      const inv = tx.db
        .prepare('SELECT i.*, c.is_walkin FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?')
        .get(input.id) as (InvoiceRecord & { txn_ref: string }) | undefined;
      if (!inv) throw new AppError(ErrorCodes.NOT_FOUND, 'Invoice not found.');
      if (tx.db.prepare('SELECT 1 FROM invoice_cancellations WHERE invoice_id = ?').get(input.id)) {
        throw new AppError(ErrorCodes.BUSINESS_RULE, `Invoice ${inv.invoice_no} is already cancelled.`);
      }
      if (tx.db.prepare('SELECT 1 FROM credit_notes WHERE invoice_id = ?').get(input.id)) {
        throw new AppError(ErrorCodes.BUSINESS_RULE, `Invoice ${inv.invoice_no} has returns. Return the remaining items instead of cancelling.`);
      }
      if (inv.kind === 'RENTAL') {
        throw new AppError(
          ErrorCodes.BUSINESS_RULE,
          'Rental invoices are part of a rental agreement. To correct one, issue a credit note for the charge instead.',
        );
      }

      tx.db
        .prepare('INSERT INTO invoice_cancellations (invoice_id, reason, user_id, cancelled_at, business_date, txn_ref) VALUES (?, ?, ?, ?, ?, ?)')
        .run(input.id, input.reason, tx.actor.userId, tx.nowIso, tx.businessDate, tx.txnRef);

      const lines = tx.db
        .prepare('SELECT product_id, qty, cost_value FROM invoice_lines WHERE invoice_id = ? AND product_id IS NOT NULL')
        .all(input.id) as { product_id: number; qty: number; cost_value: number }[];
      for (const l of lines) {
        recordMovement(tx, {
          productId: l.product_id,
          type: 'SALE_CANCEL',
          qtyChange: l.qty,
          costValue: l.cost_value,
          reason: `Invoice ${inv.invoice_no} cancelled: ${input.reason}`,
          refType: 'INVOICE',
          refId: input.id,
        });
      }

      postLedger(tx, {
        refType: 'INVOICE_CANCEL',
        refId: input.id,
        memo: `Invoice ${inv.invoice_no} cancelled`,
        lines: [
          ...mirror(invoiceRevenueLines(tx, input.id, inv)),
          { account: 'AR', credit: inv.grand_total, partyType: 'CUSTOMER', partyId: inv.customer_id },
        ],
      });

      const paidBy = (
        tx.db
          .prepare(
            `SELECT source_id FROM allocations WHERE target_type = 'INVOICE' AND target_id = ? AND source_type = 'PAYMENT'
             GROUP BY source_id HAVING SUM(amount) > 0`,
          )
          .all(input.id) as { source_id: number }[]
      ).map((r) => r.source_id);
      const released = releaseTarget(tx, { type: 'INVOICE', id: input.id }, `Invoice ${inv.invoice_no} cancelled`);
      if (inv.is_walkin) {
        // Walk-in customers have no account: the money is handed back, reversing each payment.
        for (const paymentId of paidBy) reversePaymentTx(tx, paymentId, `Invoice ${inv.invoice_no} cancelled: ${input.reason}`);
      }

      tx.audit({
        module: 'sales',
        entityType: 'invoice',
        entityId: input.id,
        action: 'CANCEL',
        before: { status: 'ISSUED', grandTotal: inv.grand_total },
        after: { status: 'CANCELLED', releasedAmount: released, stockReturned: lines.length },
        reason: input.reason,
      });
      return input.id;
    }),
  );
}

// ---------- Credit notes (returns) ----------

export function createCreditNote(
  env: AppEnv,
  actor: Actor,
  input: {
    requestId: string;
    invoiceId: number;
    lines: { invoiceLineId: number; qty: number; restock: boolean }[];
    reason: string;
    settlement: 'CREDIT' | 'REFUND';
    refundMethodId?: number;
  },
) {
  return transact(env, actor, (tx) =>
    tx.once(input.requestId, 'creditNotes.create', () => {
      const inv = tx.db
        .prepare('SELECT i.*, c.is_walkin FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?')
        .get(input.invoiceId) as InvoiceRecord | undefined;
      if (!inv) throw new AppError(ErrorCodes.NOT_FOUND, 'Invoice not found.');
      if (tx.db.prepare('SELECT 1 FROM invoice_cancellations WHERE invoice_id = ?').get(input.invoiceId)) {
        throw new AppError(ErrorCodes.BUSINESS_RULE, 'Items cannot be returned against a cancelled invoice.');
      }
      if (inv.is_walkin && input.settlement !== 'REFUND') {
        throw new AppError(ErrorCodes.BUSINESS_RULE, 'Walk-in customers have no account; refund the money instead.');
      }
      const seen = new Set<number>();
      const lineStmt = tx.db.prepare(
        `SELECT l.*, COALESCE((SELECT SUM(cl.qty) FROM credit_note_lines cl WHERE cl.invoice_line_id = l.id), 0) AS returned_qty
         FROM invoice_lines l WHERE l.id = ? AND l.invoice_id = ?`,
      );
      const computed = input.lines.map((req) => {
        if (seen.has(req.invoiceLineId)) throw new AppError(ErrorCodes.VALIDATION, 'Each item may appear once.');
        seen.add(req.invoiceLineId);
        const l = lineStmt.get(req.invoiceLineId, input.invoiceId) as
          | { id: number; product_id: number | null; name: string; qty: number; returned_qty: number; taxable: number; cgst: number; sgst: number; igst: number; cost_value: number; revenue_account: string | null }
          | undefined;
        if (!l) throw new AppError(ErrorCodes.NOT_FOUND, 'An item is not on this invoice.');
        if (req.qty > l.qty - l.returned_qty) {
          throw new AppError(ErrorCodes.BUSINESS_RULE, `Only ${formatQty(l.qty - l.returned_qty)} of ${l.name} can still be returned.`);
        }
        const share = (amount: number) => proportionalShare(amount, l.qty, l.returned_qty, req.qty);
        const taxable = share(l.taxable);
        const cgst = share(l.cgst);
        const sgst = share(l.sgst);
        const igst = share(l.igst);
        return { req, l, taxable, cgst, sgst, igst, total: taxable + cgst + sgst + igst, cost: share(l.cost_value) };
      });
      const totals = computed.reduce(
        (a, c) => ({
          taxable: a.taxable + c.taxable,
          cgst: a.cgst + c.cgst,
          sgst: a.sgst + c.sgst,
          igst: a.igst + c.igst,
          total: a.total + c.total,
          cost: a.cost + (c.req.restock ? c.cost : 0),
        }),
        { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0, cost: 0 },
      );
      if (totals.total <= 0) throw new AppError(ErrorCodes.BUSINESS_RULE, 'The returned items have no value to credit.');

      const creditNoteNo = tx.nextDocNumber('CREDIT_NOTE');
      const cnId = Number(
        tx.db
          .prepare(
            `INSERT INTO credit_notes (credit_note_no, client_request_id, invoice_id, customer_id, reason, settlement, taxable_total,
               cgst_total, sgst_total, igst_total, total, cost_total, issued_at, business_date, user_id, txn_ref)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            creditNoteNo,
            input.requestId,
            input.invoiceId,
            inv.customer_id,
            input.reason,
            input.settlement,
            totals.taxable,
            totals.cgst,
            totals.sgst,
            totals.igst,
            totals.total,
            totals.cost,
            tx.nowIso,
            tx.businessDate,
            tx.actor.userId,
            tx.txnRef,
          ).lastInsertRowid,
      );
      const insertLine = tx.db.prepare(
        `INSERT INTO credit_note_lines (credit_note_id, invoice_line_id, qty, restock, taxable, cgst, sgst, igst, line_total, cost_value, movement_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const c of computed) {
        let movementId: number | null = null;
        if (c.req.restock && c.l.product_id !== null) {
          movementId = recordMovement(tx, {
            productId: c.l.product_id,
            type: 'CUSTOMER_RETURN',
            qtyChange: c.req.qty,
            costValue: c.cost,
            reason: `Returned on ${creditNoteNo}: ${input.reason}`,
            refType: 'CREDIT_NOTE',
            refId: cnId,
          }).id;
        }
        insertLine.run(cnId, c.l.id, c.req.qty, c.req.restock ? 1 : 0, c.taxable, c.cgst, c.sgst, c.igst, c.total, c.req.restock ? c.cost : 0, movementId);
      }

      postLedger(tx, {
        refType: 'CREDIT_NOTE',
        refId: cnId,
        memo: `Credit note ${creditNoteNo} for ${inv.invoice_no}`,
        lines: [
          // Goods returned reduce sales through Sales returns; credited rental charges reduce their own income account.
          ...[
            ...computed
              .reduce((m, c) => {
                const account: AccountCode =
                  !c.l.revenue_account || c.l.revenue_account === 'SALES' ? 'SALES_RETURNS' : (c.l.revenue_account as AccountCode);
                return m.set(account, (m.get(account) ?? 0) + c.taxable);
              }, new Map<AccountCode, number>())
              .entries(),
          ].map(([account, debit]) => ({ account, debit })),
          { account: 'OUTPUT_CGST', debit: totals.cgst },
          { account: 'OUTPUT_SGST', debit: totals.sgst },
          { account: 'OUTPUT_IGST', debit: totals.igst },
          { account: 'AR', credit: totals.total, partyType: 'CUSTOMER', partyId: inv.customer_id },
        ],
      });

      // The credit first reduces what is still owed on this invoice.
      const applied = applyCreditFifo(tx, inv.customer_id, {
        onlySource: { type: 'CREDIT_NOTE', id: cnId },
        onlyTarget: { type: 'INVOICE', id: input.invoiceId },
      });
      let refunded = 0;
      const remainder = totals.total - applied;
      if (remainder > 0 && input.settlement === 'REFUND') {
        if (!input.refundMethodId) throw new AppError(ErrorCodes.VALIDATION, 'Choose how the refund is paid.');
        const refundId = insertPayment(tx, {
          requestId: `${input.requestId}:refund`,
          direction: 'OUT',
          purpose: 'REFUND',
          customerId: inv.customer_id,
          amount: remainder,
          methodId: input.refundMethodId,
          reference: '',
          notes: `Refund for ${creditNoteNo}`,
        });
        allocate(tx, { type: 'CREDIT_NOTE', id: cnId }, { type: 'REFUND', id: refundId }, remainder);
        refunded = remainder;
      } else if (remainder > 0) {
        applyCreditFifo(tx, inv.customer_id, { onlySource: { type: 'CREDIT_NOTE', id: cnId } });
      }

      tx.audit({
        module: 'sales',
        entityType: 'invoice',
        entityId: input.invoiceId,
        action: 'RETURN',
        after: {
          creditNoteNo,
          items: computed.map((c) => ({ item: c.l.name, qty: c.req.qty, restocked: c.req.restock, amount: c.total })),
          totalAmount: totals.total,
          appliedToInvoiceAmount: applied,
          refundedAmount: refunded,
        },
        reason: input.reason,
        relatedType: 'credit_note',
        relatedId: cnId,
      });
      return { creditNoteId: cnId, creditNoteNo, total: totals.total };
    }),
  );
}


/** Today's and this month's sales, and today's collections by method. Cancelled invoices are excluded. */
export function salesSummary(db: Db, asOf: string) {
  const totals = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(i.grand_total), 0) AS total FROM invoices i
     WHERE i.business_date BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM invoice_cancellations c WHERE c.invoice_id = i.id)`,
  );
  // Sales are reported net of goods returned in the same period.
  const returns = db.prepare('SELECT COALESCE(SUM(total), 0) AS t FROM credit_notes WHERE business_date BETWEEN ? AND ?');
  const monthStart = `${asOf.slice(0, 7)}-01`;
  const day = totals.get(asOf, asOf) as { n: number; total: number };
  const month = totals.get(monthStart, asOf) as { n: number; total: number };
  day.total -= (returns.get(asOf, asOf) as { t: number }).t;
  month.total -= (returns.get(monthStart, asOf) as { t: number }).t;
  const collected = db
    .prepare(
      `SELECT m.name AS methodName, m.kind, SUM(CASE p.direction WHEN 'IN' THEN p.amount ELSE -p.amount END) AS amount
       FROM payments p JOIN payment_methods m ON m.id = p.method_id
       WHERE p.business_date = ? AND p.party_type = 'CUSTOMER'
         AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)
       GROUP BY m.id ORDER BY m.sort_order`,
    )
    .all(asOf) as { methodName: string; kind: string; amount: number }[];
  return { todayTotal: day.total, todayCount: day.n, monthTotal: month.total, monthCount: month.n, collectedToday: collected };
}
