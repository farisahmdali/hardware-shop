import { readFile, writeFile } from 'node:fs/promises';
import type { HandlerMap } from './dispatcher';
import type { DesktopUi } from './systemHandlers';
import { transact } from '../db/tx';
import { getCatalog, quickAddSupplier, saveBrand, saveCategory, saveUnit } from '../services/catalog';
import { createProduct, getProduct, listProducts, setProductActive, updateProduct } from '../services/products';
import { adjustStock, listMovements, stockSummary } from '../services/stock';
import { cancelCount, countLines, createCount, finalizeCount, getCount, listCounts, saveCountLines } from '../services/stockCounts';
import { buildImportPreview, commitImport, exportProducts, importTemplate, readTable } from '../services/productIo';
import { seedSampleData } from '../services/devSeed';
import { AppError, ErrorCodes } from '@shared/errors';
import type { SessionInfo } from '@shared/contracts';

/** Purchase costs and stock value are shown only to roles that manage stock or see financial figures. */
export function canSeeCost(session: SessionInfo | null): boolean {
  return !!session && ['products.manage', 'stock.adjust', 'reports.financial'].some((p) => session.permissions.includes(p as never));
}

const today = () => new Date().toISOString().slice(0, 10);

export function inventoryHandlers(ui: DesktopUi, opts: { isPackaged: boolean }): HandlerMap {
  return {
    'catalog.get': { access: 'authenticated', handle: (_i, { env }) => getCatalog(env.db) },
    'catalog.saveCategory': { access: 'products.manage', handle: (input, ctx) => saveCategory(ctx.env, ctx.actor, input) },
    'catalog.saveBrand': { access: 'products.manage', handle: (input, ctx) => saveBrand(ctx.env, ctx.actor, input) },
    'catalog.saveUnit': { access: 'products.manage', handle: (input, ctx) => saveUnit(ctx.env, ctx.actor, input) },
    'catalog.quickAddSupplier': { access: 'products.manage', handle: (input, ctx) => quickAddSupplier(ctx.env, ctx.actor, input) },

    'products.list': { access: 'authenticated', handle: (input, ctx) => listProducts(ctx.env.db, input, canSeeCost(ctx.session)) },
    'products.get': { access: 'authenticated', handle: (input, ctx) => getProduct(ctx.env.db, input.id, canSeeCost(ctx.session)) },
    'products.create': {
      access: 'products.manage',
      handle: (input, ctx) => {
        if (input.openingQty > 0 && !ctx.session!.permissions.includes('stock.adjust')) {
          throw new AppError(ErrorCodes.PERMISSION_DENIED, 'Entering opening stock needs the stock adjustment permission.');
        }
        return createProduct(ctx.env, ctx.actor, input, true);
      },
    },
    'products.update': { access: 'products.manage', handle: (input, ctx) => updateProduct(ctx.env, ctx.actor, input, true) },
    'products.setActive': { access: 'products.manage', handle: (input, ctx) => setProductActive(ctx.env, ctx.actor, input, true) },

    'stock.adjust': { access: 'stock.adjust', handle: (input, ctx) => adjustStock(ctx.env, ctx.actor, input, true) },
    'stock.movements': {
      access: 'authenticated',
      handle: (input, ctx) => listMovements(ctx.env.db, input, canSeeCost(ctx.session)),
    },
    'stock.summary': { access: 'authenticated', handle: (_i, ctx) => stockSummary(ctx.env.db, canSeeCost(ctx.session)) },

    'stockCounts.list': { access: 'stock.adjust', handle: (_i, { env }) => listCounts(env.db) },
    'stockCounts.get': { access: 'stock.adjust', handle: (input, { env }) => getCount(env.db, input.id) },
    'stockCounts.lines': { access: 'stock.adjust', handle: (input, { env }) => countLines(env.db, input) },
    'stockCounts.create': { access: 'stock.adjust', handle: (input, ctx) => createCount(ctx.env, ctx.actor, input) },
    'stockCounts.saveLines': { access: 'stock.adjust', handle: (input, ctx) => saveCountLines(ctx.env, ctx.actor, input) },
    'stockCounts.finalize': { access: 'stock.adjust', handle: (input, ctx) => finalizeCount(ctx.env, ctx.actor, input) },
    'stockCounts.cancel': { access: 'stock.adjust', handle: (input, ctx) => cancelCount(ctx.env, ctx.actor, input) },

    'products.export': {
      access: 'authenticated',
      handle: async (input, ctx) => {
        const path = await ui.chooseSaveFile('Export products', `products-${today()}.${input.format}`, input.format);
        if (!path) return null;
        const { data, rows } = await exportProducts(ctx.env.db, input.filter, input.format, canSeeCost(ctx.session));
        await writeFile(path, data);
        transact(ctx.env, ctx.actor, (tx) =>
          tx.audit({ module: 'products', entityType: 'product_export', action: 'EXPORT', after: { format: input.format, rows } }),
        );
        return { path };
      },
    },
    'products.importTemplate': {
      access: 'products.manage',
      handle: async (input) => {
        const path = await ui.chooseSaveFile('Save import template', `product-import-template.${input.format}`, input.format);
        if (!path) return null;
        await writeFile(path, await importTemplate(input.format));
        return { path };
      },
    },
    'products.importPreview': {
      access: 'products.manage',
      handle: async (_i, ctx) => {
        const file = await ui.chooseFile('Choose a product list to import', [
          { name: 'Spreadsheets', extensions: ['csv', 'xlsx'] },
        ]);
        if (!file) return null;
        const table = await readTable(file, await readFile(file));
        return buildImportPreview(ctx.env.db, file, table);
      },
    },
    'products.importCommit': {
      access: 'products.manage',
      handle: (input, ctx) => {
        if (!ctx.session!.permissions.includes('stock.adjust')) {
          // Imports may carry opening stock; keep the same rule as manual product creation.
          throw new AppError(ErrorCodes.PERMISSION_DENIED, 'Importing products needs the stock adjustment permission.');
        }
        return commitImport(ctx.env, ctx.actor, input.token, input.requestId);
      },
    },

    ...(opts.isPackaged
      ? {}
      : {
          'dev.seedSampleData': {
            access: 'users.manage' as const,
            handle: (_i, ctx) => seedSampleData(ctx.env, ctx.actor),
          },
        }),
  };
}
