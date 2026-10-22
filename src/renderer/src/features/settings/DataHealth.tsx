import { Activity, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { formatDateTime } from '@shared/time';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Card, CardHeader, EmptyState } from '../../components/ui/layout';

export function DataHealth() {
  const check = useCommandMutation('integrity.run');
  const toast = useToast();
  const report = check.data;

  const run = async () => {
    try {
      await check.mutateAsync({});
    } catch (e) {
      toast.error('The check could not run', errorMessage(e));
    }
  };

  return (
    <>
    <Card>
      <CardHeader
        title="Data health"
        description="Checks the database file, linked records, protection of history and settings."
        actions={
          <Button icon={<Activity className="size-4" />} busy={check.isPending} onClick={run}>
            Run full check
          </Button>
        }
      />
      {!report ? (
        <EmptyState
          icon={Activity}
          title="No check run in this session"
          description="A quick check runs automatically every time the application starts. Run a full check after a power cut or before restoring a backup."
        />
      ) : (
        <div className="p-5">
          <div className="mb-4 flex items-center gap-2">
            {report.issues.length === 0 ? (
              <>
                <CheckCircle2 className="size-5 text-success" />
                <p className="font-semibold text-ink">No problems found</p>
              </>
            ) : (
              <>
                <XCircle className="size-5 text-danger" />
                <p className="font-semibold text-ink">{report.issues.length} problem(s) found</p>
              </>
            )}
            <span className="text-ink-3">
              · {formatDateTime(report.ranAt)} · {report.durationMs} ms
            </span>
          </div>
          {report.issues.length > 0 && (
            <ul className="mb-4 flex flex-col gap-2">
              {report.issues.map((i, n) => (
                <li key={n} className="flex gap-2 rounded-md border border-line px-3 py-2">
                  {i.severity === 'error' ? (
                    <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
                  ) : (
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                  )}
                  <span>{i.message}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[13px] text-ink-3">Checks run: {report.checksRun.join(', ')}</p>
          <p className="mt-3 text-[13px] text-ink-3">
            The history is protected against changes made through this application. A person with direct access to the
            database file could still alter it, so keep the computer and backups secure.
          </p>
        </div>
      )}
    </Card>
    <DevSampleData />
    </>
  );
}

/** Development builds only: fill an empty catalogue with sample products for trying the screens. */
function DevSampleData() {
  const status = useCommandQuery('app.status');
  const can = useCan();
  const toast = useToast();
  const seed = useCommandMutation('dev.seedSampleData', { invalidate: ['products.', 'stock.', 'catalog.'] });
  if (!status.data || status.data.isPackaged || !can('users.manage')) return null;
  return (
    <Card className="mt-5 border-dashed">
      <CardHeader
        title="Development sample data"
        description="Not available in the installed application. Adds 30 sample products with opening stock and 6 rental items with 10 units to an empty catalogue."
        actions={
          <Button
            variant="outline"
            busy={seed.isPending}
            onClick={async () => {
              try {
                const r = await seed.mutateAsync({});
                toast.success(`Added ${r.products} sample products`);
              } catch (e) {
                toast.error('Could not add sample data', errorMessage(e));
              }
            }}
          >
            Add sample products
          </Button>
        }
      />
    </Card>
  );
}
