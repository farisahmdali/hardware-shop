import { Fragment, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, FileDown, FileText, Filter, History as HistoryIcon, Search, X } from 'lucide-react';
import type { AuditRow } from '@shared/contracts';
import { formatDateTime } from '@shared/time';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useDebounced } from '../../lib/useDebounced';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Card, EmptyState, ErrorBanner, PageHeader, Spinner, Badge } from '../../components/ui/layout';
import { Input, Select } from '../../components/ui/form';
import { Pagination, Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { ChangeDiff } from './ChangeDiff';
import { actionLabel, actionTone, pretty } from './labels';
import { recordLink } from './links';

const PAGE_SIZE = 50;

/** A shop-local calendar day (YYYY-MM-DD) as the instant it starts, optionally a number of days later. */
const dayStart = (day: string, plusDays = 0) => new Date(new Date(`${day}T00:00:00+05:30`).getTime() + plusDays * 86_400_000).toISOString();

/** "Customer #12", linked to the customer's screen when there is one. */
export function RecordRef({ type, id }: { type: string; id: string | null }) {
  const to = id ? recordLink(type, id) : null;
  return (
    <>
      {pretty(type)}
      {id &&
        (to ? (
          <Link to={to} onClick={(e) => e.stopPropagation()} className="ml-1 font-mono text-[12px] text-brand hover:underline">
            #{id}
          </Link>
        ) : (
          <span className="ml-1 font-mono text-[12px] text-ink-3">#{id}</span>
        ))}
    </>
  );
}

export function HistoryPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const recordType = params.get('type');
  const recordId = params.get('id');
  const record = recordType && recordId ? { type: recordType, id: recordId } : undefined;
  const txnRef = params.get('txn') ?? undefined;

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [module, setModule] = useState('');
  const [action, setAction] = useState('');
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null);

  // Following a link to one record or transaction starts from its first page.
  useEffect(() => setPage(1), [recordType, recordId, txnRef]);

  const debouncedSearch = useDebounced(search.trim());
  const filter = {
    module: module || undefined,
    action: action || undefined,
    userId: userId ? Number(userId) : undefined,
    search: debouncedSearch || undefined,
    record,
    txnRef,
    from: from ? dayStart(from) : undefined,
    to: to ? dayStart(to, 1) : undefined,
  };
  const facets = useCommandQuery('audit.facets');
  const list = useCommandQuery('audit.list', { ...filter, page, pageSize: PAGE_SIZE }, { placeholderData: (p) => p });
  const exportHistory = useCommandMutation('audit.export');

  const resetPage = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };
  const filtersSet = !!(search || module || action || userId || from || to);
  const clearFilters = () => {
    for (const set of [setSearch, setModule, setAction, setUserId, setFrom, setTo]) set('');
    setPage(1);
  };

  const exportAs = async (format: 'csv' | 'pdf') => {
    setExporting(format);
    try {
      const r = await exportHistory.mutateAsync({ ...filter, format });
      if (r) toast.success('History saved', r.path);
    } catch (e) {
      toast.error('Could not export the history', errorMessage(e));
    } finally {
      setExporting(null);
    }
  };

  const showRecord = (r: AuditRow) => setParams({ type: r.entityType, id: r.entityId! });
  const showTransaction = (r: AuditRow) => setParams({ txn: r.txnRef! });

  return (
    <>
      <PageHeader
        title="History & Audit Log"
        description="Every significant change, with who made it, when, and why. Entries cannot be edited or deleted."
        actions={
          <>
            <Button variant="outline" icon={<FileDown className="size-4" />} busy={exporting === 'csv'} disabled={!!exporting} onClick={() => exportAs('csv')}>
              Export CSV
            </Button>
            <Button variant="outline" icon={<FileText className="size-4" />} busy={exporting === 'pdf'} disabled={!!exporting} onClick={() => exportAs('pdf')}>
              Export PDF
            </Button>
          </>
        }
      />
      <Card>
        {(record || txnRef) && (
          <div className="flex flex-wrap items-center gap-3 border-b border-line bg-brand-soft/50 px-4 py-2.5">
            <Filter className="size-4 text-brand" />
            <p className="text-ink">
              {record ? (
                <>
                  Showing the history of <strong>{pretty(record.type)} #{record.id}</strong> and the records linked to it.
                </>
              ) : (
                <>Showing every entry recorded together in one transaction.</>
              )}
            </p>
            {record && recordLink(record.type, record.id) && (
              <Link to={recordLink(record.type, record.id)!} className="text-brand hover:underline">
                Open the {pretty(record.type).toLowerCase()}
              </Link>
            )}
            <Button variant="ghost" size="sm" icon={<X className="size-3.5" />} className="ml-auto" onClick={() => setParams({})}>
              Show all history
            </Button>
          </div>
        )}
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
            <Input
              aria-label="Search history"
              placeholder="Search names, numbers, reasons…"
              value={search}
              onChange={(e) => resetPage(setSearch)(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select aria-label="Module" value={module} onChange={(e) => resetPage(setModule)(e.target.value)} className="w-40">
            <option value="">All modules</option>
            {facets.data?.modules.map((m) => (
              <option key={m} value={m}>
                {pretty(m)}
              </option>
            ))}
          </Select>
          <Select aria-label="Action" value={action} onChange={(e) => resetPage(setAction)(e.target.value)} className="w-44">
            <option value="">All actions</option>
            {facets.data?.actions.map((a) => (
              <option key={a} value={a}>
                {actionLabel(a)}
              </option>
            ))}
          </Select>
          <Select aria-label="User" value={userId} onChange={(e) => resetPage(setUserId)(e.target.value)} className="w-40">
            <option value="">All users</option>
            {facets.data?.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            From
            <Input type="date" value={from} onChange={(e) => resetPage(setFrom)(e.target.value)} className="w-36" />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            To
            <Input type="date" value={to} onChange={(e) => resetPage(setTo)(e.target.value)} className="w-36" />
          </label>
          {filtersSet && (
            <Button variant="ghost" onClick={clearFilters}>
              Clear
            </Button>
          )}
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
                      <Td className="text-ink-3">{open === r.id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</Td>
                      <Td className="tabular whitespace-nowrap">{formatDateTime(r.occurredAt)}</Td>
                      <Td>{r.username ?? 'system'}</Td>
                      <Td>{pretty(r.module)}</Td>
                      <Td>
                        <RecordRef type={r.entityType} id={r.entityId} />
                        {r.relatedType && r.relatedId && (
                          <div className="text-[12px] text-ink-3">
                            Linked: <RecordRef type={r.relatedType} id={r.relatedId} />
                          </div>
                        )}
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
                          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px]">
                            <span className="font-mono text-ink-3">Entry #{r.id}</span>
                            {r.txnRef && !txnRef && (
                              <button type="button" className="text-brand hover:underline" onClick={() => showTransaction(r)}>
                                Everything recorded with this change
                              </button>
                            )}
                            {r.entityId && !(record && record.type === r.entityType && record.id === r.entityId) && (
                              <button type="button" className="text-brand hover:underline" onClick={() => showRecord(r)}>
                                Full history of this {pretty(r.entityType).toLowerCase()}
                              </button>
                            )}
                          </div>
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
