# Backups and Recovery

This guide is for the shop owner, and for anyone who helps look after the shop computer. It explains how the shop's data is protected and what to do when something goes wrong.

## Where the data is

| What | Where on the computer |
|---|---|
| All shop data and history (one file) | `%APPDATA%\HardwareShop\data\shop.db` |
| Backups (unless you chose another folder) | `Documents\HardwareShop Backups` |
| Technical log, for diagnosing problems | `%APPDATA%\HardwareShop\logs\main.log` |

`%APPDATA%` is usually `C:\Users\<your Windows name>\AppData\Roaming`. To open it, type `%APPDATA%\HardwareShop` in the File Explorer address bar.

**Backup & Settings → My account & display → About this installation** shows the data folder on your computer, and **Backup & Settings → Backup** shows the backup folder.

Uninstalling or reinstalling the application does **not** delete the data or the backups.

## How the data is protected

- **Every save is complete or not at all.** A bill, payment, return or rental is saved together with its stock changes, accounts and history entry, or not at all. A power cut or crash in the middle of saving leaves nothing half-saved. This has been tested by killing the application in the middle of saving.
- **The database is written safely.** Each completed save is on the disk before the screen confirms it.
- **Nothing is overwritten.** Saved bills, payments, stock movements, accounting entries and history cannot be changed or deleted. Corrections are new, linked records.
- **Checks at every start.** A quick data check runs each time the application starts. A full check is in **Backup & Settings → Data health → Run full check**.

None of this protects against the computer failing, being stolen, or the file being damaged. That is what backups are for.

## Backups

A backup is one file (`.db`) holding a complete copy of all shop data, history and settings, together with a small description file (`.json`). Every backup is checked as it is made: it is opened, tested for damage, and its checksum recorded. A file that fails the check is never kept as a backup.

Backup file names show when and why they were made, for example `HardwareShop_2026-10-26_1830_manual.db`:

| Kind | Made when | Removed automatically? |
|---|---|---|
| `manual` | You click **Back up now** | Never |
| `auto` | Automatically: at the first start of each day, then every few hours while the application is open | Yes, when old (see below) |
| `pre-restore` | Just before a restore replaces the data | Never |
| `pre-migration` | Just before a new version of the application upgrades the data | Never |

**Automatic backups** are set in **Backup & Settings → Backup → Automatic backups**: on or off, how often (default every 4 hours), and how many to keep. By default the newest 30 automatic backups are kept, plus the newest one of each day for 90 days. The newest backup that passed its check is never removed. The backup list keeps a line for each removed file.

**Make a backup by hand** before anything unusual: before a stock count, before changing many prices, before moving the computer. Use **Back up now**.

## Keep a copy away from the shop

Backups in the Documents folder are on the same disk as the data. They protect against mistakes, but **not** against a failed disk, a virus or a stolen computer. The application warns about this on the Backup screen.

At least once a week, and at the end of busy days:

1. Plug in a USB drive.
2. **Backup & Settings → Backup → Copy latest backup to USB…** and choose the drive.
3. The application copies the newest backup and checks the copy.
4. Take the drive home or keep it somewhere safe. Rotating two drives is better than one.

You can also choose a different backup folder, for example one synchronised by OneDrive or Google Drive, with **Change folder…**. The application itself never uses the internet.

## Checking a backup file

**Backup & Settings → Backup → Check a backup file…** opens any backup file and reports whether it can be used: whether it is undamaged, which shop it belongs to, when it was made, and how many products, bills and so on it holds. The file is checked on a copy and never changed.

## Restoring a backup

Restoring replaces **all** current data with the data in the backup. Anything recorded after the backup was made will no longer appear in the application. Only the owner can restore, unless the owner gives the permission to another role.

1. **Backup & Settings → Backup.** Click **Restore…** on a backup in the list, or **Restore from a file…** for a backup on a USB drive.
2. The backup is checked. A damaged file, a file from another program, or a file from a newer version of the application is refused, and nothing changes.
3. Read the summary: which shop, when the backup was made, and what it contains.
4. Type `RESTORE` and click **Restore**.

What happens next:

- A verified copy of the current data is saved first (a `pre-restore` backup). If that copy cannot be made, nothing is restored. **So a restore can always be undone**: restore that `pre-restore` backup.
- The backup replaces the data. If it comes from an older version of the application, it is upgraded.
- The data is checked, and the restore is recorded in the history: which backup, who restored it, and the copy made before.
- The application reloads. **Everyone signs in again**, with the names and PINs that were in use when the backup was made.

If anything fails part way through, the original data is put back automatically, and the screen says nothing was restored. If the computer loses power during a restore, the next start puts the original data back.

## Moving to a new computer, or after a computer failure

1. Install the application on the new computer (see [INSTALL.md](INSTALL.md)).
2. On the first screen, click **Restore from a backup…** instead of filling in the shop details.
3. Choose the newest backup file, usually from your USB drive.
4. Check the summary, type `RESTORE` and click **Restore**.
5. Sign in with your usual name and PIN.
6. Check **Backup & Settings → Backup**: set the backup folder again if you used a special one, and make a new backup.

Restoring from a backup on a set-up shop needs the owner to sign in. The first-screen restore is only available before the shop has been set up.

## When something goes wrong

| Problem | What to do |
|---|---|
| The power went off or the application closed unexpectedly | Start it again. Anything being saved at that moment was either saved completely or not at all. Check the last few bills in **Sales & Billing → Invoices** and redo any that are missing. |
| **Data health** reports a problem | Make a backup now (**Back up now**) and keep it. Do not restore yet. Note the message, then look in the History at what was done around that time. If the data is damaged (*"The database file is undamaged"* fails), restore the newest backup made before the problem. |
| The application shows "Cannot open the shop database" or "Cannot upgrade the shop database" when starting | The data has not been changed. The message shows the data folder. Copy that whole folder to a USB drive before trying anything else. Then reinstall the application. If it still fails, install it on another computer and restore the newest backup. |
| A backup says *"The file does not match its manifest checksum"* | The file was changed or only partly copied. Use another backup. |
| A backup says it was *"made by a newer version"* | Install the newer version of the application first, then restore. |
| The backup folder is on a USB drive that is not plugged in | Automatic backups fail and are retried every half hour. The failure is shown in the backup list. Plug the drive back in, or change the folder. |
| You restored the wrong backup | Restore the `pre-restore` backup that was made just before it. |

## For the person looking after the computer

- Keep Windows protected with a password. Someone with direct access to the data file and special tools could alter it, bypassing the application's protections. The history is strong evidence, but it is not tamper-proof against that.
- The data folder can be copied safely only while the application is **closed**. While it is open, use **Back up now** instead, which is always safe.
- A backup `.db` file is a standard SQLite database and can be opened read-only with any SQLite tool for inspection.
- Technical details: [ARCHITECTURE.md](ARCHITECTURE.md) (backups, restore, start-up checks) and [UPGRADING.md](UPGRADING.md).
