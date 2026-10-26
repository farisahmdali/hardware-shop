import type { HandlerContext, HandlerMap } from './dispatcher';
import {
  createExpense,
  expenseSummary,
  getExpense,
  listExpenseCategories,
  listExpenses,
  saveExpenseCategory,
  updateExpense,
  voidExpense,
} from '../services/expenses';
import { addCashEntry, cashDay, countCash, listCashCounts, reverseCashEntry } from '../services/cash';
import { AppError, ErrorCodes } from '@shared/errors';
import { businessDateOf } from '@shared/time';

const today = (ctx: HandlerContext) => businessDateOf(ctx.env.clock.now(), ctx.env.timeZone);

export function expenseHandlers(): HandlerMap {
  return {
    'expenses.list': { access: 'expenses.manage', handle: (input, ctx) => listExpenses(ctx.env.db, input) },
    'expenses.get': { access: 'expenses.manage', handle: (input, ctx) => getExpense(ctx.env.db, input.id) },
    'expenses.create': { access: 'expenses.manage', handle: (input, ctx) => createExpense(ctx.env, ctx.actor, input) },
    'expenses.update': { access: 'expenses.manage', handle: (input, ctx) => updateExpense(ctx.env, ctx.actor, input) },
    'expenses.void': { access: 'expenses.manage', handle: (input, ctx) => voidExpense(ctx.env, ctx.actor, input) },
    'expenses.summary': {
      access: 'authenticated',
      handle: (_i, ctx) => {
        const p = ctx.session!.permissions;
        if (!p.includes('expenses.manage') && !p.includes('reports.financial')) {
          throw new AppError(ErrorCodes.PERMISSION_DENIED, 'You do not have permission to see expenses.');
        }
        return expenseSummary(ctx.env.db, today(ctx));
      },
    },
    'expenseCategories.list': { access: 'expenses.manage', handle: (input, ctx) => listExpenseCategories(ctx.env.db, input.includeInactive) },
    'expenseCategories.save': { access: 'expenses.manage', handle: (input, ctx) => saveExpenseCategory(ctx.env, ctx.actor, input) },

    'cash.day': { access: 'cash.reconcile', handle: (input, ctx) => cashDay(ctx.env, input.date) },
    'cash.addEntry': { access: 'cash.reconcile', handle: (input, ctx) => addCashEntry(ctx.env, ctx.actor, input) },
    'cash.reverseEntry': { access: 'cash.reconcile', handle: (input, ctx) => reverseCashEntry(ctx.env, ctx.actor, input) },
    'cash.count': { access: 'cash.reconcile', handle: (input, ctx) => countCash(ctx.env, ctx.actor, input) },
    'cash.counts': { access: 'cash.reconcile', handle: (input, ctx) => listCashCounts(ctx.env.db, input) },
  };
}
