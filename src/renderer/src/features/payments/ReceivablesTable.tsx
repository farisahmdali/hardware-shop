import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Search } from 'lucide-react';
import type { ReceivableRow } from '@shared/contracts';
import { formatMoney } from '@shared/money';
import { formatDate } from '@shared/time';
import { useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useDebounced } from '../../lib/useDebounced';
import { Button } from '../../components/ui/button';
import { Input, Select } from '../../components/ui/form';
import { Badge, EmptyState, Spinner } from '../../components/ui/layout';
import { Pagination, Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { ReceivePaymentDialog } from './ReceivePaymentDialog';

type Filter = 'ALL' | 'OVERDUE' | 'PARTIAL' | 'UNPAID';

/** Open bills (unpaid or part-paid invoices and opening balances), oldest due first. */
export function ReceivablesTable({ customerId, initialFilter = 'ALL' }: { customerId?: number; initialFilter?: Filter }) {
  const can = useCan();
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [paying, setPaying] = useState<ReceivableRow | null>(null);
  const debounced = useDebounced(search.trim());
  const list = useCommandQuery(
    'receivables.list',
    { customerId, filter, search: debounced || undefined, page, pageSize: 50 },
    { placeholderData: (p) => p },
  );

  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5 border-b border-line p-3.5">
        {!customerId && (
          <div className="relative min-w-64 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
            <Input
              aria-label="Search open bills"
              placeholder="Invoice number, customer or phone…"
              className="pl-9"
              value={search}
              onChange={(e) => (setSearch(e.target.value), setPage(1))}
            />
          </div>
        )}
        <Select aria-label="Show" className="w-48" value={filter} onChange={(e) => (setFilter(e.target.value as Filter), setPage(1))}>
          <option value="ALL">All open bills</option>
          <option value="OVERDUE">Overdue</option>
          <option value="PARTIAL">Part paid</option>
          <option value="UNPAID">Unpaid</option>
        </Select>
      </div>
      {!list.data ? (
        <Spinner />
      ) : list.data.rows.length === 0 ? (
        <EmptyState icon={CheckCircle2} title="Nothing outstanding" description="Every bill in this view has been paid." />
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <Th>Bill</Th>
                {!customerId && <Th>Customer</Th>}
                <Th>Date</Th>
                <Th>Due</Th>
                <Th align="right">Bill amount</Th>
                <Th align="right">Still owed</Th>
                <Th />
              </tr>
            </THead>
            <tbody>
              {list.data.rows.map((r) => (
                <Tr key={`${r.docType}-${r.docId}`}>
                  <Td className="font-mono text-[13px]">
                    {r.docType === 'INVOICE' ? (
                      <Link to={`/sales/invoices/${r.docId}`} className="text-brand hover:underline">
                        {r.docNo}
                      </Link>
                    ) : (
                      r.docNo
                    )}
                  </Td>
                  {!customerId && (
                    <Td>
                      <Link to={`/customers/${r.customerId}`} className="hover:text-brand">
                        {r.customerName}
                      </Link>
                      {r.phone && <span className="block text-[12px] text-ink-3">{r.phone}</span>}
                    </Td>
                  )}
                  <Td className="tabular">{formatDate(r.businessDate)}</Td>
                  <Td className="tabular whitespace-nowrap">
                    {formatDate(r.dueDate)}
                    {r.daysOverdue > 0 && (
                      <Badge tone="danger" className="ml-2">
                        {r.daysOverdue} days late
                      </Badge>
                    )}
                  </Td>
                  <Td align="right">{formatMoney(r.amount)}</Td>
                  <Td align="right" className="font-semibold">
                    {formatMoney(r.outstanding)}
                    {r.status === 'PARTIAL' && <span className="block text-[12px] font-normal text-ink-3">part paid</span>}
                  </Td>
                  <Td align="right">
                    {can('payments.receive') && (
                      <Button size="sm" variant="outline" onClick={() => setPaying(r)}>
                        Receive
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
      {paying && (
        <ReceivePaymentDialog
          customerId={paying.customerId}
          customerName={paying.customerName}
          preset={{ docType: paying.docType, docId: paying.docId, docNo: paying.docNo, outstanding: paying.outstanding }}
          onClose={() => setPaying(null)}
        />
      )}
    </>
  );
}
