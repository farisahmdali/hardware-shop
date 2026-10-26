import { Navigate, Route, Routes } from 'react-router-dom';
import { useCommandQuery } from './lib/api';
import { SessionProvider } from './lib/session';
import { useApplyTheme } from './lib/theme';
import { Spinner, ErrorBanner } from './components/ui/layout';
import { SetupWizard } from './features/setup/SetupWizard';
import { LoginScreen } from './features/auth/LoginScreen';
import { AppShell } from './layout/AppShell';
import { NAV_ITEMS } from './layout/nav';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { ModulePlaceholder } from './features/placeholder/ModulePlaceholder';
import { HistoryPage } from './features/history/HistoryPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { ProductsListPage } from './features/products/ProductsListPage';
import { ProductDetailPage } from './features/products/ProductDetailPage';
import { MovementsPage } from './features/products/MovementsPage';
import { StockCountsPage } from './features/products/StockCountsPage';
import { StockCountDetailPage } from './features/products/StockCountDetailPage';
import { CatalogPage } from './features/products/CatalogPage';
import { BillingPage } from './features/sales/BillingPage';
import { InvoicesPage } from './features/sales/InvoicesPage';
import { InvoiceDetailPage } from './features/sales/InvoiceDetailPage';
import { HeldBillsPage } from './features/sales/HeldBillsPage';
import { CustomersPage } from './features/customers/CustomersPage';
import { CustomerDetailPage } from './features/customers/CustomerDetailPage';
import { PaymentsPage } from './features/payments/PaymentsPage';
import { RentalInventoryPage } from './features/rentals/RentalInventoryPage';
import { RentalProductPage } from './features/rentals/RentalProductPage';
import { RentalsPage } from './features/rentals/RentalsPage';
import { NewRentalPage } from './features/rentals/NewRentalPage';
import { RentalDetailPage } from './features/rentals/RentalDetailPage';
import { SuppliersPage } from './features/suppliers/SuppliersPage';
import { SupplierDetailPage } from './features/suppliers/SupplierDetailPage';
import { NewPurchasePage } from './features/suppliers/NewPurchasePage';
import { PurchaseDetailPage } from './features/suppliers/PurchaseDetailPage';
import { ExpensesPage } from './features/expenses/ExpensesPage';
import { ReportsPage } from './features/reports/ReportsPage';
import { ReportPage } from './features/reports/ReportPage';

/** Decides between first-run setup, sign-in and the application itself. */
export function App() {
  const status = useCommandQuery('app.status');
  const session = useCommandQuery('auth.session', undefined, { enabled: status.data?.setupComplete === true });
  const settings = useCommandQuery('settings.get', undefined, { enabled: !!session.data });
  useApplyTheme(settings.data?.app.theme);

  if (status.isPending) return <Spinner label="Opening the shop…" className="h-full" />;
  if (status.isError) {
    return (
      <div className="mx-auto max-w-lg p-10">
        <ErrorBanner message={status.error.message} onRetry={() => void status.refetch()} />
      </div>
    );
  }
  if (!status.data.setupComplete) return <SetupWizard />;
  if (session.isPending) return <Spinner label="Checking sign-in…" className="h-full" />;
  if (!session.data) return <LoginScreen shopName={status.data.shopName} />;

  return (
    <SessionProvider session={session.data}>
      <AppShell status={status.data} shopName={settings.data?.shop.name ?? ''}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          {NAV_ITEMS.filter((n) => n.placeholder).map((n) => (
            <Route key={n.path} path={n.path} element={<ModulePlaceholder item={n} />} />
          ))}
          <Route path="/sales" element={<BillingPage />} />
          <Route path="/sales/invoices" element={<InvoicesPage />} />
          <Route path="/sales/invoices/:id" element={<InvoiceDetailPage />} />
          <Route path="/sales/held" element={<HeldBillsPage />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/customers/:id" element={<CustomerDetailPage />} />
          <Route path="/payments" element={<PaymentsPage />} />
          <Route path="/rental-inventory" element={<RentalInventoryPage />} />
          <Route path="/rental-inventory/:id" element={<RentalProductPage />} />
          <Route path="/rentals" element={<RentalsPage />} />
          <Route path="/rentals/new" element={<NewRentalPage />} />
          <Route path="/rentals/:id" element={<RentalDetailPage />} />
          <Route path="/suppliers" element={<SuppliersPage />} />
          <Route path="/suppliers/purchases/new" element={<NewPurchasePage />} />
          <Route path="/suppliers/purchases/:id" element={<PurchaseDetailPage />} />
          <Route path="/suppliers/:id" element={<SupplierDetailPage />} />
          <Route path="/expenses" element={<ExpensesPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/reports/:id" element={<ReportPage />} />
          <Route path="/products" element={<ProductsListPage />} />
          <Route path="/products/movements" element={<MovementsPage />} />
          <Route path="/products/counts" element={<StockCountsPage />} />
          <Route path="/products/counts/:id" element={<StockCountDetailPage />} />
          <Route path="/products/catalog" element={<CatalogPage />} />
          <Route path="/products/:id" element={<ProductDetailPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/settings/*" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </SessionProvider>
  );
}
