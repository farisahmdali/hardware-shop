import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, History } from 'lucide-react';
import { formatDateTime } from '@shared/time';
import { useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Badge, EmptyState, ErrorBanner, Spinner } from '../../components/ui/layout';
import { Pagination, Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { ChangeDiff } from './ChangeDiff';
import { RecordRef } from './HistoryPage';
import { actionLabel, actionTone } from './labels';
import { recordHistoryLink } from './links';

/**
 * The complete change history of one record (product, customer, invoice, ...), including entries
 * about records linked to it, such as the payments of a customer.
 */
export function EntityHistory({
  entityType,
  entityId,
  alsoIds,
}: {
  entityType: string;
  entityId: string | number;
  /** Other records of the same type this one stands for, e.g. the earlier versions of an edited bill. */
  alsoIds?: (string | number)[];
}) {
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const id = String(entityId);
  const others = (alsoIds ?? []).map(String).filter((x) => x !== id);
  const list = useCommandQuery(
    'audit.list',
    { record: { type: entityType, id, alsoIds: others.length ? others : undefined }, page, pageSize: 25 },
    { placeholderData: (p) => p },
  );

  if (list.isPending) return <Spinner />;
  if (list.isError) return <div className="p-4"><ErrorBanner message={list.error.message} /></div>;
  if (list.data.rows.length === 0) return <EmptyState icon={History} title="No history yet" />;
  const linked = list.data.rows.some((r) => r.entityType !== entityType || r.entityId !== id);
  return (
    <>
      <Table>
        <THead>
          <tr>
            <Th className="w-8" />
            <Th>When</Th>
            <Th>Who</Th>
            {linked && <Th>Record</Th>}
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
                {linked && (
                  <Td className="text-ink-2">
                    {r.entityType === entityType && r.entityId === id ? (
                      <span className="text-ink-3">This record</span>
                    ) : (
                      <RecordRef type={r.entityType} id={r.entityId} />
                    )}
                  </Td>
                )}
                <Td>
                  <Badge tone={actionTone(r.action)}>{actionLabel(r.action)}</Badge>
                </Td>
                <Td className="text-ink-2">{r.reason}</Td>
              </Tr>
              {open === r.id && (
                <tr className="bg-surface-2/50">
                  <td />
                  <td colSpan={linked ? 5 : 4} className="px-4 pt-2 pb-4">
                    <ChangeDiff before={r.before} after={r.after} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </Table>
      <Pagination page={page} pageSize={25} total={list.data.total} onPage={setPage} />
      <div className="border-t border-line px-4 py-2.5">
        <Link to={recordHistoryLink(entityType, id)} className="text-[13px] text-brand hover:underline">
          Open in History & Audit Log
        </Link>
      </div>
    </>
  );
}

/** A "History" button that shows one record's history in a dialog; hidden from users who may not see the history. */
export function HistoryButton({ entityType, entityId, title, label = 'History' }: { entityType: string; entityId: string | number; title: string; label?: string }) {
  const can = useCan();
  const [open, setOpen] = useState(false);
  if (!can('audit.view')) return null;
  // Placed in clickable table rows: keep clicks and keys (which React passes up from the dialog too) away from the row.
  return (
    <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <Button variant="ghost" size="sm" icon={<History className="size-3.5" />} aria-label={`${label}: ${title}`} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open && (
        <Dialog open onOpenChange={setOpen} title={title} description="Every recorded change, newest first." size="xl">
          <div className="-mx-6 -my-5">
            <EntityHistory entityType={entityType} entityId={entityId} />
          </div>
        </Dialog>
      )}
    </span>
  );
}
