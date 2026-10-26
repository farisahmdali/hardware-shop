import {
  ArrowLeftRight,
  Banknote,
  BarChart3,
  Boxes,
  DatabaseBackup,
  History,
  LayoutDashboard,
  ReceiptIndianRupee,
  Truck,
  Users,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@shared/permissions';

export interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Hidden from users who lack this permission (the main process enforces it too). */
  permission?: Permission;
  /** Hidden unless the user has at least one of these. */
  anyPermission?: Permission[];
  /** Modules that are not built yet show what is coming instead of half-working screens. */
  placeholder?: { phase: number; summary: string; features: string[] };
}

export const NAV_ITEMS: NavItem[] = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/sales', label: 'Sales & Billing', icon: ReceiptIndianRupee, permission: 'sales.create' },
  { path: '/products', label: 'Products & Stock', icon: Boxes },
  { path: '/rental-inventory', label: 'Rental Inventory', icon: Wrench },
  { path: '/rentals', label: 'Rental Transactions', icon: ArrowLeftRight },
  { path: '/customers', label: 'Customers', icon: Users },
  { path: '/suppliers', label: 'Suppliers & Purchases', icon: Truck, anyPermission: ['purchases.manage', 'suppliers.manage', 'suppliers.pay', 'reports.financial'] },
  { path: '/payments', label: 'Payments & Outstanding', icon: Wallet },
  { path: '/expenses', label: 'Expenses & Cash', icon: Banknote, anyPermission: ['expenses.manage', 'cash.reconcile'] },
  {
    path: '/reports',
    label: 'Reports',
    icon: BarChart3,
    anyPermission: ['reports.view', 'reports.financial', 'purchases.manage', 'suppliers.pay', 'expenses.manage', 'cash.reconcile'],
  },
  { path: '/history', label: 'History & Audit Log', icon: History, permission: 'audit.view' },
  { path: '/settings', label: 'Backup & Settings', icon: DatabaseBackup },
];
