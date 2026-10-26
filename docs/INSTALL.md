# Installing Hardware Shop Manager

This guide is for whoever installs the application on the shop computer: the owner, or someone helping them.

## What you need

- A computer with Windows 10 or Windows 11 (64-bit).
- About 600 MB of free disk space for the application, plus room for the shop data and backups. A busy shop's two years of data is a few hundred MB, and each backup is about the same size.
- A USB drive for copies of the backups.
- A printer if you print bills (A4, or an 80 mm / 58 mm receipt printer installed in Windows).
- No internet connection is needed, during installation or ever.

## Install

1. Copy the installer file, `Hardware Shop Manager Setup <version>.exe`, to the shop computer (for example from a USB drive).
2. Double-click it.
3. Windows may show **"Windows protected your PC"**. The installer is not signed with a paid code-signing certificate, so Windows does not recognise its publisher. Click **More info**, check that the name is `Hardware Shop Manager Setup <version>.exe`, then click **Run anyway**. Only do this for an installer you received directly from the person who built it.
4. If asked who to install for, choose **Only for me** (no administrator password needed). Keep the suggested installation folder unless you have a reason to change it.
5. Click **Install**, then **Finish**. The installer adds **Hardware Shop Manager** to the Start menu and the desktop.

## First start

Open **Hardware Shop Manager**. The first screen offers two ways to begin:

- **A new shop:** fill in the shop details and create the owner account. See section 1 of the [User Guide](USER_GUIDE.md).
- **Moving from another computer:** click **Restore from a backup…** and choose the newest backup from the old computer (usually on the USB drive). Then sign in with your usual name and PIN. See [BACKUP_RECOVERY.md](BACKUP_RECOVERY.md).

Then, as the owner:

1. **Backup & Settings → Backup:** check the backup folder, click **Back up now**, and copy the backup to the USB drive.
2. Set up payment methods, printing and rental rules, and an account for each employee. See the [User Guide](USER_GUIDE.md).
3. Print a test bill on the shop printer.

## Only one copy at a time

The application runs once per computer. Opening it again brings the open window to the front. It is designed for one computer; it does not share data between computers over a network.

## Where things are installed

| What | Where |
|---|---|
| The application | `%LOCALAPPDATA%\Programs\Hardware Shop Manager` (unless you chose another folder) |
| Shop data and history | `%APPDATA%\HardwareShop\data` |
| Backups | `Documents\HardwareShop Backups` (can be changed in the application) |
| Technical log | `%APPDATA%\HardwareShop\logs` |

## Updating to a new version

Run the new installer over the existing one. The shop data is kept and upgraded automatically, after a backup is taken. See [UPGRADING.md](UPGRADING.md).

## Uninstalling

**Windows Settings → Apps → Installed apps → Hardware Shop Manager → Uninstall.**

Uninstalling removes the program only. **The shop data and backups are kept**, so reinstalling later carries on where you left off. To remove the data as well, first make sure you have a backup you no longer need, then delete the `%APPDATA%\HardwareShop` folder and the `Documents\HardwareShop Backups` folder by hand.

## Troubleshooting installation

| Problem | What to do |
|---|---|
| "Windows protected your PC" | See step 3 above. |
| An antivirus program blocks the installer | Allow the file in the antivirus, or ask whoever manages the antivirus. The application makes no network connections. |
| The application does not start after installing | Restart the computer and try again. If it shows a message about the database, see [BACKUP_RECOVERY.md](BACKUP_RECOVERY.md). |
| Bills print at the wrong size | **Backup & Settings → Payments & printing:** choose the paper size that matches the printer. |

---

## For developers: building the installer

Requirements: Windows 10/11, Node.js 22 or newer, and npm.

```powershell
npm install        # also prepares the SQLite module for Electron
npm test           # unit and integration tests
npm run test:e2e   # builds the app and drives it end to end
npm run dist       # builds release\Hardware Shop Manager Setup <version>.exe
```

The version number comes from `package.json`. Production builds contain no sample data. The **Add sample products** button in Data health exists only in development builds.
