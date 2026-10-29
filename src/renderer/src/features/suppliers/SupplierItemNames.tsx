import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Tags } from 'lucide-react';
import type { SupplierItemName } from '@shared/contracts';
import { formatDate } from '@shared/time';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/dialog';
import { Card, CardHeader, EmptyState, ErrorBanner, Spinner } from '../../components/ui/layout';
import { Table, Td, Th, THead, Tr } from '../../components/ui/table';

/** What this supplier calls the shop's products, learned from scanned bills. */
export function SupplierItemNames({ supplierId, supplierName }: { supplierId: number; supplierName: string }) {
  const can = useCan();
  const toast = useToast();
  const list = useCommandQuery('supplierItemNames.list', { supplierId });
  const remove = useCommandMutation('supplierItemNames.remove', { invalidate: ['supplierItemNames.'] });
  const [forgetting, setForgetting] = useState<SupplierItemName | null>(null);

  return (
    <Card>
      <CardHeader
        title="Item names from this supplier"
        description={`How ${supplierName}'s bills name your products. Learned when a scanned bill is saved, so the next bill matches by itself. Forget a name that was linked to the wrong product.`}
      />
      {list.isLoading ? (
        <Spinner />
      ) : list.error ? (
        <div className="p-5">
          <ErrorBanner message={list.error.message} onRetry={() => list.refetch()} />
        </div>
      ) : !list.data?.length ? (
        <EmptyState icon={Tags} title="No item names yet" description="They are remembered when you save a purchase filled in by scanning this supplier's bill." />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>On their bill</Th>
              <Th>Your product</Th>
              <Th align="right">Bills</Th>
              <Th>Last bill</Th>
              <Th />
            </tr>
          </THead>
          <tbody>
            {list.data.map((n) => (
              <Tr key={n.id}>
                <Td className="font-medium text-ink">{n.itemText}</Td>
                <Td>
                  <Link to={`/products/${n.productId}`} className="hover:text-brand hover:underline">
                    {n.productName}
                  </Link>{' '}
                  <span className="font-mono text-[12px] text-ink-3">{n.sku}</span>
                </Td>
                <Td align="right" className="tabular">
                  {n.uses}
                </Td>
                <Td>{formatDate(n.lastUsedAt.slice(0, 10))}</Td>
                <Td align="right">
                  {can('purchases.manage') && (
                    <Button size="sm" variant="ghost" onClick={() => setForgetting(n)}>
                      Forget
                    </Button>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      {forgetting && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setForgetting(null)}
          title="Forget this item name?"
          description={`"${forgetting.itemText}" will no longer be matched to ${forgetting.productName}. The next bill with it asks which product it is.`}
          confirmLabel="Forget"
          busy={remove.isPending}
          onConfirm={async () => {
            try {
              await remove.mutateAsync({ id: forgetting.id, supplierId });
              toast.success('Item name forgotten');
              setForgetting(null);
            } catch (e) {
              toast.error('Not changed', errorMessage(e));
            }
          }}
        />
      )}
    </Card>
  );
}
