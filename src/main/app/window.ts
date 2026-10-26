import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, screen } from 'electron';

/** Set by electron-vite while developing; never set in a packaged build. */
export const devServerUrl: string | undefined = process.env.ELECTRON_RENDERER_URL || undefined;

export function rendererUrl(): string {
  return devServerUrl ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href;
}

export function createMainWindow(isDev: boolean): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1440, width),
    height: Math.min(900, height),
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: '#f6f5f2',
    title: 'Hardware Shop Manager',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: isDev,
    },
  });
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => {
    if (width <= 1600) win.maximize();
    win.show();
  });

  if (isDev) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    });
  }

  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

/**
 * A small notice shown while a large shop's data is backed up and upgraded after installing a
 * new version (it can take a minute), so the application is not mistaken for not starting.
 * Static text only: no preload, no scripts.
 */
export function createUpgradeNotice(): BrowserWindow {
  const win = new BrowserWindow({
    width: 440,
    height: 150,
    frame: false,
    resizable: false,
    movable: true,
    center: true,
    show: false,
    backgroundColor: '#ffffff',
    title: 'Hardware Shop Manager',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: false, devTools: false },
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"></head>
<body style="margin:0;font:15px 'Segoe UI',sans-serif;color:#1f2a28;border:1px solid #d9d5cc;height:148px;box-sizing:border-box;padding:26px 28px">
<div style="font-weight:600;font-size:17px;margin-bottom:8px">Updating the shop data…</div>
<div style="color:#5c6461">A copy of the data is saved first, then it is upgraded for the new version. This can take a minute for a large shop. Please do not switch off the computer.</div>
</body></html>`;
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  win.once('ready-to-show', () => win.show());
  return win;
}
