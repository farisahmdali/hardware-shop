import { computeBill, spread, type Discount } from './billing';

export interface PurchaseLineAmounts {
  unitCost: number;
  qty: number;
  gstRateBp: number;
  discount: Discount | null;
}

export interface PurchaseOptions {
  pricesIncludeTax: boolean;
  interstate: boolean;
  billDiscount: Discount | null;
  additionalCosts: number;
  roundOff: number;
  /** Input GST is recoverable, so it is kept out of the stock value. */
  itcClaimed: boolean;
}

/**
 * The amounts of a purchase bill, shared by the entry screen (live totals) and the main process
 * (the figures saved). GST is worked out exactly as on a sales bill. Freight and other charges are
 * spread across the lines by taxable value (by quantity when everything is free) to give each
 * line's landed cost. Claimed input GST stays out of stock value; otherwise it is part of the cost.
 */
export function computePurchase(lines: PurchaseLineAmounts[], opts: PurchaseOptions) {
  const bill = computeBill(
    lines.map((l) => ({ unitPrice: l.unitCost, qty: l.qty, gstRateBp: l.gstRateBp, priceIncludesTax: opts.pricesIncludeTax, discount: l.discount })),
    { interstate: opts.interstate, gstRegistered: true, roundTotal: false, billDiscount: opts.billDiscount },
  );
  const byValue = bill.lines.map((l) => l.taxable);
  const weights = byValue.some((v) => v > 0) ? byValue : lines.map((l) => l.qty);
  const additionalShare = spread(opts.additionalCosts, weights);
  const landed = bill.lines.map((l, i) => l.taxable + additionalShare[i]! + (opts.itcClaimed ? 0 : l.cgst + l.sgst + l.igst));
  return {
    bill,
    additionalShare,
    landed,
    inventoryValue: landed.reduce((a, b) => a + b, 0),
    /** Amount owed to the supplier. */
    grandTotal: bill.grandTotal + opts.additionalCosts + opts.roundOff,
  };
}

/** Whether GST paid to this supplier can be claimed back (kept out of stock cost). */
export function claimsInputGst(settings: { claimInputGst: boolean; gstRegistered: boolean }, supplierGstin: string): boolean {
  return settings.claimInputGst && settings.gstRegistered && supplierGstin !== '';
}
