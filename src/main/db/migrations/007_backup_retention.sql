-- 007_backup_retention: backup history remembers when an automatic backup file was removed
-- under the retention policy, and why. The history row itself is kept.

ALTER TABLE backup_history ADD COLUMN removed_at TEXT;
ALTER TABLE backup_history ADD COLUMN removed_reason TEXT;
