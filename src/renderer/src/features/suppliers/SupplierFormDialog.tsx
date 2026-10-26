import { useState } from 'react';
import { supplierFields, type SupplierDetail } from '@shared/contracts';
import { GST_STATES } from '@shared/gstStates';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select, Textarea } from '../../components/ui/form';
import { ErrorBanner } from '../../components/ui/layout';
import { MoneyInput, newRequestId } from '../../components/ui/numberInputs';

export function SupplierFormDialog({
  supplier,
  initialName = '',
  onClose,
  onSaved,
}: {
  supplier: SupplierDetail | null;
  initialName?: string;
  onClose(): void;
  onSaved(s: SupplierDetail): void;
}) {
  const can = useCan();
  const toast = useToast();
  const settings = useCommandQuery('settings.get');
  const [f, setF] = useState({
    name: supplier?.name ?? initialName,
    phone: supplier?.phone ?? '',
    address: supplier?.address ?? '',
    businessName: supplier?.businessName ?? '',
    gstin: supplier?.gstin ?? '',
    stateCode: supplier?.stateCode ?? '',
    creditDays: supplier?.creditDays ?? null,
    notes: supplier?.notes ?? '',
  });
  const [opening, setOpening] = useState<number | null>(null);
  const [openingAdvance, setOpeningAdvance] = useState(false);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [requestId] = useState(newRequestId);
  const create = useCommandMutation('suppliers.create', { invalidate: ['suppliers.', 'payables.', 'catalog.'] });
  const update = useCommandMutation('suppliers.update', { invalidate: ['suppliers.', 'catalog.'] });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const shopState = settings.data?.shop.stateCode ?? '';

  const submit = async () => {
    setServerError(null);
    const parsed = supplierFields.safeParse(f);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const i of parsed.error.issues) next[String(i.path[0])] ??= i.message;
      setErrors(next);
      return;
    }
    setErrors({});
    try {
      const saved = supplier
        ? await update.mutateAsync({ ...parsed.data, id: supplier.id, version: supplier.version, reason: reason || undefined })
        : await create.mutateAsync({ ...parsed.data, requestId, openingBalance: opening ? (openingAdvance ? -opening : opening) : 0 });
      toast.success(supplier ? 'Supplier saved' : `Supplier ${saved.code} added`);
      onSaved(saved);
    } catch (e) {
      setServerError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={supplier ? `Edit ${supplier.name}` : 'Add supplier'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} busy={create.isPending || update.isPending}>
            {supplier ? 'Save changes' : 'Add supplier'}
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-2 gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name" required error={errors.name}>
          {(p) => <Input {...p} value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus maxLength={120} />}
        </Field>
        <Field label="Phone" error={errors.phone}>
          {(p) => <Input {...p} value={f.phone} onChange={(e) => set('phone', e.target.value)} inputMode="tel" maxLength={20} />}
        </Field>
        <Field label="Business name" error={errors.businessName}>
          {(p) => <Input {...p} value={f.businessName} onChange={(e) => set('businessName', e.target.value)} maxLength={120} />}
        </Field>
        <Field label="GSTIN" error={errors.gstin} hint="Needed to claim the GST on their bills">
          {(p) => (
            <Input
              {...p}
              value={f.gstin}
              maxLength={15}
              className="uppercase"
              onChange={(e) => {
                const v = e.target.value.toUpperCase();
                setF((s) => ({ ...s, gstin: v, stateCode: !s.stateCode && /^\d{2}/.test(v) ? v.slice(0, 2) : s.stateCode }));
              }}
            />
          )}
        </Field>
        <Field label="Address" className="col-span-2" error={errors.address}>
          {(p) => <Textarea {...p} value={f.address} onChange={(e) => set('address', e.target.value)} rows={2} maxLength={300} />}
        </Field>
        <Field
          label="State"
          error={errors.stateCode}
          hint={f.stateCode && shopState && f.stateCode !== shopState ? 'Another state: their bills carry IGST' : 'Same state as the shop: CGST + SGST'}
        >
          {(p) => (
            <Select {...p} value={f.stateCode} onChange={(e) => set('stateCode', e.target.value)}>
              <option value="">Same as the shop</option>
              {GST_STATES.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.code} – {s.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Days to pay their bills" hint={`Leave empty to use the shop default (${settings.data?.purchases.defaultCreditDays ?? 30} days)`}>
          {(p) => (
            <Input
              {...p}
              type="number"
              min={0}
              max={365}
              value={f.creditDays ?? ''}
              onChange={(e) => set('creditDays', e.target.value === '' ? null : Math.max(0, Math.min(365, Math.trunc(Number(e.target.value)))))}
            />
          )}
        </Field>
        <Field label="Notes" className="col-span-2">
          {(p) => <Input {...p} value={f.notes} onChange={(e) => set('notes', e.target.value)} maxLength={1000} />}
        </Field>
        {!supplier && can('suppliers.adjustBalance') && (
          <div className="col-span-2 grid grid-cols-2 gap-4 rounded-lg border border-line p-4">
            <Field label="Opening balance (optional)" hint="Amount carried over from an old ledger book">
              {(p) => <MoneyInput {...p} value={opening} onValueChange={(v) => setOpening(v)} />}
            </Field>
            <Field label="This amount is">
              {(p) => (
                <Select {...p} value={openingAdvance ? 'advance' : 'owed'} onChange={(e) => setOpeningAdvance(e.target.value === 'advance')}>
                  <option value="owed">Owed by the shop to the supplier</option>
                  <option value="advance">An advance already paid to the supplier</option>
                </Select>
              )}
            </Field>
          </div>
        )}
        {supplier && (
          <Field label="Reason for change (optional)" className="col-span-2">
            {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}
          </Field>
        )}
        {serverError && (
          <div className="col-span-2">
            <ErrorBanner title="Not saved" message={serverError} />
          </div>
        )}
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}
