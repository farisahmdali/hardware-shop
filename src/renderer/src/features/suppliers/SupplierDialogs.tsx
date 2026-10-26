import { useState } from 'react';
import type { SupplierDetail } from '@shared/contracts';
import { formatMoney } from '@shared/money';
import { formatDate } from '@shared/time';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select, Textarea } from '../../components/ui/form';
import { ErrorBanner } from '../../components/ui/layout';
import { MoneyInput, newRequestId } from '../../components/ui/numberInputs';
import { SUPPLIER_INVALIDATE } from './shared';

export interface PresetBill {
  docType: 'PURCHASE' | 'ADJUSTMENT';
  docId: number;
  docNo: string;
  outstanding: number;
}

function MethodSelect({ value, onChange, id }: { value: number | null; onChange(id: number): void; id?: string }) {
  const methods = useCommandQuery('paymentMethods.list', {});
  return (
    <Select id={id} value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))}>
      {methods.data?.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </Select>
  );
}

function useDefaultMethod(): [number | null, (id: number) => void] {
  const methods = useCommandQuery('paymentMethods.list', {});
  const [methodId, setMethodId] = useState<number | null>(null);
  return [methodId ?? methods.data?.[0]?.id ?? null, setMethodId];
}

/**
 * Records money paid to a supplier. With a chosen bill the payment settles that bill first;
 * otherwise it settles the oldest open bills. Anything extra stays as an advance with the supplier.
 */
export function PaySupplierDialog({
  supplierId,
  supplierName,
  preset,
  onClose,
}: {
  supplierId: number;
  supplierName: string;
  preset?: PresetBill;
  onClose(): void;
}) {
  const toast = useToast();
  const open = useCommandQuery('payables.list', { supplierId, pageSize: 20 });
  const totalOpen = open.data?.rows.reduce((a, r) => a + r.outstanding, 0) ?? 0;
  const [amount, setAmount] = useState<number | null>(preset?.outstanding ?? null);
  const [method, setMethod] = useDefaultMethod();
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(newRequestId);
  const pay = useCommandMutation('supplierPayments.create', { invalidate: SUPPLIER_INVALIDATE });
  const excess = amount !== null ? amount - (preset ? preset.outstanding : totalOpen) : 0;

  const submit = async () => {
    if (!amount || !method) return;
    setError(null);
    try {
      const p = await pay.mutateAsync({
        requestId,
        supplierId,
        amount,
        methodId: method,
        reference,
        notes,
        allocations: preset ? [{ docType: preset.docType, docId: preset.docId, amount: Math.min(amount, preset.outstanding) }] : [],
      });
      toast.success(`Payment ${p.paymentNo} recorded`, `${formatMoney(p.amount)} to ${supplierName}`);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Pay ${supplierName}`}
      description={preset ? `Against ${preset.docNo} (${formatMoney(preset.outstanding)} to pay)` : `Total to pay ${formatMoney(totalOpen)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} busy={pay.isPending} disabled={!amount || !method}>
            Record payment
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="Amount paid" required>
          {(p) => <MoneyInput {...p} autoFocus value={amount} onValueChange={(v) => setAmount(v)} />}
        </Field>
        <Field label="Paid by" required>
          {(p) => <MethodSelect id={p.id} value={method} onChange={setMethod} />}
        </Field>
        <Field label="Reference" hint="UTR, cheque number…">
          {(p) => <Input {...p} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />}
        </Field>
        <Field label="Notes">{(p) => <Input {...p} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />}</Field>
        {excess > 0 && (
          <p className="col-span-2 rounded-md bg-info-soft px-3 py-2 text-ink">
            {formatMoney(excess)} more than {preset ? 'this bill' : 'all open bills'}.{' '}
            {preset ? 'The rest settles other open bills, oldest first; anything left is kept as an advance.' : 'It is kept as an advance and used for the next bill.'}
          </p>
        )}
        {!preset && open.data && open.data.rows.length > 0 && (
          <div className="col-span-2">
            <p className="mb-1 text-[13px] text-ink-3">Settles the oldest bills first:</p>
            <ul className="max-h-40 overflow-y-auto rounded-md border border-line text-[13px]">
              {open.data.rows.map((r) => (
                <li key={`${r.docType}-${r.docId}`} className="flex justify-between border-b border-line px-3 py-1.5 last:border-b-0">
                  <span>
                    <span className="font-mono">{r.docNo}</span>
                    {r.supplierInvoiceNo && <span className="text-ink-3"> · bill {r.supplierInvoiceNo}</span>}
                    <span className="text-ink-3"> · {formatDate(r.billDate)}</span>
                  </span>
                  <span className="tabular">{formatMoney(r.outstanding)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && (
          <div className="col-span-2">
            <ErrorBanner title="Not saved" message={error} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** Money the supplier hands back out of an advance or a return. */
export function SupplierRefundDialog({ supplier, onClose }: { supplier: SupplierDetail; onClose(): void }) {
  const toast = useToast();
  const [amount, setAmount] = useState<number | null>(supplier.availableCredit);
  const [method, setMethod] = useDefaultMethod();
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(newRequestId);
  const refund = useCommandMutation('supplierPayments.refund', { invalidate: SUPPLIER_INVALIDATE });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Refund from ${supplier.name}`}
      description={`${formatMoney(supplier.availableCredit)} is with the supplier as an advance or from returns.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            busy={refund.isPending}
            disabled={!amount || !method || reason.trim().length < 3}
            onClick={async () => {
              try {
                const r = await refund.mutateAsync({ requestId, supplierId: supplier.id, amount: amount!, methodId: method!, reference, reason });
                toast.success(`Refund ${r.paymentNo} recorded`, formatMoney(r.amount));
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Record refund
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="Amount received" required>
          {(p) => <MoneyInput {...p} autoFocus value={amount} onValueChange={(v) => setAmount(v)} />}
        </Field>
        <Field label="Received by" required>
          {(p) => <MethodSelect id={p.id} value={method} onChange={setMethod} />}
        </Field>
        <Field label="Reference">{(p) => <Input {...p} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />}</Field>
        <Field label="Reason" required>
          {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}
        </Field>
        {error && (
          <div className="col-span-2">
            <ErrorBanner title="Not saved" message={error} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function AdjustSupplierBalanceDialog({ supplier, onClose }: { supplier: SupplierDetail; onClose(): void }) {
  const toast = useToast();
  const [kind, setKind] = useState<'OPENING' | 'ADJUSTMENT'>('ADJUSTMENT');
  const [direction, setDirection] = useState<'OWE' | 'FAVOUR'>('OWE');
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(newRequestId);
  const adjust = useCommandMutation('suppliers.adjustBalance', { invalidate: SUPPLIER_INVALIDATE });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Adjust balance with ${supplier.name}`}
      description="Use only to record an opening balance or correct a genuine difference. Purchases, payments and returns update the balance by themselves."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            busy={adjust.isPending}
            disabled={!amount || reason.trim().length < 3}
            onClick={async () => {
              try {
                await adjust.mutateAsync({ requestId, supplierId: supplier.id, kind, amount: direction === 'OWE' ? amount! : -amount!, reason });
                toast.success('Balance adjusted');
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Save adjustment
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="Type">
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as 'OPENING' | 'ADJUSTMENT')}>
              <option value="ADJUSTMENT">Correction</option>
              <option value="OPENING">Opening balance (from old records)</option>
            </Select>
          )}
        </Field>
        <Field label="Effect">
          {(p) => (
            <Select {...p} value={direction} onChange={(e) => setDirection(e.target.value as 'OWE' | 'FAVOUR')}>
              <option value="OWE">The shop owes more</option>
              <option value="FAVOUR">In the shop's favour</option>
            </Select>
          )}
        </Field>
        <Field label="Amount" required>
          {(p) => <MoneyInput {...p} autoFocus value={amount} onValueChange={(v) => setAmount(v)} />}
        </Field>
        <Field label="Reason" required className="col-span-2" hint="Recorded in the supplier's account and the history.">
          {(p) => <Textarea {...p} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}
        </Field>
        {error && (
          <div className="col-span-2">
            <ErrorBanner title="Not saved" message={error} />
          </div>
        )}
      </div>
    </Dialog>
  );
}
