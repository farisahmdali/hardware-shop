import { transact, type Actor, type Tx } from '../db/tx';
import { assetEvent } from './rentalCatalog';
import { UNIT_MINUTES, type RateUnit } from '@shared/rentalPricing';
import type { AppEnv } from './env';
import { ensureNamed } from './catalog';
import { insertProduct } from './products';
import { AppError, ErrorCodes } from '@shared/errors';

/**
 * Development-only sample catalogue (the command is not registered in packaged builds).
 * Gives realistic data for trying the screens; never part of a production database.
 */
const SAMPLE: [category: string, brand: string, name: string, unit: string, hsn: string, cost: number, price: number, min: number, qty: number][] = [
  ['Hand tools', 'Stanley', 'Claw hammer 450 g', 'PCS', '8205', 310, 450, 5, 18],
  ['Hand tools', 'Stanley', 'Measuring tape 5 m', 'PCS', '9017', 160, 240, 10, 32],
  ['Hand tools', 'Taparia', 'Screwdriver set 6 pc', 'SET', '8205', 220, 340, 5, 12],
  ['Hand tools', 'Taparia', 'Combination plier 8 in', 'PCS', '8203', 180, 275, 6, 4],
  ['Hand tools', 'Taparia', 'Adjustable spanner 10 in', 'PCS', '8204', 260, 390, 4, 9],
  ['Hand tools', 'Stanley', 'Hacksaw frame', 'PCS', '8202', 190, 290, 4, 0],
  ['Power tools', 'Bosch', 'Impact drill 13 mm 600 W', 'PCS', '8467', 2650, 3499, 2, 5],
  ['Power tools', 'Bosch', 'Angle grinder 4 in 720 W', 'PCS', '8467', 2150, 2899, 2, 3],
  ['Power tools', 'Dewalt', 'Cordless drill driver 12 V', 'PCS', '8467', 4900, 6450, 1, 2],
  ['Power tools', 'Bosch', 'Masonry drill bit set 5 pc', 'SET', '8207', 240, 380, 5, 14],
  ['Electrical', 'Havells', 'LED bulb 9 W', 'PCS', '8539', 62, 99, 50, 180],
  ['Electrical', 'Anchor', 'Modular switch 6 A', 'PCS', '8536', 28, 45, 100, 240],
  ['Electrical', 'Polycab', 'Copper wire 1.5 sq mm', 'M', '8544', 14, 22, 200, 1800],
  ['Electrical', 'Havells', 'MCB 32 A single pole', 'PCS', '8536', 210, 315, 10, 22],
  ['Electrical', 'Anchor', 'Extension board 4 socket', 'PCS', '8536', 240, 360, 6, 7],
  ['Plumbing', 'Supreme', 'PVC pipe 1 in', 'M', '3917', 38.5, 55, 50, 210.5],
  ['Plumbing', 'Supreme', 'PVC elbow 1 in', 'PCS', '3917', 9, 15, 50, 160],
  ['Plumbing', 'Jaquar', 'Bib cock brass', 'PCS', '8481', 420, 640, 4, 6],
  ['Plumbing', 'Generic', 'Teflon tape 12 mm', 'ROLL', '3919', 8, 15, 30, 25],
  ['Paints & chemicals', 'Asian Paints', 'Wall primer 1 L', 'L', '3209', 160, 230, 10, 36],
  ['Paints & chemicals', 'Fevicol', 'Fevicol SH 1 kg', 'KG', '3506', 230, 320, 6, 15.5],
  ['Paints & chemicals', 'Asian Paints', 'Enamel paint white 1 L', 'L', '3208', 280, 395, 6, 2],
  ['Fasteners', 'Generic', 'Wood screws 1 in (box of 100)', 'BOX', '7318', 55, 90, 20, 45],
  ['Fasteners', 'Generic', 'Wire nails 2 in', 'KG', '7317', 78, 110, 25, 64.25],
  ['Fasteners', 'Hilti', 'Wall plug 8 mm (pack of 50)', 'PKT', '3926', 45, 75, 20, 38],
  ['Construction materials', 'UltraTech', 'Cement OPC 53 grade 50 kg', 'BAG', '2523', 318, 420, 20, 85],
  ['Construction materials', 'Generic', 'Binding wire', 'KG', '7217', 70, 95, 20, 48],
  ['Safety equipment', 'Karam', 'Safety helmet', 'PCS', '6506', 120, 199, 10, 16],
  ['Safety equipment', 'Generic', 'Cotton hand gloves', 'PAIR', '6116', 18, 35, 40, 120],
  ['Accessories', 'Generic', 'Padlock 50 mm', 'PCS', '8301', 140, 220, 8, 11],
];

const RENTAL_SAMPLE: [category: string, name: string, brand: string, deposit: number, rates: [RateUnit, number][], units: number][] = [
  ['Power tools', 'Impact drill 13 mm', 'Bosch', 2000, [['HOUR', 50], ['DAY', 300], ['WEEK', 1500]], 3],
  ['Power tools', 'Angle grinder 4 in', 'Bosch', 1500, [['DAY', 250], ['WEEK', 1200]], 2],
  ['Power tools', 'Demolition hammer 5 kg', 'Makita', 5000, [['DAY', 800], ['WEEK', 4000]], 1],
  ['Ladders & access', 'Aluminium ladder 12 ft', 'Generic', 1000, [['DAY', 150], ['WEEK', 700]], 2],
  ['Concrete & masonry', 'Concrete mixer half bag', 'Generic', 10000, [['DAY', 1200], ['WEEK', 6000]], 1],
  ['Generators & power', 'Generator 3 kVA', 'Honda', 15000, [['DAY', 1500], ['WEEK', 8000]], 1],
];

function seedRentals(tx: Tx): void {
  if ((tx.db.prepare('SELECT COUNT(*) AS n FROM rental_products').get() as { n: number }).n > 0) return;
  RENTAL_SAMPLE.forEach(([category, name, brand, deposit, rates, units], n) => {
    const categoryId = (tx.db.prepare("SELECT id FROM categories WHERE kind = 'RENTAL' AND name = ?").get(category) as { id: number } | undefined)?.id ?? null;
    const code = `RI-${String(n + 1).padStart(3, '0')}`;
    const id = Number(
      tx.db
        .prepare(
          `INSERT INTO rental_products (code, name, category_id, brand, deposit_amount, sac_code, gst_rate_bp, price_includes_tax, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, '997319', 1800, 1, ?, ?)`,
        )
        .run(code, name, categoryId, brand, deposit * 100, tx.nowIso, tx.nowIso).lastInsertRowid,
    );
    for (const [unit, price] of rates) {
      tx.db
        .prepare('INSERT INTO rental_rates (rental_product_id, unit, unit_minutes, price, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, unit, UNIT_MINUTES[unit as Exclude<RateUnit, 'CUSTOM'>], price * 100, tx.nowIso);
    }
    for (let u = 1; u <= units; u++) {
      const assetId = Number(
        tx.db
          .prepare("INSERT INTO rental_assets (asset_tag, rental_product_id, serial_no, condition, status, created_at, updated_at) VALUES (?, ?, ?, 'GOOD', 'AVAILABLE', ?, ?)")
          .run(`${code}-${String(u).padStart(2, '0')}`, id, `SN${1000 + n * 10 + u}`, tx.nowIso, tx.nowIso).lastInsertRowid,
      );
      assetEvent(tx, assetId, { event: 'ADDED', to: 'AVAILABLE', condition: 'GOOD', notes: 'Development sample data' });
    }
  });
  // Keep the automatic code sequence ahead of the sample codes.
  tx.db
    .prepare("INSERT INTO doc_sequences (doc_type, fiscal_year, next_value) VALUES ('RENTAL_ITEM', '-', ?) ON CONFLICT DO UPDATE SET next_value = excluded.next_value")
    .run(RENTAL_SAMPLE.length + 1);
}

export function seedSampleData(env: AppEnv, actor: Actor): { products: number } {
  return transact(env, actor, (tx) => {
    if ((tx.db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n > 0) {
      throw new AppError(ErrorCodes.BUSINESS_RULE, 'Sample data can only be added to an empty catalogue.');
    }
    const unitId = (code: string) => (tx.db.prepare('SELECT id FROM units WHERE code = ?').get(code) as { id: number }).id;
    const toPaise = (rupees: number) => Math.round(rupees * 100);
    for (const [category, brand, name, unit, hsn, cost, price, min, qty] of SAMPLE) {
      insertProduct(
        tx,
        {
          sku: '',
          name,
          categoryId: ensureNamed(tx, 'categories', category),
          brandId: ensureNamed(tx, 'brands', brand),
          unitId: unitId(unit),
          description: '',
          hsnCode: hsn,
          gstRateBp: 1800,
          priceIncludesTax: true,
          purchasePrice: toPaise(cost),
          sellingPrice: toPaise(price),
          minStockQty: Math.round(min * 1000),
          preferredSupplierId: null,
          notes: '',
          openingQty: Math.round(qty * 1000),
        },
        'Development sample data',
      );
    }
    seedRentals(tx);
    return { products: SAMPLE.length };
  });
}
