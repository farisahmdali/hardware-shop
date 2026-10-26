import { describe, expect, it } from 'vitest';
import { backupDue, backupsToRemove, nextBackupAt, type RetentionCandidate } from '@main/services/backupSchedule';

const TZ = 'Asia/Kolkata';
const on = { autoEnabled: true, intervalHours: 4 };
const at = (iso: string) => new Date(iso);

describe('when an automatic backup is due', () => {
  it('runs when there has never been a backup, and never when switched off', () => {
    expect(backupDue(at('2026-10-26T04:00:00Z'), null, on, TZ)).toBe(true);
    expect(backupDue(at('2026-10-26T04:00:00Z'), null, { ...on, autoEnabled: false }, TZ)).toBe(false);
    expect(nextBackupAt(at('2026-10-26T04:00:00Z'), null, { ...on, autoEnabled: false }, TZ)).toBeNull();
  });

  it('runs on the first start of each shop day, then every few hours', () => {
    // Last backup 11:00 pm IST yesterday; it is now 9:00 am IST: a new day.
    expect(backupDue(at('2026-10-26T03:30:00Z'), '2026-10-25T17:30:00Z', on, TZ)).toBe(true);
    // Same day, 3 hours later: not yet; 4 hours later: due.
    expect(backupDue(at('2026-10-26T06:30:00Z'), '2026-10-26T03:30:00Z', on, TZ)).toBe(false);
    expect(backupDue(at('2026-10-26T07:30:00Z'), '2026-10-26T03:30:00Z', on, TZ)).toBe(true);
    expect(nextBackupAt(at('2026-10-26T06:30:00Z'), '2026-10-26T03:30:00Z', on, TZ)).toBe('2026-10-26T07:30:00.000Z');
  });
});

describe('retention', () => {
  const row = (id: number, createdAt: string, kind = 'AUTO', extra: Partial<RetentionCandidate> = {}): RetentionCandidate => ({
    id,
    createdAt,
    kind,
    status: 'OK',
    fileExists: true,
    removedAt: null,
    ...extra,
  });
  const now = at('2026-10-26T12:00:00Z');

  it('keeps the latest automatic backups and one a day, and removes the rest', () => {
    const rows = [
      row(1, '2026-10-26T10:00:00Z'),
      row(2, '2026-10-26T06:00:00Z'),
      row(3, '2026-10-26T02:00:00Z'),
      row(4, '2026-10-25T10:00:00Z'),
      row(5, '2026-10-25T06:00:00Z'),
      row(6, '2026-10-10T06:00:00Z'),
    ];
    // Keep 2 latest (1, 2), the newest of each day within 7 days (1 on the 26th, 4 on the 25th).
    expect(backupsToRemove(rows, now, { keepAutoCount: 2, keepDailyDays: 7 }, TZ).sort()).toEqual([3, 5, 6]);
  });

  it('never removes manual, before-upgrade or before-restore backups, or the newest good backup', () => {
    const rows = [
      row(1, '2026-01-01T06:00:00Z', 'MANUAL'),
      row(2, '2026-01-02T06:00:00Z', 'PRE_MIGRATION'),
      row(3, '2026-01-03T06:00:00Z', 'PRE_RESTORE'),
      row(4, '2026-01-04T06:00:00Z'),
      row(5, '2026-01-05T06:00:00Z', 'AUTO', { status: 'FAILED' }),
    ];
    // Row 4 is old enough to go, but it is the newest backup that worked.
    expect(backupsToRemove(rows, now, { keepAutoCount: 0, keepDailyDays: 1 }, TZ)).toEqual([]);
  });

  it('ignores files already removed or missing', () => {
    const rows = [row(1, '2026-10-26T10:00:00Z'), row(2, '2026-01-01T06:00:00Z', 'AUTO', { removedAt: '2026-02-01T00:00:00Z' }), row(3, '2026-01-02T06:00:00Z', 'AUTO', { fileExists: false })];
    expect(backupsToRemove(rows, now, { keepAutoCount: 1, keepDailyDays: 1 }, TZ)).toEqual([]);
  });
});
