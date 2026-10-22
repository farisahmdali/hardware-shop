import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, History } from 'lucide-react';
import { formatDateTime } from '@shared/time';
import { useCommandQuery } from '../../lib/api';
import { Badge, EmptyState, ErrorBanner, Spinner } from '../../components/ui/layout';
import { Pagination, Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { ChangeDiff } from './ChangeDiff';
import { actionLabel, actionTone } from './labels';

/** The complete change history of one record (product, customer, invoice, ...). */
export function EntityHistory({ entityType, entityId }: { entityType: string; entityId: string | number }) {
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const list = useCommandQuery('audit.list', { entityType, entityId: String(entityId), page, pageSize: 25 });

  if (list.isPending) return <Spinner />;
  if (list.isError) return <div className="p-4"><ErrorBanner message={list.error.message} /></div>;
  if (list.data.rows.length === 0) return <EmptyState icon={History} title="No history yet" />;
  return (
    <>
      <Table>
        <THead>
          <tr>
            <Th className="w-8" />
            <Th>When</Th>
            <Th>Who</Th>
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
                <Td>
                  <Badge tone={actionTone(r.action)}>{actionLabel(r.action)}</Badge>
                </Td>
                <Td className="text-ink-2">{r.reason}</Td>
              </Tr>
              {open === r.id && (
                <tr className="bg-surface-2/50">
                  <td />
                  <td colSpan={4} className="px-4 pt-2 pb-4">
                    <ChangeDiff before={r.before} after={r.after} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </Table>
      <Pagination page={page} pageSize={25} total={list.data.total} onPage={setPage} />
    </>
  );
}
