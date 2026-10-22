import { parse, resolve } from 'node:path';
import type { HandlerMap } from './dispatcher';
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
import { backupDirectory, copyLatestBackupTo, createBackup, listBackups, validateBackupFile } from '../services/backup';
import { runIntegrityChecks } from '../services/integrity';
import { AppError, ErrorCodes } from '@shared/errors';
import { settingsSchemas } from '@shared/settings';

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
}

export function systemHandlers(ui: DesktopUi, info: SystemInfo): HandlerMap {
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
        return {
          folder,
          isDefaultFolder: getAllSettings(env.db).backup.folder === null,
          sameDriveAsData: drive(folder) === drive(env.paths.dataDir),
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
      handle: async () => {
        const file = await ui.chooseFile('Choose a backup file to check', [
          { name: 'Shop backups', extensions: ['db'] },
        ]);
        return file ? validateBackupFile(file) : null;
      },
    },
    'backup.openFolder': {
      access: 'backup.create',
      handle: async (_i, ctx) => {
        await ui.openPath(backupDirectory(ctx.env));
        return null;
      },
    },

    'integrity.run': { access: 'settings.manage', handle: (_i, { env }) => runIntegrityChecks(env.db) },
  };
}
