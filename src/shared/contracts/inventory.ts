import { z } from 'zod';
import { command, type Paged } from './define';
import { GST_RATES_BP, MANUAL_ADJUSTMENTS, MOVEMENT_TYPE_KEYS, type MovementType, type StockStatus } from '../stock';

// ---------- Types returned to the renderer ----------

export interface CategoryRow {
  id: number;
  kind: 'PRODUCT' | 'RENTAL' | 'EXPENSE';
  name: string;
  isActive: boolean;
  version: number;
  usageCount: number;
}

export interface BrandRow {
  id: number;
  name: string;
  isActive: boolean;
  version: number;
  usageCount: number;
}

export interface UnitRow {
  id: number;
  code: string;
  name: string;
  allowDecimal: boolean;
  isActive: boolean;
  version: number;
  usageCount: number;
}

export interface SupplierRef {
  id: number;
  code: string;
  name: string;
  phone: string;
  isActive: boolean;
}

export interface CatalogData {
  categories: CategoryRow[];
  brands: BrandRow[];
  units: UnitRow[];
  suppliers: SupplierRef[];
}

export interface ProductListRow {
  id: number;
  sku: string;
  name: string;
  categoryName: string | null;
  brandName: string | null;
  unitCode: string;
  allowDecimal: boolean;
  gstRateBp: number;
  priceIncludesTax: boolean;
  sellingPrice: number;
  /** Null when the user may not see costs. */
  purchasePrice: number | null;
  qty: number;
  minStockQty: number;
  /** Inventory value at weighted-average cost; null when the user may not see costs. */
  stockValue: number | null;
  status: StockStatus;
  isActive: boolean;
}

export interface ProductDetail extends ProductListRow {
  categoryId: number | null;
  brandId: number | null;
  unitId: number;
  unitName: string;
  description: string;
  hsnCode: string;
  preferredSupplierId: number | null;
  supplierName: string | null;
  notes: string;
  /** Weighted-average cost per unit (paise), null when unknown or hidden. */
  averageCost: number | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface MovementRow {
  id: number;
  productId: number;
  sku: string;
  productName: string;
  unitCode: string;
  type: MovementType;
  qtyBefore: number;
  qtyChange: number;
  qtyAfter: number;
  unitCost: number | null;
  costValue: number | null;
  reason: string | null;
  refType: string | null;
  refId: string | null;
  username: string | null;
  occurredAt: string;
  negativeOverride: boolean;
}

export interface StockSummary {
  activeProducts: number;
  inventoryValue: number | null;
  /** Stock valued at current selling prices, as printed (may include GST). */
  retailValue: number;
  lowStock: number;
  outOfStock: number;
  recentMovements: MovementRow[];
}

export interface StockCountRow {
  id: number;
  countNo: string;
  status: 'OPEN' | 'FINALIZED' | 'CANCELLED';
  categoryName: string | null;
  notes: string;
  startedAt: string;
  startedBy: string | null;
  closedAt: string | null;
  closedBy: string | null;
  closeReason: string | null;
  lineCount: number;
  countedCount: number;
  varianceCount: number;
  version: number;
}

export interface StockCountLine {
  productId: number;
  sku: string;
  name: string;
  unitCode: string;
  allowDecimal: boolean;
  /** Quantity when the count started. */
  systemQty: number;
  /** Quantity now (open counts) or when finalized. */
  currentQty: number;
  countedQty: number | null;
  variance: number | null;
  note: string;
}

export interface ImportPreview {
  token: string;
  fileName: string;
  totalRows: number;
  validRows: number;
  errorRows: number;
  /** Rows with problems first, then the first valid rows. */
  rows: { line: number; sku: string; name: string; errors: string[] }[];
  newCategories: string[];
  newBrands: string[];
}

// ---------- Input schemas ----------

const id = z.number().int().positive();
const version = z.number().int().positive();
const paise = z.number().int().min(0).max(1_000_000_000_00);
const milliQty = z.number().int().min(0).max(1_000_000_000_000);
const text = (max: number) => z.string().trim().max(max).default('');
const requestId = z.string().uuid();
const reasonRequired = z.string().trim().min(3, 'Please give a reason (at least 3 characters)').max(500);

export const productFields = z.object({
  sku: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Za-z0-9._/-]*$/, 'Use letters, digits and . _ / - only')
    .default(''),
  name: z.string().trim().min(1, 'Product name is required').max(200),
  categoryId: id.nullable(),
  brandId: id.nullable(),
  unitId: id,
  description: text(1000),
  hsnCode: z
    .string()
    .trim()
    .regex(/^(\d{4}|\d{6}|\d{8})?$/, 'HSN code must be 4, 6 or 8 digits')
    .default(''),
  gstRateBp: z
    .number()
    .int()
    .refine((v) => (GST_RATES_BP as readonly number[]).includes(v), 'Choose a GST rate'),
  priceIncludesTax: z.boolean(),
  purchasePrice: paise,
  sellingPrice: paise,
  minStockQty: milliQty,
  preferredSupplierId: id.nullable(),
  notes: text(1000),
});

export const productFilterSchema = z.object({
  search: z.string().trim().max(100).optional(),
  categoryId: id.optional(),
  brandId: id.optional(),
  supplierId: id.optional(),
  stock: z.enum(['ALL', 'IN_STOCK', 'LOW', 'OUT', 'LOW_OR_OUT']).default('ALL'),
  active: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).default('ACTIVE'),
  sort: z.enum(['name', 'sku', 'qty', 'value', 'price', 'updated']).default('name'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(10).max(200).default(50),
});

export type ProductFilter = z.output<typeof productFilterSchema>;

const movementFilter = z.object({
  productId: id.optional(),
  type: z.enum(MOVEMENT_TYPE_KEYS).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(10).max(200).default(50),
});

const catalogName = z.string().trim().min(1, 'Name is required').max(80);

export const inventoryCommands = {
  'catalog.get': command<CatalogData>()(z.object({})),
  'catalog.saveCategory': command<CategoryRow>()(
    z.object({ id: id.optional(), name: catalogName, isActive: z.boolean().default(true), version: version.optional() }),
  ),
  'catalog.saveBrand': command<BrandRow>()(
    z.object({ id: id.optional(), name: catalogName, isActive: z.boolean().default(true), version: version.optional() }),
  ),
  'catalog.saveUnit': command<UnitRow>()(
    z.object({
      id: id.optional(),
      code: z
        .string()
        .trim()
        .min(1)
        .max(10)
        .regex(/^[A-Za-z0-9]+$/, 'Letters and digits only'),
      name: catalogName,
      allowDecimal: z.boolean(),
      isActive: z.boolean().default(true),
      version: version.optional(),
    }),
  ),
  'catalog.quickAddSupplier': command<SupplierRef>()(
    z.object({ name: z.string().trim().min(1, 'Supplier name is required').max(120), phone: text(40) }),
  ),

  'products.list': command<Paged<ProductListRow>>()(productFilterSchema),
  'products.get': command<ProductDetail>()(z.object({ id })),
  'products.create': command<ProductDetail>()(
    productFields.extend({
      requestId,
      openingQty: milliQty.default(0),
      /** Cost per unit for the opening stock; defaults to the purchase price. */
      openingUnitCost: paise.optional(),
    }),
  ),
  'products.update': command<ProductDetail>()(productFields.extend({ id, version, reason: z.string().trim().max(500).optional() })),
  'products.setActive': command<ProductDetail>()(z.object({ id, version, isActive: z.boolean(), reason: reasonRequired })),

  'stock.adjust': command<MovementRow>()(
    z
      .object({
        requestId,
        productId: id,
        kind: z.enum(MANUAL_ADJUSTMENTS),
        qty: z.number().int().positive('Enter a quantity greater than zero'),
        unitCost: paise.optional(),
        reason: z.string().trim().max(500).default(''),
      })
      .refine((v) => v.kind === 'RECEIPT' || v.reason.length >= 3, {
        path: ['reason'],
        message: 'Please give a reason (at least 3 characters)',
      }),
  ),
  'stock.movements': command<Paged<MovementRow>>()(movementFilter),
  'stock.summary': command<StockSummary>()(z.object({})),

  'stockCounts.list': command<StockCountRow[]>()(z.object({})),
  'stockCounts.get': command<StockCountRow>()(z.object({ id })),
  'stockCounts.lines': command<Paged<StockCountLine>>()(
    z.object({
      id,
      search: z.string().trim().max(100).optional(),
      show: z.enum(['ALL', 'UNCOUNTED', 'COUNTED', 'VARIANCE']).default('ALL'),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(10).max(200).default(50),
    }),
  ),
  'stockCounts.create': command<StockCountRow>()(
    z.object({ categoryId: id.nullable().default(null), notes: text(500), requestId }),
  ),
  'stockCounts.saveLines': command<{ saved: number }>()(
    z.object({
      id,
      lines: z
        .array(z.object({ productId: id, countedQty: milliQty.nullable(), note: text(200) }))
        .min(1)
        .max(500),
    }),
  ),
  'stockCounts.finalize': command<StockCountRow>()(z.object({ id, version, reason: reasonRequired, requestId })),
  'stockCounts.cancel': command<StockCountRow>()(z.object({ id, version, reason: reasonRequired })),

  'products.export': command<{ path: string } | null>()(
    z.object({ format: z.enum(['csv', 'xlsx']), filter: productFilterSchema.omit({ page: true, pageSize: true }) }),
  ),
  'products.importTemplate': command<{ path: string } | null>()(z.object({ format: z.enum(['csv', 'xlsx']) })),
  'products.importPreview': command<ImportPreview | null>()(z.object({})),
  'products.importCommit': command<{ created: number }>()(z.object({ token: z.string().uuid(), requestId })),

  'dev.seedSampleData': command<{ products: number }>()(z.object({})),
};
