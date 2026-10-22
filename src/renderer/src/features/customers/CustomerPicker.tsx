import { useEffect, useState } from 'react';
import { Search, UserPlus } from 'lucide-react';
import type { CustomerDetail, CustomerRow } from '@shared/contracts';
import { formatMoney } from '@shared/money';
import { useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useDebounced } from '../../lib/useDebounced';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/form';
import { cn } from '../../lib/cn';
import { CustomerFormDialog } from './CustomerFormDialog';

export function BalanceText({ balance }: { balance: number }) {
  if (balance === 0) return <span className="text-ink-3">No balance</span>;
  return balance > 0 ? (
    <span className="font-medium text-warning">Owes {formatMoney(balance)}</span>
  ) : (
    <span className="font-medium text-success">Credit {formatMoney(-balance)}</span>
  );
}

/** Find a customer by name, phone or code, or add a new one. */
export function CustomerPicker({
  includeWalkin,
  onPick,
  onClose,
}: {
  includeWalkin: boolean;
  onPick(c: CustomerRow | CustomerDetail): void;
  onClose(): void;
}) {
  const can = useCan();
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);
  const [adding, setAdding] = useState(false);
  const debounced = useDebounced(search.trim(), 150);
  const list = useCommandQuery('customers.list', { search: debounced || undefined, includeWalkin, pageSize: 12 }, { placeholderData: (p) => p });
  const rows = list.data?.rows ?? [];
  useEffect(() => setActive(0), [debounced]);

  if (adding) {
    return <CustomerFormDialog customer={null} initialName={/\d{4,}/.test(search) ? '' : search} onClose={() => setAdding(false)} onSaved={onPick} />;
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Choose customer"
      footer={
        can('customers.manage') ? (
          <Button variant="outline" icon={<UserPlus className="size-4" />} onClick={() => setAdding(true)}>
            New customer
          </Button>
        ) : undefined
      }
    >
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
        <Input
          aria-label="Search customers"
          placeholder="Name, mobile number or customer code…"
          value={search}
          autoFocus
          className="pl-9"
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(rows.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter' && rows[active]) {
              e.preventDefault();
              onPick(rows[active]!);
            }
          }}
        />
      </div>
      <ul role="listbox" aria-label="Customers" className="max-h-[50vh] overflow-y-auto">
        {rows.map((c, i) => (
          <li key={c.id}>
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(c)}
              className={cn('flex w-full items-center justify-between gap-4 rounded-md px-3 py-2.5 text-left', i === active && 'bg-brand-soft')}
            >
              <span>
                <span className="font-medium text-ink">{c.name}</span>
                <span className="ml-2 font-mono text-[12px] text-ink-3">{c.code}</span>
                <span className="block text-[13px] text-ink-3">{[c.phone, c.businessName].filter(Boolean).join(' · ') || (c.isWalkin ? 'Counter sale without a profile' : '')}</span>
              </span>
              {!c.isWalkin && <BalanceText balance={c.balance} />}
            </button>
          </li>
        ))}
        {rows.length === 0 && list.data && <li className="px-3 py-6 text-center text-ink-3">No customer found.</li>}
      </ul>
    </Dialog>
  );
}
