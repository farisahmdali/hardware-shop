import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Ban, Eye, Undo2, Wallet } from 'lucide-react';
import { formatMoney } from '@shared/money';
import { formatQty } from '@shared/qty';
import { formatDate, formatDateTime } from '@shared/time';
import { stateName } from '@shared/gstStates';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/dialog';
import { Badge, Card, CardHeader, ErrorBanner, KeyValue, Spinner } from '../../components/ui/layout';
import { Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { newRequestId } from '../../components/ui/numberInputs';
import { EntityHistory } from '../history/EntityHistory';
import { DocumentPreview, type DocumentRef } from '../sales/DocumentPreview';
import { PaySupplierDialog } from './SupplierDialogs';
import { SupplierReturnDialog } from './SupplierReturnDialog';
import { PurchaseStatusBadge, SUPPLIER_INVALIDATE } from './shared';

export function PurchaseDetailPage() {
  const id = Number(useParams().id);
  const can = useCan();
  const toast = useToast();
  const query = useCommandQuery('purchases.get', { id });
  const [dialog, setDialog] = useState<'pay' | 'return' | 'cancel' | null>(null);
  const [preview, setPreview] = useState<DocumentRef | null>(null);
  const cancel = useCommandMutation('purchases.cancel', { invalidate: SUPPLIER_INVALIDATE });

  if (query.isPending) return <Spinner />;
  if (query.isError) return <ErrorBanner message={query.error.message} />;
  const p = query.data;
  const cancelled = p.status === 'CANCELLED';
  const canReturn = !cancelled && can('purchases.manage') && p.lines.some((l) => l.qty > l.returnedQty);
  const canCancel = !cancelled && can('purchases.manage') && p.debitNotes.length === 0;
  const tax = p.cgstTotal + p.sgstTotal + p.igstTotal;

  return (
    <>
      <Link to="/suppliers" className="mb-3 inline-flex items-center gap-1 text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Suppliers & Purchases
      </Link>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-[22px] font-semibold text-ink">{p.purchaseNo}</h1>
            <PurchaseStatusBadge status={p.status} overdue={p.overdue} />
          </div>
          <p className="text-ink-2">
            <Link to={`/suppliers/${p.supplierId}`} className="text-brand hover:underline">
              {p.supplierName}
            </Link>{' '}
            · their bill {p.supplierInvoiceNo || '(no number)'} of {formatDate(p.supplierInvoiceDate)} · entered {formatDateTime(p.receivedAt)} by{' '}
            {p.username ?? 'system'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!cancelled && p.outstanding > 0 && can('suppliers.pay') && (
            <Button icon={<Wallet className="size-4" />} onClick={() => setDialog('pay')}>
              Pay this bill
            </Button>
          )}
          {canReturn && (
            <Button variant="outline" icon={<Undo2 className="size-4" />} onClick={() => setDialog('return')}>
              Return goods
            </Button>
          )}
          {canCancel && (
            <Button variant="ghost" icon={<Ban className="size-4" />} onClick={() => setDialog('cancel')}>
              Cancel purchase
            </Button>
          )}
        </div>
      </header>

      {p.cancellation && (
        <div className="mb-5 rounded-lg border border-line bg-surface-2 px-4 py-3">
          <p className="font-semibold text-ink">
            Cancelled {formatDateTime(p.cancellation.at)} by {p.cancellation.username}
          </p>
          <p className="text-ink-2">Reason: {p.cancellation.reason}</p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_340px]">
        <Card>
          <Table>
            <THead>
              <tr>
                <Th>Item</Th>
                <Th align="right">Qty</Th>
                <Th align="right">Rate</Th>
                <Th align="right">Taxable</Th>
                <Th align="right">GST</Th>
                <Th align="right">Amount</Th>
                <Th align="right">Cost per unit</Th>
              </tr>
            </THead>
            <tbody>
              {p.lines.map((l) => (
                <Tr key={l.id}>
                  <Td>
                    <Link to={`/products/${l.productId}`} className="font-medium text-ink hover:text-brand">
                      {l.name}
                    </Link>
                    <span className="block text-[12px] text-ink-3">
                      <span className="font-mono">{l.sku}</span>
                      {l.hsnCode && ` · HSN ${l.hsnCode}`}
                      {l.lineDiscount + l.billDiscount > 0 && ` · discount ${formatMoney(l.lineDiscount + l.billDiscount)}`}
                      {l.returnedQty > 0 && <span className="ml-2 font-medium text-warning">{formatQty(l.returnedQty)} returned</span>}
                    </span>
                  </Td>
                  <Td align="right" className="whitespace-nowrap">
                    {formatQty(l.qty)} <span className="text-ink-3">{l.unitCode}</span>
                  </Td>
                  <Td align="right">{formatMoney(l.unitCost)}</Td>
                  <Td align="right">{formatMoney(l.taxable)}</Td>
                  <Td align="right">
                    {formatMoney(l.cgst + l.sgst + l.igst)}
                    <span className="block text-[12px] text-ink-3">{l.gstRateBp / 100}%</span>
                  </Td>
                  <Td align="right" className="font-semibold">
                    {formatMoney(l.lineTotal)}
                  </Td>
                  <Td align="right">
                    {formatMoney(l.landedUnitCost)}
                    {l.additionalCost > 0 && <span className="block text-[12px] text-ink-3">incl. {formatMoney(l.additionalCost)} charges</span>}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <div className="flex flex-col gap-5">
          <Card className="p-4">
            <dl className="tabular flex flex-col gap-1.5">
              <Line label="Items" value={formatMoney(p.grossTotal)} />
              {p.discountTotal > 0 && <Line label="Discount" value={`− ${formatMoney(p.discountTotal)}`} />}
              <Line label="Taxable value" value={formatMoney(p.taxableTotal)} />
              {p.isInterstate ? (
                <Line label="IGST" value={formatMoney(p.igstTotal)} />
              ) : (
                <>
                  <Line label="CGST" value={formatMoney(p.cgstTotal)} />
                  <Line label="SGST" value={formatMoney(p.sgstTotal)} />
                </>
              )}
              {p.additionalCosts > 0 && <Line label={p.additionalCostsNote || 'Freight / other charges'} value={formatMoney(p.additionalCosts)} />}
              {p.roundOff !== 0 && <Line label="Round-off" value={formatMoney(p.roundOff)} />}
              <div className="flex justify-between border-t border-line pt-2 text-[17px] font-semibold">
                <dt>Total</dt>
                <dd>{formatMoney(p.grandTotal)}</dd>
              </div>
              {!cancelled && (
                <div className="flex justify-between font-semibold">
                  <dt>To pay</dt>
                  <dd className={p.outstanding > 0 ? 'text-warning' : 'text-success'}>{formatMoney(p.outstanding)}</dd>
                </div>
              )}
              <p className="mt-1 text-[12px] text-ink-3">
                Stock value added {formatMoney(p.inventoryValue)}.{' '}
                {p.itcClaimed ? `Input GST ${formatMoney(tax)} claimed.` : tax > 0 ? 'GST included in the stock cost (not claimed).' : ''}
              </p>
            </dl>
          </Card>
          <Card>
            <CardHeader title="Supplier" />
            <div className="p-4">
              <KeyValue
                items={[
                  { label: 'Name', value: p.supplierName },
                  { label: 'GSTIN', value: p.supplierGstin || 'Not registered' },
                  { label: 'State', value: p.supplierStateCode ? stateName(p.supplierStateCode) : 'Same as the shop' },
                  ...(!cancelled && p.outstanding > 0 ? [{ label: 'Due date', value: formatDate(p.dueDate) }] : []),
                  ...(p.pricesIncludeTax ? [{ label: 'Rates', value: 'Included GST' }] : []),
                  ...(p.notes ? [{ label: 'Notes', value: p.notes }] : []),
                ]}
              />
            </div>
          </Card>
        </div>
      </div>

      <Tabs defaultValue="payments" className="mt-5">
        <TabsList className="mb-4">
          <TabsTrigger value="payments">Payments & credits ({p.settlements.length})</TabsTrigger>
          <TabsTrigger value="returns">Returns ({p.debitNotes.length})</TabsTrigger>
          {can('audit.view') && <TabsTrigger value="history">History</TabsTrigger>}
        </TabsList>
        <TabsContent value="payments">
          <Card>
            {p.settlements.length === 0 ? (
              <p className="p-5 text-ink-3">Nothing paid yet.</p>
            ) : (
              <Table>
                <THead>
                  <tr>
                    <Th>Document</Th>
                    <Th>Date</Th>
                    <Th>How</Th>
                    <Th align="right">Amount</Th>
                  </tr>
                </THead>
                <tbody>
                  {p.settlements.map((s) => (
                    <Tr key={`${s.kind}-${s.id}`}>
                      <Td className="font-mono text-[13px]">{s.docNo}</Td>
                      <Td className="tabular">{formatDateTime(s.at)}</Td>
                      <Td>{s.kind === 'PAYMENT' ? 'Payment' : s.kind === 'DEBIT_NOTE' ? 'Goods returned' : 'Balance adjustment'}</Td>
                      <Td align="right">{formatMoney(s.amount)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="returns">
          <Card>
            {p.debitNotes.length === 0 ? (
              <p className="p-5 text-ink-3">No goods returned.</p>
            ) : (
              <Table>
                <THead>
                  <tr>
                    <Th>Debit note</Th>
                    <Th>Date</Th>
                    <Th>Reason</Th>
                    <Th>Settled by</Th>
                    <Th align="right">Amount</Th>
                    <Th />
                  </tr>
                </THead>
                <tbody>
                  {p.debitNotes.map((d) => (
                    <Tr key={d.id}>
                      <Td className="font-mono text-[13px]">{d.debitNoteNo}</Td>
                      <Td className="tabular">
                        {formatDateTime(d.issuedAt)} <span className="text-ink-3">· {d.username}</span>
                      </Td>
                      <Td>{d.reason}</Td>
                      <Td>
                        <Badge tone={d.settlement === 'REFUND' ? 'accent' : 'neutral'}>{d.settlement === 'REFUND' ? 'Refund' : 'Adjusted'}</Badge>
                      </Td>
                      <Td align="right">{formatMoney(d.total)}</Td>
                      <Td align="right">
                        <Button size="sm" variant="ghost" icon={<Eye className="size-4" />} onClick={() => setPreview({ kind: 'DEBIT_NOTE', id: d.id, paper: 'A4', title: d.debitNoteNo })}>
                          Debit note
                        </Button>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </TabsContent>
        {can('audit.view') && (
          <TabsContent value="history">
            <Card>
              <EntityHistory entityType="purchase" entityId={p.id} />
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {dialog === 'pay' && (
        <PaySupplierDialog
          supplierId={p.supplierId}
          supplierName={p.supplierName}
          preset={{ docType: 'PURCHASE', docId: p.id, docNo: p.purchaseNo, outstanding: p.outstanding }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'return' && (
        <SupplierReturnDialog
          purchase={p}
          onClose={() => setDialog(null)}
          onDone={(debitNoteId) => {
            setDialog(null);
            setPreview({ kind: 'DEBIT_NOTE', id: debitNoteId, paper: 'A4' });
          }}
        />
      )}
      <ConfirmDialog
        open={dialog === 'cancel'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Cancel ${p.purchaseNo}?`}
        description="Use this for a bill entered by mistake. The stock it added is taken back out and nothing is owed for it any more. Payments made against it stay with the supplier as an advance. The purchase stays on record, marked cancelled."
        confirmLabel="Cancel purchase"
        tone="danger"
        requireReason
        busy={cancel.isPending}
        onConfirm={async (reason) => {
          try {
            await cancel.mutateAsync({ id: p.id, reason, requestId: newRequestId() });
            toast.success(`${p.purchaseNo} cancelled`);
            setDialog(null);
          } catch (e) {
            toast.error('Could not cancel', errorMessage(e));
          }
        }}
      />
      {preview && <DocumentPreview doc={preview} onClose={() => setPreview(null)} />}
    </>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-2">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
