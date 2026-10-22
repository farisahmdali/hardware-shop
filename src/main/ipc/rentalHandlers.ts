import type { HandlerContext, HandlerMap } from './dispatcher';
import { canSeeCost } from './inventoryHandlers';
import {
  addAssets,
  assetHistory,
  createRentalProduct,
  getAsset,
  getRentalProduct,
  listAssets,
  listRentalProducts,
  setAssetStatus,
  setRentalProductActive,
  updateAsset,
  updateRentalProduct,
} from '../services/rentalCatalog';
import {
  availableAssets,
  cancelReservation,
  closeRental,
  createRental,
  extendRental,
  getRental,
  issueReserved,
  listRentals,
  quoteExtension,
  quoteRental,
  quoteReturn,
  rentalSummary,
  returnItems,
  settleDeposit,
} from '../services/rentals';
import type { SalesPermissions } from '../services/sales';
import { AppError, ErrorCodes } from '@shared/errors';

const nowIso = (ctx: HandlerContext) => ctx.env.clock.now().toISOString();
const perms = (ctx: HandlerContext): SalesPermissions => ({ permissions: ctx.session!.permissions, maxDiscountBp: ctx.session!.maxDiscountBp });

export function rentalHandlers(): HandlerMap {
  return {
    'rentalProducts.list': { access: 'authenticated', handle: (input, { env }) => listRentalProducts(env.db, input) },
    'rentalProducts.get': { access: 'authenticated', handle: (input, ctx) => getRentalProduct(ctx.env.db, input.id, canSeeCost(ctx.session), nowIso(ctx)) },
    'rentalProducts.create': {
      access: 'rentals.manage',
      handle: (input, ctx) => getRentalProduct(ctx.env.db, createRentalProduct(ctx.env, ctx.actor, input), true, nowIso(ctx)),
    },
    'rentalProducts.update': {
      access: 'rentals.manage',
      handle: (input, ctx) => {
        updateRentalProduct(ctx.env, ctx.actor, input);
        return getRentalProduct(ctx.env.db, input.id, true, nowIso(ctx));
      },
    },
    'rentalProducts.setActive': {
      access: 'rentals.manage',
      handle: (input, ctx) => {
        setRentalProductActive(ctx.env, ctx.actor, input);
        return getRentalProduct(ctx.env.db, input.id, true, nowIso(ctx));
      },
    },

    'rentalAssets.list': { access: 'authenticated', handle: (input, ctx) => listAssets(ctx.env.db, input, canSeeCost(ctx.session), nowIso(ctx)) },
    'rentalAssets.add': {
      access: 'rentals.manage',
      handle: (input, ctx) => {
        addAssets(ctx.env, ctx.actor, input);
        return getRentalProduct(ctx.env.db, input.productId, true, nowIso(ctx));
      },
    },
    'rentalAssets.update': {
      access: 'rentals.manage',
      handle: (input, ctx) => {
        updateAsset(ctx.env, ctx.actor, input);
        return getAsset(ctx.env.db, input.id, true, nowIso(ctx));
      },
    },
    'rentalAssets.setStatus': {
      // Inspecting returned units is part of handling returns; retiring units is catalogue management.
      access: 'rentals.return',
      handle: (input, ctx) => {
        if (input.status === 'RETIRED' && !ctx.session!.permissions.includes('rentals.manage')) {
          throw new AppError(ErrorCodes.PERMISSION_DENIED, 'Retiring a unit needs the rental management permission.');
        }
        setAssetStatus(ctx.env, ctx.actor, input);
        return getAsset(ctx.env.db, input.id, canSeeCost(ctx.session), nowIso(ctx));
      },
    },
    'rentalAssets.history': { access: 'authenticated', handle: (input, { env }) => assetHistory(env.db, input.id) },

    'rentals.available': {
      access: 'authenticated',
      handle: (input, ctx) => {
        const ids = availableAssets(ctx.env.db, input.productId, new Date(input.startAt).toISOString(), new Date(input.endAt).toISOString(), nowIso(ctx));
        return ids.map((id) => getAsset(ctx.env.db, id, canSeeCost(ctx.session), nowIso(ctx)));
      },
    },
    'rentals.quote': { access: 'authenticated', handle: (input, ctx) => quoteRental(ctx.env.db, input, nowIso(ctx)) },
    'rentals.create': { access: 'rentals.issue', handle: (input, ctx) => createRental(ctx.env, ctx.actor, perms(ctx), input) },
    'rentals.issueReserved': {
      access: 'rentals.issue',
      handle: (input, ctx) => {
        issueReserved(ctx.env, ctx.actor, perms(ctx), input);
        return getRental(ctx.env.db, input.id, nowIso(ctx));
      },
    },
    'rentals.cancelReservation': {
      access: 'rentals.issue',
      handle: (input, ctx) => {
        cancelReservation(ctx.env, ctx.actor, input);
        return getRental(ctx.env.db, input.id, nowIso(ctx));
      },
    },
    'rentals.extendQuote': { access: 'authenticated', handle: (input, ctx) => quoteExtension(ctx.env.db, input.id, input.newExpectedReturnAt) },
    'rentals.extend': {
      access: 'rentals.issue',
      handle: (input, ctx) => {
        extendRental(ctx.env, ctx.actor, input);
        return getRental(ctx.env.db, input.id, nowIso(ctx));
      },
    },
    'rentals.returnQuote': {
      access: 'authenticated',
      handle: (input, ctx) => quoteReturn(ctx.env.db, input.id, input.itemIds, input.returnedAt, nowIso(ctx)),
    },
    'rentals.return': {
      access: 'rentals.return',
      handle: (input, ctx) => {
        returnItems(ctx.env, ctx.actor, perms(ctx), input);
        return getRental(ctx.env.db, input.id, nowIso(ctx));
      },
    },
    'rentals.settleDeposit': {
      access: 'rentals.return',
      handle: (input, ctx) => {
        settleDeposit(ctx.env, ctx.actor, perms(ctx), input);
        return getRental(ctx.env.db, input.id, nowIso(ctx));
      },
    },
    'rentals.close': {
      access: 'rentals.return',
      handle: (input, ctx) => {
        closeRental(ctx.env, ctx.actor, input);
        return getRental(ctx.env.db, input.id, nowIso(ctx));
      },
    },
    'rentals.list': { access: 'authenticated', handle: (input, ctx) => listRentals(ctx.env.db, input, nowIso(ctx)) },
    'rentals.get': { access: 'authenticated', handle: (input, ctx) => getRental(ctx.env.db, input.id, nowIso(ctx)) },
    'rentals.summary': {
      access: 'authenticated',
      handle: (_i, ctx) => {
        // "Due today" runs to midnight in the shop's time zone (India, UTC+5:30).
        const now = ctx.env.clock.now();
        const local = new Date(now.getTime() + 330 * 60_000);
        const endOfDay = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) - 330 * 60_000);
        return rentalSummary(ctx.env.db, now.toISOString(), endOfDay.toISOString());
      },
    },
  };
}
