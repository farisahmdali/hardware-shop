import { useState, type ReactNode } from 'react';
import * as RD from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Button } from './button';
import { Field, Input, Textarea } from './form';
import { cn } from '../../lib/cn';

interface DialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

const widths = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' };

export function Dialog({ open, onOpenChange, title, description, children, footer, size = 'md' }: DialogProps) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <RD.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[88vh] w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 flex-col',
            'rounded-xl border border-line bg-surface shadow-pop',
            widths[size],
          )}
          onEscapeKeyDown={(e) => {
            // Let Escape close the dialog, but never while a nested control (like a select) handles it.
            if ((e.target as HTMLElement)?.tagName === 'SELECT') e.preventDefault();
          }}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
            <div>
              <RD.Title className="text-[17px] font-semibold text-ink">{title}</RD.Title>
              {description ? (
                <RD.Description className="mt-1 text-ink-2">{description}</RD.Description>
              ) : (
                <RD.Description className="sr-only">{title}</RD.Description>
              )}
            </div>
            <RD.Close className="rounded-md p-1 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="Close">
              <X className="size-5" />
            </RD.Close>
          </div>
          <div className="overflow-y-auto px-6 py-5">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line px-6 py-4">{footer}</div>}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

interface ConfirmProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  /** When set, the user must give a reason; it is passed to onConfirm and stored in the history. */
  requireReason?: boolean;
  /** When set, the user must type this exact word to enable the confirm button. */
  typeToConfirm?: string;
  busy?: boolean;
  onConfirm(reason: string): void;
}

/** Confirmation for significant actions, optionally requiring a reason or a typed word. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone = 'primary',
  requireReason,
  typeToConfirm,
  busy,
  onConfirm,
}: ConfirmProps) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const ready = (!requireReason || reason.trim().length >= 3) && (!typeToConfirm || typed.trim() === typeToConfirm);
  const close = (o: boolean) => {
    if (!o) {
      setReason('');
      setTyped('');
    }
    onOpenChange(o);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => close(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant={tone} busy={busy} disabled={!ready} onClick={() => onConfirm(reason.trim())}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="text-ink-2">{description}</div>
        {requireReason && (
          <Field label="Reason" required hint="Saved in the history with your name.">
            {(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus />}
          </Field>
        )}
        {typeToConfirm && (
          <Field label={`Type ${typeToConfirm} to confirm`} required>
            {(p) => <Input {...p} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}
          </Field>
        )}
      </div>
    </Dialog>
  );
}
