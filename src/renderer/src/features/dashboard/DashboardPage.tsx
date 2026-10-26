import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeftRight,
  Banknote,
  Boxes,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  HandCoins,
  IndianRupee,
  PackageX,
  PiggyBank,
  ReceiptIndianRupee,
  ReceiptText,
  TrendingUp,
  Truck,
  Wallet,
  Wrench,
} from 'lucide-react';
import type { DashboardTransaction } from '@shared/contracts';
import { formatMoney } from '@shared/money';
import { formatQty } from '@shared/qty';
import { MOVEMENT_TYPES } from '@shared/stock';
import { businessDateOf, formatDate, formatDateTime } from '@shared/time';
import { useCommandQuery } from '../../lib/api';
import { useCan, useCanSeeCost, useCanViewPurchasing, useSession } from '../../lib/session';
import { Input, Select } from '../../components/ui/form';
import { Badge, Card, CardHeader, PageHeader } from '../../components/ui/layout';
import { cn } from '../../lib/cn';
import { actionLabel, actionTone, pretty } from '../history/labels';
import { matchPreset, rangePresets } from '../reports/ranges';
import { DailyBillingChart } from './DailyBillingChart';

function Tile({
  to,
  label,
  value,
  sub,
  icon: Icon,
  tone,
}: {
  to: string;
  label: string;
  value: string;
  sub: string;
  icon: typeof Boxes;
  tone?: 'warning' | 'danger' | 'success';
}) {
  const color = tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : tone === 'success' ? 'text-success' : 'text-ink';
  return (
    <Link to={to} className="group rounded-lg border border-line bg-surface p-4 shadow-card transition-colors hover:border-brand/40">
      <div className="flex items-center justify-between">
        <p className="text-[12px] font-medium tracking-wide text-ink-3 uppercase">{label}</p>
        <Icon className={cn('size-4', tone ? color : 'text-ink-3')} />
      </div>
      <p className={cn('mt-2 text-2xl font-semibold', color)}>{value}</p>
      <p className="mt-0.5 text-[13px] text-ink-3 group-hover:text-ink-2">{sub}</p>
    </Link>
  );
}

function StatusRow({ ok, title, detail, to }: { ok: boolean; title: string; detail: string; to: string }) {
  return (
    <Link to={to} className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-surface-2">
      {ok ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" /> : <CircleAlert className="mt-0.5 size-5 shrink-0 text-warning" />}
      <div>
        <p className="font-medium text-ink">{title}</p>
        <p className="text-ink-2">{detail}</p>
      </div>
    </Link>
  );
}

const TX: Record<DashboardTransaction['kind'], { label: string; link: (id: number) => string; out?: boolean }> = {
  SALE: { label: 'Sale', link: (id) => `/sales/invoices/${id}` },
  RENTAL_BILL: { label: 'Rental bill', link: (id) => `/sales/invoices/${id}` },
  PAYMENT: { label: 'Payment received', link: (id) => `/customers/${id}` },
  REFUND: { label: 'Refund paid', link: (id) => `/customers/${id}`, out: true },
  PURCHASE: { label: 'Purchase', link: (id) => `/suppliers/purchases/${id}`, out: true },
  EXPENSE: { label: 'Expense', link: () => '/expenses', out: true },
};

/** "today", "this month", or the dates: used inside tile labels such as "Sales today". */
function periodWords(key: string, from: string, to: string): string {
  const p = rangePresets().find((x) => x.key === key);
  if (p) return p.label.toLowerCase();
  return from === to ? `on ${formatDate(from)}` : `${formatDate(from)} – ${formatDate(to)}`;
}

export function DashboardPage() {
  const session = useSession();
  const can = useCan();
  const canSeeCost = useCanSeeCost();
  const canViewPurchasing = useCanViewPurchasing();
  const today = businessDateOf(new Date());
  const [range, setRange] = useState({ from: today, to: today });
  const preset = matchPreset(range.from, range.to);
  const words = periodWords(preset, range.from, range.to);
  const q = (to: string) => `?from=${range.from}&to=${range.to}${to}`;

  const period = useCommandQuery('dashboard.period', range, { placeholderData: (p) => p });
  const recent = useCommandQuery('dashboard.recent');
  const stock = useCommandQuery('stock.summary');
  const receivables = useCommandQuery('receivables.summary');
  const rentals = useCommandQuery('rentals.summary');
  const payables = useCommandQuery('payables.summary', undefined, { enabled: canViewPurchasing });
  const cash = useCommandQuery('cash.day', {}, { enabled: can('cash.reconcile') });
  const settings = useCommandQuery('settings.get');
  const backups = useCommandQuery('backup.list', undefined, { enabled: can('backup.create') });
  const lastBackup = backups.data?.find((b) => b.status === 'OK');
  const lastCount = cash.data?.counts[cash.data.counts.length - 1];
  const s = stock.data;
  const p = period.data;
  const r = rentals.data;
  const canReports = can('reports.view') || can('reports.financial');

  return (
    <>
      <PageHeader title={`Hello, ${session.user.displayName.split(' ')[0]}`} description="Live figures from your records. Click any figure to see the details." />

      <h2 className="mb-2 text-[13px] font-semibold tracking-wide text-ink-3 uppercase">Right now</h2>
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile
          to="/payments"
          label="Customers owe"
          value={receivables.data ? formatMoney(receivables.data.outstanding) : '…'}
          sub={receivables.data ? `${receivables.data.customersOwing} customer${receivables.data.customersOwing === 1 ? '' : 's'} · not yet collected` : ''}
          icon={HandCoins}
          tone={receivables.data && receivables.data.outstanding > 0 ? 'warning' : undefined}
        />
        <Tile
          to="/payments?tab=outstanding&filter=OVERDUE"
          label="Overdue from customers"
          value={receivables.data ? formatMoney(receivables.data.overdue) : '…'}
          sub="Past the credit period"
          icon={AlertTriangle}
          tone={receivables.data && receivables.data.overdue > 0 ? 'danger' : undefined}
        />
        {canViewPurchasing && (
          <Tile
            to="/suppliers?tab=payables"
            label="To pay suppliers"
            value={payables.data ? formatMoney(payables.data.outstanding) : '…'}
            sub={payables.data ? `${formatMoney(payables.data.overdue)} overdue · ${formatMoney(payables.data.dueInSevenDays)} due in 7 days` : ''}
            icon={Truck}
            tone={payables.data && payables.data.overdue > 0 ? 'danger' : payables.data && payables.data.outstanding > 0 ? 'warning' : undefined}
          />
        )}
        {can('cash.reconcile') && (
          <Tile
            to="/expenses?tab=cash"
            label="Cash in drawer"
            value={cash.data ? formatMoney(cash.data.closing) : '…'}
            sub={lastCount ? `Counted today${lastCount.difference ? `, ${lastCount.difference > 0 ? 'over' : 'short'} ${formatMoney(Math.abs(lastCount.difference))}` : ', matched'}` : 'Expected by the records · not counted today'}
            icon={Banknote}
          />
        )}
        <Tile to="/rentals?filter=ACTIVE" label="Rentals out" value={r ? String(r.active) : '…'} sub={r ? `${r.unitsOut} units out · ${r.unitsAvailable} available` : ''} icon={ArrowLeftRight} />
        <Tile
          to="/rentals?filter=OVERDUE"
          label="Overdue rentals"
          value={r ? String(r.overdue) : '…'}
          sub={r ? `${r.dueToday} more due back today · ${r.reserved} reserved` : ''}
          icon={CalendarClock}
          tone={r?.overdue ? 'danger' : undefined}
        />
        <Tile
          to="/reports/rentals.outstanding"
          label="Rental charges unpaid"
          value={r ? formatMoney(r.chargesUnpaid) : '…'}
          sub="Rental bills not yet collected"
          icon={Wrench}
          tone={r?.chargesUnpaid ? 'warning' : undefined}
        />
        <Tile to="/reports/rentals.depositsHeld" label="Deposits held" value={r ? formatMoney(r.depositsHeld) : '…'} sub="Owed back to customers · not income" icon={PiggyBank} />
        {s?.inventoryValue !== null && s !== undefined && canSeeCost && (
          <Tile to="/products?sort=value&dir=desc" label="Inventory value" value={formatMoney(s.inventoryValue)} sub="At weighted-average cost" icon={IndianRupee} />
        )}
        <Tile to="/products" label="Active products" value={s ? s.activeProducts.toLocaleString('en-IN') : '…'} sub={s ? `Retail value ${formatMoney(s.retailValue)}` : ''} icon={Boxes} />
        <Tile to="/products?stock=LOW" label="Low stock" value={s ? String(s.lowStock) : '…'} sub="At or below minimum" icon={AlertTriangle} tone={s && s.lowStock > 0 ? 'warning' : undefined} />
        <Tile to="/products?stock=OUT" label="Out of stock" value={s ? String(s.outOfStock) : '…'} sub="Active products with none left" icon={PackageX} tone={s && s.outOfStock > 0 ? 'danger' : undefined} />
      </div>

      <Card className="mb-5">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line px-5 py-3.5">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">In the period</h2>
            <p className="text-[13px] text-ink-3">Sales, money collected, deposits, expenses and profit are separate figures; none is part of another.</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Select
              aria-label="Dashboard period"
              className="h-9 w-48"
              value={preset}
              onChange={(e) => {
                const x = rangePresets().find((y) => y.key === e.target.value);
                if (x) setRange({ from: x.from, to: x.to });
              }}
            >
              {rangePresets()
                .filter((x) => x.key !== 'next7')
                .map((x) => (
                  <option key={x.key} value={x.key}>
                    {x.label}
                  </option>
                ))}
              <option value="custom">Custom dates</option>
            </Select>
            <Input aria-label="Period from" type="date" className="h-9 w-40" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} />
            <Input aria-label="Period to" type="date" className="h-9 w-40" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} />
          </div>
        </div>
        <div className={cn('p-5 transition-opacity', period.isFetching && 'opacity-60')}>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            <Tile
              to={canReports ? `/reports/sales.byPeriod${q('')}` : '/sales/invoices'}
              label={`Sales ${words}`}
              value={p ? formatMoney(p.sales.total) : '…'}
              sub={p ? `${p.sales.invoices} invoice${p.sales.invoices === 1 ? '' : 's'}${p.sales.returns ? `, less ${formatMoney(p.sales.returns)} returns` : ''} · products` : ''}
              icon={ReceiptIndianRupee}
            />
            <Tile
              to={canReports ? `/reports/sales.invoices${q('&option=RENTAL')}` : '/rentals'}
              label={`Rentals billed ${words}`}
              value={p ? formatMoney(p.rentalBilled) : '…'}
              sub="Rental bills, including GST"
              icon={Wrench}
            />
            <Tile
              to={canReports ? `/reports/sales.byPaymentMethod${q('')}` : '/payments?tab=payments'}
              label={`Collected ${words}`}
              value={p ? formatMoney(p.collected) : '…'}
              sub={p ? (p.collectedByMethod.map((m) => `${m.name} ${formatMoney(m.amount)}`).join(' · ') || 'No payments') + (p.refunds ? ` · refunds ${formatMoney(p.refunds)}` : '') : ''}
              icon={Wallet}
            />
            <Tile
              to={canReports ? `/reports/rentals.deposits${q('')}` : '/rentals'}
              label={`Deposits ${words}`}
              value={p ? formatMoney(p.deposits.collected) : '…'}
              sub={p ? `Taken · ${formatMoney(p.deposits.released)} used or returned · not income` : ''}
              icon={PiggyBank}
            />
            {p?.expenses !== null && p !== undefined && (
              <Tile to={can('reports.financial') || can('expenses.manage') ? `/reports/finance.expenses${q('')}` : '/expenses'} label={`Expenses ${words}`} value={formatMoney(p.expenses)} sub="Running costs paid" icon={ReceiptText} />
            )}
            {p?.profit && (
              <Tile
                to={`/reports/finance.income${q('')}`}
                label="Estimated profit"
                value={formatMoney(p.profit.net)}
                sub={`Gross ${formatMoney(p.profit.gross)} on revenue ${formatMoney(p.profit.revenue)}, excl. GST`}
                icon={TrendingUp}
                tone={p.profit.net < 0 ? 'danger' : 'success'}
              />
            )}
          </div>
          {p?.daily && p.daily.length > 1 && (
            <div className="mt-5">
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <p className="font-medium text-ink">Billed each day</p>
                {canReports && (
                  <Link to={`/reports/sales.byPeriod${q('')}`} className="text-[13px] font-medium text-brand hover:underline">
                    See the figures
                  </Link>
                )}
              </div>
              <DailyBillingChart data={p.daily} />
            </div>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Recent sales and transactions" />
          {!recent.data?.transactions.length ? (
            <p className="px-5 py-8 text-center text-ink-3">Nothing recorded yet.</p>
          ) : (
            <ul>
              {recent.data.transactions.map((t) => {
                const k = TX[t.kind];
                return (
                  <li key={`${t.kind}-${t.docNo}`}>
                    <Link to={k.link(t.id)} className="flex items-center justify-between gap-4 border-b border-line px-5 py-2.5 last:border-b-0 hover:bg-surface-2">
                      <span className="min-w-0">
                        <span className="font-medium text-ink">{k.label}</span> <span className="font-mono text-[13px] text-ink-3">{t.docNo}</span>
                        {t.cancelled && (
                          <Badge className="ml-2" tone="danger">
                            {t.kind === 'EXPENSE' ? 'Void' : t.kind === 'PAYMENT' || t.kind === 'REFUND' ? 'Reversed' : 'Cancelled'}
                          </Badge>
                        )}
                        <span className="block truncate text-[13px] text-ink-3">
                          {t.party} · {formatDateTime(t.at)}
                        </span>
                      </span>
                      <span className={cn('tabular shrink-0 font-semibold', t.cancelled ? 'text-ink-3 line-through' : k.out ? 'text-ink-2' : 'text-ink')}>
                        {k.out ? '−' : ''}
                        {formatMoney(t.amount)}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Shop status" />
          <div className="flex flex-col py-1">
            <StatusRow
              ok={!!settings.data?.shop.gstin}
              title="Shop profile"
              detail={settings.data?.shop.gstin ? `GSTIN ${settings.data.shop.gstin}` : 'No GSTIN entered yet.'}
              to="/settings/shop"
            />
            {can('backup.create') && (
              <StatusRow ok={!!lastBackup} title="Backups" detail={lastBackup ? `Last backup ${formatDateTime(lastBackup.createdAt)}` : 'No backup yet. Make one now.'} to="/settings/backup" />
            )}
            {can('settings.manage') && <StatusRow ok title="Data health" detail="Run a full consistency check." to="/settings/health" />}
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="Recent stock movements"
            actions={
              <Link to="/products/movements" className="font-medium text-brand hover:underline">
                View all
              </Link>
            }
          />
          {!s?.recentMovements.length ? (
            <p className="px-5 py-8 text-center text-ink-3">No stock movements yet.</p>
          ) : (
            <ul>
              {s.recentMovements.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-4 border-b border-line px-5 py-2.5 last:border-b-0">
                  <div className="min-w-0">
                    <Link to={`/products/${m.productId}`} className="font-medium text-ink hover:text-brand">
                      {m.productName}
                    </Link>
                    <p className="text-[13px] text-ink-3">
                      {MOVEMENT_TYPES[m.type].label} · {formatDateTime(m.occurredAt)} · {m.username ?? 'system'}
                    </p>
                  </div>
                  <span className={cn('tabular shrink-0 font-semibold', m.qtyChange > 0 ? 'text-success' : 'text-danger')}>
                    {m.qtyChange > 0 ? '+' : '−'}
                    {formatQty(Math.abs(m.qtyChange))} {m.unitCode}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {recent.data?.changes && (
          <Card>
            <CardHeader
              title="Significant changes"
              actions={
                <Link to="/history" className="font-medium text-brand hover:underline">
                  History
                </Link>
              }
            />
            {recent.data.changes.length === 0 ? (
              <p className="px-5 py-8 text-center text-ink-3">No cancellations, reversals, overrides or write-offs.</p>
            ) : (
              <ul>
                {recent.data.changes.map((c) => (
                  <li key={c.id} className="border-b border-line px-5 py-2.5 last:border-b-0">
                    <div className="flex items-center gap-2">
                      <Badge tone={actionTone(c.action)}>{actionLabel(c.action)}</Badge>
                      <span className="truncate text-[13px] text-ink-2">
                        {pretty(c.entityType)}
                        {c.entityId && !/^\d+$/.test(c.entityId) ? ` ${c.entityId}` : ''}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-[13px] text-ink-3">
                      {c.reason ? `“${c.reason}” · ` : ''}
                      {c.username ?? 'system'} · {formatDateTime(c.at)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
