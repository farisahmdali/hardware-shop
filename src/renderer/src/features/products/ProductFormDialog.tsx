import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { productFields, type CatalogData, type ProductDetail } from '@shared/contracts';
import { formatMoney, mulDivRound } from '@shared/money';
import { GST_RATES_BP, formatRate } from '@shared/stock';
import { call, errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select, Switch, Textarea } from '../../components/ui/form';
import { ErrorBanner } from '../../components/ui/layout';
import { MoneyInput, QtyInput, newRequestId } from '../../components/ui/numberInputs';
import { useQueryClient } from '@tanstack/react-query';

interface FormState {
  sku: string;
  name: string;
  categoryId: number | null;
  brandId: number | null;
  unitId: number | null;
  description: string;
  hsnCode: string;
  gstRateBp: number;
  priceIncludesTax: boolean;
  purchasePrice: number | null;
  sellingPrice: number | null;
  minStockQty: number | null;
  preferredSupplierId: number | null;
  notes: string;
  openingQty: number | null;
  openingUnitCost: number | null;
  reason: string;
}

function initialState(product: ProductDetail | null, catalog: CatalogData, pricesIncludeTax: boolean): FormState {
  if (product) {
    return {
      sku: product.sku,
      name: product.name,
      categoryId: product.categoryId,
      brandId: product.brandId,
      unitId: product.unitId,
      description: product.description,
      hsnCode: product.hsnCode,
      gstRateBp: product.gstRateBp,
      priceIncludesTax: product.priceIncludesTax,
      purchasePrice: product.purchasePrice,
      sellingPrice: product.sellingPrice,
      minStockQty: product.minStockQty,
      preferredSupplierId: product.preferredSupplierId,
      notes: product.notes,
      openingQty: null,
      openingUnitCost: null,
      reason: '',
    };
  }
  return {
    sku: '',
    name: '',
    categoryId: null,
    brandId: null,
    unitId: catalog.units.find((u) => u.code === 'PCS')?.id ?? catalog.units[0]?.id ?? null,
    description: '',
    hsnCode: '',
    gstRateBp: 1800,
    priceIncludesTax: pricesIncludeTax,
    purchasePrice: null,
    sellingPrice: null,
    minStockQty: null,
    preferredSupplierId: null,
    notes: '',
    openingQty: null,
    openingUnitCost: null,
    reason: '',
  };
}

export function ProductFormDialog({
  product,
  onClose,
  onSaved,
}: {
  product: ProductDetail | null;
  onClose(): void;
  onSaved(p: ProductDetail): void;
}) {
  const catalog = useCommandQuery('catalog.get');
  const settings = useCommandQuery('settings.get');
  if (!catalog.data || !settings.data) return null;
  return (
    <ProductForm
      product={product}
      catalog={catalog.data}
      pricesIncludeTax={settings.data.tax.pricesIncludeTax}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

function ProductForm({
  product,
  catalog,
  pricesIncludeTax,
  onClose,
  onSaved,
}: {
  product: ProductDetail | null;
  catalog: CatalogData;
  pricesIncludeTax: boolean;
  onClose(): void;
  onSaved(p: ProductDetail): void;
}) {
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState<FormState>(() => initialState(product, catalog, pricesIncludeTax));
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [requestId] = useState(newRequestId);
  const [adding, setAdding] = useState<'brand' | 'supplier' | null>(null);
  const [newName, setNewName] = useState('');
  const create = useCommandMutation('products.create', { invalidate: ['products.', 'stock.', 'catalog.'] });
  const update = useCommandMutation('products.update', { invalidate: ['products.', 'stock.'] });
  const busy = create.isPending || update.isPending;

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const markValid = (key: string, valid: boolean) =>
    setInvalid((s) => {
      const n = new Set(s);
      if (valid) n.delete(key);
      else n.add(key);
      return n;
    });

  const unit = catalog.units.find((u) => u.id === f.unitId);
  const activeUnits = catalog.units.filter((u) => u.isActive || u.id === f.unitId);
  const categories = catalog.categories.filter((c) => c.kind === 'PRODUCT' && (c.isActive || c.id === f.categoryId));
  const brands = catalog.brands.filter((b) => b.isActive || b.id === f.brandId);
  const suppliers = catalog.suppliers.filter((s) => s.isActive || s.id === f.preferredSupplierId);
  const showCost = can('products.manage');
  const canOpening = !product && can('stock.adjust');

  const breakdown = useMemo(() => {
    if (f.sellingPrice === null) return null;
    const taxable = f.priceIncludesTax ? mulDivRound(f.sellingPrice, 10_000, 10_000 + f.gstRateBp) : f.sellingPrice;
    const gst = f.priceIncludesTax ? f.sellingPrice - taxable : mulDivRound(f.sellingPrice, f.gstRateBp, 10_000);
    const margin = f.purchasePrice !== null && taxable > 0 ? ((taxable - f.purchasePrice) / taxable) * 100 : null;
    return { taxable, gst, total: taxable + gst, margin };
  }, [f.sellingPrice, f.priceIncludesTax, f.gstRateBp, f.purchasePrice]);

  const addNamed = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      if (adding === 'brand') {
        const b = await call('catalog.saveBrand', { name, isActive: true });
        set('brandId', b.id);
      } else {
        const s = await call('catalog.quickAddSupplier', { name, phone: '' });
        set('preferredSupplierId', s.id);
      }
      await qc.invalidateQueries({ queryKey: ['catalog.get'] });
      setAdding(null);
      setNewName('');
    } catch (e) {
      toast.error('Could not add', errorMessage(e));
    }
  };

  const submit = async () => {
    setServerError(null);
    const fields = {
      sku: f.sku,
      name: f.name,
      categoryId: f.categoryId,
      brandId: f.brandId,
      unitId: f.unitId ?? 0,
      description: f.description,
      hsnCode: f.hsnCode,
      gstRateBp: f.gstRateBp,
      priceIncludesTax: f.priceIncludesTax,
      purchasePrice: f.purchasePrice ?? 0,
      sellingPrice: f.sellingPrice ?? 0,
      minStockQty: f.minStockQty ?? 0,
      preferredSupplierId: f.preferredSupplierId,
      notes: f.notes,
    };
    const parsed = productFields.safeParse(fields);
    const next: Record<string, string> = {};
    if (!parsed.success) for (const i of parsed.error.issues) next[String(i.path[0])] ??= i.message;
    if (!f.unitId) next.unitId = 'Choose a unit';
    for (const key of invalid) next[key] ??= 'Enter a valid number';
    setErrors(next);
    if (Object.keys(next).length > 0 || !parsed.success) return;
    try {
      const saved = product
        ? await update.mutateAsync({ ...parsed.data, id: product.id, version: product.version, reason: f.reason || undefined })
        : await create.mutateAsync({
            ...parsed.data,
            requestId,
            openingQty: canOpening ? (f.openingQty ?? 0) : 0,
            openingUnitCost: f.openingUnitCost ?? undefined,
          });
      toast.success(product ? 'Product saved' : `Product ${saved.sku} added`);
      onSaved(saved);
    } catch (e) {
      setServerError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={product ? `Edit ${product.name}` : 'Add product'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} busy={busy}>
            {product ? 'Save changes' : 'Add product'}
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-6 gap-x-4 gap-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Product name" required error={errors.name} className="col-span-4">
          {(p) => <Input {...p} value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus maxLength={200} />}
        </Field>
        <Field label="Product code" error={errors.sku} className="col-span-2" hint={product ? undefined : 'Leave empty for an automatic code'}>
          {(p) => <Input {...p} value={f.sku} onChange={(e) => set('sku', e.target.value.trim())} placeholder="Automatic" maxLength={40} />}
        </Field>

        <Field label="Category" className="col-span-2">
          {(p) => (
            <Select {...p} value={f.categoryId ?? ''} onChange={(e) => set('categoryId', e.target.value ? Number(e.target.value) : null)}>
              <option value="">No category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Brand" className="col-span-2">
          {(p) =>
            adding === 'brand' ? (
              <InlineAdd value={newName} onChange={setNewName} onAdd={addNamed} onCancel={() => setAdding(null)} placeholder="New brand name" />
            ) : (
              <div className="flex gap-1.5">
                <Select {...p} value={f.brandId ?? ''} onChange={(e) => set('brandId', e.target.value ? Number(e.target.value) : null)}>
                  <option value="">No brand</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
                <Button variant="outline" className="w-10 px-0" aria-label="Add brand" onClick={() => setAdding('brand')}>
                  <Plus className="size-4" />
                </Button>
              </div>
            )
          }
        </Field>
        <Field label="Unit" required error={errors.unitId} className="col-span-2" hint={unit?.allowDecimal ? 'Decimals allowed' : 'Whole numbers only'}>
          {(p) => (
            <Select {...p} value={f.unitId ?? ''} onChange={(e) => set('unitId', Number(e.target.value))}>
              {activeUnits.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.code})
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Selling price" required error={errors.sellingPrice} className="col-span-2">
          {(p) => (
            <MoneyInput
              {...p}
              value={f.sellingPrice}
              onValueChange={(v, ok) => {
                set('sellingPrice', v);
                markValid('sellingPrice', ok);
              }}
            />
          )}
        </Field>
        <Field label="GST rate" className="col-span-2">
          {(p) => (
            <Select {...p} value={f.gstRateBp} onChange={(e) => set('gstRateBp', Number(e.target.value))}>
              {GST_RATES_BP.map((r) => (
                <option key={r} value={r}>
                  {formatRate(r)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="HSN code" error={errors.hsnCode} className="col-span-2">
          {(p) => <Input {...p} value={f.hsnCode} onChange={(e) => set('hsnCode', e.target.value.replace(/\D/g, ''))} inputMode="numeric" maxLength={8} />}
        </Field>
        <div className="col-span-6 -mt-1 flex flex-wrap items-center justify-between gap-3 rounded-md bg-surface-2 px-3 py-2">
          <Switch label="Selling price includes GST" checked={f.priceIncludesTax} onChange={(v) => set('priceIncludesTax', v)} />
          {breakdown && (
            <p className="tabular text-[13px] text-ink-2">
              Before GST {formatMoney(breakdown.taxable)} · GST {formatMoney(breakdown.gst)} · Customer pays{' '}
              <strong className="text-ink">{formatMoney(breakdown.total)}</strong>
              {showCost && breakdown.margin !== null && (
                <span className={breakdown.margin < 0 ? 'ml-2 text-danger' : 'ml-2'}>· Margin {breakdown.margin.toFixed(1)}%</span>
              )}
            </p>
          )}
        </div>

        {showCost && (
          <Field label="Purchase price (before GST)" error={errors.purchasePrice} className="col-span-2" hint="Reference cost per unit">
            {(p) => (
              <MoneyInput
                {...p}
                value={f.purchasePrice}
                onValueChange={(v, ok) => {
                  set('purchasePrice', v);
                  markValid('purchasePrice', ok);
                }}
              />
            )}
          </Field>
        )}
        <Field label="Minimum stock" error={errors.minStockQty} className="col-span-2" hint="Alert when stock falls to this level">
          {(p) => (
            <QtyInput
              {...p}
              value={f.minStockQty}
              allowDecimal={unit?.allowDecimal ?? false}
              unit={unit?.code}
              onValueChange={(v, ok) => {
                set('minStockQty', v);
                markValid('minStockQty', ok);
              }}
            />
          )}
        </Field>
        <Field label="Preferred supplier" className="col-span-2">
          {(p) =>
            adding === 'supplier' ? (
              <InlineAdd value={newName} onChange={setNewName} onAdd={addNamed} onCancel={() => setAdding(null)} placeholder="Supplier name" />
            ) : (
              <div className="flex gap-1.5">
                <Select
                  {...p}
                  value={f.preferredSupplierId ?? ''}
                  onChange={(e) => set('preferredSupplierId', e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">None</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
                <Button variant="outline" className="w-10 px-0" aria-label="Add supplier" onClick={() => setAdding('supplier')}>
                  <Plus className="size-4" />
                </Button>
              </div>
            )
          }
        </Field>

        {canOpening && (
          <div className="col-span-6 grid grid-cols-6 gap-4 rounded-lg border border-line p-4">
            <p className="col-span-6 -mb-1 font-medium text-ink">Opening stock (optional)</p>
            <Field label="Quantity in stock now" error={errors.openingQty} className="col-span-3">
              {(p) => (
                <QtyInput
                  {...p}
                  value={f.openingQty}
                  allowDecimal={unit?.allowDecimal ?? false}
                  unit={unit?.code}
                  onValueChange={(v, ok) => {
                    set('openingQty', v);
                    markValid('openingQty', ok);
                  }}
                />
              )}
            </Field>
            <Field label="Cost per unit" error={errors.openingUnitCost} className="col-span-3" hint="Defaults to the purchase price">
              {(p) => (
                <MoneyInput
                  {...p}
                  value={f.openingUnitCost}
                  placeholder={f.purchasePrice !== null ? (f.purchasePrice / 100).toFixed(2) : ''}
                  onValueChange={(v, ok) => {
                    set('openingUnitCost', v);
                    markValid('openingUnitCost', ok);
                  }}
                />
              )}
            </Field>
          </div>
        )}

        <Field label="Description" className="col-span-3">
          {(p) => <Textarea {...p} value={f.description} onChange={(e) => set('description', e.target.value)} rows={2} maxLength={1000} />}
        </Field>
        <Field label="Notes" className="col-span-3" hint="Internal; not printed">
          {(p) => <Textarea {...p} value={f.notes} onChange={(e) => set('notes', e.target.value)} rows={2} maxLength={1000} />}
        </Field>
        {product && (
          <Field label="Reason for change (optional)" className="col-span-6" hint="Saved in the product history">
            {(p) => <Input {...p} value={f.reason} onChange={(e) => set('reason', e.target.value)} maxLength={500} />}
          </Field>
        )}
        {serverError && (
          <div className="col-span-6">
            <ErrorBanner title="Not saved" message={serverError} />
          </div>
        )}
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}

function InlineAdd({
  value,
  onChange,
  onAdd,
  onCancel,
  placeholder,
}: {
  value: string;
  onChange(v: string): void;
  onAdd(): void;
  onCancel(): void;
  placeholder: string;
}) {
  return (
    <div className="flex gap-1.5">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus
        maxLength={120}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onAdd();
          }
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <Button size="md" onClick={onAdd}>
        Add
      </Button>
    </div>
  );
}
