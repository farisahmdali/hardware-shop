import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PackagePlus, Search, Truck, UserPlus, Wallet } from 'lucide-react';
import { formatMoney } from '@shared/money';
import { useCommandQuery } from '../../lib/api';
import { useCan, useCanViewPurchasing } from '../../lib/session';
import { useDebounced } from '../../lib/useDebounced';
import { Button } from '../../components/ui/button';
import { Input, Select } from '../../components/ui/form';
import { Badge, Card, EmptyState, PageHeader, Spinner } from '../../components/ui/layout';
import { Pagination, Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { cn } from '../../lib/cn';
import { PurchasesTable } from './PurchasesTable';
import { PayablesTable } from './PayablesTable';
import { SupplierPaymentsTable } from './SupplierPaymentsTable';
import { SupplierFormDialog } from './SupplierFormDialog';
import { SupplierPicker } from './SupplierPicker';
import { PaySupplierDialog } from './SupplierDialogs';
import { SupplierBalanceText } from './shared';

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

export function SuppliersPage() {
  const can = useCan();
  const canView = useCanViewPurchasing();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? (canView ? 'purchases' : 'suppliers');
  const summary = useCommandQuery('payables.summary', undefined, { enabled: canView });
  const [dialog, setDialog] = useState<'add' | 'pick-pay' | null>(null);
  const [payFor, setPayFor] = useState<{ id: number; name: string } | null>(null);
  const s = summary.data;

  return (
    <>
      <PageHeader
        title="Suppliers & Purchases"
        description="Purchase bills add stock at their cost. What you owe each supplier is worked out from bills, payments and returns."
        actions={
          <>
            {can('suppliers.pay') && (
              <Button variant="outline" icon={<Wallet className="size-4" />} onClick={() => setDialog('pick-pay')}>
                Pay supplier
              </Button>
            )}
            {can('suppliers.manage') && (
              <Button variant="outline" icon={<UserPlus className="size-4" />} onClick={() => setDialog('add')}>
                Add supplier
              </Button>
            )}
            {can('purchases.manage') && (
              <Button icon={<PackagePlus className="size-4" />} onClick={() => navigate('/suppliers/purchases/new')}>
                New purchase
              </Button>
            )}
          </>
        }
      />
      {canView && (
        <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Tile label="To pay" value={s ? formatMoney(s.outstanding) : '…'} sub={s ? `${s.suppliersOwed} supplier${s.suppliersOwed === 1 ? '' : 's'}` : ''} tone="warning" />
          <Tile label="Overdue" value={s ? formatMoney(s.overdue) : '…'} sub="Past the supplier's credit period" tone={s?.overdue ? 'danger' : undefined} />
          <Tile label="Due in 7 days" value={s ? formatMoney(s.dueInSevenDays) : '…'} sub="Plan these payments" />
          <Tile label="Advances" value={s ? formatMoney(s.advances) : '…'} sub="Paid ahead or from returns" tone="success" />
        </div>
      )}
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
        <TabsList className="mb-4">
          {canView && <TabsTrigger value="purchases">Purchases</TabsTrigger>}
          {canView && <TabsTrigger value="payables">To pay</TabsTrigger>}
          {canView && <TabsTrigger value="ageing">Ageing by supplier</TabsTrigger>}
          {canView && <TabsTrigger value="payments">Payments</TabsTrigger>}
          <TabsTrigger value="suppliers">Suppliers</TabsTrigger>
        </TabsList>
        {canView && (
          <>
            <TabsContent value="purchases">
              <Card>
                <PurchasesTable />
              </Card>
            </TabsContent>
            <TabsContent value="payables">
              <Card>
                <PayablesTable initialFilter={(params.get('filter') as 'OVERDUE' | null) ?? 'ALL'} />
              </Card>
            </TabsContent>
            <TabsContent value="ageing">
              <Card>
                <AgeingTable />
              </Card>
            </TabsContent>
            <TabsContent value="payments">
              <Card>
                <SupplierPaymentsTable />
              </Card>
            </TabsContent>
          </>
        )}
        <TabsContent value="suppliers">
          <Card>
            <SuppliersTable />
          </Card>
        </TabsContent>
      </Tabs>
      {dialog === 'add' && <SupplierFormDialog supplier={null} onClose={() => setDialog(null)} onSaved={(x) => navigate(`/suppliers/${x.id}`)} />}
      {dialog === 'pick-pay' && (
        <SupplierPicker
          onClose={() => setDialog(null)}
          onPick={(x) => {
            setDialog(null);
            setPayFor({ id: x.id, name: x.name });
          }}
        />
      )}
      {payFor && <PaySupplierDialog supplierId={payFor.id} supplierName={payFor.name} onClose={() => setPayFor(null)} />}
    </>
  );
}

type Filter = 'ALL' | 'OWED' | 'OVERDUE' | 'ADVANCE';

function SuppliersTable() {
  const navigate = useNavigate();
  const canView = useCanViewPurchasing();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('ALL');
  const [active, setActive] = useState<'ACTIVE' | 'INACTIVE' | 'ALL'>('ACTIVE');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search.trim());
  const list = useCommandQuery('suppliers.list', { search: debounced || undefined, filter, active, page, pageSize: 50 }, { placeholderData: (p) => p });

  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5 border-b border-line p-3.5">
        <div className="relative min-w-72 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <Input aria-label="Search suppliers" placeholder="Name, phone, GSTIN or code…" className="pl-9" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} />
        </div>
        {canView && (
          <Select aria-label="Balance" className="w-44" value={filter} onChange={(e) => (setFilter(e.target.value as Filter), setPage(1))}>
            <option value="ALL">All suppliers</option>
            <option value="OWED">You owe them</option>
            <option value="OVERDUE">Overdue</option>
            <option value="ADVANCE">Advance with them</option>
          </Select>
        )}
        <Select aria-label="Status" className="w-32" value={active} onChange={(e) => (setActive(e.target.value as typeof active), setPage(1))}>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
          <option value="ALL">All</option>
        </Select>
      </div>
      {!list.data ? (
        <Spinner />
      ) : list.data.rows.length === 0 ? (
        <EmptyState icon={Truck} title={list.data.total === 0 && !debounced && filter === 'ALL' ? 'No suppliers yet' : 'No suppliers match'} />
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <Th>Supplier</Th>
                <Th>Phone</Th>
                <Th>GSTIN</Th>
                {canView && <Th align="right">Overdue</Th>}
                {canView && <Th align="right">Balance</Th>}
              </tr>
            </THead>
            <tbody>
              {list.data.rows.map((s) => (
                <Tr
                  key={s.id}
                  tabIndex={0}
                  className="cursor-pointer"
                  onClick={() => navigate(`/suppliers/${s.id}`)}
                  onKeyDown={(e) => e.key === 'Enter' && navigate(`/suppliers/${s.id}`)}
                >
                  <Td>
                    <span className="font-medium text-ink">{s.name}</span>
                    {!s.isActive && <Badge className="ml-2">Inactive</Badge>}
                    <span className="block text-[12px] text-ink-3">
                      <span className="font-mono">{s.code}</span>
                      {s.businessName && ` · ${s.businessName}`}
                    </span>
                  </Td>
                  <Td>{s.phone}</Td>
                  <Td className="font-mono text-[13px]">{s.gstin || <span className="font-sans text-ink-3">Not registered</span>}</Td>
                  {canView && (
                    <Td align="right" className={s.overdue > 0 ? 'font-medium text-danger' : 'text-ink-3'}>
                      {s.overdue > 0 ? formatMoney(s.overdue) : '—'}
                    </Td>
                  )}
                  {canView && (
                    <Td align="right">
                      <SupplierBalanceText balance={s.balance} />
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={page} pageSize={50} total={list.data.total} onPage={setPage} />
        </>
      )}
    </>
  );
}

function AgeingTable() {
  const report = useCommandQuery('payables.ageing', {});
  if (!report.data) return <Spinner />;
  const r = report.data;
  if (r.rows.length === 0) return <p className="p-6 text-center text-ink-3">Nothing is owed to any supplier.</p>;
  return (
    <Table>
      <THead>
        <tr>
          <Th>Supplier</Th>
          {r.bucketLabels.map((l) => (
            <Th key={l} align="right">
              {l}
            </Th>
          ))}
          <Th align="right">Total owed</Th>
          <Th align="right">Advance</Th>
          <Th align="right">Net</Th>
        </tr>
      </THead>
      <tbody>
        {r.rows.map((row) => (
          <Tr key={row.supplierId}>
            <Td>
              <Link to={`/suppliers/${row.supplierId}`} className="font-medium hover:text-brand">
                {row.supplierName}
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
