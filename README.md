# Hardware Shop Manager

Offline desktop software for a hardware and tools shop: sales and GST billing, stock, tool rental, customers, suppliers, expenses, reports, a permanent history of every change, and local backups.

Everything runs on the shop's Windows computer. It needs no internet connection, account or server.

## Status

The application is built in phases. Each phase is tested before the next one starts.

| Phase | Scope | Status |
|---|---|---|
| 1 | Foundation: secure Electron shell, SQLite + migrations, transactions, audit log, users and roles, settings, setup wizard, manual backup and verification, data health | **Done** |
| 2 | Products and stock: catalogue, categories/brands/units, stock movements with weighted-average cost, adjustments, stock counts, low-stock alerts, CSV/Excel import and export | **Done** |
| 3 | Customers and ledgers, counter billing with GST, discounts, split and credit payments, held bills, invoices and receipts (print/PDF), returns and credit notes, cancellations, payments, refunds and reversals, outstanding and ageing | **Done** |
| 4 | Rental items, units and rates, pricing engine, reservations and issue (with a combined sale), double-booking guard, extensions, overdue, return and inspection, late and damage charges, security deposits, close, rental agreement print/PDF, unit history | **Done** |
| 5 | Suppliers, purchases, expenses, cash | Planned |
| 6 | Reports and dashboard | Planned |
| 7 | Full history screens, scheduled backups, restore, permission review | Planned |
| 8 | Release testing, installer, user documentation | Planned |

## Development

Requirements: Windows 10/11, Node.js 22 or newer.

```bash
npm install          # also prepares the SQLite native module for Electron
npm run dev          # run with hot reload
npm test             # unit + integration tests (real SQLite, inside Electron's Node)
npm run test:e2e     # builds, then drives the real app with Playwright
npm run typecheck
npm run build        # production bundles in out/
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

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the application is put together
- [docs/BUSINESS_RULES.md](docs/BUSINESS_RULES.md): money, tax, stock, rental and correction rules
- [docs/SCHEMA.md](docs/SCHEMA.md): database tables and conventions
