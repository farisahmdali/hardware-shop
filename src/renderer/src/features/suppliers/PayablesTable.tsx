import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Search } from 'lucide-react';
import type { PayableRow } from '@shared/contracts';
import { formatMoney } from '@shared/money';
import { formatDate } from '@shared/time';
import { useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useDebounced } from '../../lib/useDebounced';
import { Button } from '../../components/ui/button';
import { Input, Select } from '../../components/ui/form';
import { Badge, EmptyState, Spinner } from '../../components/ui/layout';
import { Pagination, Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { PaySupplierDialog } from './SupplierDialogs';

type Filter = 'ALL' | 'OVERDUE' | 'DUE_SOON' | 'PARTIAL' | 'UNPAID';

/** Supplier bills not yet fully paid, earliest due first. */
export function PayablesTable({ supplierId, initialFilter = 'ALL' }: { supplierId?: number; initialFilter?: Filter }) {
  const can = useCan();
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [paying, setPaying] = useState<PayableRow | null>(null);
  const debounced = useDebounced(search.trim());
  const list = useCommandQuery('payables.list', { supplierId, filter, search: debounced || undefined, page, pageSize: 50 }, { placeholderData: (p) => p });

  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5 border-b border-line p-3.5">
        {!supplierId && (
          <div className="relative min-w-60 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
            <Input aria-label="Search bills to pay" placeholder="Bill number or supplier…" className="pl-9" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} />
          </div>
        )}
        <Select aria-label="Show" className="w-48" value={filter} onChange={(e) => (setFilter(e.target.value as Filter), setPage(1))}>
          <option value="ALL">All bills to pay</option>
          <option value="OVERDUE">Overdue</option>
          <option value="DUE_SOON">Due in the next 7 days</option>
          <option value="UNPAID">Unpaid</option>
          <option value="PARTIAL">Part paid</option>
        </Select>
      </div>
      {!list.data ? (
        <Spinner />
      ) : list.data.rows.length === 0 ? (
        <EmptyState icon={CheckCircle2} title="Nothing to pay" description={filter === 'ALL' ? 'Every supplier bill is settled.' : 'No bills match this filter.'} />
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <Th>Bill</Th>
                {!supplierId && <Th>Supplier</Th>}
                <Th>Bill date</Th>
                <Th>Due</Th>
                <Th align="right">Amount</Th>
                <Th align="right">To pay</Th>
                <Th />
              </tr>
            </THead>
            <tbody>
              {list.data.rows.map((r) => (
                <Tr key={`${r.docType}-${r.docId}`}>
                  <Td className="whitespace-nowrap">
                    {r.docType === 'PURCHASE' ? (
                      <Link to={`/suppliers/purchases/${r.docId}`} className="font-mono text-[13px] text-brand hover:underline">
                        {r.docNo}
                      </Link>
                    ) : (
                      r.docNo
                    )}
                    {r.supplierInvoiceNo && <span className="block text-[12px] text-ink-3">Their bill {r.supplierInvoiceNo}</span>}
                  </Td>
                  {!supplierId && (
                    <Td>
                      <Link to={`/suppliers/${r.supplierId}`} className="font-medium hover:text-brand">
                        {r.supplierName}
                      </Link>
                    </Td>
                  )}
                  <Td className="tabular whitespace-nowrap">{formatDate(r.billDate)}</Td>
                  <Td className="whitespace-nowrap">
                    {formatDate(r.dueDate)}
                    {r.daysOverdue > 0 && (
                      <Badge tone="danger" className="ml-2">
                        {r.daysOverdue} day{r.daysOverdue === 1 ? '' : 's'} late
                      </Badge>
                    )}
                  </Td>
                  <Td align="right">{formatMoney(r.amount)}</Td>
                  <Td align="right" className="font-semibold">
                    {formatMoney(r.outstanding)}
                  </Td>
                  <Td align="right">
                    {can('suppliers.pay') && (
                      <Button size="sm" variant="ghost" onClick={() => setPaying(r)}>
                        Pay
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
        <PaySupplierDialog
          supplierId={paying.supplierId}
          supplierName={paying.supplierName}
          preset={{ docType: paying.docType, docId: paying.docId, docNo: paying.docNo, outstanding: paying.outstanding }}
          onClose={() => setPaying(null)}
        />
      )}
    </>
  );
}
