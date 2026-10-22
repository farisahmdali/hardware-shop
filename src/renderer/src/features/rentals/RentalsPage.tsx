import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeftRight, Plus, Search } from 'lucide-react';
import { formatMoney } from '@shared/money';
import { formatDateTime } from '@shared/time';
import { useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useDebounced } from '../../lib/useDebounced';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/form';
import { Card, EmptyState, PageHeader, Spinner } from '../../components/ui/layout';
import { Pagination, Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { cn } from '../../lib/cn';
import { lateText, RentalStatusBadge } from './shared';

const FILTERS = [
  { key: 'OPEN', label: 'All open' },
  { key: 'ACTIVE', label: 'Out now' },
  { key: 'OVERDUE', label: 'Overdue' },
  { key: 'RESERVED', label: 'Reservations' },
  { key: 'RETURNED', label: 'Returned · to settle' },
  { key: 'CLOSED', label: 'Closed' },
  { key: 'ALL', label: 'All' },
] as const;

function Tile({ label, value, sub, tone, onClick }: { label: string; value: string; sub: string; tone?: 'danger' | 'warning'; onClick?(): void }) {
  return (
    <button type="button" onClick={onClick} className="rounded-lg border border-line bg-surface px-4 py-3 text-left shadow-card hover:border-brand/40">
      <p className="text-[12px] font-medium tracking-wide text-ink-3 uppercase">{label}</p>
      <p className={cn('tabular mt-1 text-2xl font-semibold', tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-ink')}>{value}</p>
      <p className="text-[13px] text-ink-3">{sub}</p>
    </button>
  );
}

export function RentalsPage() {
  const can = useCan();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filter = (params.get('filter') as (typeof FILTERS)[number]['key']) ?? 'OPEN';
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search.trim());
  const summary = useCommandQuery('rentals.summary');
  const list = useCommandQuery('rentals.list', { filter, search: debounced || undefined, page, pageSize: 50 }, { placeholderData: (p) => p });
  const show = (f: string) => {
    setParams({ filter: f }, { replace: true });
    setPage(1);
  };
  const s = summary.data;

  return (
    <>
      <PageHeader
        title="Rental Transactions"
        description="Equipment out with customers, reservations, returns and deposits."
        actions={
          can('rentals.issue') && (
            <Button icon={<Plus className="size-4" />} onClick={() => navigate('/rentals/new')}>
              New rental
            </Button>
          )
        }
      />
      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile label="Out now" value={s ? String(s.active) : '…'} sub={s ? `${s.unitsOut} units out · ${s.unitsAvailable} available` : ''} onClick={() => show('ACTIVE')} />
        <Tile label="Overdue" value={s ? String(s.overdue) : '…'} sub={s ? `${s.dueToday} more due back today` : ''} tone={s?.overdue ? 'danger' : undefined} onClick={() => show('OVERDUE')} />
        <Tile label="Reservations" value={s ? String(s.reserved) : '…'} sub={s?.awaitingInspection ? `${s.awaitingInspection} unit(s) await inspection` : 'Upcoming'} onClick={() => show('RESERVED')} />
        <Tile label="Deposits held" value={s ? formatMoney(s.depositsHeld) : '…'} sub="Owed back to customers; not income" tone="warning" />
      </div>
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3.5">
          <div className="relative min-w-64 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
            <Input aria-label="Search rentals" placeholder="Rental number, customer, phone or unit…" className="pl-9" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} />
          </div>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => show(f.key)}
              className={cn('rounded-full border px-3 py-1 text-[13px] font-medium', filter === f.key ? 'border-brand bg-brand-soft text-brand' : 'border-line text-ink-2 hover:bg-surface-2')}
            >
              {f.label}
            </button>
          ))}
        </div>
        {!list.data ? (
          <Spinner />
        ) : list.data.rows.length === 0 ? (
          <EmptyState icon={ArrowLeftRight} title="No rentals here" description="Use “New rental” to hand out equipment or reserve it for a future date." />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>Rental</Th>
                  <Th>Customer</Th>
                  <Th>Items</Th>
                  <Th>Due back</Th>
                  <Th>Status</Th>
                  <Th align="right">Deposit held</Th>
                  <Th align="right">Unpaid</Th>
                </tr>
              </THead>
              <tbody>
                {list.data.rows.map((r) => (
                  <Tr key={r.id} tabIndex={0} className="cursor-pointer" onClick={() => navigate(`/rentals/${r.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/rentals/${r.id}`)}>
                    <Td className="font-mono text-[13px] whitespace-nowrap">{r.rentalNo}</Td>
                    <Td>
                      {r.customerName}
                      {r.customerPhone && <span className="block text-[12px] text-ink-3">{r.customerPhone}</span>}
                    </Td>
                    <Td className="max-w-72 text-[13px] text-ink-2">{r.itemsSummary}</Td>
                    <Td className={cn('tabular whitespace-nowrap', r.overdue && 'font-medium text-danger')}>
                      {r.status === 'RESERVED' ? `Starts ${formatDateTime(r.startAt)}` : formatDateTime(r.expectedReturnAt)}
                      {r.overdue && <span className="block text-[12px]">{lateText(r.overdueMinutes)}</span>}
                    </Td>
                    <Td>
                      <RentalStatusBadge status={r.status} overdue={r.overdue} />
                    </Td>
                    <Td align="right">{r.depositHeld ? formatMoney(r.depositHeld) : '—'}</Td>
                    <Td align="right" className={r.outstanding > 0 ? 'font-medium text-warning' : 'text-ink-3'}>
                      {r.outstanding ? formatMoney(r.outstanding) : '—'}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={50} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
