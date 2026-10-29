import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function newDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'hws-e2e-'));
}

/** Launches the built application (out/) against an isolated data folder. */
export async function launch(dataDir: string, extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // Editors such as VS Code set this for their own child processes; it would start Electron as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  env.HWS_DATA_DIR = dataDir;
  env.NODE_ENV = 'production';
  Object.assign(env, extraEnv);

  const app = await electron.launch({ args: [join(__dirname, '../../out/main/index.js')], env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

/** Runs the first-run wizard with a standard test shop and owner (PIN 4321). */
export async function completeSetup(page: Page): Promise<void> {
  await page.getByLabel('Shop name').fill('Sharma Hardware & Tools');
  await page.getByLabel('State').selectOption('27');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Your name').fill('Ravi Sharma');
  await page.getByLabel('PIN or password').fill('4321');
  await page.getByLabel('Repeat it').fill('4321');
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByRole('heading', { name: 'Hello, Ravi' })).toBeVisible();
}

/** Makes the next native open/save dialogs return the given paths instead of showing a window. */
export async function stubDialogs(app: ElectronApplication, paths: { open?: string; save?: string }): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    if (p.open) dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p.open!] })) as typeof dialog.showOpenDialog;
    if (p.save) dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p.save! })) as typeof dialog.showSaveDialog;
  }, paths);
}
