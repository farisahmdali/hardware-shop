import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Wallet } from 'lucide-react';
import type { SupplierPaymentRow } from '@shared/contracts';
import { formatMoney } from '@shared/money';
import { formatDateTime } from '@shared/time';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/dialog';
import { Input, Select } from '../../components/ui/form';
import { Badge, EmptyState, Spinner } from '../../components/ui/layout';
import { Pagination, Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { SUPPLIER_INVALIDATE } from './shared';
import { HistoryButton } from '../history/EntityHistory';

/** Payments made to suppliers and refunds received from them, with reversal for authorised users. */
export function SupplierPaymentsTable({ supplierId }: { supplierId?: number }) {
  const can = useCan();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [direction, setDirection] = useState<'ALL' | 'IN' | 'OUT'>('ALL');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reversing, setReversing] = useState<SupplierPaymentRow | null>(null);
  const list = useCommandQuery(
    'supplierPayments.list',
    { supplierId, direction, from: from || undefined, to: to || undefined, page, pageSize: 50 },
    { placeholderData: (p) => p },
  );
  const reverse = useCommandMutation('supplierPayments.reverse', { invalidate: SUPPLIER_INVALIDATE });

  return (
    <>
      <div className="flex flex-wrap items-end gap-2.5 border-b border-line p-3.5">
        <Select aria-label="Direction" className="w-56" value={direction} onChange={(e) => (setDirection(e.target.value as typeof direction), setPage(1))}>
          <option value="ALL">Payments and refunds</option>
          <option value="OUT">Paid to suppliers</option>
          <option value="IN">Refunds from suppliers</option>
        </Select>
        <label className="flex flex-col gap-1 text-[12px] text-ink-3">
          From
          <Input type="date" value={from} onChange={(e) => (setFrom(e.target.value), setPage(1))} className="w-40" />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-ink-3">
          To
          <Input type="date" value={to} onChange={(e) => (setTo(e.target.value), setPage(1))} className="w-40" />
        </label>
      </div>
      {!list.data ? (
        <Spinner />
      ) : list.data.rows.length === 0 ? (
        <EmptyState icon={Wallet} title="No supplier payments" />
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <Th>Voucher</Th>
                <Th>When</Th>
                {!supplierId && <Th>Supplier</Th>}
                <Th>Method</Th>
                <Th>Settled</Th>
                <Th align="right">Amount</Th>
                <Th />
              </tr>
            </THead>
            <tbody>
              {list.data.rows.map((p) => (
                <Tr key={p.id} className={p.reversal ? 'opacity-60' : undefined}>
                  <Td className="font-mono text-[13px] whitespace-nowrap">
                    {p.paymentNo}
                    {p.direction === 'IN' && (
                      <Badge tone="accent" className="ml-2">
                        Refund in
                      </Badge>
                    )}
                    {p.reversal && (
                      <Badge className="ml-2" tone="danger">
                        Reversed
                      </Badge>
                    )}
                  </Td>
                  <Td className="tabular whitespace-nowrap">
                    {formatDateTime(p.paidAt)} <span className="text-ink-3">· {p.username}</span>
                  </Td>
                  {!supplierId && (
                    <Td>
                      <Link to={`/suppliers/${p.supplierId}`} className="hover:text-brand">
                        {p.supplierName}
                      </Link>
                    </Td>
                  )}
                  <Td>
                    {p.methodName}
                    {p.reference && <span className="block text-[12px] text-ink-3">{p.reference}</span>}
                  </Td>
                  <Td className="text-[13px]">
                    {p.appliedTo.map((a) =>
                      a.docType === 'PURCHASE' ? (
                        <Link key={`${a.docType}${a.docId}`} to={`/suppliers/purchases/${a.docId}`} className="mr-2 font-mono text-brand hover:underline">
                          {a.docNo}
                        </Link>
                      ) : (
                        <span key={`${a.docType}${a.docId}`} className="mr-2">
                          {a.docNo}
                        </span>
                      ),
                    )}
                    {p.unallocated > 0 && <span className="text-success">Advance {formatMoney(p.unallocated)}</span>}
                    {p.reversal && <span className="block text-ink-3">Reversed: {p.reversal.reason}</span>}
                    {p.direction === 'IN' && !p.reversal && <span className="text-ink-3">{p.notes}</span>}
                  </Td>
                  <Td align="right" className="font-medium">
                    {p.direction === 'IN' ? '+ ' : ''}
                    {formatMoney(p.amount)}
                  </Td>
                  <Td align="right" className="whitespace-nowrap">
                    <HistoryButton entityType="supplier_payment" entityId={p.id} title={`Supplier payment ${p.paymentNo}`} />
                    {!p.reversal && can('suppliers.pay') && (
                      <Button size="sm" variant="ghost" onClick={() => setReversing(p)}>
                        Reverse
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={page} pageSize={50} total={list.data.total} onPage={setPage} />
        </>
      )}
      <ConfirmDialog
        open={!!reversing}
        onOpenChange={(o) => !o && setReversing(null)}
        title={`Reverse ${reversing?.paymentNo}?`}
        description={
          reversing?.direction === 'IN'
            ? 'Use this when the refund did not actually arrive. The amount goes back to being in your favour with the supplier.'
            : 'Use this when the money did not actually reach the supplier, e.g. a cheque that bounced. The bills it paid become unpaid again. The original record is kept.'
        }
        confirmLabel="Reverse"
        tone="danger"
        requireReason
        busy={reverse.isPending}
        onConfirm={async (reason) => {
          try {
            await reverse.mutateAsync({ id: reversing!.id, reason });
            toast.success(`${reversing!.paymentNo} reversed`);
            setReversing(null);
          } catch (e) {
            toast.error('Could not reverse', errorMessage(e));
          }
        }}
      />
    </>
  );
}
