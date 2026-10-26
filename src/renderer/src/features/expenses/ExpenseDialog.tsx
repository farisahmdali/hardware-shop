import { useState } from 'react';
import { expenseFields, type ExpenseRow } from '@shared/contracts';
import { formatMoney } from '@shared/money';
import { businessDateOf, formatDate } from '@shared/time';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { ConfirmDialog, Dialog } from '../../components/ui/dialog';
import { Field, Input, Select, Textarea } from '../../components/ui/form';
import { ErrorBanner } from '../../components/ui/layout';
import { MoneyInput, newRequestId } from '../../components/ui/numberInputs';

export const EXPENSE_INVALIDATE = ['expenses.', 'expenseCategories.', 'cash.'];

/** Add an expense, or correct one (with a reason, kept in the history). */
export function ExpenseDialog({ expense, onClose }: { expense: ExpenseRow | null; onClose(): void }) {
  const toast = useToast();
  const categories = useCommandQuery('expenseCategories.list', { includeInactive: false });
  const methods = useCommandQuery('paymentMethods.list', {});
  const today = businessDateOf(new Date());
  const [f, setF] = useState({
    categoryId: expense?.categoryId ?? 0,
    description: expense?.description ?? '',
    amount: expense?.amount ?? (null as number | null),
    expenseDate: expense?.expenseDate ?? today,
    methodId: expense?.methodId ?? 0,
    payee: expense?.payee ?? '',
    reference: expense?.reference ?? '',
    notes: expense?.notes ?? '',
  });
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [requestId] = useState(newRequestId);
  const create = useCommandMutation('expenses.create', { invalidate: EXPENSE_INVALIDATE });
  const update = useCommandMutation('expenses.update', { invalidate: EXPENSE_INVALIDATE });
  const voidIt = useCommandMutation('expenses.void', { invalidate: EXPENSE_INVALIDATE });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const categoryId = f.categoryId || categories.data?.[0]?.id || 0;
  const methodId = f.methodId || methods.data?.[0]?.id || 0;
  // A category or method retired since keeps showing on the expense that used it.
  const categoryOptions = (categories.data ?? []).map((c) => ({ id: c.id, name: c.name }));
  if (expense && !categoryOptions.some((c) => c.id === expense.categoryId)) categoryOptions.push({ id: expense.categoryId, name: expense.categoryName });

  const submit = async () => {
    setServerError(null);
    const parsed = expenseFields.safeParse({ ...f, categoryId, methodId, amount: f.amount ?? 0 });
    const next: Record<string, string> = {};
    if (!parsed.success) for (const i of parsed.error.issues) next[String(i.path[0])] ??= i.message;
    if (expense && reason.trim().length < 3) next.reason = 'Say why the expense is being corrected';
    setErrors(next);
    if (!parsed.success || Object.keys(next).length) return;
    try {
      const saved = expense
        ? await update.mutateAsync({ ...parsed.data, id: expense.id, version: expense.version, reason })
        : await create.mutateAsync({ ...parsed.data, requestId });
      toast.success(expense ? `${saved.expenseNo} corrected` : `Expense ${saved.expenseNo} recorded`, formatMoney(saved.amount));
      onClose();
    } catch (e) {
      setServerError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={expense ? `Correct ${expense.expenseNo}` : 'Add expense'}
      description={expense ? `Recorded ${formatDate(expense.createdAt)} by ${expense.createdBy ?? 'system'}. The original stays in the history.` : undefined}
      footer={
        <>
          {expense && (
            <Button variant="ghost" className="mr-auto text-danger" onClick={() => setVoiding(true)}>
              Void expense
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} busy={create.isPending || update.isPending}>
            {expense ? 'Save correction' : 'Record expense'}
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-2 gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Category" required error={errors.categoryId}>
          {(p) => (
            <Select {...p} value={categoryId} onChange={(e) => set('categoryId', Number(e.target.value))}>
              {categoryOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Amount" required error={errors.amount}>
          {(p) => <MoneyInput {...p} autoFocus={!expense} value={f.amount} onValueChange={(v) => set('amount', v)} />}
        </Field>
        <Field label="What for" required className="col-span-2" error={errors.description}>
          {(p) => <Input {...p} value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={200} placeholder="e.g. October shop rent" />}
        </Field>
        <Field label="Date paid" required error={errors.expenseDate}>
          {(p) => <Input {...p} type="date" value={f.expenseDate} max={today} onChange={(e) => set('expenseDate', e.target.value)} />}
        </Field>
        <Field label="Paid by" required>
          {(p) => (
            <Select {...p} value={methodId} onChange={(e) => set('methodId', Number(e.target.value))}>
              {methods.data?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Paid to">{(p) => <Input {...p} value={f.payee} onChange={(e) => set('payee', e.target.value)} maxLength={120} />}</Field>
        <Field label="Reference" hint="Bill or UTR number">
          {(p) => <Input {...p} value={f.reference} onChange={(e) => set('reference', e.target.value)} maxLength={60} />}
        </Field>
        <Field label="Notes" className="col-span-2">
          {(p) => <Input {...p} value={f.notes} onChange={(e) => set('notes', e.target.value)} maxLength={500} />}
        </Field>
        {expense && (
          <Field label="Reason for the correction" required className="col-span-2" error={errors.reason}>
            {(p) => <Textarea {...p} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}
          </Field>
        )}
        {serverError && (
          <div className="col-span-2">
            <ErrorBanner title="Not saved" message={serverError} />
          </div>
        )}
        <button type="submit" className="hidden" />
      </form>
      {expense && (
        <ConfirmDialog
          open={voiding}
          onOpenChange={setVoiding}
          title={`Void ${expense.expenseNo}?`}
          description={`${formatMoney(expense.amount)} for “${expense.description}” is taken out of the accounts and the cash book. The expense stays on record, marked void.`}
          confirmLabel="Void expense"
          tone="danger"
          requireReason
          busy={voidIt.isPending}
          onConfirm={async (r) => {
            try {
              await voidIt.mutateAsync({ id: expense.id, version: expense.version, reason: r });
              toast.success(`${expense.expenseNo} voided`);
              onClose();
            } catch (e) {
              toast.error('Could not void', errorMessage(e));
            }
          }}
        />
      )}
    </Dialog>
  );
}
