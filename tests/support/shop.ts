import { randomUUID } from 'node:crypto';
import type { Actor } from '@main/db/tx';
import type { AppEnv } from '@main/services/env';
import { createCustomer } from '@main/services/customers';
import { createExpense, listExpenseCategories } from '@main/services/expenses';
import { listPaymentMethods, receivePayment } from '@main/services/payments';
import { createProduct } from '@main/services/products';
import { createPurchase, type PurchaseInput } from '@main/services/purchases';
import { createRentalProduct } from '@main/services/rentalCatalog';
import { createRental, getRental, quoteRental, returnItems, settleDeposit } from '@main/services/rentals';
import { finalizeSale, type FinalizeInput, type SalesPermissions } from '@main/services/sales';
import { getAllSettings } from '@main/services/settings';
import { createSupplier } from '@main/services/suppliers';
import { computeBill } from '@shared/billing';
import { ALL_PERMISSIONS } from '@shared/permissions';
import { claimsInputGst, computePurchase } from '@shared/purchasing';
import { businessDateOf } from '@shared/time';

export const OWNER_PERMS: SalesPermissions = { permissions: ALL_PERMISSIONS, maxDiscountBp: 10_000 };
export const rupees = (r: number) => Math.round(r * 100);
export const units = (n: number) => Math.round(n * 1000);

export interface PricedProduct {
  id: number;
  sellingPrice: number;
  gstRateBp: number;
  priceIncludesTax: boolean;
}

/**
 * Builds shop records through the same services and calculations the screens use, so the data
 * is exactly what real use produces. Shared by the recovery, randomized and performance tests.
 */
export class ShopData {
  readonly cash: number;
  readonly upi: number;
  private billNo = 0;

  constructor(
    readonly env: AppEnv,
    readonly actor: Actor,
  ) {
    const methods = listPaymentMethods(env.db, false);
    this.cash = methods.find((m) => m.kind === 'CASH')!.id;
    this.upi = methods.find((m) => m.kind === 'UPI')!.id;
  }

  today(): string {
    return businessDateOf(this.env.clock.now(), this.env.timeZone);
  }

  unitId(code: string): number {
    return (this.env.db.prepare('SELECT id FROM units WHERE code = ?').get(code) as { id: number }).id;
  }

  product(name: string, o: { price: number; cost: number; qty?: number; unit?: string; gstRateBp?: number; categoryId?: number | null; hsn?: string }) {
    return createProduct(
      this.env,
      this.actor,
      {
        requestId: randomUUID(),
        sku: '',
        name,
        categoryId: o.categoryId ?? null,
        brandId: null,
        unitId: this.unitId(o.unit ?? 'PCS'),
        description: '',
        hsnCode: o.hsn ?? '8205',
        gstRateBp: o.gstRateBp ?? 1800,
        priceIncludesTax: true,
        purchasePrice: o.cost,
        sellingPrice: o.price,
        minStockQty: units(2),
        preferredSupplierId: null,
        notes: '',
        openingQty: o.qty ?? 0,
        openingUnitCost: o.qty ? o.cost : undefined,
      },
      true,
    );
  }

  customer(name: string, phone = '', creditDays = 30) {
    return createCustomer(this.env, this.actor, {
      requestId: randomUUID(),
      name,
      phone,
      address: '',
      businessName: '',
      gstin: '',
      stateCode: '27',
      creditDays,
      creditLimit: 0,
      notes: '',
      openingBalance: 0,
    });
  }

  supplier(name: string, gstin = '27AAPFU0939F1ZV') {
    return createSupplier(this.env, this.actor, {
      requestId: randomUUID(),
      name,
      phone: '',
      address: '',
      businessName: '',
      gstin,
      stateCode: '27',
      creditDays: 30,
      notes: '',
      openingBalance: 0,
    });
  }

  /** A sale as the billing screen sends it. `pay`: 'all', 'none' or an amount in paise. */
  saleInput(customerId: number, lines: { p: PricedProduct; qty: number }[], pay: 'all' | 'none' | number = 'all', methodId = this.cash): FinalizeInput {
    const settings = getAllSettings(this.env.db);
    const bill = computeBill(
      lines.map((l) => ({ unitPrice: l.p.sellingPrice, qty: l.qty, gstRateBp: l.p.gstRateBp, priceIncludesTax: l.p.priceIncludesTax, discount: null })),
      { interstate: false, gstRegistered: settings.tax.gstRegistered, roundTotal: settings.tax.roundInvoiceTotal, billDiscount: null },
    );
    const amount = pay === 'all' ? bill.grandTotal : pay === 'none' ? 0 : Math.min(pay, bill.grandTotal);
    return {
      requestId: randomUUID(),
      customerId,
      walkInName: '',
      walkInPhone: '',
      lines: lines.map((l) => ({ productId: l.p.id, qty: l.qty, discount: null, expectedUnitPrice: l.p.sellingPrice })),
      billDiscount: null,
      payments: amount > 0 ? [{ methodId, amount, reference: '' }] : [],
      useCredit: 0,
      notes: '',
      expectedGrandTotal: bill.grandTotal,
    };
  }

  sell(customerId: number, lines: { p: PricedProduct; qty: number }[], pay: 'all' | 'none' | number = 'all', methodId = this.cash) {
    return finalizeSale(this.env, this.actor, OWNER_PERMS, this.saleInput(customerId, lines, pay, methodId));
  }

  /** A purchase bill as the purchase screen sends it (costs before GST). */
  purchaseInput(supplierId: number, lines: { productId: number; qty: number; cost: number }[], pay = 0): PurchaseInput {
    const settings = getAllSettings(this.env.db);
    const gstin = (this.env.db.prepare('SELECT gstin FROM suppliers WHERE id = ?').get(supplierId) as { gstin: string }).gstin;
    // A supplier without a GSTIN cannot charge GST.
    const inputLines = lines.map((l) => ({ productId: l.productId, qty: l.qty, unitCost: l.cost, gstRateBp: gstin ? 1800 : 0, discount: null }));
    const calc = computePurchase(inputLines, {
      pricesIncludeTax: false,
      interstate: false,
      billDiscount: null,
      additionalCosts: 0,
      roundOff: 0,
      itcClaimed: claimsInputGst({ claimInputGst: settings.purchases.claimInputGst, gstRegistered: settings.tax.gstRegistered }, gstin),
    });
    return {
      requestId: randomUUID(),
      supplierId,
      supplierInvoiceNo: `SB-${++this.billNo}-${randomUUID().slice(0, 4)}`,
      supplierInvoiceDate: this.today(),
      pricesIncludeTax: false,
      lines: inputLines,
      billDiscount: null,
      additionalCosts: 0,
      additionalCostsNote: '',
      roundOff: 0,
      notes: '',
      payments: pay > 0 ? [{ methodId: this.cash, amount: Math.min(pay, calc.grandTotal), reference: '' }] : [],
      updatePurchasePrices: false,
      expectedGrandTotal: calc.grandTotal,
    };
  }

  buy(supplierId: number, lines: { productId: number; qty: number; cost: number }[], pay = 0) {
    return createPurchase(this.env, this.actor, this.purchaseInput(supplierId, lines, pay));
  }

  paymentInput(customerId: number, amount: number, methodId = this.upi) {
    return { requestId: randomUUID(), customerId, amount, methodId, reference: '', notes: '', allocations: [] };
  }

  receive(customerId: number, amount: number, methodId = this.upi) {
    return receivePayment(this.env, this.actor, this.paymentInput(customerId, amount, methodId));
  }

  rentalProduct(name: string, count: number, dayRate: number, deposit: number) {
    const id = createRentalProduct(this.env, this.actor, {
      requestId: randomUUID(),
      name,
      categoryId: null,
      brand: '',
      model: '',
      description: '',
      depositAmount: deposit,
      sacCode: '997319',
      gstRateBp: 1800,
      priceIncludesTax: true,
      notes: '',
      rates: [
        { unit: 'DAY', label: '', price: dayRate },
        { unit: 'WEEK', label: '', price: dayRate * 5 },
      ],
      units: count,
      serials: [],
      purchaseCost: dayRate * 20,
      purchaseDate: '2025-01-10',
    });
    const assetIds = (this.env.db.prepare('SELECT id FROM rental_assets WHERE rental_product_id = ? ORDER BY id').all(id) as { id: number }[]).map((r) => r.id);
    return { id, assetIds };
  }

  /** Issues units now for `days` days, collecting the deposit in cash; charges are left on account. */
  rent(customerId: number, assetIds: number[], days: number, deposit: number) {
    const nowIso = this.env.clock.now().toISOString();
    const expectedReturnAt = new Date(this.env.clock.now().getTime() + days * 86_400_000).toISOString();
    const quote = quoteRental(this.env.db, { customerId, assetIds, expectedReturnAt, reserve: false, discount: null }, nowIso);
    return createRental(this.env, this.actor, OWNER_PERMS, {
      requestId: randomUUID(),
      customerId,
      assetIds,
      reserve: false,
      expectedReturnAt,
      discount: null,
      expectedChargesTotal: quote.billNow.grandTotal,
      deposit: { amount: deposit, methodId: deposit > 0 ? this.cash : undefined, reference: '' },
      payments: [],
      notes: '',
      terms: '',
      saleLines: [],
      expectedSaleTotal: 0,
    });
  }

  /** Returns every unit in good condition, then uses the deposit for what is owed and refunds the rest. */
  returnAndSettle(rentalId: number) {
    const nowIso = () => this.env.clock.now().toISOString();
    const r = getRental(this.env.db, rentalId, nowIso());
    returnItems(this.env, this.actor, OWNER_PERMS, {
      requestId: randomUUID(),
      id: rentalId,
      version: r.version,
      payments: [],
      items: r.items
        .filter((i) => i.status === 'OUT')
        .map((i) => ({ itemId: i.id, condition: 'GOOD' as const, notes: '', nextStatus: 'AVAILABLE' as const, damageCharge: 0, damageReason: '', lateFeeReason: '' })),
    });
    const after = getRental(this.env.db, rentalId, nowIso());
    const apply = Math.min(after.outstanding, after.depositHeld);
    const refund = after.depositHeld - apply;
    if (after.depositHeld > 0) {
      settleDeposit(this.env, this.actor, OWNER_PERMS, {
        requestId: randomUUID(),
        id: rentalId,
        applyAmount: apply,
        applyReason: apply > 0 ? 'Rental charges' : '',
        refundAmount: refund,
        refundMethodId: refund > 0 ? this.cash : undefined,
        refundReference: '',
      });
    }
    return getRental(this.env.db, rentalId, nowIso());
  }

  expense(amount: number, description = 'Shop expense') {
    const category = listExpenseCategories(this.env.db, false)[0]!.id;
    return createExpense(this.env, this.actor, {
      requestId: randomUUID(),
      categoryId: category,
      description,
      amount,
      expenseDate: this.today(),
      methodId: this.cash,
      payee: '',
      reference: '',
      notes: '',
    });
  }
}
