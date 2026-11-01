import { expect, test } from '@playwright/test';
import { completeSetup, launch, newDataDir } from './app';

// A computer with no network at all (on a Mac, Wi-Fi off) reports itself offline to the window.
// Everything is on this computer, so saving and loading must work exactly the same.
test('with no network connection at all, the shop is set up, saves and loads as usual', async () => {
  const { app, page } = await launch(newDataDir());
  try {
    await app.context().setOffline(true);
    expect(await page.evaluate('navigator.onLine')).toBe(false);

    await completeSetup(page);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await nav.getByRole('link', { name: 'Products & Stock' }).click();
    await page.getByRole('button', { name: 'Add product' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Product name').fill('Claw hammer 450 g');
    await dialog.getByLabel(/^Selling price\*?$/).fill('450');
    await dialog.getByLabel('Quantity in stock now').fill('3');
    await dialog.getByRole('button', { name: 'Add product' }).click();
    await expect(page.getByRole('heading', { name: 'Claw hammer 450 g' })).toBeVisible({ timeout: 5_000 });

    await nav.getByRole('link', { name: 'Products & Stock' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Claw hammer 450 g' })).toContainText('3 PCS', { timeout: 5_000 });
  } finally {
    await app.close();
  }
});
