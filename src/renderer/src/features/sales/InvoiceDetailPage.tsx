import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Ban, Eye, FileDown, Printer, Undo2, Wallet } from 'lucide-react';
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
import { ReceivePaymentDialog } from '../payments/ReceivePaymentDialog';
import { CreditNoteDialog } from './CreditNoteDialog';
import { DocumentPreview, useDocumentActions, type DocumentRef } from './DocumentPreview';
import { InvoiceStatusBadge } from './invoiceBadges';

export function InvoiceDetailPage() {
  const id = Number(useParams().id);
  const can = useCan();
  const toast = useToast();
  const query = useCommandQuery('invoices.get', { id });
  const settings = useCommandQuery('settings.get');
  const actions = useDocumentActions();
  const [preview, setPreview] = useState<DocumentRef | null>(null);
  const [paying, setPaying] = useState(false);
  const [returning, setReturning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelRequest] = useState(newRequestId);
  const cancel = useCommandMutation('invoices.cancel', { invalidate: ['invoices.', 'products.', 'stock.', 'customers.', 'receivables.', 'payments.'] });

  if (query.isPending) return <Spinner />;
  if (query.isError) return <ErrorBanner message={query.error.message} />;
  const inv = query.data;
  const paper = settings.data?.printing.defaultPaper ?? 'A4';
  const doc = { kind: 'INVOICE' as const, id: inv.id, title: `Invoice ${inv.invoiceNo}` };
  const cancelled = inv.status === 'CANCELLED';
  const canReturn = !cancelled && can('sales.return') && inv.lines.some((l) => l.qty > l.returnedQty);
  const canCancel = !cancelled && can('sales.cancel') && inv.creditNotes.length === 0 && inv.kind === 'SALE';

  return (
    <>
      <Link to="/sales/invoices" className="mb-3 inline-flex items-center gap-1 text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Invoices
      </Link>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-mono text-[22px] font-semibold text-ink">{inv.invoiceNo}</h1>
            <InvoiceStatusBadge status={inv.status} overdue={inv.overdue} />
          </div>
          <p className="text-ink-2">
            {inv.rentalAgreementId && (
              <Link to={`/rentals/${inv.rentalAgreementId}`} className="mr-1 text-brand hover:underline">
                {inv.kind === 'RENTAL' ? 'Rental bill' : 'Sold with a rental'} ·
              </Link>
            )}
            {formatDateTime(inv.issuedAt)} by {inv.username ?? 'system'} ·{' '}
            {inv.isWalkin ? (
              inv.customerName
            ) : (
              <Link to={`/customers/${inv.customerId}`} className="text-brand hover:underline">
                {inv.customerName}
              </Link>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!cancelled && inv.outstanding > 0 && !inv.isWalkin && can('payments.receive') && (
            <Button icon={<Wallet className="size-4" />} onClick={() => setPaying(true)}>
              Receive payment
            </Button>
          )}
          <Button variant="outline" icon={<Printer className="size-4" />} busy={actions.busy === 'print'} onClick={() => actions.print({ ...doc, paper })}>
            Print
          </Button>
          <Button variant="outline" icon={<FileDown className="size-4" />} busy={actions.busy === 'pdf'} onClick={() => actions.pdf({ ...doc, paper: 'A4' })}>
            PDF
          </Button>
          <Button variant="ghost" icon={<Eye className="size-4" />} onClick={() => setPreview({ ...doc, paper })}>
            Preview
          </Button>
          {canReturn && (
            <Button variant="ghost" icon={<Undo2 className="size-4" />} onClick={() => setReturning(true)}>
              {inv.kind === 'RENTAL' ? 'Credit a charge' : 'Return items'}
            </Button>
          )}
          {canCancel && (
            <Button variant="ghost" icon={<Ban className="size-4" />} onClick={() => setCancelling(true)}>
              Cancel invoice
            </Button>
          )}
        </div>
      </header>

      {inv.cancellation && (
        <div className="mb-5 rounded-lg border border-line bg-surface-2 px-4 py-3">
          <p className="font-semibold text-ink">Cancelled {formatDateTime(inv.cancellation.at)} by {inv.cancellation.username}</p>
          <p className="text-ink-2">Reason: {inv.cancellation.reason}</p>
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
                <Th align="right">Discount</Th>
                <Th align="right">Taxable</Th>
                <Th align="right">GST</Th>
                <Th align="right">Amount</Th>
              </tr>
            </THead>
            <tbody>
              {inv.lines.map((l) => (
                <Tr key={l.id}>
                  <Td>
                    {l.productId ? (
                      <Link to={`/products/${l.productId}`} className="font-medium text-ink hover:text-brand">
                        {l.name}
                      </Link>
                    ) : (
                      <span className="font-medium">{l.name}</span>
                    )}
                    <span className="block text-[12px] text-ink-3">
                      <span className="font-mono">{l.sku}</span>
                      {l.hsnCode && ` · HSN ${l.hsnCode}`}
                      {l.returnedQty > 0 && <span className="ml-2 font-medium text-warning">{formatQty(l.returnedQty)} returned</span>}
                    </span>
                  </Td>
                  <Td align="right" className="whitespace-nowrap">
                    {formatQty(l.qty)} <span className="text-ink-3">{l.unitCode}</span>
                  </Td>
                  <Td align="right">{formatMoney(l.unitPrice)}</Td>
                  <Td align="right">{l.discount ? formatMoney(l.discount) : '—'}</Td>
                  <Td align="right">{formatMoney(l.taxable)}</Td>
                  <Td align="right">
                    {formatMoney(l.cgst + l.sgst + l.igst)}
                    <span className="block text-[12px] text-ink-3">{l.gstRateBp / 100}%</span>
                  </Td>
                  <Td align="right" className="font-semibold">
                    {formatMoney(l.lineTotal)}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <div className="flex flex-col gap-5">
          <Card className="p-4">
            <dl className="tabular flex flex-col gap-1.5">
              <Line label="Gross" value={formatMoney(inv.grossTotal)} />
              {inv.discountTotal > 0 && <Line label="Discount" value={`− ${formatMoney(inv.discountTotal)}`} />}
              <Line label="Taxable value" value={formatMoney(inv.taxableTotal)} />
              {inv.isInterstate ? (
                <Line label="IGST" value={formatMoney(inv.igstTotal)} />
              ) : (
                <>
                  <Line label="CGST" value={formatMoney(inv.cgstTotal)} />
                  <Line label="SGST" value={formatMoney(inv.sgstTotal)} />
                </>
              )}
              {inv.roundOff !== 0 && <Line label="Round-off" value={formatMoney(inv.roundOff)} />}
              <div className="flex justify-between border-t border-line pt-2 text-[17px] font-semibold">
                <dt>Total</dt>
                <dd>{formatMoney(inv.grandTotal)}</dd>
              </div>
              {!cancelled && (
                <div className="flex justify-between font-semibold">
                  <dt>Balance due</dt>
                  <dd className={inv.outstanding > 0 ? 'text-warning' : 'text-success'}>{formatMoney(inv.outstanding)}</dd>
                </div>
              )}
              {inv.costTotal !== null && (
                <p className="mt-1 text-[12px] text-ink-3">
                  Cost of goods {formatMoney(inv.costTotal)} · gross margin {formatMoney(inv.taxableTotal - inv.costTotal)}
                </p>
              )}
            </dl>
          </Card>
          <Card>
            <CardHeader title="Customer" />
            <div className="p-4">
              <KeyValue
                items={[
                  { label: 'Name', value: inv.customerName },
                  ...(inv.customerPhone ? [{ label: 'Phone', value: inv.customerPhone }] : []),
                  ...(inv.customerGstin ? [{ label: 'GSTIN', value: inv.customerGstin }] : []),
                  { label: 'Place of supply', value: stateName(inv.customerStateCode || inv.shopStateCode) },
                  ...(inv.outstanding > 0 ? [{ label: 'Due date', value: formatDate(inv.dueDate) }] : []),
                  ...(inv.notes ? [{ label: 'Notes', value: inv.notes }] : []),
                ]}
              />
            </div>
          </Card>
        </div>
      </div>

      <Tabs defaultValue="payments" className="mt-5">
        <TabsList className="mb-4">
          <TabsTrigger value="payments">Payments & credits ({inv.settlements.length})</TabsTrigger>
          <TabsTrigger value="returns">Returns ({inv.creditNotes.length})</TabsTrigger>
          {can('audit.view') && <TabsTrigger value="history">History</TabsTrigger>}
        </TabsList>
        <TabsContent value="payments">
          <Card>
            {inv.settlements.length === 0 ? (
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
                  {inv.settlements.map((s) => (
                    <Tr key={`${s.kind}-${s.sourceId}`}>
                      <Td className="font-mono text-[13px]">
                        {s.docNo}
                        {s.reversed && <Badge className="ml-2">Reversed</Badge>}
                      </Td>
                      <Td className="tabular">{formatDateTime(s.date)}</Td>
                      <Td>{s.methodName ?? (s.kind === 'CREDIT_NOTE' ? 'Credit note' : 'Account credit')}</Td>
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
            {inv.creditNotes.length === 0 ? (
              <p className="p-5 text-ink-3">No items returned.</p>
            ) : (
              <Table>
                <THead>
                  <tr>
                    <Th>Credit note</Th>
                    <Th>Date</Th>
                    <Th>Reason</Th>
                    <Th>Settled</Th>
                    <Th align="right">Amount</Th>
                    <Th />
                  </tr>
                </THead>
                <tbody>
                  {inv.creditNotes.map((c) => (
                    <Tr key={c.id}>
                      <Td className="font-mono text-[13px]">{c.creditNoteNo}</Td>
                      <Td className="tabular">
                        {formatDateTime(c.issuedAt)} <span className="text-ink-3">by {c.username}</span>
                      </Td>
                      <Td>{c.reason}</Td>
                      <Td>{c.settlement === 'REFUND' ? 'Refunded' : 'Account credit'}</Td>
                      <Td align="right">{formatMoney(c.total)}</Td>
                      <Td align="right">
                        <Button size="sm" variant="ghost" onClick={() => setPreview({ kind: 'CREDIT_NOTE', id: c.id, title: `Credit note ${c.creditNoteNo}`, paper: 'A4' })}>
                          View
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
              <EntityHistory entityType="invoice" entityId={inv.id} />
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {preview && <DocumentPreview doc={preview} onClose={() => setPreview(null)} />}
      {paying && (
        <ReceivePaymentDialog
          customerId={inv.customerId}
          customerName={inv.customerName}
          preset={{ docType: 'INVOICE', docId: inv.id, docNo: inv.invoiceNo, outstanding: inv.outstanding }}
          onClose={() => setPaying(false)}
        />
      )}
      {returning && <CreditNoteDialog invoice={inv} onClose={() => setReturning(false)} />}
      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title={`Cancel ${inv.invoiceNo}?`}
        description={
          <>
            All items go back into stock and the sale is reversed in the accounts. The invoice stays in the records, marked cancelled.{' '}
            {inv.isWalkin
              ? 'Payments received for it are reversed: hand the money back.'
              : 'Payments received for it become credit on the customer’s account, which can be refunded or used.'}
          </>
        }
        confirmLabel="Cancel invoice"
        tone="danger"
        requireReason
        busy={cancel.isPending}
        onConfirm={async (reason) => {
          try {
            await cancel.mutateAsync({ id: inv.id, reason, requestId: cancelRequest });
            toast.success(`${inv.invoiceNo} cancelled`);
            setCancelling(false);
          } catch (e) {
            toast.error('Could not cancel', errorMessage(e));
          }
        }}
      />
    </>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-ink-2">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
