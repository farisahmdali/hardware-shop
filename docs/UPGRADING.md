# Updating the Application Without Losing Data

The first part is for the shop owner. The second part is for whoever builds new versions.

## Installing a new version (shop owner)

1. **Make a backup** (**Backup & Settings → Backup → Back up now**) and copy it to the USB drive.
2. Close Hardware Shop Manager.
3. Run the installer of the new version. It replaces the program and leaves the shop data and backups alone.
4. Start the application. If the new version needs to change how the data is stored, it first saves a verified backup of the data as it was (a `pre-migration` backup), then upgrades the data. This happens once, before the sign-in screen, and a small **Updating the shop data…** window is shown meanwhile. For a large shop it can take a minute; do not switch off the computer.
5. Check that everything looks right: recent bills, stock, balances. **Data health → Run full check** should report no problems.

What is kept: every product, bill, payment, rental, customer, supplier, expense, setting, user account and history entry, plus all backups.

### If the upgrade fails

The application shows **"Cannot upgrade the shop database"** and stops. The data has **not** been changed: each step of an upgrade is all-or-nothing, and the upgrade only starts after the backup has been made. If that backup cannot be made (for example the backup drive is missing), the upgrade does not start at all.

1. Note the message.
2. Reinstall the **previous** version. It opens the data as before.
3. Report the message to whoever supplied the new version.

### Going back to an older version

A newer version may store data in a way an older version cannot read. If you start an older version on upgraded data, it refuses to open it rather than risk damaging it, and says that a newer version is needed. To go back:

1. Install the older version.
2. On the backup screen, **Restore from a file…** the `pre-migration` backup made just before the upgrade. It is in the backup folder, with `pre-migration` in its name.
3. Anything recorded after the upgrade will not be in that backup. Write it down before going back, and enter it again afterwards.

Backups from an **older** version can always be restored in a newer version; they are upgraded during the restore.

---

## Making a new version (developers)

### Rules for changes to the database

Shop data must survive every update. The database is changed only through migrations in `src/main/db/migrations/NNN_name.sql`:

- **Forward only.** There are no down-migrations. Going back is done with the `pre-migration` backup.
- **Never edit a released migration.** Each applied migration's checksum is stored in the database, and the application refuses to open a database whose applied migrations differ from its own. Add a new migration instead.
- **Additive.** Add tables, columns (with defaults), indexes, views and triggers. Do not drop or rewrite business data. If a table must be reshaped, create the new table, copy the rows, and keep or rename the old one, all in the one migration.
- **Keep history intact.** Append-only tables (invoices, payments, stock movements, ledger, audit log…) are protected by triggers. A migration that needs to touch them must not change existing rows' meaning.
- **Consecutive numbers.** `008_…` follows `007_…`. The application and the tests refuse to start if there is a gap.
- Each migration runs in its own transaction. The application takes a verified `PRE_MIGRATION` backup before applying any migration to an existing database (`src/main/services/upgrade.ts`).

### Checks before a release

1. Add the migration and update [SCHEMA.md](SCHEMA.md).
2. `npm run typecheck`, `npm test` and `npm run test:e2e` must all pass. The tests include:
   - an upgrade of a database left at **every** earlier version (`tests/integration/recovery.test.ts`);
   - an upgrade of a fully populated database from the previous version, checking that every row of every table is unchanged and the history is intact;
   - an upgrade refused, with nothing changed, when the backup before it cannot be made;
   - restoring backups from an older version.
3. `npm run perf` on the large generated shop, to catch slow queries (see [TEST_REPORT.md](TEST_REPORT.md)).
4. Raise `version` in `package.json` (shown in the application and in backup files).
5. `npm run dist`, then install the new installer over the previous version on a test computer that has real-looking data, and check the data after the upgrade.
