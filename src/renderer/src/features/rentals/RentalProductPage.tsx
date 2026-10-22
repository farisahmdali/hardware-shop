import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Plus, Power } from 'lucide-react';
import type { AssetRow } from '@shared/contracts';
import { formatMoney } from '@shared/money';
import { formatDateTime } from '@shared/time';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { ConfirmDialog, Dialog } from '../../components/ui/dialog';
import { Field, Input } from '../../components/ui/form';
import { Badge, Card, CardHeader, ErrorBanner, KeyValue, Spinner } from '../../components/ui/layout';
import { MoneyInput, newRequestId } from '../../components/ui/numberInputs';
import { Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { EntityHistory } from '../history/EntityHistory';
import { AssetDialog } from './AssetDialog';
import { RentalProductDialog } from './RentalProductDialog';
import { AssetStatusBadge } from './shared';

export function RentalProductPage() {
  const id = Number(useParams().id);
  const can = useCan();
  const toast = useToast();
  const query = useCommandQuery('rentalProducts.get', { id });
  const [dialog, setDialog] = useState<'edit' | 'units' | 'active' | null>(null);
  const [asset, setAsset] = useState<AssetRow | null>(null);
  const setActive = useCommandMutation('rentalProducts.setActive', { invalidate: ['rentalProducts.'] });

  if (query.isPending) return <Spinner />;
  if (query.isError) return <ErrorBanner message={query.error.message} />;
  const p = query.data;

  return (
    <>
      <Link to="/rental-inventory" className="mb-3 inline-flex items-center gap-1 text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Rental inventory
      </Link>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-display text-[22px] font-semibold text-ink">{p.name}</h1>
            {!p.isActive && <Badge>Inactive</Badge>}
          </div>
          <p className="text-ink-2">
            <span className="font-mono">{p.code}</span>
            {[p.brand, p.model, p.categoryName].filter(Boolean).map((x) => ` · ${x}`)}
          </p>
        </div>
        {can('rentals.manage') && (
          <div className="flex gap-2">
            <Button icon={<Plus className="size-4" />} onClick={() => setDialog('units')}>
              Add units
            </Button>
            <Button variant="outline" icon={<Pencil className="size-4" />} onClick={() => setDialog('edit')}>
              Edit item & rates
            </Button>
            <Button variant="ghost" icon={<Power className="size-4" />} onClick={() => setDialog('active')}>
              {p.isActive ? 'Deactivate' : 'Reactivate'}
            </Button>
          </div>
        )}
      </header>

      <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="p-5">
          <p className="mb-2 text-[12px] font-medium tracking-wide text-ink-3 uppercase">Rates ({p.priceIncludesTax ? 'incl.' : 'plus'} GST {p.gstRateBp / 100}%)</p>
          <ul className="flex flex-col gap-1">
            {p.rates.map((r) => (
              <li key={r.id} className="flex justify-between">
                <span className="text-ink-2">Per {r.displayLabel}</span>
                <span className="tabular font-semibold">{formatMoney(r.price)}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="p-5">
          <KeyValue
            items={[
              { label: 'Deposit per unit', value: formatMoney(p.depositAmount) },
              { label: 'SAC code', value: p.sacCode },
              { label: 'Units', value: `${p.unitsAvailable} available · ${p.unitsOut} out · ${p.unitsUnavailable} not usable` },
            ]}
          />
        </Card>
        <Card className="p-5 text-ink-2">{p.description || <span className="text-ink-3">No description.</span>}</Card>
      </div>

      <Tabs defaultValue="units">
        <TabsList className="mb-4">
          <TabsTrigger value="units">Units ({p.assets.length})</TabsTrigger>
          {can('audit.view') && <TabsTrigger value="history">Change history</TabsTrigger>}
        </TabsList>
        <TabsContent value="units">
          <Card>
            <Table>
              <THead>
                <tr>
                  <Th>Unit</Th>
                  <Th>Serial</Th>
                  <Th>Status</Th>
                  <Th>Condition</Th>
                  <Th>Where / when</Th>
                </tr>
              </THead>
              <tbody>
                {p.assets.map((a) => (
                  <Tr key={a.id} className="cursor-pointer" tabIndex={0} onClick={() => setAsset(a)}>
                    <Td className="font-mono font-semibold">{a.assetTag}</Td>
                    <Td>{a.serialNo || <span className="text-ink-3">—</span>}</Td>
                    <Td>
                      <AssetStatusBadge status={a.status} overdue={a.currentRental?.overdue} />
                    </Td>
                    <Td>{a.condition.toLowerCase()}</Td>
                    <Td className="text-[13px] text-ink-2">
                      {a.currentRental
                        ? `${a.currentRental.customerName}, due ${formatDateTime(a.currentRental.expectedReturnAt)}`
                        : a.nextReservation
                          ? `Reserved from ${formatDateTime(a.nextReservation.startAt)}`
                          : 'In the shop'}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </TabsContent>
        {can('audit.view') && (
          <TabsContent value="history">
            <Card>
              <EntityHistory entityType="rental_product" entityId={p.id} />
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {dialog === 'edit' && <RentalProductDialog product={p} onClose={() => setDialog(null)} onSaved={() => setDialog(null)} />}
      {dialog === 'units' && <AddUnitsDialog productId={p.id} onClose={() => setDialog(null)} />}
      {asset && <AssetDialog asset={asset} onClose={() => setAsset(null)} />}
      <ConfirmDialog
        open={dialog === 'active'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={p.isActive ? `Stop renting ${p.name}?` : `Rent ${p.name} again?`}
        description={p.isActive ? 'It will not be offered for new rentals. Units out now are returned as usual.' : 'It will be offered for new rentals again.'}
        confirmLabel={p.isActive ? 'Deactivate' : 'Reactivate'}
        tone={p.isActive ? 'danger' : 'primary'}
        requireReason
        busy={setActive.isPending}
        onConfirm={async (reason) => {
          try {
            await setActive.mutateAsync({ id: p.id, version: p.version, isActive: !p.isActive, reason });
            setDialog(null);
          } catch (e) {
            toast.error('Not saved', errorMessage(e));
          }
        }}
      />
    </>
  );
}

function AddUnitsDialog({ productId, onClose }: { productId: number; onClose(): void }) {
  const toast = useToast();
  const [count, setCount] = useState(1);
  const [serials, setSerials] = useState('');
  const [cost, setCost] = useState<number | null>(null);
  const [requestId] = useState(newRequestId);
  const add = useCommandMutation('rentalAssets.add', { invalidate: ['rentalProducts.', 'rentalAssets.'] });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add units"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            busy={add.isPending}
            onClick={async () => {
              try {
                await add.mutateAsync({ requestId, productId, count, serials: serials.split(/[\n,]/).map((s) => s.trim()).filter(Boolean), purchaseCost: cost ?? 0, purchaseDate: null });
                toast.success(`${count} unit${count === 1 ? '' : 's'} added`);
                onClose();
              } catch (e) {
                toast.error('Not saved', errorMessage(e));
              }
            }}
          >
            Add
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="How many">{(p) => <Input {...p} type="number" min={1} max={50} value={count} onChange={(e) => setCount(Math.max(1, Math.min(50, Math.trunc(Number(e.target.value) || 1))))} />}</Field>
        <Field label="Cost per unit">{(p) => <MoneyInput {...p} value={cost} onValueChange={(v) => setCost(v)} />}</Field>
        <Field label="Serial numbers (optional)" hint="Comma separated, one per unit">
          {(p) => <Input {...p} value={serials} onChange={(e) => setSerials(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}
