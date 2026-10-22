import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Hammer, LockKeyhole } from 'lucide-react';
import { call, errorMessage, useCommandQuery } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Field, Input } from '../../components/ui/form';
import { ErrorBanner } from '../../components/ui/layout';
import { cn } from '../../lib/cn';

export function LoginScreen({ shopName }: { shopName?: string }) {
  const options = useCommandQuery('auth.loginOptions');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username || !secret) return;
    setBusy(true);
    setError(null);
    try {
      await call('auth.login', { username, secret });
      await qc.invalidateQueries();
    } catch (err) {
      setError(errorMessage(err));
      setSecret('');
    } finally {
      setBusy(false);
    }
  };

  const users = options.data?.users ?? [];

  // A shop with a single account should only need the PIN.
  useEffect(() => {
    const only = options.data?.users.length === 1 ? options.data.users[0] : undefined;
    if (only) setUsername((u) => u || only.username);
  }, [options.data]);

  return (
    <div className="flex min-h-full items-center justify-center bg-bg px-6">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex size-12 items-center justify-center rounded-xl bg-accent text-white">
            <Hammer className="size-6" />
          </div>
          <h1 className="font-display text-2xl font-semibold text-ink">{shopName || 'Hardware Shop Manager'}</h1>
          <p className="text-ink-2">Sign in to continue</p>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-7 shadow-card">
          {users.length > 0 && users.length <= 8 ? (
            <div role="radiogroup" aria-label="Who is signing in?" className="grid grid-cols-2 gap-2">
              {users.map((u) => (
                <button
                  key={u.username}
                  type="button"
                  role="radio"
                  aria-checked={username === u.username}
                  onClick={() => setUsername(u.username)}
                  className={cn(
                    'rounded-lg border px-3 py-2.5 text-left transition-colors',
                    username === u.username ? 'border-brand bg-brand-soft' : 'border-line hover:bg-surface-2',
                  )}
                >
                  <span className="block font-medium text-ink">{u.displayName}</span>
                  <span className="block text-[12px] text-ink-3">{u.username}</span>
                </button>
              ))}
            </div>
          ) : (
            <Field label="Username">
              {(p) => <Input {...p} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />}
            </Field>
          )}
          <Field label="PIN or password">
            {(p) => (
              <Input
                {...p}
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoFocus={users.length > 0 && users.length <= 8}
                autoComplete="current-password"
              />
            )}
          </Field>
          {error && <ErrorBanner title="Sign-in failed" message={error} />}
          <Button type="submit" size="lg" busy={busy} disabled={!username || !secret} icon={<LockKeyhole className="size-4" />}>
            Sign in
          </Button>
        </form>
      </div>
    </div>
  );
}
