import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { resolvePaths } from './app/paths';
import { createLogger } from './app/logger';
import { blockNetwork, hardenWebContents } from './app/security';
import { createMainWindow, devServerUrl, rendererUrl } from './app/window';
import { openDatabase, type Db } from './db/connection';
import { migrate, pendingMigrations, schemaVersion } from './db/migrator';
import { SYSTEM_ACTOR, systemClock } from './db/tx';
import type { AppEnv } from './services/env';
import { createBackup } from './services/backup';
import { buildSession } from './services/auth';
import { runIntegrityChecks } from './services/integrity';
import { createDispatcher } from './ipc/dispatcher';
import { systemHandlers, type DesktopUi } from './ipc/systemHandlers';
import { inventoryHandlers } from './ipc/inventoryHandlers';
import { salesHandlers } from './ipc/salesHandlers';
import { rentalHandlers } from './ipc/rentalHandlers';
import { htmlToPdf, printHtml } from './print/printer';
import { DEFAULT_TIMEZONE } from '@shared/time';

const isDev = !app.isPackaged;

// Indian date and number formats in native controls such as date pickers.
app.commandLine.appendSwitch('lang', 'en-IN');
let mainWindow: BrowserWindow | null = null;
let db: Db | null = null;

function fatal(title: string, message: string, dataDir?: string): never {
  const where = dataDir ? `\n\nData folder: ${dataDir}` : '';
  dialog.showErrorBox(title, `${message}\n\nYour data has not been changed.${where}`);
  app.exit(1);
  throw new Error(message);
}

async function start(): Promise<void> {
  const paths = resolvePaths();
  const logger = createLogger(paths.dataDir);
  logger.info(`Starting Hardware Shop Manager ${__APP_VERSION__} (data: ${paths.dataDir})`);

  blockNetwork(logger, devServerUrl);
  hardenWebContents(() => (devServerUrl ? new URL(devServerUrl).origin : 'file://'));

  let database: Db;
  try {
    database = openDatabase(paths.databasePath);
  } catch (e) {
    logger.error('Could not open the database', e);
    fatal('Cannot open the shop database', `The database file could not be opened: ${(e as Error).message}`, paths.dataDir);
  }
  db = database;

  const env: AppEnv = {
    db: database,
    clock: systemClock,
    timeZone: DEFAULT_TIMEZONE,
    paths,
    appVersion: __APP_VERSION__,
    logger,
  };

  // Upgrades: take a verified backup before changing the schema of an existing database.
  try {
    const pending = pendingMigrations(database);
    if (pending.length > 0 && schemaVersion(database) > 0) {
      logger.info(`Backing up before applying migrations ${pending.map((m) => m.version).join(', ')}`);
      await createBackup(env, SYSTEM_ACTOR, 'PRE_MIGRATION');
    }
    const applied = migrate(database);
    if (applied.length) logger.info(`Applied migrations: ${applied.join(', ')}`);
  } catch (e) {
    logger.error('Database upgrade failed', e);
    database.close();
    fatal('Cannot upgrade the shop database', (e as Error).message, paths.dataDir);
  }

  const startupWarnings: string[] = [];
  const sessions = new Map<number, number>();
  const ui: DesktopUi = {
    async chooseFolder(title, defaultPath) {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title,
        defaultPath,
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    async chooseFile(title, filters) {
      const result = await dialog.showOpenDialog(mainWindow!, { title, filters, properties: ['openFile'] });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    async chooseSaveFile(title, defaultName, extension) {
      const result = await dialog.showSaveDialog(mainWindow!, {
        title,
        defaultPath: join(app.getPath('documents'), defaultName),
        filters: [{ name: { xlsx: 'Excel workbook', csv: 'CSV file', pdf: 'PDF document' }[extension] ?? extension, extensions: [extension] }],
      });
      return result.canceled ? null : (result.filePath ?? null);
    },
    async openPath(path) {
      await mkdir(path, { recursive: true });
      const error = await shell.openPath(path);
      if (error) throw new Error(error);
    },
  };

  const dispatch = createDispatcher({
    env,
    handlers: {
      ...systemHandlers(ui, { isPackaged: app.isPackaged, startupWarnings: () => startupWarnings }),
      ...inventoryHandlers(ui, { isPackaged: app.isPackaged }),
      ...salesHandlers(ui, { toPdf: htmlToPdf, print: printHtml }),
      ...rentalHandlers(),
    },
    getSession: (senderId) => {
      const userId = sessions.get(senderId);
      if (userId === undefined) return null;
      const session = buildSession(env.db, userId);
      if (!session) sessions.delete(senderId); // user was deactivated
      return session;
    },
    setSessionUser: (senderId, userId) => {
      if (userId === null) sessions.delete(senderId);
      else sessions.set(senderId, userId);
    },
  });

  const allowedOrigin = devServerUrl ? new URL(devServerUrl).origin : null;
  ipcMain.handle('hws:invoke', (event, message: { command?: unknown; input?: unknown }) => {
    const url = event.senderFrame?.url ?? '';
    const trusted = allowedOrigin ? url.startsWith(allowedOrigin) : url.startsWith(rendererUrl().split('#')[0]!);
    if (!trusted) {
      logger.warn(`Rejected IPC from untrusted frame: ${url}`);
      return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Untrusted caller.' } };
    }
    return dispatch(event.sender.id, message?.command, message?.input);
  });

  mainWindow = createMainWindow(isDev);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Quick consistency check after the window is up, so startup stays fast.
  setTimeout(() => {
    try {
      const report = runIntegrityChecks(env.db, { quickOnly: true });
      for (const issue of report.issues) startupWarnings.push(issue.message);
      if (report.issues.length) logger.warn('Startup integrity issues', report.issues);
    } catch (e) {
      logger.error('Startup integrity check failed', e);
    }
  }, 1500);
}

if (!app.requestSingleInstanceLock()) {
  // A second copy would compete for the same database file.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    if (db?.open) db.close();
  });
  app.whenReady().then(start).catch((e) => {
    if (!app.isReady()) return;
    console.error(e);
  });
}
