import { useState } from 'react';
import { CheckCircle2, FileSpreadsheet, XCircle } from 'lucide-react';
import type { ImportPreview } from '@shared/contracts';
import { call, errorMessage, useCommandMutation } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { ErrorBanner } from '../../components/ui/layout';
import { newRequestId } from '../../components/ui/numberInputs';
import { Table, Td, Th, THead, Tr } from '../../components/ui/table';

export function ImportDialog({ onClose }: { onClose(): void }) {
  const toast = useToast();
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(newRequestId);
  const commit = useCommandMutation('products.importCommit', { invalidate: ['products.', 'stock.', 'catalog.'] });

  const choose = async () => {
    setChoosing(true);
    setError(null);
    try {
      const result = await call('products.importPreview');
      if (result) setPreview(result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setChoosing(false);
    }
  };

  const template = async (format: 'csv' | 'xlsx') => {
    try {
      const r = await call('products.importTemplate', { format });
      if (r) toast.success('Template saved', r.path);
    } catch (e) {
      toast.error('Could not save the template', errorMessage(e));
    }
  };

  const confirm = async () => {
    if (!preview) return;
    try {
      const r = await commit.mutateAsync({ token: preview.token, requestId });
      toast.success(`${r.created} products imported`);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Import products"
      size="xl"
      description="Add many products at once from an Excel (.xlsx) or CSV file. Nothing is saved until you confirm."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={commit.isPending}>
            Cancel
          </Button>
          {preview && (
            <Button onClick={confirm} busy={commit.isPending} disabled={preview.validRows === 0}>
              Import {preview.validRows} product{preview.validRows === 1 ? '' : 's'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!preview ? (
          <div className="flex flex-col items-start gap-4">
            <ol className="list-decimal pl-5 text-ink-2">
              <li>Download the template and fill in one product per row. Only name and unit are required.</li>
              <li>Units can be written as a code (PCS, KG, M) or a name (Pieces, Kilograms, Metres).</li>
              <li>New categories and brands are created automatically. Suppliers must already exist.</li>
              <li>Opening stock is valued at the purchase price.</li>
            </ol>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => template('xlsx')}>
                Download Excel template
              </Button>
              <Button variant="ghost" onClick={() => template('csv')}>
                CSV template
              </Button>
            </div>
            <Button icon={<FileSpreadsheet className="size-4" />} onClick={choose} busy={choosing} size="lg">
              Choose file…
            </Button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <span className="font-medium text-ink">{preview.fileName}</span>
              <span className="flex items-center gap-1.5 text-success">
                <CheckCircle2 className="size-4" /> {preview.validRows} ready to import
              </span>
              {preview.errorRows > 0 && (
                <span className="flex items-center gap-1.5 text-danger">
                  <XCircle className="size-4" /> {preview.errorRows} with problems (will be skipped)
                </span>
              )}
              <Button variant="ghost" size="sm" onClick={choose} busy={choosing}>
                Choose a different file
              </Button>
            </div>
            {(preview.newCategories.length > 0 || preview.newBrands.length > 0) && (
              <p className="rounded-md bg-info-soft px-3 py-2 text-ink">
                {preview.newCategories.length > 0 && <>New categories: {preview.newCategories.join(', ')}. </>}
                {preview.newBrands.length > 0 && <>New brands: {preview.newBrands.join(', ')}.</>}
              </p>
            )}
            <div className="max-h-[45vh] overflow-y-auto rounded-md border border-line">
              <Table>
                <THead>
                  <tr>
                    <Th>Row</Th>
                    <Th>Code</Th>
                    <Th>Name</Th>
                    <Th>Status</Th>
                  </tr>
                </THead>
                <tbody>
                  {preview.rows.map((r) => (
                    <Tr key={r.line}>
                      <Td className="tabular text-ink-3">{r.line}</Td>
                      <Td className="font-mono text-[13px]">{r.sku || <span className="text-ink-3">auto</span>}</Td>
                      <Td>{r.name}</Td>
                      <Td>
                        {r.errors.length === 0 ? (
                          <span className="text-success">OK</span>
                        ) : (
                          <ul className="text-danger">
                            {r.errors.map((e) => (
                              <li key={e}>{e}</li>
                            ))}
                          </ul>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
            {preview.totalRows > preview.rows.length && (
              <p className="text-[13px] text-ink-3">
                Showing every row with a problem and the first valid rows; all {preview.validRows} valid rows will be imported.
              </p>
            )}
          </>
        )}
        {error && <ErrorBanner title="Import problem" message={error} />}
      </div>
    </Dialog>
  );
}
