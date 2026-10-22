import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { ProductListRow } from '@shared/contracts';
import { formatMoney } from '@shared/money';
import { formatQty, parseQty } from '@shared/qty';
import { useCommandQuery } from '../../lib/api';
import { useDebounced } from '../../lib/useDebounced';
import { Input } from '../../components/ui/form';
import { cn } from '../../lib/cn';

export interface ProductSearchHandle {
  focus(): void;
}

/**
 * Search box for the counter. Type part of a name or code; arrows move, Enter adds.
 * "3*hammer" or "2.5x pipe" adds that quantity.
 */
export const ProductSearch = forwardRef<ProductSearchHandle, { onAdd(p: ProductListRow, qty: number): void }>(function ProductSearch(
  { onAdd },
  ref,
) {
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }));

  const m = /^\s*(\d+(?:\.\d{1,3})?)\s*[*xX]\s*(.+)$/.exec(text);
  const qtyText = m?.[1];
  const term = (m ? m[2]! : text).trim();
  const debounced = useDebounced(term, 120);
  const results = useCommandQuery(
    'products.list',
    { search: debounced || undefined, active: 'ACTIVE', pageSize: 10 },
    { enabled: debounced.length > 0, placeholderData: (p) => p },
  );
  const rows = debounced ? (results.data?.rows ?? []) : [];
  // Results on screen may still belong to the previous search while the new one loads.
  const current = term !== '' && debounced === term && !results.isPlaceholderData && !results.isFetching;
  const [pendingEnter, setPendingEnter] = useState(false);
  useEffect(() => setActive(0), [debounced]);

  const add = (p: ProductListRow) => {
    const qty = qtyText ? parseQty(qtyText, p.allowDecimal) : 1000;
    if (qty === null || qty <= 0) return;
    onAdd(p, qty);
    setText('');
    setOpen(false);
    setPendingEnter(false);
    input.current?.focus();
  };

  // Enter pressed before the results arrived: add the top match once they do.
  useEffect(() => {
    if (pendingEnter && current) {
      setPendingEnter(false);
      if (rows[0]) add(rows[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEnter, current, rows]);

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-ink-3" />
      <Input
        ref={input}
        aria-label="Search products to add"
        role="combobox"
        aria-expanded={open && rows.length > 0}
        aria-controls="product-results"
        placeholder="Search product name or code…   (F3)   tip: 3*hammer adds 3"
        value={text}
        autoFocus
        className="h-12 pl-11 text-[15px]"
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(rows.length - 1, a + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (current && rows[active]) add(rows[active]!);
            else if (term) setPendingEnter(true);
          } else if (e.key === 'Escape') {
            setText('');
          }
        }}
      />
      {open && rows.length > 0 && (
        <ul
          id="product-results"
          role="listbox"
          className="absolute top-full right-0 left-0 z-30 mt-1 max-h-96 overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-pop"
        >
          {rows.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => add(p)}
                className={cn('flex w-full items-center justify-between gap-4 px-4 py-2 text-left', i === active && 'bg-brand-soft')}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink">{p.name}</span>
                  <span className="font-mono text-[12px] text-ink-3">{p.sku}</span>
                  {p.brandName && <span className="ml-2 text-[12px] text-ink-3">{p.brandName}</span>}
                </span>
                <span className="shrink-0 text-right">
                  <span className="tabular block font-semibold text-ink">{formatMoney(p.sellingPrice)}</span>
                  <span className={cn('tabular text-[12px]', p.qty <= 0 ? 'text-danger' : 'text-ink-3')}>
                    {p.qty <= 0 ? 'Out of stock' : `${formatQty(p.qty)} ${p.unitCode} in stock`}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && debounced && results.isError && (
        <div role="alert" className="absolute top-full right-0 left-0 z-30 mt-1 rounded-lg border border-danger/40 bg-surface px-4 py-3 text-danger shadow-pop">
          Search failed: {results.error.message}
        </div>
      )}
      {open && debounced && results.data && rows.length === 0 && (
        <div className="absolute top-full right-0 left-0 z-30 mt-1 rounded-lg border border-line bg-surface px-4 py-3 text-ink-3 shadow-pop">
          No active product matches “{debounced}”.
        </div>
      )}
    </div>
  );
});
