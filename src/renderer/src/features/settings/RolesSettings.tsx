import { useEffect, useMemo, useState } from 'react';
import { PERMISSIONS, type Permission } from '@shared/permissions';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Checkbox, Field, Input } from '../../components/ui/form';
import { Card, CardHeader, Spinner } from '../../components/ui/layout';
import { cn } from '../../lib/cn';

const groups = Object.entries(PERMISSIONS).reduce<Record<string, Permission[]>>((acc, [key, p]) => {
  (acc[p.group] ??= []).push(key as Permission);
  return acc;
}, {});

export function RolesSettings() {
  const roles = useCommandQuery('roles.list');
  const save = useCommandMutation('roles.update', { invalidate: ['roles.', 'auth.session', 'users.'] });
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const role = useMemo(() => roles.data?.find((r) => r.id === selectedId) ?? roles.data?.[1], [roles.data, selectedId]);
  const [perms, setPerms] = useState<Set<Permission>>(new Set());
  const [discount, setDiscount] = useState('0');
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (role) {
      setPerms(new Set(role.permissions));
      setDiscount(String(role.maxDiscountBp / 100));
      setReason('');
    }
  }, [role]);

  if (!roles.data || !role) return <Spinner />;
  const isOwner = role.code === 'OWNER';
  const discountBp = Math.round(Number(discount) * 100);
  const discountValid = Number.isFinite(discountBp) && discountBp >= 0 && discountBp <= 10000;

  const submit = async () => {
    try {
      await save.mutateAsync({ id: role.id, permissions: [...perms], maxDiscountBp: discountBp, version: role.version, reason: reason || undefined });
      toast.success(`${role.name} permissions saved`);
    } catch (e) {
      toast.error('Could not save the role', errorMessage(e));
    }
  };

  return (
    <Card>
      <CardHeader title="Roles & permissions" description="Changes apply to everyone with the role, immediately." />
      <div className="flex gap-6 p-5">
        <ul className="flex w-48 shrink-0 flex-col gap-1">
          {roles.data.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => setSelectedId(r.id)}
                className={cn(
                  'w-full rounded-md px-3 py-2 text-left font-medium',
                  r.id === role.id ? 'bg-brand-soft text-brand' : 'text-ink-2 hover:bg-surface-2',
                )}
              >
                {r.name}
              </button>
            </li>
          ))}
        </ul>
        <div className="min-w-0 flex-1">
          {isOwner && (
            <p className="mb-4 rounded-md bg-surface-2 px-3 py-2 text-ink-2">
              The owner always has every permission, so the shop can never be locked out.
            </p>
          )}
          <div className="grid grid-cols-2 gap-x-8 gap-y-5">
            {Object.entries(groups).map(([group, keys]) => (
              <fieldset key={group}>
                <legend className="mb-2 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">{group}</legend>
                <div className="flex flex-col gap-2">
                  {keys.map((k) => (
                    <Checkbox
                      key={k}
                      disabled={isOwner}
                      checked={isOwner || perms.has(k)}
                      label={PERMISSIONS[k].label}
                      onChange={(on) =>
                        setPerms((s) => {
                          const next = new Set(s);
                          if (on) next.add(k);
                          else next.delete(k);
                          return next;
                        })
                      }
                    />
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
          {!isOwner && (
            <div className="mt-6 grid grid-cols-2 gap-5 border-t border-line pt-5">
              <Field label="Maximum discount (%)" error={discountValid ? undefined : 'Enter 0 to 100'} hint="Largest discount this role can give on a bill.">
                {(p) => <Input {...p} type="number" min={0} max={100} step={0.5} value={discount} onChange={(e) => setDiscount(e.target.value)} />}
              </Field>
              <Field label="Reason for change (optional)">
                {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}
              </Field>
              <div className="col-span-2 flex justify-end">
                <Button onClick={submit} busy={save.isPending} disabled={!discountValid}>
                  Save {role.name}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
