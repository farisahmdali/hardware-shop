import { expect, test } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, newDataDir } from './app';

const shots = join(__dirname, '../../test-results/screens');

test('first run, sign-in, navigation, backup and restart persistence', async () => {
  const dataDir = newDataDir();

  // ---- First launch: setup wizard ----
  let { app, page } = await launch(dataDir);
  await expect(page.getByRole('heading', { name: 'Welcome to Hardware Shop Manager' })).toBeVisible();
  await page.screenshot({ path: join(shots, '01-setup-shop.png') });

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Shop name is required')).toBeVisible();

  await page.getByLabel('Shop name').fill('Sharma Hardware & Tools');
  await page.getByLabel('Address line 1').fill('12 Market Road');
  await page.getByLabel('City / town').fill('Pune');
  await page.getByLabel('PIN code').fill('411001');
  await page.getByLabel('State').selectOption('27');
  await page.getByLabel('GSTIN').fill('27AAPFU0939F1ZV');
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByLabel('Your name').fill('Ravi Sharma');
  await page.getByLabel('PIN or password').fill('4321');
  await page.getByLabel('Repeat it').fill('4321');
  await page.screenshot({ path: join(shots, '02-setup-owner.png') });
  await page.getByRole('button', { name: 'Finish setup' }).click();

  // ---- Signed in: the shell and all 12 navigation items ----
  await expect(page.getByRole('heading', { name: 'Hello, Ravi' })).toBeVisible();
  await page.screenshot({ path: join(shots, '03-dashboard.png') });
  const nav = page.getByRole('navigation', { name: 'Main' });
  const labels = [
    'Dashboard',
    'Sales & Billing',
    'Products & Stock',
    'Rental Inventory',
    'Rental Transactions',
    'Customers',
    'Suppliers & Purchases',
    'Payments & Outstanding',
    'Expenses & Cash',
    'Reports',
    'History & Audit Log',
    'Backup & Settings',
  ];
  for (const label of labels) {
    await nav.getByRole('link', { name: label }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }
  await nav.getByRole('link', { name: 'Products & Stock' }).click();
  await page.screenshot({ path: join(shots, '04-placeholder.png') });

  // ---- Backup ----
  await nav.getByRole('link', { name: 'Backup & Settings' }).click();
  await expect(page.getByText('Backups are on the same drive')).toBeVisible();
  await page.getByRole('button', { name: 'Back up now' }).click();
  await expect(page.getByText(/^Backup created:/)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Verified' }).or(page.getByText('Verified')).first()).toBeVisible();
  await page.screenshot({ path: join(shots, '05-backup.png') });
  const backups = readdirSync(join(dataDir, 'backups'));
  expect(backups.filter((f) => f.endsWith('.db'))).toHaveLength(1);
  expect(backups.filter((f) => f.endsWith('.json'))).toHaveLength(1);

  // ---- Edit a setting and see it in the history ----
  await page.getByRole('link', { name: 'Billing, tax & stock' }).click();
  await page.getByRole('switch', { name: 'Selling prices include GST' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Billing settings saved')).toBeVisible();

  await nav.getByRole('link', { name: 'History & Audit Log' }).click();
  const row = page.getByRole('row').filter({ hasText: 'Settings' }).filter({ hasText: 'Update' }).first();
  await row.click();
  await expect(page.getByRole('cell', { name: 'Prices include GST', exact: true })).toBeVisible();
  await page.screenshot({ path: join(shots, '06-history.png') });

  // ---- Data health ----
  await nav.getByRole('link', { name: 'Backup & Settings' }).click();
  await page.getByRole('link', { name: 'Data health' }).click();
  await page.getByRole('button', { name: 'Run full check' }).click();
  await expect(page.getByText('No problems found')).toBeVisible();

  // ---- The app made no network requests it was allowed to make ----
  const blocked = await app.evaluate(async ({ net }) => {
    try {
      await net.fetch('https://example.com');
      return false;
    } catch {
      return true;
    }
  });
  expect(blocked).toBe(true);

  await app.close();

  // ---- Restart: data and history persist, sign-in required ----
  ({ app, page } = await launch(dataDir));
  await expect(page.getByText('Sign in to continue')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sharma Hardware & Tools' })).toBeVisible();
  await page.getByLabel('PIN or password').fill('0000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Incorrect username or PIN/password.')).toBeVisible();
  await page.screenshot({ path: join(shots, '07-login.png') });
  await page.getByLabel('PIN or password').fill('4321');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Hello, Ravi' })).toBeVisible();

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'History & Audit Log' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Setup completed' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Login failed' }).first()).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Backup created' })).toBeVisible();

  await app.close();
  expect(existsSync(join(dataDir, 'data', 'shop.db'))).toBe(true);
});
