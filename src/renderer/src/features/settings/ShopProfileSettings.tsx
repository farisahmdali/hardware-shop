import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { shopProfileSchema, type ShopProfile } from '@shared/settings';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Card, CardHeader, Spinner } from '../../components/ui/layout';
import { ShopProfileFields, type ShopProfileInput } from './ShopProfileFields';

export function ShopProfileSettings() {
  const settings = useCommandQuery('settings.get');
  const save = useCommandMutation('settings.update', { invalidate: ['settings.', 'app.status'] });
  const toast = useToast();
  const form = useForm<ShopProfileInput, unknown, ShopProfile>({ resolver: zodResolver(shopProfileSchema) });

  useEffect(() => {
    if (settings.data) form.reset(settings.data.shop);
  }, [settings.data, form]);

  if (!settings.data) return <Spinner />;

  const submit = form.handleSubmit(async (value) => {
    try {
      await save.mutateAsync({ section: 'shop', value });
      toast.success('Shop profile saved');
    } catch (e) {
      toast.error('Could not save the shop profile', errorMessage(e));
    }
  });

  return (
    <Card>
      <CardHeader title="Shop profile" description="Shown on invoices, receipts, rental agreements and statements." />
      <form onSubmit={submit} noValidate className="p-5">
        <ShopProfileFields register={form.register} errors={form.formState.errors} />
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" disabled={!form.formState.isDirty || save.isPending} onClick={() => form.reset(settings.data.shop)}>
            Discard changes
          </Button>
          <Button type="submit" busy={save.isPending} disabled={!form.formState.isDirty}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}
