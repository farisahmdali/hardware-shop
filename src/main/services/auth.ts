import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/connection';
import { transact, SYSTEM_ACTOR, type Actor } from '../db/tx';
import type { AppEnv } from './env';
import { updateSettingsSection } from './settings';
import { AppError, ErrorCodes } from '@shared/errors';
import { ALL_PERMISSIONS, isPermission, OWNER_ROLE_CODE, type Permission } from '@shared/permissions';
import { defaultSettings, type ShopProfile } from '@shared/settings';
import type { RoleRow, SessionInfo, UserRow } from '@shared/contracts';

// ---------- Secret hashing (scrypt, local only) ----------

const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 64 };

export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(secret, salt, SCRYPT.keyLen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export function verifySecret(secret: string, stored: string): boolean {
  const [scheme, n, r, p, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = scryptSync(secret, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}

// ---------- Queries ----------

interface UserRecord {
  id: number;
  username: string;
  display_name: string;
  secret_hash: string;
  role_id: number;
  is_active: number;
  failed_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
  version: number;
}

interface RoleRecord {
  id: number;
  code: string;
  name: string;
  is_system: number;
  max_discount_bp: number;
  version: number;
}

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 5;

export function isSetupComplete(db: Db): boolean {
  return !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
}

function getRole(db: Db, roleId: number): RoleRecord {
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId) as RoleRecord | undefined;
  if (!role) throw new AppError(ErrorCodes.NOT_FOUND, 'Role not found.');
  return role;
}

export function permissionsForRole(db: Db, role: RoleRecord): Permission[] {
  if (role.code === OWNER_ROLE_CODE) return [...ALL_PERMISSIONS];
  const rows = db.prepare('SELECT permission FROM role_permissions WHERE role_id = ?').all(role.id) as {
    permission: string;
  }[];
  return rows.map((r) => r.permission).filter(isPermission);
}

/** Builds the session for an active user, reading the role fresh so permission changes apply immediately. */
export function buildSession(db: Db, userId: number): SessionInfo | null {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(userId) as UserRecord | undefined;
  if (!user) return null;
  const role = getRole(db, user.role_id);
  return {
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      roleId: role.id,
      roleCode: role.code,
      roleName: role.name,
    },
    permissions: permissionsForRole(db, role),
    maxDiscountBp: role.max_discount_bp,
  };
}

export function actorFromSession(session: SessionInfo | null): Actor {
  return session ? { userId: session.user.id, username: session.user.username } : SYSTEM_ACTOR;
}

/** The first active owner; used for automatic sign-in when the shop disables the login screen. */
export function defaultOwnerId(db: Db): number | null {
  const row = db
    .prepare(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.code = ? AND u.is_active = 1 ORDER BY u.id LIMIT 1`,
    )
    .get(OWNER_ROLE_CODE) as { id: number } | undefined;
  return row?.id ?? null;
}

function toUserRow(db: Db, u: UserRecord): UserRow {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    roleId: u.role_id,
    roleName: getRole(db, u.role_id).name,
    isActive: u.is_active === 1,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
    version: u.version,
  };
}

/** A user as recorded in the audit log: never includes the secret hash. */
function auditUser(u: UserRecord) {
  return {
    username: u.username,
    displayName: u.display_name,
    roleId: u.role_id,
    isActive: u.is_active === 1,
  };
}

// ---------- First-run setup ----------

export interface SetupInput {
  shop: ShopProfile;
  owner: { username: string; displayName: string; secret: string };
}

export function completeSetup(env: AppEnv, input: SetupInput): SessionInfo {
  const secretHash = hashSecret(input.owner.secret);
  const ownerId = transact(env, SYSTEM_ACTOR, (tx) => {
    if (isSetupComplete(tx.db)) {
      throw new AppError(ErrorCodes.CONFLICT, 'Setup has already been completed.');
    }
    const ownerRole = tx.db.prepare('SELECT id FROM roles WHERE code = ?').get(OWNER_ROLE_CODE) as { id: number };
    const id = Number(
      tx.db
        .prepare(
          `INSERT INTO users (username, display_name, secret_hash, role_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.owner.username, input.owner.displayName, secretHash, ownerRole.id, tx.nowIso, tx.nowIso)
        .lastInsertRowid,
    );
    tx.actor = { userId: id, username: input.owner.username };
    updateSettingsSection(tx, 'shop', input.shop);
    const defaults = defaultSettings();
    for (const [section, value] of Object.entries(defaults)) {
      updateSettingsSection(tx, section as keyof typeof defaults, value);
    }
    tx.audit({
      module: 'users',
      entityType: 'user',
      entityId: id,
      action: 'CREATE',
      after: { username: input.owner.username, displayName: input.owner.displayName, role: OWNER_ROLE_CODE },
      reason: 'Initial setup',
    });
    tx.audit({ module: 'system', entityType: 'system', entityId: 'setup', action: 'SETUP_COMPLETED' });
    return id;
  });
  return buildSession(env.db, ownerId)!;
}

// ---------- Sign-in ----------

export function loginOptions(db: Db) {
  const users = db
    .prepare('SELECT username, display_name FROM users WHERE is_active = 1 ORDER BY display_name')
    .all() as { username: string; display_name: string }[];
  return { users: users.map((u) => ({ username: u.username, displayName: u.display_name })) };
}

export function login(env: AppEnv, username: string, secret: string): SessionInfo {
  const now = env.clock.now();
  const user = env.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRecord | undefined;
  const invalid = new AppError(ErrorCodes.UNAUTHENTICATED, 'Incorrect username or PIN/password.');

  if (!user || user.is_active !== 1) {
    transact(env, SYSTEM_ACTOR, (tx) =>
      tx.audit({ module: 'auth', entityType: 'user', action: 'LOGIN_FAILED', after: { username, reason: 'unknown or inactive user' } }),
    );
    throw invalid;
  }
  if (user.locked_until && new Date(user.locked_until) > now) {
    throw new AppError(
      ErrorCodes.ACCOUNT_LOCKED,
      `Too many incorrect attempts. Try again after ${new Date(user.locked_until).toLocaleTimeString('en-IN')}.`,
    );
  }

  const actor = { userId: user.id, username: user.username };
  if (!verifySecret(secret, user.secret_hash)) {
    transact(env, actor, (tx) => {
      const attempts = user.failed_attempts + 1;
      const lockedUntil =
        attempts >= MAX_FAILED_ATTEMPTS ? new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString() : null;
      tx.db
        .prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
        .run(lockedUntil ? 0 : attempts, lockedUntil, user.id);
      tx.audit({
        module: 'auth',
        entityType: 'user',
        entityId: user.id,
        action: lockedUntil ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED',
        after: { attempts },
      });
    });
    throw invalid;
  }

  transact(env, actor, (tx) => {
    tx.db
      .prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?')
      .run(tx.nowIso, user.id);
    tx.audit({ module: 'auth', entityType: 'user', entityId: user.id, action: 'LOGIN' });
  });
  return buildSession(env.db, user.id)!;
}

export function logout(env: AppEnv, actor: Actor): void {
  if (actor.userId === null) return;
  transact(env, actor, (tx) => tx.audit({ module: 'auth', entityType: 'user', entityId: actor.userId, action: 'LOGOUT' }));
}

export function changeOwnSecret(env: AppEnv, actor: Actor, currentSecret: string, newSecret: string): void {
  const user = env.db.prepare('SELECT * FROM users WHERE id = ?').get(actor.userId) as UserRecord | undefined;
  if (!user || !verifySecret(currentSecret, user.secret_hash)) {
    throw new AppError(ErrorCodes.VALIDATION, 'The current PIN/password is incorrect.');
  }
  const hash = hashSecret(newSecret);
  transact(env, actor, (tx) => {
    tx.db.prepare('UPDATE users SET secret_hash = ?, updated_at = ?, version = version + 1 WHERE id = ?').run(hash, tx.nowIso, user.id);
    tx.audit({ module: 'users', entityType: 'user', entityId: user.id, action: 'SECRET_CHANGED' });
  });
}

// ---------- User management ----------

export function listUsers(db: Db): UserRow[] {
  const users = db.prepare('SELECT * FROM users ORDER BY is_active DESC, display_name').all() as UserRecord[];
  return users.map((u) => toUserRow(db, u));
}

function countActiveOwners(db: Db, excludingUserId?: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.code = ? AND u.is_active = 1 AND u.id != ?`,
    )
    .get(OWNER_ROLE_CODE, excludingUserId ?? -1) as { n: number };
  return row.n;
}

export function createUser(
  env: AppEnv,
  actor: Actor,
  input: { username: string; displayName: string; roleId: number; secret: string },
): UserRow {
  const hash = hashSecret(input.secret);
  return transact(env, actor, (tx) => {
    getRole(tx.db, input.roleId);
    if (tx.db.prepare('SELECT 1 FROM users WHERE username = ?').get(input.username)) {
      throw new AppError(ErrorCodes.CONFLICT, `The username "${input.username}" is already taken.`);
    }
    const id = Number(
      tx.db
        .prepare(
          `INSERT INTO users (username, display_name, secret_hash, role_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.username, input.displayName, hash, input.roleId, tx.nowIso, tx.nowIso).lastInsertRowid,
    );
    const user = tx.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRecord;
    tx.audit({ module: 'users', entityType: 'user', entityId: id, action: 'CREATE', after: auditUser(user) });
    return toUserRow(tx.db, user);
  });
}

export function updateUser(
  env: AppEnv,
  actor: Actor,
  input: { id: number; displayName: string; roleId: number; isActive: boolean; version: number; reason?: string },
): UserRow {
  return transact(env, actor, (tx) => {
    const before = tx.db.prepare('SELECT * FROM users WHERE id = ?').get(input.id) as UserRecord | undefined;
    if (!before) throw new AppError(ErrorCodes.NOT_FOUND, 'User not found.');
    const newRole = getRole(tx.db, input.roleId);
    const wasOwner = getRole(tx.db, before.role_id).code === OWNER_ROLE_CODE && before.is_active === 1;
    const staysOwner = newRole.code === OWNER_ROLE_CODE && input.isActive;
    if (wasOwner && !staysOwner && countActiveOwners(tx.db, input.id) === 0) {
      throw new AppError(ErrorCodes.BUSINESS_RULE, 'At least one active owner account must remain.');
    }
    const result = tx.db
      .prepare(
        `UPDATE users SET display_name = ?, role_id = ?, is_active = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND version = ?`,
      )
      .run(input.displayName, input.roleId, input.isActive ? 1 : 0, tx.nowIso, input.id, input.version);
    tx.expectOneChange(result.changes, 'This user');
    const after = tx.db.prepare('SELECT * FROM users WHERE id = ?').get(input.id) as UserRecord;
    tx.audit({
      module: 'users',
      entityType: 'user',
      entityId: input.id,
      action: before.is_active === 1 && !input.isActive ? 'DEACTIVATE' : 'UPDATE',
      before: auditUser(before),
      after: auditUser(after),
      reason: input.reason ?? null,
    });
    return toUserRow(tx.db, after);
  });
}

export function resetUserSecret(env: AppEnv, actor: Actor, userId: number, newSecret: string, reason?: string): void {
  const hash = hashSecret(newSecret);
  transact(env, actor, (tx) => {
    const result = tx.db
      .prepare(
        `UPDATE users SET secret_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ?,
           version = version + 1 WHERE id = ?`,
      )
      .run(hash, tx.nowIso, userId);
    tx.expectOneChange(result.changes, 'This user');
    tx.audit({ module: 'users', entityType: 'user', entityId: userId, action: 'SECRET_RESET', reason: reason ?? null });
  });
}

// ---------- Roles ----------

export function listRoles(db: Db): RoleRow[] {
  const roles = db.prepare('SELECT * FROM roles ORDER BY id').all() as RoleRecord[];
  return roles.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    isSystem: r.is_system === 1,
    maxDiscountBp: r.max_discount_bp,
    permissions: permissionsForRole(db, r),
    version: r.version,
  }));
}

export function updateRole(
  env: AppEnv,
  actor: Actor,
  input: { id: number; permissions: Permission[]; maxDiscountBp: number; version: number; reason?: string },
): RoleRow {
  return transact(env, actor, (tx) => {
    const role = getRole(tx.db, input.id);
    if (role.code === OWNER_ROLE_CODE) {
      throw new AppError(ErrorCodes.BUSINESS_RULE, 'The owner role always has every permission and cannot be changed.');
    }
    const before = { permissions: permissionsForRole(tx.db, role), maxDiscountBp: role.max_discount_bp };
    const result = tx.db
      .prepare('UPDATE roles SET max_discount_bp = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
      .run(input.maxDiscountBp, tx.nowIso, input.id, input.version);
    tx.expectOneChange(result.changes, 'This role');
    tx.db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(input.id);
    const insert = tx.db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)');
    const unique = [...new Set(input.permissions)].sort();
    for (const p of unique) insert.run(input.id, p);
    tx.audit({
      module: 'users',
      entityType: 'role',
      entityId: input.id,
      action: 'PERMISSIONS_CHANGED',
      before,
      after: { permissions: unique, maxDiscountBp: input.maxDiscountBp },
      reason: input.reason ?? null,
    });
    return listRoles(tx.db).find((r) => r.id === input.id)!;
  });
}

/** Records a refused action so attempts to exceed one's permissions are visible in the history. */
export function recordDenied(env: AppEnv, actor: Actor, command: string, permission: string): void {
  transact(env, actor, (tx) =>
    tx.audit({ module: 'auth', entityType: 'command', entityId: command, action: 'DENIED', after: { permission } }),
  );
}
