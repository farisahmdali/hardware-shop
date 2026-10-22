import { useState } from 'react';
import type { ProductDetail } from '@shared/contracts';
import { formatMoney, mulDivRound } from '@shared/money';
import { formatQty } from '@shared/qty';
import { MOVEMENT_TYPES, type ManualAdjustment } from '@shared/stock';
import { errorMessage, useCommandMutation } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Textarea } from '../../components/ui/form';
import { ErrorBanner } from '../../components/ui/layout';
import { MoneyInput, QtyInput, newRequestId } from '../../components/ui/numberInputs';
import { cn } from '../../lib/cn';

const OPTIONS: { kind: ManualAdjustment; hint: string }[] = [
  { kind: 'RECEIPT', hint: 'Goods arrived without a purchase bill in this system' },
  { kind: 'ADJUST_IN', hint: 'Correct a count that was too low' },
  { kind: 'ADJUST_OUT', hint: 'Correct a count that was too high' },
  { kind: 'DAMAGE', hint: 'Broken or unsellable items' },
  { kind: 'LOSS', hint: 'Missing, stolen or expired items' },
];

export function StockAdjustDialog({ product, onClose }: { product: ProductDetail; onClose(): void }) {
  const toast = useToast();
  const [kind, setKind] = useState<ManualAdjustment>('RECEIPT');
  const [qty, setQty] = useState<number | null>(null);
  const [qtyValid, setQtyValid] = useState(true);
  const [unitCost, setUnitCost] = useState<number | null>(null);
  const [costValid, setCostValid] = useState(true);
  const [reason, setReason] = useState('');
  const [requestId] = useState(newRequestId);
  const [error, setError] = useState<string | null>(null);
  const adjust = useCommandMutation('stock.adjust', { invalidate: ['products.', 'stock.'] });

  const incoming = MOVEMENT_TYPES[kind].direction === 'in';
  const after = qty === null ? null : product.qty + (incoming ? qty : -qty);
  const needsReason = kind !== 'RECEIPT';
  const ready = qty !== null && qty > 0 && qtyValid && costValid && (!needsReason || reason.trim().length >= 3) && (after ?? 0) >= 0;
  const costEstimate =
    qty === null
      ? null
      : kind === 'RECEIPT'
        ? mulDivRound(qty, unitCost ?? product.purchasePrice ?? 0, 1000)
        : product.averageCost !== null
          ? mulDivRound(qty, product.averageCost, 1000)
          : null;

  const submit = async () => {
    if (!ready || qty === null) return;
    setError(null);
    try {
      await adjust.mutateAsync({ requestId, productId: product.id, kind, qty, unitCost: unitCost ?? undefined, reason: reason.trim() });
      toast.success(`${MOVEMENT_TYPES[kind].label}: ${formatQty(qty)} ${product.unitCode} of ${product.name}`);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Adjust stock"
      description={`${product.name} · ${product.sku}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={adjust.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} busy={adjust.isPending} disabled={!ready}>
            Save adjustment
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div role="radiogroup" aria-label="Type of adjustment" className="grid grid-cols-1 gap-1.5">
          {OPTIONS.map((o) => (
            <button
              key={o.kind}
              type="button"
              role="radio"
              aria-checked={kind === o.kind}
              onClick={() => setKind(o.kind)}
              className={cn(
                'flex items-center justify-between rounded-md border px-3 py-2 text-left',
                kind === o.kind ? 'border-brand bg-brand-soft' : 'border-line hover:bg-surface-2',
              )}
            >
              <span className="font-medium text-ink">{MOVEMENT_TYPES[o.kind].label}</span>
              <span className="text-[13px] text-ink-3">{o.hint}</span>
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label={incoming ? 'Quantity to add' : 'Quantity to remove'} required error={qtyValid ? undefined : 'Enter a valid quantity'}>
            {(p) => (
              <QtyInput
                {...p}
                value={qty}
                allowDecimal={product.allowDecimal}
                unit={product.unitCode}
                onValueChange={(v, ok) => {
                  setQty(v);
                  setQtyValid(ok);
                }}
                autoFocus
              />
            )}
          </Field>
          {kind === 'RECEIPT' && product.purchasePrice !== null && (
            <Field label="Cost per unit (before GST)" hint={`Defaults to ${formatMoney(product.purchasePrice)}`}>
              {(p) => (
                <MoneyInput
                  {...p}
                  value={unitCost}
                  onValueChange={(v, ok) => {
                    setUnitCost(v);
                    setCostValid(ok);
                  }}
                />
              )}
            </Field>
          )}
        </div>
        <div className="grid grid-cols-3 gap-3 rounded-md bg-surface-2 px-4 py-3 text-center">
          <div>
            <p className="text-[12px] text-ink-3">In stock now</p>
            <p className="tabular font-semibold text-ink">
              {formatQty(product.qty)} {product.unitCode}
            </p>
          </div>
          <div>
            <p className="text-[12px] text-ink-3">Change</p>
            <p className={cn('tabular font-semibold', incoming ? 'text-success' : 'text-danger')}>
              {qty === null ? '—' : `${incoming ? '+' : '−'}${formatQty(qty)}`}
            </p>
          </div>
          <div>
            <p className="text-[12px] text-ink-3">After</p>
            <p className={cn('tabular font-semibold', after !== null && after < 0 ? 'text-danger' : 'text-ink')}>
              {after === null ? '—' : `${formatQty(after)} ${product.unitCode}`}
            </p>
          </div>
          {costEstimate !== null && product.purchasePrice !== null && (
            <p className="col-span-3 text-[13px] text-ink-3">
              Stock value change about {incoming ? '+' : '−'}
              {formatMoney(costEstimate)} at {kind === 'RECEIPT' ? 'the entered cost' : 'average cost'}
            </p>
          )}
        </div>
        {after !== null && after < 0 && <ErrorBanner title="Not enough stock" message="You cannot remove more than is in stock." />}
        <Field label={needsReason ? 'Reason' : 'Note (optional)'} required={needsReason} hint="Saved with the stock movement and in the history.">
          {(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} />}
        </Field>
        {error && <ErrorBanner title="Not saved" message={error} />}
      </div>
    </Dialog>
  );
}
