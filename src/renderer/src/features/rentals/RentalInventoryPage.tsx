import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Search, Wrench } from 'lucide-react';
import type { AssetRow } from '@shared/contracts';
import { formatMoney } from '@shared/money';
import { formatDateTime } from '@shared/time';
import { useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useDebounced } from '../../lib/useDebounced';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/form';
import { Card, EmptyState, PageHeader, Spinner } from '../../components/ui/layout';
import { Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { cn } from '../../lib/cn';
import { AssetDialog } from './AssetDialog';
import { RentalProductDialog } from './RentalProductDialog';
import { ASSET_STATUS, AssetStatusBadge } from './shared';

const BOARD_FILTERS = ['ALL', 'AVAILABLE', 'RENTED', 'OVERDUE', 'AWAITING_INSPECTION', 'MAINTENANCE', 'DAMAGED', 'RETIRED'] as const;

export function RentalInventoryPage() {
  const can = useCan();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'items';
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search.trim());
  const products = useCommandQuery('rentalProducts.list', { search: debounced || undefined, active: 'ALL' });

  return (
    <>
      <PageHeader
        title="Rental Inventory"
        description="Equipment you rent out, and every physical unit you own."
        actions={
          can('rentals.manage') && (
            <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
              Add rental item
            </Button>
          )
        }
      />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
        <TabsList className="mb-4">
          <TabsTrigger value="items">Rental items</TabsTrigger>
          <TabsTrigger value="board">Unit board</TabsTrigger>
        </TabsList>
        <TabsContent value="items">
          <Card>
            <div className="border-b border-line p-3.5">
              <div className="relative max-w-md">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
                <Input aria-label="Search rental items" placeholder="Name, code, brand…" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
            </div>
            {!products.data ? (
              <Spinner />
            ) : products.data.length === 0 ? (
              <EmptyState icon={Wrench} title="No rental items yet" description="Add the tools and equipment you rent out, with their rates and how many units you own." />
            ) : (
              <Table>
                <THead>
                  <tr>
                    <Th>Item</Th>
                    <Th>Rates</Th>
                    <Th align="right">Deposit</Th>
                    <Th align="right">Available</Th>
                    <Th align="right">Out</Th>
                    <Th align="right">Not usable</Th>
                    <Th align="right">Owned</Th>
                  </tr>
                </THead>
                <tbody>
                  {products.data.map((p) => (
                    <Tr key={p.id} tabIndex={0} className={cn('cursor-pointer', !p.isActive && 'opacity-60')} onClick={() => navigate(`/rental-inventory/${p.id}`)}>
                      <Td>
                        <span className="font-medium">{p.name}</span>
                        <span className="block text-[12px] text-ink-3">
                          <span className="font-mono">{p.code}</span>
                          {[p.brand, p.model, p.categoryName].filter(Boolean).map((x) => ` · ${x}`)}
                          {!p.isActive && ' · inactive'}
                        </span>
                      </Td>
                      <Td className="text-[13px]">{p.rates.map((r) => `${formatMoney(r.price)}/${r.displayLabel}`).join(' · ')}</Td>
                      <Td align="right">{formatMoney(p.depositAmount)}</Td>
                      <Td align="right" className={cn('font-semibold', p.unitsAvailable === 0 ? 'text-danger' : 'text-success')}>
                        {p.unitsAvailable}
                      </Td>
                      <Td align="right">{p.unitsOut}</Td>
                      <Td align="right" className={p.unitsUnavailable > 0 ? 'text-warning' : 'text-ink-3'}>
                        {p.unitsUnavailable}
                      </Td>
                      <Td align="right">{p.unitsTotal}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="board">
          <UnitBoard />
        </TabsContent>
      </Tabs>
      {adding && <RentalProductDialog product={null} onClose={() => setAdding(false)} onSaved={(p) => navigate(`/rental-inventory/${p.id}`)} />}
    </>
  );
}

function UnitBoard() {
  const [status, setStatus] = useState<(typeof BOARD_FILTERS)[number]>('ALL');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<AssetRow | null>(null);
  const debounced = useDebounced(search.trim());
  const assets = useCommandQuery('rentalAssets.list', { status, search: debounced || undefined, pageSize: 200 }, { placeholderData: (p) => p });

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <Input aria-label="Search units" placeholder="Unit tag, serial, item or customer…" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {BOARD_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setStatus(f)}
            className={cn(
              'rounded-full border px-3 py-1 text-[13px] font-medium',
              status === f ? 'border-brand bg-brand-soft text-brand' : 'border-line bg-surface text-ink-2 hover:bg-surface-2',
            )}
          >
            {f === 'ALL' ? 'All in use' : f === 'OVERDUE' ? 'Overdue' : ASSET_STATUS[f].label}
          </button>
        ))}
      </div>
      {!assets.data ? (
        <Spinner />
      ) : assets.data.rows.length === 0 ? (
        <Card>
          <EmptyState icon={Wrench} title="No units in this view" />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {assets.data.rows.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setOpen(a)}
              className={cn(
                'rounded-lg border bg-surface p-3.5 text-left shadow-card transition-colors hover:border-brand/40',
                a.currentRental?.overdue ? 'border-danger/50' : a.status === 'AVAILABLE' ? 'border-success/30' : a.status === 'DAMAGED' ? 'border-danger/30' : 'border-line',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono font-semibold text-ink">{a.assetTag}</span>
                <AssetStatusBadge status={a.status} overdue={a.currentRental?.overdue} />
              </div>
              <p className="mt-1 truncate text-ink">{a.productName}</p>
              <p className="text-[12px] text-ink-3">{a.serialNo ? `Serial ${a.serialNo}` : 'No serial'} · condition {a.condition.toLowerCase()}</p>
              {a.currentRental && (
                <p className={cn('mt-2 text-[13px]', a.currentRental.overdue ? 'font-medium text-danger' : 'text-ink-2')}>
                  {a.currentRental.customerName} · due {formatDateTime(a.currentRental.expectedReturnAt)}
                </p>
              )}
              {a.nextReservation && <p className="mt-1 text-[13px] text-info">Reserved from {formatDateTime(a.nextReservation.startAt)}</p>}
            </button>
          ))}
        </div>
      )}
      {open && <AssetDialog asset={open} onClose={() => setOpen(null)} />}
    </>
  );
}
