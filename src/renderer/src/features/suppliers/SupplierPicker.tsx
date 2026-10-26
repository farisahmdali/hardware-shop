import { useEffect, useState } from 'react';
import { Search, UserPlus } from 'lucide-react';
import type { SupplierDetail, SupplierRow } from '@shared/contracts';
import { useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useDebounced } from '../../lib/useDebounced';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/form';
import { cn } from '../../lib/cn';
import { SupplierFormDialog } from './SupplierFormDialog';
import { SupplierBalanceText } from './shared';

/** Find a supplier by name, phone, GSTIN or code, or add a new one. */
export function SupplierPicker({ onPick, onClose }: { onPick(s: SupplierRow | SupplierDetail): void; onClose(): void }) {
  const can = useCan();
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);
  const [adding, setAdding] = useState(false);
  const debounced = useDebounced(search.trim(), 150);
  const list = useCommandQuery('suppliers.list', { search: debounced || undefined, pageSize: 12 }, { placeholderData: (p) => p });
  const rows = list.data?.rows ?? [];
  useEffect(() => setActive(0), [debounced]);

  if (adding) {
    return <SupplierFormDialog supplier={null} initialName={/\d{4,}/.test(search) ? '' : search} onClose={() => setAdding(false)} onSaved={onPick} />;
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Choose supplier"
      footer={
        can('suppliers.manage') ? (
          <Button variant="outline" icon={<UserPlus className="size-4" />} onClick={() => setAdding(true)}>
            New supplier
          </Button>
        ) : undefined
      }
    >
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
        <Input
          aria-label="Search suppliers"
          placeholder="Name, phone, GSTIN or supplier code…"
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
      <ul role="listbox" aria-label="Suppliers" className="max-h-[50vh] overflow-y-auto">
        {rows.map((s, i) => (
          <li key={s.id}>
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(s)}
              className={cn('flex w-full items-center justify-between gap-4 rounded-md px-3 py-2.5 text-left', i === active && 'bg-brand-soft')}
            >
              <span>
                <span className="font-medium text-ink">{s.name}</span>
                <span className="ml-2 font-mono text-[12px] text-ink-3">{s.code}</span>
                <span className="block text-[13px] text-ink-3">{[s.phone, s.gstin || 'No GSTIN'].filter(Boolean).join(' · ')}</span>
              </span>
              <SupplierBalanceText balance={s.balance} />
            </button>
          </li>
        ))}
        {rows.length === 0 && list.data && <li className="px-3 py-6 text-center text-ink-3">No supplier found.</li>}
      </ul>
    </Dialog>
  );
}
