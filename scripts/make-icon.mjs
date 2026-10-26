// Renders the application icon (the hammer on the orange tile used in the app's header) to
// build/icon.png, 512 × 512, from which electron-builder makes the Windows .ico.
// Run with Electron: npx electron scripts/make-icon.mjs
import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 512;
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png');

// Lucide "hammer" (ISC licence), drawn white on the accent colour.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24">
  <rect x="0.5" y="0.5" width="23" height="23" rx="5.5" fill="#c76b0a"/>
  <g transform="translate(4.2 4.2) scale(0.65)" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="m15 12-9.373 9.373a1 1 0 0 1-3.001-3L12 9"/>
    <path d="m18 15 4-4"/>
    <path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172v-.344a2 2 0 0 0-.586-1.414l-1.657-1.657A6 6 0 0 0 12.516 3H9l1.243 1.243A6 6 0 0 1 12 8.485V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/>
  </g>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`)}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, image.resize({ width: SIZE, height: SIZE }).toPNG());
  console.log(`Wrote ${out}`);
  app.quit();
});
