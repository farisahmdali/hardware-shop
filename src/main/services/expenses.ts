import type { Db } from '../db/connection';
import { transact, type Actor, type Tx } from '../db/tx';
import type { AppEnv } from './env';
import { postLedger, type AccountCode } from './ledger';
import { methodAccount } from './payments';
import { AppError, ErrorCodes } from '@shared/errors';
import type { CategoryRow, ExpenseList, ExpenseRow, ExpenseSummary } from '@shared/contracts';

export interface ExpenseFields {
  categoryId: number;
  description: string;
  amount: number;
  expenseDate: string;
  methodId: number;
  payee: string;
  reference: string;
  notes: string;
}

// ---------- Categories ----------

interface CategoryRecord {
  id: number;
  name: string;
  is_active: number;
  version: number;
  usage: number;
}

const CATEGORY_SQL = `SELECT c.id, c.name, c.is_active, c.version, (SELECT COUNT(*) FROM expenses e WHERE e.category_id = c.id) AS usage
  FROM categories c WHERE c.kind = 'EXPENSE'`;

const toCategory = (r: CategoryRecord): CategoryRow => ({
  id: r.id,
  kind: 'EXPENSE',
  name: r.name,
  isActive: r.is_active === 1,
  version: r.version,
  usageCount: r.usage,
});

export function listExpenseCategories(db: Db, includeInactive: boolean): CategoryRow[] {
  return (db.prepare(`${CATEGORY_SQL} ${includeInactive ? '' : 'AND c.is_active = 1'} ORDER BY c.name`).all() as CategoryRecord[]).map(toCategory);
}

export function saveExpenseCategory(env: AppEnv, actor: Actor, input: { id?: number; name: string; isActive: boolean; version?: number }): CategoryRow {
  return transact(env, actor, (tx) => {
    const dup = tx.db.prepare("SELECT id FROM categories WHERE kind = 'EXPENSE' AND name = ?").get(input.name) as { id: number } | undefined;
    if (dup && dup.id !== input.id) throw new AppError(ErrorCodes.CONFLICT, `The expense category "${input.name}" already exists.`);
    let id = input.id;
    if (id === undefined) {
      id = Number(
        tx.db
          .prepare("INSERT INTO categories (kind, name, is_active, created_at, updated_at) VALUES ('EXPENSE', ?, ?, ?, ?)")
          .run(input.name, input.isActive ? 1 : 0, tx.nowIso, tx.nowIso).lastInsertRowid,
      );
      tx.audit({ module: 'expenses', entityType: 'expense_category', entityId: id, action: 'CREATE', after: { name: input.name, isActive: input.isActive } });
    } else {
      const before = tx.db.prepare("SELECT name, is_active FROM categories WHERE id = ? AND kind = 'EXPENSE'").get(id) as
        | { name: string; is_active: number }
        | undefined;
      if (!before) throw new AppError(ErrorCodes.NOT_FOUND, 'Expense category not found.');
      const result = tx.db
        .prepare("UPDATE categories SET name = ?, is_active = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ? AND kind = 'EXPENSE'")
        .run(input.name, input.isActive ? 1 : 0, tx.nowIso, id, input.version ?? -1);
      tx.expectOneChange(result.changes, 'This category');
      tx.audit({
        module: 'expenses',
        entityType: 'expense_category',
        entityId: id,
        action: before.is_active === 1 && !input.isActive ? 'DEACTIVATE' : 'UPDATE',
        before: { name: before.name, isActive: before.is_active === 1 },
        after: { name: input.name, isActive: input.isActive },
      });
    }
    return toCategory(tx.db.prepare(`${CATEGORY_SQL} AND c.id = ?`).get(id) as CategoryRecord);
  });
}

// ---------- Expenses ----------

interface ExpenseRecord {
  id: number;
  expense_no: string;
  category_id: number;
  category_name: string;
  description: string;
  amount: number;
  expense_date: string;
  method_id: number;
  method_name: string;
  payee: string;
  reference_no: string;
  notes: string;
  status: 'ACTIVE' | 'VOID';
  void_reason: string | null;
  created_at: string;
  created_by_name: string | null;
  updated_at: string;
  version: number;
}

const EXPENSE_SELECT = `
  SELECT e.*, c.name AS category_name, m.name AS method_name, u.username AS created_by_name
  FROM expenses e
  JOIN categories c ON c.id = e.category_id
  JOIN payment_methods m ON m.id = e.method_id
  LEFT JOIN users u ON u.id = e.created_by`;

const toRow = (r: ExpenseRecord): ExpenseRow => ({
  id: r.id,
  expenseNo: r.expense_no,
  categoryId: r.category_id,
  categoryName: r.category_name,
  description: r.description,
  amount: r.amount,
  expenseDate: r.expense_date,
  methodId: r.method_id,
  methodName: r.method_name,
  payee: r.payee,
  reference: r.reference_no,
  notes: r.notes,
  status: r.status,
  voidReason: r.void_reason,
  createdAt: r.created_at,
  createdBy: r.created_by_name,
  updatedAt: r.updated_at,
  edited: r.status === 'ACTIVE' && r.version > 1,
  version: r.version,
});

export function getExpense(db: Db, id: number): ExpenseRow {
  const r = db.prepare(`${EXPENSE_SELECT} WHERE e.id = ?`).get(id) as ExpenseRecord | undefined;
  if (!r) throw new AppError(ErrorCodes.NOT_FOUND, 'Expense not found.');
  return toRow(r);
}

function validateFields(tx: Tx, f: ExpenseFields): { methodName: string } {
  const c = tx.db.prepare('SELECT kind, name, is_active FROM categories WHERE id = ?').get(f.categoryId) as
    | { kind: string; name: string; is_active: number }
    | undefined;
  if (!c || c.kind !== 'EXPENSE') throw new AppError(ErrorCodes.VALIDATION, 'Choose an expense category.');
  if (!c.is_active) throw new AppError(ErrorCodes.BUSINESS_RULE, `The category "${c.name}" is no longer in use.`);
  if (f.expenseDate > tx.businessDate) throw new AppError(ErrorCodes.VALIDATION, 'An expense cannot be dated in the future.');
  return { methodName: methodAccount(tx.db, f.methodId).name };
}

/**
 * Ledger entry of an expense on its own date: the expense account against the account the money
 * left from. Corrections and voids post the reverse of what was recorded, then any replacement.
 */
function postExpense(
  tx: Tx,
  e: { id: number; expenseNo: string; amount: number; methodId: number; date: string },
  opts: { reverse: boolean; correction: string | null },
): void {
  // Not methodAccount(): an old expense must stay reversible after its method is retired.
  const method = tx.db
    .prepare('SELECT a.code FROM payment_methods m JOIN accounts a ON a.id = m.account_id WHERE m.id = ?')
    .get(e.methodId) as { code: AccountCode };
  const expense = { account: 'OPERATING_EXPENSES' as const, amount: e.amount };
  postLedger(tx, {
    refType: opts.correction === null ? 'EXPENSE' : 'EXPENSE_CORRECTION',
    refId: e.id,
    businessDate: e.date,
    memo: opts.correction === null ? e.expenseNo : `${e.expenseNo}: ${opts.correction}`,
    lines: opts.reverse
      ? [
          { account: method.code, debit: expense.amount },
          { account: expense.account, credit: expense.amount },
        ]
      : [
          { account: expense.account, debit: expense.amount },
          { account: method.code, credit: expense.amount },
        ],
  });
}

function snapshot(r: ExpenseRecord) {
  return {
    category: r.category_name,
    description: r.description,
    amount: r.amount,
    expenseDate: r.expense_date,
    method: r.method_name,
    payee: r.payee,
    reference: r.reference_no,
    notes: r.notes,
  };
}

export function createExpense(env: AppEnv, actor: Actor, input: ExpenseFields & { requestId: string }): ExpenseRow {
  const id = transact(env, actor, (tx) =>
    tx.once(input.requestId, 'expenses.create', () => {
      validateFields(tx, input);
      const expenseNo = tx.nextDocNumber('EXPENSE');
      const newId = Number(
        tx.db
          .prepare(
            `INSERT INTO expenses (expense_no, client_request_id, category_id, description, amount, expense_date, method_id, payee,
               reference_no, notes, created_at, created_by, updated_at, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            expenseNo,
            input.requestId,
            input.categoryId,
            input.description,
            input.amount,
            input.expenseDate,
            input.methodId,
            input.payee,
            input.reference,
            input.notes,
            tx.nowIso,
            tx.actor.userId,
            tx.nowIso,
            tx.actor.userId,
          ).lastInsertRowid,
      );
      postExpense(tx, { id: newId, expenseNo, amount: input.amount, methodId: input.methodId, date: input.expenseDate }, { reverse: false, correction: null });
      const r = tx.db.prepare(`${EXPENSE_SELECT} WHERE e.id = ?`).get(newId) as ExpenseRecord;
      tx.audit({ module: 'expenses', entityType: 'expense', entityId: newId, action: 'CREATE', after: { expenseNo, ...snapshot(r) } });
      return newId;
    }),
  );
  return getExpense(env.db, id);
}

/**
 * Corrects an expense. When the amount, payment method or date changes, the original ledger entry
 * is reversed and the corrected one posted, both on their own dates, so the accounts and the cash
 * book read as if the expense had been entered correctly. The history keeps both versions.
 */
export function updateExpense(env: AppEnv, actor: Actor, input: ExpenseFields & { id: number; version: number; reason: string }): ExpenseRow {
  transact(env, actor, (tx) => {
    const before = tx.db.prepare(`${EXPENSE_SELECT} WHERE e.id = ?`).get(input.id) as ExpenseRecord | undefined;
    if (!before) throw new AppError(ErrorCodes.NOT_FOUND, 'Expense not found.');
    if (before.status === 'VOID') throw new AppError(ErrorCodes.BUSINESS_RULE, `${before.expense_no} was voided and cannot be changed.`);
    validateFields(tx, input);
    const result = tx.db
      .prepare(
        `UPDATE expenses SET category_id = ?, description = ?, amount = ?, expense_date = ?, method_id = ?, payee = ?, reference_no = ?,
           notes = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ? AND version = ?`,
      )
      .run(
        input.categoryId,
        input.description,
        input.amount,
        input.expenseDate,
        input.methodId,
        input.payee,
        input.reference,
        input.notes,
        tx.nowIso,
        tx.actor.userId,
        input.id,
        input.version,
      );
    tx.expectOneChange(result.changes, 'This expense');
    const after = tx.db.prepare(`${EXPENSE_SELECT} WHERE e.id = ?`).get(input.id) as ExpenseRecord;
    if (before.amount !== after.amount || before.method_id !== after.method_id || before.expense_date !== after.expense_date) {
      const correction = `corrected: ${input.reason}`;
      postExpense(tx, { id: before.id, expenseNo: before.expense_no, amount: before.amount, methodId: before.method_id, date: before.expense_date }, { reverse: true, correction });
      postExpense(tx, { id: after.id, expenseNo: after.expense_no, amount: after.amount, methodId: after.method_id, date: after.expense_date }, { reverse: false, correction });
    }
    const b = snapshot(before);
    const a = snapshot(after);
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      tx.audit({ module: 'expenses', entityType: 'expense', entityId: input.id, action: 'UPDATE', before: b, after: a, reason: input.reason });
    }
  });
  return getExpense(env.db, input.id);
}

/** Voids an expense recorded by mistake. It stays on record, marked void, and its ledger entry is reversed. */
export function voidExpense(env: AppEnv, actor: Actor, input: { id: number; version: number; reason: string }): ExpenseRow {
  transact(env, actor, (tx) => {
    const e = tx.db.prepare(`${EXPENSE_SELECT} WHERE e.id = ?`).get(input.id) as ExpenseRecord | undefined;
    if (!e) throw new AppError(ErrorCodes.NOT_FOUND, 'Expense not found.');
    if (e.status === 'VOID') throw new AppError(ErrorCodes.BUSINESS_RULE, `${e.expense_no} is already void.`);
    const result = tx.db
      .prepare(
        `UPDATE expenses SET status = 'VOID', void_reason = ?, voided_at = ?, voided_by = ?, updated_at = ?, updated_by = ?, version = version + 1
         WHERE id = ? AND version = ?`,
      )
      .run(input.reason, tx.nowIso, tx.actor.userId, tx.nowIso, tx.actor.userId, input.id, input.version);
    tx.expectOneChange(result.changes, 'This expense');
    postExpense(tx, { id: e.id, expenseNo: e.expense_no, amount: e.amount, methodId: e.method_id, date: e.expense_date }, { reverse: true, correction: `voided: ${input.reason}` });
    tx.audit({
      module: 'expenses',
      entityType: 'expense',
      entityId: e.id,
      action: 'VOID',
      before: { status: 'ACTIVE', amount: e.amount },
      after: { status: 'VOID' },
      reason: input.reason,
    });
  });
  return getExpense(env.db, input.id);
}

export function listExpenses(
  db: Db,
  f: { search?: string; categoryId?: number; methodId?: number; from?: string; to?: string; status: 'ACTIVE' | 'VOID' | 'ALL'; page: number; pageSize: number },
): ExpenseList {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.status !== 'ALL') {
    where.push('e.status = ?');
    params.push(f.status);
  }
  if (f.categoryId) {
    where.push('e.category_id = ?');
    params.push(f.categoryId);
  }
  if (f.methodId) {
    where.push('e.method_id = ?');
    params.push(f.methodId);
  }
  if (f.from) {
    where.push('e.expense_date >= ?');
    params.push(f.from);
  }
  if (f.to) {
    where.push('e.expense_date <= ?');
    params.push(f.to);
  }
  if (f.search) {
    const like = `%${f.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push("(e.expense_no LIKE ? ESCAPE '\\' OR e.description LIKE ? ESCAPE '\\' OR e.payee LIKE ? ESCAPE '\\' OR e.reference_no LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const agg = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(e.amount), 0) AS sum FROM expenses e ${clause}`).get(...params) as { n: number; sum: number };
  const rows = db
    .prepare(`${EXPENSE_SELECT} ${clause} ORDER BY e.expense_date DESC, e.id DESC LIMIT ? OFFSET ?`)
    .all(...params, f.pageSize, (f.page - 1) * f.pageSize) as ExpenseRecord[];
  return { rows: rows.map(toRow), total: agg.n, page: f.page, pageSize: f.pageSize, totalAmount: agg.sum };
}

export function expenseSummary(db: Db, today: string): ExpenseSummary {
  const monthStart = `${today.slice(0, 7)}-01`;
  const t = db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM expenses WHERE status = 'ACTIVE' AND expense_date = ?").get(today) as { s: number };
  const byCategory = db
    .prepare(
      `SELECT c.name AS categoryName, SUM(e.amount) AS amount FROM expenses e JOIN categories c ON c.id = e.category_id
       WHERE e.status = 'ACTIVE' AND e.expense_date BETWEEN ? AND ? GROUP BY c.id ORDER BY amount DESC`,
    )
    .all(monthStart, today) as { categoryName: string; amount: number }[];
  return { today: t.s, month: byCategory.reduce((a, r) => a + r.amount, 0), monthByCategory: byCategory };
}
