import { useState } from 'react';
import { formatMoney } from '@shared/money';
import { formatDate } from '@shared/time';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select } from '../../components/ui/form';
import { ErrorBanner } from '../../components/ui/layout';
import { MoneyInput, newRequestId } from '../../components/ui/numberInputs';

export interface PresetDoc {
  docType: 'INVOICE' | 'ADJUSTMENT';
  docId: number;
  docNo: string;
  outstanding: number;
}

const INVALIDATE = ['invoices.', 'customers.', 'receivables.', 'payments.'];

/**
 * Records money received from a customer. With a chosen bill the payment settles that bill first;
 * otherwise it settles the oldest open bills. Anything extra stays as advance credit.
 */
export function ReceivePaymentDialog({
  customerId,
  customerName,
  preset,
  onClose,
}: {
  customerId: number;
  customerName: string;
  preset?: PresetDoc;
  onClose(): void;
}) {
  const toast = useToast();
  const methods = useCommandQuery('paymentMethods.list', {});
  const open = useCommandQuery('receivables.list', { customerId, pageSize: 20 });
  const totalOpen = open.data?.rows.reduce((a, r) => a + r.outstanding, 0) ?? 0;
  const [amount, setAmount] = useState<number | null>(preset?.outstanding ?? null);
  const [methodId, setMethodId] = useState<number | null>(null);
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(newRequestId);
  const receive = useCommandMutation('payments.receive', { invalidate: INVALIDATE });
  const method = methodId ?? methods.data?.[0]?.id ?? null;
  const excess = amount !== null ? amount - (preset ? preset.outstanding : totalOpen) : 0;

  const submit = async () => {
    if (!amount || !method) return;
    setError(null);
    try {
      const p = await receive.mutateAsync({
        requestId,
        customerId,
        amount,
        methodId: method,
        reference,
        notes,
        allocations: preset ? [{ docType: preset.docType, docId: preset.docId, amount: Math.min(amount, preset.outstanding) }] : [],
      });
      toast.success(`Payment ${p.paymentNo} recorded`, `${formatMoney(p.amount)} from ${customerName}`);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Receive payment from ${customerName}`}
      description={preset ? `Against ${preset.docNo} (${formatMoney(preset.outstanding)} due)` : `Total due ${formatMoney(totalOpen)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} busy={receive.isPending} disabled={!amount || !method}>
            Record payment
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="Amount received" required>
          {(p) => <MoneyInput {...p} autoFocus value={amount} onValueChange={(v) => setAmount(v)} />}
        </Field>
        <Field label="Paid by" required>
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
        <Field label="Reference" hint="UPI transaction id, cheque number…">
          {(p) => <Input {...p} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />}
        </Field>
        <Field label="Notes">{(p) => <Input {...p} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />}</Field>
        {excess > 0 && (
          <p className="col-span-2 rounded-md bg-info-soft px-3 py-2 text-ink">
            {formatMoney(excess)} more than {preset ? 'this bill' : 'all open bills'}.{' '}
            {preset ? 'The rest settles other open bills, oldest first; anything left is kept as advance credit.' : 'It is kept as advance credit.'}
          </p>
        )}
        {!preset && open.data && open.data.rows.length > 0 && (
          <div className="col-span-2">
            <p className="mb-1 text-[13px] text-ink-3">Settles the oldest bills first:</p>
            <ul className="max-h-40 overflow-y-auto rounded-md border border-line text-[13px]">
              {open.data.rows.map((r) => (
                <li key={`${r.docType}-${r.docId}`} className="flex justify-between border-b border-line px-3 py-1.5 last:border-b-0">
                  <span>
                    <span className="font-mono">{r.docNo}</span> <span className="text-ink-3">· {formatDate(r.businessDate)}</span>
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
