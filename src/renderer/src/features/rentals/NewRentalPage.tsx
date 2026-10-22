import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Trash2, UserRound } from 'lucide-react';
import { computeBill } from '@shared/billing';
import type { CustomerDetail, CustomerRow, DiscountInput, ProductListRow } from '@shared/contracts';
import { formatMoney } from '@shared/money';
import { formatQty } from '@shared/qty';
import { describeDuration } from '@shared/rentalPricing';
import { call, errorMessage, useCommandQuery } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { useDebounced } from '../../lib/useDebounced';
import { Button } from '../../components/ui/button';
import { Field, Input, Select } from '../../components/ui/form';
import { Card, CardHeader, ErrorBanner } from '../../components/ui/layout';
import { MoneyInput, QtyInput, newRequestId } from '../../components/ui/numberInputs';
import { cn } from '../../lib/cn';
import { BalanceText, CustomerPicker } from '../customers/CustomerPicker';
import { DiscountDialog } from '../sales/DiscountDialog';
import { ProductSearch } from '../sales/ProductSearch';
import { fromLocalInput, PaymentLines, toLocalInput, toPayments, type PaymentEntry } from './shared';

interface Chosen {
  assetId: number;
  assetTag: string;
  productName: string;
}

interface SaleLine {
  product: ProductListRow;
  qty: number;
}

const HOUR = 3_600_000;

export function NewRentalPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const can = useCan();
  const session = useSession();
  const qc = useQueryClient();
  const settings = useCommandQuery('settings.get');
  const products = useCommandQuery('rentalProducts.list', { active: 'ACTIVE' });
  const methods = useCommandQuery('paymentMethods.list', {});

  const [customer, setCustomer] = useState<(CustomerRow | CustomerDetail) | null>(null);
  const [picking, setPicking] = useState(false);
  const [reserve, setReserve] = useState(false);
  const [startLocal, setStartLocal] = useState(() => toLocalInput(new Date(Date.now() + 24 * HOUR).toISOString()));
  const [returnLocal, setReturnLocal] = useState(() => toLocalInput(new Date(Date.now() + 24 * HOUR).toISOString()));
  const [productId, setProductId] = useState<number | null>(null);
  const [unitId, setUnitId] = useState<number | null>(null);
  const [chosen, setChosen] = useState<Chosen[]>([]);
  const [discount, setDiscount] = useState<DiscountInput>(null);
  const [editingDiscount, setEditingDiscount] = useState(false);
  const [depositOverride, setDepositOverride] = useState<number | null>(null);
  const [depositMethod, setDepositMethod] = useState<number | null>(null);
  const [payments, setPayments] = useState<PaymentEntry[]>([]);
  const [notes, setNotes] = useState('');
  const [saleLines, setSaleLines] = useState<SaleLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(newRequestId);

  // A fixed "now" for availability while handing over, so queries do not change on every render.
  const [openedAt] = useState(() => new Date().toISOString());
  const startIso = reserve ? fromLocalInput(startLocal) : openedAt;
  const endIso = fromLocalInput(returnLocal);
  const datesOk = !!startIso && !!endIso && endIso > startIso;
  const quoteKey = JSON.stringify({
    customerId: customer?.id,
    assetIds: chosen.map((c) => c.assetId),
    startAt: reserve ? (startIso ?? undefined) : undefined,
    expectedReturnAt: endIso ?? '',
    reserve,
    discount,
  });
  const quoteInput = JSON.parse(useDebounced(quoteKey, 250)) as {
    customerId?: number;
    assetIds: number[];
    startAt?: string;
    expectedReturnAt: string;
    reserve: boolean;
    discount: DiscountInput;
  };
  const quote = useCommandQuery('rentals.quote', quoteInput, {
    enabled: quoteInput.assetIds.length > 0 && !!quoteInput.expectedReturnAt && datesOk,
    placeholderData: (p) => p,
  });
  const available = useCommandQuery(
    'rentals.available',
    { productId: productId ?? 0, startAt: startIso ?? '', endAt: endIso ?? '' },
    { enabled: !!productId && datesOk },
  );
  const freeUnits = (available.data ?? []).filter((a) => !chosen.some((c) => c.assetId === a.id));

  const interstate = !!customer && !!customer.stateCode && customer.stateCode !== settings.data?.shop.stateCode;
  const sale = useMemo(
    () =>
      computeBill(
        saleLines.map((l) => ({ unitPrice: l.product.sellingPrice, qty: l.qty, gstRateBp: l.product.gstRateBp, priceIncludesTax: l.product.priceIncludesTax })),
        { interstate, gstRegistered: settings.data?.tax.gstRegistered ?? true, roundTotal: settings.data?.tax.roundInvoiceTotal ?? true },
      ),
    [saleLines, interstate, settings.data],
  );

  const chargesNow = quote.data?.billNow.grandTotal ?? 0;
  const deposit = depositOverride ?? quote.data?.depositTotal ?? 0;
  const dueNow = chargesNow + (saleLines.length ? sale.grandTotal : 0);
  const paid = payments.reduce((a, p) => a + (p.amount ?? 0), 0);
  const method = depositMethod ?? methods.data?.[0]?.id ?? null;

  const problems: string[] = [];
  if (!customer) problems.push('Choose the customer.');
  if (!datesOk) problems.push('The return time must be after the start.');
  if (reserve && startIso && startIso <= new Date().toISOString()) problems.push('A reservation must start in the future.');
  if (chosen.length === 0) problems.push('Add at least one unit.');
  if (paid > dueNow) problems.push('Payments are more than what is due now.');
  if (reserve && saleLines.length > 0) problems.push('Products can only be sold when the rental is issued.');

  const addUnit = () => {
    const unit = freeUnits.find((u) => u.id === unitId) ?? freeUnits[0];
    if (!unit) {
      toast.warning('No unit free', 'Every unit of this item is out, reserved or not usable for these dates.');
      return;
    }
    setChosen((c) => [...c, { assetId: unit.id, assetTag: unit.assetTag, productName: unit.productName }]);
    setUnitId(null);
  };

  const quickReturn = (hours: number) => {
    const base = reserve && startIso ? Date.parse(startIso) : Date.now();
    setReturnLocal(toLocalInput(new Date(base + hours * HOUR).toISOString()));
  };

  const submit = async () => {
    if (problems.length || !customer || !endIso) return;
    setBusy(true);
    setError(null);
    try {
      const r = await call('rentals.create', {
        requestId,
        customerId: customer.id,
        assetIds: chosen.map((c) => c.assetId),
        reserve,
        startAt: reserve ? (startIso ?? undefined) : undefined,
        expectedReturnAt: endIso,
        discount,
        expectedChargesTotal: reserve ? 0 : chargesNow,
        deposit: reserve ? { amount: 0, reference: '' } : { amount: deposit, methodId: method ?? undefined, reference: '' },
        payments: reserve ? [] : toPayments(payments),
        notes,
        terms: '',
        saleLines: saleLines.map((l) => ({ productId: l.product.id, qty: l.qty, discount: null, expectedUnitPrice: l.product.sellingPrice })),
        expectedSaleTotal: saleLines.length ? sale.grandTotal : 0,
      });
      await qc.invalidateQueries({ predicate: (q) => ['rentals', 'rentalAssets', 'rentalProducts', 'invoices', 'customers', 'receivables', 'payments', 'products', 'stock', 'audit', 'sales'].some((p) => String(q.queryKey[0]).startsWith(p)) });
      toast.success(reserve ? `Reservation ${r.rentalNo} made` : `Rental ${r.rentalNo} issued`, [r.invoiceNo, r.saleInvoiceNo].filter(Boolean).join(' · ') || undefined);
      navigate(`/rentals/${r.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setRequestId(newRequestId());
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Link to="/rentals" className="mb-3 inline-flex items-center gap-1 text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Rentals
      </Link>
      <h1 className="mb-5 font-display text-[22px] font-semibold text-ink">New rental</h1>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_400px]">
        <div className="flex flex-col gap-5">
          <Card className="p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex size-9 items-center justify-center rounded-full bg-surface-2 text-ink-3">
                  <UserRound className="size-5" />
                </div>
                {customer ? (
                  <div>
                    <p className="font-semibold text-ink">{customer.name}</p>
                    <p className="text-[13px]">
                      <span className="mr-2 text-ink-3">{customer.phone}</span>
                      <BalanceText balance={customer.balance} />
                    </p>
                  </div>
                ) : (
                  <p className="text-ink-2">Rentals need a registered customer so the shop can follow up.</p>
                )}
              </div>
              <Button variant={customer ? 'outline' : 'primary'} onClick={() => setPicking(true)}>
                {customer ? 'Change' : 'Choose customer'}
              </Button>
            </div>
          </Card>

          <Card>
            <CardHeader title="When" />
            <div className="flex flex-col gap-4 p-4">
              <div role="radiogroup" aria-label="Rental type" className="grid grid-cols-2 gap-1 rounded-md bg-surface-2 p-1">
                {[
                  { v: false, l: 'Hand over now' },
                  { v: true, l: 'Reserve for later' },
                ].map((o) => (
                  <button
                    key={o.l}
                    type="button"
                    role="radio"
                    aria-checked={reserve === o.v}
                    onClick={() => setReserve(o.v)}
                    className={cn('rounded py-1.5 font-medium', reserve === o.v ? 'bg-surface text-ink shadow-card' : 'text-ink-3')}
                  >
                    {o.l}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-4">
                {reserve ? (
                  <Field label="Starts">{(p) => <Input {...p} type="datetime-local" value={startLocal} onChange={(e) => setStartLocal(e.target.value)} />}</Field>
                ) : (
                  <Field label="Starts">{(p) => <Input {...p} value="Now, when saved" disabled />}</Field>
                )}
                <Field label="Return by" hint={datesOk && startIso && endIso ? describeDuration(Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60_000)) : undefined}>
                  {(p) => <Input {...p} type="datetime-local" value={returnLocal} onChange={(e) => setReturnLocal(e.target.value)} />}
                </Field>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[
                  ['+4 hours', 4],
                  ['+1 day', 24],
                  ['+2 days', 48],
                  ['+1 week', 168],
                  ['+2 weeks', 336],
                ].map(([l, h]) => (
                  <Button key={l} size="sm" variant="ghost" onClick={() => quickReturn(h as number)}>
                    {l}
                  </Button>
                ))}
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Equipment" description="Only units free for the whole period are offered." />
            <div className="flex flex-col gap-3 p-4">
              <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                <Select aria-label="Rental item" value={productId ?? ''} onChange={(e) => (setProductId(e.target.value ? Number(e.target.value) : null), setUnitId(null))}>
                  <option value="">Choose an item…</option>
                  {products.data?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.unitsAvailable} available)
                    </option>
                  ))}
                </Select>
                <Select aria-label="Unit" value={unitId ?? ''} disabled={!productId} onChange={(e) => setUnitId(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">{productId && available.data ? `Any free unit (${freeUnits.length})` : 'Unit'}</option>
                  {freeUnits.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.assetTag}
                      {u.serialNo ? ` · ${u.serialNo}` : ''}
                    </option>
                  ))}
                </Select>
                <Button icon={<Plus className="size-4" />} disabled={!productId || !datesOk} onClick={addUnit}>
                  Add unit
                </Button>
              </div>
              {chosen.length > 0 && (
                <table className="w-full">
                  <tbody>
                    {chosen.map((c) => {
                      const q = quote.data?.items.find((i) => i.assetId === c.assetId);
                      return (
                        <tr key={c.assetId} className="border-t border-line">
                          <td className="py-2">
                            <span className="font-medium">{c.productName}</span> <span className="font-mono text-[13px] text-ink-3">{c.assetTag}</span>
                            {q && <span className="block text-[13px] text-ink-3">{q.price.explanation}</span>}
                          </td>
                          <td className="tabular py-2 text-right font-semibold">{q ? formatMoney(q.price.total) : '…'}</td>
                          <td className="w-10 py-2 text-right">
                            <button type="button" aria-label={`Remove ${c.assetTag}`} className="rounded p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger" onClick={() => setChosen((x) => x.filter((y) => y.assetId !== c.assetId))}>
                              <Trash2 className="size-4" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </Card>

          {!reserve && (
            <Card>
              <CardHeader title="Also selling products? (optional)" description="They go on a separate sales invoice linked to this rental." />
              <div className="flex flex-col gap-2 p-4">
                <ProductSearch onAdd={(p, qty) => setSaleLines((ls) => [...ls, { product: p, qty }])} />
                {saleLines.map((l, i) => (
                  <div key={`${l.product.id}-${i}`} className="grid grid-cols-[1fr_140px_100px_32px] items-center gap-2">
                    <span>
                      {l.product.name} <span className="text-[13px] text-ink-3">{formatMoney(l.product.sellingPrice)} · {formatQty(l.product.qty)} in stock</span>
                    </span>
                    <QtyInput aria-label={`Quantity of ${l.product.name}`} value={l.qty} allowDecimal={l.product.allowDecimal} unit={l.product.unitCode} className="h-9" onValueChange={(v) => v && v > 0 && setSaleLines((ls) => ls.map((x, k) => (k === i ? { ...x, qty: v } : x)))} />
                    <span className="tabular text-right font-semibold">{formatMoney(sale.lines[i]?.lineTotal ?? 0)}</span>
                    <button type="button" aria-label="Remove product" className="rounded p-1.5 text-ink-3 hover:bg-surface-2" onClick={() => setSaleLines((ls) => ls.filter((_, k) => k !== i))}>
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <Card className="p-4">
            <p className="mb-2 font-semibold text-ink">{reserve ? 'Estimated charges' : 'Due now'}</p>
            {quote.data ? (
              <dl className="tabular flex flex-col gap-1">
                {reserve || quote.data.billing === 'AT_RETURN' ? (
                  <p className="text-[13px] text-ink-2">
                    {reserve ? 'Charges and the deposit are taken when the reservation is handed over.' : 'This shop bills rentals on return.'} Estimated rental:{' '}
                    {formatMoney(quote.data.items.reduce((a, i) => a + i.price.total, 0))}.
                  </p>
                ) : (
                  <>
                    <Row label="Rental charges" value={formatMoney(quote.data.billNow.grossTotal)} />
                    {(quote.data.billNow.discountTotal > 0 || can('sales.discount')) && (
                      <div className="flex justify-between">
                        <dt className="text-ink-2">
                          Discount{' '}
                          {can('sales.discount') && (
                            <button type="button" className="text-[13px] font-medium text-brand hover:underline" onClick={() => setEditingDiscount(true)}>
                              change
                            </button>
                          )}
                        </dt>
                        <dd>− {formatMoney(quote.data.billNow.discountTotal)}</dd>
                      </div>
                    )}
                    <Row label="GST" value={formatMoney(quote.data.billNow.cgstTotal + quote.data.billNow.sgstTotal + quote.data.billNow.igstTotal)} muted />
                    <Row label="Rental total" value={formatMoney(chargesNow)} strong />
                    {saleLines.length > 0 && <Row label="Products sold" value={formatMoney(sale.grandTotal)} strong />}
                  </>
                )}
                <p className="mt-1 text-[12px] text-ink-3">
                  {quote.data.pricingMode === 'CHEAPEST' ? 'Cheapest combination of rates' : quote.data.pricingMode === 'DAILY' ? 'Daily rate' : 'Chosen rate'} ·{' '}
                  {quote.data.graceMinutes} min grace
                </p>
              </dl>
            ) : (
              <p className="text-ink-3">Add units to see the price.</p>
            )}
          </Card>

          {!reserve && (
            <Card className="p-4">
              <p className="mb-2 font-semibold text-ink">Security deposit</p>
              <p className="mb-3 text-[13px] text-ink-3">Held for the customer and refunded or used for charges on return. It is not income.</p>
              <div className="grid grid-cols-2 gap-2">
                <MoneyInput aria-label="Deposit amount" value={deposit} onValueChange={(v) => setDepositOverride(v ?? 0)} />
                <Select aria-label="Deposit paid by" value={method ?? ''} onChange={(e) => setDepositMethod(Number(e.target.value))}>
                  {methods.data?.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </div>
            </Card>
          )}

          {!reserve && dueNow > 0 && (
            <Card className="p-4">
              <PaymentLines due={dueNow} value={payments} onChange={setPayments} label="Payment for charges" />
            </Card>
          )}

          <Field label="Notes">{(p) => <Input {...p} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="e.g. site address, ID seen" />}</Field>
          {error && <ErrorBanner title="Not saved" message={error} />}
          {problems.length > 0 && chosen.length > 0 && <p className="text-[13px] text-ink-3">{problems[0]}</p>}
          <Button size="lg" className="h-14 text-[17px]" busy={busy} disabled={problems.length > 0 || quote.isFetching} onClick={submit}>
            {reserve ? 'Reserve' : `Issue rental${deposit + dueNow > 0 ? ` · collect ${formatMoney(deposit + paid)}` : ''}`}
          </Button>
        </div>
      </div>

      {picking && (
        <CustomerPicker
          includeWalkin={false}
          onClose={() => setPicking(false)}
          onPick={(c) => {
            setCustomer(c);
            setPicking(false);
          }}
        />
      )}
      {editingDiscount && quote.data && (
        <DiscountDialog
          title="Discount on rental charges"
          base={quote.data.billNow.grossTotal}
          value={discount}
          maxDiscountBp={session.maxDiscountBp}
          onClose={() => setEditingDiscount(false)}
          onSave={(d) => {
            setDiscount(d);
            setEditingDiscount(false);
          }}
        />
      )}
    </>
  );
}

function Row({ label, value, muted, strong }: { label: string; value: string; muted?: boolean; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className={muted ? 'text-ink-3' : 'text-ink-2'}>{label}</dt>
      <dd className={cn(muted ? 'text-ink-3' : 'text-ink', strong && 'font-semibold')}>{value}</dd>
    </div>
  );
}
