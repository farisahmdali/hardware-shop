import { defineConfig } from '@playwright/test';

/** The installer test (npm run test:install): builds installers, installs, upgrades, uninstalls. */
export default defineConfig({
  testDir: 'tests/install',
  timeout: 15 * 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
});
