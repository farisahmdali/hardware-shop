import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PackageOpen, Search } from 'lucide-react';
import { formatMoney } from '@shared/money';
import { formatDate } from '@shared/time';
import { useCommandQuery } from '../../lib/api';
import { useDebounced } from '../../lib/useDebounced';
import { Input, Select } from '../../components/ui/form';
import { EmptyState, Spinner } from '../../components/ui/layout';
import { Pagination, Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { PurchaseStatusBadge } from './shared';

type Status = 'ALL' | 'PAID' | 'PARTIAL' | 'UNPAID' | 'OPEN' | 'OVERDUE' | 'CANCELLED';

/** Purchase bills, newest bill date first. */
export function PurchasesTable({ supplierId, productId }: { supplierId?: number; productId?: number }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<Status>('ALL');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search.trim());
  const list = useCommandQuery(
    'purchases.list',
    { search: debounced || undefined, supplierId, productId, status, from: from || undefined, to: to || undefined, page, pageSize: 50 },
    { placeholderData: (p) => p },
  );
  const reset = <T,>(set: (v: T) => void) => (v: T) => (set(v), setPage(1));

  return (
    <>
      <div className="flex flex-wrap items-end gap-2.5 border-b border-line p-3.5">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <Input
            aria-label="Search purchases"
            placeholder={supplierId ? 'Purchase or supplier bill number…' : 'Purchase number, supplier bill number or supplier…'}
            className="pl-9"
            value={search}
            onChange={(e) => reset(setSearch)(e.target.value)}
          />
        </div>
        <Select aria-label="Payment status" className="w-40" value={status} onChange={(e) => reset(setStatus)(e.target.value as Status)}>
          <option value="ALL">All bills</option>
          <option value="OPEN">Not fully paid</option>
          <option value="OVERDUE">Overdue</option>
          <option value="UNPAID">Unpaid</option>
          <option value="PARTIAL">Part paid</option>
          <option value="PAID">Paid</option>
          <option value="CANCELLED">Cancelled</option>
        </Select>
        <label className="flex flex-col gap-1 text-[12px] text-ink-3">
          Bill date from
          <Input type="date" value={from} onChange={(e) => reset(setFrom)(e.target.value)} className="w-40" />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-ink-3">
          To
          <Input type="date" value={to} onChange={(e) => reset(setTo)(e.target.value)} className="w-40" />
        </label>
      </div>
      {!list.data ? (
        <Spinner />
      ) : list.data.rows.length === 0 ? (
        <EmptyState icon={PackageOpen} title="No purchases" description="Purchase bills recorded here add stock at their cost and show what is owed to suppliers." />
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <Th>Purchase</Th>
                <Th>Supplier bill</Th>
                {!supplierId && <Th>Supplier</Th>}
                <Th>Due</Th>
                <Th>Status</Th>
                <Th align="right">Total</Th>
                <Th align="right">To pay</Th>
              </tr>
            </THead>
            <tbody>
              {list.data.rows.map((p) => (
                <Tr
                  key={p.id}
                  tabIndex={0}
                  className={p.status === 'CANCELLED' ? 'cursor-pointer opacity-60' : 'cursor-pointer'}
                  onClick={() => navigate(`/suppliers/purchases/${p.id}`)}
                  onKeyDown={(e) => e.key === 'Enter' && navigate(`/suppliers/purchases/${p.id}`)}
                >
                  <Td className="font-mono text-[13px] whitespace-nowrap">
                    {p.purchaseNo}
                    <span className="block font-sans text-[12px] text-ink-3">
                      {p.itemCount} item{p.itemCount === 1 ? '' : 's'}
                      {p.returnedTotal > 0 && ` · ${formatMoney(p.returnedTotal)} returned`}
                    </span>
                  </Td>
                  <Td className="whitespace-nowrap">
                    {p.supplierInvoiceNo || <span className="text-ink-3">No number</span>}
                    <span className="block text-[12px] text-ink-3">{formatDate(p.supplierInvoiceDate)}</span>
                  </Td>
                  {!supplierId && <Td className="font-medium">{p.supplierName}</Td>}
                  <Td className={p.overdue ? 'whitespace-nowrap text-danger' : 'whitespace-nowrap text-ink-2'}>{p.status === 'CANCELLED' || p.status === 'PAID' ? '—' : formatDate(p.dueDate)}</Td>
                  <Td>
                    <PurchaseStatusBadge status={p.status} overdue={p.overdue} />
                  </Td>
                  <Td align="right">{formatMoney(p.grandTotal)}</Td>
                  <Td align="right" className={p.outstanding > 0 ? 'font-medium' : 'text-ink-3'}>
                    {p.outstanding > 0 ? formatMoney(p.outstanding) : '—'}
                  </Td>
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
