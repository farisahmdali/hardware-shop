import { useSyncExternalStore } from 'react';
import type { CartDraft, DiscountInput, ProductListRow } from '@shared/contracts';

/** What the bill needs to know about a product, captured when it is added. */
export interface CartProduct {
  id: number;
  sku: string;
  name: string;
  unitCode: string;
  allowDecimal: boolean;
  sellingPrice: number;
  gstRateBp: number;
  priceIncludesTax: boolean;
  stockQty: number;
}

export interface CartLine {
  key: string;
  product: CartProduct;
  qty: number;
  discount: DiscountInput;
}

export interface CartCustomer {
  id: number;
  name: string;
  phone: string;
  stateCode: string;
  isWalkin: boolean;
  balance: number;
  availableCredit: number;
  creditLimit: number;
}

export interface CartState {
  customer: CartCustomer | null;
  walkInName: string;
  walkInPhone: string;
  lines: CartLine[];
  billDiscount: DiscountInput;
  notes: string;
  /** Changes for every new bill, so the finalize request id is fresh per bill but stable across retries. */
  billId: string;
}

const emptyCart = (): CartState => ({
  customer: null,
  walkInName: '',
  walkInPhone: '',
  lines: [],
  billDiscount: null,
  notes: '',
  billId: crypto.randomUUID(),
});

let state: CartState = emptyCart();
const listeners = new Set<() => void>();

function set(next: CartState): void {
  state = next;
  for (const l of listeners) l();
}

export const cart = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  reset() {
    set(emptyCart());
  },
  setCustomer(customer: CartCustomer | null) {
    set({ ...state, customer });
  },
  setWalkIn(name: string, phone: string) {
    set({ ...state, walkInName: name, walkInPhone: phone });
  },
  addProduct(p: ProductListRow | CartProduct, qty = 1000) {
    const product: CartProduct =
      'stockQty' in p
        ? p
        : {
            id: p.id,
            sku: p.sku,
            name: p.name,
            unitCode: p.unitCode,
            allowDecimal: p.allowDecimal,
            sellingPrice: p.sellingPrice,
            gstRateBp: p.gstRateBp,
            priceIncludesTax: p.priceIncludesTax,
            stockQty: p.qty,
          };
    const existing = state.lines.find((l) => l.product.id === product.id && !l.discount);
    if (existing) {
      set({ ...state, lines: state.lines.map((l) => (l === existing ? { ...l, qty: l.qty + qty, product } : l)) });
    } else {
      set({ ...state, lines: [...state.lines, { key: crypto.randomUUID(), product, qty, discount: null }] });
    }
  },
  updateLine(key: string, patch: Partial<Pick<CartLine, 'qty' | 'discount' | 'product'>>) {
    set({ ...state, lines: state.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) });
  },
  removeLine(key: string) {
    set({ ...state, lines: state.lines.filter((l) => l.key !== key) });
  },
  setBillDiscount(discount: DiscountInput) {
    set({ ...state, billDiscount: discount });
  },
  setNotes(notes: string) {
    set({ ...state, notes });
  },
  toDraft(): CartDraft {
    return {
      customerId: state.customer?.isWalkin ? null : (state.customer?.id ?? null),
      walkInName: state.walkInName,
      walkInPhone: state.walkInPhone,
      lines: state.lines.map((l) => ({ productId: l.product.id, qty: l.qty, discount: l.discount })),
      billDiscount: state.billDiscount,
      notes: state.notes,
    };
  },
  load(next: Omit<CartState, 'billId'>) {
    set({ ...next, billId: crypto.randomUUID() });
  },
};

export function useCart(): CartState {
  return useSyncExternalStore(cart.subscribe, cart.get);
}
