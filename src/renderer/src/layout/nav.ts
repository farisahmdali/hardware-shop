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
  {
    path: '/suppliers',
    label: 'Suppliers & Purchases',
    icon: Truck,
    placeholder: {
      phase: 5,
      summary: 'Suppliers, purchase bills and what you owe.',
      features: ['Purchase bills that update stock and cost', 'Supplier payments and returns', 'Supplier ledger'],
    },
  },
  { path: '/payments', label: 'Payments & Outstanding', icon: Wallet },
  {
    path: '/expenses',
    label: 'Expenses & Cash',
    icon: Banknote,
    permission: 'expenses.manage',
    placeholder: {
      phase: 5,
      summary: 'Shop expenses and the daily cash drawer.',
      features: ['Expense entry by category', 'Daily cash summary by payment method', 'Cash count reconciliation'],
    },
  },
  {
    path: '/reports',
    label: 'Reports',
    icon: BarChart3,
    permission: 'reports.view',
    placeholder: {
      phase: 6,
      summary: 'Sales, stock, rental and financial reports from your records.',
      features: ['Daily, monthly and custom periods', 'GST summary', 'CSV, Excel and PDF export'],
    },
  },
  { path: '/history', label: 'History & Audit Log', icon: History, permission: 'audit.view' },
  { path: '/settings', label: 'Backup & Settings', icon: DatabaseBackup },
];
