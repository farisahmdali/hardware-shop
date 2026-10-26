/**
 * Runs one shop operation against a database and kills its own process part way through, the way a
 * power cut or a crashed application would: no rollback, no clean close. Used by the crash tests.
 *
 *   child.cjs <databasePath> <operation> <input JSON> <stop at>
 *
 * <stop at> is a piece of SQL: the process is killed right after the first statement containing it
 * runs, inside the operation's transaction. For 'backup' it is ignored; the process is killed once
 * the database copy has been written, before it is verified and given its final name.
 */
import { writeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { openDatabase } from '@main/db/connection';
import type { Actor } from '@main/db/tx';
import { silentLogger, type AppEnv } from '@main/services/env';
import { createBackup } from '@main/services/backup';
import { finalizeSale } from '@main/services/sales';
import { receivePayment } from '@main/services/payments';
import { createPurchase } from '@main/services/purchases';
import { ALL_PERMISSIONS } from '@shared/permissions';

const [databasePath, operation, inputJson, stopAt] = process.argv.slice(2) as [string, string, string, string];
const input = JSON.parse(inputJson);
const actor: Actor = { userId: 1, username: 'owner' };
const die = () => {
  writeSync(1, 'stopping\n');
  process.kill(process.pid, 'SIGKILL');
};

const db = openDatabase(databasePath);
const prepare = db.prepare.bind(db);
db.prepare = ((sql: string) => {
  const statement = prepare(sql);
  if (sql.includes(stopAt)) {
    const run = statement.run.bind(statement);
    statement.run = ((...args: unknown[]) => {
      run(...(args as []));
      die();
    }) as typeof statement.run;
  }
  return statement;
}) as typeof db.prepare;

const dir = dirname(databasePath);
const env: AppEnv = {
  db,
  clock: { now: () => new Date(input.now ?? Date.now()) },
  timeZone: 'Asia/Kolkata',
  appVersion: '0.0.0-test',
  logger: silentLogger,
  paths: { dataDir: dir, databasePath, defaultBackupDir: join(dir, 'backups') },
};

async function main() {
  switch (operation) {
    case 'sale':
      finalizeSale(env, actor, { permissions: ALL_PERMISSIONS, maxDiscountBp: 10_000 }, input.sale);
      break;
    case 'payment':
      receivePayment(env, actor, input.payment);
      break;
    case 'purchase':
      createPurchase(env, actor, input.purchase);
      break;
    case 'backup': {
      const backup = db.backup.bind(db);
      db.backup = (async (...args: Parameters<typeof db.backup>) => {
        const result = await backup(...args);
        die();
        return result;
      }) as typeof db.backup;
      await createBackup(env, actor, 'MANUAL');
      break;
    }
    default:
      throw new Error(`Unknown operation ${operation}`);
  }
  // Reaching this point means the stop was never hit.
  process.exit(3);
}

void main();
