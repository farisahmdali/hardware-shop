import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { rentalProductFields, type RentalProductDetail } from '@shared/contracts';
import { UNIT_MINUTES, type RateUnit } from '@shared/rentalPricing';
import { GST_RATES_BP, formatRate } from '@shared/stock';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select, Switch, Textarea } from '../../components/ui/form';
import { ErrorBanner } from '../../components/ui/layout';
import { MoneyInput, newRequestId } from '../../components/ui/numberInputs';

interface RateRow {
  key: string;
  unit: RateUnit;
  hours: number;
  label: string;
  price: number | null;
}

const UNIT_NAMES: Record<RateUnit, string> = { HOUR: 'Per hour', DAY: 'Per day (24 h)', WEEK: 'Per week', MONTH: 'Per 30 days', CUSTOM: 'Custom period' };

export function RentalProductDialog({ product, onClose, onSaved }: { product: RentalProductDetail | null; onClose(): void; onSaved(p: RentalProductDetail): void }) {
  const toast = useToast();
  const catalog = useCommandQuery('catalog.get');
  const settings = useCommandQuery('settings.get');
  const [f, setF] = useState({
    name: product?.name ?? '',
    categoryId: product?.categoryId ?? null,
    brand: product?.brand ?? '',
    model: product?.model ?? '',
    description: product?.description ?? '',
    depositAmount: product?.depositAmount ?? 0,
    sacCode: product?.sacCode ?? '997319',
    gstRateBp: product?.gstRateBp ?? 1800,
    priceIncludesTax: product?.priceIncludesTax ?? settings.data?.tax.pricesIncludeTax ?? true,
    notes: product?.notes ?? '',
  });
  const [rates, setRates] = useState<RateRow[]>(
    product?.rates.map((r) => ({ key: crypto.randomUUID(), unit: r.unit, hours: r.unitMinutes / 60, label: r.label ?? '', price: r.price })) ?? [
      { key: crypto.randomUUID(), unit: 'DAY', hours: 24, label: '', price: null },
    ],
  );
  const [units, setUnits] = useState(1);
  const [serials, setSerials] = useState('');
  const [cost, setCost] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(newRequestId);
  const create = useCommandMutation('rentalProducts.create', { invalidate: ['rentalProducts.', 'rentalAssets.', 'rentals.'] });
  const update = useCommandMutation('rentalProducts.update', { invalidate: ['rentalProducts.', 'rentalAssets.', 'rentals.'] });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const categories = catalog.data?.categories.filter((c) => c.kind === 'RENTAL' && (c.isActive || c.id === f.categoryId)) ?? [];

  const submit = async () => {
    setError(null);
    const parsed = rentalProductFields.safeParse({
      ...f,
      rates: rates.map((r) => ({
        unit: r.unit,
        unitMinutes: r.unit === 'CUSTOM' ? Math.round(r.hours * 60) : undefined,
        label: r.label,
        price: r.price ?? -1,
      })),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form');
      return;
    }
    try {
      const saved = product
        ? await update.mutateAsync({ ...parsed.data, id: product.id, version: product.version, reason: reason || undefined })
        : await create.mutateAsync({
            ...parsed.data,
            requestId,
            units,
            serials: serials.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
            purchaseCost: cost ?? 0,
            purchaseDate: null,
          });
      toast.success(product ? 'Rental item saved' : `${saved.name} added with ${saved.unitsTotal} unit${saved.unitsTotal === 1 ? '' : 's'}`);
      onSaved(saved);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={product ? `Edit ${product.name}` : 'Add rental item'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} busy={create.isPending || update.isPending}>
            {product ? 'Save changes' : 'Add rental item'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-6 gap-4">
        <Field label="Name" required className="col-span-4">
          {(p) => <Input {...p} value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus maxLength={160} />}
        </Field>
        <Field label="Category" className="col-span-2">
          {(p) => (
            <Select {...p} value={f.categoryId ?? ''} onChange={(e) => set('categoryId', e.target.value ? Number(e.target.value) : null)}>
              <option value="">No category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Brand" className="col-span-2">
          {(p) => <Input {...p} value={f.brand} onChange={(e) => set('brand', e.target.value)} maxLength={80} />}
        </Field>
        <Field label="Model" className="col-span-2">
          {(p) => <Input {...p} value={f.model} onChange={(e) => set('model', e.target.value)} maxLength={80} />}
        </Field>
        <Field label="Security deposit per unit" className="col-span-2">
          {(p) => <MoneyInput {...p} value={f.depositAmount} onValueChange={(v) => set('depositAmount', v ?? 0)} />}
        </Field>

        <div className="col-span-6 rounded-lg border border-line p-4">
          <p className="mb-2 font-medium text-ink">Rental rates</p>
          <p className="mb-3 text-[13px] text-ink-3">
            The cheapest combination of these rates is charged (e.g. 9 days = 1 week + 2 days). Prices {f.priceIncludesTax ? 'include' : 'exclude'} GST.
          </p>
          <div className="flex flex-col gap-2">
            {rates.map((r) => (
              <div key={r.key} className="grid grid-cols-[180px_1fr_160px_32px] items-center gap-2">
                <Select
                  aria-label="Rate unit"
                  value={r.unit}
                  onChange={(e) => setRates((rs) => rs.map((x) => (x.key === r.key ? { ...x, unit: e.target.value as RateUnit, hours: e.target.value === 'CUSTOM' ? x.hours : UNIT_MINUTES[e.target.value as Exclude<RateUnit, 'CUSTOM'>] / 60 } : x)))}
                >
                  {Object.entries(UNIT_NAMES).map(([u, l]) => (
                    <option key={u} value={u}>
                      {l}
                    </option>
                  ))}
                </Select>
                {r.unit === 'CUSTOM' ? (
                  <div className="flex gap-2">
                    <Input aria-label="Custom period name" placeholder="Name, e.g. Half day" value={r.label} onChange={(e) => setRates((rs) => rs.map((x) => (x.key === r.key ? { ...x, label: e.target.value } : x)))} />
                    <Input
                      aria-label="Hours"
                      type="number"
                      min={0.25}
                      step={0.25}
                      className="w-24"
                      value={r.hours}
                      onChange={(e) => setRates((rs) => rs.map((x) => (x.key === r.key ? { ...x, hours: Number(e.target.value) } : x)))}
                    />
                    <span className="self-center text-ink-3">hours</span>
                  </div>
                ) : (
                  <span />
                )}
                <MoneyInput aria-label={`${UNIT_NAMES[r.unit]} price`} value={r.price} onValueChange={(v) => setRates((rs) => rs.map((x) => (x.key === r.key ? { ...x, price: v } : x)))} />
                <button type="button" aria-label="Remove rate" disabled={rates.length === 1} className="rounded p-1.5 text-ink-3 hover:bg-surface-2 disabled:opacity-40" onClick={() => setRates((rs) => rs.filter((x) => x.key !== r.key))}>
                  <X className="size-4" />
                </button>
              </div>
            ))}
          </div>
          <Button variant="ghost" size="sm" icon={<Plus className="size-4" />} className="mt-2" onClick={() => setRates((rs) => [...rs, { key: crypto.randomUUID(), unit: 'WEEK', hours: 168, label: '', price: null }])}>
            Add rate
          </Button>
        </div>

        <Field label="GST rate" className="col-span-2">
          {(p) => (
            <Select {...p} value={f.gstRateBp} onChange={(e) => set('gstRateBp', Number(e.target.value))}>
              {GST_RATES_BP.map((r) => (
                <option key={r} value={r}>
                  {formatRate(r)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="SAC code" className="col-span-2" hint="997319 is rental of machinery">
          {(p) => <Input {...p} value={f.sacCode} onChange={(e) => set('sacCode', e.target.value.replace(/\D/g, ''))} maxLength={8} />}
        </Field>
        <div className="col-span-2 pt-6">
          <Switch label="Rates include GST" checked={f.priceIncludesTax} onChange={(v) => set('priceIncludesTax', v)} />
        </div>

        {!product && (
          <div className="col-span-6 grid grid-cols-6 gap-4 rounded-lg border border-line p-4">
            <Field label="Number of units owned" className="col-span-2">
              {(p) => <Input {...p} type="number" min={0} max={50} value={units} onChange={(e) => setUnits(Math.max(0, Math.min(50, Math.trunc(Number(e.target.value) || 0))))} />}
            </Field>
            <Field label="Cost per unit" className="col-span-2">
              {(p) => <MoneyInput {...p} value={cost} onValueChange={(v) => setCost(v)} />}
            </Field>
            <Field label="Serial numbers (optional)" className="col-span-6" hint="One per unit, separated by commas or new lines">
              {(p) => <Textarea {...p} rows={2} value={serials} onChange={(e) => setSerials(e.target.value)} />}
            </Field>
          </div>
        )}
        <Field label="Description" className="col-span-6">
          {(p) => <Input {...p} value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={1000} />}
        </Field>
        {product && (
          <Field label="Reason for change (optional)" className="col-span-6" hint="Rentals already made keep the rates they were made with.">
            {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}
          </Field>
        )}
        {error && (
          <div className="col-span-6">
            <ErrorBanner title="Not saved" message={error} />
          </div>
        )}
      </div>
    </Dialog>
  );
}
