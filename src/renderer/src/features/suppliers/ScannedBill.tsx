import { useState } from 'react';
import { CircleCheck, FileText, Link2, PackagePlus, TriangleAlert, Undo2 } from 'lucide-react';
import { productFields, type CatalogData, type ProductListRow, type ScanCandidate, type ScanDraft, type ScanLine } from '@shared/contracts';
import { formatMoney, mulDivRound } from '@shared/money';
import { formatQty } from '@shared/qty';
import { GST_RATES_BP, formatRate } from '@shared/stock';
import { call, errorMessage } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select } from '../../components/ui/form';
import { Badge, Card, CardHeader } from '../../components/ui/layout';
import { MoneyInput, newRequestId } from '../../components/ui/numberInputs';
import { cn } from '../../lib/cn';
import { ProductSearch } from '../sales/ProductSearch';

/** A line of a scanned bill not yet linked to one of the shop's products. */
export interface PendingItem {
  key: string;
  scan: ScanLine;
  name: string;
  unitId: number | null;
  hsnCode: string;
  gstRateBp: number;
  categoryId: number | null;
  sellingPrice: number | null;
  error?: string;
}

const validHsn = (hsn: string) => (/^(\d{4}|\d{6}|\d{8})$/.test(hsn) ? hsn : hsn.length > 8 ? hsn.slice(0, 8) : hsn.length >= 4 ? hsn.slice(0, 4) : '');

export function pendingFrom(scan: ScanLine, catalog: CatalogData): PendingItem {
  const pcs = catalog.units.find((u) => u.code === 'PCS' && u.isActive)?.id ?? catalog.units.find((u) => u.isActive)?.id ?? null;
  return {
    key: crypto.randomUUID(),
    scan,
    name: scan.text.slice(0, 200),
    unitId: scan.unitId ?? pcs,
    hsnCode: validHsn(scan.hsnCode),
    gstRateBp: scan.gstRateBp,
    categoryId: null,
    sellingPrice: null,
  };
}

/** The rate on the bill after the line's discount. */
export const netRate = (l: ScanLine) => l.rate - mulDivRound(l.rate, l.discountBp, 10_000);

export const billSummary = (l: ScanLine) =>
  `${l.qty ? formatQty(l.qty) : '?'} ${l.unitText || ''} × ${formatMoney(l.rate)}${l.discountBp ? ` less ${l.discountBp / 100}%` : ''}${l.gstRateBp ? ` · GST ${formatRate(l.gstRateBp)}` : ''}`;

export const HOW_LABEL: Record<string, string> = {
  REMEMBERED: 'Remembered',
  CODE: 'Same product code',
  BEST: 'Matched, please check',
};

// ---------- New items on the bill ----------

export function NewItemsCard({
  items,
  catalog,
  supplierId,
  billLabel,
  pricesIncludeTax,
  canAddProducts,
  onChange,
  onResolved,
  onSkip,
}: {
  items: PendingItem[];
  catalog: CatalogData;
  supplierId: number | null;
  billLabel: string;
  pricesIncludeTax: boolean;
  canAddProducts: boolean;
  onChange(items: PendingItem[]): void;
  onResolved(item: PendingItem, product: ProductListRow): void;
  onSkip(item: PendingItem): void;
}) {
  const [pointing, setPointing] = useState<PendingItem | null>(null);
  const [adding, setAdding] = useState(false);
  const update = (key: string, patch: Partial<PendingItem>) => onChange(items.map((i) => (i.key === key ? { ...i, ...patch, error: undefined } : i)));
  const missing = items.filter((i) => i.sellingPrice === null || !i.name.trim() || i.unitId === null);
  const units = catalog.units.filter((u) => u.isActive);
  const categories = catalog.categories.filter((c) => c.kind === 'PRODUCT' && c.isActive);

  const addAll = async () => {
    setAdding(true);
    // One at a time, in order: each is a normal "add product" with its own history entry.
    let left = items;
    for (const item of items) {
      const fields = productFields.safeParse({
        sku: '',
        name: item.name,
        categoryId: item.categoryId,
        brandId: null,
        unitId: item.unitId,
        description: '',
        hsnCode: item.hsnCode,
        gstRateBp: item.gstRateBp,
        priceIncludesTax: pricesIncludeTax,
        purchasePrice: netRate(item.scan),
        sellingPrice: item.sellingPrice,
        minStockQty: 0,
        preferredSupplierId: supplierId,
        notes: `Added from ${billLabel}`.slice(0, 1000),
      });
      if (!fields.success) {
        left = left.map((i) => (i.key === item.key ? { ...i, error: fields.error.issues[0]?.message ?? 'Check this item' } : i));
        continue;
      }
      try {
        const product = await call('products.create', { ...fields.data, requestId: newRequestId(), openingQty: 0 });
        left = left.filter((i) => i.key !== item.key);
        onResolved(item, product);
      } catch (e) {
        left = left.map((i) => (i.key === item.key ? { ...i, error: errorMessage(e) } : i));
      }
    }
    onChange(left);
    setAdding(false);
  };

  return (
    <Card className="border-warning/40">
      <CardHeader
        title={`New items on this bill (${items.length})`}
        description="These items were not found in your products. Add each as a new product with its selling price, or, if you already have it under another name, point it to that product."
      />
      <ul className="flex flex-col divide-y divide-line">
        {items.map((item) => {
          const needsPrice = item.sellingPrice === null;
          return (
            <li key={item.key} className="flex flex-col gap-3 px-5 py-4" data-testid="new-item">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="min-w-0">
                  <span className="text-[12px] text-ink-3 uppercase">On the bill: </span>
                  <span className="font-medium text-ink">{item.scan.text}</span>
                  <span className="ml-2 text-[13px] text-ink-3">{billSummary(item.scan)}</span>
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" icon={<Link2 className="size-4" />} onClick={() => setPointing(item)}>
                    Point to existing product…
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onSkip(item)}>
                    Leave out
                  </Button>
                </div>
              </div>
              {item.scan.candidates.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="text-ink-3">Similar products you have:</span>
                  {item.scan.candidates.map((c) => (
                    <button
                      key={c.product.id}
                      type="button"
                      className="rounded-full border border-line px-2.5 py-0.5 hover:border-brand hover:text-brand"
                      title={c.reasons.join(' · ')}
                      onClick={() => onResolved(item, c.product)}
                    >
                      Use {c.product.name}
                    </button>
                  ))}
                </div>
              )}
              {canAddProducts ? (
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
                  <Field label="New product name" className="col-span-2">
                    {(p) => <Input {...p} className="h-9" value={item.name} maxLength={200} onChange={(e) => update(item.key, { name: e.target.value })} />}
                  </Field>
                  <Field label="Unit">
                    {(p) => (
                      <Select {...p} className="h-9" value={item.unitId ?? ''} onChange={(e) => update(item.key, { unitId: Number(e.target.value) || null })}>
                        {units.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.code}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label="HSN code">
                    {(p) => <Input {...p} className="h-9" value={item.hsnCode} inputMode="numeric" maxLength={8} onChange={(e) => update(item.key, { hsnCode: e.target.value.replace(/\D/g, '') })} />}
                  </Field>
                  <Field label="GST">
                    {(p) => (
                      <Select {...p} className="h-9" value={item.gstRateBp} onChange={(e) => update(item.key, { gstRateBp: Number(e.target.value) })}>
                        {GST_RATES_BP.map((bp) => (
                          <option key={bp} value={bp}>
                            {formatRate(bp)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label="Category">
                    {(p) => (
                      <Select {...p} className="h-9" value={item.categoryId ?? ''} onChange={(e) => update(item.key, { categoryId: Number(e.target.value) || null })}>
                        <option value="">None</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field
                    label={`Selling price${pricesIncludeTax ? ' (incl. GST)' : ' (before GST)'}`}
                    required
                    className="col-span-2 lg:col-span-2"
                    error={item.error}
                    hint={`Bought at ${formatMoney(netRate(item.scan))} per ${item.scan.unitText || 'unit'}`}
                  >
                    {(p) => (
                      <MoneyInput
                        {...p}
                        aria-label={`Selling price of ${item.name}`}
                        className={cn('h-9', needsPrice && 'border-warning bg-warning-soft')}
                        value={item.sellingPrice}
                        onValueChange={(v) => update(item.key, { sellingPrice: v })}
                      />
                    )}
                  </Field>
                </div>
              ) : (
                <p className="text-[13px] text-ink-3">You do not have permission to add products. Point it to an existing product, or ask an owner to add it.</p>
              )}
            </li>
          );
        })}
      </ul>
      {canAddProducts && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4">
          <p className="text-[13px] text-ink-3">
            {missing.length
              ? `Type the selling price of every new item (${missing.length} still empty) to add them.`
              : 'New products start with no stock; saving this purchase brings the stock in.'}
          </p>
          <Button icon={<PackagePlus className="size-4" />} disabled={missing.length > 0 || items.length === 0} busy={adding} onClick={addAll}>
            Add all new items ({items.length})
          </Button>
        </div>
      )}
      {pointing && (
        <PointToProductDialog
          item={pointing}
          onClose={() => setPointing(null)}
          onPick={(p) => {
            setPointing(null);
            onResolved(pointing, p);
          }}
        />
      )}
    </Card>
  );
}

function PointToProductDialog({ item, onClose, onPick }: { item: PendingItem; onClose(): void; onPick(p: ProductListRow): void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Which of your products is this?" description={<>On the bill: <strong>{item.scan.text}</strong> · {billSummary(item.scan)}</>} size="lg">
      <div className="flex flex-col gap-4">
        {item.scan.candidates.length > 0 && <Candidates candidates={item.scan.candidates} onPick={onPick} />}
        <div>
          <p className="mb-2 text-[13px] font-medium text-ink-2">Search your products</p>
          <ProductSearch mode="purchase" onAdd={(p) => onPick(p)} />
        </div>
        <p className="text-[13px] text-ink-3">The choice is remembered for this supplier when you save the purchase, so next time this item is matched by itself.</p>
      </div>
    </Dialog>
  );
}

function Candidates({ candidates, onPick }: { candidates: ScanCandidate[]; onPick(p: ProductListRow): void }) {
  return (
    <div>
      <p className="mb-2 text-[13px] font-medium text-ink-2">Closest matches</p>
      <ul className="flex flex-col gap-1.5">
        {candidates.map((c) => (
          <li key={c.product.id}>
            <button type="button" className="flex w-full items-center justify-between gap-3 rounded-md border border-line px-3 py-2 text-left hover:border-brand" onClick={() => onPick(c.product)}>
              <span className="min-w-0">
                <span className="block font-medium text-ink">{c.product.name}</span>
                <span className="block text-[12px] text-ink-3">
                  <span className="font-mono">{c.product.sku}</span> · {c.reasons.join(' · ') || 'similar name'}
                </span>
              </span>
              <Badge tone={c.score >= 75 ? 'success' : 'neutral'}>{c.score}% match</Badge>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- The bill as scanned ----------

export function ScannedBillCard({
  draft,
  calculatedTotal,
  pendingCount,
  skipped,
  onPutBack,
}: {
  draft: ScanDraft;
  calculatedTotal: number;
  pendingCount: number;
  skipped: ScanLine[];
  onPutBack(line: ScanLine): void;
}) {
  const [zoom, setZoom] = useState(false);
  const diff = draft.printedTotal === null ? null : draft.printedTotal - calculatedTotal;
  return (
    <Card>
      <CardHeader title="Scanned bill" description={`${draft.fileName} · read by ${draft.model}`} />
      <div className="flex flex-col gap-3 p-5">
        {draft.preview ? (
          <button type="button" className="overflow-hidden rounded-md border border-line" onClick={() => setZoom(true)} aria-label="Show the bill larger">
            <img src={draft.preview} alt="The supplier's bill" className="max-h-96 w-full object-contain object-top" />
          </button>
        ) : (
          <p className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-ink-2">
            <FileText className="size-4" /> {draft.fileName}
          </p>
        )}
        {draft.printedTotal !== null && (
          <div
            className={cn('rounded-md px-3 py-2 text-[13px]', diff === 0 && pendingCount === 0 ? 'bg-success-soft' : 'bg-warning-soft')}
            data-testid="scan-total-check"
          >
            <p className="flex items-center gap-1.5 font-medium text-ink">
              {diff === 0 && pendingCount === 0 ? <CircleCheck className="size-4 text-success" /> : <TriangleAlert className="size-4 text-warning" />}
              Bill total {formatMoney(draft.printedTotal)}
              {diff === 0 ? ' — matches' : ` — this purchase comes to ${formatMoney(calculatedTotal)} (${diff! > 0 ? 'short by' : 'over by'} ${formatMoney(Math.abs(diff!))})`}
            </p>
            {pendingCount > 0 && <p className="mt-0.5 text-ink-2">{pendingCount} new item{pendingCount > 1 ? 's are' : ' is'} not in the total until added or pointed to a product.</p>}
            {diff !== 0 && pendingCount === 0 && <p className="mt-0.5 text-ink-2">Compare the items, GST and charges with the bill. A difference of paise is usually round-off.</p>}
          </div>
        )}
        {skipped.length > 0 && (
          <div className="text-[13px]">
            <p className="font-medium text-ink-2">Left out of this purchase</p>
            <ul className="mt-1 flex flex-col gap-1">
              {skipped.map((l) => (
                <li key={l.index} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    {l.text} <span className="text-ink-3">· {l.printedAmount !== null ? formatMoney(l.printedAmount) : billSummary(l)}</span>
                  </span>
                  <button type="button" className="inline-flex items-center gap-1 text-brand hover:underline" onClick={() => onPutBack(l)}>
                    <Undo2 className="size-3.5" /> Put back
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {draft.warnings.length > 0 && (
          <ul className="flex flex-col gap-1 text-[13px] text-ink-2" aria-label="Things to check">
            {draft.warnings.map((w) => (
              <li key={w} className="flex gap-1.5">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                {w}
              </li>
            ))}
          </ul>
        )}
        <p className="text-[12px] text-ink-3">Read by AI: check every item against the bill before saving.</p>
      </div>
      {zoom && draft.preview && (
        <Dialog open onOpenChange={(o) => !o && setZoom(false)} title={draft.fileName} size="xl">
          <img src={draft.preview} alt="The supplier's bill" className="w-full" />
        </Dialog>
      )}
    </Card>
  );
}
