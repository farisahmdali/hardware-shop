import { Activity, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import type { IntegrityIssue } from '@shared/contracts';
import { formatDateTime } from '@shared/time';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Card, CardHeader, EmptyState } from '../../components/ui/layout';

/** What each check confirms, in the order they are shown. */
const CHECKS: Record<string, string> = {
  'sqlite-integrity': 'The database file is undamaged',
  'sqlite-quick-check': 'The database file is undamaged (quick check)',
  'foreign-keys': 'Every record refers to records that exist',
  schema: 'The data is at the version this application expects',
  'immutability-triggers': 'Finalised records and the history are protected from changes',
  'audit-trail': 'Every bill, payment, stock movement and other document has its history entry',
  'ledger-trail': 'Every document that moves money or stock value has its accounting entries',
  'ledger-balanced': 'Every accounting entry balances (debits equal credits)',
  'stock-balances': 'Stock on hand matches the stock movements',
  'stock-chain': 'Each product’s stock movements follow on from one another',
  'inventory-ledger': 'Stock value matches the inventory account',
  'invoice-totals': 'Bill totals match their lines',
  allocations: 'No customer payment is used for more than its amount',
  'customer-balances': 'Customer balances match their bills, payments and credit',
  'rental-assets': 'No rental unit is double-booked, and unit status matches the rentals',
  'deposit-ledger': 'Deposits held match the deposit account',
  'purchase-totals': 'Purchase totals match their lines',
  'supplier-allocations': 'No supplier payment is used for more than its amount',
  'supplier-balances': 'Supplier balances match their bills, payments and returns',
  'input-gst': 'Input GST matches the purchase bills and returns',
  'expense-ledger': 'Expenses match the expense account',
  settings: 'Settings are valid',
};
const ORDER = Object.keys(CHECKS);

function CheckList({ checksRun, issues }: { checksRun: string[]; issues: IntegrityIssue[] }) {
  const byCheck = (name: string) => issues.filter((i) => i.check === name);
  const sorted = [...checksRun].sort((a, b) => {
    const failed = Number(byCheck(b).length > 0) - Number(byCheck(a).length > 0);
    return failed || ORDER.indexOf(a) - ORDER.indexOf(b);
  });
  return (
    <ul className="mb-4 divide-y divide-line rounded-lg border border-line">
      {sorted.map((name) => {
        const found = byCheck(name);
        const worst = found.some((i) => i.severity === 'error') ? 'error' : found.length ? 'warning' : null;
        return (
          <li key={name} className="flex gap-2.5 px-3.5 py-2.5">
            {worst === 'error' ? (
              <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-label="Problem" />
            ) : worst === 'warning' ? (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Warning" />
            ) : (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label="Passed" />
            )}
            <div className="min-w-0">
              <p className={worst ? 'font-medium text-ink' : 'text-ink-2'}>{CHECKS[name] ?? name}</p>
              {found.map((i, n) => (
                <p key={n} className="text-[13px] text-ink-2">
                  {i.message}
                </p>
              ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

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
          <CheckList checksRun={report.checksRun} issues={report.issues} />
          {report.issues.length > 0 && (
            <p className="mb-3 text-[13px] text-ink-2">
              The check changes nothing. Make a backup now and keep it before correcting anything.
            </p>
          )}
          <p className="text-[13px] text-ink-3">
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
  const seed = useCommandMutation('dev.seedSampleData', { invalidate: ['products.', 'stock.', 'catalog.', 'rentals.', 'rentalProducts.', 'rentalAssets.'] });
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
