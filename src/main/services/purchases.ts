import type { Db } from '../db/connection';
import { transact, type Actor, type Tx } from '../db/tx';
import type { AppEnv } from './env';
import { allocateSupplier, applySupplierCreditFifo, payableOutstanding, releaseSupplierTarget } from './supplierAllocations';
import { insertSupplierPayment, receiveSupplierRefundTx } from './supplierPayments';
import { postLedger, type LedgerLine } from './ledger';
import { recordMovement } from './stock';
import { getAllSettings } from './settings';
import { supplierCreditDays } from './suppliers';
import { AppError, ErrorCodes } from '@shared/errors';
import { proportionalShare, type Discount } from '@shared/billing';
import { claimsInputGst, computePurchase } from '@shared/purchasing';
import { formatMoney, mulDivRound } from '@shared/money';
import { formatQty, QTY_SCALE } from '@shared/qty';
import type { DebitNoteSummary, Paged, PurchaseDetail, PurchaseLineDetail, PurchaseRow, PurchaseSettlement, PurchaseStatus, PurchaseVersion } from '@shared/contracts';

export interface PurchaseInput {
  requestId: string;
  supplierId: number;
  supplierInvoiceNo: string;
  supplierInvoiceDate: string;
  pricesIncludeTax: boolean;
  lines: { productId: number; qty: number; unitCost: number; gstRateBp: number; discount: Discount | null }[];
  billDiscount: Discount | null;
  additionalCosts: number;
  additionalCostsNote: string;
  roundOff: number;
  notes: string;
  payments: { methodId: number; amount: number; reference: string }[];
  updatePurchasePrices: boolean;
  expectedGrandTotal: number;
}

interface SupplierForPurchase {
  id: number;
  name: string;
  gstin: string;
  state_code: string;
  credit_days: number | null;
  is_active: number;
}

interface ProductForPurchase {
  id: number;
  sku: string;
  name: string;
  hsn_code: string;
  purchase_price: number;
  is_active: number;
  unit_code: string;
  allow_decimal: number;
  version: number;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function reservePurchaseId(tx: Tx): number {
  return (tx.db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM purchases').get() as { id: number }).id;
}

/**
 * Records a supplier's bill in one transaction: purchase number, bill and line snapshots, stock
 * received at landed cost, the ledger entry (stock, recoverable GST, round-off, amount owed to the
 * supplier), any payment made now, and the history entry. A repeated request returns the first result.
 */
export function createPurchase(env: AppEnv, actor: Actor, input: PurchaseInput) {
  return transact(env, actor, (tx) => tx.once(input.requestId, 'purchases.create', () => createPurchaseTx(tx, input)));
}

/** A purchase bill as entered, without the payments made at entry. */
export type PurchaseBillInput = Omit<PurchaseInput, 'requestId' | 'payments'>;

interface PreparedPurchase {
  input: PurchaseBillInput;
  supplier: SupplierForPurchase;
  products: ProductForPurchase[];
  calc: ReturnType<typeof computePurchase>;
  interstate: boolean;
  itcClaimed: boolean;
  shopStateCode: string;
}

/**
 * Checks a bill and works out its amounts exactly as they will be recorded. `replacing` is the
 * purchase an edit replaces: its own supplier bill number is not a duplicate.
 */
function preparePurchase(tx: Tx, input: PurchaseBillInput, opts: { replacing?: number } = {}): PreparedPurchase {
  const settings = getAllSettings(tx.db);
  const supplier = tx.db.prepare('SELECT * FROM suppliers WHERE id = ?').get(input.supplierId) as SupplierForPurchase | undefined;
  if (!supplier) throw new AppError(ErrorCodes.NOT_FOUND, 'Supplier not found.');
  if (!supplier.is_active) throw new AppError(ErrorCodes.BUSINESS_RULE, `${supplier.name} is inactive. Reactivate the supplier first.`);
  if (input.supplierInvoiceDate > tx.businessDate) {
    throw new AppError(ErrorCodes.VALIDATION, 'The supplier bill date cannot be in the future.');
  }
  if (input.supplierInvoiceNo) {
    const dup = tx.db
      .prepare(
        `SELECT p.purchase_no FROM purchases p LEFT JOIN purchase_cancellations c ON c.purchase_id = p.id
         WHERE p.supplier_id = ? AND p.supplier_invoice_no = ? COLLATE NOCASE AND c.id IS NULL AND p.id != ?`,
      )
      .get(supplier.id, input.supplierInvoiceNo, opts.replacing ?? 0) as { purchase_no: string } | undefined;
    if (dup) {
      throw new AppError(ErrorCodes.CONFLICT, `Bill ${input.supplierInvoiceNo} from ${supplier.name} is already recorded as ${dup.purchase_no}.`);
    }
  }
  if (!supplier.gstin && input.lines.some((l) => l.gstRateBp > 0)) {
    throw new AppError(
      ErrorCodes.BUSINESS_RULE,
      `${supplier.name} has no GSTIN, so their bill cannot charge GST. Add the supplier's GSTIN or set the GST rate to 0%.`,
    );
  }
  if (Math.abs(input.roundOff) > settings.purchases.maxRoundOff) {
    throw new AppError(ErrorCodes.VALIDATION, `Round-off can be at most ${formatMoney(settings.purchases.maxRoundOff)}. Check the item amounts against the bill.`);
  }

  const productStmt = tx.db.prepare(
    `SELECT p.id, p.sku, p.name, p.hsn_code, p.purchase_price, p.is_active, p.version, u.code AS unit_code, u.allow_decimal
     FROM products p JOIN units u ON u.id = p.unit_id WHERE p.id = ?`,
  );
  const products = input.lines.map((l) => {
    const p = productStmt.get(l.productId) as ProductForPurchase | undefined;
    if (!p) throw new AppError(ErrorCodes.NOT_FOUND, 'A product on the bill no longer exists.');
    if (!p.is_active) throw new AppError(ErrorCodes.BUSINESS_RULE, `${p.name} is deactivated. Reactivate it before receiving stock.`);
    if (!p.allow_decimal && l.qty % QTY_SCALE !== 0) throw new AppError(ErrorCodes.VALIDATION, `${p.name} is counted in whole ${p.unit_code}.`);
    return p;
  });

  const interstate = supplier.state_code !== '' && supplier.state_code !== settings.shop.stateCode;
  const itcClaimed = claimsInputGst({ claimInputGst: settings.purchases.claimInputGst, gstRegistered: settings.tax.gstRegistered }, supplier.gstin);
  const calc = computePurchase(input.lines, {
    pricesIncludeTax: input.pricesIncludeTax,
    interstate,
    billDiscount: input.billDiscount,
    additionalCosts: input.additionalCosts,
    roundOff: input.roundOff,
    itcClaimed,
  });
  if (calc.grandTotal < 0) throw new AppError(ErrorCodes.VALIDATION, 'The bill total cannot be negative.');
  if (calc.grandTotal !== input.expectedGrandTotal) {
    throw new AppError(
      ErrorCodes.CONFLICT,
      `The bill total works out to ${formatMoney(calc.grandTotal)}, not ${formatMoney(input.expectedGrandTotal)}. Review the bill and try again.`,
    );
  }
  return { input, supplier, products, calc, interstate, itcClaimed, shopStateCode: settings.shop.stateCode };
}

/** Writes the bill and its lines. `movementIds` are the stock movements of the lines, in order. */
function insertPurchase(
  tx: Tx,
  prep: PreparedPurchase,
  rec: { id: number; purchaseNo: string; requestId: string; receivedAt: string; businessDate: string; movementIds: number[] },
): void {
  const { input, supplier, products, calc } = prep;
  const { bill } = calc;
  const dueDate = addDays(input.supplierInvoiceDate, supplierCreditDays(tx.db, supplier));
  tx.db
    .prepare(
      `INSERT INTO purchases (id, purchase_no, client_request_id, supplier_id, supplier_name, supplier_gstin, supplier_state_code,
         supplier_invoice_no, supplier_invoice_date, shop_state_code, is_interstate, prices_include_tax, itc_claimed,
         gross_total, discount_total, taxable_total, cgst_total, sgst_total, igst_total, additional_costs, additional_costs_note,
         round_off, grand_total, inventory_value, received_at, business_date, due_date, notes, user_id, txn_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rec.id,
      rec.purchaseNo,
      rec.requestId,
      supplier.id,
      supplier.name,
      supplier.gstin,
      supplier.state_code,
      input.supplierInvoiceNo,
      input.supplierInvoiceDate,
      prep.shopStateCode,
      prep.interstate ? 1 : 0,
      input.pricesIncludeTax ? 1 : 0,
      prep.itcClaimed ? 1 : 0,
      bill.grossTotal,
      bill.discountTotal,
      bill.taxableTotal,
      bill.cgstTotal,
      bill.sgstTotal,
      bill.igstTotal,
      input.additionalCosts,
      input.additionalCostsNote,
      input.roundOff,
      calc.grandTotal,
      calc.inventoryValue,
      rec.receivedAt,
      rec.businessDate,
      dueDate,
      input.notes,
      tx.actor.userId,
      tx.txnRef,
    );
  const lineStmt = tx.db.prepare(
    `INSERT INTO purchase_lines (purchase_id, line_no, product_id, sku, name, hsn_code, unit_code, qty, unit_cost, gross,
       line_discount, bill_discount, taxable, gst_rate_bp, cgst, sgst, igst, line_total, additional_cost, landed_value, movement_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  input.lines.forEach((l, i) => {
    const p = products[i]!;
    const r = bill.lines[i]!;
    lineStmt.run(
      rec.id,
      i + 1,
      p.id,
      p.sku,
      p.name,
      p.hsn_code,
      p.unit_code,
      l.qty,
      l.unitCost,
      r.gross,
      r.lineDiscount,
      r.billDiscount,
      r.taxable,
      l.gstRateBp,
      r.cgst,
      r.sgst,
      r.igst,
      r.lineTotal,
      calc.additionalShare[i]!,
      calc.landed[i]!,
      rec.movementIds[i]!,
    );
  });
}

/** The accounting entry of a bill: stock, recoverable GST and round-off against what the shop owes. */
function postPurchase(tx: Tx, prep: PreparedPurchase, purchaseId: number, purchaseNo: string, businessDate?: string): void {
  const { bill } = prep.calc;
  const tax = bill.cgstTotal + bill.sgstTotal + bill.igstTotal;
  const lines: LedgerLine[] = [
    { account: 'INVENTORY', debit: prep.calc.inventoryValue },
    { account: 'INPUT_GST', debit: prep.itcClaimed ? tax : 0 },
    { account: 'ROUND_OFF', debit: Math.max(0, prep.input.roundOff) },
    { account: 'ROUND_OFF', credit: Math.max(0, -prep.input.roundOff) },
    { account: 'AP', credit: prep.calc.grandTotal, partyType: 'SUPPLIER', partyId: prep.supplier.id },
  ];
  postLedger(tx, { refType: 'PURCHASE', refId: purchaseId, memo: `Purchase ${purchaseNo} from ${prep.supplier.name}`, businessDate, lines });
}

/** The products' purchase price follows the latest landed cost. */
function updatePurchasePricesFrom(tx: Tx, prep: PreparedPurchase, purchaseId: number, purchaseNo: string): void {
  const latest = new Map<number, { product: ProductForPurchase; unitCost: number }>();
  prep.input.lines.forEach((l, i) =>
    latest.set(l.productId, { product: prep.products[i]!, unitCost: mulDivRound(prep.calc.landed[i]!, QTY_SCALE, l.qty) }),
  );
  for (const { product, unitCost } of latest.values()) {
    const current = (tx.db.prepare('SELECT purchase_price FROM products WHERE id = ?').get(product.id) as { purchase_price: number }).purchase_price;
    if (unitCost === current) continue;
    tx.db.prepare('UPDATE products SET purchase_price = ?, updated_at = ?, version = version + 1 WHERE id = ?').run(unitCost, tx.nowIso, product.id);
    tx.audit({
      module: 'products',
      entityType: 'product',
      entityId: product.id,
      action: 'COST_UPDATED',
      before: { purchasePrice: current },
      after: { purchasePrice: unitCost },
      reason: `Latest cost from purchase ${purchaseNo}`,
      relatedType: 'purchase',
      relatedId: purchaseId,
    });
  }
}

function createPurchaseTx(tx: Tx, input: PurchaseInput) {
  const prep = preparePurchase(tx, input);
  const { supplier, calc, itcClaimed } = prep;
  const { bill } = calc;
  const paid = input.payments.reduce((a, p) => a + p.amount, 0);
  if (paid > calc.grandTotal) throw new AppError(ErrorCodes.VALIDATION, 'The payments are more than the bill total.');

  // ---- Stock received at landed cost ----
  const purchaseId = reservePurchaseId(tx);
  const purchaseNo = tx.nextDocNumber('PURCHASE');
  const movements = input.lines.map((l, i) =>
    recordMovement(tx, {
      productId: l.productId,
      type: 'PURCHASE',
      qtyChange: l.qty,
      costValue: calc.landed[i]!,
      unitCost: mulDivRound(calc.landed[i]!, QTY_SCALE, l.qty),
      refType: 'PURCHASE',
      refId: purchaseId,
      counterAccount: null,
    }),
  );

  insertPurchase(tx, prep, {
    id: purchaseId,
    purchaseNo,
    requestId: input.requestId,
    receivedAt: tx.nowIso,
    businessDate: tx.businessDate,
    movementIds: movements.map((m) => m.id),
  });
  postPurchase(tx, prep, purchaseId, purchaseNo);
  const tax = bill.cgstTotal + bill.sgstTotal + bill.igstTotal;

  // ---- Paid now, then any advance already with the supplier ----
  input.payments.forEach((p, i) => {
    const paymentId = insertSupplierPayment(tx, {
      requestId: `${input.requestId}:${i}`,
      direction: 'OUT',
      supplierId: supplier.id,
      amount: p.amount,
      methodId: p.methodId,
      reference: p.reference,
      notes: `Paid on receiving ${purchaseNo}`,
    });
    allocateSupplier(tx, { type: 'PAYMENT', id: paymentId }, { type: 'PURCHASE', id: purchaseId }, p.amount);
  });
  const fromAdvance = applySupplierCreditFifo(tx, supplier.id, { onlyTarget: { type: 'PURCHASE', id: purchaseId } });

  if (input.updatePurchasePrices) updatePurchasePricesFrom(tx, prep, purchaseId, purchaseNo);

  const outstanding = calc.grandTotal - paid - fromAdvance;
  tx.audit({
    module: 'purchases',
    entityType: 'purchase',
    entityId: purchaseId,
    action: 'CREATE',
    after: {
      purchaseNo,
      supplier: supplier.name,
      supplierInvoiceNo: input.supplierInvoiceNo,
      items: input.lines.length,
      grandTotal: calc.grandTotal,
      stockValueAdded: calc.inventoryValue,
      inputGstClaimed: itcClaimed ? tax : 0,
      paidAmount: paid,
      advanceUsedAmount: fromAdvance,
      outstandingAmount: outstanding,
    },
  });
  return { purchaseId, purchaseNo, grandTotal: calc.grandTotal, outstanding };
}

// ---------- Cancelling a purchase ----------

/**
 * Reverses a recorded bill's accounting entry. `removed` is the stock value taken out for it now;
 * `kept` the value of its goods left in stock untouched (an edit that did not change them). The
 * difference between the bill's stock value and those goes to stock adjustments. Returns it.
 */
function postReversal(
  tx: Tx,
  p: PurchaseRecord,
  o: { refType: 'PURCHASE_CANCEL' | 'PURCHASE_REVISED'; memo: string; removed: number; kept: number; businessDate?: string },
): number {
  const tax = p.cgst_total + p.sgst_total + p.igst_total;
  const difference = p.inventory_value - o.kept - o.removed;
  postLedger(tx, {
    refType: o.refType,
    refId: p.id,
    memo: o.memo,
    businessDate: o.businessDate,
    lines: [
      { account: 'AP', debit: p.grand_total, partyType: 'SUPPLIER', partyId: p.supplier_id },
      { account: 'ROUND_OFF', debit: Math.max(0, -p.round_off) },
      { account: 'INVENTORY', credit: o.removed + o.kept },
      { account: 'INPUT_GST', credit: p.itc_claimed ? tax : 0 },
      { account: 'ROUND_OFF', credit: Math.max(0, p.round_off) },
      { account: 'INVENTORY_LOSS', credit: Math.max(0, difference) },
      { account: 'INVENTORY_LOSS', debit: Math.max(0, -difference) },
    ],
  });
  return difference;
}

/** The version that replaced a purchase, if it was edited. */
function replacedBy(db: Db, purchaseId: number): { id: number; purchase_no: string } | undefined {
  return db
    .prepare('SELECT p.id, p.purchase_no FROM purchase_revisions r JOIN purchases p ON p.id = r.revised_purchase_id WHERE r.purchase_id = ?')
    .get(purchaseId) as { id: number; purchase_no: string } | undefined;
}

interface PurchaseRecord {
  id: number;
  purchase_no: string;
  business_date: string;
  received_at: string;
  supplier_id: number;
  supplier_name: string;
  supplier_invoice_no: string;
  supplier_invoice_date: string;
  itc_claimed: number;
  cgst_total: number;
  sgst_total: number;
  igst_total: number;
  round_off: number;
  grand_total: number;
  inventory_value: number;
}

interface PurchaseLineRecord {
  id: number;
  line_no: number;
  product_id: number;
  name: string;
  unit_code: string;
  qty: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  line_total: number;
  landed_value: number;
  movement_id: number;
  allow_decimal: number;
}

function loadPurchase(db: Db, id: number): PurchaseRecord {
  const p = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id) as PurchaseRecord | undefined;
  if (!p) throw new AppError(ErrorCodes.NOT_FOUND, 'Purchase not found.');
  return p;
}

const LINES_SQL = `SELECT l.*, u.allow_decimal FROM purchase_lines l
  JOIN products p ON p.id = l.product_id JOIN units u ON u.id = p.unit_id WHERE l.purchase_id = ? ORDER BY l.line_no`;

/**
 * Cancels a purchase entered by mistake. The stock comes back out, the amount owed is removed and
 * payments made against it become an advance with the supplier. When nothing has happened to a
 * product since, its stock value is restored exactly; otherwise the stock leaves at the current
 * average cost and the difference goes to stock adjustments.
 */
export function cancelPurchase(env: AppEnv, actor: Actor, input: { id: number; reason: string; requestId: string }): void {
  transact(env, actor, (tx) =>
    tx.once(input.requestId, 'purchases.cancel', () => {
      const p = loadPurchase(tx.db, input.id);
      const current = replacedBy(tx.db, p.id);
      if (current) throw new AppError(ErrorCodes.BUSINESS_RULE, `${p.purchase_no} was edited; the bill is now ${current.purchase_no}. Cancel that one instead.`);
      if (tx.db.prepare('SELECT 1 FROM purchase_cancellations WHERE purchase_id = ?').get(p.id)) {
        throw new AppError(ErrorCodes.BUSINESS_RULE, `${p.purchase_no} is already cancelled.`);
      }
      const dn = tx.db.prepare('SELECT debit_note_no FROM debit_notes WHERE purchase_id = ? LIMIT 1').get(p.id) as { debit_note_no: string } | undefined;
      if (dn) {
        throw new AppError(
          ErrorCodes.BUSINESS_RULE,
          `Goods from ${p.purchase_no} were already returned (${dn.debit_note_no}), so it cannot be cancelled. Record a return for the rest instead.`,
        );
      }
      const lines = tx.db.prepare(LINES_SQL).all(p.id) as PurchaseLineRecord[];
      const needed = new Map<number, { qty: number; name: string; unit: string; lastMovement: number }>();
      for (const l of lines) {
        const n = needed.get(l.product_id) ?? { qty: 0, name: l.name, unit: l.unit_code, lastMovement: 0 };
        n.qty += l.qty;
        n.lastMovement = Math.max(n.lastMovement, l.movement_id);
        needed.set(l.product_id, n);
      }
      const exact = new Set<number>();
      for (const [productId, n] of needed) {
        const b = tx.db.prepare('SELECT qty, last_movement_id FROM stock_balances WHERE product_id = ?').get(productId) as { qty: number; last_movement_id: number };
        if (b.qty < n.qty) {
          throw new AppError(
            ErrorCodes.BUSINESS_RULE,
            `Only ${formatQty(b.qty)} ${n.unit} of ${n.name} is in stock, but the bill brought in ${formatQty(n.qty)}. ` +
              'Some has already been sold, so the bill cannot be cancelled. Record a supplier return for what is left instead.',
          );
        }
        if (b.last_movement_id === n.lastMovement) exact.add(productId);
      }

      let removed = 0;
      for (const l of [...lines].reverse()) {
        const m = recordMovement(tx, {
          productId: l.product_id,
          type: 'PURCHASE_CANCEL',
          qtyChange: -l.qty,
          costValue: exact.has(l.product_id) ? -l.landed_value : undefined,
          reason: `${p.purchase_no} cancelled: ${input.reason}`,
          refType: 'PURCHASE',
          refId: p.id,
          counterAccount: null,
        });
        removed += -m.costValue;
      }

      const difference = postReversal(tx, p, { refType: 'PURCHASE_CANCEL', memo: `Purchase ${p.purchase_no} cancelled: ${input.reason}`, removed, kept: 0 });
      tx.db
        .prepare('INSERT INTO purchase_cancellations (purchase_id, reason, user_id, cancelled_at, business_date, txn_ref) VALUES (?, ?, ?, ?, ?, ?)')
        .run(p.id, input.reason, tx.actor.userId, tx.nowIso, tx.businessDate, tx.txnRef);
      const released = releaseSupplierTarget(tx, { type: 'PURCHASE', id: p.id }, `Purchase ${p.purchase_no} cancelled`);
      tx.audit({
        module: 'purchases',
        entityType: 'purchase',
        entityId: p.id,
        action: 'CANCEL',
        before: { status: 'RECORDED', grandTotal: p.grand_total },
        after: { status: 'CANCELLED', releasedAmount: released, stockRemovedValue: removed, stockAdjustmentAmount: difference },
        reason: input.reason,
      });
      return p.id;
    }),
  );
}

// ---------- Editing a purchase ----------

export interface PurchaseEditInput extends PurchaseBillInput {
  requestId: string;
  /** The version being edited; refused if it has been edited since. */
  id: number;
  reason: string;
}

/** What a version of a bill says, for the before/after of an edit in the history. */
function purchaseSnapshot(db: Db, id: number) {
  const p = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id) as PurchaseRecord & {
    supplier_name: string;
    prices_include_tax: number;
    additional_costs: number;
    additional_costs_note: string;
    notes: string;
  };
  const lines = db
    .prepare('SELECT name, sku, unit_code, qty, unit_cost, gst_rate_bp, line_discount, bill_discount FROM purchase_lines WHERE purchase_id = ? ORDER BY line_no')
    .all(id) as { name: string; sku: string; unit_code: string; qty: number; unit_cost: number; gst_rate_bp: number; line_discount: number; bill_discount: number }[];
  const items: Record<string, string> = {};
  for (const l of lines) {
    let key = `${l.name} (${l.sku})`;
    for (let n = 2; key in items; n++) key = `${l.name} (${l.sku}) #${n}`;
    const discount = l.line_discount + l.bill_discount;
    items[key] =
      `${formatQty(l.qty)} ${l.unit_code} at ${formatMoney(l.unit_cost)}` +
      (l.gst_rate_bp ? `, GST ${l.gst_rate_bp / 100}%` : '') +
      (discount ? `, less ${formatMoney(discount)}` : '');
  }
  return {
    supplier: p.supplier_name,
    supplierInvoiceNo: p.supplier_invoice_no,
    supplierInvoiceDate: p.supplier_invoice_date,
    ratesIncludeGst: p.prices_include_tax === 1,
    items,
    freightAmount: p.additional_costs,
    freightNote: p.additional_costs_note,
    roundOffAmount: p.round_off,
    notes: p.notes,
    grandTotal: p.grand_total,
    stockValueAdded: p.inventory_value,
    inputGstClaimed: p.itc_claimed ? p.cgst_total + p.sgst_total + p.igst_total : 0,
  };
}

/**
 * Edits a purchase. Recorded bills are never changed: the corrected bill is saved as a new version
 * (numbered like the original with -R2, -R3, ...), and the version it replaces is reversed and kept,
 * marked as replaced. Both accounting entries are dated on the bill's own day, so the accounts
 * read as if it had been entered correctly. Stock moves only for products whose quantity or cost
 * changed: what this bill brought in is taken out (at its own cost when nothing else has happened
 * to the product since, otherwise at the average cost, with the difference to stock adjustments)
 * and the corrected quantity brought in at the corrected cost. Payments made against the bill
 * settle the new version. The history records the edit with every change, who made it and why.
 */
export function editPurchase(env: AppEnv, actor: Actor, input: PurchaseEditInput) {
  return transact(env, actor, (tx) => tx.once(input.requestId, 'purchases.edit', () => editPurchaseTx(tx, input)));
}

function editPurchaseTx(tx: Tx, input: PurchaseEditInput) {
  const old = loadPurchase(tx.db, input.id);
  const current = replacedBy(tx.db, old.id);
  if (current) {
    throw new AppError(ErrorCodes.CONFLICT, `${old.purchase_no} has already been edited; the bill is now ${current.purchase_no}. Open that one to edit it again.`);
  }
  if (tx.db.prepare('SELECT 1 FROM purchase_cancellations WHERE purchase_id = ?').get(old.id)) {
    throw new AppError(ErrorCodes.BUSINESS_RULE, `${old.purchase_no} was cancelled and cannot be edited.`);
  }
  const dn = tx.db.prepare('SELECT debit_note_no FROM debit_notes WHERE purchase_id = ? LIMIT 1').get(old.id) as { debit_note_no: string } | undefined;
  if (dn) {
    throw new AppError(ErrorCodes.BUSINESS_RULE, `Goods from ${old.purchase_no} were returned to the supplier (${dn.debit_note_no}), so the bill can no longer be edited.`);
  }
  const prep = preparePurchase(tx, input, { replacing: old.id });
  const { calc } = prep;

  const chain = tx.db.prepare('SELECT original_purchase_id AS originalId, revision FROM purchase_revisions WHERE revised_purchase_id = ?').get(old.id) as
    | { originalId: number; revision: number }
    | undefined;
  const originalId = chain?.originalId ?? old.id;
  const revision = (chain?.revision ?? 1) + 1;
  const originalNo = (tx.db.prepare('SELECT purchase_no FROM purchases WHERE id = ?').get(originalId) as { purchase_no: string }).purchase_no;
  const purchaseNo = `${originalNo}-R${revision}`;
  const newId = reservePurchaseId(tx);

  // ---- Which products move: only those whose quantity or cost changed ----
  const oldLines = tx.db.prepare(LINES_SQL).all(old.id) as PurchaseLineRecord[];
  const before = new Map<number, { qty: number; value: number; lastMovement: number; name: string; unit: string }>();
  for (const l of oldLines) {
    const b = before.get(l.product_id) ?? { qty: 0, value: 0, lastMovement: 0, name: l.name, unit: l.unit_code };
    b.qty += l.qty;
    b.value += l.landed_value;
    b.lastMovement = Math.max(b.lastMovement, l.movement_id);
    before.set(l.product_id, b);
  }
  const after = new Map<number, { qty: number; value: number }>();
  input.lines.forEach((l, i) => {
    const a = after.get(l.productId) ?? { qty: 0, value: 0 };
    a.qty += l.qty;
    a.value += calc.landed[i]!;
    after.set(l.productId, a);
  });
  const changed = new Set<number>();
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(id);
    const a = after.get(id);
    if (!b || !a || b.qty !== a.qty || b.value !== a.value) changed.add(id);
  }

  // Taking this bill's goods out first restores their exact cost, but needs them still in stock;
  // when some have been sold, the corrected goods come in first.
  const balance = tx.db.prepare('SELECT qty, last_movement_id FROM stock_balances WHERE product_id = ?');
  let removeFirst = true;
  const untouched = new Set<number>();
  for (const id of changed) {
    const b = before.get(id);
    if (!b) continue;
    const stock = balance.get(id) as { qty: number; last_movement_id: number };
    const newQty = after.get(id)?.qty ?? 0;
    if (stock.qty + newQty < b.qty) {
      throw new AppError(
        ErrorCodes.BUSINESS_RULE,
        `${formatQty(b.qty - stock.qty)} ${b.unit} of ${b.name} from this bill has already been sold or used, so the corrected bill must bring in at least that much ` +
          `(it now has ${formatQty(newQty)} ${b.unit}).`,
      );
    }
    if (stock.qty < b.qty) removeFirst = false;
    if (stock.last_movement_id === b.lastMovement) untouched.add(id);
  }

  const movementReason = `${old.purchase_no} edited, now ${purchaseNo}: ${input.reason}`;
  let removed = 0;
  const takeOut = () => {
    for (const l of [...oldLines].reverse()) {
      if (!changed.has(l.product_id)) continue;
      const m = recordMovement(tx, {
        productId: l.product_id,
        type: 'PURCHASE_CANCEL',
        qtyChange: -l.qty,
        costValue: removeFirst && untouched.has(l.product_id) ? -l.landed_value : undefined,
        reason: movementReason,
        refType: 'PURCHASE',
        refId: old.id,
        counterAccount: null,
      });
      removed += -m.costValue;
    }
  };
  // Lines of products that did not change keep pointing at the movement that brought them in.
  const movementIds = input.lines.map((l) => before.get(l.productId)?.lastMovement ?? 0);
  const bringIn = () => {
    input.lines.forEach((l, i) => {
      if (!changed.has(l.productId)) return;
      const m = recordMovement(tx, {
        productId: l.productId,
        type: 'PURCHASE',
        qtyChange: l.qty,
        costValue: calc.landed[i]!,
        unitCost: mulDivRound(calc.landed[i]!, QTY_SCALE, l.qty),
        reason: movementReason,
        refType: 'PURCHASE',
        refId: newId,
        counterAccount: null,
      });
      movementIds[i] = m.id;
    });
  };
  if (removeFirst) {
    takeOut();
    bringIn();
  } else {
    bringIn();
    takeOut();
  }
  const kept = oldLines.filter((l) => !changed.has(l.product_id)).reduce((a, l) => a + l.landed_value, 0);

  // ---- The replaced version is reversed and kept; the corrected version recorded ----
  tx.db
    .prepare('INSERT INTO purchase_cancellations (purchase_id, reason, user_id, cancelled_at, business_date, txn_ref) VALUES (?, ?, ?, ?, ?, ?)')
    .run(old.id, `Replaced by ${purchaseNo} (edited): ${input.reason}`, tx.actor.userId, tx.nowIso, tx.businessDate, tx.txnRef);
  const difference = postReversal(tx, old, {
    refType: 'PURCHASE_REVISED',
    memo: `Purchase ${old.purchase_no} edited, replaced by ${purchaseNo}: ${input.reason}`,
    removed,
    kept,
    businessDate: old.business_date,
  });
  insertPurchase(tx, prep, { id: newId, purchaseNo, requestId: input.requestId, receivedAt: old.received_at, businessDate: old.business_date, movementIds });
  postPurchase(tx, prep, newId, purchaseNo, old.business_date);
  releaseSupplierTarget(tx, { type: 'PURCHASE', id: old.id }, `Purchase ${old.purchase_no} replaced by ${purchaseNo}`);
  applySupplierCreditFifo(tx, prep.supplier.id, { onlyTarget: { type: 'PURCHASE', id: newId } });
  if (input.updatePurchasePrices) updatePurchasePricesFrom(tx, prep, newId, purchaseNo);
  tx.db
    .prepare(
      `INSERT INTO purchase_revisions (purchase_id, revised_purchase_id, original_purchase_id, revision, reason, user_id, revised_at, business_date, txn_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(old.id, newId, originalId, revision, input.reason, tx.actor.userId, tx.nowIso, tx.businessDate, tx.txnRef);

  const was = purchaseSnapshot(tx.db, old.id);
  const now = purchaseSnapshot(tx.db, newId);
  if (JSON.stringify(was) === JSON.stringify(now)) throw new AppError(ErrorCodes.BUSINESS_RULE, 'Nothing on the bill was changed.');
  tx.audit({
    module: 'purchases',
    entityType: 'purchase',
    entityId: newId,
    action: 'EDIT',
    before: { purchaseNo: old.purchase_no, ...was },
    after: { purchaseNo, ...now, stockAdjustmentAmount: difference },
    reason: input.reason,
    relatedType: 'purchase',
    relatedId: old.id,
  });
  const outstanding = payableOutstanding(tx.db, 'PURCHASE', newId);
  return { purchaseId: newId, purchaseNo, grandTotal: calc.grandTotal, outstanding };
}

// ---------- Supplier returns (debit notes) ----------

/**
 * Goods sent back to the supplier against a purchase. The supplier is credited the share of the bill
 * those goods cost (so returning a line in parts adds up exactly); stock leaves at the current
 * average cost and any difference goes to stock adjustments. Input GST claimed on them is reversed.
 * The credit first reduces what is owed on that bill; the rest settles other bills, stays as an
 * advance with the supplier, or is refunded by the supplier now.
 */
export function createSupplierReturn(
  env: AppEnv,
  actor: Actor,
  input: {
    requestId: string;
    purchaseId: number;
    lines: { purchaseLineId: number; qty: number }[];
    reason: string;
    settlement: 'ADJUST' | 'REFUND';
    refundMethodId?: number;
    reference: string;
  },
) {
  return transact(env, actor, (tx) =>
    tx.once(input.requestId, 'supplierReturns.create', () => {
      const p = loadPurchase(tx.db, input.purchaseId);
      const current = replacedBy(tx.db, p.id);
      if (current) throw new AppError(ErrorCodes.BUSINESS_RULE, `${p.purchase_no} was edited; return the goods against ${current.purchase_no}.`);
      if (tx.db.prepare('SELECT 1 FROM purchase_cancellations WHERE purchase_id = ?').get(p.id)) {
        throw new AppError(ErrorCodes.BUSINESS_RULE, `${p.purchase_no} was cancelled; nothing can be returned against it.`);
      }
      if (input.settlement === 'REFUND' && !input.refundMethodId) throw new AppError(ErrorCodes.VALIDATION, 'Choose how the supplier refunds the money.');
      const all = new Map((tx.db.prepare(LINES_SQL).all(p.id) as PurchaseLineRecord[]).map((l) => [l.id, l]));
      const returnedStmt = tx.db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM debit_note_lines WHERE purchase_line_id = ?');
      const seen = new Set<number>();
      const parts = input.lines.map((r) => {
        const l = all.get(r.purchaseLineId);
        if (!l) throw new AppError(ErrorCodes.VALIDATION, 'A returned item is not on this purchase.');
        if (seen.has(l.id)) throw new AppError(ErrorCodes.VALIDATION, `${l.name} is listed twice.`);
        seen.add(l.id);
        if (!l.allow_decimal && r.qty % QTY_SCALE !== 0) throw new AppError(ErrorCodes.VALIDATION, `${l.name} is counted in whole ${l.unit_code}.`);
        const already = (returnedStmt.get(l.id) as { q: number }).q;
        if (r.qty > l.qty - already) {
          throw new AppError(ErrorCodes.BUSINESS_RULE, `Only ${formatQty(l.qty - already)} ${l.unit_code} of ${l.name} is left to return on this bill.`);
        }
        const share = (x: number) => proportionalShare(x, l.qty, already, r.qty);
        const taxable = share(l.taxable);
        const cgst = share(l.cgst);
        const sgst = share(l.sgst);
        const igst = share(l.igst);
        return { line: l, qty: r.qty, taxable, cgst, sgst, igst, total: taxable + cgst + sgst + igst };
      });
      const total = parts.reduce((a, x) => a + x.total, 0);
      if (total <= 0) throw new AppError(ErrorCodes.BUSINESS_RULE, 'These items were free on the bill, so there is nothing to claim from the supplier.');

      const debitNoteId = (tx.db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM debit_notes').get() as { id: number }).id;
      const debitNoteNo = tx.nextDocNumber('DEBIT_NOTE');
      const moved = parts.map((x) =>
        recordMovement(tx, {
          productId: x.line.product_id,
          type: 'SUPPLIER_RETURN',
          qtyChange: -x.qty,
          reason: `Returned to ${p.supplier_name}: ${input.reason}`,
          refType: 'DEBIT_NOTE',
          refId: debitNoteId,
          counterAccount: null,
        }),
      );
      const costTotal = moved.reduce((a, m) => a - m.costValue, 0);
      const sum = (f: (x: (typeof parts)[number]) => number) => parts.reduce((a, x) => a + f(x), 0);
      tx.db
        .prepare(
          `INSERT INTO debit_notes (id, debit_note_no, client_request_id, purchase_id, supplier_id, reason, settlement, taxable_total,
             cgst_total, sgst_total, igst_total, total, cost_total, issued_at, business_date, user_id, txn_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          debitNoteId,
          debitNoteNo,
          input.requestId,
          p.id,
          p.supplier_id,
          input.reason,
          input.settlement,
          sum((x) => x.taxable),
          sum((x) => x.cgst),
          sum((x) => x.sgst),
          sum((x) => x.igst),
          total,
          costTotal,
          tx.nowIso,
          tx.businessDate,
          tx.actor.userId,
          tx.txnRef,
        );
      const lineStmt = tx.db.prepare(
        `INSERT INTO debit_note_lines (debit_note_id, purchase_line_id, qty, taxable, cgst, sgst, igst, line_total, cost_value, movement_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      parts.forEach((x, i) => lineStmt.run(debitNoteId, x.line.id, x.qty, x.taxable, x.cgst, x.sgst, x.igst, x.total, -moved[i]!.costValue, moved[i]!.id));

      const tax = sum((x) => x.cgst + x.sgst + x.igst);
      const reversedGst = p.itc_claimed ? tax : 0;
      const difference = total - reversedGst - costTotal;
      postLedger(tx, {
        refType: 'DEBIT_NOTE',
        refId: debitNoteId,
        memo: `Debit note ${debitNoteNo}: goods returned to ${p.supplier_name}`,
        lines: [
          { account: 'AP', debit: total, partyType: 'SUPPLIER', partyId: p.supplier_id },
          { account: 'INPUT_GST', credit: reversedGst },
          { account: 'INVENTORY', credit: costTotal },
          { account: 'INVENTORY_LOSS', credit: Math.max(0, difference) },
          { account: 'INVENTORY_LOSS', debit: Math.max(0, -difference) },
        ],
      });

      // The credit settles this bill first.
      const onBill = Math.min(total, payableOutstanding(tx.db, 'PURCHASE', p.id));
      allocateSupplier(tx, { type: 'DEBIT_NOTE', id: debitNoteId }, { type: 'PURCHASE', id: p.id }, onBill);
      let refunded = 0;
      if (input.settlement === 'REFUND' && total - onBill > 0) {
        refunded = total - onBill;
        receiveSupplierRefundTx(
          tx,
          {
            requestId: `${input.requestId}:refund`,
            supplierId: p.supplier_id,
            amount: refunded,
            methodId: input.refundMethodId!,
            reference: input.reference,
            reason: `Refund for ${debitNoteNo}`,
          },
          { type: 'DEBIT_NOTE', id: debitNoteId },
        );
      } else {
        applySupplierCreditFifo(tx, p.supplier_id, { onlySource: { type: 'DEBIT_NOTE', id: debitNoteId } });
      }

      tx.audit({
        module: 'purchases',
        entityType: 'purchase',
        entityId: p.id,
        action: 'SUPPLIER_RETURN',
        after: {
          debitNoteNo,
          items: parts.length,
          totalAmount: total,
          appliedToBillAmount: onBill,
          refundedAmount: refunded,
          stockRemovedValue: costTotal,
          stockAdjustmentAmount: difference,
        },
        reason: input.reason,
        relatedType: 'debit_note',
        relatedId: debitNoteId,
      });
      return { debitNoteId, debitNoteNo, total };
    }),
  );
}

// ---------- Queries ----------

interface PurchaseListRecord {
  id: number;
  purchase_no: string;
  supplier_id: number;
  supplier_name: string;
  supplier_invoice_no: string;
  supplier_invoice_date: string;
  business_date: string;
  due_date: string;
  grand_total: number;
  outstanding: number;
  cancelled: number;
  replaced: number;
  items: number;
  returned: number;
  username: string | null;
}

const REPLACED = 'EXISTS (SELECT 1 FROM purchase_revisions r WHERE r.purchase_id = p.id)';

const LIST_SELECT = `
  SELECT p.id, p.purchase_no, p.supplier_id, s.name AS supplier_name, p.supplier_invoice_no, p.supplier_invoice_date,
         p.business_date, p.due_date, p.grand_total, b.outstanding, b.cancelled, ${REPLACED} AS replaced, u.username,
         (SELECT COUNT(*) FROM purchase_lines l WHERE l.purchase_id = p.id) AS items,
         COALESCE((SELECT SUM(d.total) FROM debit_notes d WHERE d.purchase_id = p.id), 0) AS returned
  FROM purchases p
  JOIN suppliers s ON s.id = p.supplier_id
  JOIN v_purchase_balances b ON b.purchase_id = p.id
  LEFT JOIN users u ON u.id = p.user_id`;

function statusOf(r: { cancelled: number; replaced: number; outstanding: number; grand_total: number }): PurchaseStatus {
  if (r.replaced) return 'REPLACED';
  if (r.cancelled) return 'CANCELLED';
  if (r.outstanding <= 0) return 'PAID';
  return r.outstanding < r.grand_total ? 'PARTIAL' : 'UNPAID';
}

const toRow = (r: PurchaseListRecord, asOf: string): PurchaseRow => ({
  id: r.id,
  purchaseNo: r.purchase_no,
  supplierId: r.supplier_id,
  supplierName: r.supplier_name,
  supplierInvoiceNo: r.supplier_invoice_no,
  supplierInvoiceDate: r.supplier_invoice_date,
  businessDate: r.business_date,
  dueDate: r.due_date,
  itemCount: r.items,
  grandTotal: r.grand_total,
  outstanding: r.cancelled ? 0 : r.outstanding,
  returnedTotal: r.returned,
  status: statusOf(r),
  overdue: !r.cancelled && r.outstanding > 0 && r.due_date < asOf,
  username: r.username,
});

export function listPurchases(
  db: Db,
  f: {
    search?: string;
    supplierId?: number;
    productId?: number;
    status: 'ALL' | 'PAID' | 'PARTIAL' | 'UNPAID' | 'OPEN' | 'OVERDUE' | 'CANCELLED' | 'REPLACED';
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
  },
  asOf: string,
): Paged<PurchaseRow> {
  const where: string[] = [];
  const params: unknown[] = [];
  // Earlier versions of edited bills are listed only when asked for; the current version stands for the bill.
  where.push(f.status === 'REPLACED' ? REPLACED : `NOT ${REPLACED}`);
  if (f.supplierId) {
    where.push('p.supplier_id = ?');
    params.push(f.supplierId);
  }
  if (f.productId) {
    where.push('EXISTS (SELECT 1 FROM purchase_lines l WHERE l.purchase_id = p.id AND l.product_id = ?)');
    params.push(f.productId);
  }
  if (f.from) {
    where.push('p.supplier_invoice_date >= ?');
    params.push(f.from);
  }
  if (f.to) {
    where.push('p.supplier_invoice_date <= ?');
    params.push(f.to);
  }
  if (f.search) {
    const like = `%${f.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push("(p.purchase_no LIKE ? ESCAPE '\\' OR p.supplier_invoice_no LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  switch (f.status) {
    case 'PAID':
      where.push('b.cancelled = 0 AND b.outstanding <= 0');
      break;
    case 'PARTIAL':
      where.push('b.cancelled = 0 AND b.outstanding > 0 AND b.outstanding < p.grand_total');
      break;
    case 'UNPAID':
      where.push('b.cancelled = 0 AND b.outstanding > 0 AND b.outstanding = p.grand_total');
      break;
    case 'OPEN':
      where.push('b.cancelled = 0 AND b.outstanding > 0');
      break;
    case 'OVERDUE':
      where.push('b.cancelled = 0 AND b.outstanding > 0 AND p.due_date < ?');
      params.push(asOf);
      break;
    case 'CANCELLED':
      where.push('b.cancelled = 1');
      break;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM purchases p JOIN suppliers s ON s.id = p.supplier_id JOIN v_purchase_balances b ON b.purchase_id = p.id ${clause}`,
      )
      .get(...params) as { n: number }
  ).n;
  const rows = db
    .prepare(`${LIST_SELECT} ${clause} ORDER BY p.supplier_invoice_date DESC, p.id DESC LIMIT ? OFFSET ?`)
    .all(...params, f.pageSize, (f.page - 1) * f.pageSize) as PurchaseListRecord[];
  return { rows: rows.map((r) => toRow(r, asOf)), total, page: f.page, pageSize: f.pageSize };
}

export function getPurchase(db: Db, id: number, asOf: string): PurchaseDetail {
  const r = db.prepare(`${LIST_SELECT} WHERE p.id = ?`).get(id) as PurchaseListRecord | undefined;
  if (!r) throw new AppError(ErrorCodes.NOT_FOUND, 'Purchase not found.');
  const p = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id) as PurchaseRecord & {
    supplier_gstin: string;
    supplier_state_code: string;
    is_interstate: number;
    prices_include_tax: number;
    gross_total: number;
    discount_total: number;
    taxable_total: number;
    additional_costs: number;
    additional_costs_note: string;
    notes: string;
    received_at: string;
  };
  const lines = (
    db
      .prepare(
        `SELECT l.*, u.allow_decimal, COALESCE((SELECT SUM(d.qty) FROM debit_note_lines d WHERE d.purchase_line_id = l.id), 0) AS returned_qty
         FROM purchase_lines l JOIN products pr ON pr.id = l.product_id JOIN units u ON u.id = pr.unit_id
         WHERE l.purchase_id = ? ORDER BY l.line_no`,
      )
      .all(id) as (PurchaseLineRecord & {
      sku: string;
      hsn_code: string;
      unit_cost: number;
      gross: number;
      line_discount: number;
      bill_discount: number;
      gst_rate_bp: number;
      additional_cost: number;
      returned_qty: number;
    })[]
  ).map(
    (l): PurchaseLineDetail => ({
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
      unitCost: l.unit_cost,
      gross: l.gross,
      lineDiscount: l.line_discount,
      billDiscount: l.bill_discount,
      taxable: l.taxable,
      gstRateBp: l.gst_rate_bp,
      cgst: l.cgst,
      sgst: l.sgst,
      igst: l.igst,
      lineTotal: l.line_total,
      additionalCost: l.additional_cost,
      landedValue: l.landed_value,
      landedUnitCost: mulDivRound(l.landed_value, QTY_SCALE, l.qty),
    }),
  );
  const settlements = db
    .prepare(
      `SELECT a.source_type AS kind, a.source_id AS id, SUM(a.amount) AS amount, MIN(a.created_at) AS at,
              CASE a.source_type WHEN 'PAYMENT' THEN (SELECT payment_no FROM payments WHERE id = a.source_id)
                WHEN 'DEBIT_NOTE' THEN (SELECT debit_note_no FROM debit_notes WHERE id = a.source_id)
                ELSE 'Balance adjustment' END AS docNo
       FROM supplier_allocations a WHERE a.target_type = 'PURCHASE' AND a.target_id = ?
       GROUP BY a.source_type, a.source_id HAVING SUM(a.amount) != 0 ORDER BY at`,
    )
    .all(id) as PurchaseSettlement[];
  const debitNotes = (
    db
      .prepare(
        `SELECT d.id, d.debit_note_no, d.issued_at, d.total, d.settlement, d.reason, u.username
         FROM debit_notes d LEFT JOIN users u ON u.id = d.user_id WHERE d.purchase_id = ? ORDER BY d.id`,
      )
      .all(id) as { id: number; debit_note_no: string; issued_at: string; total: number; settlement: 'ADJUST' | 'REFUND'; reason: string; username: string | null }[]
  ).map(
    (d): DebitNoteSummary => ({ id: d.id, debitNoteNo: d.debit_note_no, issuedAt: d.issued_at, total: d.total, settlement: d.settlement, reason: d.reason, username: d.username }),
  );
  const c = db
    .prepare('SELECT c.cancelled_at, c.reason, u.username FROM purchase_cancellations c LEFT JOIN users u ON u.id = c.user_id WHERE c.purchase_id = ?')
    .get(id) as { cancelled_at: string; reason: string; username: string | null } | undefined;
  const { version, versions, replacedBy: replaced } = purchaseVersions(db, id);
  return {
    ...toRow(r, asOf),
    supplierGstin: p.supplier_gstin,
    supplierStateCode: p.supplier_state_code,
    isInterstate: p.is_interstate === 1,
    pricesIncludeTax: p.prices_include_tax === 1,
    itcClaimed: p.itc_claimed === 1,
    grossTotal: p.gross_total,
    discountTotal: p.discount_total,
    taxableTotal: p.taxable_total,
    cgstTotal: p.cgst_total,
    sgstTotal: p.sgst_total,
    igstTotal: p.igst_total,
    additionalCosts: p.additional_costs,
    additionalCostsNote: p.additional_costs_note,
    roundOff: p.round_off,
    inventoryValue: p.inventory_value,
    notes: p.notes,
    receivedAt: p.received_at,
    lines,
    settlements,
    debitNotes,
    cancellation: c && !replaced ? { at: c.cancelled_at, reason: c.reason, username: c.username } : null,
    version,
    versions,
    replacedBy: replaced,
  };
}

/** The versions of the bill a purchase belongs to, and the edit that replaced it, if any. */
function purchaseVersions(db: Db, id: number): Pick<PurchaseDetail, 'version' | 'versions' | 'replacedBy'> {
  const own = db.prepare('SELECT original_purchase_id AS originalId FROM purchase_revisions WHERE revised_purchase_id = ?').get(id) as
    | { originalId: number }
    | undefined;
  const originalId = own?.originalId ?? id;
  const first = db
    .prepare('SELECT p.id, p.purchase_no, p.received_at, u.username FROM purchases p LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ?')
    .get(originalId) as { id: number; purchase_no: string; received_at: string; username: string | null };
  const edits = db
    .prepare(
      `SELECT r.purchase_id, r.revised_purchase_id, r.revision, r.reason, r.revised_at, p.purchase_no, u.username
       FROM purchase_revisions r JOIN purchases p ON p.id = r.revised_purchase_id LEFT JOIN users u ON u.id = r.user_id
       WHERE r.original_purchase_id = ? ORDER BY r.revision`,
    )
    .all(originalId) as { purchase_id: number; revised_purchase_id: number; revision: number; reason: string; revised_at: string; purchase_no: string; username: string | null }[];
  const versions: PurchaseVersion[] = [
    { id: first.id, purchaseNo: first.purchase_no, version: 1, savedAt: first.received_at, username: first.username, reason: null },
    ...edits.map((e) => ({ id: e.revised_purchase_id, purchaseNo: e.purchase_no, version: e.revision, savedAt: e.revised_at, username: e.username, reason: e.reason })),
  ];
  const next = edits.find((e) => e.purchase_id === id);
  return {
    version: versions.find((v) => v.id === id)?.version ?? 1,
    versions,
    replacedBy: next ? { id: next.revised_purchase_id, purchaseNo: next.purchase_no, at: next.revised_at, username: next.username, reason: next.reason } : null,
  };
}
