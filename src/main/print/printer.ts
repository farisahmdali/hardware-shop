import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import type { Paper } from '@shared/contracts';

const MM_PER_INCH = 25.4;

/** Loads a document into an invisible, sandboxed window. The document itself contains no scripts. */
async function withDocument<T>(html: string, fn: (win: BrowserWindow) => Promise<T>): Promise<T> {
  const dir = join(tmpdir(), 'hardware-shop-print');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${randomUUID()}.html`);
  await writeFile(file, html, 'utf8');
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  try {
    await win.loadFile(file);
    return await fn(win);
  } finally {
    win.destroy();
    await rm(file, { force: true });
  }
}

function thermalWidthMm(paper: Paper): number {
  return paper === 'THERMAL_58' ? 58 : 80;
}

/** Height of the rendered receipt in inches, so thermal receipts end where the content ends. */
async function contentHeightInches(win: BrowserWindow): Promise<number> {
  const px = (await win.webContents.executeJavaScript('document.documentElement.scrollHeight')) as number;
  return Math.max(2, px / 96 + 0.3);
}

export async function htmlToPdf(html: string, paper: Paper): Promise<Buffer> {
  return withDocument(html, async (win) => {
    if (paper === 'A4') {
      return win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true });
    }
    const width = thermalWidthMm(paper) / MM_PER_INCH;
    return win.webContents.printToPDF({
      pageSize: { width, height: await contentHeightInches(win) },
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
  });
}

/** Opens the Windows print dialog for the document. Resolves false if the user cancels. */
export async function printHtml(html: string, paper: Paper, opts: { landscape?: boolean } = {}): Promise<boolean> {
  return withDocument(html, async (win) => {
    const pageSize =
      paper === 'A4'
        ? ('A4' as const)
        : { width: thermalWidthMm(paper) * 1000, height: Math.round((await contentHeightInches(win)) * MM_PER_INCH * 1000) };
    return new Promise<boolean>((resolve) => {
      win.webContents.print({ silent: false, printBackground: true, pageSize, landscape: opts.landscape ?? false, margins: { marginType: 'none' } }, (success) =>
        resolve(success),
      );
    });
  });
}
