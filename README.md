# Hardware Shop Manager

Offline desktop software for a hardware and tools shop: sales and GST billing, stock, tool rental, customers, suppliers, expenses, reports, a permanent history of every change, and local backups.

Everything runs on the shop's Windows computer. It needs no internet connection, account or server. The one optional exception, off unless the owner switches it on, is the AI assistant that reads a photo of a supplier's bill through the owner's own OpenRouter account (version 1.2); see the user guide, section 9.

## Status

The application is built in phases. Each phase is tested before the next one starts.

| Phase | Scope | Status |
|---|---|---|
| 1 | Foundation: secure Electron shell, SQLite + migrations, transactions, audit log, users and roles, settings, setup wizard, manual backup and verification, data health | **Done** |
| 2 | Products and stock: catalogue, categories/brands/units, stock movements with weighted-average cost, adjustments, stock counts, low-stock alerts, CSV/Excel import and export | **Done** |
| 3 | Customers and ledgers, counter billing with GST, discounts, split and credit payments, held bills, invoices and receipts (print/PDF), returns and credit notes, cancellations, payments, refunds and reversals, outstanding and ageing | **Done** |
| 4 | Rental items, units and rates, pricing engine, reservations and issue (with a combined sale), double-booking guard, extensions, overdue, return and inspection, late and damage charges, security deposits, close, rental agreement print/PDF, unit history | **Done** |
| 5 | Suppliers and their accounts, purchase bills with GST, input tax credit and freight in the cost, supplier payments, advances and refunds, supplier returns (debit notes), payables and ageing, expenses with audited corrections, cash entries, daily cash book and cash counts | **Done** |
| 6 | About 45 reports (sales, stock, rentals, money and profit, GST, customers and suppliers) with filters, sorting and Excel/CSV/PDF export and printing, run in a background worker; dashboard with a chosen period, separately labelled sales, collections, deposits, expenses and estimated profit, a daily chart, recent transactions and significant changes | **Done** |
| 7 | History screen with search by product, customer, supplier, bill or receipt, filters by date, module, action and user, before/after changes, links between records and transactions, CSV/PDF export; history on each record; every refused action recorded; automatic backups with retention; restore with checks, a copy of the current data first, and automatic undo of an unfinished restore; history and accounting completeness checks | **Done** |
| 8 | Recovery tests (the process killed in the middle of sales, payments, purchases and backups; upgrades from every earlier version and over a populated database; long randomized operation sequences); performance run on a two-year, 100,000-bill shop and the fixes it led to (a memory leak, data and backup checks moved off the main thread, fast customer screens, an upgrade notice); setting up a new computer from a backup; usability check at 1366 × 768; Windows installer with an app icon; install/upgrade/uninstall test with a network check; user, installation, backup and upgrade guides and a test report | **Done** |
| 1.1 | Editing a purchase: the corrected bill is saved as a new version and the old one is kept, with a full before/after history | **Done** |
| 1.2 | Optional AI assistant: scan a supplier's bill (photo or PDF) into a draft purchase through OpenRouter, with the owner's own key and model; offline matching to the shop's suppliers and products; new items added from the bill with their selling price; the supplier's item names remembered for the next bill | **Done** |

## Development

Requirements: Windows 10/11, Node.js 22 or newer.

```bash
npm install          # also prepares the SQLite native module for Electron
npm run dev          # run with hot reload
npm test             # unit + integration tests (real SQLite, inside Electron's Node)
npm run test:e2e     # builds, then drives the real app with Playwright
npm run typecheck
npm run build        # production bundles in out/
npm run perf         # performance run on a large generated shop (first run generates it, ~10 min)
npm run dist         # Windows installer in release/
npm run test:install # builds test installers, then installs, upgrades and uninstalls them
```

While developing, set `HWS_DATA_DIR` to a scratch folder so you don't touch real shop data:

```powershell
$env:HWS_DATA_DIR = "$env:TEMP\hws-dev"; npm run dev
```

If your editor sets `ELECTRON_RUN_AS_NODE` (VS Code does in its terminals), clear it before `npm run dev`. Otherwise Electron starts as plain Node.

## Where data lives

| What | Where |
|---|---|
| Database | `%APPDATA%\HardwareShop\data\shop.db` |
| Technical log | `%APPDATA%\HardwareShop\logs\main.log` |
| Backups (default) | `Documents\HardwareShop Backups` (configurable) |

## Documentation

- [docs/USER_GUIDE.md](docs/USER_GUIDE.md): everyday use, for the owner and staff
- [docs/INSTALL.md](docs/INSTALL.md): installing, first start, uninstalling
- [docs/BACKUP_RECOVERY.md](docs/BACKUP_RECOVERY.md): backups, restore, moving to a new computer, what to do when something goes wrong
- [docs/UPGRADING.md](docs/UPGRADING.md): installing new versions without losing data; rules for database changes
- [docs/TEST_REPORT.md](docs/TEST_REPORT.md): what is tested, performance measurements, release checks
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the application is put together
- [docs/BUSINESS_RULES.md](docs/BUSINESS_RULES.md): money, tax, stock, rental and correction rules
- [docs/SCHEMA.md](docs/SCHEMA.md): database tables and conventions
