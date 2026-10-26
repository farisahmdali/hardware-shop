import { useState } from 'react';
import { AlertTriangle, CheckCircle2, History, Loader2, RotateCcw, XCircle } from 'lucide-react';
import type { BackupValidation, RestoreSummary } from '@shared/contracts';
import { formatDateTime } from '@shared/time';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input } from '../../components/ui/form';
import { KeyValue } from '../../components/ui/layout';

export const formatBytes = (n: number | null) =>
  n === null ? '' : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

const COUNT_LABELS: Record<string, string> = {
  products: 'Products',
  customers: 'Customers',
  invoices: 'Bills',
  payments: 'Payments',
  rental_agreements: 'Rentals',
  purchases: 'Purchases',
  expenses: 'Expenses',
  stock_movements: 'Stock movements',
  ledger_entries: 'Accounting entries',
  audit_log: 'History entries',
  users: 'Users',
};

/** A backup chosen for restoring, after the main process has checked it. */
export interface RestoreCandidate {
  token: string;
  validation: BackupValidation;
}

export function ValidationDetails({ validation }: { validation: BackupValidation }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        {validation.valid ? <CheckCircle2 className="size-5 shrink-0 text-success" /> : <XCircle className="size-5 shrink-0 text-danger" />}
        <span className="font-mono text-[12px] break-all">{validation.filePath}</span>
      </div>
      {validation.problems.length > 0 && (
        <ul className="list-disc pl-5 text-danger">
          {validation.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <KeyValue
        items={[
          { label: 'Shop', value: validation.shopName ?? '—' },
          { label: 'Taken', value: validation.createdAt ? formatDateTime(validation.createdAt) : 'Unknown (no manifest)' },
          { label: 'Data version', value: validation.schemaVersion ?? '—' },
          { label: 'Size', value: formatBytes(validation.sizeBytes) },
        ]}
      />
      {Object.keys(validation.counts).length > 0 && (
        <dl className="grid grid-cols-3 gap-x-5 gap-y-1.5 rounded-lg bg-surface-2 px-4 py-3 text-[13px]">
          {Object.keys(COUNT_LABELS)
            .filter((k) => k in validation.counts)
            .map((k) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className="text-ink-3">{COUNT_LABELS[k]}</dt>
                <dd className="tabular text-ink">{validation.counts[k]!.toLocaleString('en-IN')}</dd>
              </div>
            ))}
        </dl>
      )}
    </div>
  );
}

/**
 * Confirms and runs a restore: replacing the shop's data ('replace'), or setting up a new
 * installation from a backup ('setup'). The main process reloads the window once the restored data
 * is in place.
 */
export function RestoreDialog({ candidate, mode = 'replace', onClose }: { candidate: RestoreCandidate; mode?: 'replace' | 'setup'; onClose(): void }) {
  const toast = useToast();
  const status = useCommandQuery('app.status');
  const restore = useCommandMutation(mode === 'setup' ? 'setup.restore' : 'backup.restore');
  const [typed, setTyped] = useState('');
  const [done, setDone] = useState<RestoreSummary | null>(null);
  const { validation } = candidate;
  const older = status.data && validation.schemaVersion !== null && validation.schemaVersion < status.data.schemaVersion;

  const confirm = async () => {
    try {
      setDone(await restore.mutateAsync({ token: candidate.token, confirm: 'RESTORE' }));
    } catch (e) {
      toast.error('Nothing was restored', errorMessage(e));
      onClose();
    }
  };

  if (done) {
    return (
      <Dialog open onOpenChange={() => undefined} title="Backup restored" size="sm">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 font-medium text-ink">
            <CheckCircle2 className="size-5 text-success" /> The shop data now matches the backup.
          </div>
          {mode === 'replace' && (
            <p className="text-ink-2">
              The data as it was before the restore is saved as <span className="font-mono text-[12px] break-all">{done.preRestoreBackup}</span>.
            </p>
          )}
          {done.issues.length > 0 && (
            <p className="text-warning">The data check found {done.issues.length} problem(s). See Data health after signing in.</p>
          )}
          <p className="flex items-center gap-2 text-ink-3">
            <Loader2 className="size-4 animate-spin" />
            {mode === 'setup' ? 'Reloading. Sign in with your usual name and PIN.' : 'Reloading. Please sign in again.'}
          </p>
        </div>
      </Dialog>
    );
  }

  if (!validation.valid) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()} title="This backup cannot be restored" footer={<Button onClick={onClose}>Close</Button>}>
        <ValidationDetails validation={validation} />
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !restore.isPending && onClose()}
      title={mode === 'setup' ? 'Set up the shop from this backup?' : 'Restore this backup?'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={restore.isPending}>
            Cancel
          </Button>
          <Button variant={mode === 'setup' ? 'primary' : 'danger'} icon={<RotateCcw className="size-4" />} busy={restore.isPending} disabled={typed.trim() !== 'RESTORE'} onClick={confirm}>
            Restore
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {mode === 'setup' ? (
          <p className="text-ink-2">
            The shop's records, history, settings and user accounts are taken from this backup
            {validation.createdAt ? <> made on <strong>{formatDateTime(validation.createdAt)}</strong></> : null}. Anything recorded after it
            is not in the backup. Afterwards, sign in with a name and PIN from the backup.
          </p>
        ) : (
          <div className="flex gap-2.5 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-ink">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="flex flex-col gap-1">
              <p>
                All shop data will be replaced by this backup
                {validation.createdAt ? <> taken on <strong>{formatDateTime(validation.createdAt)}</strong></> : null}. Bills, payments,
                stock changes, rentals and history recorded after it will no longer appear.
              </p>
              <p className="text-ink-2">
                A verified copy of the current data is saved first, so you can go back to it by restoring that copy. Everyone will need to
                sign in again.
              </p>
            </div>
          </div>
        )}
        <ValidationDetails validation={validation} />
        {older && (
          <p className="flex items-center gap-2 text-ink-2">
            <History className="size-4 text-ink-3" /> This backup is from an older version; it will be upgraded after restoring.
          </p>
        )}
        <Field label="Type RESTORE to confirm" required>
          {(p) => <Input {...p} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" disabled={restore.isPending} />}
        </Field>
      </div>
    </Dialog>
  );
}
