import { useNavigate } from 'react-router-dom';
import { PauseCircle, Trash2 } from 'lucide-react';
import type { HeldBillRow } from '@shared/contracts';
import { formatDateTime } from '@shared/time';
import { call, errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Card, EmptyState, Spinner } from '../../components/ui/layout';
import { Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { cart, type CartLine } from './cartStore';
import { SalesTabs } from './SalesTabs';

export function HeldBillsPage() {
  const held = useCommandQuery('heldBills.list');
  const remove = useCommandMutation('heldBills.delete', { invalidate: ['heldBills.'] });
  const navigate = useNavigate();
  const toast = useToast();

  const open = async (h: HeldBillRow) => {
    if (cart.get().lines.length > 0) {
      toast.warning('Finish or hold the current bill first', 'The bill on the counter is not empty.');
      return;
    }
    try {
      // Prices and stock are re-read now; the held bill only remembers products and quantities.
      const lines: CartLine[] = [];
      for (const l of h.cart.lines) {
        const p = await call('products.get', { id: l.productId });
        lines.push({
          key: crypto.randomUUID(),
          qty: l.qty,
          discount: l.discount,
          product: {
            id: p.id,
            sku: p.sku,
            name: p.name,
            unitCode: p.unitCode,
            allowDecimal: p.allowDecimal,
            sellingPrice: p.sellingPrice,
            gstRateBp: p.gstRateBp,
            priceIncludesTax: p.priceIncludesTax,
            stockQty: p.qty,
          },
        });
      }
      const c = h.cart.customerId ? await call('customers.get', { id: h.cart.customerId }) : null;
      cart.load({
        customer: c
          ? {
              id: c.id,
              name: c.name,
              phone: c.phone,
              stateCode: c.stateCode,
              isWalkin: c.isWalkin,
              balance: c.balance,
              availableCredit: c.availableCredit,
              creditLimit: c.creditLimit,
            }
          : null,
        walkInName: h.cart.walkInName,
        walkInPhone: h.cart.walkInPhone,
        lines,
        billDiscount: h.cart.billDiscount,
        notes: h.cart.notes,
      });
      await remove.mutateAsync({ id: h.id });
      navigate('/sales');
    } catch (e) {
      toast.error('Could not open the held bill', errorMessage(e));
    }
  };

  return (
    <>
      <div className="mb-4">
        <SalesTabs />
      </div>
      <Card>
        {!held.data ? (
          <Spinner />
        ) : held.data.length === 0 ? (
          <EmptyState icon={PauseCircle} title="No held bills" description="Use “Hold bill” on the billing screen to park a bill while you serve someone else." />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Label</Th>
                <Th>Customer</Th>
                <Th align="right">Items</Th>
                <Th>Held</Th>
                <Th />
              </tr>
            </THead>
            <tbody>
              {held.data.map((h) => (
                <Tr key={h.id}>
                  <Td className="font-medium">{h.label}</Td>
                  <Td>{h.customerName ?? 'Walk-in'}</Td>
                  <Td align="right">{h.lineCount}</Td>
                  <Td className="tabular">
                    {formatDateTime(h.createdAt)} <span className="text-ink-3">by {h.username}</span>
                  </Td>
                  <Td align="right" className="whitespace-nowrap">
                    <Button size="sm" onClick={() => open(h)}>
                      Open
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Delete held bill ${h.label}`}
                      onClick={() => remove.mutate({ id: h.id })}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
