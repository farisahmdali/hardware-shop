import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { completeSetup, launch, newDataDir, stubDialogs } from './app';

const shots = join(__dirname, '../../test-results/screens');
// The required-field label reads "Selling price*"; the GST switch label also starts with "Selling price".
const SELLING_PRICE = /^Selling price\*?$/;

test('products and stock: create, receive, damage, price change, import, export, stock count', async () => {
  const dataDir = newDataDir();
  const { app, page } = await launch(dataDir);
  await completeSetup(page);
  const nav = page.getByRole('navigation', { name: 'Main' });

  // ---- Empty catalogue, then add a product with opening stock ----
  await nav.getByRole('link', { name: 'Products & Stock' }).click();
  await expect(page.getByText('No products yet')).toBeVisible();
  await page.getByRole('button', { name: 'Add product' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Product name').fill('Claw hammer 450 g');
  await dialog.getByLabel('Category').selectOption({ label: 'Hand tools' });
  await dialog.getByLabel(SELLING_PRICE).fill('450');
  await dialog.getByLabel('HSN code').fill('8205');
  await dialog.getByLabel('Purchase price (before GST)').fill('310');
  await dialog.getByLabel('Minimum stock').fill('5');
  await dialog.getByLabel('Quantity in stock now').fill('3');
  await expect(dialog.getByText('Before GST ₹381.36 · GST ₹68.64')).toBeVisible();
  await page.screenshot({ path: join(shots, '10-product-form.png') });
  await dialog.getByRole('button', { name: 'Add product' }).click();

  await expect(page.getByRole('heading', { name: 'Claw hammer 450 g' })).toBeVisible();
  await expect(page.getByText('P-000001').first()).toBeVisible();
  await expect(page.getByText('Low', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('3 PCS', { exact: true }).first()).toBeVisible();

  // ---- Receive stock at a new cost; weighted average updates ----
  await page.getByRole('button', { name: 'Adjust stock' }).click();
  await page.getByRole('radio', { name: /Stock received/ }).click();
  await page.getByLabel('Quantity to add').fill('10');
  await page.getByLabel('Cost per unit (before GST)').fill('320');
  await page.getByRole('button', { name: 'Save adjustment' }).click();
  await expect(page.getByText('13 PCS', { exact: true }).first()).toBeVisible();
  // (3 × 310 + 10 × 320) / 13 = 317.69
  await expect(page.getByText('₹317.69').first()).toBeVisible();

  // ---- Damage needs a reason and cannot exceed stock ----
  await page.getByRole('button', { name: 'Adjust stock' }).click();
  await page.getByRole('radio', { name: /Damaged/ }).click();
  await page.getByLabel('Quantity to remove').fill('20');
  await expect(page.getByText('You cannot remove more than is in stock.')).toBeVisible();
  await page.getByLabel('Quantity to remove').fill('1');
  await expect(page.getByRole('button', { name: 'Save adjustment' })).toBeDisabled();
  await page.getByLabel('Reason').fill('Handle cracked');
  await page.screenshot({ path: join(shots, '11-adjust-stock.png') });
  await page.getByRole('button', { name: 'Save adjustment' }).click();
  await expect(page.getByText('12 PCS', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Handle cracked' })).toBeVisible();

  // ---- Price change is recorded with before/after ----
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('dialog').getByLabel(SELLING_PRICE).fill('475');
  await page.getByRole('dialog').getByLabel('Reason for change (optional)').fill('New price list');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('₹475.00').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Change history' }).click();
  await page.getByRole('row').filter({ hasText: 'Price change' }).click();
  await expect(page.getByRole('cell', { name: '₹450.00', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '₹475.00', exact: true })).toBeVisible();
  await page.screenshot({ path: join(shots, '12-product-history.png') });

  // ---- Import from CSV (preview, then confirm) ----
  const csv = join(dataDir, 'import.csv');
  writeFileSync(
    csv,
    [
      'name,category,brand,unit,gst_rate,selling_price,purchase_price,min_stock,opening_stock',
      'PVC pipe 1 in,Plumbing,Supreme,M,18,55,38.5,50,120.5',
      'LED bulb 9 W,Electrical,Havells,PCS,18,99,62,20,40',
      'Broken row,,,boxes of joy,,,,,',
    ].join('\n'),
  );
  await stubDialogs(app, { open: csv });
  await nav.getByRole('link', { name: 'Products & Stock' }).click();
  await page.getByRole('button', { name: 'Import' }).click();
  await page.getByRole('button', { name: 'Choose file…' }).click();
  await expect(page.getByText('2 ready to import')).toBeVisible();
  await expect(page.getByText('Unknown unit "boxes of joy"')).toBeVisible();
  await page.screenshot({ path: join(shots, '13-import-preview.png') });
  await page.getByRole('button', { name: 'Import 2 products' }).click();
  await expect(page.getByText('2 products imported')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'PVC pipe 1 in' })).toContainText('120.5');
  await page.screenshot({ path: join(shots, '14-product-list.png') });

  // ---- Search ----
  await page.getByLabel('Search products').fill('bulb hav');
  await expect(page.getByRole('row').filter({ hasText: 'LED bulb 9 W' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Claw hammer' })).toHaveCount(0);
  await page.getByLabel('Search products').fill('');

  // ---- Export to Excel ----
  const xlsx = join(dataDir, 'export.xlsx');
  await stubDialogs(app, { save: xlsx });
  await page.getByRole('button', { name: 'Export Excel' }).click();
  await expect(page.getByText('Products exported')).toBeVisible();
  expect(existsSync(xlsx)).toBe(true);
  expect(readFileSync(xlsx).subarray(0, 2).toString()).toBe('PK');

  // ---- Stock count corrects a difference ----
  await page.getByRole('link', { name: 'Stock counts' }).click();
  await page.getByRole('button', { name: 'Start stock count' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start count' }).click();
  await expect(page.getByRole('heading', { name: /Stock count SC\/2026-27\/00001/ })).toBeVisible();
  const hammerQty = page.getByLabel('Counted quantity of Claw hammer 450 g');
  await hammerQty.fill('11');
  await hammerQty.press('Enter');
  await expect(page.getByText('1 of 3')).toBeVisible();
  await page.screenshot({ path: join(shots, '15-stock-count.png') });
  await page.getByRole('button', { name: 'Finalize count' }).click();
  await page.getByLabel('Reason').fill('Monthly shelf count');
  await page.getByRole('button', { name: 'Finalize and correct stock' }).click();
  await expect(page.getByText('Stock count finalized')).toBeVisible();

  // ---- Dashboard shows live stock figures ----
  await nav.getByRole('link', { name: 'Dashboard' }).click();
  await expect(page.getByRole('link', { name: /^Active products/ })).toContainText('3');
  await expect(page.getByText('Stock count correction').first()).toBeVisible();
  await page.screenshot({ path: join(shots, '16-dashboard-stock.png') });
  await page.getByRole('link', { name: /Low stock/ }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Claw hammer' })).toHaveCount(0);

  // ---- Data health: stock, movements and ledger all reconcile ----
  await nav.getByRole('link', { name: 'Backup & Settings' }).click();
  await page.getByRole('link', { name: 'Data health' }).click();
  await page.getByRole('button', { name: 'Run full check' }).click();
  await expect(page.getByText('No problems found')).toBeVisible();
  await expect(page.getByText(/inventory-ledger/)).toBeVisible();

  await app.close();
});
