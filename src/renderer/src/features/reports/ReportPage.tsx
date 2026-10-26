import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowLeft, ArrowUp, FileDown, FileSpreadsheet, Printer, Sheet, UserRound } from 'lucide-react';
import { canRunReport, reportDef, type ReportDef, type ReportParams, type ReportResult, type ReportRow } from '@shared/reports';
import { formatReportCell, NUMERIC_KINDS } from '@shared/reportFormat';
import { formatDateTime } from '@shared/time';
import { call, errorMessage, useCommandQuery } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Input, Select } from '../../components/ui/form';
import { Card, EmptyState, ErrorBanner, PageHeader, Spinner } from '../../components/ui/layout';
import { Pagination } from '../../components/ui/table';
import { cn } from '../../lib/cn';
import { CustomerPicker } from '../customers/CustomerPicker';
import { SupplierPicker } from '../suppliers/SupplierPicker';
import { matchPreset, presetFor, rangePresets } from './ranges';

const PAGE = 100;

const LINKS: Record<NonNullable<ReportRow['link']>['to'], (id: number) => string> = {
  invoice: (id) => `/sales/invoices/${id}`,
  customer: (id) => `/customers/${id}`,
  supplier: (id) => `/suppliers/${id}`,
  product: (id) => `/products/${id}`,
  purchase: (id) => `/suppliers/purchases/${id}`,
  rental: (id) => `/rentals/${id}`,
  rentalProduct: (id) => `/rental-inventory/${id}`,
};

/** Report parameters live in the address, so a dashboard tile or a bookmark opens the same view. */
function useReportParams(def: ReportDef) {
  const [search, setSearch] = useSearchParams();
  const num = (k: string) => (search.get(k) ? Number(search.get(k)) : undefined);
  const preset = presetFor(def.defaultRange);
  const params: ReportParams = {
    from: def.params.includes('range') ? (search.get('from') ?? preset.from) : undefined,
    to: def.params.includes('range') || def.params.includes('asOf') ? (search.get('to') ?? (def.params.includes('range') ? preset.to : undefined)) : undefined,
    groupBy: (search.get('groupBy') as ReportParams['groupBy']) ?? 'day',
    customerId: num('customerId'),
    supplierId: num('supplierId'),
    categoryId: num('categoryId'),
    rentalProductId: num('rentalProductId'),
    option: search.get('option') ?? def.option?.default,
  };
  const set = (patch: Record<string, string | number | undefined>) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '') next.delete(k);
      else next.set(k, String(v));
    }
    setSearch(next, { replace: true });
  };
  return { params, set };
}

export function ReportPage() {
  const def = reportDef(useParams().id ?? '');
  const session = useSession();
  if (!def) return <ErrorBanner title="Report not found" message="This report does not exist." />;
  if (!canRunReport(def, session.permissions)) {
    return <ErrorBanner title="Not available" message="You do not have permission to see this report." />;
  }
  return <ReportView key={def.id} def={def} />;
}

function ReportView({ def }: { def: ReportDef }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { params, set } = useReportParams(def);
  const ready = (def.requires !== 'customer' || !!params.customerId) && (def.requires !== 'supplier' || !!params.supplierId);
  const report = useCommandQuery('reports.run', { reportId: def.id, params }, { enabled: ready, placeholderData: (p) => p });
  const [busy, setBusy] = useState<'csv' | 'xlsx' | 'pdf' | 'print' | null>(null);

  const exportAs = async (format: 'csv' | 'xlsx' | 'pdf' | 'print') => {
    setBusy(format);
    try {
      if (format === 'print') {
        await call('reports.print', { reportId: def.id, params });
      } else {
        const r = await call('reports.export', { reportId: def.id, params, format });
        if (r) toast.success('Report saved', r.path);
      }
    } catch (e) {
      toast.error(format === 'print' ? 'Could not print' : 'Could not save', errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Link to="/reports" className="mb-3 inline-flex items-center gap-1 text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Reports
      </Link>
      <PageHeader
        title={def.title}
        description={def.description}
        actions={
          <>
            <Button variant="outline" icon={<FileSpreadsheet className="size-4" />} busy={busy === 'xlsx'} disabled={!report.data || !!busy} onClick={() => exportAs('xlsx')}>
              Excel
            </Button>
            <Button variant="outline" icon={<Sheet className="size-4" />} busy={busy === 'csv'} disabled={!report.data || !!busy} onClick={() => exportAs('csv')}>
              CSV
            </Button>
            <Button variant="outline" icon={<FileDown className="size-4" />} busy={busy === 'pdf'} disabled={!report.data || !!busy} onClick={() => exportAs('pdf')}>
              PDF
            </Button>
            <Button variant="outline" icon={<Printer className="size-4" />} busy={busy === 'print'} disabled={!report.data || !!busy} onClick={() => exportAs('print')}>
              Print
            </Button>
          </>
        }
      />
      <Filters def={def} params={params} set={set} />
      {!ready ? (
        <Card>
          <EmptyState icon={UserRound} title={`Choose a ${def.requires} to see the report`} />
        </Card>
      ) : report.isError ? (
        <ErrorBanner title="Could not produce the report" message={report.error.message} onRetry={() => void report.refetch()} />
      ) : !report.data ? (
        <Spinner label="Working out the report…" />
      ) : (
        <Results result={report.data} sortable={def.sortable !== false} updating={report.isFetching} onOpen={(to) => navigate(to)} />
      )}
    </>
  );
}

function Filters({ def, params, set }: { def: ReportDef; params: ReportParams; set(patch: Record<string, string | number | undefined>): void }) {
  const [picking, setPicking] = useState<'customer' | 'supplier' | null>(null);
  const catalog = useCommandQuery('catalog.get', undefined, { enabled: def.params.includes('category') });
  const rentalProducts = useCommandQuery('rentalProducts.list', { active: 'ALL' }, { enabled: def.params.includes('rentalProduct') });
  const customer = useCommandQuery('customers.get', { id: params.customerId ?? 0 }, { enabled: !!params.customerId });
  const supplier = useCommandQuery('suppliers.get', { id: params.supplierId ?? 0 }, { enabled: !!params.supplierId });
  const presets = rangePresets();
  const preset = params.from && params.to ? matchPreset(params.from, params.to) : 'custom';
  const has = (k: ReportDef['params'][number]) => def.params.includes(k);
  if (def.params.length === 0) return null;

  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-end gap-3 p-3.5">
        {has('range') && (
          <>
            <label className="flex flex-col gap-1 text-[12px] text-ink-3">
              Period
              <Select
                aria-label="Period"
                className="w-48"
                value={preset}
                onChange={(e) => {
                  const p = presets.find((x) => x.key === e.target.value);
                  if (p) set({ from: p.from, to: p.to });
                }}
              >
                {presets
                  .filter((p) => p.key !== 'next7' || def.defaultRange === 'next7')
                  .map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label}
                    </option>
                  ))}
                <option value="custom">Custom dates</option>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-ink-3">
              From
              <Input aria-label="From" type="date" className="w-40" value={params.from ?? ''} onChange={(e) => e.target.value && set({ from: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-ink-3">
              To
              <Input aria-label="To" type="date" className="w-40" value={params.to ?? ''} onChange={(e) => e.target.value && set({ to: e.target.value })} />
            </label>
          </>
        )}
        {has('asOf') && (
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            On date
            <Input aria-label="On date" type="date" className="w-40" value={params.to ?? ''} onChange={(e) => set({ to: e.target.value || undefined })} />
          </label>
        )}
        {has('groupBy') && (
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            Show by
            <Select aria-label="Show by" className="w-32" value={params.groupBy} onChange={(e) => set({ groupBy: e.target.value })}>
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </Select>
          </label>
        )}
        {has('category') && (
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            Category
            <Select aria-label="Category" className="w-48" value={params.categoryId ?? ''} onChange={(e) => set({ categoryId: e.target.value || undefined })}>
              <option value="">All categories</option>
              {catalog.data?.categories
                .filter((c) => c.kind === 'PRODUCT')
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </Select>
          </label>
        )}
        {has('rentalProduct') && (
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            Rental item
            <Select aria-label="Rental item" className="w-56" value={params.rentalProductId ?? ''} onChange={(e) => set({ rentalProductId: e.target.value || undefined })}>
              <option value="">All rental items</option>
              {rentalProducts.data?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        {def.option && (
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            {def.option.label}
            <Select aria-label={def.option.label} className="w-56" value={params.option} onChange={(e) => set({ option: e.target.value === def.option!.default ? undefined : e.target.value })}>
              {def.option.choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </label>
        )}
        {has('customer') && (
          <div className="flex flex-col gap-1 text-[12px] text-ink-3">
            Customer
            <div className="flex gap-1">
              <Button variant="outline" className="min-w-44 justify-start" onClick={() => setPicking('customer')}>
                {params.customerId ? (customer.data?.name ?? '…') : def.requires === 'customer' ? 'Choose customer' : 'All customers'}
              </Button>
              {params.customerId && def.requires !== 'customer' && (
                <Button variant="ghost" onClick={() => set({ customerId: undefined })}>
                  Clear
                </Button>
              )}
            </div>
          </div>
        )}
        {has('supplier') && (
          <div className="flex flex-col gap-1 text-[12px] text-ink-3">
            Supplier
            <div className="flex gap-1">
              <Button variant="outline" className="min-w-44 justify-start" onClick={() => setPicking('supplier')}>
                {params.supplierId ? (supplier.data?.name ?? '…') : def.requires === 'supplier' ? 'Choose supplier' : 'All suppliers'}
              </Button>
              {params.supplierId && def.requires !== 'supplier' && (
                <Button variant="ghost" onClick={() => set({ supplierId: undefined })}>
                  Clear
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
      {picking === 'customer' && (
        <CustomerPicker
          includeWalkin={false}
          onClose={() => setPicking(null)}
          onPick={(c) => {
            setPicking(null);
            set({ customerId: c.id });
          }}
        />
      )}
      {picking === 'supplier' && (
        <SupplierPicker
          onClose={() => setPicking(null)}
          onPick={(s) => {
            setPicking(null);
            set({ supplierId: s.id });
          }}
        />
      )}
    </Card>
  );
}

function Results({ result: r, sortable, updating, onOpen }: { result: ReportResult; sortable: boolean; updating: boolean; onOpen(to: string): void }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [page, setPage] = useState(1);
  const canSort = sortable && r.rows.every((row) => !row.style);
  const rows = useMemo(() => {
    if (!sort || !canSort) return r.rows;
    return [...r.rows].sort((a, b) => {
      const x = a.cells[sort.key] ?? null;
      const y = b.cells[sort.key] ?? null;
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en-IN', { numeric: true })) * sort.dir;
    });
  }, [r.rows, sort, canSort]);
  const shown = rows.slice((page - 1) * PAGE, page * PAGE);

  return (
    <div className={cn('flex flex-col gap-4 transition-opacity', updating && 'opacity-60')}>
      {r.summary.length > 0 && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {r.summary.map((s) => (
            <div key={s.label} className="rounded-lg border border-line bg-surface px-4 py-3 shadow-card">
              <p className="text-[12px] font-medium tracking-wide text-ink-3 uppercase">{s.label}</p>
              <p className="tabular mt-1 text-xl font-semibold text-ink">{formatReportCell(s.kind, s.value)}</p>
              {s.hint && <p className="text-[12px] text-ink-3">{s.hint}</p>}
            </div>
          ))}
        </div>
      )}
      <Card>
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 text-[13px] text-ink-3">
          <span>{r.subtitle}</span>
          <span>
            {r.rows.length.toLocaleString('en-IN')} row{r.rows.length === 1 ? '' : 's'} · worked out {formatDateTime(r.generatedAt)}
          </span>
        </div>
        {r.rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-ink-3">Nothing to show for this period and these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 z-10 bg-surface-2 text-[12px] tracking-wide text-ink-3 uppercase">
                <tr>
                  {r.columns.map((c) => {
                    const numeric = NUMERIC_KINDS.has(c.kind);
                    const active = sort?.key === c.key;
                    return (
                      <th key={c.key} className={cn('border-b border-line px-3 py-2.5 font-semibold whitespace-nowrap', numeric && 'text-right')}>
                        {canSort ? (
                          <button
                            type="button"
                            className={cn('inline-flex items-center gap-1 uppercase hover:text-ink', active && 'text-ink')}
                            onClick={() => {
                              setPage(1);
                              setSort(active ? (sort.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: numeric ? -1 : 1 });
                            }}
                          >
                            {c.label}
                            {active && (sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                          </button>
                        ) : (
                          c.label
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {shown.map((row, i) => (
                  <tr
                    key={i}
                    tabIndex={row.link ? 0 : undefined}
                    onClick={() => row.link && onOpen(LINKS[row.link.to](row.link.id))}
                    onKeyDown={(e) => e.key === 'Enter' && row.link && onOpen(LINKS[row.link.to](row.link.id))}
                    className={cn(
                      'border-b border-line last:border-b-0',
                      row.link && 'cursor-pointer hover:bg-surface-2/60',
                      row.style === 'section' && 'bg-surface-2/70 font-semibold',
                      row.style === 'subtotal' && 'font-semibold',
                      row.style === 'total' && 'bg-brand-soft/60 font-bold',
                    )}
                  >
                    {r.columns.map((c) => {
                      const v = row.cells[c.key] ?? null;
                      return (
                        <td
                          key={c.key}
                          className={cn(
                            'px-3 py-2 align-top',
                            NUMERIC_KINDS.has(c.kind) && 'tabular text-right whitespace-nowrap',
                            c.kind === 'code' && 'font-mono text-[13px] whitespace-nowrap',
                            c.kind === 'text' && 'min-w-32',
                            (c.kind === 'date' || c.kind === 'datetime') && 'tabular whitespace-nowrap',
                            typeof v === 'number' && v < 0 && c.kind === 'money' && 'text-danger',
                          )}
                        >
                          {formatReportCell(c.kind, v)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
              {r.totals && (
                <tfoot>
                  <tr className="border-t-2 border-line-strong bg-surface-2/60 font-semibold">
                    {r.columns.map((c) => (
                      <td key={c.key} className={cn('px-3 py-2.5', NUMERIC_KINDS.has(c.kind) && 'tabular text-right whitespace-nowrap')}>
                        {formatReportCell(c.kind, r.totals![c.key] ?? null)}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
        {rows.length > PAGE && <Pagination page={page} pageSize={PAGE} total={rows.length} onPage={setPage} />}
      </Card>
      {r.notes.length > 0 && (
        <div className={cn('rounded-lg border px-4 py-3 text-[13px]', r.truncated ? 'border-warning/40 bg-warning-soft' : 'border-line bg-surface-2')}>
          {r.notes.map((n) => (
            <p key={n} className="text-ink-2">
              {n}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
