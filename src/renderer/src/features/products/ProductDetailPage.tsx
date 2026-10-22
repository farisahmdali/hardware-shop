import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, PackagePlus, Pencil, Power } from 'lucide-react';
import { formatMoney, mulDivRound } from '@shared/money';
import { formatQty } from '@shared/qty';
import { formatDateTime } from '@shared/time';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useCan, useCanSeeCost } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/dialog';
import { Badge, Card, CardHeader, ErrorBanner, KeyValue, Spinner } from '../../components/ui/layout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { EntityHistory } from '../history/EntityHistory';
import { MovementsTable } from './MovementsTable';
import { ProductFormDialog } from './ProductFormDialog';
import { StockAdjustDialog } from './StockAdjustDialog';
import { StockBadge } from './shared';

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'danger' | 'warning' }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3 shadow-card">
      <p className="text-[12px] font-medium tracking-wide text-ink-3 uppercase">{label}</p>
      <p className={`tabular mt-1 text-xl font-semibold ${tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-ink'}`}>
        {value}
      </p>
      {sub && <p className="text-[12px] text-ink-3">{sub}</p>}
    </div>
  );
}

export function ProductDetailPage() {
  const id = Number(useParams().id);
  const can = useCan();
  const showCost = useCanSeeCost();
  const toast = useToast();
  const product = useCommandQuery('products.get', { id }, { enabled: Number.isInteger(id) });
  const [editing, setEditing] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const setActive = useCommandMutation('products.setActive', { invalidate: ['products.', 'stock.'] });

  if (product.isPending) return <Spinner />;
  if (product.isError) return <ErrorBanner message={product.error.message} />;
  const p = product.data;
  const taxable = p.priceIncludesTax ? mulDivRound(p.sellingPrice, 10_000, 10_000 + p.gstRateBp) : p.sellingPrice;

  return (
    <>
      <Link to="/products" className="mb-3 inline-flex items-center gap-1 text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> All products
      </Link>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-[22px] font-semibold text-ink">{p.name}</h1>
            <StockBadge status={p.status} />
            {!p.isActive && <Badge>Inactive</Badge>}
          </div>
          <p className="mt-0.5 text-ink-2">
            <span className="font-mono">{p.sku}</span>
            {[p.categoryName, p.brandName].filter(Boolean).map((x) => ` · ${x}`)}
          </p>
        </div>
        <div className="flex gap-2">
          {can('stock.adjust') && (
            <Button icon={<PackagePlus className="size-4" />} onClick={() => setAdjusting(true)}>
              Adjust stock
            </Button>
          )}
          {can('products.manage') && (
            <>
              <Button variant="outline" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button variant="ghost" icon={<Power className="size-4" />} onClick={() => setToggling(true)}>
                {p.isActive ? 'Deactivate' : 'Reactivate'}
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="In stock"
          value={`${formatQty(p.qty)} ${p.unitCode}`}
          sub={p.minStockQty > 0 ? `Minimum ${formatQty(p.minStockQty)}` : 'No minimum set'}
          tone={p.status === 'OUT' ? 'danger' : p.status === 'LOW' ? 'warning' : undefined}
        />
        <Stat label="Selling price" value={formatMoney(p.sellingPrice)} sub={`${p.priceIncludesTax ? 'Includes' : 'Plus'} GST ${p.gstRateBp / 100}% · ${formatMoney(taxable)} before GST`} />
        {showCost && (
          <Stat
            label="Average cost"
            value={p.averageCost === null ? '—' : formatMoney(p.averageCost)}
            sub={p.purchasePrice !== null ? `Purchase price ${formatMoney(p.purchasePrice)}` : undefined}
          />
        )}
        {showCost && <Stat label="Stock value" value={formatMoney(p.stockValue ?? 0)} sub="At weighted-average cost" />}
      </div>

      <Tabs defaultValue="movements">
        <TabsList className="mb-4">
          <TabsTrigger value="movements">Stock movements</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
          {can('audit.view') && <TabsTrigger value="history">Change history</TabsTrigger>}
        </TabsList>
        <TabsContent value="movements">
          <Card>
            <MovementsTable productId={p.id} />
          </Card>
        </TabsContent>
        <TabsContent value="details">
          <Card>
            <CardHeader title="Product details" />
            <div className="p-5">
              <KeyValue
                items={[
                  { label: 'Product code', value: <span className="font-mono">{p.sku}</span> },
                  { label: 'Unit', value: `${p.unitName} (${p.unitCode})${p.allowDecimal ? ' · decimals allowed' : ''}` },
                  { label: 'HSN code', value: p.hsnCode || '—' },
                  { label: 'GST', value: `${p.gstRateBp / 100}%, price ${p.priceIncludesTax ? 'includes' : 'excludes'} GST` },
                  { label: 'Preferred supplier', value: p.supplierName ?? '—' },
                  { label: 'Description', value: p.description || '—' },
                  { label: 'Notes', value: p.notes || '—' },
                  { label: 'Sales and purchases', value: <span className="text-ink-3">Listed here once billing and purchasing are in use.</span> },
                  { label: 'Added', value: formatDateTime(p.createdAt) },
                  { label: 'Last changed', value: formatDateTime(p.updatedAt) },
                ]}
              />
            </div>
          </Card>
        </TabsContent>
        {can('audit.view') && (
          <TabsContent value="history">
            <Card>
              <EntityHistory entityType="product" entityId={p.id} />
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {editing && <ProductFormDialog product={p} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />}
      {adjusting && <StockAdjustDialog product={p} onClose={() => setAdjusting(false)} />}
      <ConfirmDialog
        open={toggling}
        onOpenChange={setToggling}
        title={p.isActive ? `Deactivate ${p.name}?` : `Reactivate ${p.name}?`}
        description={
          p.isActive
            ? 'It will no longer appear in billing or in the active product list. Its history and stock records are kept.'
            : 'It will appear in billing and the product list again.'
        }
        confirmLabel={p.isActive ? 'Deactivate' : 'Reactivate'}
        tone={p.isActive ? 'danger' : 'primary'}
        requireReason
        busy={setActive.isPending}
        onConfirm={async (reason) => {
          try {
            await setActive.mutateAsync({ id: p.id, version: p.version, isActive: !p.isActive, reason });
            toast.success(p.isActive ? 'Product deactivated' : 'Product reactivated');
            setToggling(false);
          } catch (e) {
            toast.error('Not saved', errorMessage(e));
          }
        }}
      />
    </>
  );
}
