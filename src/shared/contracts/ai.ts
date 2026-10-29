import { z } from 'zod';
import { command } from './define';
import type { ProductListRow } from './inventory';
import type { SupplierRow } from './purchases';

// ---------- Types returned to the renderer ----------

export interface AiStatus {
  enabled: boolean;
  model: string;
  hasKey: boolean;
  /** Last characters of the saved key, so the owner can tell which key it is. Only for settings managers. */
  keyEnding: string | null;
  /** The key can be stored encrypted on this computer. */
  canStoreKey: boolean;
  /** Switched on, with a key and a model: bills can be scanned. */
  ready: boolean;
  monthlyScanLimit: number;
  /** Bills read this calendar month, including ones that failed. */
  scansThisMonth: number;
}

export interface AiTestResult {
  model: string;
  modelName: string;
  readsImages: boolean;
  /** The model reads PDF files itself; otherwise OpenRouter converts them to text first. */
  readsPdf: boolean;
  structuredOutput: boolean;
  /** Credit left on the key in US dollars, when OpenRouter reports one. */
  creditLeft: number | null;
}

export type ScanMatchHow = 'REMEMBERED' | 'CODE' | 'BEST';

export interface ScanCandidate {
  product: ProductListRow;
  /** 0–100. */
  score: number;
  reasons: string[];
}

export interface ScanLine {
  /** Position on the bill, from 0. */
  index: number;
  /** The item as printed on the bill. */
  text: string;
  hsnCode: string;
  /** Unit as printed (NOS, BOX, KG, …) and the shop unit it corresponds to. */
  unitText: string;
  unitId: number | null;
  /** Milli-units. */
  qty: number;
  /** Paise per unit, as on the bill. */
  rate: number;
  discountBp: number;
  gstRateBp: number;
  /** Line amount printed on the bill, when there is one. */
  printedAmount: number | null;
  match: { product: ProductListRow; how: ScanMatchHow } | null;
  candidates: ScanCandidate[];
}

export type ScanSupplier = Pick<SupplierRow, 'id' | 'name' | 'gstin' | 'stateCode'>;

export interface ScanDraft {
  scanId: string;
  fileName: string;
  /** The bill image for display (a data URL); null for PDFs. */
  preview: string | null;
  model: string;
  supplier: {
    match: ScanSupplier | null;
    how: 'GSTIN' | 'NAME' | null;
    /** As printed on the bill, for adding the supplier. */
    name: string;
    gstin: string;
    stateCode: string;
    phone: string;
    address: string;
  };
  supplierInvoiceNo: string;
  supplierInvoiceDate: string | null;
  pricesIncludeTax: boolean;
  lines: ScanLine[];
  additionalCosts: number;
  additionalCostsNote: string;
  roundOff: number;
  /** Grand total printed on the bill. */
  printedTotal: number | null;
  warnings: string[];
}

export interface SupplierItemName {
  id: number;
  itemText: string;
  productId: number;
  productName: string;
  sku: string;
  uses: number;
  lastUsedAt: string;
}

// ---------- Input schemas ----------

const id = z.number().int().positive();

export const aiCommands = {
  'ai.status': command<AiStatus>()(z.object({})),
  'ai.setKey': command<AiStatus>()(
    z.object({
      key: z
        .string()
        .trim()
        .min(20, 'Paste the whole API key')
        .max(300)
        .regex(/^[\x21-\x7e]+$/, 'The key contains spaces or characters a key does not have'),
    }),
  ),
  'ai.clearKey': command<AiStatus>()(z.object({})),
  /** Checks the saved key and a model (the one typed, or the saved one). */
  'ai.test': command<AiTestResult>()(z.object({ model: z.string().trim().max(120).optional() })),
  /** Asks for a bill file and reads it. Nothing is saved except the history entry. */
  'ai.scanBill': command<ScanDraft | null>()(z.object({})),

  'supplierItemNames.list': command<SupplierItemName[]>()(z.object({ supplierId: id })),
  'supplierItemNames.remove': command<SupplierItemName[]>()(z.object({ id, supplierId: id })),
};
