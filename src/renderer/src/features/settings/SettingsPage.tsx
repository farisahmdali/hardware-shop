import type { ReactElement } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { Activity, CreditCard, Wrench, DatabaseBackup, KeyRound, ReceiptText, Store, UserCog, Users } from 'lucide-react';
import type { Permission } from '@shared/permissions';
import { useCan } from '../../lib/session';
import { cn } from '../../lib/cn';
import { PageHeader } from '../../components/ui/layout';
import { ShopProfileSettings } from './ShopProfileSettings';
import { BillingSettings } from './BillingSettings';
import { BackupSettings } from './BackupSettings';
import { DataHealth } from './DataHealth';
import { UsersSettings } from './UsersSettings';
import { RolesSettings } from './RolesSettings';
import { AccountSettings } from './AccountSettings';
import { PaymentsPrintingSettings } from './PaymentsPrintingSettings';
import { RentalSettings } from './RentalSettings';

const SECTIONS: { path: string; label: string; icon: typeof Store; permission?: Permission; element: ReactElement }[] = [
  { path: 'backup', label: 'Backup', icon: DatabaseBackup, permission: 'backup.create', element: <BackupSettings /> },
  { path: 'shop', label: 'Shop profile', icon: Store, permission: 'settings.manage', element: <ShopProfileSettings /> },
  { path: 'billing', label: 'Billing, tax & stock', icon: ReceiptText, permission: 'settings.manage', element: <BillingSettings /> },
  { path: 'payments', label: 'Payments & printing', icon: CreditCard, permission: 'settings.manage', element: <PaymentsPrintingSettings /> },
  { path: 'rentals', label: 'Rental rules', icon: Wrench, permission: 'settings.manage', element: <RentalSettings /> },
  { path: 'users', label: 'Users', icon: Users, permission: 'users.manage', element: <UsersSettings /> },
  { path: 'roles', label: 'Roles & permissions', icon: UserCog, permission: 'users.manage', element: <RolesSettings /> },
  { path: 'health', label: 'Data health', icon: Activity, permission: 'settings.manage', element: <DataHealth /> },
  { path: 'account', label: 'My account & display', icon: KeyRound, element: <AccountSettings /> },
];

export function SettingsPage() {
  const can = useCan();
  const visible = SECTIONS.filter((s) => !s.permission || can(s.permission));
  return (
    <>
      <PageHeader title="Backup & Settings" />
      <div className="flex gap-6">
        <nav className="w-56 shrink-0" aria-label="Settings sections">
          <ul className="flex flex-col gap-0.5">
            {visible.map((s) => (
              <li key={s.path}>
                <NavLink
                  to={`/settings/${s.path}`}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-2.5 rounded-md px-3 py-2 font-medium',
                      isActive ? 'bg-brand-soft text-brand' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                    )
                  }
                >
                  <s.icon className="size-4" />
                  {s.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 flex-1">
          <Routes>
            {visible.map((s) => (
              <Route key={s.path} path={s.path} element={s.element} />
            ))}
            <Route path="*" element={<Navigate to={`/settings/${visible[0]!.path}`} replace />} />
          </Routes>
        </div>
      </div>
    </>
  );
}
