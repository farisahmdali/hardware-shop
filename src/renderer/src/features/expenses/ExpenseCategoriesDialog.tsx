import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { CategoryRow } from '@shared/contracts';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/form';
import { Badge } from '../../components/ui/layout';
import { EXPENSE_INVALIDATE } from './ExpenseDialog';

/** Add, rename, retire or bring back expense categories. Categories in use are never deleted. */
export function ExpenseCategoriesDialog({ onClose }: { onClose(): void }) {
  const toast = useToast();
  const list = useCommandQuery('expenseCategories.list', { includeInactive: true });
  const save = useCommandMutation('expenseCategories.save', { invalidate: EXPENSE_INVALIDATE });
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);

  const run = async (input: { id?: number; name: string; isActive: boolean; version?: number }, done: string) => {
    try {
      await save.mutateAsync(input);
      toast.success(done);
      return true;
    } catch (e) {
      toast.error('Not saved', errorMessage(e));
      return false;
    }
  };

  const rename = async (c: CategoryRow) => {
    if (!editing || editing.name.trim() === c.name) return setEditing(null);
    if (await run({ id: c.id, name: editing.name.trim(), isActive: c.isActive, version: c.version }, 'Category renamed')) setEditing(null);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Expense categories">
      <form
        className="mb-4 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (name.trim() && (await run({ name: name.trim(), isActive: true }, `Category “${name.trim()}” added`))) setName('');
        }}
      >
        <Input aria-label="New category name" placeholder="New category, e.g. Security guard" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        <Button type="submit" icon={<Plus className="size-4" />} disabled={!name.trim()} busy={save.isPending}>
          Add
        </Button>
      </form>
      <ul className="divide-y divide-line rounded-md border border-line">
        {list.data?.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2">
            {editing?.id === c.id ? (
              <Input
                aria-label={`Rename ${c.name}`}
                autoFocus
                className="h-8"
                value={editing.name}
                onChange={(e) => setEditing({ id: c.id, name: e.target.value })}
                onBlur={() => void rename(c)}
                onKeyDown={(e) => e.key === 'Enter' && void rename(c)}
              />
            ) : (
              <button type="button" className="text-left" onClick={() => setEditing({ id: c.id, name: c.name })}>
                <span className={c.isActive ? 'font-medium text-ink' : 'text-ink-3 line-through'}>{c.name}</span>
                <span className="ml-2 text-[12px] text-ink-3">{c.usageCount} expense{c.usageCount === 1 ? '' : 's'}</span>
              </button>
            )}
            <div className="flex shrink-0 items-center gap-2">
              {!c.isActive && <Badge>Retired</Badge>}
              <Button size="sm" variant="ghost" onClick={() => void run({ id: c.id, name: c.name, isActive: !c.isActive, version: c.version }, c.isActive ? 'Category retired' : 'Category back in use')}>
                {c.isActive ? 'Retire' : 'Use again'}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[13px] text-ink-3">Click a name to rename it. Retired categories stay on past expenses but are not offered for new ones.</p>
    </Dialog>
  );
}
