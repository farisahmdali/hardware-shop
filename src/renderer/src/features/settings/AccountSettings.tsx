import { useState } from 'react';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Field, Input, Select, Switch } from '../../components/ui/form';
import { Card, CardHeader, KeyValue } from '../../components/ui/layout';

export function AccountSettings() {
  const session = useSession();
  const can = useCan();
  const toast = useToast();
  const status = useCommandQuery('app.status');
  const settings = useCommandQuery('settings.get');
  const changeSecret = useCommandMutation('auth.changeSecret');
  const saveSettings = useCommandMutation('settings.update', { invalidate: ['settings.', 'app.status'] });
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  const submitSecret = async () => {
    if (next !== confirm) {
      toast.error('The new PIN entries do not match');
      return;
    }
    try {
      await changeSecret.mutateAsync({ currentSecret: current, newSecret: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      toast.success('Your PIN has been changed');
    } catch (e) {
      toast.error('Could not change the PIN', errorMessage(e));
    }
  };

  const app = settings.data?.app;
  const saveApp = async (patch: Partial<NonNullable<typeof app>>) => {
    if (!app) return;
    try {
      await saveSettings.mutateAsync({ section: 'app', value: { ...app, ...patch } });
    } catch (e) {
      toast.error('Could not save', errorMessage(e));
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader title="Change my PIN or password" description={`Signed in as ${session.user.displayName} (${session.user.username}).`} />
        <div className="grid max-w-xl grid-cols-1 gap-4 p-5">
          <Field label="Current PIN or password">
            {(p) => <Input {...p} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />}
          </Field>
          <Field label="New PIN or password" hint="A PIN of 4+ digits, or a password of 6+ characters.">
            {(p) => <Input {...p} type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />}
          </Field>
          <Field label="Repeat the new one">
            {(p) => <Input {...p} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />}
          </Field>
          <div>
            <Button onClick={submitSecret} busy={changeSecret.isPending} disabled={!current || !next}>
              Change PIN
            </Button>
          </div>
        </div>
      </Card>

      {can('settings.manage') && app && (
        <Card>
          <CardHeader title="Display and sign-in" />
          <div className="flex max-w-xl flex-col gap-5 p-5">
            <Field label="Theme">
              {(p) => (
                <Select {...p} value={app.theme} onChange={(e) => saveApp({ theme: e.target.value as typeof app.theme })}>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                  <option value="system">Follow Windows setting</option>
                </Select>
              )}
            </Field>
            <Switch
              label="Ask for a PIN when the application opens"
              description="Turn off only if the computer is used by the owner alone. Everything is then recorded as the owner."
              checked={app.requireLogin}
              onChange={(v) => saveApp({ requireLogin: v })}
              disabled={saveSettings.isPending}
            />
          </div>
        </Card>
      )}

      {status.data && (
        <Card>
          <CardHeader title="About this installation" />
          <div className="p-5">
            <KeyValue
              items={[
                { label: 'Version', value: status.data.appVersion },
                { label: 'Database schema', value: status.data.schemaVersion },
                { label: 'Data folder', value: <span className="font-mono text-[13px]">{status.data.dataDir}</span> },
              ]}
            />
          </div>
        </Card>
      )}
    </div>
  );
}
