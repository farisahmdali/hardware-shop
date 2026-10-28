import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { ProductDetail, SupplierDetail } from '@shared/contracts';
import { call, errorMessage, useCommandQuery } from '../../lib/api';
import { ErrorBanner, Spinner } from '../../components/ui/layout';
import { PurchaseForm, type ExistingBill } from './NewPurchasePage';

/** Edit a recorded purchase: the bill's form, filled in with its current version. */
export function EditPurchasePage() {
  const id = Number(useParams().id);
  const purchase = useCommandQuery('purchases.get', { id });
  const [existing, setExisting] = useState<ExistingBill | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Loaded once: later refreshes of the purchase must not reset what is being typed.
  useEffect(() => {
    const p = purchase.data;
    if (!p || existing) return;
    let alive = true;
    const productIds = [...new Set(p.lines.map((l) => l.productId))];
    Promise.all([call('suppliers.get', { id: p.supplierId }), Promise.all(productIds.map((productId) => call('products.get', { id: productId })))])
      .then(([supplier, products]: [SupplierDetail, ProductDetail[]]) => {
        if (alive) setExisting({ purchase: p, supplier, products: new Map(products.map((x) => [x.id, x])) });
      })
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [purchase.data, existing]);

  if (purchase.isError) return <ErrorBanner message={purchase.error.message} />;
  if (error) return <ErrorBanner message={error} />;
  if (!existing) return <Spinner />;
  const p = existing.purchase;
  if (p.status === 'REPLACED') {
    return <ErrorBanner title="This is an earlier version" message={`${p.purchaseNo} was already edited into ${p.replacedBy?.purchaseNo}. Edit the current version instead.`} />;
  }
  if (p.status === 'CANCELLED') return <ErrorBanner title="Cannot edit" message={`${p.purchaseNo} was cancelled.`} />;
  if (p.debitNotes.length > 0) {
    return <ErrorBanner title="Cannot edit" message={`Goods from ${p.purchaseNo} were returned to the supplier, so the bill can no longer be edited.`} />;
  }
  return <PurchaseForm existing={existing} />;
}
