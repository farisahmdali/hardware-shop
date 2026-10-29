import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, HandCoins, PackagePlus, Pencil, Power, Scale, Undo2, Wallet } from 'lucide-react';
import { formatMoney } from '@shared/money';
import { formatDate } from '@shared/time';
import { stateName } from '@shared/gstStates';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useCan, useCanViewPurchasing } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/dialog';
import { Badge, Card, CardHeader, ErrorBanner, KeyValue, Spinner } from '../../components/ui/layout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { newRequestId } from '../../components/ui/numberInputs';
import { cn } from '../../lib/cn';
import { EntityHistory } from '../history/EntityHistory';
import { SupplierFormDialog } from './SupplierFormDialog';
import { AdjustSupplierBalanceDialog, PaySupplierDialog, SupplierRefundDialog } from './SupplierDialogs';
import { SupplierLedgerView } from './SupplierLedgerView';
import { PurchasesTable } from './PurchasesTable';
import { PayablesTable } from './PayablesTable';
import { SupplierPaymentsTable } from './SupplierPaymentsTable';
import { SUPPLIER_INVALIDATE } from './shared';
import { SupplierItemNames } from './SupplierItemNames';

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

export function SupplierDetailPage() {
  const id = Number(useParams().id);
  const can = useCan();
  const canView = useCanViewPurchasing();
  const toast = useToast();
  const navigate = useNavigate();
  const query = useCommandQuery('suppliers.get', { id });
  const [dialog, setDialog] = useState<'edit' | 'pay' | 'refund' | 'adjust' | 'active' | null>(null);
  const setActive = useCommandMutation('suppliers.setActive', { invalidate: ['suppliers.', 'catalog.'] });
  const applyCredit = useCommandMutation('supplierPayments.applyCredit', { invalidate: SUPPLIER_INVALIDATE });

  if (query.isPending) return <Spinner />;
  if (query.isError) return <ErrorBanner message={query.error.message} />;
  const s = query.data;

  return (
    <>
      <Link to="/suppliers?tab=suppliers" className="mb-3 inline-flex items-center gap-1 text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Suppliers
      </Link>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-display text-[22px] font-semibold text-ink">{s.name}</h1>
            {!s.isActive && <Badge>Inactive</Badge>}
          </div>
          <p className="text-ink-2">
            <span className="font-mono">{s.code}</span>
            {s.businessName && ` · ${s.businessName}`}
            {s.phone && ` · ${s.phone}`}
            {s.gstin ? ` · GSTIN ${s.gstin}` : ' · not GST registered'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {can('purchases.manage') && s.isActive && (
            <Button icon={<PackagePlus className="size-4" />} onClick={() => navigate(`/suppliers/purchases/new?supplier=${s.id}`)}>
              New purchase
            </Button>
          )}
          {can('suppliers.pay') && (
            <Button variant="outline" icon={<Wallet className="size-4" />} onClick={() => setDialog('pay')}>
              Pay
            </Button>
          )}
          {can('suppliers.manage') && (
            <Button variant="outline" icon={<Pencil className="size-4" />} onClick={() => setDialog('edit')}>
              Edit
            </Button>
          )}
          {can('suppliers.pay') && s.availableCredit > 0 && (
            <Button variant="ghost" icon={<Undo2 className="size-4" />} onClick={() => setDialog('refund')}>
              Refund received
            </Button>
          )}
          {can('suppliers.adjustBalance') && (
            <Button variant="ghost" icon={<Scale className="size-4" />} onClick={() => setDialog('adjust')}>
              Adjust balance
            </Button>
          )}
          {can('suppliers.manage') && (
            <Button variant="ghost" icon={<Power className="size-4" />} onClick={() => setDialog('active')}>
              {s.isActive ? 'Deactivate' : 'Reactivate'}
            </Button>
          )}
        </div>
      </header>

      {canView && (
        <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Tile
            label="Balance"
            value={formatMoney(Math.abs(s.balance))}
            sub={s.balance > 0 ? 'The shop owes this supplier' : s.balance < 0 ? 'Advance with the supplier' : 'Nothing owed'}
            tone={s.balance > 0 ? 'warning' : s.balance < 0 ? 'success' : undefined}
          />
          <Tile label="Open bills" value={formatMoney(s.outstanding)} sub={`${s.purchaseCount} purchase${s.purchaseCount === 1 ? '' : 's'} in total`} />
          <Tile label="Overdue" value={formatMoney(s.overdue)} sub={`Pays within ${s.effectiveCreditDays} days`} tone={s.overdue > 0 ? 'danger' : undefined} />
          <Tile label="Advance" value={formatMoney(s.availableCredit)} sub="Paid ahead or from returns, not yet used" tone={s.availableCredit > 0 ? 'success' : undefined} />
        </div>
      )}
      {canView && s.availableCredit > 0 && s.outstanding > 0 && can('suppliers.pay') && (
        <div className="mb-5 flex items-center justify-between gap-4 rounded-lg border border-info/30 bg-info-soft px-4 py-3">
          <p className="text-ink">
            {formatMoney(s.availableCredit)} is with {s.name} as an advance, and {formatMoney(s.outstanding)} of their bills are open.
          </p>
          <Button
            size="sm"
            icon={<HandCoins className="size-4" />}
            busy={applyCredit.isPending}
            onClick={async () => {
              try {
                await applyCredit.mutateAsync({ supplierId: s.id, requestId: newRequestId() });
                toast.success('Advance set against the oldest bills');
              } catch (e) {
                toast.error('Could not apply the advance', errorMessage(e));
              }
            }}
          >
            Use advance for open bills
          </Button>
        </div>
      )}

      <Tabs defaultValue={canView ? 'ledger' : 'details'}>
        <TabsList className="mb-4">
          {canView && <TabsTrigger value="ledger">Account</TabsTrigger>}
          {canView && <TabsTrigger value="open">Bills to pay</TabsTrigger>}
          {canView && <TabsTrigger value="purchases">Purchases</TabsTrigger>}
          {canView && <TabsTrigger value="payments">Payments</TabsTrigger>}
          {canView && <TabsTrigger value="itemNames">Item names</TabsTrigger>}
          <TabsTrigger value="details">Details</TabsTrigger>
          {can('audit.view') && <TabsTrigger value="history">History</TabsTrigger>}
        </TabsList>
        {canView && (
          <>
            <TabsContent value="ledger">
              <Card>
                <SupplierLedgerView supplierId={s.id} supplierName={s.name} />
              </Card>
            </TabsContent>
            <TabsContent value="open">
              <Card>
                <PayablesTable supplierId={s.id} />
              </Card>
            </TabsContent>
            <TabsContent value="purchases">
              <Card>
                <PurchasesTable supplierId={s.id} />
              </Card>
            </TabsContent>
            <TabsContent value="payments">
              <Card>
                <SupplierPaymentsTable supplierId={s.id} />
              </Card>
            </TabsContent>
            <TabsContent value="itemNames">
              <SupplierItemNames supplierId={s.id} supplierName={s.name} />
            </TabsContent>
          </>
        )}
        <TabsContent value="details">
          <Card>
            <CardHeader title="Supplier details" />
            <div className="p-5">
              <KeyValue
                items={[
                  { label: 'Supplier code', value: <span className="font-mono">{s.code}</span> },
                  { label: 'Phone', value: s.phone || '—' },
                  { label: 'Business name', value: s.businessName || '—' },
                  { label: 'GSTIN', value: s.gstin || 'Not registered: their bills carry no GST' },
                  { label: 'State', value: s.stateCode ? `${stateName(s.stateCode)} (${s.stateCode})` : 'Same as the shop' },
                  { label: 'Address', value: s.address || '—' },
                  { label: 'Days to pay', value: `${s.effectiveCreditDays} days${s.creditDays === null ? ' (shop default)' : ''}` },
                  { label: 'Notes', value: s.notes || '—' },
                  { label: 'Last purchase', value: s.lastPurchaseDate ? formatDate(s.lastPurchaseDate) : '—' },
                  { label: 'Added', value: formatDate(s.createdAt) },
                ]}
              />
            </div>
          </Card>
        </TabsContent>
        {can('audit.view') && (
          <TabsContent value="history">
            <Card>
              <EntityHistory entityType="supplier" entityId={s.id} />
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {dialog === 'edit' && <SupplierFormDialog supplier={s} onClose={() => setDialog(null)} onSaved={() => setDialog(null)} />}
      {dialog === 'pay' && <PaySupplierDialog supplierId={s.id} supplierName={s.name} onClose={() => setDialog(null)} />}
      {dialog === 'refund' && <SupplierRefundDialog supplier={s} onClose={() => setDialog(null)} />}
      {dialog === 'adjust' && <AdjustSupplierBalanceDialog supplier={s} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={dialog === 'active'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={s.isActive ? `Deactivate ${s.name}?` : `Reactivate ${s.name}?`}
        description={s.isActive ? 'New purchases cannot be recorded from them. Their bills, payments and balance are kept.' : 'New purchases can be recorded from them again.'}
        confirmLabel={s.isActive ? 'Deactivate' : 'Reactivate'}
        tone={s.isActive ? 'danger' : 'primary'}
        requireReason
        busy={setActive.isPending}
        onConfirm={async (reason) => {
          try {
            await setActive.mutateAsync({ id: s.id, version: s.version, isActive: !s.isActive, reason });
            setDialog(null);
          } catch (e) {
            toast.error('Not saved', errorMessage(e));
          }
        }}
      />
    </>
  );
}
