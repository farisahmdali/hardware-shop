import { useEffect, useState } from 'react';
import type { AllSettings } from '@shared/settings';
import { formatMoney } from '@shared/money';
import { priceRental, lateFee } from '@shared/rentalPricing';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Field, Input, Select, Textarea } from '../../components/ui/form';
import { Card, CardHeader, Spinner } from '../../components/ui/layout';
import { MoneyInput } from '../../components/ui/numberInputs';

const EXAMPLE = [
  { unit: 'HOUR' as const, unitMinutes: 60, price: 5000 },
  { unit: 'DAY' as const, unitMinutes: 1440, price: 30000 },
  { unit: 'WEEK' as const, unitMinutes: 10080, price: 150000 },
];

/** Rental pricing and billing rules, with a live worked example so the effect of each choice is visible. */
export function RentalSettings() {
  const settings = useCommandQuery('settings.get');
  const save = useCommandMutation('settings.update', { invalidate: ['settings.', 'rentals.'] });
  const toast = useToast();
  const [r, setR] = useState<AllSettings['rental'] | null>(null);
  useEffect(() => {
    if (settings.data) setR(settings.data.rental);
  }, [settings.data]);
  if (!r) return <Spinner />;
  const set = <K extends keyof AllSettings['rental']>(k: K, v: AllSettings['rental'][K]) => setR({ ...r, [k]: v });

  const opts = { mode: r.pricingMode, graceMinutes: r.graceMinutes, chosenUnit: 'DAY' as const };
  let example = '';
  let lateExample = '';
  try {
    example = priceRental(EXAMPLE, 9 * 1440 + 90, opts).explanation;
    const fee = lateFee(EXAMPLE, 7 * 1440, 8 * 1440 + 180, { ...opts, lateFeeMode: r.lateFeeMode, lateFeePerDay: r.lateFeePerDay, lateMultiplierBp: r.lateMultiplierBp });
    lateExample = `${formatMoney(fee.amount)} — ${fee.explanation}`;
  } catch (e) {
    example = (e as Error).message;
  }

  return (
    <Card>
      <CardHeader title="Rental rules" description="Applies to new rentals. Each rental keeps the rules it was made with." />
      <div className="grid max-w-3xl grid-cols-2 gap-5 p-5">
        <Field label="Pricing">
          {(p) => (
            <Select {...p} value={r.pricingMode} onChange={(e) => set('pricingMode', e.target.value as typeof r.pricingMode)}>
              <option value="CHEAPEST">Cheapest combination of rates</option>
              <option value="DAILY">Daily rate, every started day</option>
              <option value="CHOSEN_UNIT">One rate unit chosen at issue</option>
            </Select>
          )}
        </Field>
        <Field label="Grace period (minutes)" hint="Lateness forgiven before another unit or a late fee is charged">
          {(p) => <Input {...p} type="number" min={0} max={720} value={r.graceMinutes} onChange={(e) => set('graceMinutes', Math.max(0, Math.min(720, Math.trunc(Number(e.target.value) || 0))))} />}
        </Field>
        <Field label="When rentals are billed">
          {(p) => (
            <Select {...p} value={r.billing} onChange={(e) => set('billing', e.target.value as typeof r.billing)}>
              <option value="AT_ISSUE">Booked period at issue; extra time on extension or return</option>
              <option value="AT_RETURN">Everything on return</option>
            </Select>
          )}
        </Field>
        <Field label="Late returns">
          {(p) => (
            <Select {...p} value={r.lateFeeMode} onChange={(e) => set('lateFeeMode', e.target.value as typeof r.lateFeeMode)}>
              <option value="SAME_RATES">Extra time at the normal rates</option>
              <option value="MULTIPLIER">Extra time at the normal rates × a multiplier</option>
              <option value="FIXED_PER_DAY">A fixed fee per started day</option>
            </Select>
          )}
        </Field>
        {r.lateFeeMode === 'FIXED_PER_DAY' && (
          <Field label="Late fee per day">{(p) => <MoneyInput {...p} value={r.lateFeePerDay} onValueChange={(v) => set('lateFeePerDay', v ?? 0)} />}</Field>
        )}
        {r.lateFeeMode === 'MULTIPLIER' && (
          <Field label="Multiplier" hint="1.5 means extra time costs 50% more">
            {(p) => <Input {...p} type="number" min={1} max={5} step={0.1} value={r.lateMultiplierBp / 10_000} onChange={(e) => set('lateMultiplierBp', Math.round(Math.max(1, Math.min(5, Number(e.target.value) || 1)) * 10_000))} />}
          </Field>
        )}
        <div className="col-span-2 rounded-md bg-surface-2 px-4 py-3 text-[13px]">
          <p className="font-medium text-ink">Example with ₹50/hour, ₹300/day, ₹1,500/week</p>
          <p className="text-ink-2">9 days 1½ hours: {example}</p>
          <p className="text-ink-2">Booked for 1 week, returned 1 day 3 hours late: {lateExample}</p>
        </div>
        <Field label="Terms printed on rental agreements" className="col-span-2">
          {(p) => <Textarea {...p} rows={4} value={r.terms} onChange={(e) => set('terms', e.target.value)} maxLength={2000} />}
        </Field>
        <div className="col-span-2">
          <Button
            busy={save.isPending}
            onClick={async () => {
              try {
                await save.mutateAsync({ section: 'rental', value: r });
                toast.success('Rental rules saved');
              } catch (e) {
                toast.error('Not saved', errorMessage(e));
              }
            }}
          >
            Save rental rules
          </Button>
        </div>
      </div>
    </Card>
  );
}
