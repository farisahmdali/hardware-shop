import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDispatcher } from '@main/ipc/dispatcher';
import { systemHandlers, type DesktopUi } from '@main/ipc/systemHandlers';
import { buildSession, createUser, listRoles } from '@main/services/auth';
import { listAudit } from '@main/services/audit';
import type { Result } from '@shared/errors';
import { actorOf, createTestEnv, SHOP, type TestEnv } from '../helpers';

let env: TestEnv;
let sessions: Map<number, number>;
let dispatch: ReturnType<typeof createDispatcher>;

const ui: DesktopUi = {
  chooseFolder: async () => null,
  chooseFile: async () => null,
  chooseSaveFile: async () => null,
  openPath: async () => undefined,
};

beforeEach(() => {
  env = createTestEnv();
  sessions = new Map();
  dispatch = createDispatcher({
    env,
    handlers: systemHandlers(ui, { isPackaged: false, startupWarnings: () => [] }),
    getSession: (id) => (sessions.has(id) ? buildSession(env.db, sessions.get(id)!) : null),
    setSessionUser: (id, userId) => (userId === null ? sessions.delete(id) : sessions.set(id, userId)),
  });
});
afterEach(() => env.cleanup());

const WINDOW = 1;
const ok = <T>(r: Result<unknown>) => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data as T;
};

async function setup() {
  return ok(
    await dispatch(WINDOW, 'setup.complete', {
      shop: SHOP,
      owner: { username: 'owner', displayName: 'Ravi Sharma', secret: '4321' },
    }),
  );
}

describe('IPC dispatcher', () => {
  it('rejects unknown commands', async () => {
    const r = await dispatch(WINDOW, 'db.exec', { sql: 'DROP TABLE users' });
    expect(r).toMatchObject({ ok: false, error: { code: 'UNKNOWN_COMMAND' } });
  });

  it('validates input before running a command', async () => {
    const r = await dispatch(WINDOW, 'setup.complete', { shop: { name: '' }, owner: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION');
  });

  it('requires a session for protected commands', async () => {
    const r = await dispatch(WINDOW, 'settings.get', {});
    expect(r).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
  });

  it('signs the window in after setup and keeps sessions per window', async () => {
    await setup();
    expect(ok<{ shop: { name: string } }>(await dispatch(WINDOW, 'settings.get', {})).shop.name).toBe(SHOP.name);
    expect((await dispatch(2, 'settings.get', {})).ok).toBe(false);
  });

  it('refuses commands the role does not allow and records the attempt', async () => {
    const owner = await setup();
    const sales = listRoles(env.db).find((r) => r.code === 'SALES')!;
    const amit = createUser(env, actorOf(owner as never), { username: 'amit', displayName: 'Amit', roleId: sales.id, secret: '1111' });
    ok(await dispatch(WINDOW, 'auth.logout', {}));
    ok(await dispatch(WINDOW, 'auth.login', { username: 'amit', secret: '1111' }));

    const r = await dispatch(WINDOW, 'settings.update', { section: 'tax', value: { gstRegistered: false } });
    expect(r).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    const denied = listAudit(env.db, { page: 1, pageSize: 5, action: 'DENIED' }).rows[0]!;
    expect(denied.userId).toBe(amit.id);
    expect(denied.entityId).toBe('settings.update');

    // Sales staff may still create backups.
    expect((await dispatch(WINDOW, 'backup.create', {})).ok).toBe(true);
  });

  it('refuses a renderer-supplied backup folder path', async () => {
    await setup();
    const settings = ok<{ backup: Record<string, unknown> }>(await dispatch(WINDOW, 'settings.get', {}));
    const r = await dispatch(WINDOW, 'settings.update', {
      section: 'backup',
      value: { ...settings.backup, folder: 'C:\\Windows\\System32' },
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });

  it('drops the session of a user who was deactivated', async () => {
    const owner = await setup();
    const sales = listRoles(env.db).find((r) => r.code === 'SALES')!;
    const amit = createUser(env, actorOf(owner as never), { username: 'amit', displayName: 'Amit', roleId: sales.id, secret: '1111' });
    ok(await dispatch(2, 'auth.login', { username: 'amit', secret: '1111' }));
    ok(await dispatch(WINDOW, 'users.update', { id: amit.id, displayName: 'Amit', roleId: sales.id, isActive: false, version: amit.version }));
    expect(await dispatch(2, 'settings.get', {})).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
  });

  it('signs in automatically as the owner when the login screen is switched off', async () => {
    await setup();
    const settings = ok<{ app: Record<string, unknown> }>(await dispatch(WINDOW, 'settings.get', {}));
    ok(await dispatch(WINDOW, 'settings.update', { section: 'app', value: { ...settings.app, requireLogin: false } }));
    const session = ok<{ user: { roleCode: string } } | null>(await dispatch(3, 'auth.session', {}));
    expect(session?.user.roleCode).toBe('OWNER');
  });
});
