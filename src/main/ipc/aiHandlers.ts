import type { HandlerMap } from './dispatcher';
import type { DesktopUi } from './systemHandlers';
import { canSeeCost } from './inventoryHandlers';
import { canViewPurchasing } from './purchaseHandlers';
import { aiStatus, assertCanScan, BILL_FILE_TYPES, clearApiKey, scanBill, setApiKey, testConnection } from '../services/ai/assistant';
import { listItemNames, removeItemName } from '../services/ai/supplierItemNames';
import { AppError, ErrorCodes } from '@shared/errors';

export function aiHandlers(ui: DesktopUi): HandlerMap {
  const showKey = (permissions: string[] | undefined) => !!permissions?.includes('settings.manage');
  return {
    // Whether scanning is ready, for the purchase screen; the key's ending only for settings managers.
    'ai.status': { access: 'authenticated', handle: (_i, ctx) => aiStatus(ctx.env, showKey(ctx.session?.permissions)) },
    'ai.setKey': {
      access: 'settings.manage',
      handle: async (input, ctx) => {
        await setApiKey(ctx.env, ctx.actor, input.key);
        return aiStatus(ctx.env, true);
      },
    },
    'ai.clearKey': {
      access: 'settings.manage',
      handle: async (_i, ctx) => {
        await clearApiKey(ctx.env, ctx.actor);
        return aiStatus(ctx.env, true);
      },
    },
    'ai.test': { access: 'settings.manage', handle: (input, ctx) => testConnection(ctx.env, input.model) },
    'ai.scanBill': {
      access: 'purchases.manage',
      handle: async (_i, ctx) => {
        await assertCanScan(ctx.env);
        // The file is chosen here, in a native dialog: the screen never supplies a path.
        const path = await ui.chooseFile("Choose the supplier's bill", [
          { name: 'Bill photo or PDF', extensions: Object.keys(BILL_FILE_TYPES).map((e) => e.slice(1)) },
        ]);
        if (!path) return null;
        return scanBill(ctx.env, ctx.actor, path, { canSeeCost: canSeeCost(ctx.session) });
      },
    },

    'supplierItemNames.list': {
      access: 'authenticated',
      handle: (input, ctx) => {
        if (!canViewPurchasing(ctx.session)) throw new AppError(ErrorCodes.PERMISSION_DENIED, 'You do not have permission to see purchases and supplier balances.');
        return listItemNames(ctx.env.db, input.supplierId);
      },
    },
    'supplierItemNames.remove': { access: 'purchases.manage', handle: (input, ctx) => removeItemName(ctx.env, ctx.actor, input) },
  };
}
