import { randomUUID } from 'node:crypto';
import { parse, resolve } from 'node:path';
import type { HandlerContext, HandlerMap } from './dispatcher';
import { transact } from '../db/tx';
import { schemaVersion } from '../db/migrator';
import {
  buildSession,
  changeOwnSecret,
  completeSetup,
  createUser,
  defaultOwnerId,
  isSetupComplete,
  listRoles,
  listUsers,
  login,
  loginOptions,
  logout,
  resetUserSecret,
  updateRole,
  updateUser,
} from '../services/auth';
import { getAllSettings, updateSettingsSection } from '../services/settings';
import { auditFacets, listAudit } from '../services/audit';
import { backupDirectory, copyLatestBackupTo, createBackup, listBackups, restoreBackup, validateBackupFile } from '../services/backup';
import { lastSuccessfulBackupAt, nextBackupAt } from '../services/backupSchedule';
import { runIntegrityChecks } from '../services/integrity';
import { AppError, ErrorCodes } from '@shared/errors';
import { settingsSchemas } from '@shared/settings';
import type { IntegrityReport } from '@shared/contracts';

/** Native dialogs and shell access, provided by the Electron layer. */
export interface DesktopUi {
  chooseFolder(title: string, defaultPath?: string): Promise<string | null>;
  chooseFile(title: string, filters: { name: string; extensions: string[] }[]): Promise<string | null>;
  chooseSaveFile(title: string, defaultName: string, extension: string): Promise<string | null>;
  openPath(path: string): Promise<void>;
}

export interface SystemInfo {
  isPackaged: boolean;
  startupWarnings: () => string[];
  /** The data checks, run off the main thread; in-process when not given (tests). */
  checks?(opts: { quickOnly?: boolean }): Promise<IntegrityReport>;
  /**
   * Around a restore: stop whatever holds the database open, then pick up the (restored or,
   * after a failure, reopened original) connection and refresh the screens.
   */
  restore?: { beforeSwap(): Promise<void>; afterRestore(restored: boolean): void };
}

const RESTORE_TOKEN_MS = 15 * 60_000;

export function systemHandlers(ui: DesktopUi, info: SystemInfo): HandlerMap {
  // Files chosen and checked for restoring. The renderer only ever holds a token, never a path.
  const candidates = new Map<string, { path: string; senderId: number; expires: number }>();
  const offer = async (path: string, ctx: HandlerContext) => {
    const validation = await validateBackupFile(path, ctx.env);
    const token = randomUUID();
    if (validation.valid) candidates.set(token, { path, senderId: ctx.senderId, expires: Date.now() + RESTORE_TOKEN_MS });
    return { token, validation };
  };
  const chooseAndOffer = async (ctx: HandlerContext) => {
    const file = await ui.chooseFile('Choose the backup to restore', [{ name: 'Shop backups', extensions: ['db'] }]);
    return file ? offer(file, ctx) : null;
  };
  const restore = async (token: string, ctx: HandlerContext) => {
    const candidate = candidates.get(token);
    if (!candidate || candidate.senderId !== ctx.senderId || candidate.expires < Date.now()) {
      throw new AppError(ErrorCodes.VALIDATION, 'Choose and check the backup again before restoring.');
    }
    candidates.delete(token);
    try {
      const summary = await restoreBackup(ctx.env, ctx.actor, candidate.path, {
        beforeSwap: info.restore?.beforeSwap ?? (async () => {}),
        checks: info.checks && (() => info.checks!({})),
      });
      info.restore?.afterRestore(true);
      return summary;
    } catch (e) {
      info.restore?.afterRestore(false);
      throw e;
    }
  };
  // Restoring without signing in is only for a new installation, before the shop has been set up.
  const assertNotSetUp = (ctx: HandlerContext) => {
    if (isSetupComplete(ctx.env.db)) {
      throw new AppError(ErrorCodes.PERMISSION_DENIED, 'The shop is already set up. An owner can restore from Backup & Settings.', { permission: 'restore before setup' });
    }
  };

  return {
    'app.status': {
      access: 'public',
      handle: (_input, { env }) => ({
        appVersion: env.appVersion,
        schemaVersion: schemaVersion(env.db),
        setupComplete: isSetupComplete(env.db),
        shopName: getAllSettings(env.db).shop.name,
        requireLogin: getAllSettings(env.db).app.requireLogin,
        dataDir: env.paths.dataDir,
        databasePath: env.paths.databasePath,
        isPackaged: info.isPackaged,
        startupWarnings: info.startupWarnings(),
      }),
    },

    'setup.complete': {
      access: 'public',
      handle: (input, ctx) => {
        const session = completeSetup(ctx.env, input);
        ctx.setSessionUser(session.user.id);
        return session;
      },
    },

    'auth.session': {
      access: 'public',
      handle: (_input, ctx) => {
        if (ctx.session) return ctx.session;
        // With the login screen switched off, the shop runs as its owner account.
        if (isSetupComplete(ctx.env.db) && !getAllSettings(ctx.env.db).app.requireLogin) {
          const ownerId = defaultOwnerId(ctx.env.db);
          if (ownerId !== null) {
            ctx.setSessionUser(ownerId);
            return buildSession(ctx.env.db, ownerId);
          }
        }
        return null;
      },
    },
    'auth.loginOptions': { access: 'public', handle: (_i, { env }) => loginOptions(env.db) },
    'auth.login': {
      access: 'public',
      handle: (input, ctx) => {
        const session = login(ctx.env, input.username, input.secret);
        ctx.setSessionUser(session.user.id);
        return session;
      },
    },
    'auth.logout': {
      access: 'authenticated',
      handle: (_input, ctx) => {
        logout(ctx.env, ctx.actor);
        ctx.setSessionUser(null);
        return null;
      },
    },
    'auth.changeSecret': {
      access: 'authenticated',
      handle: (input, ctx) => {
        changeOwnSecret(ctx.env, ctx.actor, input.currentSecret, input.newSecret);
        return null;
      },
    },

    'users.list': { access: 'users.manage', handle: (_i, { env }) => listUsers(env.db) },
    'users.create': { access: 'users.manage', handle: (input, ctx) => createUser(ctx.env, ctx.actor, input) },
    'users.update': { access: 'users.manage', handle: (input, ctx) => updateUser(ctx.env, ctx.actor, input) },
    'users.resetSecret': {
      access: 'users.manage',
      handle: (input, ctx) => {
        resetUserSecret(ctx.env, ctx.actor, input.id, input.newSecret, input.reason);
        return null;
      },
    },
    'roles.list': { access: 'users.manage', handle: (_i, { env }) => listRoles(env.db) },
    'roles.update': { access: 'users.manage', handle: (input, ctx) => updateRole(ctx.env, ctx.actor, input) },

    'settings.get': { access: 'authenticated', handle: (_i, { env }) => getAllSettings(env.db) },
    'settings.update': {
      access: 'settings.manage',
      handle: (input, ctx) => {
        // The renderer never supplies filesystem paths; the folder is only set through the native picker.
        if (
          input.section === 'backup' &&
          settingsSchemas.backup.parse(input.value).folder !== getAllSettings(ctx.env.db).backup.folder
        ) {
          throw new AppError(ErrorCodes.VALIDATION, 'Choose the backup folder with the "Change folder" button.');
        }
        transact(ctx.env, ctx.actor, (tx) => updateSettingsSection(tx, input.section, input.value, input.reason));
        return getAllSettings(ctx.env.db);
      },
    },

    'audit.list': { access: 'audit.view', handle: (input, { env }) => listAudit(env.db, input) },
    'audit.facets': { access: 'audit.view', handle: (_i, { env }) => auditFacets(env.db) },

    'backup.info': {
      access: 'backup.create',
      handle: (_i, { env }) => {
        const folder = backupDirectory(env);
        const drive = (p: string) => parse(resolve(p)).root.toLowerCase();
        const settings = getAllSettings(env.db).backup;
        const last = lastSuccessfulBackupAt(env);
        return {
          folder,
          isDefaultFolder: settings.folder === null,
          sameDriveAsData: drive(folder) === drive(env.paths.dataDir),
          lastSuccessAt: last,
          nextAutoAt: nextBackupAt(env.clock.now(), last, settings, env.timeZone ?? 'Asia/Kolkata'),
        };
      },
    },
    'backup.list': { access: 'backup.create', handle: (_i, ctx) => listBackups(ctx.env) },
    'backup.create': { access: 'backup.create', handle: (_i, ctx) => createBackup(ctx.env, ctx.actor, 'MANUAL') },
    'backup.chooseFolder': {
      access: 'settings.manage',
      handle: async (_i, ctx) => {
        const folder = await ui.chooseFolder('Choose the backup folder', backupDirectory(ctx.env));
        if (!folder) return null;
        const current = getAllSettings(ctx.env.db).backup;
        transact(ctx.env, ctx.actor, (tx) => updateSettingsSection(tx, 'backup', { ...current, folder }));
        return getAllSettings(ctx.env.db);
      },
    },
    'backup.copyLatestTo': {
      access: 'backup.create',
      handle: async (_i, ctx) => {
        const folder = await ui.chooseFolder('Choose the USB drive or folder to copy the latest backup to');
        if (!folder) return null;
        return { copiedTo: await copyLatestBackupTo(ctx.env, ctx.actor, folder) };
      },
    },
    'backup.validateFile': {
      access: 'backup.create',
      handle: async (_i, { env }) => {
        const file = await ui.chooseFile('Choose a backup file to check', [
          { name: 'Shop backups', extensions: ['db'] },
        ]);
        return file ? validateBackupFile(file, env) : null;
      },
    },
    'backup.restoreChoose': { access: 'backup.restore', handle: (_i, ctx) => chooseAndOffer(ctx) },
    'backup.restoreCheck': {
      access: 'backup.restore',
      handle: async (input, ctx) => {
        const row = listBackups(ctx.env, 5000).find((b) => b.id === input.id);
        if (!row || row.status !== 'OK') throw new AppError(ErrorCodes.NOT_FOUND, 'That backup is not in the history.');
        if (!row.fileExists) throw new AppError(ErrorCodes.NOT_FOUND, `The file ${row.fileName} is no longer in the backup folder.`);
        return offer(row.filePath, ctx);
      },
    },
    'backup.restore': { access: 'backup.restore', handle: (input, ctx) => restore(input.token, ctx) },
    'setup.restoreChoose': {
      access: 'public',
      handle: (_i, ctx) => {
        assertNotSetUp(ctx);
        return chooseAndOffer(ctx);
      },
    },
    'setup.restore': {
      access: 'public',
      handle: (input, ctx) => {
        assertNotSetUp(ctx);
        return restore(input.token, ctx);
      },
    },
    'backup.openFolder': {
      access: 'backup.create',
      handle: async (_i, ctx) => {
        await ui.openPath(backupDirectory(ctx.env));
        return null;
      },
    },

    'integrity.run': { access: 'settings.manage', handle: (_i, { env }) => (info.checks ? info.checks({}) : runIntegrityChecks(env.db)) },
  };
}
