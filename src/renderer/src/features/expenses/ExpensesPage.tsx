import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, ReceiptText, Search, Tags } from 'lucide-react';
import type { ExpenseRow } from '@shared/contracts';
import { formatMoney } from '@shared/money';
import { formatDate, formatDateTime } from '@shared/time';
import { useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useDebounced } from '../../lib/useDebounced';
import { Button } from '../../components/ui/button';
import { Input, Select } from '../../components/ui/form';
import { Badge, Card, EmptyState, PageHeader, Spinner } from '../../components/ui/layout';
import { Pagination, Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { HistoryButton } from '../history/EntityHistory';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { ExpenseDialog } from './ExpenseDialog';
import { ExpenseCategoriesDialog } from './ExpenseCategoriesDialog';
import { CashBookView } from './CashBookView';

export function ExpensesPage() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const canExpenses = can('expenses.manage');
  const canCash = can('cash.reconcile');
  const tab = params.get('tab') ?? (canExpenses ? 'expenses' : 'cash');
  const [dialog, setDialog] = useState<'add' | 'categories' | null>(null);

  return (
    <>
      <PageHeader
        title="Expenses & Cash"
        description="Shop expenses and the cash drawer. Corrections keep the original in the history."
        actions={
          canExpenses && (
            <>
              <Button variant="outline" icon={<Tags className="size-4" />} onClick={() => setDialog('categories')}>
                Categories
              </Button>
              <Button icon={<Plus className="size-4" />} onClick={() => setDialog('add')}>
                Add expense
              </Button>
            </>
          )
        }
      />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
        <TabsList className="mb-4">
          {canExpenses && <TabsTrigger value="expenses">Expenses</TabsTrigger>}
          {canCash && <TabsTrigger value="cash">Cash book</TabsTrigger>}
        </TabsList>
        {canExpenses && (
          <TabsContent value="expenses">
            <ExpensesList />
          </TabsContent>
        )}
        {canCash && (
          <TabsContent value="cash">
            <CashBookView />
          </TabsContent>
        )}
      </Tabs>
      {dialog === 'add' && <ExpenseDialog expense={null} onClose={() => setDialog(null)} />}
      {dialog === 'categories' && <ExpenseCategoriesDialog onClose={() => setDialog(null)} />}
    </>
  );
}

function monthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function ExpensesList() {
  const summary = useCommandQuery('expenses.summary');
  const categories = useCommandQuery('expenseCategories.list', { includeInactive: true });
  const methods = useCommandQuery('paymentMethods.list', { includeInactive: true });
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState<number | undefined>();
  const [methodId, setMethodId] = useState<number | undefined>();
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState('');
  const [status, setStatus] = useState<'ACTIVE' | 'VOID' | 'ALL'>('ACTIVE');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<ExpenseRow | null>(null);
  const debounced = useDebounced(search.trim());
  const list = useCommandQuery(
    'expenses.list',
    { search: debounced || undefined, categoryId, methodId, from: from || undefined, to: to || undefined, status, page, pageSize: 50 },
    { placeholderData: (p) => p },
  );
  const reset = <T,>(set: (v: T) => void) => (v: T) => (set(v), setPage(1));

  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-lg border border-line bg-surface px-4 py-3 shadow-card">
          <p className="text-[12px] font-medium tracking-wide text-ink-3 uppercase">Today</p>
          <p className="tabular mt-1 text-2xl font-semibold">{summary.data ? formatMoney(summary.data.today) : '…'}</p>
        </div>
        <div className="rounded-lg border border-line bg-surface px-4 py-3 shadow-card">
          <p className="text-[12px] font-medium tracking-wide text-ink-3 uppercase">This month</p>
          <p className="tabular mt-1 text-2xl font-semibold">{summary.data ? formatMoney(summary.data.month) : '…'}</p>
        </div>
        <div className="col-span-2 rounded-lg border border-line bg-surface px-4 py-3 shadow-card">
          <p className="text-[12px] font-medium tracking-wide text-ink-3 uppercase">This month by category</p>
          <p className="mt-1 text-[13px] text-ink-2">
            {summary.data?.monthByCategory.length
              ? summary.data.monthByCategory
                  .slice(0, 4)
                  .map((c) => `${c.categoryName} ${formatMoney(c.amount)}`)
                  .join(' · ')
              : 'No expenses yet this month'}
          </p>
        </div>
      </div>
      <Card>
        <div className="flex flex-wrap items-end gap-2.5 border-b border-line p-3.5">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
            <Input aria-label="Search expenses" placeholder="Description, paid to, number…" className="pl-9" value={search} onChange={(e) => reset(setSearch)(e.target.value)} />
          </div>
          <Select aria-label="Category" className="w-44" value={categoryId ?? ''} onChange={(e) => reset(setCategoryId)(e.target.value ? Number(e.target.value) : undefined)}>
            <option value="">All categories</option>
            {categories.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Select aria-label="Paid by" className="w-36" value={methodId ?? ''} onChange={(e) => reset(setMethodId)(e.target.value ? Number(e.target.value) : undefined)}>
            <option value="">Any method</option>
            {methods.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            From
            <Input type="date" value={from} onChange={(e) => reset(setFrom)(e.target.value)} className="w-40" />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            To
            <Input type="date" value={to} onChange={(e) => reset(setTo)(e.target.value)} className="w-40" />
          </label>
          <Select aria-label="Status" className="w-28" value={status} onChange={(e) => reset(setStatus)(e.target.value as typeof status)}>
            <option value="ACTIVE">Current</option>
            <option value="VOID">Voided</option>
            <option value="ALL">All</option>
          </Select>
        </div>
        {!list.data ? (
          <Spinner />
        ) : list.data.rows.length === 0 ? (
          <EmptyState icon={ReceiptText} title="No expenses" description="Rent, wages, electricity and other running costs recorded here appear in the cash book and the profit reports." />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>Date</Th>
                  <Th>Expense</Th>
                  <Th>Category</Th>
                  <Th>Paid by</Th>
                  <Th align="right">Amount</Th>
                  <Th />
                </tr>
              </THead>
              <tbody>
                {list.data.rows.map((e) => (
                  <Tr
                    key={e.id}
                    tabIndex={0}
                    className={e.status === 'VOID' ? 'opacity-60' : 'cursor-pointer'}
                    onClick={() => e.status === 'ACTIVE' && setEditing(e)}
                    onKeyDown={(k) => k.key === 'Enter' && e.status === 'ACTIVE' && setEditing(e)}
                  >
                    <Td className="tabular whitespace-nowrap">{formatDate(e.expenseDate)}</Td>
                    <Td>
                      <span className="font-medium text-ink">{e.description}</span>
                      {e.status === 'VOID' && (
                        <Badge tone="danger" className="ml-2">
                          Void
                        </Badge>
                      )}
                      {e.edited && <Badge className="ml-2">Corrected</Badge>}
                      <span className="block text-[12px] text-ink-3">
                        <span className="font-mono">{e.expenseNo}</span>
                        {e.payee && ` · ${e.payee}`}
                        {e.status === 'VOID' ? ` · voided: ${e.voidReason}` : ` · ${formatDateTime(e.createdAt)} by ${e.createdBy ?? 'system'}`}
                      </span>
                    </Td>
                    <Td>{e.categoryName}</Td>
                    <Td>
                      {e.methodName}
                      {e.reference && <span className="block text-[12px] text-ink-3">{e.reference}</span>}
                    </Td>
                    <Td align="right" className="font-medium">
                      {formatMoney(e.amount)}
                    </Td>
                    <Td align="right">
                      <HistoryButton entityType="expense" entityId={e.id} title={`Expense ${e.expenseNo}`} />
                    </Td>
                  </Tr>
                ))}
                <Tr className="bg-surface-2/60 font-semibold">
                  <Td />
                  <Td>Total of {list.data.total} expense{list.data.total === 1 ? '' : 's'}</Td>
                  <Td />
                  <Td />
                  <Td align="right">{formatMoney(list.data.totalAmount)}</Td>
                  <Td />
                </Tr>
              </tbody>
            </Table>
            <Pagination page={page} pageSize={50} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>
      {editing && <ExpenseDialog expense={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
