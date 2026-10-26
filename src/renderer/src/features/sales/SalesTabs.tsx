import { NavLink } from 'react-router-dom';
import { useCommandQuery } from '../../lib/api';
import { cn } from '../../lib/cn';

export function SalesTabs() {
  const held = useCommandQuery('heldBills.list');
  const tabs = [
    { to: '/sales', label: 'New bill', end: true },
    { to: '/sales/invoices', label: 'Invoices' },
    { to: '/sales/held', label: `Held bills${held.data?.length ? ` (${held.data.length})` : ''}` },
  ];
  return (
    <>
    {/* The tabs replace a visible title on the sales screens; screen readers still get one. */}
    <h1 className="sr-only">Sales & Billing</h1>
    <nav className="flex gap-1 rounded-lg bg-surface-2 p-1" aria-label="Sales sections">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            cn('rounded-md px-4 py-1.5 font-medium transition-colors', isActive ? 'bg-surface text-ink shadow-card' : 'text-ink-3 hover:text-ink')
          }
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
    </>
  );
}
