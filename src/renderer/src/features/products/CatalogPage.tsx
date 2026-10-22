import { useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import type { BrandRow, CategoryRow, UnitRow } from '@shared/contracts';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Switch } from '../../components/ui/form';
import { Badge, Card, CardHeader, PageHeader, Spinner } from '../../components/ui/layout';
import { Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { ProductsTabs } from './shared';

type Editing =
  | { kind: 'category'; row: CategoryRow | null }
  | { kind: 'brand'; row: BrandRow | null }
  | { kind: 'unit'; row: UnitRow | null }
  | null;

export function CatalogPage() {
  const catalog = useCommandQuery('catalog.get');
  const [editing, setEditing] = useState<Editing>(null);
  if (!catalog.data) return <Spinner />;
  const categories = catalog.data.categories.filter((c) => c.kind === 'PRODUCT');

  const status = (active: boolean) => (active ? null : <Badge>Inactive</Badge>);
  const editButton = (onClick: () => void) => (
    <Button variant="ghost" size="sm" icon={<Pencil className="size-3.5" />} onClick={onClick}>
      Edit
    </Button>
  );

  return (
    <>
      <PageHeader title="Products & Stock" />
      <ProductsTabs />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Card>
          <CardHeader
            title="Categories"
            actions={
              <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing({ kind: 'category', row: null })}>
                Add
              </Button>
            }
          />
          <Table>
            <THead>
              <tr>
                <Th>Name</Th>
                <Th align="right">Products</Th>
                <Th />
              </tr>
            </THead>
            <tbody>
              {categories.map((c) => (
                <Tr key={c.id}>
                  <Td>
                    {c.name} {status(c.isActive)}
                  </Td>
                  <Td align="right">{c.usageCount}</Td>
                  <Td align="right">{editButton(() => setEditing({ kind: 'category', row: c }))}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card>
          <CardHeader
            title="Brands"
            actions={
              <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing({ kind: 'brand', row: null })}>
                Add
              </Button>
            }
          />
          {catalog.data.brands.length === 0 ? (
            <p className="p-5 text-ink-3">No brands yet. They can also be added from the product form.</p>
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th>Name</Th>
                  <Th align="right">Products</Th>
                  <Th />
                </tr>
              </THead>
              <tbody>
                {catalog.data.brands.map((b) => (
                  <Tr key={b.id}>
                    <Td>
                      {b.name} {status(b.isActive)}
                    </Td>
                    <Td align="right">{b.usageCount}</Td>
                    <Td align="right">{editButton(() => setEditing({ kind: 'brand', row: b }))}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card>
          <CardHeader
            title="Units of measurement"
            actions={
              <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing({ kind: 'unit', row: null })}>
                Add
              </Button>
            }
          />
          <Table>
            <THead>
              <tr>
                <Th>Unit</Th>
                <Th>Decimals</Th>
                <Th align="right">Products</Th>
                <Th />
              </tr>
            </THead>
            <tbody>
              {catalog.data.units.map((u) => (
                <Tr key={u.id}>
                  <Td>
                    {u.name} <span className="font-mono text-[12px] text-ink-3">{u.code}</span> {status(u.isActive)}
                  </Td>
                  <Td>{u.allowDecimal ? 'Yes' : 'No'}</Td>
                  <Td align="right">{u.usageCount}</Td>
                  <Td align="right">{editButton(() => setEditing({ kind: 'unit', row: u }))}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
      {editing && <EditDialog editing={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function EditDialog({ editing, onClose }: { editing: Exclude<Editing, null>; onClose(): void }) {
  const toast = useToast();
  const row = editing.row;
  const [name, setName] = useState(row?.name ?? '');
  const [code, setCode] = useState(editing.kind === 'unit' ? (editing.row?.code ?? '') : '');
  const [allowDecimal, setAllowDecimal] = useState(editing.kind === 'unit' ? (editing.row?.allowDecimal ?? false) : false);
  const [isActive, setIsActive] = useState(row?.isActive ?? true);
  const invalidate = { invalidate: ['catalog.', 'products.'] };
  const saveCategory = useCommandMutation('catalog.saveCategory', invalidate);
  const saveBrand = useCommandMutation('catalog.saveBrand', invalidate);
  const saveUnit = useCommandMutation('catalog.saveUnit', invalidate);
  const busy = saveCategory.isPending || saveBrand.isPending || saveUnit.isPending;
  const noun = editing.kind === 'category' ? 'category' : editing.kind === 'brand' ? 'brand' : 'unit';

  const submit = async () => {
    try {
      const base = { id: row?.id, version: row?.version, name, isActive };
      if (editing.kind === 'category') await saveCategory.mutateAsync(base);
      else if (editing.kind === 'brand') await saveBrand.mutateAsync(base);
      else await saveUnit.mutateAsync({ ...base, code, allowDecimal });
      toast.success(`${noun[0]!.toUpperCase()}${noun.slice(1)} saved`);
      onClose();
    } catch (e) {
      toast.error('Not saved', errorMessage(e));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={row ? `Edit ${noun}` : `Add ${noun}`}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} busy={busy} disabled={!name.trim() || (editing.kind === 'unit' && !code.trim())}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" required>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} />}
        </Field>
        {editing.kind === 'unit' && (
          <>
            <Field label="Short code" required hint="Printed on invoices, e.g. PCS, KG, M">
              {(p) => <Input {...p} value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} maxLength={10} />}
            </Field>
            <Switch label="Allow decimal quantities" description="For weights, lengths and volumes, e.g. 2.5 kg" checked={allowDecimal} onChange={setAllowDecimal} />
          </>
        )}
        {row && <Switch label="Active" description="Inactive entries are hidden when adding products; existing products keep them." checked={isActive} onChange={setIsActive} />}
      </div>
    </Dialog>
  );
}
