import { z } from 'zod';
import { command, type Paged } from './define';
import { settingsSchemas, shopProfileSchema, type AllSettings, type SettingsSection } from '../settings';
import { ALL_PERMISSIONS, type Permission } from '../permissions';

// ---------- Types returned to the renderer ----------

export interface AppStatus {
  appVersion: string;
  schemaVersion: number;
  setupComplete: boolean;
  shopName: string;
  requireLogin: boolean;
  dataDir: string;
  databasePath: string;
  isPackaged: boolean;
  startupWarnings: string[];
}

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  roleId: number;
  roleCode: string;
  roleName: string;
}

export interface SessionInfo {
  user: SessionUser;
  permissions: Permission[];
  maxDiscountBp: number;
}

export interface UserRow {
  id: number;
  username: string;
  displayName: string;
  roleId: number;
  roleName: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  version: number;
}

export interface RoleRow {
  id: number;
  code: string;
  name: string;
  isSystem: boolean;
  maxDiscountBp: number;
  permissions: Permission[];
  version: number;
}

export interface AuditRow {
  id: number;
  occurredAt: string;
  userId: number | null;
  username: string | null;
  module: string;
  entityType: string;
  entityId: string | null;
  action: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  txnRef: string | null;
  relatedType: string | null;
  relatedId: string | null;
}

export interface AuditFacets {
  modules: string[];
  actions: string[];
  entityTypes: string[];
  users: { id: number; name: string; username: string }[];
}

export interface BackupRecord {
  id: number;
  createdAt: string;
  kind: BackupKind;
  fileName: string;
  filePath: string;
  sizeBytes: number | null;
  sha256: string | null;
  schemaVersion: number | null;
  status: 'OK' | 'FAILED';
  message: string | null;
  username: string | null;
  fileExists: boolean;
  /** Set when the retention policy removed the file; the history entry is kept. */
  removedAt: string | null;
  removedReason: string | null;
}

export interface RestoreSummary {
  restoredFrom: string;
  backupCreatedAt: string | null;
  /** The copy of the data as it was just before the restore. */
  preRestoreBackup: string;
  migrationsApplied: number[];
  issues: IntegrityIssue[];
}

export type BackupKind = 'MANUAL' | 'AUTO' | 'PRE_RESTORE' | 'PRE_MIGRATION';

export interface BackupFolderInfo {
  folder: string;
  isDefaultFolder: boolean;
  /** True when backups sit on the same drive as the live database (no protection against disk failure). */
  sameDriveAsData: boolean;
  lastSuccessAt: string | null;
  /** When the next automatic backup is due; null when automatic backups are off. */
  nextAutoAt: string | null;
}

/** The result of checking a database file: damage, identity, version and contents. */
export type DatabaseInspection = Pick<BackupValidation, 'valid' | 'problems' | 'schemaVersion' | 'shopName' | 'counts'>;

export interface BackupValidation {
  filePath: string;
  valid: boolean;
  problems: string[];
  schemaVersion: number | null;
  createdAt: string | null;
  appVersion: string | null;
  shopName: string | null;
  sizeBytes: number;
  counts: Record<string, number>;
}

export interface IntegrityIssue {
  check: string;
  severity: 'error' | 'warning';
  message: string;
  details?: unknown;
}

export interface IntegrityReport {
  ranAt: string;
  durationMs: number;
  checksRun: string[];
  issues: IntegrityIssue[];
}

// ---------- Input schemas ----------

const username = z
  .string()
  .trim()
  .min(3, 'At least 3 characters')
  .max(40)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Use letters, digits, dot, dash or underscore');

/** A password or a numeric PIN of at least 4 digits. */
export const secretSchema = z
  .string()
  .min(4, 'At least 4 characters')
  .max(128)
  .refine((v) => /^\d+$/.test(v) || v.length >= 6, 'Use a PIN of 4+ digits or a password of 6+ characters');

const displayName = z.string().trim().min(1, 'Name is required').max(80);

const auditFilter = z.object({
  module: z.string().max(40).optional(),
  entityType: z.string().max(40).optional(),
  entityId: z.string().max(40).optional(),
  /** A record and everything linked to it. */
  record: z.object({ type: z.string().max(40), id: z.string().max(40) }).optional(),
  action: z.string().max(60).optional(),
  userId: z.number().int().positive().optional(),
  txnRef: z.string().max(60).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  search: z.string().trim().max(100).optional(),
});
const id = z.number().int().positive();
const restoreInput = z.object({ token: z.string().uuid(), confirm: z.literal('RESTORE', { message: 'Type RESTORE to confirm' }) });
const version = z.number().int().positive();
const reason = z.string().trim().max(500).optional();

const settingsUpdateInput = z
  .object({
    section: z.enum(Object.keys(settingsSchemas) as [SettingsSection, ...SettingsSection[]]),
    value: z.unknown(),
    reason,
  })
  .superRefine((d, ctx) => {
    const result = settingsSchemas[d.section].safeParse(d.value);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ code: 'custom', message: issue.message, path: ['value', ...issue.path] });
      }
    }
  });

export const systemCommands = {
  'app.status': command<AppStatus>()(z.object({})),

  'setup.complete': command<SessionInfo>()(
    z.object({
      shop: shopProfileSchema,
      owner: z.object({ username, displayName, secret: secretSchema }),
    }),
  ),

  'auth.session': command<SessionInfo | null>()(z.object({})),
  'auth.loginOptions': command<{ users: { username: string; displayName: string }[] }>()(z.object({})),
  'auth.login': command<SessionInfo>()(z.object({ username: z.string().trim().min(1), secret: z.string().min(1) })),
  'auth.logout': command<null>()(z.object({})),
  'auth.changeSecret': command<null>()(z.object({ currentSecret: z.string().min(1), newSecret: secretSchema })),

  'users.list': command<UserRow[]>()(z.object({})),
  'users.create': command<UserRow>()(z.object({ username, displayName, roleId: id, secret: secretSchema })),
  'users.update': command<UserRow>()(
    z.object({ id, displayName, roleId: id, isActive: z.boolean(), version, reason }),
  ),
  'users.resetSecret': command<null>()(z.object({ id, newSecret: secretSchema, reason })),

  'roles.list': command<RoleRow[]>()(z.object({})),
  'roles.update': command<RoleRow>()(
    z.object({
      id,
      permissions: z.array(z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]])),
      maxDiscountBp: z.number().int().min(0).max(10_000),
      version,
      reason,
    }),
  ),

  'settings.get': command<AllSettings>()(z.object({})),
  'settings.update': command<AllSettings>()(settingsUpdateInput),

  'audit.list': command<Paged<AuditRow>>()(
    auditFilter.extend({
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(10).max(200).default(50),
    }),
  ),
  'audit.facets': command<AuditFacets>()(z.object({})),
  /** CSV or PDF of the matching entries (the newest 10,000). */
  'audit.export': command<{ path: string } | null>()(auditFilter.extend({ format: z.enum(['csv', 'pdf']) })),

  'backup.info': command<BackupFolderInfo>()(z.object({})),
  'backup.list': command<BackupRecord[]>()(z.object({})),
  'backup.create': command<BackupRecord>()(z.object({})),
  'backup.chooseFolder': command<AllSettings | null>()(z.object({})),
  'backup.copyLatestTo': command<{ copiedTo: string } | null>()(z.object({})),
  'backup.validateFile': command<BackupValidation | null>()(z.object({})),
  /** Choose a backup file to restore; returns its check and a token for 'backup.restore'. */
  'backup.restoreChoose': command<{ token: string; validation: BackupValidation } | null>()(z.object({})),
  /** Check a backup from the history for restoring; returns its check and a token. */
  'backup.restoreCheck': command<{ token: string; validation: BackupValidation }>()(z.object({ id })),
  'backup.restore': command<RestoreSummary>()(restoreInput),
  /** First start on a new computer: choose a backup to set the shop up from, instead of the setup steps. */
  'setup.restoreChoose': command<{ token: string; validation: BackupValidation } | null>()(z.object({})),
  'setup.restore': command<RestoreSummary>()(restoreInput),
  'backup.openFolder': command<null>()(z.object({})),

  'integrity.run': command<IntegrityReport>()(z.object({})),
};
