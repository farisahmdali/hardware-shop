import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION, schemaVersion } from '@main/db/migrator';
import { transact } from '@main/db/tx';
import { createDispatcher, type HandlerMap } from '@main/ipc/dispatcher';
import { systemHandlers, type DesktopUi } from '@main/ipc/systemHandlers';
import { inventoryHandlers } from '@main/ipc/inventoryHandlers';
import { salesHandlers } from '@main/ipc/salesHandlers';
import { rentalHandlers } from '@main/ipc/rentalHandlers';
import { purchaseHandlers } from '@main/ipc/purchaseHandlers';
import { expenseHandlers } from '@main/ipc/expenseHandlers';
import { reportHandlers } from '@main/ipc/reportHandlers';
import { historyAsReport, historyHandlers } from '@main/ipc/historyHandlers';
import { inProcessRunner } from '@main/reports/runner';
import { auditFacets, auditForExport, listAudit } from '@main/services/audit';
import { buildSession, completeSetup, createUser, listRoles } from '@main/services/auth';
import { createBackup, listBackups, pruneBackups, recoverInterruptedRestore, restoreBackup } from '@main/services/backup';
import { startBackupScheduler } from '@main/services/backupSchedule';
import { createCustomer } from '@main/services/customers';
import { runIntegrityChecks } from '@main/services/integrity';
import { listPaymentMethods, receivePayment } from '@main/services/payments';
import { createProduct, updateProduct } from '@main/services/products';
import { getAllSettings, updateSettingsSection } from '@main/services/settings';
import { silentLogger } from '@main/services/env';
import { describeChanges } from '@shared/auditFormat';
import { contract, type SessionInfo } from '@shared/contracts';
import type { Result } from '@shared/errors';
import { actorOf, createTestEnv, openDatabaseAtVersion, setupOwner, SHOP, type TestEnv } from '../helpers';

let env: TestEnv;
beforeEach(() => {
  env = createTestEnv();
});
afterEach(() => env.cleanup());

const noHooks = { beforeSwap: async () => {} };
const unitId = (code: string) => (env.db.prepare('SELECT id FROM units WHERE code = ?').get(code) as { id: number }).id;
const productNames = () => (env.db.prepare('SELECT name FROM products ORDER BY id').all() as { name: string }[]).map((r) => r.name);

function newProduct(owner: SessionInfo, name: string) {
  return createProduct(
    env,
    actorOf(owner),
    {
      requestId: randomUUID(),
      sku: '',
      name,
      categoryId: null,
      brandId: null,
      unitId: unitId('PCS'),
      description: '',
      hsnCode: '8205',
      gstRateBp: 1800,
      priceIncludesTax: true,
      purchasePrice: 31000,
      sellingPrice: 45000,
      minStockQty: 0,
      preferredSupplierId: null,
      notes: '',
      openingQty: 0,
    },
    true,
  );
}

function setBackupSettings(owner: SessionInfo, change: Partial<ReturnType<typeof getAllSettings>['backup']>) {
  transact(env, actorOf(owner), (tx) => updateSettingsSection(tx, 'backup', { ...getAllSettings(env.db).backup, ...change }));
}

/** A shop database as an older release left it: every migration except the newest. */
function olderVersionDatabase(path: string, shopName: string, version = LATEST_SCHEMA_VERSION - 1): void {
  const db = openDatabaseAtVersion(path, version);
  completeSetup({ ...env, db }, { shop: { ...SHOP, name: shopName }, owner: { username: 'owner', displayName: 'Ravi Sharma', secret: '4321' } });
  db.close();
}

describe('restoring a backup', () => {
  it('brings back the data as it was, keeps a copy of what it replaced, and records the restore', async () => {
    const owner = setupOwner(env);
    newProduct(owner, 'Claw hammer');
    const backup = await createBackup(env, actorOf(owner), 'MANUAL');
    env.clock.advanceMinutes(30);
    newProduct(owner, 'Spirit level');

    let swapped = false;
    const summary = await restoreBackup(env, actorOf(owner), backup.filePath, { beforeSwap: async () => void (swapped = true) });
    expect(swapped).toBe(true);
    expect(summary).toMatchObject({ restoredFrom: backup.filePath, migrationsApplied: [], issues: [] });
    expect(productNames()).toEqual(['Claw hammer']);

    // The data that was replaced is kept in a verified backup, listed in the restored history
    // together with the backup that was restored (made after its own snapshot was taken).
    const backups = listBackups(env);
    const pre = backups.find((b) => b.kind === 'PRE_RESTORE')!;
    expect(pre.filePath).toBe(summary.preRestoreBackup);
    expect(backups.some((b) => b.fileName === backup.fileName)).toBe(true);
    const replaced = new Database(pre.filePath, { readonly: true });
    expect(replaced.prepare("SELECT COUNT(*) AS n FROM products WHERE name = 'Spirit level'").get()).toEqual({ n: 1 });
    replaced.close();

    const entry = listAudit(env.db, { page: 1, pageSize: 5, action: 'BACKUP_RESTORED' }).rows[0]!;
    expect(entry.userId).toBe(owner.user.id);
    expect(entry.after).toMatchObject({ fileName: backup.fileName, preRestoreBackup: pre.fileName, migrationsApplied: [] });
    // The history of the restored data is intact, and the shop can carry on working.
    expect(listAudit(env.db, { page: 1, pageSize: 5, action: 'SETUP_COMPLETED' }).total).toBe(1);
    newProduct(owner, 'Spirit level');
    expect(runIntegrityChecks(env.db).issues).toEqual([]);
    for (const leftover of ['.before-restore', '.restoring']) expect(existsSync(env.paths.databasePath + leftover)).toBe(false);
  });

  it('refuses a damaged backup, records the attempt, and leaves the data untouched', async () => {
    const owner = setupOwner(env);
    newProduct(owner, 'Claw hammer');
    const backup = await createBackup(env, actorOf(owner), 'MANUAL');
    const bytes = readFileSync(backup.filePath);
    for (let i = 4096; i < bytes.length; i += 97) bytes[i] = 0xff;
    const corrupt = join(env.dir, 'damaged.db');
    writeFileSync(corrupt, bytes);
    const backupsBefore = listBackups(env).length;

    let swapped = false;
    await expect(restoreBackup(env, actorOf(owner), corrupt, { beforeSwap: async () => void (swapped = true) })).rejects.toMatchObject({ code: 'BACKUP_INVALID' });
    expect(swapped).toBe(false);
    expect(listBackups(env)).toHaveLength(backupsBefore); // no copy taken; nothing was about to change
    expect(productNames()).toEqual(['Claw hammer']);
    expect(listAudit(env.db, { page: 1, pageSize: 5, action: 'RESTORE_FAILED' }).rows[0]!.after).toMatchObject({ fileName: 'damaged.db' });
  });

  it('upgrades a backup made by an older version of the application', async () => {
    const owner = setupOwner(env);
    const old = join(env.dir, 'older.db');
    olderVersionDatabase(old, 'Sharma Hardware (old copy)');

    const summary = await restoreBackup(env, actorOf(owner), old, noHooks);
    expect(summary.migrationsApplied).toEqual([LATEST_SCHEMA_VERSION]);
    expect(schemaVersion(env.db)).toBe(LATEST_SCHEMA_VERSION);
    expect(getAllSettings(env.db).shop.name).toBe('Sharma Hardware (old copy)');
    expect(listAudit(env.db, { page: 1, pageSize: 5, action: 'BACKUP_RESTORED' }).rows[0]!.after).toMatchObject({ schemaVersion: LATEST_SCHEMA_VERSION - 1 });
    expect(runIntegrityChecks(env.db).issues).toEqual([]);
  });

  it('puts the current data back when the restored file cannot be upgraded', async () => {
    const owner = setupOwner(env);
    newProduct(owner, 'Claw hammer');
    // A version-6 file whose next upgrade (007, which adds backup_history.removed_at) cannot apply,
    // because the column is already there.
    const broken = join(env.dir, 'cannot-upgrade.db');
    olderVersionDatabase(broken, 'Other shop', 6);
    const db = new Database(broken);
    db.exec('ALTER TABLE backup_history ADD COLUMN removed_at TEXT');
    db.close();

    await expect(restoreBackup(env, actorOf(owner), broken, noHooks)).rejects.toThrow(/put back unchanged/);
    expect(env.db.open).toBe(true);
    expect(productNames()).toEqual(['Claw hammer']);
    expect(getAllSettings(env.db).shop.name).toBe(SHOP.name);
    expect(listAudit(env.db, { page: 1, pageSize: 5, action: 'RESTORE_FAILED' }).total).toBe(1);
    expect(listBackups(env).some((b) => b.kind === 'PRE_RESTORE')).toBe(true);
    for (const leftover of ['.before-restore', '.restoring']) expect(existsSync(env.paths.databasePath + leftover)).toBe(false);
    expect(runIntegrityChecks(env.db).issues).toEqual([]);
  });

  it('records who restored, without linking to a user the restored data does not have', async () => {
    const owner = setupOwner(env);
    const backup = await createBackup(env, actorOf(owner), 'MANUAL');
    const ownerRole = listRoles(env.db).find((r) => r.code === 'OWNER')!;
    const priya = createUser(env, actorOf(owner), { username: 'priya', displayName: 'Priya', roleId: ownerRole.id, secret: '2222' });

    await restoreBackup(env, { userId: priya.id, username: 'priya' }, backup.filePath, noHooks);
    const entry = listAudit(env.db, { page: 1, pageSize: 5, action: 'BACKUP_RESTORED' }).rows[0]!;
    expect(entry).toMatchObject({ userId: null, username: 'priya' });
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'priya'").get()).toEqual({ n: 0 });
  });

  it('undoes a restore the application did not finish', async () => {
    const dir = join(env.dir, 'interrupted');
    mkdirSync(dir);
    const dbPath = join(dir, 'shop.db');

    // Stopped between moving the current file aside and moving the restored one in.
    writeFileSync(`${dbPath}.before-restore`, 'original');
    writeFileSync(`${dbPath}.restoring`, 'half copied');
    await recoverInterruptedRestore(dbPath, silentLogger);
    expect(readFileSync(dbPath, 'utf8')).toBe('original');

    // Stopped after the restored file was in place but before the restore was recorded.
    writeFileSync(`${dbPath}.before-restore`, 'original');
    writeFileSync(dbPath, 'restored, not recorded');
    await recoverInterruptedRestore(dbPath, silentLogger);
    expect(readFileSync(dbPath, 'utf8')).toBe('original');
    for (const leftover of ['.before-restore', '.restoring']) expect(existsSync(dbPath + leftover)).toBe(false);

    // Nothing to do after a clean shutdown.
    await recoverInterruptedRestore(dbPath, silentLogger);
    expect(readFileSync(dbPath, 'utf8')).toBe('original');
  });
});

describe('automatic backups', () => {
  it('removes automatic backups the retention policy no longer needs, and records it', async () => {
    const owner = setupOwner(env);
    setBackupSettings(owner, { keepAutoCount: 3, keepDailyDays: 7 });
    const manual = await createBackup(env, actorOf(owner), 'MANUAL');
    const autos = [];
    for (let i = 0; i < 3; i++) {
      env.clock.advanceMinutes(60);
      autos.push(await createBackup(env, actorOf(owner), 'AUTO'));
    }
    env.clock.advanceMinutes(20 * 24 * 60);
    for (let i = 0; i < 4; i++) {
      env.clock.advanceMinutes(60);
      autos.push(await createBackup(env, actorOf(owner), 'AUTO'));
    }

    // Kept: the 3 newest, which include the newest of today; older days are past the 7-day window.
    const removed = await pruneBackups(env, actorOf(owner));
    expect(removed.sort()).toEqual([autos[0]!, autos[1]!, autos[2]!, autos[3]!].map((b) => b.fileName).sort());
    for (const b of autos.slice(0, 4)) {
      expect(existsSync(b.filePath)).toBe(false);
      expect(existsSync(b.filePath.replace(/\.db$/, '.json'))).toBe(false);
    }
    for (const b of [manual, ...autos.slice(4)]) expect(existsSync(b.filePath)).toBe(true);

    const history = listBackups(env);
    const gone = history.filter((b) => b.removedAt);
    expect(gone).toHaveLength(4);
    expect(gone[0]!.removedReason).toMatch(/retention/);
    expect(listAudit(env.db, { page: 1, pageSize: 5, action: 'BACKUP_PRUNED' }).rows[0]!.after).toMatchObject({ count: 4 });

    expect(await pruneBackups(env, actorOf(owner))).toEqual([]);
    expect(listAudit(env.db, { page: 1, pageSize: 5, action: 'BACKUP_PRUNED' }).total).toBe(1);
  });

  it('takes a backup when one is due, and not while switched off or during a restore', async () => {
    const owner = setupOwner(env);
    let paused = false;
    const scheduler = startBackupScheduler(env, { firstCheckMs: 3_600_000, isPaused: () => paused });
    const autoCount = () => listBackups(env).filter((b) => b.kind === 'AUTO' && b.status === 'OK').length;
    try {
      await scheduler.check();
      expect(autoCount()).toBe(1);
      env.clock.advanceMinutes(60);
      await scheduler.check();
      expect(autoCount()).toBe(1);
      env.clock.advanceMinutes(180);
      paused = true;
      await scheduler.check();
      expect(autoCount()).toBe(1);
      paused = false;
      await scheduler.check();
      expect(autoCount()).toBe(2);

      setBackupSettings(owner, { autoEnabled: false });
      env.clock.advanceMinutes(24 * 60);
      await scheduler.check();
      expect(autoCount()).toBe(2);
    } finally {
      scheduler.stop();
    }
  });
});

describe('history search and filters', () => {
  it('finds entries by product name or code, by record (including linked entries), by transaction and by user', () => {
    const owner = setupOwner(env);
    const actor = actorOf(owner);
    const hammer = newProduct(owner, 'Claw hammer 450 g');
    newProduct(owner, 'Spirit level');
    updateProduct(env, actor, { ...hammer, purchasePrice: hammer.purchasePrice ?? 0, sellingPrice: 48000, reason: 'Supplier price rise' }, true);
    const ramesh = createCustomer(env, actor, {
      requestId: randomUUID(),
      name: 'Ramesh Patil',
      phone: '9822012345',
      address: '',
      businessName: '',
      gstin: '',
      stateCode: '27',
      creditDays: 15,
      creditLimit: 0,
      notes: '',
      openingBalance: 0,
    });
    const cash = listPaymentMethods(env.db, false).find((m) => m.kind === 'CASH')!.id;
    receivePayment(env, actor, { requestId: randomUUID(), customerId: ramesh.id, amount: 50000, methodId: cash, reference: '', notes: 'Advance', allocations: [] });

    const about = (rows: { entityType: string; entityId: string | null; action: string }[], type: string, id: number) =>
      rows.filter((r) => r.entityType === type && r.entityId === String(id)).map((r) => r.action);
    const byName = listAudit(env.db, { page: 1, pageSize: 50, search: 'claw HAMMER' }).rows;
    expect(about(byName, 'product', hammer.id)).toEqual(expect.arrayContaining(['CREATE', 'PRICE_CHANGE']));
    expect(byName.some((r) => r.after && JSON.stringify(r.after).includes('Spirit level'))).toBe(false);
    expect(about(listAudit(env.db, { page: 1, pageSize: 50, search: hammer.sku }).rows, 'product', hammer.id)).toContain('PRICE_CHANGE');
    expect(listAudit(env.db, { page: 1, pageSize: 50, search: 'Supplier price rise' }).total).toBe(1);

    // A customer's history includes payments linked to them.
    const customerHistory = listAudit(env.db, { page: 1, pageSize: 50, record: { type: 'customer', id: String(ramesh.id) } }).rows;
    expect(customerHistory.map((r) => r.entityType)).toEqual(expect.arrayContaining(['customer', 'payment']));
    // Searching the phone number finds the same entries.
    expect(listAudit(env.db, { page: 1, pageSize: 50, search: '98220' }).total).toBe(customerHistory.length);

    const payment = customerHistory.find((r) => r.entityType === 'payment')!;
    const sameTxn = listAudit(env.db, { page: 1, pageSize: 50, txnRef: payment.txnRef! }).rows;
    expect(sameTxn.length).toBeGreaterThan(0);
    expect(sameTxn.every((r) => r.txnRef === payment.txnRef)).toBe(true);

    const all = listAudit(env.db, { page: 1, pageSize: 1 }).total;
    expect(listAudit(env.db, { page: 1, pageSize: 1, userId: owner.user.id }).total).toBe(all);
    expect(auditFacets(env.db).users).toEqual([{ id: owner.user.id, name: 'Ravi Sharma', username: 'owner' }]);
  });

  it('exports the newest entries in time order, with readable changes', () => {
    const owner = setupOwner(env);
    const hammer = newProduct(owner, 'Claw hammer');
    updateProduct(env, actorOf(owner), { ...hammer, purchasePrice: hammer.purchasePrice ?? 0, sellingPrice: 48000 }, true);

    const total = listAudit(env.db, { page: 1, pageSize: 1 }).total;
    const { rows, truncated } = auditForExport(env.db, {}, 2);
    expect(truncated).toBe(total > 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBeLessThan(rows[1]!.id);
    expect(rows[1]!.id).toBe(listAudit(env.db, { page: 1, pageSize: 1 }).rows[0]!.id);

    const update = auditForExport(env.db, { action: 'PRICE_CHANGE', entityType: 'product' }, 100).rows;
    const report = historyAsReport(update, false, 'All dates', env.clock.now().toISOString());
    expect(report.rows[0]!.cells).toMatchObject({ user: 'owner', module: 'Products', action: 'Price change' });
    expect(report.rows[0]!.cells.changes).toMatch(/Selling price: ₹450\.00 → ₹480\.00/);
    expect(describeChanges({ name: 'A', isActive: true }, { name: 'A', isActive: false })).toBe('Active: Yes → No');
  });
});

describe('permissions', () => {
  const ui: DesktopUi = { chooseFolder: async () => null, chooseFile: async () => null, chooseSaveFile: async () => null, openPath: async () => undefined };
  const printer = { toPdf: async () => Buffer.from(''), print: async () => false };
  const allHandlers = (): HandlerMap => ({
    ...systemHandlers(ui, { isPackaged: false, startupWarnings: () => [] }),
    ...inventoryHandlers(ui, { isPackaged: false }),
    ...salesHandlers(ui, printer),
    ...rentalHandlers(),
    ...purchaseHandlers(),
    ...expenseHandlers(),
    ...historyHandlers(ui, printer),
    ...reportHandlers(ui, printer, inProcessRunner(() => env.db)),
  });

  const PUBLIC = ['app.status', 'setup.complete', 'setup.restoreChoose', 'setup.restore', 'auth.session', 'auth.loginOptions', 'auth.login'];
  // Commands open to every signed-in user. Most only read; those that can show cost, purchasing,
  // expense or financial figures check the user's permissions inside the command.
  const SIGNED_IN = [
    'auth.logout', 'auth.changeSecret', 'settings.get', 'catalog.get', 'paymentMethods.list',
    'products.list', 'products.get', 'products.export', 'stock.movements', 'stock.summary',
    'customers.list', 'customers.get', 'customers.ledger',
    'sales.summary', 'invoices.list', 'invoices.get', 'payments.get', 'payments.list',
    'receivables.list', 'receivables.ageing', 'receivables.summary',
    'print.render', 'print.pdf', 'print.send',
    'rentalProducts.list', 'rentalProducts.get', 'rentalAssets.list', 'rentalAssets.history',
    'rentals.available', 'rentals.quote', 'rentals.extendQuote', 'rentals.returnQuote', 'rentals.list', 'rentals.get', 'rentals.summary',
    'suppliers.list', 'suppliers.get', 'suppliers.ledger', 'purchases.list', 'purchases.get', 'supplierPayments.list',
    'payables.list', 'payables.ageing', 'payables.summary', 'expenses.summary',
    'reports.run', 'reports.export', 'reports.print', 'dashboard.period', 'dashboard.recent',
  ];

  let sessions: Map<number, number>;
  let handlers: HandlerMap;
  let dispatch: ReturnType<typeof createDispatcher>;
  beforeEach(() => {
    sessions = new Map();
    handlers = allHandlers();
    dispatch = createDispatcher({
      env,
      handlers,
      getSession: (id) => (sessions.has(id) ? buildSession(env.db, sessions.get(id)!) : null),
      setSessionUser: (id, userId) => (userId === null ? sessions.delete(id) : sessions.set(id, userId)),
    });
  });
  const access = (name: string) => (handlers as Record<string, { access: string }>)[name]!.access;
  const errorCode = (r: Result<unknown>) => (r.ok ? 'OK' : r.error.code);
  const denials = () => listAudit(env.db, { page: 1, pageSize: 1, action: 'DENIED' }).total;

  it('has a handler for every command, and only the expected commands are open', () => {
    expect(Object.keys(contract).filter((k) => !(k in handlers))).toEqual([]);
    expect(Object.keys(handlers).filter((k) => !(k in contract))).toEqual([]);
    const names = Object.keys(contract);
    expect(names.filter((k) => access(k) === 'public').sort()).toEqual([...PUBLIC].sort());
    expect(names.filter((k) => access(k) === 'authenticated').sort()).toEqual([...SIGNED_IN].sort());
  });

  it('refuses every protected command without a session', async () => {
    for (const name of Object.keys(contract).filter((k) => access(k) !== 'public')) {
      expect([name, errorCode(await dispatch(9, name, {}))]).toEqual([name, 'UNAUTHENTICATED']);
    }
  });

  it('refuses and records every command a sales employee is not allowed', async () => {
    const owner = setupOwner(env);
    const salesRole = listRoles(env.db).find((r) => r.code === 'SALES')!;
    createUser(env, actorOf(owner), { username: 'amit', displayName: 'Amit', roleId: salesRole.id, secret: '1111' });
    const WINDOW = 2;
    expect((await dispatch(WINDOW, 'auth.login', { username: 'amit', secret: '1111' })).ok).toBe(true);
    const allowed = buildSession(env.db, sessions.get(WINDOW)!)!.permissions as string[];

    const gated = Object.keys(contract).filter((k) => !['public', 'authenticated'].includes(access(k)) && !allowed.includes(access(k)));
    expect(gated).toEqual(expect.arrayContaining(['backup.restore', 'audit.list', 'users.create', 'settings.update', 'invoices.cancel', 'purchases.create']));
    const before = denials();
    for (const name of gated) {
      expect([name, errorCode(await dispatch(WINDOW, name, {}))]).toEqual([name, 'PERMISSION_DENIED']);
    }
    expect(denials() - before).toBe(gated.length);

    // Checks made inside a command are recorded the same way.
    expect(errorCode(await dispatch(WINDOW, 'purchases.list', { page: 1, pageSize: 20 }))).toBe('PERMISSION_DENIED');
    const entry = listAudit(env.db, { page: 1, pageSize: 1, action: 'DENIED' }).rows[0]!;
    expect(entry).toMatchObject({ username: 'amit', entityId: 'purchases.list' });
  });

  it('sets a new installation up from a backup, but never restores over a set-up shop without signing in', async () => {
    // The old computer's backup.
    const old = createTestEnv();
    const oldOwner = setupOwner(old);
    createProduct(old, actorOf(oldOwner), {
      requestId: randomUUID(), sku: '', name: 'Claw hammer', categoryId: null, brandId: null,
      unitId: (old.db.prepare("SELECT id FROM units WHERE code = 'PCS'").get() as { id: number }).id,
      description: '', hsnCode: '8205', gstRateBp: 1800, priceIncludesTax: true, purchasePrice: 31000, sellingPrice: 45000,
      minStockQty: 0, preferredSupplierId: null, notes: '', openingQty: 0,
    }, true);
    const backup = await createBackup(old, actorOf(oldOwner), 'MANUAL');
    const picking = createDispatcher({
      env,
      handlers: systemHandlers({ ...ui, chooseFile: async () => backup.filePath }, { isPackaged: false, startupWarnings: () => [] }),
      getSession: (id) => (sessions.has(id) ? buildSession(env.db, sessions.get(id)!) : null),
      setSessionUser: (id, userId) => (userId === null ? sessions.delete(id) : sessions.set(id, userId)),
    });
    try {
      // The new computer, before setup.
      const offer = await picking(5, 'setup.restoreChoose', {});
      if (!offer.ok) throw new Error(offer.error.message);
      const { token } = offer.data as { token: string };
      expect((await picking(5, 'setup.restore', { token, confirm: 'RESTORE' })).ok).toBe(true);
      expect(productNames()).toEqual(['Claw hammer']);
      expect(listAudit(env.db, { page: 1, pageSize: 1, action: 'BACKUP_RESTORED' }).rows[0]).toMatchObject({ userId: null });
      expect(runIntegrityChecks(env.db).issues).toEqual([]);

      // Once the shop is set up, restoring without signing in is refused and recorded.
      expect(errorCode(await picking(6, 'setup.restoreChoose', {}))).toBe('PERMISSION_DENIED');
      expect(errorCode(await picking(6, 'setup.restore', { token: randomUUID(), confirm: 'RESTORE' }))).toBe('PERMISSION_DENIED');
      expect(listAudit(env.db, { page: 1, pageSize: 1, action: 'DENIED' }).rows[0]).toMatchObject({ entityId: 'setup.restore', userId: null });
    } finally {
      old.cleanup();
    }
  });

  it('restores only a backup the same window chose and checked, with the typed confirmation', async () => {
    const owner = setupOwner(env);
    const backup = await createBackup(env, actorOf(owner), 'MANUAL');
    sessions.set(1, owner.user.id);
    sessions.set(2, owner.user.id);
    newProduct(owner, 'Spirit level');

    const check = await dispatch(1, 'backup.restoreCheck', { id: backup.id });
    if (!check.ok) throw new Error(check.error.message);
    const { token, validation } = check.data as { token: string; validation: { valid: boolean } };
    expect(validation.valid).toBe(true);

    expect(errorCode(await dispatch(1, 'backup.restore', { token, confirm: 'restore' }))).toBe('VALIDATION');
    expect(errorCode(await dispatch(2, 'backup.restore', { token, confirm: 'RESTORE' }))).toBe('VALIDATION');
    expect(productNames()).toEqual(['Spirit level']);

    const restored = await dispatch(1, 'backup.restore', { token, confirm: 'RESTORE' });
    expect(restored.ok).toBe(true);
    expect(productNames()).toEqual([]);
    // A token is good for one restore only.
    expect(errorCode(await dispatch(1, 'backup.restore', { token, confirm: 'RESTORE' }))).toBe('VALIDATION');
  });
});
