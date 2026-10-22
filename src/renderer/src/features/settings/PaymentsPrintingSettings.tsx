import { useEffect, useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import type { PaymentMethodRow } from '@shared/contracts';
import type { AllSettings } from '@shared/settings';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select, Switch } from '../../components/ui/form';
import { Badge, Card, CardHeader, Spinner } from '../../components/ui/layout';
import { Table, Td, Th, THead, Tr } from '../../components/ui/table';

const KIND_LABELS: Record<PaymentMethodRow['kind'], string> = {
  CASH: 'Cash',
  UPI: 'UPI',
  CARD: 'Card',
  BANK: 'Bank transfer',
  CHEQUE: 'Cheque',
  OTHER: 'Other (bank)',
};

export function PaymentsPrintingSettings() {
  const methods = useCommandQuery('paymentMethods.list', { includeInactive: true });
  const settings = useCommandQuery('settings.get');
  const save = useCommandMutation('settings.update', { invalidate: ['settings.'] });
  const toast = useToast();
  const [editing, setEditing] = useState<PaymentMethodRow | 'new' | null>(null);
  const [printing, setPrinting] = useState<AllSettings['printing'] | null>(null);

  useEffect(() => {
    if (settings.data) setPrinting(settings.data.printing);
  }, [settings.data]);

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader
          title="Payment methods"
          description="Shown as buttons at the billing counter. Each type is kept separately in the accounts and the daily cash summary."
          actions={
            <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              Add method
            </Button>
          }
        />
        {!methods.data ? (
          <Spinner />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th align="right">Order</Th>
                <Th />
              </tr>
            </THead>
            <tbody>
              {methods.data.map((m) => (
                <Tr key={m.id}>
                  <Td className="font-medium">
                    {m.name} {!m.isActive && <Badge>Inactive</Badge>}
                  </Td>
                  <Td>{KIND_LABELS[m.kind]}</Td>
                  <Td align="right">{m.sortOrder}</Td>
                  <Td align="right">
                    <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(m)}>
                      Edit
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {printing && (
        <Card>
          <CardHeader title="Printing" />
          <div className="flex max-w-xl flex-col gap-4 p-5">
            <Field label="Default paper after a sale">
              {(p) => (
                <Select {...p} value={printing.defaultPaper} onChange={(e) => setPrinting({ ...printing, defaultPaper: e.target.value as typeof printing.defaultPaper })}>
                  <option value="A4">A4 tax invoice</option>
                  <option value="THERMAL_80">Thermal receipt 80 mm</option>
                  <option value="THERMAL_58">Thermal receipt 58 mm</option>
                </Select>
              )}
            </Field>
            <Switch
              label="Print the HSN / GST summary on A4 invoices"
              checked={printing.showHsnSummary}
              onChange={(v) => setPrinting({ ...printing, showHsnSummary: v })}
            />
            <Field label="Receipt footer">
              {(p) => <Input {...p} value={printing.receiptFooter} maxLength={120} onChange={(e) => setPrinting({ ...printing, receiptFooter: e.target.value })} />}
            </Field>
            <p className="text-[13px] text-ink-3">The A4 invoice footer (terms, bank details) is set in Shop profile.</p>
            <div>
              <Button
                busy={save.isPending}
                onClick={async () => {
                  try {
                    await save.mutateAsync({ section: 'printing', value: printing });
                    toast.success('Printing settings saved');
                  } catch (e) {
                    toast.error('Not saved', errorMessage(e));
                  }
                }}
              >
                Save printing settings
              </Button>
            </div>
          </div>
        </Card>
      )}
      {editing && <MethodDialog method={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function MethodDialog({ method, onClose }: { method: PaymentMethodRow | null; onClose(): void }) {
  const toast = useToast();
  const [name, setName] = useState(method?.name ?? '');
  const [kind, setKind] = useState<PaymentMethodRow['kind']>(method?.kind ?? 'UPI');
  const [sortOrder, setSortOrder] = useState(method?.sortOrder ?? 10);
  const [isActive, setIsActive] = useState(method?.isActive ?? true);
  const save = useCommandMutation('paymentMethods.save', { invalidate: ['paymentMethods.'] });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={method ? `Edit ${method.name}` : 'Add payment method'}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            busy={save.isPending}
            disabled={!name.trim()}
            onClick={async () => {
              try {
                await save.mutateAsync({ id: method?.id, version: method?.version, name, kind, sortOrder, isActive });
                toast.success('Payment method saved');
                onClose();
              } catch (e) {
                toast.error('Not saved', errorMessage(e));
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" hint="e.g. PhonePe, HDFC card machine">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={40} />}
        </Field>
        <Field label="Type" hint="Decides which account the money goes to">
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as PaymentMethodRow['kind'])}>
              {Object.entries(KIND_LABELS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Order on the billing screen">
          {(p) => <Input {...p} type="number" min={0} max={999} value={sortOrder} onChange={(e) => setSortOrder(Math.max(0, Math.trunc(Number(e.target.value) || 0)))} />}
        </Field>
        {method && <Switch label="Active" checked={isActive} onChange={setIsActive} />}
      </div>
    </Dialog>
  );
}
