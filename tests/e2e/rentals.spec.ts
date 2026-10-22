import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { completeSetup, launch, newDataDir } from './app';

const shots = join(__dirname, '../../test-results/screens');

test('rentals: issue with deposit, extend, damaged return, deposit settlement, close, reservation', async () => {
  const dataDir = newDataDir();
  const { app, page } = await launch(dataDir);
  await completeSetup(page);
  const nav = page.getByRole('navigation', { name: 'Main' });

  await nav.getByRole('link', { name: 'Backup & Settings' }).click();
  await page.getByRole('link', { name: 'Data health' }).click();
  await page.getByRole('button', { name: 'Add sample products' }).click();
  await expect(page.getByText('Added 30 sample products')).toBeVisible();

  // ---- Inventory ----
  await nav.getByRole('link', { name: 'Rental Inventory' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Impact drill 13 mm' })).toContainText('₹300.00/day');
  await page.getByRole('tab', { name: 'Unit board' }).click();
  await expect(page.getByRole('button', { name: /RI-001-01/ })).toBeVisible();
  await page.screenshot({ path: join(shots, '30-unit-board.png') });

  // ---- Issue a rental to a new customer ----
  await nav.getByRole('link', { name: 'Rental Transactions' }).click();
  await page.getByRole('button', { name: 'New rental' }).click();
  await page.getByRole('button', { name: 'Choose customer' }).click();
  await page.getByRole('button', { name: 'New customer' }).click();
  await page.getByRole('dialog').getByLabel(/^Name/).fill('Patil Constructions');
  await page.getByRole('dialog').getByLabel('Mobile number').fill('9890011122');
  await page.getByRole('button', { name: 'Add customer' }).click();
  await expect(page.getByText('Patil Constructions')).toBeVisible();

  await page.getByRole('button', { name: '+2 days' }).click();
  await page.getByLabel('Rental item').selectOption({ label: 'Impact drill 13 mm (3 available)' });
  await page.getByRole('button', { name: 'Add unit' }).click();
  await expect(page.getByText('2 days: 2 days × ₹300.00')).toBeVisible();
  await expect(page.getByText('Rental total').locator('..')).toContainText('₹600.00');
  await expect(page.getByLabel('Deposit amount')).toHaveValue('2000.00');
  await page.getByRole('button', { name: 'UPI', exact: true }).click();
  await page.screenshot({ path: join(shots, '31-new-rental.png') });
  await page.getByRole('button', { name: /^Issue rental/ }).click();

  await expect(page.getByRole('heading', { name: 'RNT/2026-27/00001' })).toBeVisible();
  await expect(page.getByText('With customer')).toBeVisible();
  await expect(page.getByText('Deposit held').locator('..')).toContainText('₹2,000.00');
  await expect(page.getByText('Unpaid charges').locator('..')).toContainText('₹0.00');
  await page.screenshot({ path: join(shots, '32-rental-detail.png') });

  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.frameLocator('iframe[title="Document preview"]').getByText('RENTAL AGREEMENT')).toBeVisible();
  await page.screenshot({ path: join(shots, '33-rental-agreement.png') });
  await page.keyboard.press('Escape');

  // ---- Extend by a day: one more day charged ----
  await page.getByRole('button', { name: 'Extend' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '+1 day' }).click();
  await expect(page.getByText('Extra charge ₹300.00 (incl. GST)')).toBeVisible();
  await page.getByRole('dialog').getByLabel(/^Reason/).fill('Job delayed');
  await page.getByRole('dialog').getByRole('button', { name: /^Extend/ }).click();
  await expect(page.getByText('Rental extended')).toBeVisible();
  await expect(page.getByText('Unpaid charges').locator('..')).toContainText('₹300.00');

  // ---- Damaged return ----
  await page.getByRole('button', { name: 'Return items' }).click();
  await page.getByLabel('Condition on return').selectOption('DAMAGED');
  await page.getByLabel('Damage charge').fill('500');
  await page.getByLabel(/^Damage details/).fill('Cracked side handle');
  await page.screenshot({ path: join(shots, '34-return.png') });
  await page.getByRole('button', { name: /Record return/ }).click();
  await expect(page.getByText('Return recorded')).toBeVisible();
  await expect(page.getByText('Returned · to settle')).toBeVisible();
  await expect(page.getByText('Unpaid charges').locator('..')).toContainText('₹800.00');

  // ---- Settle the deposit: ₹800 used for charges, ₹1,200 refunded ----
  await page.getByRole('button', { name: 'Settle deposit' }).click();
  await expect(page.getByRole('dialog').getByText('₹1,200.00')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Settle' }).click();
  await expect(page.getByText('Deposit settled')).toBeVisible();
  await expect(page.getByText('Deposit held').locator('..')).toContainText('₹0.00');
  await page.getByRole('button', { name: 'Close rental' }).click();
  await page.getByRole('button', { name: 'Close rental' }).last().click();
  await expect(page.getByText('Closed', { exact: true })).toBeVisible();

  // ---- The damaged unit is out of service ----
  await nav.getByRole('link', { name: 'Rental Inventory' }).click();
  await page.getByRole('tab', { name: 'Unit board' }).click();
  await expect(page.getByRole('button', { name: /RI-001-01/ })).toContainText('Damaged');

  // ---- Reserve for tomorrow, then cancel ----
  await nav.getByRole('link', { name: 'Rental Transactions' }).click();
  await page.getByRole('button', { name: 'New rental' }).click();
  await page.getByRole('button', { name: 'Choose customer' }).click();
  await page.getByLabel('Search customers').fill('Patil');
  await page.getByRole('option', { name: /Patil Constructions/ }).click();
  await page.getByRole('radio', { name: 'Reserve for later' }).click();
  await page.getByRole('button', { name: '+2 days' }).click();
  await page.getByLabel('Rental item').selectOption({ label: 'Concrete mixer half bag (1 available)' });
  await page.getByRole('button', { name: 'Add unit' }).click();
  await expect(page.getByText(/Estimated rental/)).toBeVisible();
  await page.getByRole('button', { name: 'Reserve', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'RNT/2026-27/00002' })).toBeVisible();
  await expect(page.getByText('Reserved', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Cancel reservation' }).click();
  await page.getByLabel(/^Reason/).fill('Customer postponed');
  await page.getByRole('button', { name: 'Cancel reservation' }).last().click();
  await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();

  // ---- Dashboard and data health ----
  await nav.getByRole('link', { name: 'Dashboard' }).click();
  await expect(page.getByRole('link', { name: /Deposits held/ })).toContainText('₹0.00');
  await page.screenshot({ path: join(shots, '35-dashboard-rentals.png') });
  await nav.getByRole('link', { name: 'Backup & Settings' }).click();
  await page.getByRole('link', { name: 'Data health' }).click();
  await page.getByRole('button', { name: 'Run full check' }).click();
  await expect(page.getByText('No problems found')).toBeVisible();
  await expect(page.getByText(/deposit-ledger/)).toBeVisible();
  await app.close();
});
