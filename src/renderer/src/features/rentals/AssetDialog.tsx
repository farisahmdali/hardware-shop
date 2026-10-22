import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AssetCondition, AssetRow } from '@shared/contracts';
import { formatMoney } from '@shared/money';
import { formatDate, formatDateTime } from '@shared/time';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select } from '../../components/ui/form';
import { KeyValue, Spinner } from '../../components/ui/layout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { pretty } from '../history/labels';
import { AssetStatusBadge } from './shared';

const CONDITIONS: AssetCondition[] = ['NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED'];

/** One physical unit: where it is, its condition, and everything that happened to it. */
export function AssetDialog({ asset, onClose }: { asset: AssetRow; onClose(): void }) {
  const can = useCan();
  const toast = useToast();
  const history = useCommandQuery('rentalAssets.history', { id: asset.id });
  const setStatus = useCommandMutation('rentalAssets.setStatus', { invalidate: ['rentalAssets.', 'rentalProducts.', 'rentals.'] });
  const update = useCommandMutation('rentalAssets.update', { invalidate: ['rentalAssets.', 'rentalProducts.'] });
  const inspecting = asset.status === 'AWAITING_INSPECTION';
  const [status, setNext] = useState<'AVAILABLE' | 'DAMAGED' | 'MAINTENANCE' | 'RETIRED'>(inspecting ? 'AVAILABLE' : asset.status === 'AVAILABLE' ? 'MAINTENANCE' : 'AVAILABLE');
  const [condition, setCondition] = useState<AssetCondition>(asset.condition === 'DAMAGED' ? 'GOOD' : asset.condition);
  const [reason, setReason] = useState(inspecting ? 'Inspected after return' : '');
  const [serial, setSerial] = useState(asset.serialNo);
  const [notes, setNotes] = useState(asset.notes);

  const changeStatus = async () => {
    try {
      await setStatus.mutateAsync({ id: asset.id, version: asset.version, status, condition, reason });
      toast.success(`${asset.assetTag}: ${pretty(status)}`);
      onClose();
    } catch (e) {
      toast.error('Not saved', errorMessage(e));
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`${asset.assetTag} · ${asset.productName}`} size="lg">
      <div className="mb-4 flex items-center gap-2">
        <AssetStatusBadge status={asset.status} overdue={asset.currentRental?.overdue} />
        <span className="text-ink-3">Condition: {pretty(asset.condition)}</span>
      </div>
      <Tabs defaultValue={inspecting ? 'status' : 'details'}>
        <TabsList className="mb-4">
          <TabsTrigger value="details">Details</TabsTrigger>
          {asset.status !== 'RENTED' && asset.status !== 'RETIRED' && can('rentals.return') && (
            <TabsTrigger value="status">{inspecting ? 'Inspect' : 'Change status'}</TabsTrigger>
          )}
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="details">
          <KeyValue
            items={[
              {
                label: 'Now',
                value: asset.currentRental ? (
                  <Link to={`/rentals/${asset.currentRental.agreementId}`} className="text-brand hover:underline" onClick={onClose}>
                    With {asset.currentRental.customerName} ({asset.currentRental.rentalNo}), due {formatDateTime(asset.currentRental.expectedReturnAt)}
                  </Link>
                ) : (
                  'In the shop'
                ),
              },
              ...(asset.nextReservation
                ? [{ label: 'Next reservation', value: `${asset.nextReservation.customerName} from ${formatDateTime(asset.nextReservation.startAt)} (${asset.nextReservation.rentalNo})` }]
                : []),
              ...(asset.purchaseCost !== null ? [{ label: 'Purchase cost', value: formatMoney(asset.purchaseCost) }] : []),
              { label: 'Bought', value: asset.purchaseDate ? formatDate(asset.purchaseDate) : '—' },
            ]}
          />
          {can('rentals.manage') && (
            <div className="mt-5 grid grid-cols-2 gap-3 border-t border-line pt-4">
              <Field label="Serial number">{(p) => <Input {...p} value={serial} onChange={(e) => setSerial(e.target.value)} maxLength={60} />}</Field>
              <Field label="Notes">{(p) => <Input {...p} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />}</Field>
              <div>
                <Button
                  variant="outline"
                  busy={update.isPending}
                  disabled={serial === asset.serialNo && notes === asset.notes}
                  onClick={async () => {
                    try {
                      await update.mutateAsync({ id: asset.id, version: asset.version, serialNo: serial, notes, purchaseCost: asset.purchaseCost ?? 0, purchaseDate: asset.purchaseDate });
                      toast.success('Unit saved');
                      onClose();
                    } catch (e) {
                      toast.error('Not saved', errorMessage(e));
                    }
                  }}
                >
                  Save details
                </Button>
              </div>
            </div>
          )}
        </TabsContent>
        <TabsContent value="status">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Condition">
              {(p) => (
                <Select {...p} value={condition} onChange={(e) => setCondition(e.target.value as AssetCondition)}>
                  {CONDITIONS.map((c) => (
                    <option key={c} value={c}>
                      {pretty(c)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Next status">
              {(p) => (
                <Select {...p} value={status} onChange={(e) => setNext(e.target.value as typeof status)}>
                  <option value="AVAILABLE">Available for rent</option>
                  <option value="MAINTENANCE">Under maintenance</option>
                  <option value="DAMAGED">Damaged</option>
                  {can('rentals.manage') && <option value="RETIRED">Retired (no longer rented)</option>}
                </Select>
              )}
            </Field>
            <Field label="Reason / findings" required className="col-span-2">
              {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}
            </Field>
            <div className="col-span-2 flex justify-end">
              <Button busy={setStatus.isPending} disabled={reason.trim().length < 3} onClick={changeStatus}>
                {inspecting ? 'Record inspection' : 'Change status'}
              </Button>
            </div>
          </div>
        </TabsContent>
        <TabsContent value="history">
          {!history.data ? (
            <Spinner />
          ) : (
            <ol className="flex flex-col gap-2">
              {history.data.events.map((e) => (
                <li key={e.id} className="rounded-md border border-line px-3 py-2">
                  <p className="font-medium text-ink">
                    {pretty(e.event)}
                    {e.toStatus && e.fromStatus !== e.toStatus && <span className="ml-2 font-normal text-ink-3">→ {pretty(e.toStatus)}</span>}
                  </p>
                  <p className="text-[13px] text-ink-3">
                    {formatDateTime(e.occurredAt)} · {e.username ?? 'system'}
                    {e.condition && ` · condition ${pretty(e.condition)}`}
                  </p>
                  {e.notes && <p className="text-[13px] text-ink-2">{e.notes}</p>}
                </li>
              ))}
            </ol>
          )}
        </TabsContent>
      </Tabs>
    </Dialog>
  );
}
