import { useState } from 'react';
import type { CustomerDetail } from '@shared/contracts';
import { formatMoney } from '@shared/money';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select, Textarea } from '../../components/ui/form';
import { ErrorBanner } from '../../components/ui/layout';
import { MoneyInput, newRequestId } from '../../components/ui/numberInputs';

const INVALIDATE = ['customers.', 'receivables.', 'payments.', 'invoices.'];

export function RefundDialog({ customer, onClose }: { customer: CustomerDetail; onClose(): void }) {
  const toast = useToast();
  const methods = useCommandQuery('paymentMethods.list', {});
  const [amount, setAmount] = useState<number | null>(customer.availableCredit);
  const [methodId, setMethodId] = useState<number | null>(null);
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(newRequestId);
  const refund = useCommandMutation('payments.refund', { invalidate: INVALIDATE });
  const method = methodId ?? methods.data?.[0]?.id ?? null;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Refund credit to ${customer.name}`}
      description={`${formatMoney(customer.availableCredit)} of credit is available.`}
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
                const r = await refund.mutateAsync({ requestId, customerId: customer.id, amount: amount!, methodId: method!, reference, reason });
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
        <Field label="Amount" required>
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

export function AdjustBalanceDialog({ customer, onClose }: { customer: CustomerDetail; onClose(): void }) {
  const toast = useToast();
  const [kind, setKind] = useState<'OPENING' | 'ADJUSTMENT'>('ADJUSTMENT');
  const [direction, setDirection] = useState<'OWES' | 'CREDIT'>('OWES');
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(newRequestId);
  const adjust = useCommandMutation('customers.adjustBalance', { invalidate: INVALIDATE });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Adjust balance of ${customer.name}`}
      description="Use only to record an opening balance or correct a genuine difference. Normal sales, payments and returns update the balance by themselves."
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
                await adjust.mutateAsync({ requestId, customerId: customer.id, kind, amount: direction === 'OWES' ? amount! : -amount!, reason });
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
            <Select {...p} value={direction} onChange={(e) => setDirection(e.target.value as 'OWES' | 'CREDIT')}>
              <option value="OWES">Customer owes more</option>
              <option value="CREDIT">Credit to the customer</option>
            </Select>
          )}
        </Field>
        <Field label="Amount" required>
          {(p) => <MoneyInput {...p} autoFocus value={amount} onValueChange={(v) => setAmount(v)} />}
        </Field>
        <Field label="Reason" required className="col-span-2" hint="Recorded in the customer's ledger and the history.">
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
