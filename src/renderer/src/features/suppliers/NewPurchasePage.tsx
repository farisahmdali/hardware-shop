import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ScanText, Trash2, Truck } from 'lucide-react';
import type { ProductListRow, PurchaseDetail, ScanDraft, ScanLine, SupplierDetail, SupplierRow } from '@shared/contracts';
import type { Discount } from '@shared/billing';
import { formatMoney, mulDivRound, roundToRupee } from '@shared/money';
import { formatQty } from '@shared/qty';
import { claimsInputGst, computePurchase } from '@shared/purchasing';
import { GST_RATES_BP, formatRate } from '@shared/stock';
import { businessDateOf } from '@shared/time';
import { stateName } from '@shared/gstStates';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Checkbox, Field, Input, Textarea } from '../../components/ui/form';
import { Badge, Card, CardHeader, ErrorBanner, PageHeader } from '../../components/ui/layout';
import { ConfirmDialog } from '../../components/ui/dialog';
import { MoneyInput, QtyInput, newRequestId } from '../../components/ui/numberInputs';
import { cn } from '../../lib/cn';
import { ProductSearch, type ProductSearchHandle } from '../sales/ProductSearch';
import { PaymentLines, toPayments, type PaymentEntry } from '../rentals/shared';
import { SupplierPicker } from './SupplierPicker';
import { SUPPLIER_INVALIDATE } from './shared';
import { SupplierFormDialog } from './SupplierFormDialog';
import { HOW_LABEL, NewItemsCard, ScannedBillCard, pendingFrom, type PendingItem } from './ScannedBill';

interface Line {
  key: string;
  product: ProductListRow;
  qty: number | null;
  unitCost: number | null;
  gstRateBp: number;
  /** Discount in basis points of the line amount. */
  discountBp: number;
  /** The line of a scanned bill this came from. */
  scan?: ScanLine;
}

type SupplierInfo = Pick<SupplierRow, 'id' | 'name' | 'gstin' | 'stateCode'>;

/** A bill being edited: its current version, and its supplier and products as they are now. */
export interface ExistingBill {
  purchase: PurchaseDetail;
  supplier: SupplierInfo;
  products: Map<number, ProductListRow>;
}

/**
 * The percentage that gives a line's recorded discount. Discounts are entered as percentages and
 * stored as amounts; the roundest percentage that reproduces the amount exactly is chosen.
 */
function discountBpFor(gross: number, amount: number): number {
  if (!amount || !gross) return 0;
  for (const step of [100, 50, 25, 1]) {
    const bp = Math.round((amount * 10_000) / gross / step) * step;
    if (mulDivRound(gross, bp, 10_000) === amount) return bp;
  }
  return Math.round((amount * 10_000) / gross);
}

function linesFrom(existing: ExistingBill): Line[] {
  return existing.purchase.lines.map((l) => ({
    key: crypto.randomUUID(),
    product: existing.products.get(l.productId)!,
    qty: l.qty,
    unitCost: l.unitCost,
    gstRateBp: l.gstRateBp,
    discountBp: discountBpFor(l.gross, l.lineDiscount),
  }));
}

/** Enter a supplier's bill: stock comes in at landed cost and the amount is owed to the supplier. */
export function NewPurchasePage() {
  return <PurchaseForm />;
}

/**
 * The supplier's bill form, for a new purchase or, with `existing`, for editing one. An edit is
 * saved as a new version of the bill; the version edited is kept in the history.
 */
export function PurchaseForm({ existing }: { existing?: ExistingBill }) {
  const navigate = useNavigate();
  const toast = useToast();
  const can = useCan();
  const [params] = useSearchParams();
  const settings = useCommandQuery('settings.get');
  const preset = Number(params.get('supplier')) || null;
  const presetSupplier = useCommandQuery('suppliers.get', { id: preset ?? 0 }, { enabled: preset !== null });
  const search = useRef<ProductSearchHandle>(null);

  const bill0 = existing?.purchase;
  const [supplier, setSupplier] = useState<SupplierInfo | null>(existing?.supplier ?? null);
  const [picking, setPicking] = useState(false);
  const [billNo, setBillNo] = useState(bill0?.supplierInvoiceNo ?? '');
  const [billDate, setBillDate] = useState(() => bill0?.supplierInvoiceDate ?? businessDateOf(new Date()));
  const [includesTax, setIncludesTax] = useState(bill0?.pricesIncludeTax ?? false);
  const [lines, setLines] = useState<Line[]>(() => (existing ? linesFrom(existing) : []));
  const [additional, setAdditional] = useState<number | null>(bill0?.additionalCosts || null);
  const [additionalNote, setAdditionalNote] = useState(bill0?.additionalCostsNote ?? '');
  const [roundOff, setRoundOff] = useState(bill0?.roundOff ?? 0);
  const [notes, setNotes] = useState(bill0?.notes ?? '');
  const [payments, setPayments] = useState<PaymentEntry[]>([]);
  const [updatePrices, setUpdatePrices] = useState(true);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(newRequestId);
  // A discount on the whole bill cannot be entered here, but a bill recorded with one keeps it.
  const [billDiscount] = useState<Discount | null>(() => {
    const amount = bill0 ? bill0.lines.reduce((a, l) => a + l.billDiscount, 0) : 0;
    return amount > 0 ? { type: 'AMOUNT', value: amount } : null;
  });
  const ai = useCommandQuery('ai.status', undefined, { enabled: !existing });
  const catalog = useCommandQuery('catalog.get');
  const scanMutation = useCommandMutation('ai.scanBill', { invalidate: ['ai.'] });
  const [scan, setScan] = useState<ScanDraft | null>(null);
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [skipped, setSkipped] = useState<ScanLine[]>([]);
  const [confirmScan, setConfirmScan] = useState(false);
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const create = useCommandMutation('purchases.create', { invalidate: SUPPLIER_INVALIDATE });
  const edit = useCommandMutation('purchases.edit', { invalidate: SUPPLIER_INVALIDATE });

  useEffect(() => {
    if (presetSupplier.data && !supplier) setSupplier(presetSupplier.data);
  }, [presetSupplier.data, supplier]);

  const s = settings.data;
  const registered = !!supplier?.gstin;
  const interstate = !!supplier && supplier.stateCode !== '' && !!s && supplier.stateCode !== s.shop.stateCode;
  const itc = !!s && !!supplier && claimsInputGst({ claimInputGst: s.purchases.claimInputGst, gstRegistered: s.tax.gstRegistered }, supplier.gstin);
  const ready = useMemo(() => lines.filter((l) => l.qty !== null && l.qty > 0 && l.unitCost !== null), [lines]);
  const calc = useMemo(
    () =>
      computePurchase(
        ready.map((l) => ({
          unitCost: l.unitCost!,
          qty: l.qty!,
          gstRateBp: registered ? l.gstRateBp : 0,
          discount: l.discountBp ? { type: 'PERCENT' as const, valueBp: l.discountBp } : null,
        })),
        { pricesIncludeTax: includesTax, interstate, billDiscount, additionalCosts: additional ?? 0, roundOff, itcClaimed: itc },
      ),
    [ready, registered, includesTax, interstate, billDiscount, additional, roundOff, itc],
  );
  const { bill } = calc;
  const tax = bill.cgstTotal + bill.sgstTotal + bill.igstTotal;
  const maxRoundOff = s?.purchases.maxRoundOff ?? 1000;
  const paid = existing ? 0 : payments.reduce((a, p) => a + (p.amount ?? 0), 0);
  const landedOf = (l: Line) => {
    const i = ready.indexOf(l);
    return i === -1 ? null : calc.landed[i]!;
  };

  const chooseSupplier = (x: SupplierInfo) => {
    setSupplier(x);
    setPicking(false);
    // An unregistered supplier cannot charge GST.
    if (!x.gstin) setLines((ls) => ls.map((l) => ({ ...l, gstRateBp: 0 })));
    else setLines((ls) => ls.map((l) => ({ ...l, gstRateBp: l.gstRateBp || l.product.gstRateBp })));
  };

  const add = (p: ProductListRow, qty: number) => {
    setLines((ls) => [
      ...ls,
      { key: crypto.randomUUID(), product: p, qty, unitCost: p.purchasePrice, gstRateBp: registered || !supplier ? p.gstRateBp : 0, discountBp: 0 },
    ]);
  };
  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  // ---- Scanning a supplier's bill with the AI assistant ----
  const lineFromScan = (l: ScanLine, product: ProductListRow, gstin: string | null | undefined): Line => ({
    key: crypto.randomUUID(),
    product,
    qty: l.qty || null,
    unitCost: l.rate,
    gstRateBp: gstin ? l.gstRateBp : 0,
    discountBp: l.discountBp,
    scan: l,
  });
  const applyScan = (d: ScanDraft) => {
    const found = d.supplier.match;
    setSupplier(found);
    setBillNo(d.supplierInvoiceNo);
    if (d.supplierInvoiceDate) setBillDate(d.supplierInvoiceDate);
    setIncludesTax(d.pricesIncludeTax);
    setAdditional(d.additionalCosts || null);
    setAdditionalNote(d.additionalCostsNote);
    setRoundOff(d.roundOff);
    setLines(d.lines.filter((l) => l.match).map((l) => lineFromScan(l, l.match!.product, found?.gstin)));
    setPending(catalog.data ? d.lines.filter((l) => !l.match).map((l) => pendingFrom(l, catalog.data!)) : []);
    setSkipped([]);
    setScan(d);
    setError(null);
    setRequestId(newRequestId());
  };
  const runScan = async () => {
    setConfirmScan(false);
    setScanError(null);
    try {
      const d = await scanMutation.mutateAsync({});
      if (d) applyScan(d);
    } catch (e) {
      setScanError(errorMessage(e));
    }
  };
  const byBillOrder = (a: Line, b: Line) => (a.scan?.index ?? 1e9) - (b.scan?.index ?? 1e9);
  const resolvePending = (item: PendingItem, product: ProductListRow) => {
    setPending((ps) => ps.filter((p) => p.key !== item.key));
    setLines((ls) => [...ls, lineFromScan(item.scan, product, supplier?.gstin)].sort(byBillOrder));
  };
  const skipPending = (item: PendingItem) => {
    setPending((ps) => ps.filter((p) => p.key !== item.key));
    setSkipped((ss) => [...ss, item.scan]);
  };
  /** A scanned line linked to the wrong product goes back to the new-items list. */
  const unlink = (l: Line) => {
    setLines((ls) => ls.filter((x) => x.key !== l.key));
    if (l.scan && catalog.data) setPending((ps) => [...ps, pendingFrom({ ...l.scan!, qty: l.qty ?? l.scan!.qty, rate: l.unitCost ?? l.scan!.rate }, catalog.data!)]);
  };
  const removeLine = (l: Line) => {
    setLines((ls) => ls.filter((x) => x.key !== l.key));
    if (l.scan) setSkipped((ss) => [...ss, l.scan!]);
  };

  const problems: string[] = [];
  if (!supplier) problems.push('Choose the supplier');
  if (pending.length > 0) problems.push(`Decide what to do with the ${pending.length} new item${pending.length > 1 ? 's' : ''} from the bill`);
  if (lines.length === 0) problems.push('Add the items on the bill');
  if (lines.length !== ready.length) problems.push('Every item needs a quantity and a rate');
  if (Math.abs(roundOff) > maxRoundOff) problems.push(`Round-off can be at most ${formatMoney(maxRoundOff)}`);
  if (paid > calc.grandTotal) problems.push('Payments are more than the bill total');
  if (existing && reason.trim().length < 3) problems.push('Say why the bill is being changed');

  const save = async () => {
    if (!supplier || problems.length) return;
    setError(null);
    const fields = {
      supplierId: supplier.id,
      supplierInvoiceNo: billNo,
      supplierInvoiceDate: billDate,
      pricesIncludeTax: includesTax,
      lines: ready.map((l) => ({
        productId: l.product.id,
        qty: l.qty!,
        unitCost: l.unitCost!,
        gstRateBp: registered ? l.gstRateBp : 0,
        discount: l.discountBp ? ({ type: 'PERCENT', valueBp: l.discountBp } as const) : null,
        scannedText: l.scan?.text,
      })),
      billDiscount,
      additionalCosts: additional ?? 0,
      additionalCostsNote: additionalNote,
      roundOff,
      notes,
      updatePurchasePrices: updatePrices,
      expectedGrandTotal: calc.grandTotal,
    };
    try {
      if (existing) {
        const r = await edit.mutateAsync({ ...fields, requestId, id: existing.purchase.id, reason: reason.trim() });
        toast.success(`Saved as ${r.purchaseNo}`, `${existing.purchase.purchaseNo} is kept in the history.`);
        navigate(`/suppliers/purchases/${r.purchaseId}`, { replace: true });
        return;
      }
      const r = await create.mutateAsync({ ...fields, requestId, payments: toPayments(payments), scannedFrom: scan?.fileName });
      toast.success(`Purchase ${r.purchaseNo} saved`, r.outstanding > 0 ? `${formatMoney(r.outstanding)} to pay ${supplier.name}` : 'Fully paid');
      navigate(`/suppliers/purchases/${r.purchaseId}`, { replace: true });
    } catch (e) {
      setError(errorMessage(e));
      // A changed request (e.g. corrected bill number) must not be mistaken for the failed one.
      setRequestId(newRequestId());
    }
  };

  return (
    <>
      {existing ? (
        <Link to={`/suppliers/purchases/${existing.purchase.id}`} className="mb-3 inline-flex items-center gap-1 text-ink-2 hover:text-ink">
          <ArrowLeft className="size-4" /> {existing.purchase.purchaseNo}
        </Link>
      ) : (
        <Link to="/suppliers" className="mb-3 inline-flex items-center gap-1 text-ink-2 hover:text-ink">
          <ArrowLeft className="size-4" /> Suppliers & Purchases
        </Link>
      )}
      {existing ? (
        <PageHeader
          title={`Edit ${existing.purchase.purchaseNo}`}
          description="Correct anything on the bill. Saving records the corrected bill as a new version and keeps this one, unchanged, in the history."
        />
      ) : (
        <PageHeader
          title="New purchase"
          description="Copy the supplier's bill. Stock is added at the bill's cost when you save."
          actions={
            ai.data?.ready && can('purchases.manage') ? (
              <Button
                variant="outline"
                icon={<ScanText className="size-4" />}
                busy={scanMutation.isPending}
                onClick={() => (lines.length || pending.length ? setConfirmScan(true) : void runScan())}
              >
                {scanMutation.isPending ? 'Reading the bill…' : "Scan supplier's bill…"}
              </Button>
            ) : undefined
          }
        />
      )}
      {scanError && (
        <div className="mb-5">
          <ErrorBanner title="The bill could not be read" message={scanError} />
        </div>
      )}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_400px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Card>
            <CardHeader title="Supplier's bill" />
            <div className="grid grid-cols-2 gap-4 p-5 lg:grid-cols-4">
              <div className="col-span-2 flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2">
                {supplier ? (
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink">{supplier.name}</p>
                    <p className="text-[13px] text-ink-3">
                      {supplier.gstin ? `GSTIN ${supplier.gstin}` : 'Not GST registered'}
                      {supplier.stateCode && ` · ${stateName(supplier.stateCode)}`}
                    </p>
                  </div>
                ) : scan && (scan.supplier.name || scan.supplier.gstin) ? (
                  <div className="min-w-0">
                    <p className="truncate text-ink-2">
                      On the bill: <span className="font-medium text-ink">{scan.supplier.name || scan.supplier.gstin}</span>
                    </p>
                    {can('suppliers.manage') && (
                      <button type="button" className="text-[13px] font-medium text-brand hover:underline" onClick={() => setAddingSupplier(true)}>
                        Add as a new supplier…
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="text-ink-3">No supplier chosen</p>
                )}
                <Button variant={supplier ? 'outline' : 'primary'} icon={<Truck className="size-4" />} onClick={() => setPicking(true)}>
                  {supplier ? 'Change' : 'Choose supplier'}
                </Button>
              </div>
              <Field label="Their bill number">{(p) => <Input {...p} value={billNo} onChange={(e) => setBillNo(e.target.value)} maxLength={40} />}</Field>
              <Field label="Bill date" required>
                {(p) => <Input {...p} type="date" value={billDate} max={businessDateOf(new Date())} onChange={(e) => setBillDate(e.target.value)} />}
              </Field>
              <div className="col-span-2 lg:col-span-4">
                <Checkbox checked={includesTax} onChange={setIncludesTax} label="Rates on the bill include GST" />
              </div>
            </div>
          </Card>

          {pending.length > 0 && catalog.data && s && (
            <NewItemsCard
              items={pending}
              catalog={catalog.data}
              supplierId={supplier?.id ?? null}
              billLabel={`${supplier?.name ?? scan?.supplier.name ?? 'the supplier'}'s bill${billNo ? ` ${billNo}` : ''}`}
              pricesIncludeTax={s.tax.pricesIncludeTax}
              canAddProducts={can('products.manage')}
              onChange={setPending}
              onResolved={resolvePending}
              onSkip={skipPending}
            />
          )}

          <Card>
            <CardHeader title="Items" description={supplier && !registered ? 'This supplier is not GST registered, so no GST is charged.' : undefined} />
            <div className="p-4">
              <ProductSearch ref={search} mode="purchase" onAdd={add} />
            </div>
            {lines.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="bg-surface-2 text-[12px] tracking-wide text-ink-3 uppercase">
                    <tr>
                      <th className="min-w-56 px-4 py-2">Item</th>
                      <th className="w-32 px-2 py-2 text-right">Qty</th>
                      <th className="w-36 px-2 py-2 text-right">Rate</th>
                      <th className="w-28 px-2 py-2">GST</th>
                      <th className="w-20 px-2 py-2 text-right">Disc %</th>
                      <th className="px-2 py-2 text-right">Amount</th>
                      <th className="w-10" />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => {
                      const i = ready.indexOf(l);
                      const r = i === -1 ? null : bill.lines[i]!;
                      const landed = landedOf(l);
                      return (
                        <tr key={l.key} className="border-t border-line align-top">
                          <td className="px-4 py-2">
                            <span className="font-medium text-ink">{l.product.name}</span>
                            {l.scan && (
                              <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
                                <span className="truncate">On the bill: {l.scan.text}</span>
                                {l.scan.match?.product.id === l.product.id ? (
                                  <Badge tone={l.scan.match.how === 'BEST' ? 'warning' : 'success'}>{HOW_LABEL[l.scan.match.how]}</Badge>
                                ) : null}
                                <button type="button" className="font-medium text-brand hover:underline" onClick={() => unlink(l)}>
                                  Not this product
                                </button>
                              </span>
                            )}
                            <span className="block text-[12px] text-ink-3">
                              <span className="font-mono">{l.product.sku}</span> · {formatQty(l.product.qty)} {l.product.unitCode} in stock
                              {landed !== null && l.qty ? ` · lands at ${formatMoney(Math.round((landed * 1000) / l.qty))}/${l.product.unitCode}` : ''}
                            </span>
                          </td>
                          <td className="px-2 py-2">
                            <QtyInput
                              aria-label={`Quantity of ${l.product.name}`}
                              className="h-9"
                              value={l.qty}
                              allowDecimal={l.product.allowDecimal}
                              unit={l.product.unitCode}
                              onValueChange={(v) => update(l.key, { qty: v })}
                            />
                          </td>
                          <td className="px-2 py-2">
                            <MoneyInput aria-label={`Rate of ${l.product.name}`} className="h-9" value={l.unitCost} onValueChange={(v) => update(l.key, { unitCost: v })} />
                          </td>
                          <td className="px-2 py-2">
                            <select
                              aria-label={`GST rate of ${l.product.name}`}
                              className="h-9 w-full rounded-md border border-line-strong bg-surface px-2 disabled:bg-surface-2"
                              value={registered ? l.gstRateBp : 0}
                              disabled={!registered}
                              onChange={(e) => update(l.key, { gstRateBp: Number(e.target.value) })}
                            >
                              {GST_RATES_BP.map((bp) => (
                                <option key={bp} value={bp}>
                                  {formatRate(bp)}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="px-2 py-2">
                            <Input
                              aria-label={`Discount on ${l.product.name}`}
                              className="h-9 text-right"
                              type="number"
                              min={0}
                              max={100}
                              step={0.5}
                              value={l.discountBp ? l.discountBp / 100 : ''}
                              onChange={(e) => update(l.key, { discountBp: Math.round(Math.max(0, Math.min(100, Number(e.target.value) || 0)) * 100) })}
                            />
                          </td>
                          <td className="tabular px-2 py-2 text-right whitespace-nowrap">
                            {r ? formatMoney(r.lineTotal) : '—'}
                            {r && r.cgst + r.sgst + r.igst > 0 && <span className="block text-[12px] text-ink-3">incl. GST {formatMoney(r.cgst + r.sgst + r.igst)}</span>}
                          </td>
                          <td className="py-2 pr-2">
                            <button
                              type="button"
                              aria-label={`Remove ${l.product.name}`}
                              className="rounded p-1.5 text-ink-3 hover:bg-surface-2 hover:text-danger"
                              onClick={() => removeLine(l)}
                            >
                              <Trash2 className="size-4" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Other charges and notes" description="Freight, loading and similar charges on the bill are spread over the items, so their cost includes them." />
            <div className="grid grid-cols-2 gap-4 p-5">
              <Field label="Freight / other charges">{(p) => <MoneyInput {...p} value={additional} onValueChange={(v) => setAdditional(v)} />}</Field>
              <Field label="What the charges are for">
                {(p) => <Input {...p} value={additionalNote} onChange={(e) => setAdditionalNote(e.target.value)} maxLength={120} placeholder="e.g. Transport from Bhiwandi" />}
              </Field>
              <Field label="Notes" className="col-span-2">
                {(p) => <Textarea {...p} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />}
              </Field>
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          {scan && (
            <ScannedBillCard
              draft={scan}
              calculatedTotal={calc.grandTotal}
              pendingCount={pending.length}
              skipped={skipped}
              onPutBack={(l) => {
                setSkipped((ss) => ss.filter((x) => x !== l));
                if (catalog.data) setPending((ps) => [...ps, pendingFrom(l, catalog.data!)]);
              }}
            />
          )}
          <Card>
            <CardHeader title="Bill total" />
            <div className="flex flex-col gap-1.5 p-5">
              <Row label="Items" value={formatMoney(bill.grossTotal)} />
              {bill.discountTotal > 0 && <Row label="Discount" value={`− ${formatMoney(bill.discountTotal)}`} />}
              <Row label="Taxable value" value={formatMoney(bill.taxableTotal)} />
              {interstate ? <Row label="IGST" value={formatMoney(bill.igstTotal)} /> : <Row label="CGST + SGST" value={formatMoney(bill.cgstTotal + bill.sgstTotal)} />}
              {(additional ?? 0) > 0 && <Row label="Freight / other charges" value={formatMoney(additional!)} />}
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-2">Round-off</span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    className="text-[13px] font-medium text-brand hover:underline"
                    onClick={() => setRoundOff(roundToRupee(calc.grandTotal - roundOff) - (calc.grandTotal - roundOff))}
                  >
                    to rupee
                  </button>
                  <Input
                    aria-label="Round-off in paise"
                    className={cn('h-8 w-24 text-right', Math.abs(roundOff) > maxRoundOff && 'border-danger')}
                    type="number"
                    step={0.01}
                    value={roundOff ? roundOff / 100 : ''}
                    placeholder="0.00"
                    onChange={(e) => setRoundOff(Math.round((Number(e.target.value) || 0) * 100))}
                  />
                </div>
              </div>
              <div className="mt-1 flex items-center justify-between border-t border-line pt-2 text-[17px] font-semibold">
                <span>Total</span>
                <span className="tabular" data-testid="purchase-total">
                  {formatMoney(calc.grandTotal)}
                </span>
              </div>
              <p className="mt-1 rounded-md bg-surface-2 px-3 py-2 text-[13px] text-ink-2">
                {!supplier
                  ? 'Choose the supplier to see how GST is treated.'
                  : itc
                    ? `Input GST ${formatMoney(tax)} is claimable and kept out of the stock cost. Stock value added: ${formatMoney(calc.inventoryValue)}.`
                    : `${tax > 0 ? `GST ${formatMoney(tax)} is part of the cost. ` : ''}Stock value added: ${formatMoney(calc.inventoryValue)}.`}
              </p>
            </div>
          </Card>
          {!existing && can('suppliers.pay') && (
            <Card>
              <div className="p-5">
                <PaymentLines label="Paid now (optional)" due={calc.grandTotal} value={payments} onChange={setPayments} remainder="is owed to the supplier" />
              </div>
            </Card>
          )}
          <Card>
            <div className="flex flex-col gap-3 p-5">
              <Checkbox checked={updatePrices} onChange={setUpdatePrices} label="Set each product's purchase price to its new cost" />
              {existing && (
                <Field label="Why is the bill being changed?" required hint="Saved in the history with your name.">
                  {(p) => (
                    <Textarea {...p} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. Wrong rate entered for the drill bits" />
                  )}
                </Field>
              )}
              {error && <ErrorBanner title="Not saved" message={error} />}
              {problems.length > 0 && lines.length > 0 && <p className="text-[13px] text-ink-3">{problems[0]}.</p>}
              <Button size="lg" busy={create.isPending || edit.isPending} disabled={problems.length > 0} onClick={save}>
                {existing ? 'Save changes' : 'Save purchase'} · {formatMoney(calc.grandTotal)}
              </Button>
            </div>
          </Card>
        </div>
      </div>
      {confirmScan && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirmScan(false)}
          title="Replace what is entered?"
          description="Scanning a bill fills the form from the bill, replacing the supplier and items entered so far."
          confirmLabel="Scan and replace"
          onConfirm={runScan}
        />
      )}
      {addingSupplier && scan && (
        <SupplierFormDialog
          supplier={null}
          initial={{ name: scan.supplier.name, phone: scan.supplier.phone, address: scan.supplier.address, gstin: scan.supplier.gstin, stateCode: scan.supplier.stateCode }}
          onClose={() => setAddingSupplier(false)}
          onSaved={(x) => {
            setAddingSupplier(false);
            chooseSupplier(x);
          }}
        />
      )}
      {picking && <SupplierPicker onClose={() => setPicking(false)} onPick={(x: SupplierRow | SupplierDetail) => chooseSupplier(x)} />}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-ink-2">{label}</span>
      <span className="tabular">{value}</span>
    </div>
  );
}
