// Runs Vitest inside Electron's Node runtime, so tests exercise the same Node
// version and better-sqlite3 binary that the packaged application uses.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const vitestEntry = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');

const child = spawn(electronPath, [vitestEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
child.on('exit', (code) => process.exit(code ?? 1));
