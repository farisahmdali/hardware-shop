import { useState } from 'react';
import { FileDown, Printer } from 'lucide-react';
import type { DocumentKind, Paper } from '@shared/contracts';
import { call, errorMessage, useCommandQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Select } from '../../components/ui/form';
import { Spinner } from '../../components/ui/layout';

export interface DocumentRef {
  kind: DocumentKind;
  id: number;
  paper?: Paper;
  from?: string;
  to?: string;
  title?: string;
}

/** Print and PDF actions for a document, usable without opening the preview. */
export function useDocumentActions() {
  const toast = useToast();
  const [busy, setBusy] = useState<'pdf' | 'print' | null>(null);
  const run = async (action: 'pdf' | 'print', doc: DocumentRef & { paper: Paper }) => {
    setBusy(action);
    try {
      const input = { kind: doc.kind, id: doc.id, paper: doc.paper, from: doc.from, to: doc.to };
      if (action === 'pdf') {
        const r = await call('print.pdf', input);
        if (r) toast.success('PDF saved', r.path);
      } else {
        await call('print.send', input);
      }
    } catch (e) {
      toast.error(action === 'pdf' ? 'Could not save the PDF' : 'Could not print', errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return { busy, pdf: (doc: DocumentRef & { paper: Paper }) => run('pdf', doc), print: (doc: DocumentRef & { paper: Paper }) => run('print', doc) };
}

/** Shows the document exactly as it will print, in a sandboxed frame, with print and PDF buttons. */
export function DocumentPreview({ doc, onClose }: { doc: DocumentRef; onClose(): void }) {
  const [paper, setPaper] = useState<Paper>(doc.paper ?? (doc.kind === 'RECEIPT' ? 'THERMAL_80' : 'A4'));
  const rendered = useCommandQuery('print.render', { kind: doc.kind, id: doc.id, paper, from: doc.from, to: doc.to });
  const actions = useDocumentActions();
  const thermal = paper !== 'A4';

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={doc.title ?? 'Preview'}
      size="xl"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          {(doc.kind === 'INVOICE' || doc.kind === 'RECEIPT') && (
            <Select aria-label="Paper" className="w-56" value={paper} onChange={(e) => setPaper(e.target.value as Paper)}>
              <option value="A4">A4 tax invoice</option>
              <option value="THERMAL_80">Receipt 80 mm</option>
              <option value="THERMAL_58">Receipt 58 mm</option>
            </Select>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" icon={<FileDown className="size-4" />} busy={actions.busy === 'pdf'} onClick={() => actions.pdf({ ...doc, paper })}>
              Save PDF
            </Button>
            <Button icon={<Printer className="size-4" />} busy={actions.busy === 'print'} onClick={() => actions.print({ ...doc, paper })}>
              Print
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex justify-center rounded-md bg-surface-3 p-4">
        {rendered.data ? (
          <iframe
            title="Document preview"
            sandbox=""
            srcDoc={rendered.data.html}
            className="rounded bg-white shadow-pop"
            style={{ width: thermal ? (paper === 'THERMAL_58' ? 240 : 320) : 794, height: '62vh', border: 'none' }}
          />
        ) : (
          <Spinner />
        )}
      </div>
    </Dialog>
  );
}
