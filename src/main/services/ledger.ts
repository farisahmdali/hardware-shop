import type { Db } from '../db/connection';
import type { Tx } from '../db/tx';
import { AppError, ErrorCodes } from '@shared/errors';

export type AccountCode =
  | 'CASH'
  | 'BANK'
  | 'UPI'
  | 'CARD'
  | 'CHEQUE'
  | 'AR'
  | 'INVENTORY'
  | 'INPUT_GST'
  | 'AP'
  | 'OUTPUT_CGST'
  | 'OUTPUT_SGST'
  | 'OUTPUT_IGST'
  | 'DEPOSIT_LIABILITY'
  | 'CUSTOMER_ADVANCES'
  | 'SALES'
  | 'SALES_RETURNS'
  | 'RENTAL_INCOME'
  | 'LATE_FEE_INCOME'
  | 'DAMAGE_INCOME'
  | 'ROUND_OFF'
  | 'COGS'
  | 'INVENTORY_LOSS'
  | 'OPERATING_EXPENSES'
  | 'CASH_OVER_SHORT'
  | 'BALANCE_ADJUSTMENTS'
  | 'OWNER_EQUITY';

export interface LedgerLine {
  account: AccountCode;
  debit?: number;
  credit?: number;
  partyType?: 'CUSTOMER' | 'SUPPLIER';
  partyId?: number;
  memo?: string;
}

const accountIds = new WeakMap<Db, Map<string, number>>();

function accountId(db: Db, code: AccountCode): number {
  let map = accountIds.get(db);
  if (!map) {
    map = new Map(
      (db.prepare('SELECT id, code FROM accounts').all() as { id: number; code: string }[]).map((a) => [a.code, a.id]),
    );
    accountIds.set(db, map);
  }
  const id = map.get(code);
  if (id === undefined) throw new Error(`Unknown account ${code}`);
  return id;
}

/**
 * Posts one balanced double-entry transaction. Zero-amount lines are dropped;
 * the debits must equal the credits or nothing is written.
 */
export function postLedger(
  tx: Tx,
  entry: { refType: string; refId: string | number; memo?: string; lines: LedgerLine[] },
): void {
  const lines = entry.lines.filter((l) => (l.debit ?? 0) !== 0 || (l.credit ?? 0) !== 0);
  if (lines.length === 0) return;
  let debits = 0;
  let credits = 0;
  for (const l of lines) {
    const d = l.debit ?? 0;
    const c = l.credit ?? 0;
    if (!Number.isSafeInteger(d) || !Number.isSafeInteger(c) || d < 0 || c < 0 || (d > 0 && c > 0)) {
      throw new Error(`Invalid ledger line ${JSON.stringify(l)}`);
    }
    debits += d;
    credits += c;
  }
  if (debits !== credits) {
    throw new AppError(ErrorCodes.INTERNAL, `Ledger entry is unbalanced (${debits} ≠ ${credits}); nothing was saved.`);
  }
  const insert = tx.db.prepare(
    `INSERT INTO ledger_entries (txn_ref, occurred_at, business_date, account_id, party_type, party_id, debit, credit,
       ref_type, ref_id, memo, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const l of lines) {
    insert.run(
      tx.txnRef,
      tx.nowIso,
      tx.businessDate,
      accountId(tx.db, l.account),
      l.partyType ?? null,
      l.partyId ?? null,
      l.debit ?? 0,
      l.credit ?? 0,
      entry.refType,
      String(entry.refId),
      l.memo ?? entry.memo ?? null,
      tx.actor.userId,
    );
  }
}

/** Balance of an account (debits minus credits), optionally for one party. */
export function accountBalance(db: Db, code: AccountCode, party?: { type: 'CUSTOMER' | 'SUPPLIER'; id: number }): number {
  const row = party
    ? db
        .prepare(
          `SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries
           WHERE account_id = ? AND party_type = ? AND party_id = ?`,
        )
        .get(accountId(db, code), party.type, party.id)
    : db.prepare('SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries WHERE account_id = ?').get(accountId(db, code));
  return (row as { b: number }).b;
}
