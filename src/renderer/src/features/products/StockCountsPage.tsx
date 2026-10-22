import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, Plus } from 'lucide-react';
import { formatDateTime } from '@shared/time';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select } from '../../components/ui/form';
import { Badge, Card, EmptyState, PageHeader, Spinner } from '../../components/ui/layout';
import { newRequestId } from '../../components/ui/numberInputs';
import { Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { ProductsTabs } from './shared';

export const countStatusBadge = (s: 'OPEN' | 'FINALIZED' | 'CANCELLED') =>
  s === 'OPEN' ? <Badge tone="info">In progress</Badge> : s === 'FINALIZED' ? <Badge tone="success">Finalized</Badge> : <Badge>Cancelled</Badge>;

export function StockCountsPage() {
  const counts = useCommandQuery('stockCounts.list');
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const open = counts.data?.find((c) => c.status === 'OPEN');

  return (
    <>
      <PageHeader
        title="Products & Stock"
        actions={
          !open && (
            <Button icon={<Plus className="size-4" />} onClick={() => setStarting(true)}>
              Start stock count
            </Button>
          )
        }
      />
      <ProductsTabs />
      <Card>
        {counts.isPending ? (
          <Spinner />
        ) : !counts.data?.length ? (
          <EmptyState
            icon={ClipboardList}
            title="No stock counts yet"
            description="A stock count compares what is on the shelves with the system and corrects the difference, with a reason recorded."
            action={
              <Button icon={<Plus className="size-4" />} onClick={() => setStarting(true)}>
                Start stock count
              </Button>
            }
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Count</Th>
                <Th>Scope</Th>
                <Th>Started</Th>
                <Th align="right">Counted</Th>
                <Th align="right">Differences</Th>
                <Th>Status</Th>
              </tr>
            </THead>
            <tbody>
              {counts.data.map((c) => (
                <Tr key={c.id} className="cursor-pointer" tabIndex={0} onClick={() => navigate(`/products/counts/${c.id}`)}>
                  <Td className="font-mono text-[13px]">{c.countNo}</Td>
                  <Td>{c.categoryName ?? 'All products'}</Td>
                  <Td className="tabular">
                    {formatDateTime(c.startedAt)} <span className="text-ink-3">by {c.startedBy}</span>
                  </Td>
                  <Td align="right">
                    {c.countedCount} / {c.lineCount}
                  </Td>
                  <Td align="right">{c.varianceCount}</Td>
                  <Td>{countStatusBadge(c.status)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {starting && <StartCountDialog onClose={() => setStarting(false)} onStarted={(id) => navigate(`/products/counts/${id}`)} />}
    </>
  );
}

function StartCountDialog({ onClose, onStarted }: { onClose(): void; onStarted(id: number): void }) {
  const catalog = useCommandQuery('catalog.get');
  const create = useCommandMutation('stockCounts.create', { invalidate: ['stockCounts.'] });
  const toast = useToast();
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [requestId] = useState(newRequestId);

  const start = async () => {
    try {
      const c = await create.mutateAsync({ categoryId, notes, requestId });
      toast.success(`Stock count ${c.countNo} started`, `${c.lineCount} products to count`);
      onStarted(c.id);
    } catch (e) {
      toast.error('Could not start the count', errorMessage(e));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Start a stock count"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={start} busy={create.isPending}>
            Start count
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Products to count">
          {(p) => (
            <Select {...p} value={categoryId ?? ''} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">All active products</option>
              {catalog.data?.categories
                .filter((c) => c.kind === 'PRODUCT' && c.isActive)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Field label="Notes">{(p) => <Input {...p} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />}</Field>
        <p className="text-[13px] text-ink-3">
          Sales can continue while you count. When you finalize, each counted quantity is compared with the stock at that moment.
        </p>
      </div>
    </Dialog>
  );
}
