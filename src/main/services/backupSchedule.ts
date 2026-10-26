import type { AppEnv } from './env';
import { createBackup, pruneBackups } from './backup';
import { getAllSettings } from './settings';
import { SYSTEM_ACTOR } from '../db/tx';
import { businessDateOf } from '@shared/time';

const HOUR = 3_600_000;

/**
 * Whether an automatic backup is due: on the first run of each day, and then every
 * `intervalHours` after the last successful backup of any kind.
 */
export function backupDue(now: Date, lastSuccessAt: string | null, s: { autoEnabled: boolean; intervalHours: number }, timeZone: string): boolean {
  if (!s.autoEnabled) return false;
  if (!lastSuccessAt) return true;
  const last = new Date(lastSuccessAt);
  if (businessDateOf(last, timeZone) !== businessDateOf(now, timeZone)) return true;
  return now.getTime() - last.getTime() >= s.intervalHours * HOUR;
}

/** When the next automatic backup will be taken, or null when they are switched off. */
export function nextBackupAt(now: Date, lastSuccessAt: string | null, s: { autoEnabled: boolean; intervalHours: number }, timeZone: string): string | null {
  if (!s.autoEnabled) return null;
  if (backupDue(now, lastSuccessAt, s, timeZone)) return now.toISOString();
  return new Date(new Date(lastSuccessAt!).getTime() + s.intervalHours * HOUR).toISOString();
}

export interface RetentionCandidate {
  id: number;
  createdAt: string;
  kind: string;
  status: 'OK' | 'FAILED';
  fileExists: boolean;
  removedAt: string | null;
}

/**
 * Automatic backups that the retention policy no longer needs. Kept: the newest `keepAutoCount`
 * automatic backups, the newest automatic backup of each day for `keepDailyDays` days, and the
 * newest verified backup of any kind. Manual, before-upgrade and before-restore backups are never removed.
 */
export function backupsToRemove(rows: RetentionCandidate[], now: Date, s: { keepAutoCount: number; keepDailyDays: number }, timeZone: string): number[] {
  const usable = rows.filter((r) => r.status === 'OK' && r.fileExists && !r.removedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  const autos = usable.filter((r) => r.kind === 'AUTO');
  const keep = new Set<number>(autos.slice(0, s.keepAutoCount).map((r) => r.id));
  if (usable[0]) keep.add(usable[0].id);
  const cutoff = businessDateOf(new Date(now.getTime() - s.keepDailyDays * 24 * HOUR), timeZone);
  const days = new Set<string>();
  for (const r of autos) {
    const day = businessDateOf(new Date(r.createdAt), timeZone);
    if (day >= cutoff && !days.has(day)) {
      days.add(day);
      keep.add(r.id);
    }
  }
  return autos.filter((r) => !keep.has(r.id)).map((r) => r.id);
}

export function lastSuccessfulBackupAt(env: AppEnv): string | null {
  return (env.db.prepare("SELECT MAX(created_at) AS at FROM backup_history WHERE status = 'OK'").get() as { at: string | null }).at;
}

/**
 * Takes automatic backups while the application runs. It checks shortly after start (so the first
 * run of the day is covered) and then every few minutes. A failed attempt is retried after half an hour.
 */
export function startBackupScheduler(env: AppEnv, opts: { firstCheckMs?: number; everyMs?: number; isPaused?: () => boolean } = {}): { stop(): void; check(): Promise<void> } {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let lastFailure = 0;
  let stopped = false;

  const check = async () => {
    if (running || stopped || opts.isPaused?.()) return;
    const now = env.clock.now();
    if (now.getTime() - lastFailure < 0.5 * HOUR) return;
    const settings = getAllSettings(env.db).backup;
    if (!backupDue(now, lastSuccessfulBackupAt(env), settings, env.timeZone ?? 'Asia/Kolkata')) return;
    running = true;
    try {
      await createBackup(env, SYSTEM_ACTOR, 'AUTO');
      await pruneBackups(env, SYSTEM_ACTOR);
    } catch (e) {
      // createBackup records the failure in the backup history; try again later.
      lastFailure = now.getTime();
      env.logger.error('Automatic backup failed', e);
    } finally {
      running = false;
    }
  };

  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await check();
      schedule(opts.everyMs ?? 10 * 60_000);
    }, ms);
    timer.unref?.();
  };
  schedule(opts.firstCheckMs ?? 60_000);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    check,
  };
}
