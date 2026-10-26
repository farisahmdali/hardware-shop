import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Trash2, Truck } from 'lucide-react';
import type { ProductListRow, SupplierDetail, SupplierRow } from '@shared/contracts';
import { formatMoney, roundToRupee } from '@shared/money';
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
import { Card, CardHeader, ErrorBanner, PageHeader } from '../../components/ui/layout';
import { MoneyInput, QtyInput, newRequestId } from '../../components/ui/numberInputs';
import { cn } from '../../lib/cn';
import { ProductSearch, type ProductSearchHandle } from '../sales/ProductSearch';
import { PaymentLines, toPayments, type PaymentEntry } from '../rentals/shared';
import { SupplierPicker } from './SupplierPicker';
import { SUPPLIER_INVALIDATE } from './shared';

interface Line {
  key: string;
  product: ProductListRow;
  qty: number | null;
  unitCost: number | null;
  gstRateBp: number;
  /** Discount in basis points of the line amount. */
  discountBp: number;
}

type SupplierInfo = Pick<SupplierRow, 'id' | 'name' | 'gstin' | 'stateCode'>;

/** Enter a supplier's bill: stock comes in at landed cost and the amount is owed to the supplier. */
export function NewPurchasePage() {
  const navigate = useNavigate();
  const toast = useToast();
  const can = useCan();
  const [params] = useSearchParams();
  const settings = useCommandQuery('settings.get');
  const preset = Number(params.get('supplier')) || null;
  const presetSupplier = useCommandQuery('suppliers.get', { id: preset ?? 0 }, { enabled: preset !== null });
  const search = useRef<ProductSearchHandle>(null);

  const [supplier, setSupplier] = useState<SupplierInfo | null>(null);
  const [picking, setPicking] = useState(false);
  const [billNo, setBillNo] = useState('');
  const [billDate, setBillDate] = useState(() => businessDateOf(new Date()));
  const [includesTax, setIncludesTax] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [additional, setAdditional] = useState<number | null>(null);
  const [additionalNote, setAdditionalNote] = useState('');
  const [roundOff, setRoundOff] = useState(0);
  const [notes, setNotes] = useState('');
  const [payments, setPayments] = useState<PaymentEntry[]>([]);
  const [updatePrices, setUpdatePrices] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(newRequestId);
  const create = useCommandMutation('purchases.create', { invalidate: SUPPLIER_INVALIDATE });

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
        { pricesIncludeTax: includesTax, interstate, billDiscount: null, additionalCosts: additional ?? 0, roundOff, itcClaimed: itc },
      ),
    [ready, registered, includesTax, interstate, additional, roundOff, itc],
  );
  const { bill } = calc;
  const tax = bill.cgstTotal + bill.sgstTotal + bill.igstTotal;
  const maxRoundOff = s?.purchases.maxRoundOff ?? 1000;
  const paid = payments.reduce((a, p) => a + (p.amount ?? 0), 0);
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

  const problems: string[] = [];
  if (!supplier) problems.push('Choose the supplier');
  if (lines.length === 0) problems.push('Add the items on the bill');
  if (lines.length !== ready.length) problems.push('Every item needs a quantity and a rate');
  if (Math.abs(roundOff) > maxRoundOff) problems.push(`Round-off can be at most ${formatMoney(maxRoundOff)}`);
  if (paid > calc.grandTotal) problems.push('Payments are more than the bill total');

  const save = async () => {
    if (!supplier || problems.length) return;
    setError(null);
    try {
      const r = await create.mutateAsync({
        requestId,
        supplierId: supplier.id,
        supplierInvoiceNo: billNo,
        supplierInvoiceDate: billDate,
        pricesIncludeTax: includesTax,
        lines: ready.map((l) => ({
          productId: l.product.id,
          qty: l.qty!,
          unitCost: l.unitCost!,
          gstRateBp: registered ? l.gstRateBp : 0,
          discount: l.discountBp ? { type: 'PERCENT', valueBp: l.discountBp } : null,
        })),
        billDiscount: null,
        additionalCosts: additional ?? 0,
        additionalCostsNote: additionalNote,
        roundOff,
        notes,
        payments: toPayments(payments),
        updatePurchasePrices: updatePrices,
        expectedGrandTotal: calc.grandTotal,
      });
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
      <Link to="/suppliers" className="mb-3 inline-flex items-center gap-1 text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Suppliers & Purchases
      </Link>
      <PageHeader title="New purchase" description="Copy the supplier's bill. Stock is added at the bill's cost when you save." />
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
                      <th className="w-32 px-2 py-2 text-right">Rate</th>
                      <th className="w-24 px-2 py-2">GST</th>
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
                              onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
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
          {can('suppliers.pay') && (
            <Card>
              <div className="p-5">
                <PaymentLines label="Paid now (optional)" due={calc.grandTotal} value={payments} onChange={setPayments} remainder="is owed to the supplier" />
              </div>
            </Card>
          )}
          <Card>
            <div className="flex flex-col gap-3 p-5">
              <Checkbox checked={updatePrices} onChange={setUpdatePrices} label="Set each product's purchase price to its new cost" />
              {error && <ErrorBanner title="Not saved" message={error} />}
              {problems.length > 0 && lines.length > 0 && <p className="text-[13px] text-ink-3">{problems[0]}.</p>}
              <Button size="lg" busy={create.isPending} disabled={problems.length > 0} onClick={save}>
                Save purchase · {formatMoney(calc.grandTotal)}
              </Button>
            </div>
          </Card>
        </div>
      </div>
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
