import type { HandlerContext, HandlerMap } from './dispatcher';
import {
  adjustSupplierBalance,
  createSupplier,
  getSupplier,
  listSuppliers,
  setSupplierActive,
  supplierLedger,
  updateSupplier,
} from '../services/suppliers';
import { cancelPurchase, createPurchase, createSupplierReturn, getPurchase, listPurchases } from '../services/purchases';
import {
  applySupplierCredit,
  listPayables,
  listSupplierPayments,
  payablesAgeing,
  payablesSummary,
  paySupplier,
  refundFromSupplier,
  reverseSupplierPayment,
} from '../services/supplierPayments';
import { AppError, ErrorCodes } from '@shared/errors';
import { businessDateOf } from '@shared/time';
import type { SessionInfo } from '@shared/contracts';

const asOf = (ctx: HandlerContext) => businessDateOf(ctx.env.clock.now(), ctx.env.timeZone);

/** Purchase bills, supplier balances and payments reveal costs, so only these roles may see them. */
export function canViewPurchasing(session: SessionInfo | null): boolean {
  return !!session && (['purchases.manage', 'suppliers.pay', 'reports.financial'] as const).some((p) => session.permissions.includes(p));
}

function requireView(ctx: HandlerContext): void {
  if (!canViewPurchasing(ctx.session)) throw new AppError(ErrorCodes.PERMISSION_DENIED, 'You do not have permission to see purchases and supplier balances.');
}

export function purchaseHandlers(): HandlerMap {
  return {
    'suppliers.list': { access: 'authenticated', handle: (input, ctx) => listSuppliers(ctx.env.db, input, asOf(ctx)) },
    'suppliers.get': { access: 'authenticated', handle: (input, ctx) => getSupplier(ctx.env.db, input.id, asOf(ctx)) },
    'suppliers.create': {
      access: 'suppliers.manage',
      handle: (input, ctx) => {
        if (input.openingBalance !== 0 && !ctx.session!.permissions.includes('suppliers.adjustBalance')) {
          throw new AppError(ErrorCodes.PERMISSION_DENIED, 'Entering an opening balance needs the supplier balance adjustment permission.');
        }
        return createSupplier(ctx.env, ctx.actor, input);
      },
    },
    'suppliers.update': { access: 'suppliers.manage', handle: (input, ctx) => updateSupplier(ctx.env, ctx.actor, input) },
    'suppliers.setActive': { access: 'suppliers.manage', handle: (input, ctx) => setSupplierActive(ctx.env, ctx.actor, input) },
    'suppliers.ledger': {
      access: 'authenticated',
      handle: (input, ctx) => {
        requireView(ctx);
        return supplierLedger(ctx.env.db, input.id, input, asOf(ctx));
      },
    },
    'suppliers.adjustBalance': { access: 'suppliers.adjustBalance', handle: (input, ctx) => adjustSupplierBalance(ctx.env, ctx.actor, input) },

    'purchases.create': {
      access: 'purchases.manage',
      handle: (input, ctx) => {
        if (input.payments.length > 0 && !ctx.session!.permissions.includes('suppliers.pay')) {
          throw new AppError(ErrorCodes.PERMISSION_DENIED, 'Recording a payment to the supplier needs the supplier payment permission.');
        }
        return createPurchase(ctx.env, ctx.actor, input);
      },
    },
    'purchases.list': {
      access: 'authenticated',
      handle: (input, ctx) => {
        requireView(ctx);
        return listPurchases(ctx.env.db, input, asOf(ctx));
      },
    },
    'purchases.get': {
      access: 'authenticated',
      handle: (input, ctx) => {
        requireView(ctx);
        return getPurchase(ctx.env.db, input.id, asOf(ctx));
      },
    },
    'purchases.cancel': {
      access: 'purchases.manage',
      handle: (input, ctx) => {
        cancelPurchase(ctx.env, ctx.actor, input);
        return getPurchase(ctx.env.db, input.id, asOf(ctx));
      },
    },
    'supplierReturns.create': { access: 'purchases.manage', handle: (input, ctx) => createSupplierReturn(ctx.env, ctx.actor, input) },

    'supplierPayments.create': { access: 'suppliers.pay', handle: (input, ctx) => paySupplier(ctx.env, ctx.actor, input) },
    'supplierPayments.refund': { access: 'suppliers.pay', handle: (input, ctx) => refundFromSupplier(ctx.env, ctx.actor, input) },
    'supplierPayments.reverse': { access: 'suppliers.pay', handle: (input, ctx) => reverseSupplierPayment(ctx.env, ctx.actor, input) },
    'supplierPayments.applyCredit': {
      access: 'suppliers.pay',
      handle: (input, ctx) => {
        applySupplierCredit(ctx.env, ctx.actor, input);
        return getSupplier(ctx.env.db, input.supplierId, asOf(ctx));
      },
    },
    'supplierPayments.list': {
      access: 'authenticated',
      handle: (input, ctx) => {
        requireView(ctx);
        return listSupplierPayments(ctx.env.db, input);
      },
    },

    'payables.list': {
      access: 'authenticated',
      handle: (input, ctx) => {
        requireView(ctx);
        return listPayables(ctx.env.db, input, asOf(ctx));
      },
    },
    'payables.ageing': {
      access: 'authenticated',
      handle: (input, ctx) => {
        requireView(ctx);
        return payablesAgeing(ctx.env.db, asOf(ctx), input.search);
      },
    },
    'payables.summary': {
      access: 'authenticated',
      handle: (_i, ctx) => {
        requireView(ctx);
        return payablesSummary(ctx.env.db, asOf(ctx));
      },
    },
  };
}
