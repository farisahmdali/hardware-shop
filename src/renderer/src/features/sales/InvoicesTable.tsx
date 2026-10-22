import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Search } from 'lucide-react';
import { formatMoney } from '@shared/money';
import { formatDate, formatDateTime } from '@shared/time';
import { useCommandQuery } from '../../lib/api';
import { useDebounced } from '../../lib/useDebounced';
import { Input, Select } from '../../components/ui/form';
import { EmptyState, ErrorBanner, Spinner } from '../../components/ui/layout';
import { Pagination, Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { InvoiceStatusBadge } from './invoiceBadges';

type Status = 'ALL' | 'PAID' | 'PARTIAL' | 'UNPAID' | 'OPEN' | 'OVERDUE' | 'CANCELLED';

/** Invoice list with search and filters; optionally for one customer. */
export function InvoicesTable({ customerId, initialStatus = 'ALL' }: { customerId?: number; initialStatus?: Status }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<Status>(initialStatus);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search.trim());
  const list = useCommandQuery(
    'invoices.list',
    { customerId, search: debounced || undefined, status, from: from || undefined, to: to || undefined, page, pageSize: 50 },
    { placeholderData: (p) => p },
  );

  return (
    <>
      <div className="flex flex-wrap items-end gap-2.5 border-b border-line p-3.5">
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <Input
            aria-label="Search invoices"
            placeholder={customerId ? 'Invoice number…' : 'Invoice number, customer name or phone…'}
            className="pl-9"
            value={search}
            onChange={(e) => (setSearch(e.target.value), setPage(1))}
          />
        </div>
        <Select aria-label="Status" className="w-44" value={status} onChange={(e) => (setStatus(e.target.value as Status), setPage(1))}>
          <option value="ALL">All invoices</option>
          <option value="OPEN">Not fully paid</option>
          <option value="OVERDUE">Overdue</option>
          <option value="PARTIAL">Part paid</option>
          <option value="UNPAID">Unpaid</option>
          <option value="PAID">Paid</option>
          <option value="CANCELLED">Cancelled</option>
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
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <div className="p-4">
          <ErrorBanner message={list.error.message} />
        </div>
      ) : list.data.rows.length === 0 ? (
        <EmptyState icon={FileText} title="No invoices" description="Invoices appear here as soon as a bill is saved." />
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <Th>Invoice</Th>
                <Th>Date</Th>
                {!customerId && <Th>Customer</Th>}
                <Th align="right">Total</Th>
                <Th align="right">Balance</Th>
                <Th>Status</Th>
                <Th>Due</Th>
              </tr>
            </THead>
            <tbody>
              {list.data.rows.map((r) => (
                <Tr
                  key={r.id}
                  tabIndex={0}
                  className="cursor-pointer"
                  onClick={() => navigate(`/sales/invoices/${r.id}`)}
                  onKeyDown={(e) => e.key === 'Enter' && navigate(`/sales/invoices/${r.id}`)}
                >
                  <Td className="font-mono text-[13px] whitespace-nowrap">{r.invoiceNo}</Td>
                  <Td className="tabular whitespace-nowrap">{formatDateTime(r.issuedAt)}</Td>
                  {!customerId && (
                    <Td>
                      {r.customerName}
                      {r.isWalkin && <span className="ml-1 text-[12px] text-ink-3">(walk-in)</span>}
                    </Td>
                  )}
                  <Td align="right" className="font-medium">
                    {formatMoney(r.grandTotal)}
                  </Td>
                  <Td align="right">{r.outstanding > 0 ? formatMoney(r.outstanding) : '—'}</Td>
                  <Td>
                    <InvoiceStatusBadge status={r.status} overdue={r.overdue} />
                  </Td>
                  <Td className="tabular whitespace-nowrap text-ink-3">{r.outstanding > 0 ? formatDate(r.dueDate) : ''}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={page} pageSize={50} total={list.data.total} onPage={setPage} />
        </>
      )}
    </>
  );
}
