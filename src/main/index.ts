import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { resolvePaths } from './app/paths';
import { createLogger } from './app/logger';
import { blockNetwork, hardenWebContents } from './app/security';
import { createMainWindow, createUpgradeNotice, devServerUrl, rendererUrl } from './app/window';
import { openDatabase, type Db } from './db/connection';
import { systemClock } from './db/tx';
import { pendingMigrations, schemaVersion } from './db/migrator';
import type { AppEnv } from './services/env';
import { removeInterruptedBackups, recoverInterruptedRestore } from './services/backup';
import { upgradeDatabase } from './services/upgrade';
import { startBackupScheduler } from './services/backupSchedule';
import { buildSession } from './services/auth';
import { createDispatcher } from './ipc/dispatcher';
import { systemHandlers, type DesktopUi } from './ipc/systemHandlers';
import { inventoryHandlers } from './ipc/inventoryHandlers';
import { salesHandlers } from './ipc/salesHandlers';
import { rentalHandlers } from './ipc/rentalHandlers';
import { purchaseHandlers } from './ipc/purchaseHandlers';
import { expenseHandlers } from './ipc/expenseHandlers';
import { reportHandlers } from './ipc/reportHandlers';
import { historyHandlers } from './ipc/historyHandlers';
import { workerRunner } from './reports/workerHost';
import type { ReportRunner } from './reports/runner';
import { htmlToPdf, printHtml } from './print/printer';
import { DEFAULT_TIMEZONE } from '@shared/time';

const isDev = !app.isPackaged;

// Indian date and number formats in native controls such as date pickers.
app.commandLine.appendSwitch('lang', 'en-IN');
let mainWindow: BrowserWindow | null = null;
let db: Db | null = null;
let reports: ReportRunner | null = null;
let backups: { stop(): void } | null = null;

function fatal(title: string, message: string, dataDir?: string): never {
  const where = dataDir ? `\n\nData folder: ${dataDir}` : '';
  dialog.showErrorBox(title, `${message}\n\nYour data has not been changed.${where}`);
  app.exit(1);
  throw new Error(message);
}

async function start(): Promise<void> {
  const paths = resolvePaths();
  const logger = createLogger(paths.dataDir);
  // The installed package's version (set by the installer build). Unpackaged runs (development,
  // tests) start from out/main, where Electron would report its own version instead.
  const appVersion = app.isPackaged ? app.getVersion() : __APP_VERSION__;
  logger.info(`Starting Hardware Shop Manager ${appVersion} (data: ${paths.dataDir})`);

  blockNetwork(logger, devServerUrl);
  hardenWebContents(() => (devServerUrl ? new URL(devServerUrl).origin : 'file://'));

  let database: Db;
  try {
    await recoverInterruptedRestore(paths.databasePath, logger);
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
    appVersion,
    logger,
  };

  // Upgrades: take a verified backup before changing the schema of an existing database.
  let notice: BrowserWindow | null = null;
  try {
    if (schemaVersion(database) > 0 && pendingMigrations(database).length > 0) notice = createUpgradeNotice();
    await upgradeDatabase(env);
  } catch (e) {
    logger.error('Database upgrade failed', e);
    database.close();
    notice?.destroy();
    fatal('Cannot upgrade the shop database', (e as Error).message, paths.dataDir);
  }

  // Reports, data checks and backup checks run in a background worker on their own read-only
  // connection, so the window stays responsive however large the shop's data is.
  const background = (reports = workerRunner(paths.databasePath, logger));
  env.inspectFile = (path) => background.inspect(path);

  const startupWarnings: string[] = [];
  const sessions = new Map<number, number>();
  let restoring = false;
  const restoreHooks = {
    async beforeSwap() {
      restoring = true;
      await reports?.close();
    },
    afterRestore(restored: boolean) {
      db = env.db;
      restoring = false;
      if (!restored) return;
      // Signed-in users may not exist in the restored data; everyone signs in again.
      sessions.clear();
      setTimeout(() => mainWindow?.webContents.reload(), 800);
    },
  };
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
      ...systemHandlers(ui, {
        isPackaged: app.isPackaged,
        startupWarnings: () => startupWarnings,
        checks: (opts) => background.integrity(opts),
        restore: restoreHooks,
      }),
      ...inventoryHandlers(ui, { isPackaged: app.isPackaged }),
      ...salesHandlers(ui, { toPdf: htmlToPdf, print: printHtml }),
      ...rentalHandlers(),
      ...purchaseHandlers(),
      ...expenseHandlers(),
      ...historyHandlers(ui, { toPdf: htmlToPdf, print: printHtml }),
      ...reportHandlers(ui, { toPdf: htmlToPdf, print: printHtml }, background),
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
  // Only now: closing the last window would otherwise end the application.
  notice?.destroy();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void removeInterruptedBackups(env);
  backups = startBackupScheduler(env, { isPaused: () => restoring });

  // Quick consistency check after the window is up, in the background worker.
  setTimeout(() => {
    background
      .integrity({ quickOnly: true })
      .then((report) => {
        for (const issue of report.issues) startupWarnings.push(issue.message);
        if (report.issues.length) logger.warn('Startup integrity issues', report.issues);
      })
      .catch((e) => logger.error('Startup integrity check failed', e));
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
    backups?.stop();
    void reports?.close();
    if (db?.open) db.close();
  });
  app.whenReady().then(start).catch((e) => {
    if (!app.isReady()) return;
    console.error(e);
  });
}
