import { expect, test, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { completeSetup, launch, newDataDir, stubDialogs } from './app';

const shots = join(__dirname, '../../test-results/screens');

async function addProduct(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Products & Stock' }).click();
  await page.getByRole('button', { name: 'Add product' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Product name').fill(name);
  await dialog.getByLabel('Category').selectOption({ label: 'Hand tools' });
  await dialog.getByLabel(/^Selling price\*?$/).fill('450');
  await dialog.getByRole('button', { name: 'Add product' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

test('history, automatic backup settings, and restoring a backup', async () => {
  const dataDir = newDataDir();
  const { app, page } = await launch(dataDir);
  await completeSetup(page);
  const nav = page.getByRole('navigation', { name: 'Main' });

  // ---- Data, a backup of it, then a later change ----
  await addProduct(page, 'Claw hammer 450 g');
  await nav.getByRole('link', { name: 'Backup & Settings' }).click();
  await page.getByRole('button', { name: 'Back up now' }).click();
  await expect(page.getByText(/^Backup created:/)).toBeVisible();
  await addProduct(page, 'Spirit level 600 mm');

  // ---- Automatic backup settings ----
  await nav.getByRole('link', { name: 'Backup & Settings' }).click();
  await expect(page.getByText('Last backup')).toBeVisible();
  await page.getByLabel('Back up every').selectOption('6');
  await page.getByRole('button', { name: 'Save backup settings' }).click();
  await expect(page.getByText('Automatic backup settings saved')).toBeVisible();

  // ---- Restore the backup from its history row ----
  await page.getByRole('row').filter({ hasText: 'Manual' }).getByRole('button', { name: 'Restore…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Restore this backup?' });
  await expect(confirm.getByText('All shop data will be replaced by this backup')).toBeVisible();
  await expect(confirm.getByRole('button', { name: 'Restore' })).toBeDisabled();
  await confirm.getByLabel('Type RESTORE to confirm').fill('RESTORE');
  await page.screenshot({ path: join(shots, '60-restore-confirm.png') });
  await confirm.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('The shop data now matches the backup.')).toBeVisible();

  // The window reloads and everyone signs in again.
  await expect(page.getByText('Sign in to continue')).toBeVisible({ timeout: 15_000 });
  await page.getByLabel('PIN or password').fill('4321');
  await page.getByRole('button', { name: 'Sign in' }).click();
  // The reload keeps the screen the restore was started from.
  await expect(page.getByRole('heading', { name: 'Backup & Settings', level: 1 })).toBeVisible();

  await nav.getByRole('link', { name: 'Products & Stock' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Claw hammer 450 g' })).toBeVisible();
  await expect(page.getByText('Spirit level 600 mm')).toHaveCount(0);

  // The copy saved before the restore is listed, and the restore is in the history.
  await nav.getByRole('link', { name: 'Backup & Settings' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Before restore' }).getByText('Verified')).toBeVisible();
  await page.screenshot({ path: join(shots, '61-backups-after-restore.png') });

  await nav.getByRole('link', { name: 'History & Audit Log' }).click();
  const restored = page.getByRole('row').filter({ hasText: 'Data restored from a backup' });
  await restored.click();
  await expect(page.getByRole('cell', { name: /_manual\.db$/ })).toBeVisible();
  await page.screenshot({ path: join(shots, '62-history-restore.png') });

  // ---- History: search by product name, one record's history, export ----
  await page.getByLabel('Search history').fill('claw hammer');
  await expect(page.getByRole('row').filter({ hasText: 'Product' }).filter({ hasText: 'Create' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Data restored from a backup' })).toHaveCount(0);
  await page.getByRole('row').filter({ hasText: 'Create' }).click();
  await page.getByRole('button', { name: 'Full history of this product' }).click();
  await expect(page.getByText('Showing the history of')).toBeVisible();
  await page.getByRole('button', { name: 'Show all history' }).click();
  await expect(page.getByText('Showing the history of')).toHaveCount(0);

  const csv = join(dataDir, 'history.csv');
  await stubDialogs(app, { save: csv });
  await page.getByRole('button', { name: 'Export CSV' }).click();
  await expect(page.getByText('History saved')).toBeVisible();
  expect(existsSync(csv)).toBe(true);
  // The export contains what the filters show.
  const text = readFileSync(csv, 'utf8');
  expect(text).toContain('Name: Claw hammer 450 g');
  expect(text).not.toContain('Data restored from a backup');

  // ---- Data health after the restore ----
  await nav.getByRole('link', { name: 'Backup & Settings' }).click();
  await page.getByRole('link', { name: 'Data health' }).click();
  await page.getByRole('button', { name: 'Run full check' }).click();
  await expect(page.getByText('No problems found')).toBeVisible();
  await expect(page.getByText('Every bill, payment, stock movement and other document has its history entry')).toBeVisible();
  await page.screenshot({ path: join(shots, '63-data-health.png') });

  await app.close();
});

test('a new computer is set up from the old computer\'s backup', async () => {
  // ---- The old computer: a shop with a product, and a backup of it ----
  const oldDir = newDataDir();
  let { app, page } = await launch(oldDir);
  await completeSetup(page);
  await addProduct(page, 'Claw hammer 450 g');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Backup & Settings' }).click();
  await page.getByRole('button', { name: 'Back up now' }).click();
  await expect(page.getByText(/^Backup created:/)).toBeVisible();
  await app.close();
  const backup = join(oldDir, 'backups', readdirSync(join(oldDir, 'backups')).find((f) => f.endsWith('.db'))!);

  // ---- The new computer: restore on the first screen instead of setting up ----
  ({ app, page } = await launch(newDataDir()));
  await expect(page.getByRole('heading', { name: 'Welcome to Hardware Shop Manager' })).toBeVisible();
  await stubDialogs(app, { open: backup });
  await page.getByRole('button', { name: 'Restore from a backup…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Set up the shop from this backup?' });
  await expect(confirm.getByText('Sharma Hardware & Tools')).toBeVisible();
  await page.screenshot({ path: join(shots, '64-setup-restore.png') });
  await confirm.getByLabel('Type RESTORE to confirm').fill('RESTORE');
  await confirm.getByRole('button', { name: 'Restore' }).click();

  // Signed in with the old computer's account, with its data and history.
  await expect(page.getByText('Sign in to continue')).toBeVisible({ timeout: 15_000 });
  await page.getByLabel('PIN or password').fill('4321');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Hello, Ravi' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('link', { name: 'Products & Stock' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Claw hammer 450 g' })).toBeVisible();
  await nav.getByRole('link', { name: 'History & Audit Log' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Data restored from a backup' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Setup completed' })).toBeVisible();
  await app.close();
});

test('starting a new version upgrades the data after a backup, and says so while it works', async () => {
  const dataDir = newDataDir();
  let { app, page } = await launch(dataDir);
  await completeSetup(page);
  await addProduct(page, 'Claw hammer 450 g');
  await app.close();

  // Make the file as the previous version (schema 7) left it: before migration 008's index.
  const db = new Database(join(dataDir, 'data', 'shop.db'));
  db.exec('DROP INDEX idx_ledger_party_account; DELETE FROM schema_migrations WHERE version = 8; PRAGMA user_version = 7;');
  db.close();

  ({ app, page } = await launch(dataDir));
  // The first window is the notice (on a small shop it closes again almost at once); the main
  // window follows when the upgrade is done.
  expect(decodeURIComponent(page.url())).toContain('Updating the shop data…');
  const main = app.windows().find((w) => !w.url().startsWith('data:')) ?? (await app.waitForEvent('window'));
  await expect(main.getByText('Sign in to continue')).toBeVisible({ timeout: 30_000 });
  await main.getByLabel('PIN or password').fill('4321');
  await main.getByRole('button', { name: 'Sign in' }).click();
  const nav = main.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('link', { name: 'Products & Stock' }).click();
  await expect(main.getByRole('row').filter({ hasText: 'Claw hammer 450 g' })).toBeVisible();
  await nav.getByRole('link', { name: 'Backup & Settings' }).click();
  await expect(main.getByRole('row').filter({ hasText: 'Before upgrade' }).getByText('Verified')).toBeVisible();
  await app.close();

  const upgraded = new Database(join(dataDir, 'data', 'shop.db'), { readonly: true });
  expect(upgraded.pragma('user_version', { simple: true })).toBe(8);
  upgraded.close();
});
