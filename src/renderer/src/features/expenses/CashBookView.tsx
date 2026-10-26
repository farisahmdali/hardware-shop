import { useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Calculator, ChevronLeft, ChevronRight, Coins } from 'lucide-react';
import type { CashEntryRow, CashFlowLine } from '@shared/contracts';
import { formatMoney } from '@shared/money';
import { businessDateOf, formatDate, formatDateTime } from '@shared/time';
import { errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/form';
import { Badge, Card, CardHeader, Spinner } from '../../components/ui/layout';
import { Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { HistoryButton } from '../history/EntityHistory';
import { cn } from '../../lib/cn';
import { CASH_ENTRY_LABELS, CashCountDialog, CashEntryDialog } from './CashDialogs';
import { EXPENSE_INVALIDATE } from './ExpenseDialog';

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function FlowList({ title, icon: Icon, lines, total, tone }: { title: string; icon: typeof Coins; lines: CashFlowLine[]; total: number; tone: 'success' | 'danger' }) {
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Icon className={cn('size-4', tone === 'success' ? 'text-success' : 'text-danger')} />
            {title}
          </span>
        }
        actions={<span className="tabular text-[15px] font-semibold">{formatMoney(total)}</span>}
      />
      {lines.length === 0 ? (
        <p className="px-5 py-4 text-ink-3">None</p>
      ) : (
        <ul className="divide-y divide-line">
          {lines.map((l) => (
            <li key={l.key} className="flex justify-between gap-3 px-5 py-2.5">
              <span>
                {l.label} <span className="text-[12px] text-ink-3">· {l.count}</span>
              </span>
              <span className="tabular">{formatMoney(l.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** One day of the cash drawer: opening, money in and out by kind, the expected closing, and counts. */
export function CashBookView() {
  const toast = useToast();
  const today = businessDateOf(new Date());
  const [date, setDate] = useState(today);
  const day = useCommandQuery('cash.day', { date });
  const [dialog, setDialog] = useState<'entry' | 'count' | null>(null);
  const [reversing, setReversing] = useState<CashEntryRow | null>(null);
  const reverse = useCommandMutation('cash.reverseEntry', { invalidate: EXPENSE_INVALIDATE });

  if (!day.data) return <Spinner />;
  const d = day.data;
  const lastCount = d.counts[d.counts.length - 1];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" aria-label="Previous day" onClick={() => setDate(shift(date, -1))}>
            <ChevronLeft className="size-4" />
          </Button>
          <Input aria-label="Cash book date" type="date" className="h-8 w-40" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <Button variant="outline" size="sm" aria-label="Next day" disabled={date >= today} onClick={() => setDate(shift(date, 1))}>
            <ChevronRight className="size-4" />
          </Button>
          {!d.isToday && (
            <Button variant="ghost" size="sm" onClick={() => setDate(today)}>
              Today
            </Button>
          )}
        </div>
        {d.isToday && (
          <div className="flex gap-2">
            <Button variant="outline" icon={<Coins className="size-4" />} onClick={() => setDialog('entry')}>
              Cash in / out
            </Button>
            <Button icon={<Calculator className="size-4" />} onClick={() => setDialog('count')}>
              Count cash
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Figure label="Opening cash" value={d.opening} sub={`End of ${formatDate(shift(d.date, -1))}`} />
        <Figure label="Cash in" value={d.totalIn} sub="Received in cash" tone="success" />
        <Figure label="Cash out" value={d.totalOut} sub="Paid out in cash" tone="danger" />
        <Figure
          label={d.isToday ? 'Should be in the drawer' : 'Closing cash'}
          value={d.closing}
          sub={lastCount ? `Last counted ${formatDateTime(lastCount.countedAt)}` : d.isToday ? 'Not counted yet today' : 'Not counted that day'}
          strong
        />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <FlowList title="Cash in" icon={ArrowDownLeft} lines={d.inflows} total={d.totalIn} tone="success" />
        <FlowList title="Cash out" icon={ArrowUpRight} lines={d.outflows} total={d.totalOut} tone="danger" />
      </div>

      {d.otherMethods.length > 0 && (
        <Card>
          <CardHeader title="Other accounts that day" description="UPI, card, bank and cheque movements, for reference. They are not in the drawer." />
          <Table>
            <THead>
              <tr>
                <Th>Account</Th>
                <Th align="right">In</Th>
                <Th align="right">Out</Th>
              </tr>
            </THead>
            <tbody>
              {d.otherMethods.map((m) => (
                <Tr key={m.methodName}>
                  <Td>{m.methodName}</Td>
                  <Td align="right">{m.received ? formatMoney(m.received) : '—'}</Td>
                  <Td align="right">{m.paid ? formatMoney(m.paid) : '—'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <Card>
        <CardHeader title="Counts" />
        {d.counts.length === 0 ? (
          <p className="px-5 py-4 text-ink-3">{d.isToday ? 'Count the drawer at the end of the day to check it against the records.' : 'No count was recorded that day.'}</p>
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>When</Th>
                <Th align="right">Records said</Th>
                <Th align="right">Counted</Th>
                <Th align="right">Difference</Th>
                <Th>Note</Th>
              </tr>
            </THead>
            <tbody>
              {d.counts.map((c) => (
                <Tr key={c.id}>
                  <Td className="tabular whitespace-nowrap">
                    {formatDateTime(c.countedAt)} <span className="text-ink-3">· {c.username}</span>
                  </Td>
                  <Td align="right">{formatMoney(c.expected)}</Td>
                  <Td align="right">{formatMoney(c.counted)}</Td>
                  <Td align="right" className={c.difference === 0 ? 'text-success' : 'font-medium text-danger'}>
                    {c.difference === 0 ? 'Matched' : `${c.difference > 0 ? 'Over' : 'Short'} ${formatMoney(Math.abs(c.difference))}`}
                  </Td>
                  <Td className="text-ink-2">{c.note}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {d.entries.length > 0 && (
        <Card>
          <CardHeader title="Cash entries" />
          <Table>
            <THead>
              <tr>
                <Th>Entry</Th>
                <Th>What</Th>
                <Th>Reason</Th>
                <Th align="right">Amount</Th>
                <Th />
              </tr>
            </THead>
            <tbody>
              {d.entries.map((e) => (
                <Tr key={e.id} className={e.reversal ? 'opacity-60' : undefined}>
                  <Td className="font-mono text-[13px] whitespace-nowrap">
                    {e.entryNo}
                    {e.reversal && (
                      <Badge tone="danger" className="ml-2">
                        Reversed
                      </Badge>
                    )}
                  </Td>
                  <Td>{CASH_ENTRY_LABELS[e.type].label}</Td>
                  <Td className="text-ink-2">
                    {e.reason}
                    {e.reversal && <span className="block text-[12px]">Reversed: {e.reversal.reason}</span>}
                  </Td>
                  <Td align="right" className={CASH_ENTRY_LABELS[e.type].into ? 'text-success' : 'text-danger'}>
                    {CASH_ENTRY_LABELS[e.type].into ? '+ ' : '− '}
                    {formatMoney(e.amount)}
                  </Td>
                  <Td align="right" className="whitespace-nowrap">
                    <HistoryButton entityType="cash_entry" entityId={e.id} title={`Cash entry ${e.entryNo}`} />
                    {!e.reversal && (
                      <Button size="sm" variant="ghost" onClick={() => setReversing(e)}>
                        Reverse
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {dialog === 'entry' && <CashEntryDialog expected={d.closing} onClose={() => setDialog(null)} />}
      {dialog === 'count' && <CashCountDialog expected={d.closing} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={!!reversing}
        onOpenChange={(o) => !o && setReversing(null)}
        title={`Reverse ${reversing?.entryNo}?`}
        description="The entry stays on record, marked reversed, and the cash it moved is put back."
        confirmLabel="Reverse"
        tone="danger"
        requireReason
        busy={reverse.isPending}
        onConfirm={async (reason) => {
          try {
            await reverse.mutateAsync({ id: reversing!.id, reason });
            toast.success(`${reversing!.entryNo} reversed`);
            setReversing(null);
          } catch (e) {
            toast.error('Could not reverse', errorMessage(e));
          }
        }}
      />
    </div>
  );
}

function Figure({ label, value, sub, tone, strong }: { label: string; value: number; sub: string; tone?: 'success' | 'danger'; strong?: boolean }) {
  return (
    <div className={cn('rounded-lg border bg-surface px-4 py-3 shadow-card', strong ? 'border-brand/40' : 'border-line')}>
      <p className="text-[12px] font-medium tracking-wide text-ink-3 uppercase">{label}</p>
      <p className={cn('tabular mt-1 text-2xl font-semibold', tone === 'success' && 'text-success', tone === 'danger' && 'text-danger', !tone && 'text-ink')}>
        {formatMoney(value)}
      </p>
      <p className="text-[13px] text-ink-3">{sub}</p>
    </div>
  );
}
