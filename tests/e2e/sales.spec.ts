import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { completeSetup, launch, newDataDir, stubDialogs } from './app';

const shots = join(__dirname, '../../test-results/screens');

test('sales: walk-in bill with change, PDF, credit customer, payment, return, cancel, statement', async () => {
  const dataDir = newDataDir();
  const { app, page } = await launch(dataDir);
  await completeSetup(page);
  const nav = page.getByRole('navigation', { name: 'Main' });

  // Sample catalogue (development builds only).
  await nav.getByRole('link', { name: 'Backup & Settings' }).click();
  await page.getByRole('link', { name: 'Data health' }).click();
  await page.getByRole('button', { name: 'Add sample products' }).click();
  await expect(page.getByText('Added 30 sample products')).toBeVisible();

  // ---- Walk-in bill using the keyboard ----
  await nav.getByRole('link', { name: 'Sales & Billing' }).click();
  const search = page.getByLabel('Search products to add');
  await search.fill('claw ham');
  await expect(page.getByRole('option', { name: /Claw hammer 450 g/ })).toBeVisible();
  await search.press('Enter');
  await search.fill('2*led bulb');
  await expect(page.getByRole('option', { name: /LED bulb 9 W/ })).toBeVisible();
  await search.press('Enter');
  await expect(page.getByLabel('Quantity of LED bulb 9 W')).toHaveValue('2');
  // ₹450 + 2 × ₹99 = ₹648
  await expect(page.getByRole('button', { name: /Save bill · ₹648.00/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await page.getByLabel('Cash received').fill('700');
  await expect(page.getByText('change ₹52.00')).toBeVisible();
  await page.screenshot({ path: join(shots, '20-billing.png') });
  await page.keyboard.press('F9');
  await expect(page.getByText('INV/2026-27/00001')).toBeVisible();
  await expect(page.getByText('Give change ₹52.00')).toBeVisible();
  await page.screenshot({ path: join(shots, '21-bill-saved.png') });

  const pdf = join(dataDir, 'invoice.pdf');
  await stubDialogs(app, { save: pdf });
  await page.getByRole('button', { name: 'Save PDF' }).click();
  await expect(page.getByText('PDF saved')).toBeVisible();
  expect(readFileSync(pdf).subarray(0, 5).toString()).toBe('%PDF-');
  await page.getByRole('button', { name: 'New bill (Enter)' }).click();
  await expect(page.getByText('The bill is empty')).toBeVisible();

  // ---- Credit sale to a new customer ----
  await page.keyboard.press('F4');
  await page.getByRole('button', { name: 'New customer' }).click();
  await page.getByRole('dialog').getByLabel(/^Name/).fill('Ramesh Builders');
  await page.getByRole('dialog').getByLabel('Mobile number').fill('9822012345');
  await page.getByRole('button', { name: 'Add customer' }).click();
  await expect(page.getByText('Ramesh Builders').first()).toBeVisible();
  await search.fill('cement');
  await search.press('Enter');
  await page.getByLabel('Quantity of Cement OPC 53 grade 50 kg').fill('10');
  await page.getByRole('button', { name: 'UPI', exact: true }).click();
  await page.getByLabel('UPI amount').fill('1000');
  await page.getByLabel('UPI reference').fill('UPI-778899');
  await expect(page.getByText('On credit (pay later)').locator('..')).toContainText('₹3,200.00');
  await page.getByRole('button', { name: /Save bill/ }).click();
  await expect(page.getByText('Balance on credit: ₹3,200.00')).toBeVisible();
  await page.getByRole('button', { name: 'New bill (Enter)' }).click();

  // ---- Later payment against that invoice ----
  await page.getByRole('link', { name: 'Invoices' }).click();
  await page.getByRole('row').filter({ hasText: 'INV/2026-27/00002' }).click();
  await expect(page.getByText('Part paid').first()).toBeVisible();
  await page.getByRole('button', { name: 'Receive payment' }).click();
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByText(/Payment RCPT\/2026-27\/00003 recorded/)).toBeVisible();
  await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: join(shots, '22-invoice-detail.png') });
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.frameLocator('iframe[title="Document preview"]').getByText('TAX INVOICE')).toBeVisible();
  await page.screenshot({ path: join(shots, '27-invoice-preview.png') });
  await page.keyboard.press('Escape');

  // ---- Return one hammer from the walk-in invoice, refunded in cash ----
  await page.getByRole('link', { name: 'Invoices' }).first().click();
  await page.getByRole('row').filter({ hasText: 'INV/2026-27/00001' }).click();
  await page.getByRole('button', { name: 'Return items' }).click();
  await page.getByLabel('Return quantity of Claw hammer 450 g').fill('1');
  await page.getByRole('dialog').getByLabel(/^Reason/).fill('Handle loose');
  await expect(page.getByText('Refund ₹450.00 to the customer.')).toBeVisible();
  await page.screenshot({ path: join(shots, '23-return.png') });
  await page.getByRole('button', { name: /Issue credit note/ }).click();
  await expect(page.getByText(/Credit note CN\/2026-27\/00001 issued/)).toBeVisible();
  await expect(page.getByText('1 returned')).toBeVisible();

  // ---- Cancel the credit invoice: the payments become customer credit ----
  await page.getByRole('link', { name: 'Invoices' }).first().click();
  await page.getByRole('row').filter({ hasText: 'INV/2026-27/00002' }).click();
  await page.getByRole('button', { name: 'Cancel invoice' }).click();
  await page.getByLabel(/^Reason/).fill('Customer cancelled the order');
  await page.getByRole('button', { name: 'Cancel invoice' }).last().click();
  await expect(page.getByText(/Cancelled .* by owner/)).toBeVisible();

  // ---- Customer account and statement ----
  await nav.getByRole('link', { name: 'Customers' }).click();
  await page.getByRole('row').filter({ hasText: 'Ramesh Builders' }).click();
  await expect(page.getByText('In the customer’s favour')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Invoice cancelled' })).toBeVisible();
  await page.screenshot({ path: join(shots, '24-customer.png') });
  await page.getByRole('button', { name: 'Statement' }).click();
  await expect(page.frameLocator('iframe[title="Document preview"]').getByText('STATEMENT OF ACCOUNT')).toBeVisible();
  await page.screenshot({ path: join(shots, '25-statement.png') });
  await page.keyboard.press('Escape');

  // ---- Payments overview and dashboard ----
  await nav.getByRole('link', { name: 'Payments & Outstanding' }).click();
  await page.getByRole('tab', { name: 'Payments received' }).click();
  await expect(page.getByText('UPI-778899')).toBeVisible();
  await nav.getByRole('link', { name: 'Dashboard' }).click();
  // ₹648 sold, ₹450 returned; the cancelled credit sale does not count.
  await expect(page.getByRole('link', { name: /Sales today/ })).toContainText('₹198.00');
  await page.screenshot({ path: join(shots, '26-dashboard-sales.png') });

  // ---- Everything reconciles ----
  await nav.getByRole('link', { name: 'Backup & Settings' }).click();
  await page.getByRole('link', { name: 'Data health' }).click();
  await page.getByRole('button', { name: 'Run full check' }).click();
  await expect(page.getByText('No problems found')).toBeVisible();
  await expect(page.getByText(/customer-balances/)).toBeVisible();
  expect(existsSync(pdf)).toBe(true);
  await app.close();
});
