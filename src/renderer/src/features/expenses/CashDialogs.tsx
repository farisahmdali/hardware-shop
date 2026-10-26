import { useState } from 'react';
import { DENOMINATIONS, type CashEntryType } from '@shared/contracts';
import { formatMoney } from '@shared/money';
import { errorMessage, useCommandMutation } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select, Textarea } from '../../components/ui/form';
import { ErrorBanner } from '../../components/ui/layout';
import { MoneyInput, newRequestId } from '../../components/ui/numberInputs';
import { cn } from '../../lib/cn';
import { EXPENSE_INVALIDATE } from './ExpenseDialog';

export const CASH_ENTRY_LABELS: Record<CashEntryType, { label: string; hint: string; into: boolean }> = {
  CASH_IN: { label: 'Cash added by the owner', hint: 'Opening float, or the owner putting money into the drawer', into: true },
  DRAWING: { label: 'Owner drawing', hint: 'The owner taking cash for personal use', into: false },
  BANK_DEPOSIT: { label: 'Deposited in the bank', hint: 'Cash taken from the drawer to the bank', into: false },
  BANK_WITHDRAWAL: { label: 'Withdrawn from the bank', hint: 'Cash brought from the bank into the drawer', into: true },
};

/** Cash moved in or out of the drawer other than by sales, payments and expenses. */
export function CashEntryDialog({ expected, onClose }: { expected: number; onClose(): void }) {
  const toast = useToast();
  const [type, setType] = useState<CashEntryType>('BANK_DEPOSIT');
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(newRequestId);
  const add = useCommandMutation('cash.addEntry', { invalidate: EXPENSE_INVALIDATE });
  const out = !CASH_ENTRY_LABELS[type].into;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Cash in or out"
      description={`The records show ${formatMoney(expected)} in the drawer.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            busy={add.isPending}
            disabled={!amount || reason.trim().length < 3}
            onClick={async () => {
              try {
                const e = await add.mutateAsync({ requestId, type, amount: amount!, reason });
                toast.success(`${e.entryNo} recorded`, `${CASH_ENTRY_LABELS[type].label}: ${formatMoney(e.amount)}`);
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Record
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="What happened" className="col-span-2" hint={CASH_ENTRY_LABELS[type].hint}>
          {(p) => (
            <Select {...p} value={type} onChange={(e) => setType(e.target.value as CashEntryType)}>
              {(Object.keys(CASH_ENTRY_LABELS) as CashEntryType[]).map((t) => (
                <option key={t} value={t}>
                  {CASH_ENTRY_LABELS[t].into ? 'In: ' : 'Out: '}
                  {CASH_ENTRY_LABELS[t].label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Amount" required error={out && amount !== null && amount > expected ? 'More than the drawer holds' : undefined}>
          {(p) => <MoneyInput {...p} autoFocus value={amount} onValueChange={(v) => setAmount(v)} />}
        </Field>
        <Field label="Reason" required>
          {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder={type === 'BANK_DEPOSIT' ? 'e.g. Deposited at SBI' : ''} />}
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

/**
 * Count the drawer. Notes and coins can be counted one by one, or the total typed.
 * Any difference from the records is saved with an explanation, and the expected cash follows the count.
 */
export function CashCountDialog({ expected, onClose }: { expected: number; onClose(): void }) {
  const toast = useToast();
  const [byNotes, setByNotes] = useState(true);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [typed, setTyped] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(newRequestId);
  const count = useCommandMutation('cash.count', { invalidate: EXPENSE_INVALIDATE });
  const fromNotes = DENOMINATIONS.reduce((a, d) => a + d * 100 * (counts[d] ?? 0), 0);
  const counted = byNotes ? fromNotes : (typed ?? 0);
  const difference = counted - expected;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Count the cash drawer"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            busy={count.isPending}
            disabled={(!byNotes && typed === null) || (difference !== 0 && note.trim().length < 3)}
            onClick={async () => {
              try {
                const denominations = byNotes ? Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)) : null;
                const c = await count.mutateAsync({ requestId, counted, denominations, note });
                toast.success(
                  'Cash count saved',
                  c.difference === 0 ? 'Matches the records' : `${c.difference > 0 ? 'Over' : 'Short'} by ${formatMoney(Math.abs(c.difference))}`,
                );
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Save count
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex gap-2">
          <Button size="sm" variant={byNotes ? 'primary' : 'outline'} onClick={() => setByNotes(true)}>
            Count notes and coins
          </Button>
          <Button size="sm" variant={byNotes ? 'outline' : 'primary'} onClick={() => setByNotes(false)}>
            Type the total
          </Button>
        </div>
        {byNotes ? (
          <div className="grid grid-cols-3 gap-x-6 gap-y-2">
            {DENOMINATIONS.map((d) => (
              <label key={d} className="grid grid-cols-[56px_1fr_96px] items-center gap-2">
                <span className="tabular text-right font-medium">₹{d}</span>
                <Input
                  aria-label={`Number of ₹${d}`}
                  type="number"
                  min={0}
                  className="h-9 text-right"
                  value={counts[d] ?? ''}
                  onChange={(e) => setCounts((c) => ({ ...c, [d]: Math.max(0, Math.trunc(Number(e.target.value) || 0)) }))}
                />
                <span className="tabular text-right text-ink-3">{formatMoney(d * 100 * (counts[d] ?? 0))}</span>
              </label>
            ))}
          </div>
        ) : (
          <Field label="Cash counted">{(p) => <MoneyInput {...p} autoFocus value={typed} onValueChange={(v) => setTyped(v)} />}</Field>
        )}
        <div className="grid grid-cols-3 gap-3 rounded-md bg-surface-2 px-4 py-3">
          <div>
            <p className="text-[12px] text-ink-3 uppercase">Records say</p>
            <p className="tabular text-lg font-semibold">{formatMoney(expected)}</p>
          </div>
          <div>
            <p className="text-[12px] text-ink-3 uppercase">Counted</p>
            <p className="tabular text-lg font-semibold">{formatMoney(counted)}</p>
          </div>
          <div>
            <p className="text-[12px] text-ink-3 uppercase">Difference</p>
            <p className={cn('tabular text-lg font-semibold', difference === 0 ? 'text-success' : 'text-danger')}>
              {difference === 0 ? 'None' : `${difference > 0 ? 'Over' : 'Short'} ${formatMoney(Math.abs(difference))}`}
            </p>
          </div>
        </div>
        <Field label={difference === 0 ? 'Note (optional)' : 'Explain the difference'} required={difference !== 0}>
          {(p) => <Textarea {...p} rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}
        </Field>
        {error && <ErrorBanner title="Not saved" message={error} />}
      </div>
    </Dialog>
  );
}
