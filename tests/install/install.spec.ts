import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeSetup } from '../e2e/app';

/**
 * Installs the real Windows installer silently, runs the installed application, upgrades it with
 * the next version's installer, and uninstalls it. The installers are built by
 * scripts/build-test-installers.mjs under their own id and name ("HSM Install Test"), so a real
 * installation of Hardware Shop Manager on this computer is never touched. Data goes to a temporary
 * folder (HWS_DATA_DIR).
 */
const root = join(__dirname, '../..');
const NAME = 'HSM Install Test';
const installer = (label: 'a' | 'b') => {
  const dir = join(root, process.env.HWS_INSTALLER_DIR || 'installer-test', label);
  const exe = readdirSync(dir).find((f) => f.endsWith('.exe') && f.includes('Setup'));
  if (!exe) throw new Error(`No installer in ${dir}; run npm run test:install`);
  return { path: join(dir, exe), version: /Setup (.+)\.exe$/.exec(exe)![1]! };
};

const work = mkdtempSync(join(tmpdir(), 'hws-install-'));
const installDir = join(work, 'app');
const dataDir = join(work, 'data');
const appExe = join(installDir, `${NAME}.exe`);
const desktopShortcut = join(homedir(), 'Desktop', `${NAME}.lnk`);
const uninstaller = join(installDir, `Uninstall ${NAME}.exe`);

function runInstaller(path: string) {
  // NSIS: /S silent, /currentuser per-user install, /D= target folder (must be last, unquoted).
  const r = spawnSync(path, ['/S', '/currentuser', `/D=${installDir}`], { timeout: 5 * 60_000 });
  expect(r.status).toBe(0);
}

async function launchInstalled(): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_ENV;
  env.HWS_DATA_DIR = dataDir;
  const app = await electron.launch({ executablePath: appExe, env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

/** Remote network connections held by the application's processes (main, renderer, GPU, utility). */
function remoteConnections(mainPid: number): string[] {
  const script = `
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
    $ids = @(${mainPid}); $added = $true
    while ($added) { $added = $false; foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $added = $true } } }
    $tcp = Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess -and $_.RemoteAddress -notin @('127.0.0.1','::1','0.0.0.0','::') }
    $udp = Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess -and $_.LocalAddress -notin @('127.0.0.1','::1') -and $_.LocalPort -ne 0 }
    @($tcp | ForEach-Object { "tcp $($_.RemoteAddress):$($_.RemotePort) $($_.State)" }) + @($udp | ForEach-Object { "udp $($_.LocalAddress):$($_.LocalPort)" }) | Write-Output`;
  return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
}

async function signIn(page: Page) {
  await expect(page.getByText('Sign in to continue')).toBeVisible();
  await page.getByLabel('PIN or password').fill('4321');
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function aboutVersion(page: Page): Promise<string> {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Backup & Settings' }).click();
  await page.getByRole('link', { name: 'My account & display' }).click();
  const row = page.getByText('Version', { exact: true }).locator('..');
  return (await row.innerText()).replace('Version', '').trim();
}

test('installs, runs offline, upgrades keeping the data, and uninstalls keeping the data', async () => {
  const a = installer('a');
  const b = installer('b');

  // ---- Install ----
  runInstaller(a.path);
  try {
    await runUpgradeUninstall(a.version, b);
  } finally {
    // Never leave the test installation behind, even when a step fails.
    if (existsSync(appExe)) spawnSync(uninstaller, ['/S', `_?=${installDir}`], { timeout: 5 * 60_000 });
  }
});

async function runUpgradeUninstall(versionA: string, b: { path: string; version: string }) {
  expect(existsSync(appExe)).toBe(true);
  expect(existsSync(desktopShortcut)).toBe(true);

  // ---- First run of the installed application: setup, a product, a sale, a backup ----
  let { app, page } = await launchInstalled();
  await completeSetup(page);
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('link', { name: 'Products & Stock' }).click();
  await page.getByRole('button', { name: 'Add product' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Product name').fill('Claw hammer 450 g');
  await dialog.getByLabel('Category').selectOption({ label: 'Hand tools' });
  await dialog.getByLabel(/^Selling price\*?$/).fill('450');
  await dialog.getByLabel('Quantity in stock now').fill('5');
  await dialog.getByRole('button', { name: 'Add product' }).click();
  await expect(page.getByRole('heading', { name: 'Claw hammer 450 g' })).toBeVisible();

  await nav.getByRole('link', { name: 'Sales & Billing' }).click();
  const search = page.getByLabel('Search products to add');
  await search.fill('claw ham');
  await expect(page.getByRole('option', { name: /Claw hammer 450 g/ })).toBeVisible();
  await search.press('Enter');
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await page.getByLabel('Cash received').fill('450');
  await page.keyboard.press('F9');
  await expect(page.getByText(/INV\/\d{4}-\d{2}\/00001/)).toBeVisible();
  await page.getByRole('button', { name: 'New bill (Enter)' }).click();

  await nav.getByRole('link', { name: 'Backup & Settings' }).click();
  await page.getByRole('button', { name: 'Back up now' }).click();
  await expect(page.getByText(/^Backup created:/)).toBeVisible();
  expect(await aboutVersion(page)).toBe(versionA);

  // No network: requests are refused inside the app, and no process of it holds a remote connection.
  const blocked = await app.evaluate(async ({ net }) => {
    try {
      await net.fetch('https://example.com');
      return false;
    } catch {
      return true;
    }
  });
  expect(blocked).toBe(true);
  expect(remoteConnections(app.process().pid!)).toEqual([]);
  await app.close();

  // ---- Upgrade with the next version's installer: the data stays ----
  runInstaller(b.path);
  ({ app, page } = await launchInstalled());
  await signIn(page);
  expect(await aboutVersion(page)).toBe(b.version);
  const upgradedNav = page.getByRole('navigation', { name: 'Main' });
  await upgradedNav.getByRole('link', { name: 'Products & Stock' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Claw hammer 450 g' })).toContainText('4 PCS');
  await upgradedNav.getByRole('link', { name: 'History & Audit Log' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Backup created' }).first()).toBeVisible();
  await app.close();

  // ---- Uninstall: the program and shortcuts go, the shop data and backups stay ----
  // _?= runs the uninstaller in place, so it can be waited for.
  const r = spawnSync(uninstaller, ['/S', `_?=${installDir}`], { timeout: 5 * 60_000 });
  expect(r.status).toBe(0);
  expect(existsSync(appExe)).toBe(false);
  expect(existsSync(desktopShortcut)).toBe(false);
  expect(existsSync(join(dataDir, 'data', 'shop.db'))).toBe(true);
  expect(readdirSync(join(dataDir, 'backups')).some((f) => f.endsWith('.db'))).toBe(true);
}
