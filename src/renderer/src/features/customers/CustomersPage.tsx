import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, UserPlus, Users } from 'lucide-react';
import { formatMoney } from '@shared/money';
import { useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useDebounced } from '../../lib/useDebounced';
import { Button } from '../../components/ui/button';
import { Input, Select } from '../../components/ui/form';
import { Badge, Card, EmptyState, PageHeader, Spinner } from '../../components/ui/layout';
import { Pagination, Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { BalanceText } from './CustomerPicker';
import { CustomerFormDialog } from './CustomerFormDialog';

type Filter = 'ALL' | 'OWES' | 'OVERDUE' | 'CREDIT';

export function CustomersPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const can = useCan();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const filter = (params.get('filter') as Filter) ?? 'ALL';
  const active = (params.get('active') as 'ACTIVE' | 'INACTIVE' | 'ALL') ?? 'ACTIVE';
  const debounced = useDebounced(search.trim());
  const list = useCommandQuery('customers.list', { search: debounced || undefined, filter, active, page, pageSize: 50 }, { placeholderData: (p) => p });

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v === 'ALL' || v === 'ACTIVE') next.delete(k);
    else next.set(k, v);
    setParams(next, { replace: true });
    setPage(1);
  };

  return (
    <>
      <PageHeader
        title="Customers"
        description="Balances are worked out from invoices, payments and returns; they cannot be typed over."
        actions={
          can('customers.manage') && (
            <Button icon={<UserPlus className="size-4" />} onClick={() => setAdding(true)}>
              Add customer
            </Button>
          )
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line p-3.5">
          <div className="relative min-w-72 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
            <Input
              aria-label="Search customers"
              placeholder="Name, mobile number, business or code…"
              className="pl-9"
              value={search}
              autoFocus
              onChange={(e) => (setSearch(e.target.value), setPage(1))}
            />
          </div>
          <Select aria-label="Balance" className="w-48" value={filter} onChange={(e) => setParam('filter', e.target.value)}>
            <option value="ALL">All customers</option>
            <option value="OWES">Owe money</option>
            <option value="OVERDUE">Overdue</option>
            <option value="CREDIT">Have credit</option>
          </Select>
          <Select aria-label="Status" className="w-32" value={active} onChange={(e) => setParam('active', e.target.value)}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
            <option value="ALL">All</option>
          </Select>
        </div>
        {!list.data ? (
          <Spinner />
        ) : list.data.rows.length === 0 ? (
          <EmptyState
            icon={Users}
            title={list.data.total === 0 && !debounced && filter === 'ALL' ? 'No customers yet' : 'No customers match'}
            description="Customers are needed for credit sales, statements and GST invoices to businesses. Walk-in sales need none."
          />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>Customer</Th>
                  <Th>Phone</Th>
                  <Th>GSTIN</Th>
                  <Th align="right">Overdue</Th>
                  <Th align="right">Balance</Th>
                </tr>
              </THead>
              <tbody>
                {list.data.rows.map((c) => (
                  <Tr
                    key={c.id}
                    tabIndex={0}
                    className="cursor-pointer"
                    onClick={() => navigate(`/customers/${c.id}`)}
                    onKeyDown={(e) => e.key === 'Enter' && navigate(`/customers/${c.id}`)}
                  >
                    <Td>
                      <span className="font-medium text-ink">{c.name}</span>
                      {!c.isActive && <Badge className="ml-2">Inactive</Badge>}
                      <span className="block text-[12px] text-ink-3">
                        <span className="font-mono">{c.code}</span>
                        {c.businessName && ` · ${c.businessName}`}
                      </span>
                    </Td>
                    <Td>{c.phone}</Td>
                    <Td className="font-mono text-[13px]">{c.gstin}</Td>
                    <Td align="right" className={c.overdue > 0 ? 'font-medium text-danger' : 'text-ink-3'}>
                      {c.overdue > 0 ? formatMoney(c.overdue) : '—'}
                    </Td>
                    <Td align="right">
                      <BalanceText balance={c.balance} />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={50} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>
      {adding && <CustomerFormDialog customer={null} onClose={() => setAdding(false)} onSaved={(c) => navigate(`/customers/${c.id}`)} />}
    </>
  );
}
