/** The screen that shows a record, for linking from history entries; null when there is none. */
export function recordLink(type: string, id: string): string | null {
  switch (type) {
    case 'product':
      return `/products/${id}`;
    case 'stock_count':
      return `/products/counts/${id}`;
    case 'stock_movement':
      return '/products/movements';
    case 'category':
    case 'brand':
    case 'unit':
      return '/products/catalog';
    case 'invoice':
      return `/sales/invoices/${id}`;
    case 'payment':
      return '/payments?tab=payments';
    case 'customer':
      return `/customers/${id}`;
    case 'rental':
      return `/rentals/${id}`;
    case 'rental_product':
      return `/rental-inventory/${id}`;
    case 'supplier':
      return `/suppliers/${id}`;
    case 'purchase':
      return `/suppliers/purchases/${id}`;
    case 'expense':
    case 'expense_category':
      return '/expenses';
    case 'cash_entry':
    case 'cash_count':
      return '/expenses?tab=cash';
    case 'report':
      return `/reports/${id}`;
    case 'user':
      return '/settings/users';
    case 'role':
      return '/settings/roles';
    case 'payment_method':
      return '/settings/payments';
    case 'backup':
      return '/settings/backup';
    default:
      return null;
  }
}

/** The History screen, filtered to one record and everything linked to it. */
export const recordHistoryLink = (type: string, id: string | number): string =>
  `/history?type=${encodeURIComponent(type)}&id=${encodeURIComponent(String(id))}`;
