export const DocTypes = {
  INVOICE: { prefix: 'INV', label: 'Sales invoice' },
  CREDIT_NOTE: { prefix: 'CN', label: 'Credit note' },
  RENTAL: { prefix: 'RNT', label: 'Rental agreement' },
  RENTAL_INVOICE: { prefix: 'RINV', label: 'Rental invoice' },
  PURCHASE: { prefix: 'PUR', label: 'Purchase' },
  DEBIT_NOTE: { prefix: 'DN', label: 'Supplier debit note' },
  RECEIPT: { prefix: 'RCPT', label: 'Payment receipt' },
  SUPPLIER_PAYMENT: { prefix: 'PAY', label: 'Supplier payment' },
  EXPENSE: { prefix: 'EXP', label: 'Expense' },
  STOCK_COUNT: { prefix: 'SC', label: 'Stock count' },
  REFUND: { prefix: 'RFD', label: 'Refund' },
} as const;

export type DocType = keyof typeof DocTypes;

export function formatDocNumber(prefix: string, fiscalYear: string, value: number): string {
  return `${prefix}/${fiscalYear}/${String(value).padStart(5, '0')}`;
}
