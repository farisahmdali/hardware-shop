import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, PauseCircle, Percent, Plus, ShoppingCart, Trash2, UserRound, X } from 'lucide-react';
import { computeBill } from '@shared/billing';
import { formatMoney, mulDivRound } from '@shared/money';
import { formatQty } from '@shared/qty';
import type { CustomerDetail, CustomerRow, DiscountInput, PaymentMethodRow } from '@shared/contracts';
import { ApiError, call, errorMessage, useCommandQuery } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Checkbox, Field, Input } from '../../components/ui/form';
import { Card, EmptyState, ErrorBanner } from '../../components/ui/layout';
import { MoneyInput, QtyInput } from '../../components/ui/numberInputs';
import { ConfirmDialog, Dialog } from '../../components/ui/dialog';
import { cn } from '../../lib/cn';
import { BalanceText, CustomerPicker } from '../customers/CustomerPicker';
import { cart, useCart, type CartCustomer } from './cartStore';
import { ProductSearch, type ProductSearchHandle } from './ProductSearch';
import { DiscountDialog } from './DiscountDialog';
import { SaleCompleteDialog, type SaleResult } from './SaleCompleteDialog';
import { SalesTabs } from './SalesTabs';

interface PaymentEntry {
  key: string;
  methodId: number;
  amount: number | null;
  reference: string;
}

const discountLabel = (d: DiscountInput) => (!d ? '' : d.type === 'PERCENT' ? `${d.valueBp / 100}%` : formatMoney(d.value));

function toCartCustomer(c: CustomerRow | CustomerDetail): CartCustomer {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    stateCode: c.stateCode,
    isWalkin: c.isWalkin,
    balance: c.balance,
    availableCredit: 'availableCredit' in c ? c.availableCredit : Math.max(0, -c.balance),
    creditLimit: 'creditLimit' in c ? c.creditLimit : 0,
  };
}

export function BillingPage() {
  const state = useCart();
  const session = useSession();
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const settings = useCommandQuery('settings.get');
  const methods = useCommandQuery('paymentMethods.list', {});
  const walkInQuery = useCommandQuery('customers.list', { search: 'WALKIN', includeWalkin: true, pageSize: 5 });
  const walkIn = walkInQuery.data?.rows.find((c) => c.isWalkin);
  const search = useRef<ProductSearchHandle>(null);

  const [payments, setPayments] = useState<PaymentEntry[]>([]);
  const [useCredit, setUseCredit] = useState(false);
  const [cashReceived, setCashReceived] = useState<number | null>(null);
  const [override, setOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [picking, setPicking] = useState(false);
  const [discountFor, setDiscountFor] = useState<string | 'BILL' | null>(null);
  const [holding, setHolding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<SaleResult | null>(null);
  const [confirmNew, setConfirmNew] = useState(false);

  const customer = state.customer ?? (walkIn ? toCartCustomer(walkIn) : null);
  const isWalkin = !state.customer || state.customer.isWalkin;
  const shopState = settings.data?.shop.stateCode ?? '';
  const interstate = !isWalkin && !!customer?.stateCode && customer.stateCode !== shopState;

  const bill = useMemo(
    () =>
      computeBill(
        state.lines.map((l) => ({
          unitPrice: l.product.sellingPrice,
          qty: l.qty,
          gstRateBp: l.product.gstRateBp,
          priceIncludesTax: l.product.priceIncludesTax,
          discount: l.discount,
        })),
        {
          interstate,
          gstRegistered: settings.data?.tax.gstRegistered ?? true,
          roundTotal: settings.data?.tax.roundInvoiceTotal ?? true,
          billDiscount: state.billDiscount,
        },
      ),
    [state.lines, state.billDiscount, interstate, settings.data],
  );

  const creditUsed = useCredit && customer ? Math.min(customer.availableCredit, bill.grandTotal) : 0;
  const paid = payments.reduce((a, p) => a + (p.amount ?? 0), 0);
  const due = bill.grandTotal - creditUsed - paid;
  const cashPayment = payments.find((p) => methods.data?.find((m) => m.id === p.methodId)?.kind === 'CASH');
  const change = cashPayment && cashReceived !== null ? cashReceived - (cashPayment.amount ?? 0) : 0;

  const shortLines = state.lines.filter((l) => {
    const total = state.lines.filter((x) => x.product.id === l.product.id).reduce((a, x) => a + x.qty, 0);
    return total > l.product.stockQty;
  });
  const canOverride = !!settings.data?.stock.allowNegativeOverride && can('stock.overrideNegative');
  const maxDiscount = mulDivRound(bill.grossTotal, session.maxDiscountBp, 10_000);
  const overLimit = customer && !isWalkin && customer.creditLimit > 0 && customer.balance + Math.max(due, 0) > customer.creditLimit;

  const problems: string[] = [];
  if (state.lines.length === 0) problems.push('Add at least one item.');
  if (due < 0) problems.push('Payments are more than the bill. Enter only the amount kept; use "Cash received" for change.');
  if (isWalkin && due > 0) problems.push('Walk-in sales must be paid in full. Choose a customer to sell on credit.');
  if (bill.discountTotal > maxDiscount) problems.push(`Discount is above your limit of ${session.maxDiscountBp / 100}%.`);
  if (shortLines.length > 0 && !(override && overrideReason.trim().length >= 3)) problems.push('Some items are short of stock.');
  if (payments.some((p) => p.amount === null || p.amount <= 0)) problems.push('Enter an amount for each payment.');

  const newBill = useCallback(
    (force = false) => {
      if (!force && cart.get().lines.length > 0) {
        setConfirmNew(true);
        return;
      }
      setConfirmNew(false);
      cart.reset();
      setPayments([]);
      setUseCredit(false);
      setCashReceived(null);
      setOverride(false);
      setOverrideReason('');
      setError(null);
      setDone(null);
      setTimeout(() => search.current?.focus(), 0);
    },
    [],
  );

  const addPayment = (m: PaymentMethodRow) => {
    setPayments((ps) => [...ps, { key: crypto.randomUUID(), methodId: m.id, amount: Math.max(0, due), reference: '' }]);
  };

  const refreshPrices = async () => {
    for (const l of cart.get().lines) {
      const p = await call('products.get', { id: l.product.id });
      cart.updateLine(l.key, {
        product: { ...l.product, sellingPrice: p.sellingPrice, gstRateBp: p.gstRateBp, priceIncludesTax: p.priceIncludesTax, stockQty: p.qty },
      });
    }
    toast.success('Prices and stock refreshed', 'Check the total with the customer before saving.');
  };

  const finalize = async () => {
    if (problems.length > 0 || busy || !customer) return;
    setBusy(true);
    setError(null);
    try {
      const r = await call('sales.finalize', {
        requestId: state.billId,
        customerId: customer.id,
        walkInName: state.walkInName,
        walkInPhone: state.walkInPhone,
        lines: state.lines.map((l) => ({ productId: l.product.id, qty: l.qty, discount: l.discount, expectedUnitPrice: l.product.sellingPrice })),
        billDiscount: state.billDiscount,
        payments: payments.map((p) => ({ methodId: p.methodId, amount: p.amount ?? 0, reference: p.reference })),
        useCredit: creditUsed,
        notes: state.notes,
        expectedGrandTotal: bill.grandTotal,
        negativeStockReason: shortLines.length > 0 ? overrideReason.trim() : undefined,
      });
      setDone({ ...r, change: Math.max(0, change) });
      await qc.invalidateQueries({
        predicate: (q) => ['products.', 'stock.', 'invoices.', 'customers.', 'receivables.', 'payments.', 'audit.', 'sales.', 'dashboard.', 'reports.'].some((p) => String(q.queryKey[0]).startsWith(p)),
      });
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.code === 'CONFLICT' && /price/.test(e.message)) {
        toast.warning('A price has changed', 'Use "Refresh prices" and check the bill again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const hold = async (label: string) => {
    try {
      await call('heldBills.save', { label, cart: cart.toDraft() });
      await qc.invalidateQueries({ queryKey: ['heldBills.list'] });
      toast.success('Bill put on hold', label);
      setHolding(false);
      newBill(true);
    } catch (e) {
      toast.error('Could not hold the bill', errorMessage(e));
    }
  };

  // Keyboard shortcuts for the counter.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (done) return;
      if (e.key === 'F2') {
        e.preventDefault();
        newBill();
      } else if (e.key === 'F3') {
        e.preventDefault();
        search.current?.focus();
      } else if (e.key === 'F4') {
        e.preventDefault();
        setPicking(true);
      } else if (e.key === 'F9') {
        e.preventDefault();
        void finalize();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const lineBeingDiscounted = state.lines.find((l) => l.key === discountFor);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SalesTabs />
        <div className="flex gap-2">
          <Button variant="ghost" icon={<PauseCircle className="size-4" />} disabled={state.lines.length === 0} onClick={() => setHolding(true)}>
            Hold bill
          </Button>
          <Button variant="outline" icon={<Plus className="size-4" />} onClick={() => newBill()}>
            New bill (F2)
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_400px]">
        <Card className="flex min-h-[560px] flex-col">
          <div className="border-b border-line p-4">
            <ProductSearch ref={search} onAdd={(p, qty) => cart.addProduct(p, qty)} />
          </div>
          {state.lines.length === 0 ? (
            <EmptyState
              icon={ShoppingCart}
              title="The bill is empty"
              description="Search for a product above and press Enter to add it. F4 chooses the customer, F9 saves the bill."
              className="flex-1"
            />
          ) : (
            <div className="flex-1 overflow-y-auto">
              <table className="w-full">
                <thead className="sticky top-0 z-10 bg-surface-2 text-[12px] tracking-wide text-ink-3 uppercase">
                  <tr>
                    <th className="px-4 py-2 text-left font-semibold">Item</th>
                    <th className="w-40 px-2 py-2 text-right font-semibold">Qty</th>
                    <th className="px-2 py-2 text-right font-semibold">Price</th>
                    <th className="px-2 py-2 text-right font-semibold">Discount</th>
                    <th className="px-4 py-2 text-right font-semibold">Amount</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {state.lines.map((l, i) => {
                    const short = shortLines.includes(l);
                    return (
                      <tr key={l.key} className="border-b border-line">
                        <td className="px-4 py-2.5">
                          <span className="font-medium text-ink">{l.product.name}</span>
                          <span className="block text-[12px] text-ink-3">
                            <span className="font-mono">{l.product.sku}</span> · GST {l.product.gstRateBp / 100}%
                            {short && (
                              <span className="ml-2 font-medium text-danger">
                                Only {formatQty(l.product.stockQty)} {l.product.unitCode} in stock
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-2 py-2">
                          <QtyInput
                            aria-label={`Quantity of ${l.product.name}`}
                            value={l.qty}
                            allowDecimal={l.product.allowDecimal}
                            unit={l.product.unitCode}
                            className={cn('h-9', short && 'border-danger')}
                            onValueChange={(v) => v !== null && v > 0 && cart.updateLine(l.key, { qty: v })}
                          />
                        </td>
                        <td className="tabular px-2 py-2 text-right whitespace-nowrap">{formatMoney(l.product.sellingPrice)}</td>
                        <td className="px-2 py-2 text-right">
                          {can('sales.discount') ? (
                            <button
                              type="button"
                              onClick={() => setDiscountFor(l.key)}
                              className={cn('rounded px-2 py-1 text-[13px] hover:bg-surface-2', l.discount ? 'font-medium text-accent' : 'text-ink-3')}
                            >
                              {l.discount ? `− ${discountLabel(l.discount)}` : 'Add'}
                            </button>
                          ) : (
                            <span className="text-ink-3">{l.discount ? discountLabel(l.discount) : '—'}</span>
                          )}
                        </td>
                        <td className="tabular px-4 py-2 text-right font-semibold text-ink">{formatMoney(bill.lines[i]?.lineTotal ?? 0)}</td>
                        <td className="pr-3">
                          <button
                            type="button"
                            aria-label={`Remove ${l.product.name}`}
                            onClick={() => cart.removeLine(l.key)}
                            className="rounded p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger"
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
          <div className="flex items-center gap-3 border-t border-line px-4 py-3">
            <Input aria-label="Bill notes" placeholder="Notes printed on the invoice (optional)" value={state.notes} onChange={(e) => cart.setNotes(e.target.value)} maxLength={500} />
            {state.lines.length > 0 && (
              <Button variant="ghost" size="sm" onClick={refreshPrices}>
                Refresh prices
              </Button>
            )}
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          {/* Customer */}
          <Card className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-3">
                  <UserRound className="size-5" />
                </div>
                <div className="min-w-0">
                  <p className="truncate font-semibold text-ink">{isWalkin ? 'Walk-in customer' : customer?.name}</p>
                  {isWalkin ? (
                    <p className="text-[13px] text-ink-3">Pays in full at the counter</p>
                  ) : (
                    <p className="text-[13px]">
                      {customer?.phone && <span className="mr-2 text-ink-3">{customer.phone}</span>}
                      <BalanceText balance={customer?.balance ?? 0} />
                    </p>
                  )}
                  {interstate && <p className="text-[13px] font-medium text-info">Other state: IGST applies</p>}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="outline" size="sm" onClick={() => setPicking(true)}>
                  {isWalkin ? 'Choose (F4)' : 'Change'}
                </Button>
                {!isWalkin && (
                  <Button variant="ghost" size="sm" aria-label="Back to walk-in" onClick={() => (cart.setCustomer(null), setUseCredit(false))}>
                    <X className="size-4" />
                  </Button>
                )}
              </div>
            </div>
            {isWalkin && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Input aria-label="Walk-in name" placeholder="Name (optional)" value={state.walkInName} onChange={(e) => cart.setWalkIn(e.target.value, state.walkInPhone)} />
                <Input aria-label="Walk-in phone" placeholder="Phone (optional)" value={state.walkInPhone} onChange={(e) => cart.setWalkIn(state.walkInName, e.target.value)} />
              </div>
            )}
          </Card>

          {/* Totals */}
          <Card className="p-4">
            <dl className="tabular flex flex-col gap-1.5">
              <Row label={`Items (${state.lines.length})`} value={formatMoney(bill.grossTotal)} />
              {(bill.discountTotal > 0 || can('sales.discount')) && (
                <div className="flex items-center justify-between">
                  <dt className="text-ink-2">
                    Discount
                    {can('sales.discount') && state.lines.length > 0 && (
                      <button type="button" onClick={() => setDiscountFor('BILL')} className="ml-2 text-[13px] font-medium text-brand hover:underline">
                        <Percent className="mr-0.5 inline size-3" />
                        {state.billDiscount ? `bill ${discountLabel(state.billDiscount)}` : 'on whole bill'}
                      </button>
                    )}
                  </dt>
                  <dd className={cn(bill.discountTotal > maxDiscount && 'font-semibold text-danger')}>− {formatMoney(bill.discountTotal)}</dd>
                </div>
              )}
              <Row label="Taxable value" value={formatMoney(bill.taxableTotal)} muted />
              {bill.igstTotal > 0 ? (
                <Row label="IGST" value={formatMoney(bill.igstTotal)} muted />
              ) : (
                <>
                  <Row label="CGST" value={formatMoney(bill.cgstTotal)} muted />
                  <Row label="SGST" value={formatMoney(bill.sgstTotal)} muted />
                </>
              )}
              {bill.roundOff !== 0 && <Row label="Round-off" value={`${bill.roundOff > 0 ? '+' : '−'}${formatMoney(Math.abs(bill.roundOff))}`} muted />}
              <div className="mt-1 flex items-baseline justify-between border-t border-line pt-2">
                <dt className="text-[15px] font-semibold text-ink">Total</dt>
                <dd className="font-display text-[28px] font-semibold text-ink">{formatMoney(bill.grandTotal)}</dd>
              </div>
            </dl>
          </Card>

          {/* Payment */}
          <Card className="p-4">
            <p className="mb-2 font-semibold text-ink">Payment</p>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {methods.data?.map((m) => (
                <Button key={m.id} variant="outline" size="sm" disabled={state.lines.length === 0 || due <= 0} onClick={() => addPayment(m)}>
                  {m.name}
                </Button>
              ))}
            </div>
            {!isWalkin && customer && customer.availableCredit > 0 && (
              <div className="mb-2">
                <Checkbox
                  checked={useCredit}
                  onChange={setUseCredit}
                  label={<>Use account credit ({formatMoney(customer.availableCredit)} available)</>}
                />
              </div>
            )}
            <div className="flex flex-col gap-2">
              {payments.map((p) => {
                const m = methods.data?.find((x) => x.id === p.methodId);
                return (
                  <div key={p.key} className="grid grid-cols-[1fr_130px_32px] items-center gap-2">
                    <div>
                      <span className="font-medium text-ink">{m?.name}</span>
                      {m && m.kind !== 'CASH' && (
                        <Input
                          aria-label={`${m.name} reference`}
                          placeholder="Reference / txn no."
                          className="mt-1 h-8 text-[13px]"
                          value={p.reference}
                          onChange={(e) => setPayments((ps) => ps.map((x) => (x.key === p.key ? { ...x, reference: e.target.value } : x)))}
                        />
                      )}
                    </div>
                    <MoneyInput
                      aria-label={`${m?.name} amount`}
                      value={p.amount}
                      className="h-9"
                      onValueChange={(v) => setPayments((ps) => ps.map((x) => (x.key === p.key ? { ...x, amount: v } : x)))}
                    />
                    <button
                      type="button"
                      aria-label="Remove payment"
                      onClick={() => setPayments((ps) => ps.filter((x) => x.key !== p.key))}
                      className="rounded p-1.5 text-ink-3 hover:bg-surface-2"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                );
              })}
              {cashPayment && (
                <div className="grid grid-cols-[1fr_130px_32px] items-center gap-2 rounded-md bg-surface-2 px-2 py-1.5">
                  <span className="text-[13px] text-ink-2">
                    Cash received {change > 0 && <strong className="text-accent">· change {formatMoney(change)}</strong>}
                  </span>
                  <MoneyInput aria-label="Cash received" value={cashReceived} className="h-8" onValueChange={(v) => setCashReceived(v)} />
                </div>
              )}
            </div>
            <dl className="tabular mt-3 flex flex-col gap-1 border-t border-line pt-2">
              {creditUsed > 0 && <Row label="Paid from credit" value={formatMoney(creditUsed)} />}
              <Row label="Paid now" value={formatMoney(paid)} />
              <Row
                label={isWalkin ? 'Still to pay' : 'On credit (pay later)'}
                value={formatMoney(Math.max(0, due))}
                strong={due > 0}
              />
            </dl>
            {overLimit && (
              <p className="mt-2 flex items-start gap-1.5 text-[13px] text-warning">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> This takes {customer?.name} over the credit limit of {formatMoney(customer?.creditLimit ?? 0)}.
              </p>
            )}
          </Card>

          {shortLines.length > 0 && canOverride && (
            <Card className="border-warning/40 p-4">
              <Checkbox checked={override} onChange={setOverride} label="Sell even though stock is short" />
              {override && (
                <Field label="Reason" className="mt-2" required>
                  {(p) => <Input {...p} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="e.g. stock arrived, not yet entered" />}
                </Field>
              )}
            </Card>
          )}

          {/* Stays in view at the bottom of small screens while the bill panel scrolls. */}
          <div className="sticky bottom-0 z-10 -mx-2 flex flex-col gap-2 bg-bg px-2 pt-2 pb-3">
            {error && <ErrorBanner title="Not saved" message={error} />}
            {problems.length > 0 && state.lines.length > 0 && <p className="text-[13px] text-ink-3">{problems[0]}</p>}
            <Button size="lg" className="h-14 text-[17px]" busy={busy} disabled={problems.length > 0 || !customer} onClick={finalize}>
              Save bill {state.lines.length > 0 && `· ${formatMoney(bill.grandTotal)}`} (F9)
            </Button>
          </div>
        </div>
      </div>

      {picking && (
        <CustomerPicker
          includeWalkin
          onClose={() => setPicking(false)}
          onPick={async (c) => {
            setPicking(false);
            if (c.isWalkin) {
              cart.setCustomer(null);
              return;
            }
            const detail = await call('customers.get', { id: c.id });
            cart.setCustomer(toCartCustomer(detail));
            search.current?.focus();
          }}
        />
      )}
      {discountFor && (
        <DiscountDialog
          title={discountFor === 'BILL' ? 'Discount on the whole bill' : `Discount on ${lineBeingDiscounted?.product.name}`}
          base={discountFor === 'BILL' ? bill.grossTotal - bill.lines.reduce((a, l) => a + l.lineDiscount, 0) : (bill.lines[state.lines.indexOf(lineBeingDiscounted!)]?.gross ?? 0)}
          value={discountFor === 'BILL' ? state.billDiscount : (lineBeingDiscounted?.discount ?? null)}
          maxDiscountBp={session.maxDiscountBp}
          onClose={() => setDiscountFor(null)}
          onSave={(d) => {
            if (discountFor === 'BILL') cart.setBillDiscount(d);
            else cart.updateLine(discountFor, { discount: d });
            setDiscountFor(null);
          }}
        />
      )}
      {holding && <HoldDialog defaultLabel={isWalkin ? state.walkInName || 'Walk-in' : (customer?.name ?? '')} onHold={hold} onClose={() => setHolding(false)} />}
      {done && <SaleCompleteDialog result={done} onNewBill={() => newBill(true)} />}
      <ConfirmDialog
        open={confirmNew}
        onOpenChange={setConfirmNew}
        title="Start a new bill?"
        description="The items on the current bill will be cleared. Use Hold bill to keep them for later."
        confirmLabel="Clear and start new"
        tone="danger"
        onConfirm={() => newBill(true)}
      />
      <p className="mt-4 text-[12px] text-ink-3">
        Shortcuts: F2 new bill · F3 search · F4 customer · F9 save. Recall parked bills from <Link to="/sales/held" className="text-brand hover:underline">Held bills</Link>.
      </p>
    </>
  );
}

function Row({ label, value, muted, strong }: { label: string; value: string; muted?: boolean; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className={muted ? 'text-ink-3' : 'text-ink-2'}>{label}</dt>
      <dd className={cn(muted ? 'text-ink-3' : 'text-ink', strong && 'font-semibold text-warning')}>{value}</dd>
    </div>
  );
}

function HoldDialog({ defaultLabel, onHold, onClose }: { defaultLabel: string; onHold(label: string): void; onClose(): void }) {
  const [label, setLabel] = useState(defaultLabel || `Bill at ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Hold this bill"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onHold(label.trim() || 'Held bill')}>Hold</Button>
        </>
      }
    >
      <Field label="Label" hint="So you can find it again">
        {(p) => <Input {...p} value={label} onChange={(e) => setLabel(e.target.value)} autoFocus maxLength={60} onKeyDown={(e) => e.key === 'Enter' && onHold(label.trim() || 'Held bill')} />}
      </Field>
    </Dialog>
  );
}
