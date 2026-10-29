import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { completeSetup, launch, newDataDir, stubDialogs } from './app';

const shots = join(__dirname, '../../test-results/screens');
const KEY = 'sk-or-v1-e2e0123456789abcdef0123456789abcdef';
const MODEL = 'test/vision-model';
// Any picture will do: the stand-in server answers with the bill below whatever it is sent.
const BILL_PHOTO = join(__dirname, '../../build/icon.png');

/** A local stand-in for OpenRouter's API. */
function fakeOpenRouter(): Promise<{ server: Server; base: string; requests: { path: string; auth: string; body: string }[] }> {
  const requests: { path: string; auth: string; body: string }[] = [];
  let bills = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ path: req.url ?? '', auth: String(req.headers.authorization ?? ''), body });
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: { code: 401, message: 'User not found.' } });
      if (req.url === '/api/v1/key') return send(200, { data: { limit_remaining: 4.5 } });
      if (req.url === '/api/v1/models') {
        return send(200, { data: [{ id: MODEL, name: 'Test Vision', architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['structured_outputs'] }] });
      }
      if (req.url === '/api/v1/chat/completions') {
        bills++;
        const bill = {
          isBill: true,
          supplier: { name: 'Mehta Traders', gstin: '27AAPFU0939F1ZV', address: 'Lohar Chawl, Mumbai', phone: '022 2345 6789', state: 'Maharashtra' },
          billNumber: `MT-${bills}`,
          billDate: '20/10/2026',
          ratesIncludeGst: false,
          items: [
            { description: 'MEASURING TAPE 5MTR', hsn: '9017', quantity: 6, unit: 'NOS', rate: 160, discountPercent: null, discountAmount: null, gstPercent: 18, amount: 960 },
            { description: 'TAPARIA PLIER 200MM', hsn: '8203', quantity: 4, unit: 'NOS', rate: 180, discountPercent: null, discountAmount: null, gstPercent: 18, amount: 720 },
            { description: 'FEVIKWIK 20 GM', hsn: '3506', quantity: 10, unit: 'NOS', rate: 18, discountPercent: null, discountAmount: null, gstPercent: 18, amount: 180 },
            { description: 'LOADING CHARGES', hsn: null, quantity: 1, unit: null, rate: 50, discountPercent: null, discountAmount: null, gstPercent: 18, amount: 50 },
          ],
          billDiscountPercent: null,
          billDiscountAmount: null,
          freight: null,
          freightNote: null,
          roundOff: 0.2,
          // 1,860 + 18% GST + 0.20 round-off; the loading line was already paid in cash.
          grandTotal: 2195,
        };
        return send(200, { model: MODEL, choices: [{ message: { content: JSON.stringify(bill) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1200, completion_tokens: 300, cost: 0.002 } });
      }
      send(404, { error: { code: 404, message: 'Not found' } });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`, requests })),
  );
}

test('a supplier bill is scanned into a purchase, new items are added, and the next bill matches by itself', async () => {
  const fake = await fakeOpenRouter();
  const { app, page } = await launch(newDataDir(), { HWS_AI_BASE_URL: fake.base });
  try {
    await completeSetup(page);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await nav.getByRole('link', { name: 'Backup & Settings' }).click();
    await page.getByRole('link', { name: 'Data health' }).click();
    await page.getByRole('button', { name: 'Add sample products' }).click();
    await expect(page.getByText('Added 30 sample products')).toBeVisible();

    // ---- No scan button until the owner sets the assistant up ----
    await nav.getByRole('link', { name: 'Suppliers & Purchases' }).click();
    await page.getByRole('button', { name: 'New purchase' }).click();
    await expect(page.getByRole('heading', { name: 'New purchase' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Scan supplier's bill/ })).toHaveCount(0);

    // ---- Backup & Settings → AI assistant ----
    await nav.getByRole('link', { name: 'Backup & Settings' }).click();
    await page.getByRole('link', { name: 'AI assistant' }).click();
    await expect(page.getByText('Only the bill file you choose is sent')).toBeVisible();
    await page.getByLabel('API key').fill(KEY);
    await page.getByRole('button', { name: 'Save key' }).click();
    await expect(page.getByText(/A key is saved, ending …cdef/)).toBeVisible();
    await page.getByRole('switch', { name: 'Scan supplier bills with AI' }).click();
    await page.getByLabel('AI model').fill(MODEL);
    await page.getByRole('button', { name: 'Save AI settings' }).click();
    await expect(page.getByText('AI assistant settings saved')).toBeVisible();
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.getByText('Connected. Test Vision can read bills.')).toBeVisible();
    await expect(page.getByText('Credit left on this key: US$ 4.50')).toBeVisible();
    await page.screenshot({ path: join(shots, '80-ai-settings.png') });
    // The key never reaches the screen.
    expect(await page.content()).not.toContain(KEY);

    // ---- Scan the bill ----
    await nav.getByRole('link', { name: 'Suppliers & Purchases' }).click();
    await page.getByRole('button', { name: 'New purchase' }).click();
    await stubDialogs(app, { open: BILL_PHOTO });
    await page.getByRole('button', { name: "Scan supplier's bill…" }).click();
    await expect(page.getByRole('heading', { name: 'Scanned bill' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel('Their bill number')).toHaveValue('MT-1');
    await expect(page.getByLabel('Bill date')).toHaveValue('2026-10-20');

    // The tape is matched by name, size and HSN; the person checks it.
    const tapeRow = page.getByRole('row').filter({ hasText: 'Measuring tape 5 m' });
    await expect(tapeRow).toContainText('On the bill: MEASURING TAPE 5MTR');
    await expect(tapeRow).toContainText('Matched, please check');
    await expect(page.getByLabel('Quantity of Measuring tape 5 m')).toHaveValue('6');

    // The rest need a decision before the purchase can be saved.
    const newItems = page.getByTestId('new-item');
    await expect(newItems).toHaveCount(3);
    await expect(page.getByRole('button', { name: /^Save purchase/ })).toBeDisabled();

    // The supplier is not in the shop yet: added from the bill's details.
    await page.getByRole('button', { name: 'Add as a new supplier…' }).click();
    const supplierDialog = page.getByRole('dialog', { name: 'Add supplier' });
    await expect(supplierDialog.getByLabel(/^Name/)).toHaveValue('Mehta Traders');
    await expect(supplierDialog.getByLabel('GSTIN')).toHaveValue('27AAPFU0939F1ZV');
    await supplierDialog.getByRole('button', { name: 'Add supplier' }).click();
    await expect(page.getByText('GSTIN 27AAPFU0939F1ZV')).toBeVisible();
    await expect(page.getByText('Decide what to do with the 3 new items from the bill.')).toBeVisible();

    // The pliers are a product the shop has under another name: point the line to it.
    const plier = newItems.filter({ hasText: 'TAPARIA PLIER 200MM' });
    await plier.getByRole('button', { name: 'Point to existing product…' }).click();
    const which = page.getByRole('dialog', { name: 'Which of your products is this?' });
    await expect(which.getByRole('button', { name: /Combination plier 8 in .*size 200 mm · same HSN/ })).toBeVisible();
    await which.getByRole('button', { name: /Combination plier 8 in/ }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Combination plier 8 in' })).toContainText('On the bill: TAPARIA PLIER 200MM');

    // The loading charge is not an item.
    await newItems.filter({ hasText: 'LOADING CHARGES' }).getByRole('button', { name: 'Leave out' }).click();

    // Fevikwik is new: it is added as a product, but only once its selling price is typed.
    await expect(newItems).toHaveCount(1);
    const addAll = page.getByRole('button', { name: 'Add all new items (1)' });
    await expect(addAll).toBeDisabled();
    await expect(page.getByText('Type the selling price of every new item (1 still empty) to add them.')).toBeVisible();
    await page.getByLabel('Selling price of FEVIKWIK 20 GM').fill('30');
    await page.screenshot({ path: join(shots, '81-scanned-bill.png'), fullPage: true });
    await addAll.click();
    await expect(newItems).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: 'FEVIKWIK 20 GM' })).toContainText('0 PCS in stock');

    // The purchase now matches the bill.
    await expect(page.getByTestId('scan-total-check')).toContainText('Bill total ₹2,195.00 — matches');
    await expect(page.getByTestId('purchase-total')).toHaveText('₹2,195.00');
    await page.getByRole('button', { name: /^Save purchase · ₹2,195.00/ }).click();
    await expect(page.getByRole('heading', { name: 'PUR/2026-27/00001' })).toBeVisible();

    // Stock came in for the new product.
    await nav.getByRole('link', { name: 'Products & Stock' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'FEVIKWIK 20 GM' })).toContainText('10 PCS');

    // ---- The next bill from the same supplier: matched without asking ----
    await nav.getByRole('link', { name: 'Suppliers & Purchases' }).click();
    await page.getByRole('button', { name: 'New purchase' }).click();
    await stubDialogs(app, { open: BILL_PHOTO });
    await page.getByRole('button', { name: "Scan supplier's bill…" }).click();
    await expect(page.getByLabel('Their bill number')).toHaveValue('MT-2', { timeout: 20_000 });
    for (const name of ['Measuring tape 5 m', 'Combination plier 8 in', 'FEVIKWIK 20 GM']) {
      await expect(page.getByRole('row').filter({ hasText: name })).toContainText('Remembered');
    }
    await expect(newItems).toHaveCount(1);
    await expect(newItems).toContainText('LOADING CHARGES');

    // ---- What the history and the supplier show ----
    await nav.getByRole('link', { name: 'History & Audit Log' }).click();
    await expect(page.getByRole('row').filter({ hasText: "Supplier's bill read by AI" })).toHaveCount(2);
    await expect(page.getByRole('row').filter({ hasText: 'OpenRouter API key saved' })).toBeVisible();
    await nav.getByRole('link', { name: 'Suppliers & Purchases' }).click();
    await page.getByRole('tab', { name: 'Suppliers' }).click();
    await page.getByRole('row').filter({ hasText: 'Mehta Traders' }).click();
    await page.getByRole('tab', { name: 'Item names' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'TAPARIA PLIER 200MM' })).toContainText('Combination plier 8 in');

    // ---- Every request carried the key and went only to the AI address; the windows stay offline ----
    expect(fake.requests.length).toBeGreaterThanOrEqual(4);
    expect(fake.requests.every((r) => r.auth === `Bearer ${KEY}`)).toBe(true);
    const blocked = await app.evaluate(async ({ net, session }) => {
      const fails = async (p: Promise<unknown>) => p.then(() => false, () => true);
      return {
        windows: await fails(net.fetch('https://example.com')),
        aiElsewhere: await fails(session.fromPartition('hws-ai').fetch('https://example.com')),
      };
    });
    expect(blocked).toEqual({ windows: true, aiElsewhere: true });
  } finally {
    await app.close();
    fake.server.close();
  }
});
