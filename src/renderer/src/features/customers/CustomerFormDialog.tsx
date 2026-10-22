import { useState } from 'react';
import { customerFields, type CustomerDetail } from '@shared/contracts';
import { GST_STATES } from '@shared/gstStates';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select, Textarea } from '../../components/ui/form';
import { ErrorBanner } from '../../components/ui/layout';
import { MoneyInput, newRequestId } from '../../components/ui/numberInputs';

export function CustomerFormDialog({
  customer,
  initialName = '',
  onClose,
  onSaved,
}: {
  customer: CustomerDetail | null;
  initialName?: string;
  onClose(): void;
  onSaved(c: CustomerDetail): void;
}) {
  const can = useCan();
  const toast = useToast();
  const settings = useCommandQuery('settings.get');
  const [f, setF] = useState({
    name: customer?.name ?? initialName,
    phone: customer?.phone ?? '',
    address: customer?.address ?? '',
    businessName: customer?.businessName ?? '',
    gstin: customer?.gstin ?? '',
    stateCode: customer?.stateCode ?? '',
    creditDays: customer?.creditDays ?? null,
    creditLimit: customer?.creditLimit ?? 0,
    notes: customer?.notes ?? '',
  });
  const [opening, setOpening] = useState<number | null>(null);
  const [openingCredit, setOpeningCredit] = useState(false);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [requestId] = useState(newRequestId);
  const create = useCommandMutation('customers.create', { invalidate: ['customers.', 'receivables.'] });
  const update = useCommandMutation('customers.update', { invalidate: ['customers.'] });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const shopState = settings.data?.shop.stateCode ?? '';

  const submit = async () => {
    setServerError(null);
    const parsed = customerFields.safeParse({ ...f, stateCode: f.stateCode });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const i of parsed.error.issues) next[String(i.path[0])] ??= i.message;
      setErrors(next);
      return;
    }
    setErrors({});
    try {
      const saved = customer
        ? await update.mutateAsync({ ...parsed.data, id: customer.id, version: customer.version, reason: reason || undefined })
        : await create.mutateAsync({ ...parsed.data, requestId, openingBalance: opening ? (openingCredit ? -opening : opening) : 0 });
      toast.success(customer ? 'Customer saved' : `Customer ${saved.code} added`);
      onSaved(saved);
    } catch (e) {
      setServerError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={customer ? `Edit ${customer.name}` : 'Add customer'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} busy={create.isPending || update.isPending}>
            {customer ? 'Save changes' : 'Add customer'}
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
        <Field label="Mobile number" error={errors.phone}>
          {(p) => <Input {...p} value={f.phone} onChange={(e) => set('phone', e.target.value)} inputMode="tel" maxLength={20} />}
        </Field>
        <Field label="Business name" error={errors.businessName}>
          {(p) => <Input {...p} value={f.businessName} onChange={(e) => set('businessName', e.target.value)} maxLength={120} />}
        </Field>
        <Field label="GSTIN" error={errors.gstin} hint="For business customers who claim GST credit">
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
          hint={f.stateCode && shopState && f.stateCode !== shopState ? 'Another state: IGST will be charged' : 'Same state as the shop: CGST + SGST'}
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
        <Field label="Credit period (days)" hint={`Leave empty to use the shop default (${settings.data?.receivables.defaultCreditDays ?? 30} days)`}>
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
        <Field label="Credit limit" hint="0 means no limit; a warning is shown at billing when exceeded">
          {(p) => <MoneyInput {...p} value={f.creditLimit} onValueChange={(v) => set('creditLimit', v ?? 0)} />}
        </Field>
        <Field label="Notes">{(p) => <Input {...p} value={f.notes} onChange={(e) => set('notes', e.target.value)} maxLength={1000} />}</Field>
        {!customer && can('customers.adjustBalance') && (
          <div className="col-span-2 grid grid-cols-2 gap-4 rounded-lg border border-line p-4">
            <Field label="Opening balance (optional)" hint="Amount carried over from an old ledger book">
              {(p) => <MoneyInput {...p} value={opening} onValueChange={(v) => setOpening(v)} />}
            </Field>
            <Field label="This amount is">
              {(p) => (
                <Select {...p} value={openingCredit ? 'credit' : 'owed'} onChange={(e) => setOpeningCredit(e.target.value === 'credit')}>
                  <option value="owed">Owed by the customer</option>
                  <option value="credit">Credit in the customer's favour</option>
                </Select>
              )}
            </Field>
          </div>
        )}
        {customer && (
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
