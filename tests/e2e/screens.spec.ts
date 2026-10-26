import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { completeSetup, launch, newDataDir } from './app';

const shots = join(__dirname, '../../test-results/screens/1366');

/**
 * Usability check at a common shop-computer resolution: 1366 × 768 with the Windows taskbar.
 * Every main screen opens with data in it, without errors, and without the page scrolling sideways
 * (wide tables scroll inside their own box). Screenshots are kept for review.
 */
test('every main screen fits a 1366 × 768 screen', async () => {
  const { app, page } = await launch(newDataDir());
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.unmaximize();
    win.setContentSize(1366, 728);
  });
  await completeSetup(page);
  const nav = page.getByRole('navigation', { name: 'Main' });

  // Sample products, a counter sale and a rental, so screens show real content.
  await nav.getByRole('link', { name: 'Backup & Settings' }).click();
  await page.getByRole('link', { name: 'Data health' }).click();
  await page.getByRole('button', { name: 'Add sample products' }).click();
  await expect(page.getByText('Added 30 sample products')).toBeVisible();
  await nav.getByRole('link', { name: 'Sales & Billing' }).click();
  const search = page.getByLabel('Search products to add');
  // Typed quickly, pressing Enter before each list appears: every item still lands on the bill.
  for (const term of ['claw ham', '2*led bulb', 'cement']) {
    await search.fill(term);
    await search.press('Enter');
  }
  await expect(page.getByText('Items (3)')).toBeVisible();
  await expect(page.getByLabel('Quantity of LED bulb 9 W')).toHaveValue('2');
  await page.screenshot({ path: join(shots, 'billing-cart.png') });
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await page.getByLabel('Cash received').fill('5000');
  await page.keyboard.press('F9');
  await expect(page.getByText('INV/2026-27/00001')).toBeVisible();
  await page.getByRole('button', { name: 'New bill (Enter)' }).click();

  const screens: [string, string][] = [
    ['dashboard', '#/'],
    ['billing', '#/sales'],
    ['invoices', '#/sales/invoices'],
    ['invoice', '#/sales/invoices/1'],
    ['products', '#/products'],
    ['product', '#/products/1'],
    ['movements', '#/products/movements'],
    ['stock-counts', '#/products/counts'],
    ['rental-items', '#/rental-inventory'],
    ['new-rental', '#/rentals/new'],
    ['rentals', '#/rentals'],
    ['customers', '#/customers'],
    ['payments', '#/payments'],
    ['suppliers', '#/suppliers'],
    ['new-purchase', '#/suppliers/purchases/new'],
    ['expenses', '#/expenses'],
    ['reports', '#/reports'],
    ['report-sales', '#/reports/sales.byPeriod'],
    ['report-valuation', '#/reports/stock.valuation'],
    ['history', '#/history'],
    ['settings-backup', '#/settings/backup'],
    ['settings-billing', '#/settings/billing'],
    ['settings-users', '#/settings/users'],
    ['settings-roles', '#/settings/roles'],
    ['data-health', '#/settings/health'],
  ];
  const problems: string[] = [];
  for (const [name, hash] of screens) {
    // Page-side code as text: this project's Node type settings have no DOM types.
    await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(300);
    const overflow = (await page.evaluate(`(() => {
      const main = document.querySelector('main');
      return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: main.scrollWidth - main.clientWidth };
    })()`)) as { page: number; main: number };
    if (overflow.page > 0 || overflow.main > 0) problems.push(`${name}: scrolls sideways by ${Math.max(overflow.page, overflow.main)} px`);
    if (await page.getByText(/Could not load|Something went wrong/).count()) problems.push(`${name}: shows an error`);
    await page.screenshot({ path: join(shots, `${name}.png`) });
  }
  expect(problems).toEqual([]);
  await app.close();
});
