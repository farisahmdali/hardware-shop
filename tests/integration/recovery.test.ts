import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@main/db/connection';
import { LATEST_SCHEMA_VERSION, schemaVersion } from '@main/db/migrator';
import { createBackup, listBackups, removeInterruptedBackups, validateBackupFile } from '@main/services/backup';
import { walkInCustomerId } from '@main/services/customers';
import { runIntegrityChecks } from '@main/services/integrity';
import { receivePayment } from '@main/services/payments';
import { createPurchase } from '@main/services/purchases';
import { finalizeSale, getInvoice } from '@main/services/sales';
import { upgradeDatabase } from '@main/services/upgrade';
import { bundleForNode } from '../support/bundle';
import { ShopData, OWNER_PERMS, rupees, units } from '../support/shop';
import { actorOf, createTestEnv, openDatabaseAtVersion, setupOwner, snapshotTables, type TestEnv } from '../helpers';

let env: TestEnv;
let child: string;

beforeAll(async () => {
  child = await bundleForNode('tests/fixtures/crashChild.ts');
}, 120_000);
afterAll(() => rmSync(dirname(child), { recursive: true, force: true }));
beforeEach(() => {
  env = createTestEnv();
});
afterEach(() => env.cleanup());

const healthy = () => expect(runIntegrityChecks(env.db).issues).toEqual([]);

/**
 * Runs an operation in a separate process that is killed part way through (see crashChild.ts),
 * then reopens the database the way the application does at its next start.
 */
function crash(operation: string, input: Record<string, unknown>, stopAt: string): void {
  env.db.close();
  const r = spawnSync(process.execPath, [child, env.paths.databasePath, operation, JSON.stringify({ ...input, now: env.clock.now().toISOString() }), stopAt], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  env.db = openDatabase(env.paths.databasePath);
  // Killed, not finished (3) and not failed for another reason (an error would be on stderr).
  expect({ stopped: r.stdout.includes('stopping'), finished: r.status === 0 || r.status === 3, stderr: r.stderr }).toEqual({ stopped: true, finished: false, stderr: '' });
}

describe('the application stopping in the middle of an operation', () => {
  let shop: ShopData;
  beforeEach(() => {
    shop = new ShopData(env, actorOf(setupOwner(env)));
  });

  it('leaves no trace of a sale that was being saved, and the same sale can then be completed', () => {
    const hammer = shop.product('Claw hammer', { price: rupees(450), cost: rupees(310), qty: units(10) });
    const sale = shop.saleInput(walkInCustomerId(env.db), [{ p: hammer, qty: units(2) }]);
    const before = snapshotTables(env.db);

    // Killed after the bill, its lines, the stock movement and the bill number were written, before the accounts.
    crash('sale', { sale }, 'INSERT INTO ledger_entries');
    expect(snapshotTables(env.db)).toEqual(before);
    healthy();

    // Retrying (same request) completes it, with the first bill number: numbering stays gap-free.
    const done = finalizeSale(env, shop.actor, OWNER_PERMS, sale);
    expect(done.invoiceNo).toBe('INV/2026-27/00001');
    expect(getInvoice(env.db, done.invoiceId, true, shop.today()).status).toBe('PAID');
    healthy();
  });

  it('leaves no trace of a payment that was being saved', () => {
    const hammer = shop.product('Claw hammer', { price: rupees(450), cost: rupees(310), qty: units(10) });
    const ramesh = shop.customer('Ramesh Builders');
    shop.sell(ramesh.id, [{ p: hammer, qty: units(1) }], 'none');
    const payment = shop.paymentInput(ramesh.id, rupees(450));
    const before = snapshotTables(env.db);

    crash('payment', { payment }, 'INSERT INTO ledger_entries');
    expect(snapshotTables(env.db)).toEqual(before);
    healthy();
    expect(receivePayment(env, shop.actor, payment).amount).toBe(rupees(450));
    healthy();
  });

  it('leaves no trace of a purchase that was being saved', () => {
    const hammer = shop.product('Claw hammer', { price: rupees(450), cost: rupees(310) });
    const supplier = shop.supplier('Pune Tools');
    const purchase = shop.purchaseInput(supplier.id, [{ productId: hammer.id, qty: units(5), cost: rupees(300) }], rupees(500));
    const before = snapshotTables(env.db);

    // Killed after the bill and its lines, before the stock came in.
    crash('purchase', { purchase }, 'INSERT INTO stock_movements');
    expect(snapshotTables(env.db)).toEqual(before);
    healthy();
    createPurchase(env, shop.actor, purchase);
    healthy();
  });

  it('cleans up after a backup that was being written, and backs up normally afterwards', async () => {
    shop.product('Claw hammer', { price: rupees(450), cost: rupees(310), qty: units(10) });
    const before = snapshotTables(env.db);

    crash('backup', {}, '(not used)');
    expect(snapshotTables(env.db)).toEqual(before); // nothing recorded for a backup that never finished
    const folder = env.paths.defaultBackupDir;
    expect(readdirSync(folder).some((f) => f.endsWith('.partial'))).toBe(true);

    const removed = await removeInterruptedBackups(env);
    expect(removed.length).toBeGreaterThan(0);
    expect(readdirSync(folder)).toEqual([]);

    const backup = await createBackup(env, shop.actor, 'MANUAL');
    expect((await validateBackupFile(backup.filePath)).valid).toBe(true);
    // A finished backup and its manifest are never treated as left over.
    expect(await removeInterruptedBackups(env)).toEqual([]);
    expect(existsSync(backup.filePath)).toBe(true);
  });
});

describe('upgrading the database', () => {
  /** Replaces the test database with one an older release created. */
  function olderDatabase(version: number) {
    env.db.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(env.paths.databasePath + suffix, { force: true });
    env.db = openDatabaseAtVersion(env.paths.databasePath, version);
  }
  const notCompared = ['schema_migrations', 'backup_history', 'audit_log'];

  it('keeps every existing record, after a verified backup of the old version', async () => {
    olderDatabase(LATEST_SCHEMA_VERSION - 1);
    const shop = new ShopData(env, actorOf(setupOwner(env)));
    const hammer = shop.product('Claw hammer', { price: rupees(450), cost: rupees(310), qty: units(20) });
    const pipe = shop.product('PVC pipe 1 in', { price: rupees(55), cost: rupees(38), qty: units(100), unit: 'M' });
    const ramesh = shop.customer('Ramesh Builders', '9822012345');
    shop.sell(walkInCustomerId(env.db), [{ p: hammer, qty: units(2) }, { p: pipe, qty: units(2.5) }]);
    shop.sell(ramesh.id, [{ p: hammer, qty: units(3) }], 'none');
    shop.receive(ramesh.id, rupees(500));
    const supplier = shop.supplier('Pune Tools');
    shop.buy(supplier.id, [{ productId: hammer.id, qty: units(10), cost: rupees(300) }], rupees(1000));
    const drill = shop.rentalProduct('Impact drill', 2, rupees(300), rupees(2000));
    const rental = shop.rent(ramesh.id, [drill.assetIds[0]!], 2, rupees(2000));
    env.clock.advanceMinutes(3 * 24 * 60);
    shop.returnAndSettle(rental.id);
    shop.rent(ramesh.id, [drill.assetIds[1]!], 7, rupees(1000));
    shop.expense(rupees(1200), 'Electricity bill');
    // Healthy apart from not being at the latest version yet.
    expect(runIntegrityChecks(env.db).issues.map((i) => i.check)).toEqual(['schema']);

    const before = snapshotTables(env.db, notCompared);
    const historyBefore = env.db.prepare('SELECT * FROM audit_log ORDER BY id').all();

    expect(await upgradeDatabase(env)).toEqual([LATEST_SCHEMA_VERSION]);
    expect(schemaVersion(env.db)).toBe(LATEST_SCHEMA_VERSION);
    expect(snapshotTables(env.db, notCompared)).toEqual(before);
    const historyAfter = env.db.prepare('SELECT * FROM audit_log ORDER BY id').all();
    expect(historyAfter.slice(0, historyBefore.length)).toEqual(historyBefore);
    expect(historyAfter.slice(historyBefore.length).map((a) => (a as { action: string }).action)).toEqual(['BACKUP_CREATED']);

    const pre = listBackups(env)[0]!;
    expect(pre).toMatchObject({ kind: 'PRE_MIGRATION', status: 'OK', schemaVersion: LATEST_SCHEMA_VERSION - 1 });
    expect((await validateBackupFile(pre.filePath)).valid).toBe(true);
    healthy();

    // The next start has nothing to do.
    expect(await upgradeDatabase(env)).toEqual([]);
    expect(listBackups(env)).toHaveLength(1);
  });

  it.each(Array.from({ length: LATEST_SCHEMA_VERSION - 1 }, (_, i) => i + 1))('upgrades a database last opened at version %i', async (version) => {
    olderDatabase(version);
    const applied = await upgradeDatabase(env);
    expect(applied).toEqual(Array.from({ length: LATEST_SCHEMA_VERSION - version }, (_, i) => version + 1 + i));
    expect(listBackups(env)[0]).toMatchObject({ kind: 'PRE_MIGRATION', status: 'OK', schemaVersion: version });
    healthy();
  });

  it('changes nothing when the backup before upgrading cannot be made', async () => {
    olderDatabase(LATEST_SCHEMA_VERSION - 1);
    writeFileSync(env.paths.defaultBackupDir, 'a file where the backup folder should be');
    await expect(upgradeDatabase(env)).rejects.toThrow(/backup could not be created/);
    expect(schemaVersion(env.db)).toBe(LATEST_SCHEMA_VERSION - 1);
  });

  it('creates a new database without a backup', async () => {
    olderDatabase(0);
    expect(await upgradeDatabase(env)).toHaveLength(LATEST_SCHEMA_VERSION);
    expect(listBackups(env)).toEqual([]);
  });
});
