import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Eye, FileDown } from 'lucide-react';
import { formatMoney } from '@shared/money';
import { formatDate } from '@shared/time';
import { useCommandQuery } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/form';
import { Spinner } from '../../components/ui/layout';
import { Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { DocumentPreview, useDocumentActions } from '../sales/DocumentPreview';

const balanceText = (b: number) => (b === 0 ? '0.00' : b > 0 ? `${formatMoney(b)} Dr` : `${formatMoney(-b)} Cr`);

/** The customer's running account for a period, with a printable statement. */
export function CustomerLedgerView({ customerId, customerName }: { customerId: number; customerName: string }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [preview, setPreview] = useState(false);
  const ledger = useCommandQuery('customers.ledger', { id: customerId, from: from || undefined, to: to || undefined });
  const actions = useDocumentActions();
  const doc = { kind: 'STATEMENT' as const, id: customerId, paper: 'A4' as const, from: ledger.data?.from, to: ledger.data?.to, title: `Statement · ${customerName}` };

  const linkFor = (refType: string, refId: string) =>
    refType === 'INVOICE' || refType === 'INVOICE_CANCEL' ? `/sales/invoices/${refId}` : null;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line p-3.5">
        <div className="flex gap-3">
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            From
            <Input type="date" value={from || ledger.data?.from || ''} onChange={(e) => setFrom(e.target.value)} className="w-40" />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            To
            <Input type="date" value={to || ledger.data?.to || ''} onChange={(e) => setTo(e.target.value)} className="w-40" />
          </label>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" icon={<Eye className="size-4" />} onClick={() => setPreview(true)} disabled={!ledger.data}>
            Statement
          </Button>
          <Button variant="ghost" icon={<FileDown className="size-4" />} busy={actions.busy === 'pdf'} disabled={!ledger.data} onClick={() => actions.pdf(doc)}>
            PDF
          </Button>
        </div>
      </div>
      {!ledger.data ? (
        <Spinner />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Date</Th>
              <Th>Document</Th>
              <Th>Details</Th>
              <Th align="right">Debit</Th>
              <Th align="right">Credit</Th>
              <Th align="right">Balance</Th>
            </tr>
          </THead>
          <tbody>
            <Tr>
              <Td className="tabular">{formatDate(ledger.data.from)}</Td>
              <Td />
              <Td className="font-medium">Opening balance</Td>
              <Td />
              <Td />
              <Td align="right" className="font-medium">
                {balanceText(ledger.data.openingBalance)}
              </Td>
            </Tr>
            {ledger.data.rows.map((r, i) => {
              const link = linkFor(r.refType, r.refId);
              return (
                <Tr key={i}>
                  <Td className="tabular whitespace-nowrap">{formatDate(r.businessDate)}</Td>
                  <Td className="font-mono text-[13px]">
                    {link ? (
                      <Link to={link} className="text-brand hover:underline">
                        {r.docNo}
                      </Link>
                    ) : (
                      r.docNo
                    )}
                  </Td>
                  <Td>{r.description}</Td>
                  <Td align="right">{r.debit ? formatMoney(r.debit) : ''}</Td>
                  <Td align="right">{r.credit ? formatMoney(r.credit) : ''}</Td>
                  <Td align="right">{balanceText(r.balance)}</Td>
                </Tr>
              );
            })}
            <Tr className="bg-surface-2/60 font-semibold">
              <Td />
              <Td />
              <Td>Closing balance</Td>
              <Td align="right">{formatMoney(ledger.data.totalDebit)}</Td>
              <Td align="right">{formatMoney(ledger.data.totalCredit)}</Td>
              <Td align="right">{balanceText(ledger.data.closingBalance)}</Td>
            </Tr>
          </tbody>
        </Table>
      )}
      {preview && <DocumentPreview doc={doc} onClose={() => setPreview(false)} />}
    </>
  );
}
