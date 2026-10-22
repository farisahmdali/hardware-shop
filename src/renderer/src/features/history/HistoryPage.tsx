import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, History as HistoryIcon, Search } from 'lucide-react';
import { formatDateTime } from '@shared/time';
import { useCommandQuery } from '../../lib/api';
import { useDebounced } from '../../lib/useDebounced';
import { Card, EmptyState, ErrorBanner, PageHeader, Spinner, Badge } from '../../components/ui/layout';
import { Input, Select } from '../../components/ui/form';
import { Pagination, Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { ChangeDiff } from './ChangeDiff';
import { actionLabel, actionTone, pretty } from './labels';
import { Link } from 'react-router-dom';

/** Screen that shows a record, for linking from its history entries. */
function recordLink(entityType: string, entityId: string): string | null {
  if (entityType === 'product') return `/products/${entityId}`;
  if (entityType === 'stock_count') return `/products/counts/${entityId}`;
  if (entityType === 'invoice') return `/sales/invoices/${entityId}`;
  if (entityType === 'rental') return `/rentals/${entityId}`;
  if (entityType === 'rental_product') return `/rental-inventory/${entityId}`;
  if (entityType === 'customer') return `/customers/${entityId}`;
  return null;
}

const PAGE_SIZE = 50;

export function HistoryPage() {
  const [page, setPage] = useState(1);
  const [module, setModule] = useState('');
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<number | null>(null);

  const debouncedSearch = useDebounced(search.trim());
  const facets = useCommandQuery('audit.facets');
  const list = useCommandQuery('audit.list', {
    page,
    pageSize: PAGE_SIZE,
    module: module || undefined,
    action: action || undefined,
    search: debouncedSearch || undefined,
    // Date inputs are shop-local calendar days; convert to instants at IST midnight.
    from: from ? new Date(`${from}T00:00:00+05:30`).toISOString() : undefined,
    to: to ? new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86_400_000).toISOString() : undefined,
  });

  const resetPage = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  return (
    <>
      <PageHeader
        title="History & Audit Log"
        description="Every significant change, with who made it, when, and why. Entries cannot be edited or deleted."
      />
      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <div className="relative min-w-64 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
            <Input
              aria-label="Search history"
              placeholder="Search by record ID, reason or value…"
              value={search}
              onChange={(e) => resetPage(setSearch)(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select aria-label="Module" value={module} onChange={(e) => resetPage(setModule)(e.target.value)} className="w-44">
            <option value="">All modules</option>
            {facets.data?.modules.map((m) => (
              <option key={m} value={m}>
                {pretty(m)}
              </option>
            ))}
          </Select>
          <Select aria-label="Action" value={action} onChange={(e) => resetPage(setAction)(e.target.value)} className="w-48">
            <option value="">All actions</option>
            {facets.data?.actions.map((a) => (
              <option key={a} value={a}>
                {actionLabel(a)}
              </option>
            ))}
          </Select>
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            From
            <Input type="date" value={from} onChange={(e) => resetPage(setFrom)(e.target.value)} className="w-40" />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            To
            <Input type="date" value={to} onChange={(e) => resetPage(setTo)(e.target.value)} className="w-40" />
          </label>
        </div>

        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <div className="p-4">
            <ErrorBanner message={list.error.message} onRetry={() => void list.refetch()} />
          </div>
        ) : list.data.rows.length === 0 ? (
          <EmptyState icon={HistoryIcon} title="No matching history" description="Try a wider date range or clear the filters." />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th className="w-8" />
                  <Th>When</Th>
                  <Th>Who</Th>
                  <Th>Module</Th>
                  <Th>Record</Th>
                  <Th>Action</Th>
                  <Th>Reason</Th>
                </tr>
              </THead>
              <tbody>
                {list.data.rows.map((r) => (
                  <Fragment key={r.id}>
                    <Tr className="cursor-pointer" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                      <Td className="text-ink-3">
                        {open === r.id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                      </Td>
                      <Td className="tabular whitespace-nowrap">{formatDateTime(r.occurredAt)}</Td>
                      <Td>{r.username ?? 'system'}</Td>
                      <Td>{pretty(r.module)}</Td>
                      <Td>
                        {pretty(r.entityType)}
                        {r.entityId &&
                          (recordLink(r.entityType, r.entityId) ? (
                            <Link
                              to={recordLink(r.entityType, r.entityId)!}
                              onClick={(e) => e.stopPropagation()}
                              className="ml-1 font-mono text-[12px] text-brand hover:underline"
                            >
                              #{r.entityId}
                            </Link>
                          ) : (
                            <span className="ml-1 font-mono text-[12px] text-ink-3">#{r.entityId}</span>
                          ))}
                      </Td>
                      <Td>
                        <Badge tone={actionTone(r.action)}>{actionLabel(r.action)}</Badge>
                      </Td>
                      <Td className="max-w-72 truncate text-ink-2" title={r.reason ?? ''}>
                        {r.reason}
                      </Td>
                    </Tr>
                    {open === r.id && (
                      <tr className="bg-surface-2/50">
                        <td />
                        <td colSpan={6} className="px-4 pt-2 pb-4">
                          <ChangeDiff before={r.before} after={r.after} />
                          <p className="mt-3 font-mono text-[11px] text-ink-3">
                            Entry #{r.id} · transaction {r.txnRef}
                          </p>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
