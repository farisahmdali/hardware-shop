import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, HandCoins, Pencil, Power, ReceiptIndianRupee, Scale, Undo2, Wallet } from 'lucide-react';
import { formatMoney } from '@shared/money';
import { formatDate } from '@shared/time';
import { stateName } from '@shared/gstStates';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/dialog';
import { Badge, Card, CardHeader, ErrorBanner, KeyValue, Spinner } from '../../components/ui/layout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { newRequestId } from '../../components/ui/numberInputs';
import { cn } from '../../lib/cn';
import { EntityHistory } from '../history/EntityHistory';
import { InvoicesTable } from '../sales/InvoicesTable';
import { PaymentsTable } from '../payments/PaymentsTable';
import { ReceivablesTable } from '../payments/ReceivablesTable';
import { ReceivePaymentDialog } from '../payments/ReceivePaymentDialog';
import { cart } from '../sales/cartStore';
import { CustomerFormDialog } from './CustomerFormDialog';
import { AdjustBalanceDialog, RefundDialog } from './CustomerDialogs';
import { CustomerLedgerView } from './CustomerLedgerView';

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warning' | 'danger' | 'success' }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3 shadow-card">
      <p className="text-[12px] font-medium tracking-wide text-ink-3 uppercase">{label}</p>
      <p className={cn('tabular mt-1 text-xl font-semibold', tone === 'warning' && 'text-warning', tone === 'danger' && 'text-danger', tone === 'success' && 'text-success', !tone && 'text-ink')}>
        {value}
      </p>
      {sub && <p className="text-[12px] text-ink-3">{sub}</p>}
    </div>
  );
}

export function CustomerDetailPage() {
  const id = Number(useParams().id);
  const can = useCan();
  const toast = useToast();
  const navigate = useNavigate();
  const query = useCommandQuery('customers.get', { id });
  const [dialog, setDialog] = useState<'edit' | 'pay' | 'refund' | 'adjust' | 'active' | null>(null);
  const setActive = useCommandMutation('customers.setActive', { invalidate: ['customers.'] });
  const applyCredit = useCommandMutation('payments.applyCredit', { invalidate: ['customers.', 'invoices.', 'receivables.', 'payments.'] });

  if (query.isPending) return <Spinner />;
  if (query.isError) return <ErrorBanner message={query.error.message} />;
  const c = query.data;

  const startBill = () => {
    cart.reset();
    cart.setCustomer({
      id: c.id,
      name: c.name,
      phone: c.phone,
      stateCode: c.stateCode,
      isWalkin: false,
      balance: c.balance,
      availableCredit: c.availableCredit,
      creditLimit: c.creditLimit,
    });
    navigate('/sales');
  };

  return (
    <>
      <Link to="/customers" className="mb-3 inline-flex items-center gap-1 text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Customers
      </Link>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-display text-[22px] font-semibold text-ink">{c.name}</h1>
            {!c.isActive && <Badge>Inactive</Badge>}
          </div>
          <p className="text-ink-2">
            <span className="font-mono">{c.code}</span>
            {c.businessName && ` · ${c.businessName}`}
            {c.phone && ` · ${c.phone}`}
          </p>
        </div>
        {!c.isWalkin && (
          <div className="flex flex-wrap gap-2">
            {can('sales.create') && c.isActive && (
              <Button icon={<ReceiptIndianRupee className="size-4" />} onClick={startBill}>
                New bill
              </Button>
            )}
            {can('payments.receive') && (
              <Button variant="outline" icon={<Wallet className="size-4" />} onClick={() => setDialog('pay')}>
                Receive payment
              </Button>
            )}
            {can('customers.manage') && (
              <Button variant="outline" icon={<Pencil className="size-4" />} onClick={() => setDialog('edit')}>
                Edit
              </Button>
            )}
            {can('sales.return') && c.availableCredit > 0 && (
              <Button variant="ghost" icon={<Undo2 className="size-4" />} onClick={() => setDialog('refund')}>
                Refund credit
              </Button>
            )}
            {can('customers.adjustBalance') && (
              <Button variant="ghost" icon={<Scale className="size-4" />} onClick={() => setDialog('adjust')}>
                Adjust balance
              </Button>
            )}
            {can('customers.manage') && (
              <Button variant="ghost" icon={<Power className="size-4" />} onClick={() => setDialog('active')}>
                {c.isActive ? 'Deactivate' : 'Reactivate'}
              </Button>
            )}
          </div>
        )}
      </header>

      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile
          label="Balance"
          value={c.balance === 0 ? formatMoney(0) : formatMoney(Math.abs(c.balance))}
          sub={c.balance > 0 ? 'Customer owes the shop' : c.balance < 0 ? 'In the customer’s favour' : 'Nothing owed'}
          tone={c.balance > 0 ? 'warning' : c.balance < 0 ? 'success' : undefined}
        />
        <Tile label="Open bills" value={formatMoney(c.outstanding)} sub={`${c.invoiceCount} invoices in total`} />
        <Tile label="Overdue" value={formatMoney(c.overdue)} sub={`Credit period ${c.effectiveCreditDays} days`} tone={c.overdue > 0 ? 'danger' : undefined} />
        <Tile label="Available credit" value={formatMoney(c.availableCredit)} sub={c.creditLimit > 0 ? `Credit limit ${formatMoney(c.creditLimit)}` : 'No credit limit'} tone={c.availableCredit > 0 ? 'success' : undefined} />
      </div>
      {c.availableCredit > 0 && c.outstanding > 0 && can('payments.receive') && (
        <div className="mb-5 flex items-center justify-between gap-4 rounded-lg border border-info/30 bg-info-soft px-4 py-3">
          <p className="text-ink">
            {c.name} has {formatMoney(c.availableCredit)} of credit and {formatMoney(c.outstanding)} of open bills.
          </p>
          <Button
            size="sm"
            icon={<HandCoins className="size-4" />}
            busy={applyCredit.isPending}
            onClick={async () => {
              try {
                await applyCredit.mutateAsync({ customerId: c.id, requestId: newRequestId() });
                toast.success('Credit applied to the oldest bills');
              } catch (e) {
                toast.error('Could not apply credit', errorMessage(e));
              }
            }}
          >
            Use credit for open bills
          </Button>
        </div>
      )}

      <Tabs defaultValue="ledger">
        <TabsList className="mb-4">
          <TabsTrigger value="ledger">Account</TabsTrigger>
          <TabsTrigger value="open">Open bills</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
          {can('audit.view') && <TabsTrigger value="history">History</TabsTrigger>}
        </TabsList>
        <TabsContent value="ledger">
          <Card>
            <CustomerLedgerView customerId={c.id} customerName={c.name} />
          </Card>
        </TabsContent>
        <TabsContent value="open">
          <Card>
            <ReceivablesTable customerId={c.id} />
          </Card>
        </TabsContent>
        <TabsContent value="invoices">
          <Card>
            <InvoicesTable customerId={c.id} />
          </Card>
        </TabsContent>
        <TabsContent value="payments">
          <Card>
            <PaymentsTable customerId={c.id} />
          </Card>
        </TabsContent>
        <TabsContent value="details">
          <Card>
            <CardHeader title="Customer details" />
            <div className="p-5">
              <KeyValue
                items={[
                  { label: 'Customer code', value: <span className="font-mono">{c.code}</span> },
                  { label: 'Mobile', value: c.phone || '—' },
                  { label: 'Business name', value: c.businessName || '—' },
                  { label: 'GSTIN', value: c.gstin || '—' },
                  { label: 'State', value: c.stateCode ? `${stateName(c.stateCode)} (${c.stateCode})` : 'Same as the shop' },
                  { label: 'Address', value: c.address || '—' },
                  { label: 'Credit period', value: `${c.effectiveCreditDays} days${c.creditDays === null ? ' (shop default)' : ''}` },
                  { label: 'Credit limit', value: c.creditLimit ? formatMoney(c.creditLimit) : 'None' },
                  { label: 'Notes', value: c.notes || '—' },
                  { label: 'Last invoice', value: c.lastInvoiceDate ? formatDate(c.lastInvoiceDate) : '—' },
                  { label: 'Added', value: formatDate(c.createdAt) },
                ]}
              />
            </div>
          </Card>
        </TabsContent>
        {can('audit.view') && (
          <TabsContent value="history">
            <Card>
              <EntityHistory entityType="customer" entityId={c.id} />
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {dialog === 'edit' && <CustomerFormDialog customer={c} onClose={() => setDialog(null)} onSaved={() => setDialog(null)} />}
      {dialog === 'pay' && <ReceivePaymentDialog customerId={c.id} customerName={c.name} onClose={() => setDialog(null)} />}
      {dialog === 'refund' && <RefundDialog customer={c} onClose={() => setDialog(null)} />}
      {dialog === 'adjust' && <AdjustBalanceDialog customer={c} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={dialog === 'active'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={c.isActive ? `Deactivate ${c.name}?` : `Reactivate ${c.name}?`}
        description={c.isActive ? 'They will not appear when choosing a customer for new bills. Their history and balance are kept.' : 'They will appear again when choosing a customer.'}
        confirmLabel={c.isActive ? 'Deactivate' : 'Reactivate'}
        tone={c.isActive ? 'danger' : 'primary'}
        requireReason
        busy={setActive.isPending}
        onConfirm={async (reason) => {
          try {
            await setActive.mutateAsync({ id: c.id, version: c.version, isActive: !c.isActive, reason });
            setDialog(null);
          } catch (e) {
            toast.error('Not saved', errorMessage(e));
          }
        }}
      />
    </>
  );
}

