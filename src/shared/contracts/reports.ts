import { z } from 'zod';
import { command } from './define';
import { REPORT_IDS, reportParamsSchema, type ReportResult } from '../reports';

// ---------- Types returned to the renderer ----------

/** Figures for a chosen period. Each is labelled for what it is; none is derived from another. */
export interface DashboardPeriod {
  from: string;
  to: string;
  /** Product sales invoices (not cancelled), including GST, less returns in the period. */
  sales: { invoices: number; total: number; returns: number };
  /** Rental bills, including GST, less credits on them. */
  rentalBilled: number;
  /** Money received from customers (less reversals), and refunds paid. */
  collected: number;
  refunds: number;
  collectedByMethod: { name: string; amount: number }[];
  /** Security deposits taken and given back or used: held for customers, not income. */
  deposits: { collected: number; released: number };
  /** Null when the user may not see expenses. */
  expenses: number | null;
  /** From the accounts, excluding GST. Null without the financial reports permission. */
  profit: { revenue: number; cogs: number; gross: number; running: number; net: number } | null;
  /** One point per day for periods up to two months, otherwise null. */
  daily: { date: string; sales: number; rental: number }[] | null;
}

export interface DashboardTransaction {
  kind: 'SALE' | 'RENTAL_BILL' | 'PAYMENT' | 'REFUND' | 'PURCHASE' | 'EXPENSE';
  id: number;
  docNo: string;
  at: string;
  party: string;
  amount: number;
  cancelled: boolean;
}

export interface DashboardChange {
  id: number;
  at: string;
  username: string | null;
  module: string;
  entityType: string;
  entityId: string | null;
  action: string;
  reason: string | null;
}

export interface DashboardRecent {
  transactions: DashboardTransaction[];
  /** Null without permission to view the history. */
  changes: DashboardChange[] | null;
}

// ---------- Input schemas ----------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date');
const reportInput = { reportId: z.enum(REPORT_IDS), params: reportParamsSchema };

export const reportCommands = {
  'reports.run': command<ReportResult>()(z.object(reportInput)),
  'reports.export': command<{ path: string } | null>()(z.object({ ...reportInput, format: z.enum(['csv', 'xlsx', 'pdf']) })),
  'reports.print': command<{ printed: boolean }>()(z.object(reportInput)),

  'dashboard.period': command<DashboardPeriod>()(
    z.object({ from: isoDate, to: isoDate }).refine((p) => p.from <= p.to, { message: 'The start date is after the end date', path: ['from'] }),
  ),
  'dashboard.recent': command<DashboardRecent>()(z.object({})),
};
