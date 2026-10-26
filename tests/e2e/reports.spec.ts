import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { completeSetup, launch, newDataDir, stubDialogs } from './app';

const shots = join(__dirname, '../../test-results/screens');

test('reports and dashboard: period figures, profit, report filters, Excel/CSV/PDF export', async () => {
  const dataDir = newDataDir();
  const { app, page } = await launch(dataDir);
  await completeSetup(page);
  const nav = page.getByRole('navigation', { name: 'Main' });

  await nav.getByRole('link', { name: 'Backup & Settings' }).click();
  await page.getByRole('link', { name: 'Data health' }).click();
  await page.getByRole('button', { name: 'Add sample products' }).click();
  await expect(page.getByText('Added 30 sample products')).toBeVisible();

  // ---- Two cash sales: 2 hammers (₹900) and 3 LED bulbs (₹297) ----
  await nav.getByRole('link', { name: 'Sales & Billing' }).click();
  const search = page.getByLabel('Search products to add');
  for (const [term, option] of [
    ['2*claw ham', /Claw hammer 450 g/],
    ['3*led bulb', /LED bulb 9 W/],
  ] as const) {
    await search.fill(term);
    await expect(page.getByRole('option', { name: option })).toBeVisible();
    await search.press('Enter');
    await page.getByRole('button', { name: 'Cash', exact: true }).click();
    await page.keyboard.press('F9');
    await page.getByRole('button', { name: 'New bill (Enter)' }).click();
    await expect(page.getByText('The bill is empty')).toBeVisible();
  }

  // ---- Dashboard: today, then the month with the daily chart ----
  await nav.getByRole('link', { name: 'Dashboard' }).click();
  await expect(page.getByRole('link', { name: /Sales today/ })).toContainText('₹1,197.00');
  await expect(page.getByRole('link', { name: /Collected today/ })).toContainText('₹1,197.00');
  await expect(page.getByRole('link', { name: /Estimated profit/ })).toBeVisible();
  await page.getByLabel('Dashboard period').selectOption('month');
  await expect(page.getByRole('link', { name: /Sales this month/ })).toContainText('₹1,197.00');
  const chart = page.getByRole('img', { name: /Amount billed each day/ });
  if (new Date().getDate() > 1) {
    await expect(chart).toBeVisible();
    await chart.scrollIntoViewIfNeeded();
    await chart.hover({ position: { x: 300, y: 100 } });
    await page.screenshot({ path: join(shots, '50b-dashboard-chart.png') });
  }
  await page.screenshot({ path: join(shots, '50-dashboard-period.png') });

  // ---- Estimated profit opens the income summary for the same period ----
  await page.getByRole('link', { name: /Estimated profit/ }).click();
  await expect(page.getByRole('heading', { name: 'Income and profit summary' })).toBeVisible();
  await expect(page.getByRole('row', { name: /^Product sales/ })).toContainText('₹1,014.40');
  await expect(page.getByRole('row', { name: /Gross profit/ })).toBeVisible();
  await page.screenshot({ path: join(shots, '51-income-summary.png') });

  // ---- The catalogue, a report with a filter, and exports ----
  await nav.getByRole('link', { name: 'Reports' }).click();
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
  await page.screenshot({ path: join(shots, '52-reports.png') });
  await page.getByLabel('Search reports').fill('sales by product');
  await page.getByRole('link', { name: /Sales by product/ }).click();
  await expect(page.getByRole('row', { name: /Claw hammer 450 g/ })).toContainText('₹900.00');
  await page.getByLabel('Category').selectOption({ label: 'Electrical' });
  await expect(page.getByRole('row', { name: /LED bulb 9 W/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Claw hammer 450 g/ })).toHaveCount(0);
  await expect(page.getByText(/Category: Electrical/)).toBeVisible();
  await page.screenshot({ path: join(shots, '53-sales-by-product.png') });

  const xlsx = join(dataDir, 'sales.xlsx');
  await stubDialogs(app, { save: xlsx });
  await page.getByRole('button', { name: 'Excel' }).click();
  await expect(page.getByText('Report saved')).toBeVisible();
  expect(readFileSync(xlsx).subarray(0, 2).toString()).toBe('PK');

  await page.goto(page.url().replace(/#.*$/, '#/reports/stock.valuation'));
  await expect(page.getByRole('heading', { name: 'Stock valuation' })).toBeVisible();
  await expect(page.getByText('Stock value at cost')).toBeVisible();
  const csv = join(dataDir, 'valuation.csv');
  await stubDialogs(app, { save: csv });
  await page.getByRole('button', { name: 'CSV' }).click();
  await expect(page.getByText('Report saved').first()).toBeVisible();
  expect(readFileSync(csv, 'utf8')).toContain('Code,Product,Category,Quantity,Unit,Average cost (₹)');
  const pdf = join(dataDir, 'valuation.pdf');
  await stubDialogs(app, { save: pdf });
  await page.getByRole('button', { name: 'PDF' }).click();
  await expect.poll(() => {
    try {
      return readFileSync(pdf).subarray(0, 5).toString();
    } catch {
      return '';
    }
  }).toBe('%PDF-');

  // ---- A statement needs a customer first ----
  await page.goto(page.url().replace(/#.*$/, '#/reports/parties.customerStatement'));
  await expect(page.getByText('Choose a customer to see the report')).toBeVisible();

  // ---- Everything reconciles ----
  await nav.getByRole('link', { name: 'Backup & Settings' }).click();
  await page.getByRole('link', { name: 'Data health' }).click();
  await page.getByRole('button', { name: 'Run full check' }).click();
  await expect(page.getByText('No problems found')).toBeVisible();
  await app.close();
});
