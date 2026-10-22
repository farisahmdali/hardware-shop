import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Wallet } from 'lucide-react';
import { formatMoney } from '@shared/money';
import { useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { Button } from '../../components/ui/button';
import { Card, PageHeader, Spinner } from '../../components/ui/layout';
import { Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { CustomerPicker } from '../customers/CustomerPicker';
import { PaymentsTable } from './PaymentsTable';
import { ReceivablesTable } from './ReceivablesTable';
import { ReceivePaymentDialog } from './ReceivePaymentDialog';
import { cn } from '../../lib/cn';

function Tile({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'warning' | 'danger' | 'success' }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3 shadow-card">
      <p className="text-[12px] font-medium tracking-wide text-ink-3 uppercase">{label}</p>
      <p className={cn('tabular mt-1 text-2xl font-semibold', tone === 'warning' && 'text-warning', tone === 'danger' && 'text-danger', tone === 'success' && 'text-success', !tone && 'text-ink')}>
        {value}
      </p>
      <p className="text-[13px] text-ink-3">{sub}</p>
    </div>
  );
}

export function PaymentsPage() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'outstanding';
  const summary = useCommandQuery('receivables.summary');
  const [picking, setPicking] = useState(false);
  const [payFor, setPayFor] = useState<{ id: number; name: string } | null>(null);

  return (
    <>
      <PageHeader
        title="Payments & Outstanding"
        description="Money owed by customers and payments received. Supplier balances are kept separately under Suppliers."
        actions={
          can('payments.receive') && (
            <Button icon={<Wallet className="size-4" />} onClick={() => setPicking(true)}>
              Receive payment
            </Button>
          )
        }
      />
      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile label="Outstanding" value={summary.data ? formatMoney(summary.data.outstanding) : '…'} sub="Open bills, not yet collected" tone="warning" />
        <Tile label="Overdue" value={summary.data ? formatMoney(summary.data.overdue) : '…'} sub="Past the credit period" tone={summary.data?.overdue ? 'danger' : undefined} />
        <Tile label="Customers owing" value={summary.data ? String(summary.data.customersOwing) : '…'} sub="With at least one open bill" />
        <Tile label="Customer credit" value={summary.data ? formatMoney(summary.data.credit) : '…'} sub="Advances and returns not yet used" tone="success" />
      </div>
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
        <TabsList className="mb-4">
          <TabsTrigger value="outstanding">Open bills</TabsTrigger>
          <TabsTrigger value="ageing">Ageing by customer</TabsTrigger>
          <TabsTrigger value="payments">Payments received</TabsTrigger>
        </TabsList>
        <TabsContent value="outstanding">
          <Card>
            <ReceivablesTable initialFilter={(params.get('filter') as 'OVERDUE' | null) ?? 'ALL'} />
          </Card>
        </TabsContent>
        <TabsContent value="ageing">
          <Card>
            <AgeingTable />
          </Card>
        </TabsContent>
        <TabsContent value="payments">
          <Card>
            <PaymentsTable />
          </Card>
        </TabsContent>
      </Tabs>
      {picking && (
        <CustomerPicker
          includeWalkin={false}
          onClose={() => setPicking(false)}
          onPick={(c) => {
            setPicking(false);
            setPayFor({ id: c.id, name: c.name });
          }}
        />
      )}
      {payFor && <ReceivePaymentDialog customerId={payFor.id} customerName={payFor.name} onClose={() => setPayFor(null)} />}
    </>
  );
}

function AgeingTable() {
  const report = useCommandQuery('receivables.ageing', {});
  if (!report.data) return <Spinner />;
  const r = report.data;
  if (r.rows.length === 0) return <p className="p-6 text-center text-ink-3">No customer owes anything.</p>;
  return (
    <Table>
      <THead>
        <tr>
          <Th>Customer</Th>
          {r.bucketLabels.map((l) => (
            <Th key={l} align="right">
              {l}
            </Th>
          ))}
          <Th align="right">Total owed</Th>
          <Th align="right">Credit</Th>
          <Th align="right">Net</Th>
        </tr>
      </THead>
      <tbody>
        {r.rows.map((row) => (
          <Tr key={row.customerId}>
            <Td>
              <Link to={`/customers/${row.customerId}`} className="font-medium hover:text-brand">
                {row.customerName}
              </Link>
              {row.phone && <span className="block text-[12px] text-ink-3">{row.phone}</span>}
            </Td>
            {row.buckets.map((b, i) => (
              <Td key={i} align="right" className={cn(b === 0 && 'text-ink-3', b > 0 && i >= 2 && 'font-medium text-danger')}>
                {b ? formatMoney(b) : '—'}
              </Td>
            ))}
            <Td align="right" className="font-semibold">
              {formatMoney(row.outstanding)}
            </Td>
            <Td align="right" className="text-success">
              {row.credit ? formatMoney(row.credit) : '—'}
            </Td>
            <Td align="right">{formatMoney(row.balance)}</Td>
          </Tr>
        ))}
        <Tr className="bg-surface-2/60 font-semibold">
          <Td>Total</Td>
          {r.totals.buckets.map((b, i) => (
            <Td key={i} align="right">
              {formatMoney(b)}
            </Td>
          ))}
          <Td align="right">{formatMoney(r.totals.outstanding)}</Td>
          <Td align="right">{formatMoney(r.totals.credit)}</Td>
          <Td align="right">{formatMoney(r.totals.balance)}</Td>
        </Tr>
      </tbody>
    </Table>
  );
}
