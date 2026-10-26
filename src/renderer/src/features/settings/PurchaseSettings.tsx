import { useEffect, useState } from 'react';
import type { AllSettings } from '@shared/settings';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Field, Input, Switch } from '../../components/ui/form';
import { Card, CardHeader, Spinner } from '../../components/ui/layout';
import { MoneyInput } from '../../components/ui/numberInputs';

/** How purchase bills are costed and when suppliers are due to be paid. */
export function PurchaseSettings() {
  const settings = useCommandQuery('settings.get');
  const save = useCommandMutation('settings.update', { invalidate: ['settings.', 'purchases.', 'payables.'] });
  const toast = useToast();
  const [r, setR] = useState<AllSettings['purchases'] | null>(null);
  useEffect(() => {
    if (settings.data) setR(settings.data.purchases);
  }, [settings.data]);
  if (!r || !settings.data) return <Spinner />;
  const set = <K extends keyof AllSettings['purchases']>(k: K, v: AllSettings['purchases'][K]) => setR({ ...r, [k]: v });
  const registered = settings.data.tax.gstRegistered;

  return (
    <Card>
      <CardHeader title="Purchases" description="Applies to purchases entered from now on. Recorded purchases keep how they were costed." />
      <div className="grid max-w-3xl grid-cols-2 gap-5 p-5">
        <div className="col-span-2">
          <Switch
            checked={r.claimInputGst}
            onChange={(v) => set('claimInputGst', v)}
            label="Claim GST paid on purchases (input tax credit)"
            description={
              registered
                ? 'GST on bills from GST-registered suppliers is kept out of stock cost and recorded as recoverable. Turn off if you are under the composition scheme.'
                : 'The shop is not GST registered (Billing, tax & stock), so GST paid is always part of the cost.'
            }
          />
        </div>
        <Field label="Days to pay a supplier's bill" hint="Used when the supplier has no period of their own">
          {(p) => (
            <Input
              {...p}
              type="number"
              min={0}
              max={365}
              value={r.defaultCreditDays}
              onChange={(e) => set('defaultCreditDays', Math.max(0, Math.min(365, Math.trunc(Number(e.target.value) || 0))))}
            />
          )}
        </Field>
        <Field label="Largest round-off allowed" hint="To match a supplier's rounded bill total">
          {(p) => <MoneyInput {...p} value={r.maxRoundOff} onValueChange={(v) => set('maxRoundOff', Math.min(10_000, v ?? 0))} />}
        </Field>
        <div className="col-span-2">
          <Button
            busy={save.isPending}
            onClick={async () => {
              try {
                await save.mutateAsync({ section: 'purchases', value: r });
                toast.success('Purchase settings saved');
              } catch (e) {
                toast.error('Not saved', errorMessage(e));
              }
            }}
          >
            Save purchase settings
          </Button>
        </div>
      </div>
    </Card>
  );
}
