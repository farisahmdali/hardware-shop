import { useState } from 'react';
import { CheckCircle2, Eye, FileDown, Printer, ReceiptText } from 'lucide-react';
import { formatMoney } from '@shared/money';
import { useCommandQuery } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { DocumentPreview, useDocumentActions } from './DocumentPreview';

export interface SaleResult {
  invoiceId: number;
  invoiceNo: string;
  grandTotal: number;
  outstanding: number;
  change: number;
}

/** Shown after a bill is saved: print options, then straight on to the next customer. */
export function SaleCompleteDialog({ result, onNewBill }: { result: SaleResult; onNewBill(): void }) {
  const settings = useCommandQuery('settings.get');
  const actions = useDocumentActions();
  const [preview, setPreview] = useState(false);
  const paper = settings.data?.printing.defaultPaper ?? 'A4';
  const doc = { kind: 'INVOICE' as const, id: result.invoiceId, title: `Invoice ${result.invoiceNo}` };

  if (preview) return <DocumentPreview doc={{ ...doc, paper }} onClose={() => setPreview(false)} />;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onNewBill()}
      title="Bill saved"
      size="sm"
      footer={
        <Button size="lg" className="w-full" onClick={onNewBill} autoFocus>
          New bill (Enter)
        </Button>
      }
    >
      <div className="flex flex-col items-center gap-1 text-center">
        <CheckCircle2 className="size-10 text-success" />
        <p className="font-mono text-[15px] font-semibold text-ink">{result.invoiceNo}</p>
        <p className="tabular text-2xl font-semibold text-ink">{formatMoney(result.grandTotal)}</p>
        {result.change > 0 && (
          <p className="tabular rounded-md bg-accent-soft px-3 py-1 text-[15px] font-semibold text-accent">Give change {formatMoney(result.change)}</p>
        )}
        {result.outstanding > 0 && <p className="text-warning">Balance on credit: {formatMoney(result.outstanding)}</p>}
      </div>
      <div className="mt-5 grid grid-cols-2 gap-2">
        <Button icon={<Printer className="size-4" />} busy={actions.busy === 'print'} onClick={() => actions.print({ ...doc, paper })}>
          Print {paper === 'A4' ? 'invoice' : 'receipt'}
        </Button>
        <Button
          variant="outline"
          icon={<ReceiptText className="size-4" />}
          onClick={() => actions.print({ ...doc, kind: paper === 'A4' ? 'RECEIPT' : 'INVOICE', paper: paper === 'A4' ? 'THERMAL_80' : 'A4' })}
        >
          {paper === 'A4' ? 'Print receipt' : 'Print A4 invoice'}
        </Button>
        <Button variant="outline" icon={<FileDown className="size-4" />} busy={actions.busy === 'pdf'} onClick={() => actions.pdf({ ...doc, paper: 'A4' })}>
          Save PDF
        </Button>
        <Button variant="ghost" icon={<Eye className="size-4" />} onClick={() => setPreview(true)}>
          Preview
        </Button>
      </div>
    </Dialog>
  );
}
