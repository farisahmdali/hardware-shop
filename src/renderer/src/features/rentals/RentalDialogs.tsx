import { useMemo, useState } from 'react';
import type { AssetCondition, RentalDetail } from '@shared/contracts';
import { formatMoney } from '@shared/money';
import { formatDateTime } from '@shared/time';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { useDebounced } from '../../lib/useDebounced';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Checkbox, Field, Input, Select } from '../../components/ui/form';
import { ErrorBanner } from '../../components/ui/layout';
import { MoneyInput, newRequestId } from '../../components/ui/numberInputs';
import { fromLocalInput, PaymentLines, toLocalInput, toPayments, type PaymentEntry } from './shared';

const INVALIDATE = ['rentals.', 'rentalAssets.', 'rentalProducts.', 'invoices.', 'customers.', 'receivables.', 'payments.', 'sales.'];
const HOUR = 3_600_000;

export function ExtendDialog({ rental, onClose }: { rental: RentalDetail; onClose(): void }) {
  const toast = useToast();
  const [local, setLocal] = useState(() => toLocalInput(new Date(Date.parse(rental.expectedReturnAt) + 24 * HOUR).toISOString()));
  const [reason, setReason] = useState('');
  const [payments, setPayments] = useState<PaymentEntry[]>([]);
  const [requestId] = useState(newRequestId);
  const iso = fromLocalInput(local);
  const valid = !!iso && iso > rental.expectedReturnAt;
  const debounced = useDebounced(iso ?? '', 250);
  const quote = useCommandQuery('rentals.extendQuote', { id: rental.id, newExpectedReturnAt: debounced }, { enabled: valid && debounced === iso, placeholderData: (p) => p });
  const extend = useCommandMutation('rentals.extend', { invalidate: INVALIDATE });
  const due = quote.data?.bill.grandTotal ?? 0;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Extend ${rental.rentalNo}`}
      description={`Currently due back ${formatDateTime(rental.expectedReturnAt)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            busy={extend.isPending}
            disabled={!valid || reason.trim().length < 3 || quote.isFetching}
            onClick={async () => {
              try {
                await extend.mutateAsync({ requestId, id: rental.id, version: rental.version, newExpectedReturnAt: iso!, reason, payments: toPayments(payments) });
                toast.success('Rental extended', `Now due ${formatDateTime(iso!)}`);
                onClose();
              } catch (e) {
                toast.error('Not extended', errorMessage(e));
              }
            }}
          >
            Extend {due > 0 && `· ${formatMoney(due)}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="New return time" error={iso && !valid ? 'Must be later than the current return time' : undefined}>
          {(p) => <Input {...p} type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} />}
        </Field>
        <div className="flex gap-1.5">
          {[24, 48, 168].map((h) => (
            <Button key={h} size="sm" variant="ghost" onClick={() => setLocal(toLocalInput(new Date(Date.parse(rental.expectedReturnAt) + h * HOUR).toISOString()))}>
              +{h === 168 ? '1 week' : `${h / 24} day${h > 24 ? 's' : ''}`}
            </Button>
          ))}
        </div>
        {quote.data && valid && (
          <div className="rounded-md bg-surface-2 px-3 py-2">
            {quote.data.billing === 'AT_RETURN' ? (
              <p className="text-ink-2">This shop bills rentals on return; nothing is charged now.</p>
            ) : (
              <>
                {quote.data.items.map((i) => (
                  <p key={i.itemId} className="text-[13px] text-ink-2">
                    <span className="font-mono">{i.assetTag}</span>: {formatMoney(i.amount)} — {i.explanation}
                  </p>
                ))}
                <p className="mt-1 font-semibold text-ink">Extra charge {formatMoney(due)} (incl. GST)</p>
              </>
            )}
          </div>
        )}
        <Field label="Reason" required>
          {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. Job delayed by rain" />}
        </Field>
        {due > 0 && <PaymentLines due={due} value={payments} onChange={setPayments} />}
      </div>
    </Dialog>
  );
}

interface ReturnRow {
  selected: boolean;
  condition: AssetCondition;
  nextStatus: 'AVAILABLE' | 'AWAITING_INSPECTION' | 'DAMAGED' | 'MAINTENANCE';
  notes: string;
  damage: number | null;
  damageReason: string;
  waive: boolean;
  waiveAmount: number | null;
  waiveReason: string;
}

export function ReturnDialog({ rental, onClose }: { rental: RentalDetail; onClose(): void }) {
  const toast = useToast();
  const can = useCan();
  const out = rental.items.filter((i) => i.status === 'OUT');
  const [rows, setRows] = useState<Record<number, ReturnRow>>(() =>
    Object.fromEntries(
      out.map((i) => [
        i.id,
        { selected: true, condition: 'GOOD', nextStatus: 'AVAILABLE', notes: '', damage: null, damageReason: '', waive: false, waiveAmount: 0, waiveReason: '' } satisfies ReturnRow,
      ]),
    ),
  );
  const [payments, setPayments] = useState<PaymentEntry[]>([]);
  const [requestId] = useState(newRequestId);
  const selectedIds = out.filter((i) => rows[i.id]?.selected).map((i) => i.id);
  const quote = useCommandQuery('rentals.returnQuote', { id: rental.id, itemIds: selectedIds }, { enabled: selectedIds.length > 0 });
  const doReturn = useCommandMutation('rentals.return', { invalidate: INVALIDATE });
  const set = (id: number, patch: Partial<ReturnRow>) => setRows((r) => ({ ...r, [id]: { ...r[id]!, ...patch } }));

  const estimate = useMemo(() => {
    let total = 0;
    for (const id of selectedIds) {
      const r = rows[id]!;
      const q = quote.data?.items.find((x) => x.itemId === id);
      total += r.waive ? (r.waiveAmount ?? 0) : (q?.amount ?? 0);
      total += r.damage ?? 0;
    }
    return total;
  }, [selectedIds, rows, quote.data]);

  const submit = async () => {
    try {
      await doReturn.mutateAsync({
        requestId,
        id: rental.id,
        version: rental.version,
        payments: toPayments(payments),
        items: selectedIds.map((id) => {
          const r = rows[id]!;
          const q = quote.data?.items.find((x) => x.itemId === id);
          return {
            itemId: id,
            condition: r.condition,
            nextStatus: r.nextStatus,
            notes: r.notes,
            damageCharge: r.damage ?? 0,
            damageReason: r.damageReason,
            lateFeeOverride: r.waive && q && (r.waiveAmount ?? 0) < q.amount ? (r.waiveAmount ?? 0) : undefined,
            lateFeeReason: r.waiveReason,
          };
        }),
      });
      toast.success('Return recorded');
      onClose();
    } catch (e) {
      toast.error('Return not saved', errorMessage(e));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Return items · ${rental.rentalNo}`}
      description={`Due back ${formatDateTime(rental.expectedReturnAt)}. Charges below include GST where applicable.`}
      size="xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={doReturn.isPending} disabled={selectedIds.length === 0 || quote.isFetching} onClick={submit}>
            Record return {estimate > 0 && `· charges about ${formatMoney(estimate)}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {out.map((i) => {
          const r = rows[i.id]!;
          const q = quote.data?.items.find((x) => x.itemId === i.id);
          return (
            <div key={i.id} className="rounded-lg border border-line p-3">
              <div className="flex items-center justify-between gap-3">
                <Checkbox
                  checked={r.selected}
                  onChange={(v) => set(i.id, { selected: v })}
                  label={
                    <>
                      <span className="font-medium">{i.productName}</span> <span className="font-mono text-[13px] text-ink-3">{i.assetTag}</span>
                      <span className="ml-2 text-[13px] text-ink-3">went out {i.conditionAtIssue?.toLowerCase()}</span>
                    </>
                  }
                />
                {r.selected && q && (
                  <span className={q.amount > 0 ? 'text-[13px] font-medium text-warning' : 'text-[13px] text-success'}>{q.amount > 0 ? `Late fee ${formatMoney(q.amount)}` : 'No late fee'}</span>
                )}
              </div>
              {r.selected && (
                <div className="mt-3 grid grid-cols-4 gap-3">
                  <Field label="Condition on return">
                    {(p) => (
                      <Select
                        {...p}
                        value={r.condition}
                        onChange={(e) => {
                          const condition = e.target.value as AssetCondition;
                          set(i.id, { condition, nextStatus: condition === 'DAMAGED' ? 'DAMAGED' : r.nextStatus === 'DAMAGED' ? 'AVAILABLE' : r.nextStatus });
                        }}
                      >
                        {['GOOD', 'FAIR', 'POOR', 'DAMAGED'].map((c) => (
                          <option key={c} value={c}>
                            {c.charAt(0) + c.slice(1).toLowerCase()}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label="Unit goes to">
                    {(p) => (
                      <Select {...p} value={r.nextStatus} onChange={(e) => set(i.id, { nextStatus: e.target.value as ReturnRow['nextStatus'] })}>
                        <option value="AVAILABLE" disabled={r.condition === 'DAMAGED'}>
                          Available now
                        </option>
                        <option value="AWAITING_INSPECTION">Awaiting inspection</option>
                        <option value="MAINTENANCE">Maintenance</option>
                        <option value="DAMAGED">Damaged</option>
                      </Select>
                    )}
                  </Field>
                  <Field label="Damage charge">{(p) => <MoneyInput {...p} value={r.damage} onValueChange={(v) => set(i.id, { damage: v })} />}</Field>
                  <Field label={r.damage ? 'Damage details' : 'Notes'} required={!!r.damage}>
                    {(p) => (
                      <Input
                        {...p}
                        value={r.damage ? r.damageReason : r.notes}
                        maxLength={300}
                        onChange={(e) => set(i.id, r.damage ? { damageReason: e.target.value, notes: e.target.value } : { notes: e.target.value })}
                      />
                    )}
                  </Field>
                  {q && q.amount > 0 && (
                    <div className="col-span-4 rounded-md bg-surface-2 px-3 py-2 text-[13px]">
                      <p className="text-ink-2">{q.explanation}</p>
                      {can('rentals.depositDeduct') && (
                        <div className="mt-2 flex flex-wrap items-center gap-3">
                          <Checkbox checked={r.waive} onChange={(v) => set(i.id, { waive: v })} label="Reduce or waive the late fee" />
                          {r.waive && (
                            <>
                              <div className="w-36">
                                <MoneyInput aria-label="Late fee to charge" value={r.waiveAmount} onValueChange={(v) => set(i.id, { waiveAmount: v })} />
                              </div>
                              <Input aria-label="Reason for waiver" placeholder="Reason" className="h-9 w-72" value={r.waiveReason} onChange={(e) => set(i.id, { waiveReason: e.target.value })} />
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {estimate > 0 && <PaymentLines due={estimate} value={payments} onChange={setPayments} label="Collect now (optional)" />}
        {rental.deposit.held > 0 && <p className="text-[13px] text-ink-3">The {formatMoney(rental.deposit.held)} deposit can be used for these charges afterwards, under “Settle deposit”.</p>}
      </div>
    </Dialog>
  );
}

export function SettleDepositDialog({ rental, onClose }: { rental: RentalDetail; onClose(): void }) {
  const toast = useToast();
  const can = useCan();
  const methods = useCommandQuery('paymentMethods.list', {});
  const held = rental.deposit.held;
  const [apply, setApply] = useState<number | null>(can('rentals.depositDeduct') ? Math.min(held, rental.outstanding) : 0);
  const [reason, setReason] = useState(rental.outstanding > 0 ? 'Rental charges due' : '');
  const [methodId, setMethodId] = useState<number | null>(null);
  const [requestId] = useState(newRequestId);
  const settle = useCommandMutation('rentals.settleDeposit', { invalidate: INVALIDATE });
  const refund = Math.max(0, held - (apply ?? 0));
  const method = methodId ?? methods.data?.[0]?.id ?? null;
  const tooMuch = (apply ?? 0) > Math.min(held, rental.outstanding);

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Settle deposit · ${rental.rentalNo}`}
      description={`Deposit held ${formatMoney(held)} · unpaid rental charges ${formatMoney(rental.outstanding)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            busy={settle.isPending}
            disabled={tooMuch || ((apply ?? 0) > 0 && reason.trim().length < 3) || (refund > 0 && !method)}
            onClick={async () => {
              try {
                await settle.mutateAsync({ requestId, id: rental.id, applyAmount: apply ?? 0, applyReason: reason, refundAmount: refund, refundMethodId: method ?? undefined, refundReference: '' });
                toast.success('Deposit settled', refund > 0 ? `Refund ${formatMoney(refund)} to the customer` : undefined);
                onClose();
              } catch (e) {
                toast.error('Not saved', errorMessage(e));
              }
            }}
          >
            Settle
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="Use for unpaid charges" hint={can('rentals.depositDeduct') ? `Up to ${formatMoney(Math.min(held, rental.outstanding))}` : 'Needs the deposit deduction permission'} error={tooMuch ? 'More than is held or unpaid' : undefined}>
          {(p) => <MoneyInput {...p} value={apply} disabled={!can('rentals.depositDeduct')} onValueChange={(v) => setApply(v)} />}
        </Field>
        <Field label="Reason for using the deposit" required={(apply ?? 0) > 0}>
          {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />}
        </Field>
        <div className="col-span-2 flex items-center justify-between rounded-md bg-surface-2 px-3 py-2">
          <span className="font-medium">Refund to the customer</span>
          <span className="tabular text-lg font-semibold">{formatMoney(refund)}</span>
        </div>
        {refund > 0 && (
          <Field label="Refund paid by">
            {(p) => (
              <Select {...p} value={method ?? ''} onChange={(e) => setMethodId(Number(e.target.value))}>
                {methods.data?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>
    </Dialog>
  );
}

export function IssueReservedDialog({ rental, onClose }: { rental: RentalDetail; onClose(): void }) {
  const toast = useToast();
  const methods = useCommandQuery('paymentMethods.list', {});
  const quote = useCommandQuery('rentals.quote', {
    customerId: rental.customerId,
    assetIds: rental.items.filter((i) => i.status === 'RESERVED').map((i) => i.assetId),
    expectedReturnAt: rental.expectedReturnAt,
    reserve: false,
    discount: null,
  });
  const [deposit, setDeposit] = useState<number | null>(null);
  const [methodId, setMethodId] = useState<number | null>(null);
  const [payments, setPayments] = useState<PaymentEntry[]>([]);
  const [requestId] = useState(newRequestId);
  const issue = useCommandMutation('rentals.issueReserved', { invalidate: INVALIDATE });
  const due = quote.data?.billNow.grandTotal ?? 0;
  const depositAmount = deposit ?? quote.data?.depositTotal ?? 0;
  const method = methodId ?? methods.data?.[0]?.id ?? null;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Hand over ${rental.rentalNo}`}
      description={`Runs from now until ${formatDateTime(rental.expectedReturnAt)}.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            busy={issue.isPending}
            disabled={!quote.data}
            onClick={async () => {
              try {
                await issue.mutateAsync({
                  requestId,
                  id: rental.id,
                  version: rental.version,
                  discount: null,
                  expectedChargesTotal: due,
                  deposit: { amount: depositAmount, methodId: method ?? undefined, reference: '' },
                  payments: toPayments(payments),
                });
                toast.success(`${rental.rentalNo} handed over`);
                onClose();
              } catch (e) {
                toast.error('Not issued', errorMessage(e));
              }
            }}
          >
            Hand over
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {quote.isError && <ErrorBanner message={quote.error.message} />}
        {quote.data?.items.map((i) => (
          <p key={i.assetId} className="text-ink-2">
            <span className="font-mono">{i.assetTag}</span> {i.productName}: {formatMoney(i.price.total)} — {i.price.explanation}
          </p>
        ))}
        {quote.data && <p className="font-semibold">Rental charges due {formatMoney(due)}</p>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Deposit">{(p) => <MoneyInput {...p} value={depositAmount} onValueChange={(v) => setDeposit(v ?? 0)} />}</Field>
          <Field label="Deposit paid by">
            {(p) => (
              <Select {...p} value={method ?? ''} onChange={(e) => setMethodId(Number(e.target.value))}>
                {methods.data?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {due > 0 && <PaymentLines due={due} value={payments} onChange={setPayments} label="Payment for charges" />}
      </div>
    </Dialog>
  );
}
