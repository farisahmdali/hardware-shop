export const PERMISSIONS = {
  'products.manage': { group: 'Products & stock', label: 'Add and edit products, categories and units' },
  'stock.adjust': { group: 'Products & stock', label: 'Adjust stock, record damage/loss, reconcile counts' },
  'stock.overrideNegative': { group: 'Products & stock', label: 'Override the negative-stock block (needs a reason)' },
  'sales.create': { group: 'Sales', label: 'Create and finalize sales invoices' },
  'sales.discount': { group: 'Sales', label: 'Give discounts (up to the role limit)' },
  'sales.cancel': { group: 'Sales', label: 'Cancel finalized invoices' },
  'sales.return': { group: 'Sales', label: 'Process customer returns and refunds' },
  'customers.manage': { group: 'Customers', label: 'Add and edit customers' },
  'customers.adjustBalance': { group: 'Customers', label: 'Adjust customer balances and opening balances' },
  'payments.receive': { group: 'Payments', label: 'Record customer payments' },
  'payments.reverse': { group: 'Payments', label: 'Reverse payments' },
  'rentals.manage': { group: 'Rentals', label: 'Manage rental items, assets and rates' },
  'rentals.issue': { group: 'Rentals', label: 'Issue and extend rentals' },
  'rentals.return': { group: 'Rentals', label: 'Record rental returns and inspections' },
  'rentals.depositDeduct': { group: 'Rentals', label: 'Deduct from or waive security deposits and charges' },
  'suppliers.manage': { group: 'Suppliers & purchases', label: 'Add and edit suppliers' },
  'purchases.manage': { group: 'Suppliers & purchases', label: 'Record purchases and supplier returns' },
  'suppliers.pay': { group: 'Suppliers & purchases', label: 'Record supplier payments' },
  'expenses.manage': { group: 'Expenses & cash', label: 'Record and edit expenses' },
  'cash.reconcile': { group: 'Expenses & cash', label: 'Cash entries and daily cash reconciliation' },
  'reports.view': { group: 'Reports', label: 'View sales, stock and rental reports' },
  'reports.financial': { group: 'Reports', label: 'View financial reports, costs and profit' },
  'audit.view': { group: 'Administration', label: 'View history and audit log' },
  'backup.create': { group: 'Administration', label: 'Create and copy backups' },
  'backup.restore': { group: 'Administration', label: 'Restore a backup (replaces all data)' },
  'settings.manage': { group: 'Administration', label: 'Change shop settings' },
  'users.manage': { group: 'Administration', label: 'Manage users, roles and permissions' },
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(value: string): value is Permission {
  return Object.hasOwn(PERMISSIONS, value);
}

/** The owner role always holds every permission; it cannot be edited or locked out. */
export const OWNER_ROLE_CODE = 'OWNER';
