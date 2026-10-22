import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeftRight } from 'lucide-react';
import { formatMoney } from '@shared/money';
import { formatQty } from '@shared/qty';
import { MOVEMENT_TYPES, MOVEMENT_TYPE_KEYS, type MovementType } from '@shared/stock';
import { formatDateTime } from '@shared/time';
import { useCommandQuery } from '../../lib/api';
import { useCanSeeCost } from '../../lib/session';
import { Input, Select } from '../../components/ui/form';
import { Badge, EmptyState, ErrorBanner, Spinner } from '../../components/ui/layout';
import { Pagination, Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { cn } from '../../lib/cn';

const PAGE_SIZE = 50;

/** The stock movement ledger, for one product or all products. */
export function MovementsTable({ productId }: { productId?: number }) {
  const [page, setPage] = useState(1);
  const [type, setType] = useState<MovementType | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const showCost = useCanSeeCost();
  const list = useCommandQuery(
    'stock.movements',
    { productId, type: type || undefined, from: from || undefined, to: to || undefined, page, pageSize: PAGE_SIZE },
    { placeholderData: (prev) => prev },
  );

  return (
    <>
      <div className="flex flex-wrap items-end gap-3 border-b border-line p-3.5">
        <Select
          aria-label="Movement type"
          className="w-56"
          value={type}
          onChange={(e) => {
            setType(e.target.value as MovementType | '');
            setPage(1);
          }}
        >
          <option value="">All movement types</option>
          {MOVEMENT_TYPE_KEYS.map((k) => (
            <option key={k} value={k}>
              {MOVEMENT_TYPES[k].label}
            </option>
          ))}
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
        <EmptyState icon={ArrowLeftRight} title="No stock movements" description="Opening stock, receipts, sales and adjustments appear here." />
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <Th>When</Th>
                {!productId && <Th>Product</Th>}
                <Th>Type</Th>
                <Th align="right">Before</Th>
                <Th align="right">Change</Th>
                <Th align="right">After</Th>
                {showCost && <Th align="right">Value change</Th>}
                <Th>Reason / reference</Th>
                <Th>By</Th>
              </tr>
            </THead>
            <tbody>
              {list.data.rows.map((m) => (
                <Tr key={m.id}>
                  <Td className="tabular whitespace-nowrap">{formatDateTime(m.occurredAt)}</Td>
                  {!productId && (
                    <Td>
                      <Link to={`/products/${m.productId}`} className="font-medium text-brand hover:underline">
                        {m.productName}
                      </Link>
                      <span className="block font-mono text-[12px] text-ink-3">{m.sku}</span>
                    </Td>
                  )}
                  <Td>
                    <Badge tone={m.qtyChange > 0 ? 'success' : m.type === 'DAMAGE' || m.type === 'LOSS' ? 'danger' : 'neutral'}>
                      {MOVEMENT_TYPES[m.type].label}
                    </Badge>
                    {m.negativeOverride && <Badge tone="warning" className="ml-1">Below zero</Badge>}
                  </Td>
                  <Td align="right">{formatQty(m.qtyBefore)}</Td>
                  <Td align="right" className={cn('font-medium', m.qtyChange > 0 ? 'text-success' : 'text-danger')}>
                    {m.qtyChange > 0 ? '+' : '−'}
                    {formatQty(Math.abs(m.qtyChange))} <span className="font-normal text-ink-3">{m.unitCode}</span>
                  </Td>
                  <Td align="right" className="font-medium">
                    {formatQty(m.qtyAfter)}
                  </Td>
                  {showCost && (
                    <Td align="right" className="text-ink-2">
                      {m.costValue === null ? '' : `${m.costValue > 0 ? '+' : m.costValue < 0 ? '−' : ''}${formatMoney(Math.abs(m.costValue))}`}
                      {m.unitCost !== null && m.unitCost > 0 && (
                        <span className="block text-[12px] text-ink-3">@ {formatMoney(m.unitCost)}</span>
                      )}
                    </Td>
                  )}
                  <Td className="max-w-80 text-ink-2">
                    {m.reason}
                    {m.refType === 'STOCK_COUNT' && (
                      <Link to={`/products/counts/${m.refId}`} className="ml-1 text-brand hover:underline">
                        (view count)
                      </Link>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap">{m.username ?? 'system'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
        </>
      )}
    </>
  );
}
