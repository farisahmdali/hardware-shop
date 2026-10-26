import { useEffect, useState } from 'react';
import { AlertTriangle, DatabaseBackup, FileSearch, FolderOpen, FolderCog, HardDriveUpload, RotateCcw } from 'lucide-react';
import type { BackupValidation } from '@shared/contracts';
import type { AllSettings } from '@shared/settings';
import { formatDateTime } from '@shared/time';
import { call, errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select, Switch } from '../../components/ui/form';
import { Badge, Card, CardHeader, EmptyState, ErrorBanner, KeyValue, Spinner } from '../../components/ui/layout';
import { Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { formatBytes, RestoreDialog, ValidationDetails, type RestoreCandidate } from './RestoreDialog';

const kindLabel = { MANUAL: 'Manual', AUTO: 'Automatic', PRE_RESTORE: 'Before restore', PRE_MIGRATION: 'Before upgrade' } as const;

export function BackupSettings() {
  const can = useCan();
  const toast = useToast();
  const info = useCommandQuery('backup.info');
  const history = useCommandQuery('backup.list');
  const create = useCommandMutation('backup.create', { invalidate: ['backup.'] });
  const chooseFolder = useCommandMutation('backup.chooseFolder', { invalidate: ['backup.', 'settings.'] });
  const copy = useCommandMutation('backup.copyLatestTo', { invalidate: ['backup.'] });
  const [checking, setChecking] = useState(false);
  const [validation, setValidation] = useState<BackupValidation | null>(null);
  const [candidate, setCandidate] = useState<RestoreCandidate | null>(null);
  const [preparing, setPreparing] = useState<number | 'file' | null>(null);

  const run = async <T,>(fn: () => Promise<T>, success: (r: T) => string | null, failure: string) => {
    try {
      const result = await fn();
      const msg = success(result);
      if (msg) toast.success(msg);
    } catch (e) {
      toast.error(failure, errorMessage(e));
    }
  };

  const checkFile = async () => {
    setChecking(true);
    try {
      const result = await call('backup.validateFile');
      if (result) setValidation(result);
    } catch (e) {
      toast.error('Could not check the file', errorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  /** Asks the main process to check a backup (one from the history, or a file the user picks) before restoring it. */
  const prepareRestore = async (from: number | 'file') => {
    setPreparing(from);
    try {
      const result = from === 'file' ? await call('backup.restoreChoose') : await call('backup.restoreCheck', { id: from });
      if (result) setCandidate(result);
    } catch (e) {
      toast.error('Could not check the backup', errorMessage(e));
    } finally {
      setPreparing(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader
          title="Back up the shop data"
          description="A backup is a complete, verified copy of all records, history and settings."
        />
        <div className="flex flex-col gap-4 p-5">
          {info.data && (
            <KeyValue
              items={[
                {
                  label: 'Backup folder',
                  value: (
                    <span className="font-mono text-[13px]">
                      {info.data.folder}
                      {info.data.isDefaultFolder && <span className="ml-2 font-sans text-ink-3">(default)</span>}
                    </span>
                  ),
                },
                { label: 'Last backup', value: info.data.lastSuccessAt ? formatDateTime(info.data.lastSuccessAt) : 'None yet' },
                {
                  label: 'Next automatic backup',
                  value: info.data.nextAutoAt
                    ? new Date(info.data.nextAutoAt) <= new Date()
                      ? 'Within the next few minutes'
                      : formatDateTime(info.data.nextAutoAt)
                    : 'Automatic backups are off',
                },
              ]}
            />
          )}
          {info.data?.sameDriveAsData && (
            <div className="flex gap-2.5 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-ink">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <p>
                Backups are on the same drive as the shop data. They protect against mistakes, but not against a failed or stolen
                computer. Regularly use <strong>Copy latest backup to USB</strong> and keep the drive somewhere else.
              </p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              icon={<DatabaseBackup className="size-4" />}
              busy={create.isPending}
              onClick={() =>
                run(() => create.mutateAsync({}), (r) => `Backup created: ${r.fileName}`, 'Backup failed')
              }
            >
              Back up now
            </Button>
            <Button
              variant="outline"
              icon={<HardDriveUpload className="size-4" />}
              busy={copy.isPending}
              onClick={() =>
                run(() => copy.mutateAsync({}), (r) => (r ? `Copied to ${r.copiedTo}` : null), 'Copy failed')
              }
            >
              Copy latest backup to USB…
            </Button>
            {can('settings.manage') && (
              <Button
                variant="outline"
                icon={<FolderCog className="size-4" />}
                busy={chooseFolder.isPending}
                onClick={() => run(() => chooseFolder.mutateAsync({}), (r) => (r ? 'Backup folder changed' : null), 'Could not change the folder')}
              >
                Change folder…
              </Button>
            )}
            <Button
              variant="ghost"
              icon={<FolderOpen className="size-4" />}
              onClick={() => run(() => call('backup.openFolder'), () => null, 'Could not open the folder')}
            >
              Open folder
            </Button>
            <Button variant="ghost" icon={<FileSearch className="size-4" />} busy={checking} onClick={checkFile}>
              Check a backup file…
            </Button>
          </div>
        </div>
      </Card>

      {can('settings.manage') && <AutomaticBackups />}

      {can('backup.restore') && (
        <Card>
          <CardHeader
            title="Restore from a backup"
            description="Replaces all shop data with a backup. Use it after a computer failure or a serious mistake."
            actions={
              <Button variant="outline" icon={<RotateCcw className="size-4" />} busy={preparing === 'file'} onClick={() => prepareRestore('file')}>
                Restore from a file…
              </Button>
            }
          />
          <p className="px-5 pb-5 text-ink-2">
            The backup is checked first, and a copy of the current data is saved before anything is replaced, so a restore can
            itself be undone. To restore a backup listed below, use <strong>Restore…</strong> in its row.
          </p>
        </Card>
      )}

      <Card>
        <CardHeader title="Backup history" />
        {history.isPending ? (
          <Spinner />
        ) : history.isError ? (
          <div className="p-4">
            <ErrorBanner message={history.error.message} />
          </div>
        ) : history.data.length === 0 ? (
          <EmptyState icon={DatabaseBackup} title="No backups yet" description="Click “Back up now” to make the first one." />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>When</Th>
                <Th>Type</Th>
                <Th>File</Th>
                <Th align="right">Size</Th>
                <Th>By</Th>
                <Th>Status</Th>
                {can('backup.restore') && <Th />}
              </tr>
            </THead>
            <tbody>
              {history.data.map((b) => (
                <Tr key={b.id} className={b.removedAt ? 'text-ink-3' : undefined}>
                  <Td className="tabular whitespace-nowrap">{formatDateTime(b.createdAt)}</Td>
                  <Td>{kindLabel[b.kind]}</Td>
                  <Td className="font-mono text-[12px] break-all" title={b.filePath}>
                    {b.fileName}
                  </Td>
                  <Td align="right">{formatBytes(b.sizeBytes)}</Td>
                  <Td>{b.username ?? 'system'}</Td>
                  <Td>
                    {b.status === 'FAILED' ? (
                      <Badge tone="danger">Failed</Badge>
                    ) : b.removedAt ? (
                      <Badge>Removed</Badge>
                    ) : b.fileExists ? (
                      <Badge tone="success">Verified</Badge>
                    ) : (
                      <Badge tone="warning">File missing</Badge>
                    )}
                    {b.removedAt ? (
                      <p className="mt-1 text-[12px] text-ink-3">
                        {formatDateTime(b.removedAt)}: {b.removedReason}
                      </p>
                    ) : (
                      b.message && <p className="mt-1 text-[12px] text-ink-3">{b.message}</p>
                    )}
                  </Td>
                  {can('backup.restore') && (
                    <Td align="right">
                      {b.status === 'OK' && b.fileExists && !b.removedAt && (
                        <Button size="sm" variant="ghost" busy={preparing === b.id} disabled={preparing !== null} onClick={() => prepareRestore(b.id)}>
                          Restore…
                        </Button>
                      )}
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Dialog
        open={!!validation}
        onOpenChange={(o) => !o && setValidation(null)}
        title={validation?.valid ? 'This backup is valid' : 'This backup cannot be used'}
        footer={<Button onClick={() => setValidation(null)}>Close</Button>}
      >
        {validation && <ValidationDetails validation={validation} />}
      </Dialog>

      {candidate && <RestoreDialog candidate={candidate} onClose={() => setCandidate(null)} />}
    </div>
  );
}

const INTERVALS = [1, 2, 4, 6, 8, 12, 24];

function AutomaticBackups() {
  const settings = useCommandQuery('settings.get');
  const save = useCommandMutation('settings.update', { invalidate: ['settings.', 'backup.'] });
  const toast = useToast();
  const [b, setB] = useState<AllSettings['backup'] | null>(null);
  useEffect(() => {
    if (settings.data) setB(settings.data.backup);
  }, [settings.data]);
  if (!b) return null;
  const set = <K extends keyof AllSettings['backup']>(k: K, v: AllSettings['backup'][K]) => setB({ ...b, [k]: v });
  const whole = (v: string, min: number, max: number) => Math.max(min, Math.min(max, Math.trunc(Number(v) || min)));

  return (
    <Card>
      <CardHeader title="Automatic backups" description="Taken in the background while the application is open: at the first start of each day, then every few hours." />
      <div className="grid max-w-3xl grid-cols-3 gap-5 p-5">
        <div className="col-span-3">
          <Switch checked={b.autoEnabled} onChange={(v) => set('autoEnabled', v)} label="Back up automatically" />
        </div>
        <Field label="Back up every">
          {(p) => (
            <Select {...p} value={b.intervalHours} disabled={!b.autoEnabled} onChange={(e) => set('intervalHours', Number(e.target.value))}>
              {INTERVALS.map((h) => (
                <option key={h} value={h}>
                  {h === 1 ? '1 hour' : `${h} hours`}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Keep the latest" hint="Automatic backups (at least 3)">
          {(p) => <Input {...p} type="number" min={3} max={500} value={b.keepAutoCount} onChange={(e) => set('keepAutoCount', whole(e.target.value, 3, 500))} />}
        </Field>
        <Field label="And one a day for" hint="Days (at least 7)">
          {(p) => <Input {...p} type="number" min={7} max={3650} value={b.keepDailyDays} onChange={(e) => set('keepDailyDays', whole(e.target.value, 7, 3650))} />}
        </Field>
        <p className="col-span-3 text-[13px] text-ink-3">
          Older automatic backups are removed to save space; the history keeps a note of each. Manual backups, and those made before an
          upgrade or a restore, are never removed, nor is the newest backup that passed its check.
        </p>
        <div className="col-span-3">
          <Button
            busy={save.isPending}
            onClick={async () => {
              try {
                await save.mutateAsync({ section: 'backup', value: b });
                toast.success('Automatic backup settings saved');
              } catch (e) {
                toast.error('Not saved', errorMessage(e));
              }
            }}
          >
            Save backup settings
          </Button>
        </div>
      </div>
    </Card>
  );
}
