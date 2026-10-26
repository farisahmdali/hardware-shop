import type { TestEnv } from '../helpers';
import { actorOf, setupOwner } from '../helpers';
import { cancelInvoice, createCreditNote, getInvoice } from '@main/services/sales';
import { walkInCustomerId } from '@main/services/customers';
import { ShopData, rupees, units, type PricedProduct } from '../support/shop';
import { randomUUID } from 'node:crypto';

export interface PerfSizes {
  products: number;
  customers: number;
  suppliers: number;
  days: number;
  invoicesPerDay: number;
}

export const FULL_SIZE: PerfSizes = { products: 30_000, customers: 3_000, suppliers: 40, days: 730, invoicesPerDay: 137 };

const BRANDS = ['Bosch', 'Stanley', 'Taparia', 'Makita', 'Dewalt', 'Asian Paints', 'Finolex', 'Havells', 'Anchor', 'Jaquar', 'Supreme', 'Astral', 'Pidilite', 'Fevicol', 'Black+Decker', 'Eastman', 'Jk', 'Ingco', 'Tolsen', 'Kpt', 'Polycab', 'Legrand', 'Philips', 'Cera', 'Hindware', 'Godrej', 'Dorset', 'Yale', 'Ozone', 'Hettich'];
const KINDS = ['Claw hammer', 'Ball pein hammer', 'Screwdriver', 'Spanner', 'Ring spanner', 'Pipe wrench', 'Plier', 'Wire cutter', 'Hacksaw', 'Hand saw', 'Chisel', 'File', 'Measuring tape', 'Spirit level', 'Trowel', 'Paint brush', 'Roller', 'Putty knife', 'PVC pipe', 'CPVC pipe', 'Elbow', 'Tee', 'Ball valve', 'Gate valve', 'Tap', 'Wire', 'MCB', 'Switch', 'Socket', 'LED bulb', 'Tube light', 'Extension board', 'Drill bit', 'Masonry bit', 'Cutting disc', 'Grinding wheel', 'Sandpaper', 'Wood screw', 'Machine bolt', 'Anchor fastener', 'Nail', 'Hinge', 'Tower bolt', 'Door handle', 'Padlock', 'Mortise lock', 'Primer', 'Enamel paint', 'Emulsion', 'Wall putty', 'Adhesive', 'Sealant', 'Teflon tape', 'Safety gloves', 'Safety helmet', 'Goggles', 'Ladder', 'Wheelbarrow', 'Shovel', 'Pickaxe'];
const SIZES = ['6 mm', '8 mm', '10 mm', '12 mm', '15 mm', '20 mm', '25 mm', '32 mm', '1/2 in', '3/4 in', '1 in', '100 g', '250 g', '450 g', '500 g', '1 kg', '1 L', '4 L', '10 L', '3 m'];

/**
 * A busy shop's two years: products, customers and suppliers, ~137 bills a day (most paid at the
 * counter, some on credit), payments, returns, cancellations, purchases, rentals and expenses,
 * all through the real services, one transaction each, in date order.
 */
export function seedPerfShop(env: TestEnv, sizes: PerfSizes, progress: (msg: string) => void = () => {}): void {
  // Generation only: the measurements reopen the file with the application's normal settings.
  env.db.pragma('synchronous = OFF');
  // mulberry32: integer-only arithmetic, so the sequence stays well spread over millions of draws.
  let seed = 12345;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const between = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
  const pick = <T,>(xs: T[]): T => xs[Math.floor(random() * xs.length)]!;

  const start = new Date(Date.UTC(2024, 9, 1, 3, 30)); // 1 Oct 2024, 9:00 am IST
  env.clock.set(start.toISOString());
  const shop = new ShopData(env, actorOf(setupOwner(env)));
  const categories = (env.db.prepare("SELECT id FROM categories WHERE kind = 'PRODUCT'").all() as { id: number }[]).map((c) => c.id);

  const products: PricedProduct[] = [];
  for (let i = 0; i < sizes.products; i++) {
    const cost = rupees(between(5, 4000));
    products.push(
      shop.product(`${pick(BRANDS)} ${pick(KINDS)} ${pick(SIZES)}`, {
        price: Math.round((cost * between(120, 160)) / 100),
        cost,
        qty: units(between(200, 2000)),
        categoryId: pick(categories),
        hsn: String(between(7300, 9600)),
      }),
    );
    if (i % 5000 === 4999) progress(`${i + 1} products`);
  }
  const customers = Array.from({ length: sizes.customers }, (_, i) => shop.customer(`Customer ${i + 1} ${pick(BRANDS)} Works`, `9${String(800000000 + i)}`).id);
  const suppliers = Array.from({ length: sizes.suppliers }, (_, i) => shop.supplier(`${pick(BRANDS)} Distributors ${i + 1}`).id);
  const rentalUnits = Array.from({ length: 40 }, (_, i) => shop.rentalProduct(`${pick(KINDS)} for rent ${i + 1}`, 3, rupees(between(100, 800)), rupees(between(500, 3000))).assetIds).flat();
  const walkIn = walkInCustomerId(env.db);
  progress('catalogue ready');

  const owed = new Map<number, number>();
  const outRentals: { id: number; dueAt: number; assetId: number }[] = [];
  const recentInvoices: number[] = [];
  const DAY = 86_400_000;

  for (let day = 0; day < sizes.days; day++) {
    const opening = start.getTime() + day * DAY;
    const ops = sizes.invoicesPerDay + 70;
    for (let n = 0; n < ops; n++) {
      env.clock.set(new Date(opening + Math.floor((n / ops) * 11 * 3_600_000)).toISOString());
      const r = random();
      if (n < sizes.invoicesPerDay) {
        const registered = r < 0.3;
        const customer = registered ? pick(customers) : walkIn;
        const lines = [...new Map(Array.from({ length: between(1, 5) }, () => pick(products)).map((p) => [p.id, { p, qty: units(between(1, 3)) }])).values()];
        const pay = registered ? pick(['all', 'none', 'none', rupees(between(100, 1000))] as const) : 'all';
        const sale = shop.sell(customer, lines, pay, random() < 0.6 ? shop.cash : shop.upi);
        if (registered) owed.set(customer, (owed.get(customer) ?? 0) + sale.outstanding);
        recentInvoices.push(sale.invoiceId);
        if (recentInvoices.length > 200) recentInvoices.shift();
      } else if (r < 0.55) {
        // Customers paying what they owe (most in full).
        const debtors = [...owed.entries()].filter(([, v]) => v > 0);
        if (debtors.length) {
          const [customer, amount] = pick(debtors);
          const paid = random() < 0.8 ? amount : Math.ceil(amount / 2);
          shop.receive(customer, paid);
          owed.set(customer, amount - paid);
        }
      } else if (r < 0.6 && n % 3 === 0) {
        shop.buy(pick(suppliers), Array.from({ length: between(3, 10) }, () => ({ productId: pick(products).id, qty: units(between(20, 100)), cost: rupees(between(5, 3000)) })).filter((l, i, all) => all.findIndex((x) => x.productId === l.productId) === i), random() < 0.7 ? rupees(between(1000, 50000)) : 0);
      } else if (r < 0.7) {
        // Rentals: return what is due, issue to new customers.
        const due = outRentals.findIndex((o) => o.dueAt <= env.clock.now().getTime());
        if (due >= 0) {
          shop.returnAndSettle(outRentals[due]!.id);
          rentalUnits.push(outRentals[due]!.assetId);
          outRentals.splice(due, 1);
        } else if (rentalUnits.length && random() < 0.5) {
          const assetId = rentalUnits.splice(Math.floor(random() * rentalUnits.length), 1)[0]!;
          const days = between(1, 6);
          const rental = shop.rent(pick(customers), [assetId], days, rupees(1000));
          outRentals.push({ id: rental.id, dueAt: env.clock.now().getTime() + days * DAY, assetId });
        }
      } else if (r < 0.72) {
        shop.expense(rupees(between(100, 15000)), pick(['Electricity', 'Tea and snacks', 'Transport', 'Repairs', 'Stationery']));
      } else if (r < 0.735 && recentInvoices.length) {
        // An occasional return, and a rarer cancellation, on a recent bill.
        const invoiceId = pick(recentInvoices);
        try {
          const inv = getInvoice(env.db, invoiceId, false, shop.today());
          if (random() < 0.8) {
            createCreditNote(env, shop.actor, {
              requestId: randomUUID(),
              invoiceId,
              lines: [{ invoiceLineId: inv.lines[0]!.id, qty: units(1), restock: true }],
              reason: 'Customer returned it',
              settlement: 'REFUND',
              refundMethodId: shop.cash,
            });
          } else {
            cancelInvoice(env, shop.actor, { id: invoiceId, reason: 'Billed by mistake', requestId: randomUUID() });
          }
        } catch {
          // Already cancelled or returned: skip, as a shop employee would.
        }
      }
    }
    if (day % 10 === 9) progress(`day ${day + 1} of ${sizes.days}`);
  }
  env.db.pragma('wal_checkpoint(TRUNCATE)');
}
