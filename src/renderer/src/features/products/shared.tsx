import { NavLink } from 'react-router-dom';
import type { StockStatus } from '@shared/stock';
import { Badge } from '../../components/ui/layout';
import { useCan } from '../../lib/session';
import { cn } from '../../lib/cn';

export function StockBadge({ status }: { status: StockStatus }) {
  if (status === 'OUT') return <Badge tone="danger">Out of stock</Badge>;
  if (status === 'LOW') return <Badge tone="warning">Low</Badge>;
  return null;
}

export function ProductsTabs() {
  const can = useCan();
  const tabs = [
    { to: '/products', label: 'Products', end: true },
    { to: '/products/movements', label: 'Stock movements' },
    ...(can('stock.adjust') ? [{ to: '/products/counts', label: 'Stock counts' }] : []),
    ...(can('products.manage') ? [{ to: '/products/catalog', label: 'Categories, brands & units' }] : []),
  ];
  return (
    <nav className="mb-5 flex gap-1 border-b border-line" aria-label="Products sections">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            cn(
              '-mb-px border-b-2 px-3.5 py-2.5 font-medium transition-colors',
              isActive ? 'border-brand text-brand' : 'border-transparent text-ink-3 hover:text-ink',
            )
          }
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
