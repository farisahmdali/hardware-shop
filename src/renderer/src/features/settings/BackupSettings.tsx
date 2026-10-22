import { useState } from 'react';
import { AlertTriangle, CheckCircle2, DatabaseBackup, FileSearch, FolderOpen, FolderCog, HardDriveUpload, XCircle } from 'lucide-react';
import type { BackupValidation } from '@shared/contracts';
import { formatDateTime } from '@shared/time';
import { call, errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Badge, Card, CardHeader, EmptyState, ErrorBanner, KeyValue, Spinner } from '../../components/ui/layout';
import { Table, Td, Th, THead, Tr } from '../../components/ui/table';

const formatBytes = (n: number | null) =>
  n === null ? '' : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

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
              </tr>
            </THead>
            <tbody>
              {history.data.map((b) => (
                <Tr key={b.id}>
                  <Td className="tabular whitespace-nowrap">{formatDateTime(b.createdAt)}</Td>
                  <Td>{kindLabel[b.kind]}</Td>
                  <Td className="font-mono text-[12px] break-all" title={b.filePath}>
                    {b.fileName}
                  </Td>
                  <Td align="right">{formatBytes(b.sizeBytes)}</Td>
                  <Td>{b.username ?? 'system'}</Td>
                  <Td>
                    {b.status === 'FAILED' ? (
                      <Badge tone="danger" >Failed</Badge>
                    ) : b.fileExists ? (
                      <Badge tone="success">Verified</Badge>
                    ) : (
                      <Badge tone="warning">File missing</Badge>
                    )}
                    {b.message && <p className="mt-1 text-[12px] text-ink-3">{b.message}</p>}
                  </Td>
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
        {validation && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              {validation.valid ? (
                <CheckCircle2 className="size-5 text-success" />
              ) : (
                <XCircle className="size-5 text-danger" />
              )}
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
                { label: 'Created', value: validation.createdAt ? formatDateTime(validation.createdAt) : 'Unknown (no manifest)' },
                { label: 'Schema version', value: validation.schemaVersion ?? '—' },
                { label: 'Size', value: formatBytes(validation.sizeBytes) },
                ...Object.entries(validation.counts).map(([k, v]) => ({
                  label: k.replace(/_/g, ' '),
                  value: v.toLocaleString('en-IN'),
                })),
              ]}
            />
            {validation.valid && (
              <p className="text-ink-3">Restoring from a backup becomes available in a later update of this application.</p>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}
