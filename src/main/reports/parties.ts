import type { ReportImpl } from './engine';
import { col } from './util';
import { customerLedger } from '../services/customers';
import { ageingReport } from '../services/payments';
import { supplierLedger } from '../services/suppliers';
import { payablesAgeing } from '../services/supplierPayments';
import type { CustomerLedger } from '@shared/contracts';
import type { ReportRow } from '@shared/reports';

const LEDGER_COLUMNS = [
  col('date', 'Date', 'date'),
  col('doc', 'Document', 'code'),
  col('details', 'Details', 'text'),
  col('debit', 'Debit', 'money', true),
  col('credit', 'Credit', 'money', true),
  col('balance', 'Balance', 'money'),
];

function ledgerRows(l: CustomerLedger, link: (refType: string, refId: string) => ReportRow['link']): ReportRow[] {
  return [
    { style: 'subtotal', cells: { date: l.from, doc: '', details: 'Opening balance', debit: null, credit: null, balance: l.openingBalance } },
    ...l.rows.map((r) => ({
      link: link(r.refType, r.refId),
      cells: { date: r.businessDate, doc: r.docNo, details: r.description, debit: r.debit || null, credit: r.credit || null, balance: r.balance },
    })),
    { style: 'total', cells: { date: l.to, doc: '', details: 'Closing balance', debit: l.totalDebit, credit: l.totalCredit, balance: l.closingBalance } },
  ];
}

const customerStatement: ReportImpl = ({ db, params: p, today }) => {
  const l = customerLedger(db, p.customerId!, { from: p.from, to: p.to }, today);
  return {
    columns: LEDGER_COLUMNS,
    rows: ledgerRows(l, (t, id) => (t === 'INVOICE' || t === 'INVOICE_CANCEL' ? { to: 'invoice', id: Number(id) } : undefined)),
    noTotals: true,
    summary: [{ label: l.closingBalance >= 0 ? 'Owed to the shop' : 'In the customer’s favour', value: Math.abs(l.closingBalance), kind: 'money' }],
    notes: [
      'Debit: bills (what the customer owes). Credit: payments, returns and credits. A positive balance is owed to the shop; a negative balance is credit in the customer’s favour.',
      ...(l.truncated ? ['The period has too many entries to show in full; choose a shorter period.'] : []),
    ],
  };
};

const supplierStatement: ReportImpl = ({ db, params: p, today }) => {
  const l = supplierLedger(db, p.supplierId!, { from: p.from, to: p.to }, today);
  return {
    columns: [
      col('date', 'Date', 'date'),
      col('doc', 'Document', 'code'),
      col('details', 'Details', 'text'),
      col('debit', 'Paid / returned', 'money', true),
      col('credit', 'Billed', 'money', true),
      col('balance', 'Balance', 'money'),
    ],
    rows: ledgerRows(l, (t, id) => (t === 'PURCHASE' || t === 'PURCHASE_CANCEL' ? { to: 'purchase', id: Number(id) } : undefined)),
    noTotals: true,
    summary: [{ label: l.closingBalance >= 0 ? 'The shop owes' : 'Advance with the supplier', value: Math.abs(l.closingBalance), kind: 'money' }],
    notes: [
      'Billed: purchase bills (what the shop owes). Paid / returned: payments, returns and corrections. A positive balance is owed by the shop to the supplier.',
      ...(l.truncated ? ['The period has too many entries to show in full; choose a shorter period.'] : []),
    ],
  };
};

interface PaymentRecord {
  id: number;
  payment_no: string;
  business_date: string;
  direction: 'IN' | 'OUT';
  party_id: number;
  name: string;
  amount: number;
  method: string;
  reference_no: string;
  reversed_on: string | null;
}

function payments(party: 'CUSTOMER' | 'SUPPLIER'): ReportImpl {
  return ({ db, params: p, limit }) => {
    const partyId = party === 'CUSTOMER' ? p.customerId : p.supplierId;
    const table = party === 'CUSTOMER' ? 'customers' : 'suppliers';
    const rows = db
      .prepare(
        `SELECT pa.id, pa.payment_no, pa.business_date, pa.direction, pa.party_id, x.name, pa.amount, m.name AS method, pa.reference_no,
                r.business_date AS reversed_on
         FROM payments pa JOIN ${table} x ON x.id = pa.party_id JOIN payment_methods m ON m.id = pa.method_id
         LEFT JOIN payment_reversals r ON r.payment_id = pa.id
         WHERE pa.party_type = ? AND pa.business_date BETWEEN ? AND ? AND (? IS NULL OR pa.party_id = ?)
         ORDER BY pa.business_date, pa.id LIMIT ?`,
      )
      .all(party, p.from, p.to, partyId ?? null, partyId ?? null, limit + 1) as PaymentRecord[];
    // For customers money comes IN; for suppliers it goes OUT. The other direction is a refund.
    const main: 'IN' | 'OUT' = party === 'CUSTOMER' ? 'IN' : 'OUT';
    return {
      columns: [
        col('date', 'Date', 'date'),
        col('doc', party === 'CUSTOMER' ? 'Receipt' : 'Voucher', 'code'),
        col('party', party === 'CUSTOMER' ? 'Customer' : 'Supplier', 'text'),
        col('method', 'Method', 'text'),
        col('reference', 'Reference', 'text'),
        col('paid', party === 'CUSTOMER' ? 'Received' : 'Paid', 'money', true),
        col('refund', party === 'CUSTOMER' ? 'Refunded to customer' : 'Refunded by supplier', 'money', true),
        col('status', 'Status', 'text'),
      ],
      rows: rows.map((r) => ({
        link: { to: party === 'CUSTOMER' ? ('customer' as const) : ('supplier' as const), id: r.party_id },
        cells: {
          date: r.business_date,
          doc: r.payment_no,
          party: r.name,
          method: r.method,
          reference: r.reference_no,
          paid: !r.reversed_on && r.direction === main ? r.amount : null,
          refund: !r.reversed_on && r.direction !== main ? r.amount : null,
          status: r.reversed_on ? `Reversed (${r.reversed_on})` : '',
        },
      })),
      notes: ['Reversed payments are listed without an amount, so they do not add to the totals.'],
    };
  };
}

const customerBalances: ReportImpl = ({ db, today, limit }) => {
  const rows = db
    .prepare(
      `SELECT c.id, c.code, c.name, c.phone,
              COALESCE((SELECT SUM(le.debit - le.credit) FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
                        WHERE a.code = 'AR' AND le.party_type = 'CUSTOMER' AND le.party_id = c.id), 0) AS balance,
              COALESCE((SELECT SUM(outstanding) FROM v_receivables r WHERE r.customer_id = c.id AND r.cancelled = 0 AND r.outstanding > 0), 0) AS open,
              COALESCE((SELECT SUM(outstanding) FROM v_receivables r WHERE r.customer_id = c.id AND r.cancelled = 0 AND r.outstanding > 0 AND r.due_date < ?), 0) AS overdue,
              COALESCE((SELECT SUM(unallocated) FROM v_credit_sources s WHERE s.customer_id = c.id AND s.reversed = 0 AND s.unallocated > 0), 0) AS credit
       FROM customers c WHERE c.is_walkin = 0`,
    )
    .all(today) as { id: number; code: string; name: string; phone: string; balance: number; open: number; overdue: number; credit: number }[];
  const shown = rows.filter((r) => r.balance !== 0 || r.open > 0 || r.credit > 0).sort((a, b) => b.balance - a.balance);
  return {
    columns: [
      col('code', 'Code', 'code'),
      col('customer', 'Customer', 'text'),
      col('phone', 'Phone', 'text'),
      col('open', 'Open bills', 'money', true),
      col('overdue', 'Overdue', 'money', true),
      col('credit', 'Credit held', 'money', true),
      col('balance', 'Balance', 'money', true),
    ],
    rows: shown.slice(0, limit + 1).map((r) => ({
      link: { to: 'customer' as const, id: r.id },
      cells: { code: r.code, customer: r.name, phone: r.phone, open: r.open, overdue: r.overdue, credit: r.credit, balance: r.balance },
    })),
    summary: [
      { label: 'Owed to the shop', value: shown.reduce((a, r) => a + r.open, 0), kind: 'money' },
      { label: 'Overdue', value: shown.reduce((a, r) => a + r.overdue, 0), kind: 'money' },
      { label: 'Customer credit held', value: shown.reduce((a, r) => a + r.credit, 0), kind: 'money' },
    ],
    notes: ['Balance = open bills − credit held, from the accounts. A negative balance is credit in the customer’s favour.'],
  };
};

const customerAgeing: ReportImpl = ({ db, today }) => {
  const r = ageingReport(db, today);
  return {
    columns: [
      col('customer', 'Customer', 'text'),
      col('phone', 'Phone', 'text'),
      ...r.bucketLabels.map((l, i) => col(`b${i}`, l, 'money', true)),
      col('owed', 'Total owed', 'money', true),
      col('credit', 'Credit held', 'money', true),
      col('net', 'Net', 'money', true),
    ],
    rows: r.rows.map((x) => ({
      link: { to: 'customer' as const, id: x.customerId },
      cells: { customer: x.customerName, phone: x.phone, ...Object.fromEntries(x.buckets.map((b, i) => [`b${i}`, b])), owed: x.outstanding, credit: x.credit, net: x.balance },
    })),
    notes: ['Age is counted from the bill date. The buckets are set under Backup & Settings → Billing.'],
  };
};

const supplierBalances: ReportImpl = ({ db, today }) => {
  const r = payablesAgeing(db, today);
  const listed = new Set(r.rows.map((x) => x.supplierId));
  const advancesOnly = (
    db
      .prepare(
        `SELECT s.id, s.name, s.phone, SUM(c.unallocated) AS credit FROM v_supplier_credits c JOIN suppliers s ON s.id = c.supplier_id
         WHERE c.reversed = 0 AND c.unallocated > 0 GROUP BY s.id`,
      )
      .all() as { id: number; name: string; phone: string; credit: number }[]
  ).filter((s) => !listed.has(s.id));
  const zero = Object.fromEntries(r.bucketLabels.map((_, i) => [`b${i}`, 0]));
  return {
    columns: [
      col('supplier', 'Supplier', 'text'),
      col('phone', 'Phone', 'text'),
      ...r.bucketLabels.map((l, i) => col(`b${i}`, l, 'money', true)),
      col('owed', 'Total owed', 'money', true),
      col('credit', 'Advance', 'money', true),
      col('net', 'Net to pay', 'money', true),
    ],
    rows: [
      ...r.rows.map((x) => ({
        link: { to: 'supplier' as const, id: x.supplierId },
        cells: { supplier: x.supplierName, phone: x.phone, ...Object.fromEntries(x.buckets.map((b, i) => [`b${i}`, b])), owed: x.outstanding, credit: x.credit, net: x.balance },
      })),
      ...advancesOnly.map((s) => ({
        link: { to: 'supplier' as const, id: s.id },
        cells: { supplier: s.name, phone: s.phone, ...zero, owed: 0, credit: s.credit, net: -s.credit },
      })),
    ],
    notes: ['Age is counted from the supplier’s bill date. Advances and unused debit notes are in the shop’s favour.'],
  };
};

export const partyReports: Record<string, ReportImpl> = {
  'parties.customerStatement': customerStatement,
  'parties.customerPayments': payments('CUSTOMER'),
  'parties.customerBalances': customerBalances,
  'parties.customerAgeing': customerAgeing,
  'parties.supplierStatement': supplierStatement,
  'parties.supplierPayments': payments('SUPPLIER'),
  'parties.supplierBalances': supplierBalances,
};
