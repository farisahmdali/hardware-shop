export const MOVEMENT_TYPES = {
  OPENING: { label: 'Opening stock', direction: 'in' },
  RECEIPT: { label: 'Stock received', direction: 'in' },
  PURCHASE: { label: 'Purchase', direction: 'in' },
  PURCHASE_CANCEL: { label: 'Purchase cancelled', direction: 'out' },
  ADJUST_IN: { label: 'Correction (added)', direction: 'in' },
  ADJUST_OUT: { label: 'Correction (removed)', direction: 'out' },
  DAMAGE: { label: 'Damaged', direction: 'out' },
  LOSS: { label: 'Lost / missing', direction: 'out' },
  SALE: { label: 'Sale', direction: 'out' },
  SALE_CANCEL: { label: 'Sale cancelled', direction: 'in' },
  CUSTOMER_RETURN: { label: 'Customer return', direction: 'in' },
  SUPPLIER_RETURN: { label: 'Returned to supplier', direction: 'out' },
  RECONCILE: { label: 'Stock count correction', direction: 'both' },
} as const;

export type MovementType = keyof typeof MOVEMENT_TYPES;
export const MOVEMENT_TYPE_KEYS = Object.keys(MOVEMENT_TYPES) as [MovementType, ...MovementType[]];

/** Manual stock operations available on the product screen. */
export const MANUAL_ADJUSTMENTS = ['RECEIPT', 'ADJUST_IN', 'ADJUST_OUT', 'DAMAGE', 'LOSS'] as const;
export type ManualAdjustment = (typeof MANUAL_ADJUSTMENTS)[number];

/**
 * GST rates in basis points. 5%, 18% and 40% are the current slabs; 12% and 28%
 * remain selectable for goods still priced at the older slabs.
 */
export const GST_RATES_BP = [0, 25, 300, 500, 1200, 1800, 2800, 4000] as const;

export const formatRate = (bp: number): string => `${bp / 100}%`;

export type StockStatus = 'IN_STOCK' | 'LOW' | 'OUT';

/** Out of stock at zero or below; low when at or below a configured minimum. */
export function stockStatus(qty: number, minQty: number): StockStatus {
  if (qty <= 0) return 'OUT';
  if (minQty > 0 && qty <= minQty) return 'LOW';
  return 'IN_STOCK';
}
