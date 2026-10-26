import { z } from 'zod';
import { GST_STATE_CODES, isValidGstin } from './gstStates';

const optionalText = (max: number) => z.string().trim().max(max).default('');

export const shopProfileSchema = z.object({
  name: z.string().trim().min(1, 'Shop name is required').max(120),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(80),
  pincode: z
    .string()
    .trim()
    .refine((v) => v === '' || /^[1-9][0-9]{5}$/.test(v), 'PIN code must be 6 digits')
    .default(''),
  stateCode: z.string().refine((v) => GST_STATE_CODES.includes(v), 'Select the shop state'),
  phone: optionalText(40),
  email: z
    .string()
    .trim()
    .max(120)
    .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid email')
    .default(''),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => v === '' || isValidGstin(v), 'GSTIN is not valid')
    .default(''),
  invoiceFooter: optionalText(500),
});

export const taxSettingsSchema = z.object({
  /** When false, invoices are issued as a bill of supply with no GST. */
  gstRegistered: z.boolean().default(true),
  /** Default for new products: entered selling prices already include GST. */
  pricesIncludeTax: z.boolean().default(true),
  /** Round the invoice grand total to the nearest rupee and show the difference as round-off. */
  roundInvoiceTotal: z.boolean().default(true),
});

export const appSettingsSchema = z.object({
  requireLogin: z.boolean().default(true),
  theme: z.enum(['light', 'dark', 'system']).default('light'),
});

export const backupSettingsSchema = z.object({
  /** Absolute folder for backups; null means the default Documents folder. */
  folder: z.string().nullable().default(null),
  autoEnabled: z.boolean().default(true),
  intervalHours: z.number().int().min(1).max(72).default(4),
  keepAutoCount: z.number().int().min(3).max(500).default(30),
  keepDailyDays: z.number().int().min(7).max(3650).default(90),
});

export const stockSettingsSchema = z.object({
  allowNegativeOverride: z.boolean().default(false),
});

export const receivableSettingsSchema = z.object({
  defaultCreditDays: z.number().int().min(0).max(365).default(30),
  /** Upper bounds (days) of the ageing buckets; the last bucket is open-ended. */
  ageingBuckets: z.array(z.number().int().min(1).max(3650)).min(1).max(6).default([30, 60, 90]),
});

export const printingSettingsSchema = z.object({
  /** Paper used by the "Print" button after a sale. */
  defaultPaper: z.enum(['A4', 'THERMAL_80', 'THERMAL_58']).default('A4'),
  /** Print the HSN / GST rate summary table on A4 tax invoices. */
  showHsnSummary: z.boolean().default(true),
  /** Short line printed at the bottom of thermal receipts. */
  receiptFooter: z.string().trim().max(120).default('Thank you! Please visit again.'),
});

export const rentalSettingsSchema = z.object({
  /** How a rental period is priced; see shared/rentalPricing. */
  pricingMode: z.enum(['CHEAPEST', 'CHOSEN_UNIT', 'DAILY']).default('CHEAPEST'),
  /** Minutes of lateness forgiven before another unit (or a late fee) is charged. */
  graceMinutes: z.number().int().min(0).max(720).default(60),
  lateFeeMode: z.enum(['SAME_RATES', 'FIXED_PER_DAY', 'MULTIPLIER']).default('SAME_RATES'),
  /** Paise per started day late, when the late fee is a fixed amount. */
  lateFeePerDay: z.number().int().min(0).max(10_000_000).default(0),
  /** Multiplier on the extra-time charge, in basis points (15000 = 1.5×). */
  lateMultiplierBp: z.number().int().min(10_000).max(50_000).default(15_000),
  /** AT_ISSUE: the booked period is billed when the item goes out. AT_RETURN: everything is billed on return. */
  billing: z.enum(['AT_ISSUE', 'AT_RETURN']).default('AT_ISSUE'),
  /** Printed on rental agreements. */
  terms: z
    .string()
    .trim()
    .max(2000)
    .default(
      'The customer is responsible for the equipment until it is returned. Damage beyond normal wear, and loss, will be charged. ' +
        'Late returns are charged as shown. The security deposit is refunded after inspection, less any amounts due.',
    ),
});

export const purchaseSettingsSchema = z.object({
  /**
   * Keep GST paid on purchases out of stock cost, as input tax credit. Applies only when the shop is
   * GST registered and the supplier has a GSTIN; otherwise the GST paid is part of the cost of the goods.
   */
  claimInputGst: z.boolean().default(true),
  /** Days the shop has to pay a supplier's bill, unless the supplier has their own period. */
  defaultCreditDays: z.number().int().min(0).max(365).default(30),
  /** Largest round-off accepted to match a supplier's bill total, in paise. */
  maxRoundOff: z.number().int().min(0).max(10_000).default(1_000),
});

export const settingsSchemas = {
  shop: shopProfileSchema,
  tax: taxSettingsSchema,
  app: appSettingsSchema,
  backup: backupSettingsSchema,
  stock: stockSettingsSchema,
  receivables: receivableSettingsSchema,
  printing: printingSettingsSchema,
  rental: rentalSettingsSchema,
  purchases: purchaseSettingsSchema,
} as const;

export type SettingsSection = keyof typeof settingsSchemas;
export const SETTINGS_SECTIONS = Object.keys(settingsSchemas) as SettingsSection[];

export type ShopProfile = z.infer<typeof shopProfileSchema>;
export type AllSettings = { [K in SettingsSection]: z.infer<(typeof settingsSchemas)[K]> };

/** Defaults for every section except the shop profile, which the setup wizard collects. */
export function defaultSettings(): Omit<AllSettings, 'shop'> {
  return {
    tax: taxSettingsSchema.parse({}),
    app: appSettingsSchema.parse({}),
    backup: backupSettingsSchema.parse({}),
    stock: stockSettingsSchema.parse({}),
    receivables: receivableSettingsSchema.parse({}),
    printing: printingSettingsSchema.parse({}),
    rental: rentalSettingsSchema.parse({}),
    purchases: purchaseSettingsSchema.parse({}),
  };
}
