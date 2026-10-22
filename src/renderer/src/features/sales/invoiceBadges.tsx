import type { InvoiceStatus } from '@shared/contracts';
import { Badge } from '../../components/ui/layout';

export function InvoiceStatusBadge({ status, overdue }: { status: InvoiceStatus; overdue?: boolean }) {
  if (status === 'CANCELLED') return <Badge>Cancelled</Badge>;
  if (status === 'PAID') return <Badge tone="success">Paid</Badge>;
  if (overdue) return <Badge tone="danger">Overdue</Badge>;
  return status === 'PARTIAL' ? <Badge tone="warning">Part paid</Badge> : <Badge tone="warning">Unpaid</Badge>;
}
