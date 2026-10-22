import { writeFile } from 'node:fs/promises';
import type { HandlerContext, HandlerMap } from './dispatcher';
import type { DesktopUi } from './systemHandlers';
import { canSeeCost } from './inventoryHandlers';
import { transact } from '../db/tx';
import { adjustBalance, createCustomer, customerLedger, getCustomer, listCustomers, setCustomerActive, updateCustomer } from '../services/customers';
import { cancelInvoice, createCreditNote, finalizeSale, getInvoice, listInvoices, salesSummary } from '../services/sales';
import {
  ageingReport,
  applyCustomerCredit,
  getPayment,
  listPaymentMethods,
  listPayments,
  listReceivables,
  receivablesSummary,
  receivePayment,
  refundCustomer,
  reversePayment,
  savePaymentMethod,
} from '../services/payments';
import { deleteHeldBill, listHeldBills, saveHeldBill } from '../services/heldBills';
import { renderDocument } from '../print/documents';
import { businessDateOf } from '@shared/time';
import { AppError, ErrorCodes } from '@shared/errors';
import type { DocumentKind, Paper } from '@shared/contracts';

/** Printing needs Electron windows; injected so the handlers stay testable. */
export interface Printer {
  toPdf(html: string, paper: Paper): Promise<Buffer>;
  print(html: string, paper: Paper): Promise<boolean>;
}

const asOf = (ctx: HandlerContext) => businessDateOf(ctx.env.clock.now(), ctx.env.timeZone);

export function salesHandlers(ui: DesktopUi, printer: Printer): HandlerMap {
  const render = (ctx: HandlerContext, input: { kind: DocumentKind; id: number; paper: Paper; from?: string; to?: string }) =>
    renderDocument(ctx.env.db, input.kind, input.id, input.paper, asOf(ctx), { from: input.from, to: input.to });

  return {
    'customers.list': { access: 'authenticated', handle: (input, ctx) => listCustomers(ctx.env.db, input, asOf(ctx)) },
    'customers.get': { access: 'authenticated', handle: (input, ctx) => getCustomer(ctx.env.db, input.id, asOf(ctx)) },
    'customers.create': { access: 'customers.manage', handle: (input, ctx) => {
      if (input.openingBalance !== 0 && !ctx.session!.permissions.includes('customers.adjustBalance')) {
        throw new AppError(ErrorCodes.PERMISSION_DENIED, 'Entering an opening balance needs the balance adjustment permission.');
      }
      return createCustomer(ctx.env, ctx.actor, input);
    } },
    'customers.update': { access: 'customers.manage', handle: (input, ctx) => updateCustomer(ctx.env, ctx.actor, input) },
    'customers.setActive': { access: 'customers.manage', handle: (input, ctx) => setCustomerActive(ctx.env, ctx.actor, input) },
    'customers.ledger': { access: 'authenticated', handle: (input, ctx) => customerLedger(ctx.env.db, input.id, input, asOf(ctx)) },
    'customers.adjustBalance': { access: 'customers.adjustBalance', handle: (input, ctx) => adjustBalance(ctx.env, ctx.actor, input) },

    'paymentMethods.list': { access: 'authenticated', handle: (input, { env }) => listPaymentMethods(env.db, input.includeInactive) },
    'paymentMethods.save': { access: 'settings.manage', handle: (input, ctx) => savePaymentMethod(ctx.env, ctx.actor, input) },

    'sales.finalize': {
      access: 'sales.create',
      handle: (input, ctx) =>
        finalizeSale(ctx.env, ctx.actor, { permissions: ctx.session!.permissions, maxDiscountBp: ctx.session!.maxDiscountBp }, input),
    },
    'sales.summary': { access: 'authenticated', handle: (_i, ctx) => salesSummary(ctx.env.db, asOf(ctx)) },
    'invoices.list': { access: 'authenticated', handle: (input, ctx) => listInvoices(ctx.env.db, input, asOf(ctx)) },
    'invoices.get': { access: 'authenticated', handle: (input, ctx) => getInvoice(ctx.env.db, input.id, canSeeCost(ctx.session), asOf(ctx)) },
    'invoices.cancel': {
      access: 'sales.cancel',
      handle: (input, ctx) => {
        cancelInvoice(ctx.env, ctx.actor, input);
        return getInvoice(ctx.env.db, input.id, canSeeCost(ctx.session), asOf(ctx));
      },
    },
    'creditNotes.create': { access: 'sales.return', handle: (input, ctx) => createCreditNote(ctx.env, ctx.actor, input) },

    'payments.receive': { access: 'payments.receive', handle: (input, ctx) => receivePayment(ctx.env, ctx.actor, input) },
    'payments.refund': { access: 'sales.return', handle: (input, ctx) => refundCustomer(ctx.env, ctx.actor, input) },
    'payments.reverse': { access: 'payments.reverse', handle: (input, ctx) => reversePayment(ctx.env, ctx.actor, input) },
    'payments.get': { access: 'authenticated', handle: (input, { env }) => getPayment(env.db, input.id) },
    'payments.list': { access: 'authenticated', handle: (input, { env }) => listPayments(env.db, input) },
    'payments.applyCredit': {
      access: 'payments.receive',
      handle: (input, ctx) => {
        applyCustomerCredit(ctx.env, ctx.actor, input);
        return getCustomer(ctx.env.db, input.customerId, asOf(ctx));
      },
    },

    'receivables.list': { access: 'authenticated', handle: (input, ctx) => listReceivables(ctx.env.db, input, asOf(ctx)) },
    'receivables.ageing': { access: 'authenticated', handle: (input, ctx) => ageingReport(ctx.env.db, asOf(ctx), input.search) },
    'receivables.summary': { access: 'authenticated', handle: (_i, ctx) => receivablesSummary(ctx.env.db, asOf(ctx)) },

    'heldBills.list': { access: 'sales.create', handle: (_i, { env }) => listHeldBills(env.db) },
    'heldBills.save': { access: 'sales.create', handle: (input, ctx) => saveHeldBill(ctx.env, ctx.actor, input) },
    'heldBills.delete': {
      access: 'sales.create',
      handle: (input, ctx) => {
        deleteHeldBill(ctx.env, ctx.actor, input.id);
        return null;
      },
    },

    'print.render': { access: 'authenticated', handle: (input, ctx) => render(ctx, input) },
    'print.pdf': {
      access: 'authenticated',
      handle: async (input, ctx) => {
        const doc = render(ctx, input);
        const path = await ui.chooseSaveFile('Save as PDF', `${doc.title}.pdf`, 'pdf');
        if (!path) return null;
        await writeFile(path, await printer.toPdf(doc.html, input.kind === 'RECEIPT' && input.paper === 'A4' ? 'THERMAL_80' : input.paper));
        transact(ctx.env, ctx.actor, (tx) =>
          tx.audit({ module: 'print', entityType: input.kind.toLowerCase(), entityId: input.id, action: 'PDF_SAVED', after: { paper: input.paper } }),
        );
        return { path };
      },
    },
    'print.send': {
      access: 'authenticated',
      handle: async (input, ctx) => {
        const doc = render(ctx, input);
        const printed = await printer.print(doc.html, input.kind === 'RECEIPT' && input.paper === 'A4' ? 'THERMAL_80' : input.paper);
        if (printed) {
          transact(ctx.env, ctx.actor, (tx) =>
            tx.audit({ module: 'print', entityType: input.kind.toLowerCase(), entityId: input.id, action: 'PRINTED', after: { paper: input.paper } }),
          );
        }
        return { printed };
      },
    },
  };
}
