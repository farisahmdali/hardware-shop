import { useState } from 'react';
import { KeyRound, Pencil, UserPlus } from 'lucide-react';
import type { UserRow } from '@shared/contracts';
import { formatDateTime } from '@shared/time';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select, Switch } from '../../components/ui/form';
import { Badge, Card, CardHeader, Spinner } from '../../components/ui/layout';
import { Table, Td, Th, THead, Tr } from '../../components/ui/table';

type Mode = { kind: 'create' } | { kind: 'edit'; user: UserRow } | { kind: 'reset'; user: UserRow } | null;

export function UsersSettings() {
  const users = useCommandQuery('users.list');
  const roles = useCommandQuery('roles.list');
  const [mode, setMode] = useState<Mode>(null);
  const me = useSession();

  return (
    <Card>
      <CardHeader
        title="Users"
        description="Each person signs in with their own account, so the history shows who did what."
        actions={
          <Button icon={<UserPlus className="size-4" />} onClick={() => setMode({ kind: 'create' })}>
            Add user
          </Button>
        }
      />
      {!users.data || !roles.data ? (
        <Spinner />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Name</Th>
              <Th>Username</Th>
              <Th>Role</Th>
              <Th>Last sign-in</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </THead>
          <tbody>
            {users.data.map((u) => (
              <Tr key={u.id}>
                <Td className="font-medium">
                  {u.displayName}
                  {u.id === me.user.id && <span className="ml-2 text-ink-3">(you)</span>}
                </Td>
                <Td className="font-mono text-[13px]">{u.username}</Td>
                <Td>{u.roleName}</Td>
                <Td className="tabular">{formatDateTime(u.lastLoginAt) || 'Never'}</Td>
                <Td>{u.isActive ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}</Td>
                <Td align="right" className="whitespace-nowrap">
                  <Button variant="ghost" size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setMode({ kind: 'edit', user: u })}>
                    Edit
                  </Button>
                  <Button variant="ghost" size="sm" icon={<KeyRound className="size-3.5" />} onClick={() => setMode({ kind: 'reset', user: u })}>
                    Reset PIN
                  </Button>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      {mode && roles.data && <UserDialog mode={mode} roles={roles.data} onClose={() => setMode(null)} />}
    </Card>
  );
}

function UserDialog({
  mode,
  roles,
  onClose,
}: {
  mode: Exclude<Mode, null>;
  roles: { id: number; name: string; code: string }[];
  onClose(): void;
}) {
  const toast = useToast();
  const create = useCommandMutation('users.create', { invalidate: ['users.'] });
  const update = useCommandMutation('users.update', { invalidate: ['users.'] });
  const reset = useCommandMutation('users.resetSecret', { invalidate: ['users.'] });
  const user = mode.kind === 'create' ? null : mode.user;
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [username, setUsername] = useState('');
  const [roleId, setRoleId] = useState(user?.roleId ?? roles.find((r) => r.code === 'SALES')?.id ?? roles[0]!.id);
  const [isActive, setIsActive] = useState(user?.isActive ?? true);
  const [secret, setSecret] = useState('');
  const [reason, setReason] = useState('');
  const busy = create.isPending || update.isPending || reset.isPending;

  const submit = async () => {
    try {
      if (mode.kind === 'create') {
        await create.mutateAsync({ username, displayName, roleId, secret });
        toast.success(`User ${displayName} added`);
      } else if (mode.kind === 'edit') {
        await update.mutateAsync({ id: mode.user.id, displayName, roleId, isActive, version: mode.user.version, reason: reason || undefined });
        toast.success('User updated');
      } else {
        await reset.mutateAsync({ id: mode.user.id, newSecret: secret, reason: reason || undefined });
        toast.success(`PIN reset for ${mode.user.displayName}`);
      }
      onClose();
    } catch (e) {
      toast.error('Could not save', errorMessage(e));
    }
  };

  const title = mode.kind === 'create' ? 'Add user' : mode.kind === 'edit' ? `Edit ${mode.user.displayName}` : `Reset PIN for ${mode.user.displayName}`;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} busy={busy}>
            {mode.kind === 'reset' ? 'Reset PIN' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {mode.kind !== 'reset' && (
          <>
            <Field label="Full name" required>
              {(p) => <Input {...p} value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoFocus />}
            </Field>
            {mode.kind === 'create' && (
              <Field label="Username" required hint="Letters, digits, dot, dash or underscore.">
                {(p) => <Input {...p} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />}
              </Field>
            )}
            <Field label="Role" required hint="Roles decide what the user may do. Edit them under Roles & permissions.">
              {(p) => (
                <Select {...p} value={roleId} onChange={(e) => setRoleId(Number(e.target.value))}>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {mode.kind === 'edit' && (
              <Switch label="Account active" description="Inactive users cannot sign in. Their history is kept." checked={isActive} onChange={setIsActive} />
            )}
          </>
        )}
        {mode.kind !== 'edit' && (
          <Field label={mode.kind === 'reset' ? 'New PIN or password' : 'PIN or password'} required hint="A PIN of 4+ digits, or a password of 6+ characters.">
            {(p) => <Input {...p} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" />}
          </Field>
        )}
        {mode.kind !== 'create' && (
          <Field label="Reason (optional)" hint="Saved in the history.">
            {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}
          </Field>
        )}
      </div>
    </Dialog>
  );
}
