import { X } from 'lucide-react';
import type { AssetStatus, RentalStatus } from '@shared/contracts';
import { formatMoney } from '@shared/money';
import { describeDuration } from '@shared/rentalPricing';
import { useCommandQuery } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/form';
import { Badge } from '../../components/ui/layout';
import { MoneyInput } from '../../components/ui/numberInputs';

export const ASSET_STATUS: Record<AssetStatus, { label: string; tone: 'success' | 'info' | 'warning' | 'danger' | 'neutral' | 'accent' }> = {
  AVAILABLE: { label: 'Available', tone: 'success' },
  RESERVED: { label: 'Reserved', tone: 'info' },
  RENTED: { label: 'Out on rent', tone: 'info' },
  AWAITING_INSPECTION: { label: 'Awaiting inspection', tone: 'accent' },
  DAMAGED: { label: 'Damaged', tone: 'danger' },
  MAINTENANCE: { label: 'Under maintenance', tone: 'warning' },
  RETIRED: { label: 'Retired', tone: 'neutral' },
};

export function AssetStatusBadge({ status, overdue }: { status: AssetStatus; overdue?: boolean }) {
  if (status === 'RENTED' && overdue) return <Badge tone="danger">Overdue</Badge>;
  const s = ASSET_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export const RENTAL_STATUS: Record<RentalStatus, { label: string; tone: 'success' | 'info' | 'warning' | 'danger' | 'neutral' | 'accent' | 'brand' }> = {
  RESERVED: { label: 'Reserved', tone: 'info' },
  ACTIVE: { label: 'Out', tone: 'brand' },
  PARTIALLY_RETURNED: { label: 'Part returned', tone: 'accent' },
  RETURNED: { label: 'Returned · to settle', tone: 'warning' },
  CLOSED: { label: 'Closed', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

export function RentalStatusBadge({ status, overdue }: { status: RentalStatus; overdue?: boolean }) {
  if (overdue) return <Badge tone="danger">Overdue</Badge>;
  const s = RENTAL_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export const lateText = (minutes: number) => `${describeDuration(minutes)} late`;

/** ISO instant → value for <input type="datetime-local"> in this computer's time zone. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const t = new Date(value);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

export interface PaymentEntry {
  key: string;
  methodId: number;
  amount: number | null;
  reference: string;
}

/** Payment method buttons plus editable payment rows. */
export function PaymentLines({ due, value, onChange, label = 'Payment now (optional)' }: { due: number; value: PaymentEntry[]; onChange(p: PaymentEntry[]): void; label?: string }) {
  const methods = useCommandQuery('paymentMethods.list', {});
  const paid = value.reduce((a, p) => a + (p.amount ?? 0), 0);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[13px] font-medium text-ink-2">{label}</span>
        {methods.data?.map((m) => (
          <Button
            key={m.id}
            size="sm"
            variant="outline"
            disabled={due - paid <= 0}
            onClick={() => onChange([...value, { key: crypto.randomUUID(), methodId: m.id, amount: Math.max(0, due - paid), reference: '' }])}
          >
            {m.name}
          </Button>
        ))}
      </div>
      {value.map((p) => {
        const m = methods.data?.find((x) => x.id === p.methodId);
        return (
          <div key={p.key} className="mb-1.5 grid grid-cols-[110px_1fr_140px_32px] items-center gap-2">
            <span className="font-medium">{m?.name}</span>
            <Input
              aria-label={`${m?.name} reference`}
              placeholder="Reference (optional)"
              className="h-9"
              value={p.reference}
              onChange={(e) => onChange(value.map((x) => (x.key === p.key ? { ...x, reference: e.target.value } : x)))}
            />
            <MoneyInput
              aria-label={`${m?.name} amount`}
              className="h-9"
              value={p.amount}
              onValueChange={(v) => onChange(value.map((x) => (x.key === p.key ? { ...x, amount: v } : x)))}
            />
            <button type="button" aria-label="Remove payment" className="rounded p-1.5 text-ink-3 hover:bg-surface-2" onClick={() => onChange(value.filter((x) => x.key !== p.key))}>
              <X className="size-4" />
            </button>
          </div>
        );
      })}
      {due > 0 && (
        <p className="text-[13px] text-ink-3">
          Due {formatMoney(due)} · paying {formatMoney(paid)}
          {due - paid > 0 && ` · ${formatMoney(due - paid)} stays on the customer's account`}
        </p>
      )}
    </div>
  );
}

export const toPayments = (ps: PaymentEntry[]) =>
  ps.filter((p) => (p.amount ?? 0) > 0).map((p) => ({ methodId: p.methodId, amount: p.amount!, reference: p.reference }));
