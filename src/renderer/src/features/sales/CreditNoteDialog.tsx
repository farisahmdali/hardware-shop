import { useMemo, useState } from 'react';
import type { InvoiceDetail } from '@shared/contracts';
import { proportionalShare } from '@shared/billing';
import { formatMoney } from '@shared/money';
import { formatQty } from '@shared/qty';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Checkbox, Field, Select, Textarea } from '../../components/ui/form';
import { ErrorBanner } from '../../components/ui/layout';
import { QtyInput, newRequestId } from '../../components/ui/numberInputs';
import { cn } from '../../lib/cn';

/** Return items from an invoice. The credit is worked out exactly as the invoice charged it. */
export function CreditNoteDialog({ invoice, onClose }: { invoice: InvoiceDetail; onClose(): void }) {
  const toast = useToast();
  const methods = useCommandQuery('paymentMethods.list', {});
  const returnable = invoice.lines.filter((l) => l.qty - l.returnedQty > 0);
  const [qty, setQty] = useState<Record<number, number | null>>({});
  const [restock, setRestock] = useState<Record<number, boolean>>({});
  const [reason, setReason] = useState('');
  const [settlement, setSettlement] = useState<'CREDIT' | 'REFUND'>(invoice.isWalkin ? 'REFUND' : 'CREDIT');
  const [methodId, setMethodId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(newRequestId);
  const create = useCommandMutation('creditNotes.create', { invalidate: ['invoices.', 'products.', 'stock.', 'customers.', 'receivables.', 'payments.'] });
  const method = methodId ?? methods.data?.[0]?.id ?? null;

  const chosen = returnable.filter((l) => (qty[l.id] ?? 0) > 0);
  const total = useMemo(
    () =>
      chosen.reduce((a, l) => {
        const q = qty[l.id] ?? 0;
        const share = (x: number) => proportionalShare(x, l.qty, l.returnedQty, q);
        return a + share(l.taxable) + share(l.cgst) + share(l.sgst) + share(l.igst);
      }, 0),
    [chosen, qty],
  );
  const toRefund = Math.max(0, total - invoice.outstanding);
  const invalid = chosen.some((l) => (qty[l.id] ?? 0) > l.qty - l.returnedQty);

  const submit = async () => {
    setError(null);
    try {
      const cn = await create.mutateAsync({
        requestId,
        invoiceId: invoice.id,
        lines: chosen.map((l) => ({ invoiceLineId: l.id, qty: qty[l.id]!, restock: restock[l.id] ?? true })),
        reason,
        settlement,
        refundMethodId: settlement === 'REFUND' ? (method ?? undefined) : undefined,
      });
      toast.success(`Credit note ${cn.creditNoteNo} issued`, formatMoney(cn.total));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Return items from ${invoice.invoiceNo}`}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} busy={create.isPending} disabled={chosen.length === 0 || invalid || reason.trim().length < 3 || (settlement === 'REFUND' && !method)}>
            Issue credit note {total > 0 && `· ${formatMoney(total)}`}
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
              <th className="py-1.5 pl-4">Back to stock</th>
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
                    <span className="block text-[12px] text-ink-3">{formatMoney(l.lineTotal)} for {formatQty(l.qty)}</span>
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
                  <td className="py-2 pl-4">
                    {l.productId ? (
                      <Checkbox checked={restock[l.id] ?? true} onChange={(v) => setRestock((s) => ({ ...s, [l.id]: v }))} label="Resaleable" />
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <Field label="Reason" required>
          {(p) => <Textarea {...p} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Settle the credit by">
            {(p) => (
              <Select {...p} value={settlement} disabled={invoice.isWalkin} onChange={(e) => setSettlement(e.target.value as 'CREDIT' | 'REFUND')}>
                <option value="CREDIT">Credit to the customer's account</option>
                <option value="REFUND">Refunding the money now</option>
              </Select>
            )}
          </Field>
          {settlement === 'REFUND' && (
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
        {total > 0 && (
          <p className="rounded-md bg-surface-2 px-3 py-2 text-ink-2">
            Credit {formatMoney(total)}.{' '}
            {invoice.outstanding > 0 && <>First {formatMoney(Math.min(total, invoice.outstanding))} reduces what is still owed on this invoice. </>}
            {toRefund > 0 && (settlement === 'REFUND' ? <>Refund {formatMoney(toRefund)} to the customer.</> : <>{formatMoney(toRefund)} goes to the customer's account.</>)}
          </p>
        )}
        {error && <ErrorBanner title="Not saved" message={error} />}
      </div>
    </Dialog>
  );
}
