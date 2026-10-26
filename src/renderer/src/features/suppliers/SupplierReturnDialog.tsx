import { useMemo, useState } from 'react';
import type { PurchaseDetail } from '@shared/contracts';
import { proportionalShare } from '@shared/billing';
import { formatMoney } from '@shared/money';
import { formatQty } from '@shared/qty';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select, Textarea } from '../../components/ui/form';
import { ErrorBanner } from '../../components/ui/layout';
import { QtyInput, newRequestId } from '../../components/ui/numberInputs';
import { cn } from '../../lib/cn';
import { SUPPLIER_INVALIDATE } from './shared';

/** Send goods back to the supplier. The credit is worked out exactly as the bill charged for them. */
export function SupplierReturnDialog({ purchase, onClose, onDone }: { purchase: PurchaseDetail; onClose(): void; onDone(debitNoteId: number): void }) {
  const toast = useToast();
  const methods = useCommandQuery('paymentMethods.list', {});
  const returnable = purchase.lines.filter((l) => l.qty - l.returnedQty > 0);
  const [qty, setQty] = useState<Record<number, number | null>>({});
  const [reason, setReason] = useState('');
  const [settlement, setSettlement] = useState<'ADJUST' | 'REFUND'>(purchase.outstanding > 0 ? 'ADJUST' : 'REFUND');
  const [methodId, setMethodId] = useState<number | null>(null);
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(newRequestId);
  const create = useCommandMutation('supplierReturns.create', { invalidate: SUPPLIER_INVALIDATE });
  const method = methodId ?? methods.data?.[0]?.id ?? null;

  const chosen = returnable.filter((l) => (qty[l.id] ?? 0) > 0);
  const total = useMemo(
    () =>
      chosen.reduce((a, l) => {
        const share = (x: number) => proportionalShare(x, l.qty, l.returnedQty, qty[l.id] ?? 0);
        return a + share(l.taxable) + share(l.cgst) + share(l.sgst) + share(l.igst);
      }, 0),
    [chosen, qty],
  );
  const onBill = Math.min(total, purchase.outstanding);
  const rest = total - onBill;
  const invalid = chosen.some((l) => (qty[l.id] ?? 0) > l.qty - l.returnedQty);

  const submit = async () => {
    setError(null);
    try {
      const dn = await create.mutateAsync({
        requestId,
        purchaseId: purchase.id,
        lines: chosen.map((l) => ({ purchaseLineId: l.id, qty: qty[l.id]! })),
        reason,
        settlement,
        refundMethodId: settlement === 'REFUND' ? (method ?? undefined) : undefined,
        reference,
      });
      toast.success(`Debit note ${dn.debitNoteNo} issued`, formatMoney(dn.total));
      onDone(dn.debitNoteId);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Return goods from ${purchase.purchaseNo}`}
      description={`To ${purchase.supplierName}. Stock leaves at its current average cost.`}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} busy={create.isPending} disabled={chosen.length === 0 || invalid || reason.trim().length < 3 || (settlement === 'REFUND' && rest > 0 && !method)}>
            Issue debit note {total > 0 && `· ${formatMoney(total)}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <table className="w-full">
          <thead className="text-left text-[12px] tracking-wide text-ink-3 uppercase">
            <tr>
              <th className="py-1.5">Item</th>
              <th className="py-1.5 text-right">Can return</th>
              <th className="w-40 py-1.5 text-right">Return qty</th>
            </tr>
          </thead>
          <tbody>
            {returnable.map((l) => {
              const left = l.qty - l.returnedQty;
              const over = (qty[l.id] ?? 0) > left;
              return (
                <tr key={l.id} className="border-t border-line">
                  <td className="py-2">
                    <span className="font-medium">{l.name}</span>
                    <span className="block text-[12px] text-ink-3">
                      {formatMoney(l.lineTotal)} for {formatQty(l.qty)} {l.unitCode}
                    </span>
                  </td>
                  <td className="tabular py-2 text-right">
                    {formatQty(left)} {l.unitCode}
                  </td>
                  <td className="py-2">
                    <QtyInput
                      aria-label={`Return quantity of ${l.name}`}
                      value={qty[l.id] ?? null}
                      allowDecimal={l.allowDecimal}
                      unit={l.unitCode}
                      className={cn('h-9', over && 'border-danger')}
                      onValueChange={(v) => setQty((s) => ({ ...s, [l.id]: v }))}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <Field label="Reason" required hint="Printed on the debit note">
          {(p) => <Textarea {...p} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Settle by">
            {(p) => (
              <Select {...p} value={settlement} onChange={(e) => setSettlement(e.target.value as 'ADJUST' | 'REFUND')}>
                <option value="ADJUST">Reduce what we owe / keep as advance</option>
                <option value="REFUND">The supplier refunds the money now</option>
              </Select>
            )}
          </Field>
          {settlement === 'REFUND' && rest > 0 && (
            <Field label="Refund received by">
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
          {settlement === 'REFUND' && rest > 0 && (
            <Field label="Refund reference">{(p) => <Input {...p} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />}</Field>
          )}
        </div>
        {total > 0 && (
          <p className="rounded-md bg-surface-2 px-3 py-2 text-ink-2">
            Credit {formatMoney(total)}. {onBill > 0 && <>First {formatMoney(onBill)} reduces what is still owed on this bill. </>}
            {rest > 0 &&
              (settlement === 'REFUND' ? (
                <>The supplier refunds {formatMoney(rest)}.</>
              ) : (
                <>{formatMoney(rest)} settles other open bills or stays as an advance with the supplier.</>
              ))}
            {purchase.itcClaimed && ' The input GST claimed on these goods is reversed.'}
          </p>
        )}
        {error && <ErrorBanner title="Not saved" message={error} />}
      </div>
    </Dialog>
  );
}
