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
