import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowLeftRight, CalendarClock, Boxes, CheckCircle2, CircleAlert, HandCoins, IndianRupee, PackageX, ReceiptIndianRupee, Wallet } from 'lucide-react';
import { formatMoney } from '@shared/money';
import { formatQty } from '@shared/qty';
import { MOVEMENT_TYPES } from '@shared/stock';
import { formatDateTime } from '@shared/time';
import { useCommandQuery } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { Card, CardHeader, PageHeader } from '../../components/ui/layout';
import { cn } from '../../lib/cn';

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
  tone?: 'warning' | 'danger';
}) {
  return (
    <Link to={to} className="group rounded-lg border border-line bg-surface p-4 shadow-card transition-colors hover:border-brand/40">
      <div className="flex items-center justify-between">
        <p className="text-[12px] font-medium tracking-wide text-ink-3 uppercase">{label}</p>
        <Icon className={cn('size-4', tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-ink-3')} />
      </div>
      <p className={cn('tabular mt-2 text-2xl font-semibold', tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-ink')}>
        {value}
      </p>
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

export function DashboardPage() {
  const session = useSession();
  const can = useCan();
  const stock = useCommandQuery('stock.summary');
  const sales = useCommandQuery('sales.summary');
  const receivables = useCommandQuery('receivables.summary');
  const rentals = useCommandQuery('rentals.summary');
  const settings = useCommandQuery('settings.get');
  const backups = useCommandQuery('backup.list', undefined, { enabled: can('backup.create') });
  const lastBackup = backups.data?.find((b) => b.status === 'OK');
  const s = stock.data;

  return (
    <>
      <PageHeader
        title={`Hello, ${session.user.displayName.split(' ')[0]}`}
        description="Live figures from your records."
      />
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile
          to="/sales/invoices"
          label="Sales today"
          value={sales.data ? formatMoney(sales.data.todayTotal) : '…'}
          sub={sales.data ? `${sales.data.todayCount} invoice${sales.data.todayCount === 1 ? '' : 's'}, after returns · not cash collected` : ''}
          icon={ReceiptIndianRupee}
        />
        <Tile
          to="/payments?tab=payments"
          label="Collected today"
          value={sales.data ? formatMoney(sales.data.collectedToday.reduce((a, c) => a + c.amount, 0)) : '…'}
          sub={sales.data?.collectedToday.length ? sales.data.collectedToday.map((c) => `${c.methodName} ${formatMoney(c.amount)}`).join(' · ') : 'No payments yet today'}
          icon={Wallet}
        />
        <Tile
          to="/payments"
          label="Outstanding"
          value={receivables.data ? formatMoney(receivables.data.outstanding) : '…'}
          sub={receivables.data ? `${receivables.data.customersOwing} customer${receivables.data.customersOwing === 1 ? '' : 's'} owe money` : ''}
          icon={HandCoins}
          tone={receivables.data && receivables.data.outstanding > 0 ? 'warning' : undefined}
        />
        <Tile
          to="/payments?tab=outstanding&filter=OVERDUE"
          label="Overdue"
          value={receivables.data ? formatMoney(receivables.data.overdue) : '…'}
          sub={sales.data ? `This month's sales ${formatMoney(sales.data.monthTotal)}` : ''}
          icon={AlertTriangle}
          tone={receivables.data && receivables.data.overdue > 0 ? 'danger' : undefined}
        />
      </div>
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile to="/rentals?filter=ACTIVE" label="Rentals out" value={rentals.data ? String(rentals.data.active) : '…'} sub={rentals.data ? `${rentals.data.unitsOut} units out · ${rentals.data.unitsAvailable} available` : ''} icon={ArrowLeftRight} />
        <Tile
          to="/rentals?filter=OVERDUE"
          label="Overdue rentals"
          value={rentals.data ? String(rentals.data.overdue) : '…'}
          sub={rentals.data ? `${rentals.data.dueToday} more due back today` : ''}
          icon={AlertTriangle}
          tone={rentals.data?.overdue ? 'danger' : undefined}
        />
        <Tile to="/rentals?filter=RESERVED" label="Reservations" value={rentals.data ? String(rentals.data.reserved) : '…'} sub={rentals.data?.awaitingInspection ? `${rentals.data.awaitingInspection} unit(s) await inspection` : 'Upcoming hand-overs'} icon={CalendarClock} />
        <Tile to="/rentals" label="Deposits held" value={rentals.data ? formatMoney(rentals.data.depositsHeld) : '…'} sub="Owed back to customers · not income" icon={HandCoins} />
      </div>
      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {s?.inventoryValue !== null && s !== undefined && (
          <Tile to="/products?sort=value&dir=desc" label="Inventory value" value={formatMoney(s.inventoryValue)} sub="At weighted-average cost" icon={IndianRupee} />
        )}
        <Tile to="/products" label="Active products" value={s ? s.activeProducts.toLocaleString('en-IN') : '…'} sub={s ? `Retail value ${formatMoney(s.retailValue)}` : ''} icon={Boxes} />
        <Tile
          to="/products?stock=LOW"
          label="Low stock"
          value={s ? String(s.lowStock) : '…'}
          sub="At or below minimum"
          icon={AlertTriangle}
          tone={s && s.lowStock > 0 ? 'warning' : undefined}
        />
        <Tile
          to="/products?stock=OUT"
          label="Out of stock"
          value={s ? String(s.outOfStock) : '…'}
          sub="Active products with none left"
          icon={PackageX}
          tone={s && s.outOfStock > 0 ? 'danger' : undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
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
              <StatusRow
                ok={!!lastBackup}
                title="Backups"
                detail={lastBackup ? `Last backup ${formatDateTime(lastBackup.createdAt)}` : 'No backup yet. Make one now.'}
                to="/settings/backup"
              />
            )}
            {can('settings.manage') && <StatusRow ok title="Data health" detail="Run a full consistency check." to="/settings/health" />}
          </div>
        </Card>
      </div>
    </>
  );
}
