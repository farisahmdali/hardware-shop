import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Ban, CalendarPlus, CheckCircle2, Eye, HandCoins, PackageCheck, PlayCircle, Printer } from 'lucide-react';
import { formatMoney } from '@shared/money';
import { formatDateTime } from '@shared/time';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/dialog';
import { Badge, Card, CardHeader, ErrorBanner, Spinner } from '../../components/ui/layout';
import { Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { cn } from '../../lib/cn';
import { EntityHistory } from '../history/EntityHistory';
import { pretty } from '../history/labels';
import { DocumentPreview, useDocumentActions } from '../sales/DocumentPreview';
import { ExtendDialog, IssueReservedDialog, ReturnDialog, SettleDepositDialog } from './RentalDialogs';
import { lateText, RentalStatusBadge } from './shared';

type DialogKind = 'extend' | 'return' | 'deposit' | 'issue' | 'cancel' | 'close' | 'preview' | null;

export function RentalDetailPage() {
  const id = Number(useParams().id);
  const can = useCan();
  const toast = useToast();
  const query = useCommandQuery('rentals.get', { id });
  const actions = useDocumentActions();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const cancel = useCommandMutation('rentals.cancelReservation', { invalidate: ['rentals.', 'rentalAssets.'] });
  const close = useCommandMutation('rentals.close', { invalidate: ['rentals.', 'customers.'] });

  if (query.isPending) return <Spinner />;
  if (query.isError) return <ErrorBanner message={query.error.message} />;
  const r = query.data;
  const isOut = r.status === 'ACTIVE' || r.status === 'PARTIALLY_RETURNED';
  const doc = { kind: 'RENTAL_AGREEMENT' as const, id: r.id, paper: 'A4' as const, title: `Rental agreement ${r.rentalNo}` };

  return (
    <>
      <Link to="/rentals" className="mb-3 inline-flex items-center gap-1 text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Rentals
      </Link>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-mono text-[22px] font-semibold text-ink">{r.rentalNo}</h1>
            <RentalStatusBadge status={r.status} overdue={r.overdue} />
          </div>
          <p className="text-ink-2">
            <Link to={`/customers/${r.customerId}`} className="text-brand hover:underline">
              {r.customerName}
            </Link>
            {r.customerPhone && ` · ${r.customerPhone}`} · created {formatDateTime(r.createdAt)} by {r.createdBy ?? 'system'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {r.status === 'RESERVED' && can('rentals.issue') && (
            <Button icon={<PlayCircle className="size-4" />} onClick={() => setDialog('issue')}>
              Hand over now
            </Button>
          )}
          {isOut && can('rentals.return') && (
            <Button icon={<PackageCheck className="size-4" />} onClick={() => setDialog('return')}>
              Return items
            </Button>
          )}
          {isOut && can('rentals.issue') && (
            <Button variant="outline" icon={<CalendarPlus className="size-4" />} onClick={() => setDialog('extend')}>
              Extend
            </Button>
          )}
          {r.deposit.held > 0 && r.status !== 'RESERVED' && can('rentals.return') && (
            <Button variant={r.status === 'RETURNED' ? 'primary' : 'outline'} icon={<HandCoins className="size-4" />} onClick={() => setDialog('deposit')}>
              Settle deposit
            </Button>
          )}
          {r.status === 'RETURNED' && can('rentals.return') && (
            <Button variant={r.deposit.held > 0 ? 'outline' : 'primary'} icon={<CheckCircle2 className="size-4" />} onClick={() => setDialog('close')}>
              Close rental
            </Button>
          )}
          <Button variant="ghost" icon={<Printer className="size-4" />} busy={actions.busy === 'print'} onClick={() => actions.print(doc)}>
            Print agreement
          </Button>
          <Button variant="ghost" icon={<Eye className="size-4" />} onClick={() => setDialog('preview')}>
            Preview
          </Button>
          {r.status === 'RESERVED' && can('rentals.issue') && (
            <Button variant="ghost" icon={<Ban className="size-4" />} onClick={() => setDialog('cancel')}>
              Cancel reservation
            </Button>
          )}
        </div>
      </header>

      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile
          label={r.status === 'RESERVED' ? 'Starts' : 'Due back'}
          value={formatDateTime(r.status === 'RESERVED' ? r.startAt : r.expectedReturnAt)}
          sub={r.overdue ? lateText(r.overdueMinutes) : r.originalExpectedReturnAt !== r.expectedReturnAt ? `Originally ${formatDateTime(r.originalExpectedReturnAt)}` : `From ${formatDateTime(r.startAt)}`}
          tone={r.overdue ? 'danger' : undefined}
        />
        <Tile label="Units out" value={`${r.outCount} of ${r.itemCount}`} sub={r.linkedInvoice ? `Products sold on ${r.linkedInvoice.invoiceNo}` : 'Equipment on this agreement'} />
        <Tile label="Deposit held" value={formatMoney(r.deposit.held)} sub={`Collected ${formatMoney(r.deposit.collected)} · used ${formatMoney(r.deposit.applied)} · refunded ${formatMoney(r.deposit.refunded)}`} tone={r.deposit.held > 0 && r.status === 'RETURNED' ? 'warning' : undefined} />
        <Tile label="Unpaid charges" value={formatMoney(r.outstanding)} sub={`${r.invoices.length} rental bill${r.invoices.length === 1 ? '' : 's'}`} tone={r.outstanding > 0 ? 'warning' : undefined} />
      </div>

      <Card className="mb-5">
        <CardHeader title="Equipment" />
        <Table>
          <THead>
            <tr>
              <Th>Unit</Th>
              <Th>Item</Th>
              <Th>Status</Th>
              <Th>Out</Th>
              <Th>Back</Th>
              <Th align="right">Deposit</Th>
            </tr>
          </THead>
          <tbody>
            {r.items.map((i) => (
              <Tr key={i.id}>
                <Td className="font-mono font-semibold">{i.assetTag}</Td>
                <Td>
                  {i.productName}
                  {i.serialNo && <span className="block text-[12px] text-ink-3">Serial {i.serialNo}</span>}
                </Td>
                <Td>
                  <Badge tone={i.status === 'OUT' ? (r.overdue ? 'danger' : 'info') : i.status === 'RETURNED' ? 'success' : 'neutral'}>
                    {i.status === 'OUT' ? 'With customer' : pretty(i.status)}
                  </Badge>
                </Td>
                <Td className="text-[13px]">
                  {i.issuedAt ? formatDateTime(i.issuedAt) : '—'}
                  {i.conditionAtIssue && <span className="block text-ink-3">{i.conditionAtIssue.toLowerCase()}</span>}
                </Td>
                <Td className="text-[13px]">
                  {i.returnedAt ? formatDateTime(i.returnedAt) : '—'}
                  {i.returnCondition && <span className={cn('block', i.returnCondition === 'DAMAGED' ? 'text-danger' : 'text-ink-3')}>{i.returnCondition.toLowerCase()}{i.returnNotes && ` · ${i.returnNotes}`}</span>}
                </Td>
                <Td align="right">{formatMoney(i.depositAmount)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Tabs defaultValue="charges">
        <TabsList className="mb-4">
          <TabsTrigger value="charges">Charges ({r.charges.length})</TabsTrigger>
          <TabsTrigger value="deposit">Deposit ({r.deposit.transactions.length})</TabsTrigger>
          <TabsTrigger value="extensions">Extensions ({r.extensions.length})</TabsTrigger>
          {can('audit.view') && <TabsTrigger value="history">History</TabsTrigger>}
        </TabsList>
        <TabsContent value="charges">
          <Card>
            {r.charges.length === 0 ? (
              <p className="p-5 text-ink-3">{r.status === 'RESERVED' ? 'Charged when handed over.' : 'No charges yet.'}</p>
            ) : (
              <Table>
                <THead>
                  <tr>
                    <Th>Charge</Th>
                    <Th>How it was worked out</Th>
                    <Th align="right">Amount</Th>
                    <Th>Bill</Th>
                  </tr>
                </THead>
                <tbody>
                  {r.charges.map((c) => (
                    <Tr key={c.id}>
                      <Td>
                        <Badge tone={c.type === 'LATE_FEE' ? 'warning' : c.type === 'DAMAGE' ? 'danger' : 'neutral'}>{pretty(c.type)}</Badge>
                        <span className="block text-[13px]">{c.description}</span>
                      </Td>
                      <Td className="max-w-md text-[13px] text-ink-2">{c.explanation}</Td>
                      <Td align="right" className="font-medium">
                        {formatMoney(c.amount)}
                      </Td>
                      <Td>
                        {c.invoiceId ? (
                          <Link to={`/sales/invoices/${c.invoiceId}`} className="font-mono text-[13px] text-brand hover:underline">
                            {c.invoiceNo}
                          </Link>
                        ) : (
                          <span className="text-ink-3">not billed</span>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="deposit">
          <Card>
            {r.deposit.transactions.length === 0 ? (
              <p className="p-5 text-ink-3">No deposit taken.</p>
            ) : (
              <Table>
                <THead>
                  <tr>
                    <Th>When</Th>
                    <Th>What</Th>
                    <Th>Details</Th>
                    <Th align="right">Amount</Th>
                  </tr>
                </THead>
                <tbody>
                  {r.deposit.transactions.map((d) => (
                    <Tr key={d.id}>
                      <Td className="tabular whitespace-nowrap">
                        {formatDateTime(d.createdAt)} <span className="text-ink-3">· {d.username}</span>
                      </Td>
                      <Td>{d.type === 'COLLECT' ? 'Collected' : d.type === 'APPLY' ? 'Used for charges' : 'Refunded'}</Td>
                      <Td className="text-ink-2">{[d.methodName, d.reason].filter(Boolean).join(' · ')}</Td>
                      <Td align="right">{formatMoney(d.amount)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="extensions">
          <Card>
            {r.extensions.length === 0 ? (
              <p className="p-5 text-ink-3">Not extended.</p>
            ) : (
              <Table>
                <THead>
                  <tr>
                    <Th>When</Th>
                    <Th>Was due</Th>
                    <Th>Now due</Th>
                    <Th>Reason</Th>
                    <Th>Bill</Th>
                  </tr>
                </THead>
                <tbody>
                  {r.extensions.map((e) => (
                    <Tr key={e.id}>
                      <Td className="tabular">
                        {formatDateTime(e.createdAt)} <span className="text-ink-3">· {e.username}</span>
                      </Td>
                      <Td className="tabular">{formatDateTime(e.previousExpected)}</Td>
                      <Td className="tabular">{formatDateTime(e.newExpected)}</Td>
                      <Td>{e.reason}</Td>
                      <Td className="font-mono text-[13px]">{e.invoiceNo ?? '—'}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </TabsContent>
        {can('audit.view') && (
          <TabsContent value="history">
            <Card>
              <EntityHistory entityType="rental" entityId={r.id} />
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {dialog === 'extend' && <ExtendDialog rental={r} onClose={() => setDialog(null)} />}
      {dialog === 'return' && <ReturnDialog rental={r} onClose={() => setDialog(null)} />}
      {dialog === 'deposit' && <SettleDepositDialog rental={r} onClose={() => setDialog(null)} />}
      {dialog === 'issue' && <IssueReservedDialog rental={r} onClose={() => setDialog(null)} />}
      {dialog === 'preview' && <DocumentPreview doc={doc} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={dialog === 'cancel'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Cancel reservation ${r.rentalNo}?`}
        description="The units become free for these dates. The reservation stays in the records as cancelled."
        confirmLabel="Cancel reservation"
        tone="danger"
        requireReason
        busy={cancel.isPending}
        onConfirm={async (reason) => {
          try {
            await cancel.mutateAsync({ id: r.id, version: r.version, reason });
            setDialog(null);
          } catch (e) {
            toast.error('Not cancelled', errorMessage(e));
          }
        }}
      />
      <ConfirmDialog
        open={dialog === 'close'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Close ${r.rentalNo}?`}
        description={
          r.outstanding > 0
            ? `${formatMoney(r.outstanding)} of rental charges is unpaid. Closing keeps it on ${r.customerName}'s account to collect later.`
            : 'Everything is returned and settled. A closed rental cannot be changed.'
        }
        confirmLabel="Close rental"
        busy={close.isPending}
        onConfirm={async () => {
          try {
            await close.mutateAsync({ id: r.id, version: r.version, note: '', acceptOutstanding: r.outstanding > 0 });
            toast.success(`${r.rentalNo} closed`);
            setDialog(null);
          } catch (e) {
            toast.error('Not closed', errorMessage(e));
          }
        }}
      />
    </>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'danger' | 'warning' }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3 shadow-card">
      <p className="text-[12px] font-medium tracking-wide text-ink-3 uppercase">{label}</p>
      <p className={cn('tabular mt-1 text-lg font-semibold', tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-ink')}>{value}</p>
      <p className="text-[12px] text-ink-3">{sub}</p>
    </div>
  );
}
