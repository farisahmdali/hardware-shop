// Checks a packaged application (…/win-unpacked) after electron-builder: the app archive must hold
// only the built application (out/), package.json and runtime dependencies (node_modules/). A wrong
// `files` setting once made the packager include the whole project folder (a 7 GB archive).
// Usage: node scripts/check-package.mjs release/win-unpacked
import { statSync } from 'node:fs';
import { join } from 'node:path';
import asar from '@electron/asar';

const unpacked = process.argv[2] ?? 'release/win-unpacked';
const archive = join(unpacked, 'resources', 'app.asar');
const MAX_MB = 150;

const top = new Set(asar.listPackage(archive).map((f) => f.split(/[\\/]/).filter(Boolean)[0]));
const unexpected = [...top].filter((name) => !['out', 'package.json', 'node_modules'].includes(name));
const sizeMb = Math.round(statSync(archive).size / 1024 / 1024);

if (unexpected.length || sizeMb > MAX_MB) {
  console.error(`Package check failed for ${archive}: ${sizeMb} MB (limit ${MAX_MB}); unexpected entries: ${unexpected.join(', ') || 'none'}`);
  process.exit(1);
}
console.log(`Package check passed: ${archive} is ${sizeMb} MB and holds only ${[...top].sort().join(', ')}.`);
