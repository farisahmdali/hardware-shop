import type { PurchaseStatus } from '@shared/contracts';
import { formatMoney } from '@shared/money';
import { Badge } from '../../components/ui/layout';
import { cn } from '../../lib/cn';

/** Positive balances are owed by the shop; negative ones are advances with the supplier. */
export function SupplierBalanceText({ balance }: { balance: number }) {
  if (balance === 0) return <span className="text-ink-3">Nothing owed</span>;
  return balance > 0 ? (
    <span className="font-medium text-warning">To pay {formatMoney(balance)}</span>
  ) : (
    <span className="font-medium text-success">Advance {formatMoney(-balance)}</span>
  );
}

const STATUS: Record<PurchaseStatus, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }> = {
  PAID: { label: 'Paid', tone: 'success' },
  PARTIAL: { label: 'Part paid', tone: 'info' },
  UNPAID: { label: 'Unpaid', tone: 'warning' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  REPLACED: { label: 'Replaced by an edit', tone: 'neutral' },
};

export function PurchaseStatusBadge({ status, overdue, className }: { status: PurchaseStatus; overdue?: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex gap-1', className)}>
      <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>
      {overdue && <Badge tone="danger">Overdue</Badge>}
    </span>
  );
}

export const SUPPLIER_INVALIDATE = ['suppliers.', 'purchases.', 'payables.', 'supplierPayments.', 'products.', 'stock.', 'cash.'];
