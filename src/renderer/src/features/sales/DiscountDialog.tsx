import { useState } from 'react';
import type { DiscountInput } from '@shared/contracts';
import { formatMoney, mulDivRound } from '@shared/money';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input } from '../../components/ui/form';
import { MoneyInput } from '../../components/ui/numberInputs';
import { cn } from '../../lib/cn';

/** Edits a discount as an amount or a percentage of `base`, showing the role's limit. */
export function DiscountDialog({
  title,
  base,
  value,
  maxDiscountBp,
  onSave,
  onClose,
}: {
  title: string;
  base: number;
  value: DiscountInput;
  maxDiscountBp: number;
  onSave(d: DiscountInput): void;
  onClose(): void;
}) {
  const [type, setType] = useState<'PERCENT' | 'AMOUNT'>(value?.type ?? 'PERCENT');
  const [percent, setPercent] = useState(value?.type === 'PERCENT' ? String(value.valueBp / 100) : '');
  const [amount, setAmount] = useState<number | null>(value?.type === 'AMOUNT' ? value.value : null);
  const bp = Math.round(Number(percent || '0') * 100);
  const effective = type === 'PERCENT' ? mulDivRound(base, Number.isFinite(bp) ? bp : 0, 10_000) : Math.min(amount ?? 0, base);
  const limit = mulDivRound(base, maxDiscountBp, 10_000);
  const valid = type === 'PERCENT' ? Number.isFinite(bp) && bp >= 0 && bp <= 10_000 : amount !== null && amount >= 0;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      size="sm"
      footer={
        <>
          {value && (
            <Button variant="ghost" className="mr-auto" onClick={() => onSave(null)}>
              Remove discount
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            onClick={() => onSave(effective === 0 ? null : type === 'PERCENT' ? { type, valueBp: bp } : { type, value: amount ?? 0 })}
          >
            Apply
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div role="radiogroup" aria-label="Discount type" className="grid grid-cols-2 gap-1 rounded-md bg-surface-2 p-1">
          {(['PERCENT', 'AMOUNT'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={type === t}
              onClick={() => setType(t)}
              className={cn('rounded py-1.5 font-medium', type === t ? 'bg-surface text-ink shadow-card' : 'text-ink-3')}
            >
              {t === 'PERCENT' ? 'Percentage' : 'Amount (₹)'}
            </button>
          ))}
        </div>
        {type === 'PERCENT' ? (
          <Field label="Discount %">
            {(p) => (
              <Input
                {...p}
                autoFocus
                inputMode="decimal"
                value={percent}
                onChange={(e) => setPercent(e.target.value.replace(/[^0-9.]/g, ''))}
                onKeyDown={(e) => e.key === 'Enter' && valid && onSave(effective === 0 ? null : { type: 'PERCENT', valueBp: bp })}
              />
            )}
          </Field>
        ) : (
          <Field label="Discount amount">{(p) => <MoneyInput {...p} autoFocus value={amount} onValueChange={(v) => setAmount(v)} />}</Field>
        )}
        <p className="text-ink-2">
          Discount {formatMoney(effective)} on {formatMoney(base)}.{' '}
          <span className={effective > limit ? 'font-medium text-danger' : 'text-ink-3'}>
            Your limit is {maxDiscountBp / 100}% of the bill ({formatMoney(limit)}).
          </span>
        </p>
      </div>
    </Dialog>
  );
}
