import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { completeSetup, launch, newDataDir } from './app';

const shots = join(__dirname, '../../test-results/screens');

test('editing a purchase saves a new version, keeps the old one, and records the change', async () => {
  const { app, page } = await launch(newDataDir());
  await completeSetup(page);
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('link', { name: 'Backup & Settings' }).click();
  await page.getByRole('link', { name: 'Data health' }).click();
  await page.getByRole('button', { name: 'Add sample products' }).click();
  await expect(page.getByText('Added 30 sample products')).toBeVisible();

  // ---- A supplier and their bill: 10 hammers at ₹300 + GST, ₹60 freight, ₹1,000 paid ----
  await nav.getByRole('link', { name: 'Suppliers & Purchases' }).click();
  await page.getByRole('button', { name: 'Add supplier' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^Name/).fill('Pune Tools Distributors');
  await dialog.getByLabel('GSTIN').fill('27AAPFU0939F1ZV');
  await dialog.getByRole('button', { name: 'Add supplier' }).click();
  await page.getByRole('button', { name: 'New purchase' }).click();
  await page.getByLabel('Their bill number').fill('PT-1001');
  const search = page.getByLabel('Search products to add');
  await search.fill('claw ham');
  await expect(page.getByRole('option', { name: /Claw hammer 450 g/ })).toBeVisible();
  await search.press('Enter');
  await page.getByLabel('Quantity of Claw hammer 450 g').fill('10');
  await page.getByLabel('Rate of Claw hammer 450 g', { exact: true }).fill('300');
  await page.getByLabel('Freight / other charges').fill('60');
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await page.getByLabel('Cash amount').fill('1000');
  await page.getByRole('button', { name: /^Save purchase/ }).click();
  await expect(page.getByRole('heading', { name: 'PUR/2026-27/00001' })).toBeVisible();

  // ---- Edit: the bill actually had 12 hammers ----
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('heading', { name: 'Edit PUR/2026-27/00001' })).toBeVisible();
  await expect(page.getByLabel('Their bill number')).toHaveValue('PT-1001');
  await expect(page.getByLabel('Quantity of Claw hammer 450 g')).toHaveValue('10');
  await expect(page.getByTestId('purchase-total')).toHaveText('₹3,600.00');
  await page.getByLabel('Quantity of Claw hammer 450 g').fill('12');
  // 12 × ₹300 + 18% GST + ₹60 freight
  await expect(page.getByTestId('purchase-total')).toHaveText('₹4,308.00');
  await expect(page.getByRole('button', { name: /^Save changes/ })).toBeDisabled();
  await page.getByLabel(/Why is the bill being changed/).fill('Two more hammers were on the bill');
  await page.screenshot({ path: join(shots, '70-purchase-edit.png') });
  await page.getByRole('button', { name: /^Save changes · ₹4,308.00/ }).click();

  // ---- The new version: what is owed accounts for the ₹1,000 already paid ----
  await expect(page.getByRole('heading', { name: 'PUR/2026-27/00001-R2' })).toBeVisible();
  await expect(page.getByText('Version 2 of 2')).toBeVisible();
  await expect(page.getByRole('row', { name: /Claw hammer 450 g/ })).toContainText('12');
  await expect(page.getByText('To pay', { exact: true }).locator('..')).toContainText('₹3,308.00');

  // The history shows the edit, its reason, and exactly what changed.
  await page.getByRole('tab', { name: 'History' }).click();
  const editEntry = page.getByRole('row').filter({ hasText: 'Edited' }).filter({ hasText: 'Two more hammers were on the bill' });
  await editEntry.click();
  await expect(page.getByRole('cell', { name: 'Item: Claw hammer 450 g (P-000001)', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '10 PCS at ₹300.00, GST 18%', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '12 PCS at ₹300.00, GST 18%', exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Create' }).first()).toBeVisible(); // the first version's entry
  await page.screenshot({ path: join(shots, '71-purchase-edit-history.png') });

  // ---- The earlier version is kept, read-only, and points to the newer one ----
  await page.getByRole('link', { name: 'PUR/2026-27/00001', exact: true }).click();
  await expect(page.getByText('This is an earlier version.')).toBeVisible();
  await expect(page.getByText('Replaced by an edit')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Open the newer version PUR/2026-27/00001-R2' }).click();
  await expect(page.getByRole('heading', { name: 'PUR/2026-27/00001-R2' })).toBeVisible();

  // The purchase list shows the bill once, as its current version.
  await nav.getByRole('link', { name: 'Suppliers & Purchases' }).click();
  await expect(page.getByRole('heading', { name: 'Suppliers & Purchases', level: 1 })).toBeVisible();
  const list = page.getByRole('table');
  await expect(list.getByRole('row', { name: /^PUR\/2026-27\/00001-R2 / })).toBeVisible();
  await expect(list.getByRole('row')).toHaveCount(2); // the header and the bill, once

  // ---- Everything still adds up ----
  await nav.getByRole('link', { name: 'Backup & Settings' }).click();
  await page.getByRole('link', { name: 'Data health' }).click();
  await page.getByRole('button', { name: 'Run full check' }).click();
  await expect(page.getByText('No problems found')).toBeVisible();
  await app.close();
});
