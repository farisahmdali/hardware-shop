import { useEffect, useState } from 'react';
import type { AllSettings } from '@shared/settings';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Field, Input, Switch } from '../../components/ui/form';
import { Card, CardHeader, Spinner } from '../../components/ui/layout';

type Editable = Pick<AllSettings, 'tax' | 'stock' | 'receivables'>;

export function BillingSettings() {
  const settings = useCommandQuery('settings.get');
  const save = useCommandMutation('settings.update', { invalidate: ['settings.'] });
  const toast = useToast();
  const [draft, setDraft] = useState<Editable | null>(null);
  const [buckets, setBuckets] = useState('');

  useEffect(() => {
    if (settings.data) {
      setDraft({ tax: settings.data.tax, stock: settings.data.stock, receivables: settings.data.receivables });
      setBuckets(settings.data.receivables.ageingBuckets.join(', '));
    }
  }, [settings.data]);

  if (!settings.data || !draft) return <Spinner />;

  const parsedBuckets = buckets
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const bucketsValid =
    parsedBuckets.length > 0 && parsedBuckets.every((n, i) => i === 0 || n > parsedBuckets[i - 1]!);

  const saveAll = async () => {
    const next: Editable = { ...draft, receivables: { ...draft.receivables, ageingBuckets: parsedBuckets } };
    try {
      for (const section of ['tax', 'stock', 'receivables'] as const) {
        if (JSON.stringify(next[section]) !== JSON.stringify(settings.data[section])) {
          await save.mutateAsync({ section, value: next[section] });
        }
      }
      toast.success('Billing settings saved');
    } catch (e) {
      toast.error('Could not save the settings', errorMessage(e));
    }
  };

  const set = <S extends keyof Editable>(section: S, patch: Partial<Editable[S]>) =>
    setDraft((d) => (d ? { ...d, [section]: { ...d[section], ...patch } } : d));

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader title="GST and invoice totals" />
        <div className="flex flex-col gap-4 p-5">
          <Switch
            label="The shop is registered for GST"
            description="When off, bills are issued as a bill of supply without GST."
            checked={draft.tax.gstRegistered}
            onChange={(v) => set('tax', { gstRegistered: v })}
          />
          <Switch
            label="Selling prices include GST"
            description="Default for new products. Can be changed for each product."
            checked={draft.tax.pricesIncludeTax}
            onChange={(v) => set('tax', { pricesIncludeTax: v })}
          />
          <Switch
            label="Round invoice totals to the nearest rupee"
            description="The difference is printed as a separate round-off line."
            checked={draft.tax.roundInvoiceTotal}
            onChange={(v) => set('tax', { roundInvoiceTotal: v })}
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="Credit and outstanding balances" />
        <div className="grid grid-cols-2 gap-5 p-5">
          <Field label="Default credit period (days)" hint="When an unpaid invoice becomes overdue. Can be set per customer.">
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0}
                max={365}
                value={draft.receivables.defaultCreditDays}
                onChange={(e) => set('receivables', { defaultCreditDays: Math.max(0, Math.trunc(Number(e.target.value) || 0)) })}
              />
            )}
          </Field>
          <Field
            label="Ageing buckets (days)"
            hint="Comma-separated upper limits, e.g. 30, 60, 90 gives 0–30, 31–60, 61–90 and over 90."
            error={bucketsValid ? undefined : 'Enter increasing whole numbers, e.g. 30, 60, 90'}
          >
            {(p) => <Input {...p} value={buckets} onChange={(e) => setBuckets(e.target.value)} />}
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="Stock" />
        <div className="p-5">
          <Switch
            label="Allow authorised users to sell below zero stock"
            description="Off by default. When on, users with the override permission can continue after giving a reason."
            checked={draft.stock.allowNegativeOverride}
            onChange={(v) => set('stock', { allowNegativeOverride: v })}
          />
        </div>
      </Card>

      <div className="flex justify-end">
        <Button onClick={saveAll} busy={save.isPending} disabled={!bucketsValid}>
          Save changes
        </Button>
      </div>
    </div>
  );
}
