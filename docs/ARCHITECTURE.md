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
- **Connection settings:** WAL journal, `synchronous=FULL` (a committed sale survives a power cut), foreign keys enforced.
- **File identity:** `PRAGMA application_id` marks the file as ours.
- **Migrations:** `src/main/db/migrations/NNN_name.sql`, bundled into the app.
  - They are applied in order, each in its own transaction.
  - Each applied migration's checksum is recorded. An edited migration, a foreign file, or a database from a newer app version is refused.
  - On upgrade, a verified backup is taken **before** any migration runs.

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

## Integrity checks

`src/main/services/integrity.ts` holds a list of checks:

- SQLite integrity
- foreign keys
- schema version and application id
- protection triggers present
- settings valid

Quick checks run after every start. The full set runs from Settings → Data health and in tests. Later phases add stock and ledger reconciliation checks to the same list.

## Testing

| Layer | Tool | What it covers |
|---|---|---|
| Unit | Vitest | Money, quantity, date, GST and numbering helpers |
| Integration | Vitest, run inside Electron's Node, on real SQLite temp files | Services and the IPC dispatcher: migrations, rollback, append-only audit, idempotency, sign-in and lockout, permissions, backups and corrupt-file detection |
| End to end | Playwright driving the built app on an isolated data folder | Setup, sign-in, navigation, backup, history, restart persistence and the network block |

## Logging

`electron-log` writes technical events to `logs/main.log` (rotated at 5 MB). Business history is never kept in log files; it lives in the database's audit log.
