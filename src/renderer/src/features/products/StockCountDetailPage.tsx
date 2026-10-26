import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Search } from 'lucide-react';
import type { StockCountLine } from '@shared/contracts';
import { formatQty } from '@shared/qty';
import { formatDateTime } from '@shared/time';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { useDebounced } from '../../lib/useDebounced';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/dialog';
import { Input, Select } from '../../components/ui/form';
import { Card, ErrorBanner, KeyValue, Spinner } from '../../components/ui/layout';
import { QtyInput, newRequestId } from '../../components/ui/numberInputs';
import { Pagination, Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { countStatusBadge } from './StockCountsPage';
import { HistoryButton } from '../history/EntityHistory';
import { cn } from '../../lib/cn';

const PAGE_SIZE = 50;

export function StockCountDetailPage() {
  const id = Number(useParams().id);
  const toast = useToast();
  const count = useCommandQuery('stockCounts.get', { id });
  const [search, setSearch] = useState('');
  const [show, setShow] = useState<'ALL' | 'UNCOUNTED' | 'COUNTED' | 'VARIANCE'>('ALL');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search.trim());
  const lines = useCommandQuery(
    'stockCounts.lines',
    { id, search: debounced || undefined, show, page, pageSize: PAGE_SIZE },
    { placeholderData: (prev) => prev },
  );
  const [confirm, setConfirm] = useState<'finalize' | 'cancel' | null>(null);
  const [requestId] = useState(newRequestId);
  const finalize = useCommandMutation('stockCounts.finalize', { invalidate: ['stockCounts.', 'products.', 'stock.'] });
  const cancel = useCommandMutation('stockCounts.cancel', { invalidate: ['stockCounts.'] });

  if (count.isPending) return <Spinner />;
  if (count.isError) return <ErrorBanner message={count.error.message} />;
  const c = count.data;
  const isOpen = c.status === 'OPEN';

  return (
    <>
      <Link to="/products/counts" className="mb-3 inline-flex items-center gap-1 text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Stock counts
      </Link>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-display text-[22px] font-semibold text-ink">Stock count {c.countNo}</h1>
            {countStatusBadge(c.status)}
          </div>
          <p className="text-ink-2">
            {c.categoryName ?? 'All products'} · started {formatDateTime(c.startedAt)} by {c.startedBy}
          </p>
        </div>
        <div className="flex gap-2">
          <HistoryButton entityType="stock_count" entityId={c.id} title={`Stock count ${c.countNo}`} />
          {isOpen && (
            <>
              <Button variant="ghost" onClick={() => setConfirm('cancel')}>
                Cancel count
              </Button>
              <Button onClick={() => setConfirm('finalize')} disabled={c.countedCount === 0}>
                Finalize count
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="mb-5 grid grid-cols-3 gap-4">
        <SummaryTile label="Counted" value={`${c.countedCount} of ${c.lineCount}`} />
        <SummaryTile label="Differences" value={String(c.varianceCount)} tone={c.varianceCount > 0 ? 'warning' : undefined} />
        <SummaryTile label="Not counted" value={String(c.lineCount - c.countedCount)} sub={isOpen ? 'Left unchanged when finalized' : undefined} />
      </div>
      {!isOpen && (
        <Card className="mb-5 p-5">
          <KeyValue
            items={[
              { label: c.status === 'FINALIZED' ? 'Finalized' : 'Cancelled', value: `${formatDateTime(c.closedAt)} by ${c.closedBy}` },
              { label: 'Reason', value: c.closeReason },
            ]}
          />
        </Card>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line p-3.5">
          <div className="relative min-w-72 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
            <Input
              aria-label="Search products in this count"
              placeholder="Find a product…"
              value={search}
              onChange={(e) => (setSearch(e.target.value), setPage(1))}
              className="pl-9"
            />
          </div>
          <Select aria-label="Show" className="w-48" value={show} onChange={(e) => (setShow(e.target.value as typeof show), setPage(1))}>
            <option value="ALL">All products</option>
            <option value="UNCOUNTED">Not counted yet</option>
            <option value="COUNTED">Counted</option>
            <option value="VARIANCE">With differences</option>
          </Select>
        </div>
        {!lines.data ? (
          <Spinner />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>Product</Th>
                  <Th align="right">{isOpen ? 'System now' : 'System at finalize'}</Th>
                  <Th align="right">Counted</Th>
                  <Th align="right">Difference</Th>
                </tr>
              </THead>
              <tbody>
                {lines.data.rows.map((l) => (
                  <CountRow key={l.productId} countId={id} line={l} editable={isOpen} onError={(m) => toast.error('Not saved', m)} />
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={lines.data.total} onPage={setPage} />
          </>
        )}
      </Card>

      <ConfirmDialog
        open={confirm === 'finalize'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Finalize this stock count?"
        description={
          <>
            {c.varianceCount} product{c.varianceCount === 1 ? '' : 's'} will be corrected to the counted quantity. Products not counted stay as
            they are. This cannot be undone; later mistakes are fixed with a new adjustment.
          </>
        }
        confirmLabel="Finalize and correct stock"
        requireReason
        busy={finalize.isPending}
        onConfirm={async (reason) => {
          try {
            await finalize.mutateAsync({ id, version: c.version, reason, requestId });
            toast.success('Stock count finalized');
            setConfirm(null);
          } catch (e) {
            toast.error('Could not finalize', errorMessage(e));
          }
        }}
      />
      <ConfirmDialog
        open={confirm === 'cancel'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Cancel this stock count?"
        description="No stock will be changed. The count stays in the list as cancelled."
        confirmLabel="Cancel count"
        tone="danger"
        requireReason
        busy={cancel.isPending}
        onConfirm={async (reason) => {
          try {
            await cancel.mutateAsync({ id, version: c.version, reason });
            setConfirm(null);
          } catch (e) {
            toast.error('Could not cancel', errorMessage(e));
          }
        }}
      />
    </>
  );
}

function SummaryTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warning' }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3 shadow-card">
      <p className="text-[12px] font-medium tracking-wide text-ink-3 uppercase">{label}</p>
      <p className={cn('tabular mt-1 text-xl font-semibold', tone === 'warning' ? 'text-warning' : 'text-ink')}>{value}</p>
      {sub && <p className="text-[12px] text-ink-3">{sub}</p>}
    </div>
  );
}

/** One product line; the counted quantity is saved when the field loses focus or Enter is pressed. */
function CountRow({ countId, line, editable, onError }: { countId: number; line: StockCountLine; editable: boolean; onError(m: string): void }) {
  const qc = useQueryClient();
  const save = useCommandMutation('stockCounts.saveLines');
  const [value, setValue] = useState<number | null>(line.countedQty);
  const [valid, setValid] = useState(true);
  const variance = value === null ? null : value - line.currentQty;

  const commit = async () => {
    if (!valid || value === line.countedQty) return;
    try {
      await save.mutateAsync({ id: countId, lines: [{ productId: line.productId, countedQty: value, note: line.note }] });
      await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('stockCounts.') });
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  return (
    <Tr>
      <Td>
        <span className="font-medium">{line.name}</span>
        <span className="ml-2 font-mono text-[12px] text-ink-3">{line.sku}</span>
      </Td>
      <Td align="right">
        {formatQty(line.currentQty)} <span className="text-ink-3">{line.unitCode}</span>
      </Td>
      <Td align="right" className="w-44">
        {editable ? (
          <QtyInput
            aria-label={`Counted quantity of ${line.name}`}
            value={value}
            allowDecimal={line.allowDecimal}
            unit={line.unitCode}
            onValueChange={(v, ok) => {
              setValue(v);
              setValid(ok);
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            className={cn('h-9', !valid && 'border-danger', save.isPending && 'opacity-60')}
          />
        ) : line.countedQty === null ? (
          <span className="text-ink-3">not counted</span>
        ) : (
          formatQty(line.countedQty)
        )}
      </Td>
      <Td align="right" className={cn('font-medium', variance !== null && variance > 0 && 'text-success', variance !== null && variance < 0 && 'text-danger')}>
        {variance === null || variance === 0 ? (variance === 0 ? '—' : '') : `${variance > 0 ? '+' : '−'}${formatQty(Math.abs(variance))}`}
      </Td>
    </Tr>
  );
}
