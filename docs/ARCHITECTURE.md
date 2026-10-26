# Architecture

## Overview

```
┌────────────────────────── Electron ──────────────────────────┐
│ Renderer (React)                Main process (Node)          │
│ sandboxed, no Node, no FS  ──►  dispatcher ─► services ─► SQLite
│ window.hws.invoke(cmd, input)   validate → authorize → run   │
└──────────────────────────────────────────────────────────────┘
```

- **Renderer** (`src/renderer`): React + TypeScript + Tailwind. It shows data and collects input. It cannot reach the filesystem, the database or Node, and it never decides what is allowed.
- **Preload** (`src/preload`): exposes exactly one function, `window.hws.invoke(command, input)`.
- **Main** (`src/main`): owns the database, sessions, permissions, dialogs and files.
- **Shared** (`src/shared`): code used by both sides:
  - zod schemas that define every command's input
  - money, quantity and date helpers
  - permission names and settings schemas

## Command pipeline

Every request from the screen follows the same path (`src/main/ipc/dispatcher.ts`):

1. **Known command?** Each name must appear in the shared contract (`src/shared/contracts`) and have a handler. Anything else is rejected.
2. **Authorized?** The window's session is held in main. The renderer cannot claim to be someone else. The user and role are re-read on every call, so a deactivated user or a changed role takes effect immediately. A denied attempt is written to the audit log.
3. **Valid input?** The command's zod schema parses the input.
4. **Run** inside `transact()` (`src/main/db/tx.ts`), a `BEGIN IMMEDIATE` transaction. Everything a command writes either commits together or rolls back together:
   - business rows
   - stock movements and ledger entries (later phases)
   - audit entries
   - document numbers
5. **Reply** with `{ ok: true, data }` or `{ ok: false, error: { code, message } }`. The UI shows success only after this reply arrives, which means after the commit.

Unexpected errors are logged to `logs/main.log` and reported as "nothing was saved". SQLite constraint errors are translated into plain messages.

## The `Tx` unit of work

`transact(env, actor, tx => ...)` gives services a `Tx` with:

| Member | Purpose |
|---|---|
| `tx.audit({...})` | Appends to `audit_log`. Passwords, PINs and hashes are redacted. |
| `tx.nextDocNumber('INVOICE')` | Gap-free numbering per financial year, e.g. `INV/2026-27/00001`. A rollback releases the number. |
| `tx.once(requestId, command, fn)` | Idempotency: a retried request returns the first result instead of running again. |
| `tx.expectOneChange(...)` | Optimistic locking with `version` columns. |
| `tx.nowIso`, `tx.businessDate`, `tx.txnRef` | One timestamp, one shop-local date and one correlation id per transaction. |

Transaction callbacks must be synchronous; better-sqlite3 transactions cannot span `await`.

## Security settings

- `contextIsolation`, `sandbox` and `webSecurity` are on, and `nodeIntegration` is off.
- A strict Content-Security-Policy is applied in production builds.
- Navigation, new windows, webviews and device permissions are refused.
- **All network requests are cancelled** (`src/main/app/security.ts`). The only exception is the local dev server while developing. Blocking the network also proves that no feature depends on it; the E2E test checks this.
- Only one copy of the app can run at a time, because two would compete for the database.
- IPC calls from frames other than the app's own page are rejected.
- Filesystem paths always come from native dialogs in main. The renderer can never supply one.

## Database

- **Library:** SQLite through better-sqlite3 (`src/main/db`).
- **Connection settings:** WAL journal, `synchronous=FULL` (a committed sale survives a power cut), foreign keys enforced, a 32 MB page cache.
- **Statement reuse:** better-sqlite3 keeps every prepared statement until its connection closes, so preparing SQL on every request made memory grow by about 2.7 KB per call for as long as the app stayed open. `openDatabase` makes `prepare` return one statement per distinct SQL text per connection. Statements only run to completion (`get`, `all`, `run`); none is iterated or switched to pluck/raw/expand mode, which would make sharing unsafe.
- **File identity:** `PRAGMA application_id` marks the file as ours.
- **Migrations:** `src/main/db/migrations/NNN_name.sql`, bundled into the app.
  - They are applied in order, each in its own transaction.
  - Each applied migration's checksum is recorded. An edited migration, a foreign file, or a database from a newer app version is refused.
  - On upgrade, a verified backup is taken **before** any migration runs (`src/main/services/upgrade.ts`). If it cannot be made, nothing is migrated and the app stops with a message.

See [SCHEMA.md](SCHEMA.md) for tables.

## Backups

`src/main/services/backup.ts` makes a backup in four steps:

1. SQLite's online backup API copies the live database into a `.partial` file. This is safe while the app is in use.
2. The copy is converted to a single self-contained file (no `-wal`/`-shm` side files).
3. The copy is verified:
   - integrity check
   - foreign keys
   - application id
   - migration checksums
4. A manifest is written (`.json`, with SHA-256 and row counts), and only then is the file renamed to its final name.

Existing backups are never overwritten. User-chosen backup files are validated on a temporary copy, never in place.

At start-up, files left by a backup interrupted by a crash or power cut (an unfinished `.partial` copy, or a manifest without its backup) are removed (`removeInterruptedBackups`). Finished backups are never touched.

Verifying a backup reads every page of the file, which takes tens of seconds on a large shop. The application therefore runs that check (`inspectDatabase`) in the background worker, through `AppEnv.inspectFile`; tests and the upgrade before the window opens run it in-process.

`src/main/services/backupSchedule.ts` takes automatic backups from a timer in the main process (checked a minute after start, then every 10 minutes) and applies the retention policy after each one.

### Restore

`restoreBackup` in `backup.ts`:

1. Validates the backup (refused if invalid; the attempt is recorded).
2. Takes a verified `PRE_RESTORE` backup of the current data.
3. Copies the backup to `shop.db.restoring` and compares checksums.
4. Stops the report worker and the backup timer, closes the database, moves `shop.db` aside to `shop.db.before-restore`, and moves the staged copy into place.
5. Opens and migrates the restored file, adds backups found in the backup folders to its backup history, runs the full integrity check, and records `BACKUP_RESTORED`.
6. Only then deletes `shop.db.before-restore`.

On a new installation, before setup, the first screen can restore a backup without signing in (`setup.restoreChoose` / `setup.restore`); once the shop is set up these commands are refused and the attempt recorded.

If step 5 fails, the original file is moved back. If the process stops between steps 4 and 6, `recoverInterruptedRestore` puts the original back at the next start, because a leftover `shop.db.before-restore` means the restore never finished. The renderer never sees file paths: choosing or checking a backup returns a one-time token bound to that window, valid for 15 minutes, which `backup.restore` requires together with the word RESTORE. After a restore, sessions are cleared and the window reloads.

## Background worker

`src/main/reports/worker.ts` runs in a worker thread with its own read-only connection (`query_only`). It runs reports, the data checks and backup-file checks, so long work never holds up billing or the window. It starts on first use and is replaced after a failure or a job that runs too long (2 minutes for a report, 15 minutes for a check). It is stopped during a restore and restarts on the restored file.

## Integrity checks

`src/main/services/integrity.ts` holds a list of checks:

- SQLite integrity
- foreign keys
- schema version and application id
- protection triggers present
- stock, ledger, invoice, purchase, allocation, balance, deposit, GST and expense reconciliations
- every finalized document has its history entry and its accounting entries
- settings valid

Quick checks run after every start. The full set runs from Settings → Data health, after every restore, and after every integration test scenario. In the application they run in the background worker on a freshly opened read-only connection, so the window stays responsive (on a two-year, 100,000-bill shop the quick checks take about 12 s and the full set about 30 s). A fresh connection is needed because a read-only connection kept open while the application writes can hold an out-of-date picture of the product search index, which SQLite's integrity check reports as a mismatch.

## Testing

| Layer | Tool | What it covers |
|---|---|---|
| Unit | Vitest | Money, quantity, date, GST and numbering helpers |
| Integration | Vitest, run inside Electron's Node, on real SQLite temp files | Services and the IPC dispatcher: migrations, rollback, append-only audit, idempotency, sign-in and lockout, the access level of every command and refusal logging, backups, retention, restore (including older versions, damaged files, failed upgrades and interrupted restores), history search |
| End to end | Playwright driving the built app on an isolated data folder | Setup, sign-in, navigation, products, sales, rentals, purchases, reports, backup, restore, history, restart persistence and the network block |

## Logging

`electron-log` writes technical events to `logs/main.log` (rotated at 5 MB). Business history is never kept in log files; it lives in the database's audit log.
