import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { Hammer, ShieldCheck, Store } from 'lucide-react';
import { shopProfileSchema, type ShopProfile } from '@shared/settings';
import { secretSchema } from '@shared/contracts';
import { call, errorMessage } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Field, Input } from '../../components/ui/form';
import { ErrorBanner } from '../../components/ui/layout';
import { ShopProfileFields, type ShopProfileInput } from '../settings/ShopProfileFields';
import { cn } from '../../lib/cn';

const ownerSchema = z
  .object({
    displayName: z.string().trim().min(1, 'Enter your name').max(80),
    username: z
      .string()
      .trim()
      .min(3, 'At least 3 characters')
      .max(40)
      .regex(/^[a-zA-Z0-9._-]+$/, 'Letters, digits, dot, dash or underscore only'),
    secret: secretSchema,
    confirm: z.string(),
  })
  .refine((v) => v.secret === v.confirm, { path: ['confirm'], message: 'The two entries do not match' });

type OwnerInput = z.input<typeof ownerSchema>;

export function SetupWizard() {
  const [step, setStep] = useState<1 | 2>(1);
  const [shop, setShop] = useState<ShopProfile | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  const shopForm = useForm<ShopProfileInput, unknown, ShopProfile>({
    resolver: zodResolver(shopProfileSchema),
    defaultValues: { name: '', stateCode: '', addressLine1: '', city: '', pincode: '', phone: '', email: '', gstin: '' },
  });
  const ownerForm = useForm<OwnerInput, unknown, z.output<typeof ownerSchema>>({
    resolver: zodResolver(ownerSchema),
    defaultValues: { displayName: '', username: 'owner', secret: '', confirm: '' },
  });

  const finish = ownerForm.handleSubmit(async (owner) => {
    if (!shop) return;
    setBusy(true);
    setSubmitError(null);
    try {
      await call('setup.complete', {
        shop,
        owner: { displayName: owner.displayName, username: owner.username, secret: owner.secret },
      });
      await qc.invalidateQueries();
    } catch (e) {
      setSubmitError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  });

  return (
    <div className="flex min-h-full items-start justify-center bg-bg px-6 py-12">
      <div className="w-full max-w-2xl">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl bg-accent text-white">
            <Hammer className="size-6" />
          </div>
          <div>
            <h1 className="font-display text-2xl font-semibold text-ink">Welcome to Hardware Shop Manager</h1>
            <p className="text-ink-2">Two quick steps and the shop is ready. Everything stays on this computer.</p>
          </div>
        </div>

        <ol className="mb-6 flex gap-3" aria-label="Setup steps">
          {[
            { n: 1, label: 'Shop details', icon: Store },
            { n: 2, label: 'Owner account', icon: ShieldCheck },
          ].map((s) => (
            <li
              key={s.n}
              aria-current={step === s.n ? 'step' : undefined}
              className={cn(
                'flex flex-1 items-center gap-2 rounded-lg border px-4 py-3',
                step === s.n ? 'border-brand bg-brand-soft text-brand' : 'border-line bg-surface text-ink-3',
              )}
            >
              <s.icon className="size-4" />
              <span className="font-medium">
                {s.n}. {s.label}
              </span>
            </li>
          ))}
        </ol>

        <div className="rounded-xl border border-line bg-surface p-7 shadow-card">
          {step === 1 ? (
            <form
              onSubmit={shopForm.handleSubmit((values) => {
                setShop(values);
                setStep(2);
              })}
              noValidate
            >
              <ShopProfileFields register={shopForm.register} errors={shopForm.formState.errors} showFooter={false} />
              <div className="mt-7 flex justify-end">
                <Button type="submit" size="lg">
                  Continue
                </Button>
              </div>
            </form>
          ) : (
            <form onSubmit={finish} noValidate className="flex flex-col gap-4">
              <p className="text-ink-2">
                The owner account can do everything, including managing employee accounts and restoring backups.
              </p>
              <Field label="Your name" required error={ownerForm.formState.errors.displayName?.message}>
                {(p) => <Input {...p} {...ownerForm.register('displayName')} autoFocus />}
              </Field>
              <Field label="Username" required error={ownerForm.formState.errors.username?.message}>
                {(p) => <Input {...p} {...ownerForm.register('username')} autoComplete="off" />}
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field
                  label="PIN or password"
                  required
                  error={ownerForm.formState.errors.secret?.message}
                  hint="A PIN of 4+ digits, or a password of 6+ characters."
                >
                  {(p) => <Input {...p} {...ownerForm.register('secret')} type="password" autoComplete="new-password" />}
                </Field>
                <Field label="Repeat it" required error={ownerForm.formState.errors.confirm?.message}>
                  {(p) => <Input {...p} {...ownerForm.register('confirm')} type="password" autoComplete="new-password" />}
                </Field>
              </div>
              {submitError && <ErrorBanner title="Setup failed" message={submitError} />}
              <div className="mt-3 flex justify-between">
                <Button variant="secondary" onClick={() => setStep(1)} disabled={busy}>
                  Back
                </Button>
                <Button type="submit" size="lg" busy={busy}>
                  Finish setup
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
