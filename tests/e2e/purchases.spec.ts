import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { completeSetup, launch, newDataDir } from './app';

const shots = join(__dirname, '../../test-results/screens');

test('suppliers and cash: purchase with freight and part payment, return, pay off, expense correction, cash count', async () => {
  const dataDir = newDataDir();
  const { app, page } = await launch(dataDir);
  await completeSetup(page);
  const nav = page.getByRole('navigation', { name: 'Main' });

  await nav.getByRole('link', { name: 'Backup & Settings' }).click();
  await page.getByRole('link', { name: 'Data health' }).click();
  await page.getByRole('button', { name: 'Add sample products' }).click();
  await expect(page.getByText('Added 30 sample products')).toBeVisible();

  // ---- A GST-registered supplier ----
  await nav.getByRole('link', { name: 'Suppliers & Purchases' }).click();
  await page.getByRole('button', { name: 'Add supplier' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^Name/).fill('Pune Tools Distributors');
  await dialog.getByLabel('Phone').fill('9822098220');
  await dialog.getByLabel('GSTIN').fill('27AAPFU0939F1ZV');
  await dialog.getByRole('button', { name: 'Add supplier' }).click();
  await expect(page.getByRole('heading', { name: 'Pune Tools Distributors' })).toBeVisible();

  // ---- Their bill: 10 hammers at ₹300 + 18% GST, ₹60 freight, ₹1,000 paid in cash ----
  await page.getByRole('button', { name: 'New purchase' }).click();
  await expect(page.getByText('GSTIN 27AAPFU0939F1ZV')).toBeVisible();
  await page.getByLabel('Their bill number').fill('PT-1001');
  const search = page.getByLabel('Search products to add');
  await search.fill('claw ham');
  await expect(page.getByRole('option', { name: /Claw hammer 450 g/ })).toBeVisible();
  await search.press('Enter');
  await page.getByLabel('Quantity of Claw hammer 450 g').fill('10');
  await page.getByLabel('Rate of Claw hammer 450 g', { exact: true }).fill('300');
  await page.getByLabel('Freight / other charges').fill('60');
  await expect(page.getByTestId('purchase-total')).toHaveText('₹3,600.00');
  await expect(page.getByText(/Input GST ₹540.00 is claimable/)).toBeVisible();
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await page.getByLabel('Cash amount').fill('1000');
  await page.screenshot({ path: join(shots, '40-purchase-entry.png') });
  await page.getByRole('button', { name: /^Save purchase/ }).click();

  await expect(page.getByRole('heading', { name: 'PUR/2026-27/00001' })).toBeVisible();
  await expect(page.getByText('Part paid')).toBeVisible();
  // Freight spread in: ₹3,060 over 10 hammers.
  await expect(page.getByRole('row', { name: /Claw hammer 450 g/ })).toContainText('₹306.00');
  await expect(page.getByText('To pay', { exact: true }).locator('..')).toContainText('₹2,600.00');
  await page.screenshot({ path: join(shots, '41-purchase-detail.png') });

  // ---- Two hammers go back: debit note for 2/10 of ₹3,540 ----
  await page.getByRole('button', { name: 'Return goods' }).click();
  await page.getByLabel('Return quantity of Claw hammer 450 g').fill('2');
  await page.getByRole('dialog').getByLabel(/^Reason/).fill('Two handles cracked');
  await page.getByRole('button', { name: /Issue debit note · ₹708.00/ }).click();
  await expect(page.frameLocator('iframe[title="Document preview"]').getByText('DEBIT NOTE')).toBeVisible();
  await expect(page.frameLocator('iframe[title="Document preview"]').getByText('Two handles cracked')).toBeVisible();
  await page.screenshot({ path: join(shots, '42-debit-note.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByText('To pay', { exact: true }).locator('..')).toContainText('₹1,892.00');

  // ---- Pay the rest from the supplier's page ----
  await page.getByRole('link', { name: 'Pune Tools Distributors' }).click();
  await page.getByRole('button', { name: 'Pay', exact: true }).click();
  await page.getByLabel('Amount paid').fill('1892');
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByText(/Payment PAY\/2026-27\/\d+ recorded/)).toBeVisible();
  await expect(page.getByText('Nothing owed')).toBeVisible();

  // ---- An expense, corrected afterwards ----
  await nav.getByRole('link', { name: 'Expenses & Cash' }).click();
  await page.getByRole('button', { name: 'Add expense' }).click();
  await page.getByRole('dialog').getByLabel('Category').selectOption({ label: 'Electricity' });
  await page.getByRole('dialog').getByLabel('Amount').fill('1200');
  await page.getByRole('dialog').getByLabel(/^What for/).fill('Electricity bill October');
  await page.getByRole('button', { name: 'Record expense' }).click();
  await expect(page.getByRole('row', { name: /Electricity bill October/ })).toContainText('₹1,200.00');
  await page.getByRole('row', { name: /Electricity bill October/ }).click();
  await page.getByRole('dialog').getByLabel('Amount').fill('1100');
  await page.getByRole('dialog').getByLabel(/^Reason for the correction/).fill('Typed the wrong amount');
  await page.getByRole('button', { name: 'Save correction' }).click();
  await expect(page.getByRole('row', { name: /Electricity bill October/ })).toContainText('Corrected');
  await expect(page.getByRole('row', { name: /Electricity bill October/ })).toContainText('₹1,100.00');

  // ---- Cash book: float in, then count ₹8 short ----
  await page.getByRole('tab', { name: 'Cash book' }).click();
  await page.getByRole('button', { name: 'Cash in / out' }).click();
  await page.getByLabel('What happened').selectOption('CASH_IN');
  await page.getByRole('dialog').getByLabel('Amount').fill('5000');
  await page.getByRole('dialog').getByLabel(/^Reason/).fill('Opening float');
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  // ₹5,000 in − ₹2,892 paid to the supplier − ₹1,100 electricity.
  await expect(page.getByText('Should be in the drawer').locator('..')).toContainText('₹1,008.00');
  await expect(page.getByText('Paid to suppliers')).toBeVisible();
  await page.getByRole('button', { name: 'Count cash' }).click();
  await page.getByRole('button', { name: 'Type the total' }).click();
  await page.getByLabel('Cash counted').fill('1000');
  await expect(page.getByRole('dialog').getByText('Short ₹8.00')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save count' })).toBeDisabled();
  await page.getByLabel(/^Explain the difference/).fill('Coins given as change');
  await page.getByRole('button', { name: 'Save count' }).click();
  await expect(page.getByText('Short by ₹8.00')).toBeVisible();
  await expect(page.getByText('Should be in the drawer').locator('..')).toContainText('₹1,000.00');
  await page.screenshot({ path: join(shots, '43-cash-book.png') });

  // ---- Dashboard and data health ----
  await nav.getByRole('link', { name: 'Dashboard' }).click();
  await expect(page.getByRole('link', { name: /To pay suppliers/ })).toContainText('₹0.00');
  await expect(page.getByRole('link', { name: /Cash in drawer/ })).toContainText('₹1,000.00');
  await expect(page.getByRole('link', { name: /Expenses today/ })).toContainText('₹1,100.00');
  await page.screenshot({ path: join(shots, '44-dashboard.png') });
  await nav.getByRole('link', { name: 'Backup & Settings' }).click();
  await page.getByRole('link', { name: 'Data health' }).click();
  await page.getByRole('button', { name: 'Run full check' }).click();
  await expect(page.getByText('No problems found')).toBeVisible();
  await expect(page.getByText('Supplier balances match their bills, payments and returns')).toBeVisible();
  await app.close();
});
