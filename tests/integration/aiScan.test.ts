import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transact } from '@main/db/tx';
import type { KeyCipher } from '@main/services/env';
import { aiStatus, assertCanScan, clearApiKey, readApiKey, scanBill, setApiKey, testConnection } from '@main/services/ai/assistant';
import { listItemNames, removeItemName } from '@main/services/ai/supplierItemNames';
import { createPurchase } from '@main/services/purchases';
import { updateSettingsSection } from '@main/services/settings';
import { listAudit } from '@main/services/audit';
import { runIntegrityChecks } from '@main/services/integrity';
import { computePurchase } from '@shared/purchasing';
import type { ScanDraft } from '@shared/contracts';
import { actorOf, createTestEnv, setupOwner, type TestEnv } from '../helpers';
import { ShopData, rupees, units } from '../support/shop';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const SUPPLIER_GSTIN = '27AAPFU0939F1ZV';
const MODEL = 'test/vision-model';

/** Stands in for Windows' encryption: reversible, but the key never appears in the file as written. */
const cipher: KeyCipher = {
  available: () => true,
  encrypt: (t) => Buffer.from(`enc:${Buffer.from(t).toString('base64').split('').reverse().join('')}`),
  decrypt: (b) => {
    const s = b.toString();
    if (!s.startsWith('enc:')) throw new Error('not encrypted by this user');
    return Buffer.from(s.slice(4).split('').reverse().join(''), 'base64').toString();
  },
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/** A stand-in for OpenRouter: answers like the real API, and records every request. */
class FakeOpenRouter {
  calls: Call[] = [];
  modalities = ['text', 'image'];
  parameters = ['structured_outputs', 'temperature'];
  answer: unknown = null;
  chatStatus = 200;
  chatBody: unknown = null;
  offline = false;

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    this.calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    });
    if (this.offline) throw new TypeError('fetch failed: net::ERR_INTERNET_DISCONNECTED');
    const auth = (init.headers as Record<string, string>).Authorization;
    if (auth !== `Bearer ${KEY}`) return Response.json({ error: { code: 401, message: 'No auth credentials found' } }, { status: 401 });
    if (url.endsWith('/key')) return Response.json({ data: { label: 'sk-or…', usage: 0.12, limit: 5, limit_remaining: 4.88 } });
    if (url.endsWith('/models')) {
      return Response.json({
        data: [
          { id: 'other/model', name: 'Other', architecture: { input_modalities: ['text'] }, supported_parameters: [] },
          { id: MODEL, name: 'Test Vision', architecture: { input_modalities: this.modalities }, supported_parameters: this.parameters },
        ],
      });
    }
    if (url.endsWith('/chat/completions')) {
      if (this.chatBody !== null) return Response.json(this.chatBody, { status: this.chatStatus });
      return Response.json({
        id: 'gen-1',
        model: MODEL,
        choices: [{ message: { role: 'assistant', content: typeof this.answer === 'string' ? this.answer : JSON.stringify(this.answer) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1530, completion_tokens: 410, cost: 0.0021 },
      });
    }
    return new Response('not found', { status: 404 });
  };

  chats = () => this.calls.filter((c) => c.url.endsWith('/chat/completions'));
}

let env: TestEnv;
let actor: { userId: number | null; username: string | null };
let shop: ShopData;
let api: FakeOpenRouter;
let billFile: string;
let hinge: { id: number };
let fevicol500: { id: number };
let supplierId: number;

const bill = (items: Record<string, unknown>[], o: Record<string, unknown> = {}) => ({
  isBill: true,
  supplier: { name: 'Mehta Traders Pvt. Ltd.', gstin: SUPPLIER_GSTIN, address: 'Shop 4, Lohar Chawl, Mumbai', phone: '022 2345 6789', state: 'Maharashtra' },
  billNumber: 'MT-412',
  billDate: '20/10/2026',
  ratesIncludeGst: false,
  items,
  billDiscountPercent: null,
  billDiscountAmount: null,
  freight: 120,
  freightNote: 'Cartage',
  roundOff: 0.2,
  grandTotal: 3628,
  ...o,
});
const HINGE_LINE = { description: 'SS BUTT HINGE 4" HVY', hsn: '8302', quantity: 24, unit: 'NOS', rate: 82, discountPercent: null, discountAmount: null, gstPercent: 18, amount: 1968 };
const DRILL_LINE = { description: 'HSS DRILL BIT 6MM', hsn: '8207', quantity: 10, unit: 'PCS', rate: 35, discountPercent: null, discountAmount: null, gstPercent: 18, amount: 350 };
const FEVICOL_LINE = { description: 'FEVICOL SH 1KG', hsn: '3506', quantity: 2, unit: 'NOS', rate: 410, discountPercent: null, discountAmount: null, gstPercent: 18, amount: 820 };

async function enable(o: { model?: string; limit?: number } = {}) {
  transact(env, actor, (tx) => updateSettingsSection(tx, 'ai', { enabled: true, model: o.model ?? MODEL, monthlyScanLimit: o.limit ?? 200 }));
  await setApiKey(env, actor, KEY);
}

const scan = () => scanBill(env, actor, billFile, { canSeeCost: true });

beforeEach(() => {
  env = createTestEnv();
  actor = actorOf(setupOwner(env));
  shop = new ShopData(env, actor);
  api = new FakeOpenRouter();
  env.ai = { cipher, fetch: api.fetch, baseUrl: 'https://openrouter.ai/api/v1' };
  billFile = join(env.dir, 'bill photo.jpg');
  writeFileSync(billFile, Buffer.from('fake jpeg bytes of the bill'));
  env.clock.set('2026-10-29T06:00:00.000Z');
  hinge = shop.product('Stainless steel butt hinge 100 mm', { price: rupees(120), cost: rupees(80), hsn: '83021010' });
  shop.product('Stainless steel butt hinge 125 mm', { price: rupees(150), cost: rupees(98), hsn: '83021010' });
  fevicol500 = shop.product('Fevicol SH 500 g', { price: rupees(260), cost: rupees(205), hsn: '3506' });
  shop.product('Claw hammer 450 g', { price: rupees(450), cost: rupees(310) });
  supplierId = shop.supplier('Mehta Traders', SUPPLIER_GSTIN).id;
});
afterEach(() => env.cleanup());

describe('the OpenRouter key', () => {
  it('is kept encrypted in the data folder, never in the database or the history', async () => {
    expect((await aiStatus(env, true)).hasKey).toBe(false);
    await setApiKey(env, actor, KEY);
    const file = readFileSync(join(env.dir, 'ai', 'openrouter.key'));
    expect(file.toString()).not.toContain(KEY);
    expect(await readApiKey(env)).toBe(KEY);
    expect(await aiStatus(env, true)).toMatchObject({ hasKey: true, keyEnding: 'cdef', ready: false });
    expect((await aiStatus(env, false)).keyEnding).toBeNull();

    await setApiKey(env, actor, `${KEY}99`);
    await clearApiKey(env, actor);
    expect((await aiStatus(env, true)).hasKey).toBe(false);
    const entries = listAudit(env.db, { page: 1, pageSize: 10, module: 'settings' }).rows.filter((r) => r.entityType === 'ai_key');
    expect(entries.map((e) => e.action)).toEqual(['AI_KEY_REMOVED', 'AI_KEY_REPLACED', 'AI_KEY_SET']);
    const everything = JSON.stringify(env.db.prepare('SELECT * FROM audit_log').all()) + JSON.stringify(env.db.prepare('SELECT * FROM settings').all());
    expect(everything).not.toContain(KEY.slice(10));
  });

  it('is not used when it was saved by another Windows user', async () => {
    await setApiKey(env, actor, KEY);
    writeFileSync(join(env.dir, 'ai', 'openrouter.key'), 'garbage');
    expect(await readApiKey(env)).toBeNull();
    expect((await aiStatus(env, true)).hasKey).toBe(false);
  });

  it('is refused when Windows cannot encrypt it', async () => {
    env.ai = { ...env.ai!, cipher: { ...cipher, available: () => false } };
    await expect(setApiKey(env, actor, KEY)).rejects.toThrow('cannot keep the key encrypted');
  });
});

describe('testing the connection', () => {
  it('checks the key and whether the model reads bills', async () => {
    await setApiKey(env, actor, KEY);
    expect(await testConnection(env, MODEL)).toEqual({
      model: MODEL,
      modelName: 'Test Vision',
      readsImages: true,
      readsPdf: false,
      structuredOutput: true,
      creditLeft: 4.88,
    });
    expect((await testConnection(env, 'other/model')).readsImages).toBe(false);
    await expect(testConnection(env, 'no/such-model')).rejects.toThrow('OpenRouter has no model called "no/such-model"');
    expect(api.calls.every((c) => c.headers.Authorization === `Bearer ${KEY}`)).toBe(true);
  });

  it('explains a wrong key and no internet', async () => {
    await setApiKey(env, actor, 'sk-or-v1-wrongwrongwrongwrongwrong');
    await expect(testConnection(env, MODEL)).rejects.toThrow('did not accept the API key');
    await setApiKey(env, actor, KEY);
    api.offline = true;
    await expect(testConnection(env, MODEL)).rejects.toThrow('Could not reach OpenRouter');
  });
});

describe('scanning a bill', () => {
  it('is refused when switched off, without a key or model, or over the monthly limit', async () => {
    await expect(assertCanScan(env)).rejects.toThrow('switched off');
    transact(env, actor, (tx) => updateSettingsSection(tx, 'ai', { enabled: true, model: '', monthlyScanLimit: 1 }));
    await expect(assertCanScan(env)).rejects.toThrow('Choose the AI model');
    transact(env, actor, (tx) => updateSettingsSection(tx, 'ai', { enabled: true, model: MODEL, monthlyScanLimit: 1 }));
    await expect(assertCanScan(env)).rejects.toThrow('API key');
    await setApiKey(env, actor, KEY);
    api.answer = bill([HINGE_LINE]);
    await scan();
    await expect(scan()).rejects.toThrow("This month's limit of 1 bill scans has been reached");
    expect(api.chats()).toHaveLength(1);
    // A new month starts again.
    env.clock.set('2026-11-01T00:30:00.000Z'); // 06:00 on 1 November in India
    expect((await aiStatus(env, false)).scansThisMonth).toBe(0);
    await expect(assertCanScan(env)).resolves.toBeUndefined();
  });

  it('sends only the bill, asks for a fixed answer format, and fills a checked draft', async () => {
    await enable();
    api.answer = bill([HINGE_LINE, DRILL_LINE, FEVICOL_LINE]);
    const d = await scan();

    const [req] = api.chats();
    expect(req!.body).toMatchObject({ model: MODEL, temperature: 0, response_format: { type: 'json_schema', json_schema: { name: 'supplier_bill', strict: true } } });
    const parts = (req!.body!.messages as { content: unknown }[])[1]!.content as { type: string; image_url?: { url: string } }[];
    expect(parts[1]!.image_url!.url).toBe(`data:image/jpeg;base64,${Buffer.from('fake jpeg bytes of the bill').toString('base64')}`);
    // Nothing from the shop's records is sent.
    expect(JSON.stringify(req!.body)).not.toMatch(/Stainless steel butt hinge|Claw hammer|Sharma/);

    expect(d.supplier).toMatchObject({ match: { id: supplierId, name: 'Mehta Traders' }, how: 'GSTIN' });
    expect(d).toMatchObject({ supplierInvoiceNo: 'MT-412', supplierInvoiceDate: '2026-10-20', pricesIncludeTax: false, additionalCosts: 12_000, roundOff: 20, printedTotal: 362_800 });
    expect(d.preview).toMatch(/^data:image\/jpeg;base64,/);

    const [h, drill, fev] = d.lines;
    // Another name for an existing product, matched by name, size and HSN; the 125 mm hinge is ruled out.
    expect(h!.match).toMatchObject({ how: 'BEST', product: { id: hinge.id } });
    expect(h!.candidates.map((c) => c.product.name)).toEqual(['Stainless steel butt hinge 100 mm']);
    expect(h).toMatchObject({ qty: units(24), rate: rupees(82), gstRateBp: 1800, unitId: shop.unitId('PCS') });
    // Not in the shop: no match and no wrong suggestion.
    expect(drill!.match).toBeNull();
    expect(drill!.candidates).toEqual([]);
    // The 500 g pack is a different size from the 1 kg on the bill: never offered.
    expect(fev!.match).toBeNull();
    expect(fev!.candidates.map((c) => c.product.id)).not.toContain(fevicol500.id);

    const entry = listAudit(env.db, { page: 1, pageSize: 1, action: 'AI_SCAN' }).rows[0]!;
    expect(entry).toMatchObject({ module: 'purchases', entityType: 'bill_scan', entityId: d.scanId, username: 'owner' });
    expect(entry.after).toMatchObject({ fileName: 'bill photo.jpg', model: MODEL, itemsRead: 3, itemsMatched: 1, supplier: 'Mehta Traders', aiUsage: '1530 in, 410 out', costUsd: 0.0021 });
    const logged = JSON.stringify(env.db.prepare('SELECT * FROM audit_log').all());
    expect(logged).not.toContain(KEY.slice(10));
    expect(logged).not.toContain(Buffer.from('fake jpeg bytes of the bill').toString('base64'));
  });

  it('remembers the products chosen for the supplier, so the next bill matches by itself', async () => {
    await enable();
    api.answer = bill([HINGE_LINE, DRILL_LINE]);
    const first = await scan();
    expect(first.lines[1]!.match).toBeNull();

    // The person adds the drill bit as a new product and saves the purchase, as the screen does.
    const drill = shop.product('Drill bit HSS 6 mm', { price: rupees(55), cost: rupees(35), hsn: '8207' });
    const lines = [
      { productId: hinge.id, qty: units(24), unitCost: rupees(82), gstRateBp: 1800, discount: null, scannedText: first.lines[0]!.text },
      { productId: drill.id, qty: units(10), unitCost: rupees(35), gstRateBp: 1800, discount: null, scannedText: first.lines[1]!.text },
    ];
    const calc = computePurchase(lines, { pricesIncludeTax: false, interstate: false, billDiscount: null, additionalCosts: 12_000, roundOff: 20, itcClaimed: false });
    const saved = createPurchase(env, actor, {
      requestId: crypto.randomUUID(),
      supplierId,
      supplierInvoiceNo: first.supplierInvoiceNo,
      supplierInvoiceDate: first.supplierInvoiceDate!,
      pricesIncludeTax: false,
      lines,
      billDiscount: null,
      additionalCosts: 12_000,
      additionalCostsNote: 'Cartage',
      roundOff: 20,
      notes: '',
      payments: [],
      updatePurchasePrices: true,
      expectedGrandTotal: calc.grandTotal,
      scannedFrom: first.fileName,
    });
    const created = listAudit(env.db, { page: 1, pageSize: 1, action: 'CREATE', entityType: 'purchase' }).rows[0]!;
    expect(created.after).toMatchObject({ filledFromScannedBill: 'bill photo.jpg', itemNamesRemembered: 2 });
    expect(listItemNames(env.db, supplierId).map((n) => [n.itemText, n.productName, n.uses])).toEqual([
      ['HSS DRILL BIT 6MM', 'Drill bit HSS 6 mm', 1],
      ['SS BUTT HINGE 4" HVY', 'Stainless steel butt hinge 100 mm', 1],
    ]);
    expect(runIntegrityChecks(env.db).issues).toEqual([]);

    // The next bill writes the names a little differently.
    api.answer = bill([{ ...HINGE_LINE, description: 'Hinge SS Butt 4 in HVY' }, { ...DRILL_LINE, description: 'Hss Drill Bit 6 mm' }], { billNumber: 'MT-413' });
    const second = await scan();
    expect(second.lines.map((l) => [l.match?.how, l.match?.product.id])).toEqual([
      ['REMEMBERED', hinge.id],
      ['REMEMBERED', drill.id],
    ]);
    // The same bill again is flagged.
    api.answer = bill([HINGE_LINE]);
    expect((await scan()).warnings).toContain(`Bill MT-412 from Mehta Traders is already recorded as ${saved.purchaseNo}.`);

    // A wrong link can be forgotten; that is in the history.
    const link = listItemNames(env.db, supplierId).find((n) => n.productId === drill.id)!;
    expect(removeItemName(env, actor, { id: link.id, supplierId })).toHaveLength(1);
    const forgotten = listAudit(env.db, { page: 1, pageSize: 1, action: 'ITEM_NAME_FORGOTTEN' }).rows[0]!;
    expect(forgotten.before).toEqual({ itemName: 'HSS DRILL BIT 6MM', product: 'Drill bit HSS 6 mm' });
  });

  it('finds the supplier by name when the bill has no GSTIN, and offers to add an unknown one', async () => {
    await enable();
    api.answer = bill([HINGE_LINE], { supplier: { name: 'M/s. MEHTA TRADERS', gstin: null, address: null, phone: null, state: null } });
    expect((await scan()).supplier).toMatchObject({ match: { id: supplierId }, how: 'NAME' });

    api.answer = bill([HINGE_LINE], { supplier: { name: 'Gupta Hardware Mart', gstin: '29AAACR5055K1Z3', address: 'Bengaluru', phone: '', state: 'Karnataka' } });
    const d = await scan();
    expect(d.supplier).toMatchObject({ match: null, name: 'Gupta Hardware Mart', gstin: '29AAACR5055K1Z3', stateCode: '29' });
    expect(d.warnings).toContain('The supplier "Gupta Hardware Mart" was not found among your suppliers. Choose or add them.');
  });

  it('records failures, and explains each one', async () => {
    await enable();
    const failures: [Partial<FakeOpenRouter>, string][] = [
      [{ chatStatus: 402, chatBody: { error: { code: 402, message: 'Insufficient credits' } } }, 'no credit left'],
      [{ chatStatus: 429, chatBody: { error: { code: 429, message: 'Rate limited' } } }, 'Too many requests'],
      [{ chatStatus: 200, chatBody: { error: { code: 502, message: 'Provider returned error' } } }, 'not available right now'],
      [{ answer: 'Sorry, I cannot read this image.' }, "answer could not be read"],
      [{ answer: bill([], { isBill: false }) }, "does not look like a supplier's bill"],
      [{ answer: bill([]) }, 'No items could be read'],
    ];
    for (const [setup, message] of failures) {
      Object.assign(api, { chatStatus: 200, chatBody: null, answer: null }, setup);
      await expect(scan()).rejects.toThrow(message);
    }
    const failed = listAudit(env.db, { page: 1, pageSize: 20, action: 'AI_SCAN_FAILED' }).rows;
    expect(failed).toHaveLength(failures.length);
    expect(failed[0]!.after).toMatchObject({ fileName: 'bill photo.jpg', model: MODEL });
    // Failed attempts may be charged, so they count against the monthly limit.
    expect((await aiStatus(env, false)).scansThisMonth).toBe(failures.length);
  });

  it('asks for a model that reads images before sending anything, and works without structured output', async () => {
    await enable();
    api.modalities = ['text'];
    await expect(scan()).rejects.toThrow('cannot read images');
    expect(api.chats()).toHaveLength(0);

    // A model without structured output: the answer is found in its text. (A new setup: no cached model details.)
    api.modalities = ['text', 'image'];
    api.parameters = [];
    env.ai = { ...env.ai! };
    api.answer = `Here is the bill:\n\`\`\`json\n${JSON.stringify(bill([HINGE_LINE]))}\n\`\`\``;
    const d: ScanDraft = await scan();
    expect(d.lines).toHaveLength(1);
    expect(api.chats().at(-1)!.body!.response_format).toBeUndefined();
  });

  it('refuses files that are not a bill photo or PDF, or too large', async () => {
    await enable();
    const text = join(env.dir, 'bill.txt');
    writeFileSync(text, 'hello');
    await expect(scanBill(env, actor, text, { canSeeCost: true })).rejects.toThrow('Choose a photo');
    const big = join(env.dir, 'big.png');
    writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1));
    await expect(scanBill(env, actor, big, { canSeeCost: true })).rejects.toThrow('larger than 10 MB');
    const pdf = join(env.dir, 'bill.pdf');
    writeFileSync(pdf, '%PDF-1.4 fake');
    api.answer = bill([HINGE_LINE]);
    const d = await scanBill(env, actor, pdf, { canSeeCost: true });
    expect(d.preview).toBeNull();
    const part = ((api.chats().at(-1)!.body!.messages as { content: unknown }[])[1]!.content as { type: string; file?: { filename: string; file_data: string } }[])[1]!;
    expect(part).toEqual({ type: 'file', file: { filename: 'bill.pdf', file_data: `data:application/pdf;base64,${Buffer.from('%PDF-1.4 fake').toString('base64')}` } });
  });
});
