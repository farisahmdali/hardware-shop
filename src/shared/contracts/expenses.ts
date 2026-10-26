import { z } from 'zod';
import { command, type Paged } from './define';
import type { CategoryRow } from './inventory';

// ---------- Types returned to the renderer ----------

export interface ExpenseRow {
  id: number;
  expenseNo: string;
  categoryId: number;
  categoryName: string;
  description: string;
  amount: number;
  expenseDate: string;
  methodId: number;
  methodName: string;
  payee: string;
  reference: string;
  notes: string;
  status: 'ACTIVE' | 'VOID';
  voidReason: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  /** Changed after it was first recorded; the history shows what changed. */
  edited: boolean;
  version: number;
}

export type ExpenseList = Paged<ExpenseRow> & { totalAmount: number };

export interface ExpenseSummary {
  today: number;
  month: number;
  monthByCategory: { categoryName: string; amount: number }[];
}

export type CashEntryType = 'CASH_IN' | 'DRAWING' | 'BANK_DEPOSIT' | 'BANK_WITHDRAWAL';

export interface CashEntryRow {
  id: number;
  entryNo: string;
  type: CashEntryType;
  amount: number;
  reason: string;
  createdAt: string;
  businessDate: string;
  username: string | null;
  reversal: { at: string; reason: string; username: string | null } | null;
}

export interface CashCountRow {
  id: number;
  businessDate: string;
  countedAt: string;
  expected: number;
  counted: number;
  difference: number;
  /** Number of notes/coins by face value in rupees, when counted that way. */
  denominations: Record<string, number> | null;
  note: string;
  username: string | null;
}

export interface CashFlowLine {
  key: string;
  label: string;
  amount: number;
  count: number;
}

/** The cash drawer for one day, from the ledger. */
export interface CashDay {
  date: string;
  isToday: boolean;
  opening: number;
  inflows: CashFlowLine[];
  outflows: CashFlowLine[];
  totalIn: number;
  totalOut: number;
  /** Opening + in − out: what the drawer should hold at the end of the day. */
  closing: number;
  counts: CashCountRow[];
  entries: CashEntryRow[];
  /** Other payment methods received and paid that day, for reference (not cash). */
  otherMethods: { methodName: string; received: number; paid: number }[];
}

// ---------- Input schemas ----------

const id = z.number().int().positive();
const version = z.number().int().positive();
const paise = z.number().int().min(0).max(1_000_000_000_00);
const requestId = z.string().uuid();
const text = (max: number) => z.string().trim().max(max).default('');
const reasonRequired = z.string().trim().min(3, 'Please give a reason (at least 3 characters)').max(500);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date');

const pageInput = {
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(5).max(200).default(50),
};

export const expenseFields = z.object({
  categoryId: id,
  description: z.string().trim().min(1, 'Describe the expense').max(200),
  amount: z.number().int().positive('Enter an amount').max(1_000_000_000_00),
  expenseDate: isoDate,
  methodId: id,
  payee: text(120),
  reference: text(60),
  notes: text(500),
});

/** Face values (rupees) of notes and coins offered when counting the drawer. */
export const DENOMINATIONS = [500, 200, 100, 50, 20, 10, 5, 2, 1] as const;

export const expenseCommands = {
  'expenses.list': command<ExpenseList>()(
    z.object({
      search: z.string().trim().max(100).optional(),
      categoryId: id.optional(),
      methodId: id.optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
      status: z.enum(['ACTIVE', 'VOID', 'ALL']).default('ACTIVE'),
      ...pageInput,
    }),
  ),
  'expenses.get': command<ExpenseRow>()(z.object({ id })),
  'expenses.create': command<ExpenseRow>()(expenseFields.extend({ requestId })),
  'expenses.update': command<ExpenseRow>()(expenseFields.extend({ id, version, reason: reasonRequired })),
  'expenses.void': command<ExpenseRow>()(z.object({ id, version, reason: reasonRequired })),
  'expenses.summary': command<ExpenseSummary>()(z.object({})),

  'expenseCategories.list': command<CategoryRow[]>()(z.object({ includeInactive: z.boolean().default(false) })),
  'expenseCategories.save': command<CategoryRow>()(
    z.object({
      id: id.optional(),
      name: z.string().trim().min(1, 'Enter a name').max(60),
      isActive: z.boolean().default(true),
      version: version.optional(),
    }),
  ),

  'cash.day': command<CashDay>()(z.object({ date: isoDate.optional() })),
  'cash.addEntry': command<CashEntryRow>()(
    z.object({
      requestId,
      type: z.enum(['CASH_IN', 'DRAWING', 'BANK_DEPOSIT', 'BANK_WITHDRAWAL']),
      amount: z.number().int().positive('Enter an amount').max(1_000_000_000_00),
      reason: reasonRequired,
    }),
  ),
  'cash.reverseEntry': command<CashEntryRow>()(z.object({ id, reason: reasonRequired })),
  'cash.count': command<CashCountRow>()(
    z.object({
      requestId,
      counted: paise,
      /** Number of each note/coin, keyed by face value in rupees. */
      denominations: z.record(z.string().regex(/^\d+$/), z.number().int().min(0).max(100_000)).nullable().default(null),
      /** Required when the count differs from what the records expect. */
      note: text(500),
    }),
  ),
  'cash.counts': command<Paged<CashCountRow>>()(z.object({ from: isoDate.optional(), to: isoDate.optional(), ...pageInput })),
};
