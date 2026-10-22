import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSession,
  completeSetup,
  createUser,
  isSetupComplete,
  listRoles,
  login,
  updateRole,
  updateUser,
  verifySecret,
  hashSecret,
} from '@main/services/auth';
import { listAudit } from '@main/services/audit';
import { getAllSettings } from '@main/services/settings';
import { ALL_PERMISSIONS } from '@shared/permissions';
import { actorOf, createTestEnv, SHOP, setupOwner, type TestEnv } from '../helpers';

let env: TestEnv;
beforeEach(() => {
  env = createTestEnv();
});
afterEach(() => env.cleanup());

describe('first-run setup', () => {
  it('creates the owner, shop profile and default settings once', () => {
    expect(isSetupComplete(env.db)).toBe(false);
    const session = setupOwner(env);
    expect(isSetupComplete(env.db)).toBe(true);
    expect(session.user.roleCode).toBe('OWNER');
    expect(session.permissions).toEqual(ALL_PERMISSIONS);
    const settings = getAllSettings(env.db);
    expect(settings.shop.name).toBe(SHOP.name);
    expect(settings.tax.pricesIncludeTax).toBe(true);
    expect(settings.backup.intervalHours).toBe(4);
    const setupAudit = listAudit(env.db, { page: 1, pageSize: 50, action: 'SETUP_COMPLETED' }).rows[0]!;
    expect(setupAudit.userId).toBe(session.user.id);
    expect(() =>
      completeSetup(env, { shop: SHOP, owner: { username: 'other', displayName: 'Other', secret: '9999' } }),
    ).toThrow(/already been completed/);
  });
});

describe('sign-in', () => {
  it('hashes secrets with a random salt', () => {
    const a = hashSecret('4321');
    expect(a).not.toBe(hashSecret('4321'));
    expect(verifySecret('4321', a)).toBe(true);
    expect(verifySecret('4322', a)).toBe(false);
  });

  it('accepts the right PIN and audits the login', () => {
    setupOwner(env);
    const session = login(env, 'OWNER', '4321');
    expect(session.user.username).toBe('owner');
    expect(listAudit(env.db, { page: 1, pageSize: 5, action: 'LOGIN' }).total).toBe(1);
  });

  it('locks the account after five wrong attempts', () => {
    setupOwner(env);
    for (let i = 0; i < 4; i++) expect(() => login(env, 'owner', '0000')).toThrow(/Incorrect/);
    expect(() => login(env, 'owner', '0000')).toThrow(/Incorrect/);
    expect(() => login(env, 'owner', '4321')).toThrow(/Too many/);
    expect(listAudit(env.db, { page: 1, pageSize: 5, action: 'ACCOUNT_LOCKED' }).total).toBe(1);
    env.clock.advanceMinutes(6);
    expect(login(env, 'owner', '4321').user.username).toBe('owner');
  });

  it('rejects unknown and deactivated users', () => {
    const owner = setupOwner(env);
    const sales = listRoles(env.db).find((r) => r.code === 'SALES')!;
    const user = createUser(env, actorOf(owner), { username: 'amit', displayName: 'Amit', roleId: sales.id, secret: '1111' });
    expect(login(env, 'amit', '1111').user.roleCode).toBe('SALES');
    updateUser(env, actorOf(owner), { id: user.id, displayName: 'Amit', roleId: sales.id, isActive: false, version: user.version });
    expect(() => login(env, 'amit', '1111')).toThrow(/Incorrect/);
    expect(() => login(env, 'nobody', '1111')).toThrow(/Incorrect/);
    expect(buildSession(env.db, user.id)).toBeNull();
  });
});

describe('users and roles', () => {
  it('keeps at least one active owner', () => {
    const owner = setupOwner(env);
    const manager = listRoles(env.db).find((r) => r.code === 'MANAGER')!;
    expect(() =>
      updateUser(env, actorOf(owner), { id: owner.user.id, displayName: 'Ravi', roleId: manager.id, isActive: true, version: 1 }),
    ).toThrow(/active owner/);
  });

  it('detects concurrent edits with the version number', () => {
    const owner = setupOwner(env);
    const sales = listRoles(env.db).find((r) => r.code === 'SALES')!;
    const user = createUser(env, actorOf(owner), { username: 'amit', displayName: 'Amit', roleId: sales.id, secret: '1111' });
    updateUser(env, actorOf(owner), { id: user.id, displayName: 'Amit K', roleId: sales.id, isActive: true, version: user.version });
    expect(() =>
      updateUser(env, actorOf(owner), { id: user.id, displayName: 'Amit X', roleId: sales.id, isActive: true, version: user.version }),
    ).toThrow(/changed by someone else/);
  });

  it('applies role permission changes to the next session and audits them', () => {
    const owner = setupOwner(env);
    const sales = listRoles(env.db).find((r) => r.code === 'SALES')!;
    const user = createUser(env, actorOf(owner), { username: 'amit', displayName: 'Amit', roleId: sales.id, secret: '1111' });
    expect(buildSession(env.db, user.id)!.permissions).not.toContain('sales.cancel');
    updateRole(env, actorOf(owner), {
      id: sales.id,
      permissions: [...sales.permissions, 'sales.cancel'],
      maxDiscountBp: 1000,
      version: sales.version,
      reason: 'Senior counter staff',
    });
    const session = buildSession(env.db, user.id)!;
    expect(session.permissions).toContain('sales.cancel');
    expect(session.maxDiscountBp).toBe(1000);
    const entry = listAudit(env.db, { page: 1, pageSize: 5, action: 'PERMISSIONS_CHANGED' }).rows[0]!;
    expect((entry.before as { permissions: string[] }).permissions).not.toContain('sales.cancel');
    expect((entry.after as { permissions: string[] }).permissions).toContain('sales.cancel');
  });

  it('does not allow editing the owner role', () => {
    const owner = setupOwner(env);
    const ownerRole = listRoles(env.db).find((r) => r.code === 'OWNER')!;
    expect(() =>
      updateRole(env, actorOf(owner), { id: ownerRole.id, permissions: [], maxDiscountBp: 0, version: ownerRole.version }),
    ).toThrow(/owner role/);
  });
});
