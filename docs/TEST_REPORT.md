# Test Report

What is tested, how, and the results of the release checks. Every result here comes from an actual run; the date of the run is given with each section.

## How to run the tests

| Command | What it runs | Time |
|---|---|---|
| `npm run typecheck` | TypeScript checks of the main process, renderer and tests | ~30 s |
| `npm test` | Unit and integration tests on real SQLite database files, inside Electron's Node | ~15 s |
| `npm run test:e2e` | Builds the app, then drives it end to end with Playwright on isolated data folders | ~2 min |
| `npm run perf` | Performance run on a generated two-year shop (generated once, then cached) | ~10 min first time |
| `npm run test:install` | Builds test installers, then installs, runs, upgrades and uninstalls the app | ~6 min |

`npm test -- upgradeCopy` with `HWS_UPGRADE_FROM` set to a shop's `shop.db` upgrades a **copy** of that shop's data and checks nothing was lost (see [UPGRADING.md](UPGRADING.md)).

## Coverage of the required test scenarios

The scenarios listed in section 22 of the specification, with the tests that cover them. *I* = integration test (services on a real database), *E* = end-to-end test (the built application), *U* = unit test.

### Inventory

| Scenario | Tests |
|---|---|
| Add a product | I `inventory`: creates a product with an automatic code, opening stock, ledger entry and history · E `products` |
| Receive stock | I `inventory`: keeps the weighted average through receipts and issues · E `products` |
| Adjust stock | I `inventory`: requires a reason for corrections; applies an adjustment once even if sent twice · E `products` |
| Sell a product | I `sales`: finalizes a paid walk-in sale with stock, tax, cost and ledger entries · E `sales` |
| Process a customer return | I `sales`: processes a return with a credit note; refunds a paid walk-in return · E `sales` |
| Record damaged stock | I `inventory`: requires a reason · E `products` (damage with reason) |
| Prevent sales beyond available stock | I `sales`: refuses a sale beyond available stock and leaves nothing behind · I `inventory`: prevents removing more than is in stock |
| Verify stock movement history | I `inventory`: records the user, time, reason and link for every movement; cannot be altered |
| Change prices without altering historical invoices | I `sales`: keeps historical invoice prices when the product price changes · I `inventory`: records price changes with before and after values |

### Sales and payments

| Scenario | Tests |
|---|---|
| Create an invoice, calculate taxes | U `billing` (inclusive/exclusive GST, CGST/SGST split, IGST, round-off) · I `sales` · E `sales` |
| Apply discounts | U `billing` · I `sales`: applies discounts within the role limit and refuses larger ones |
| Finalize a sale, record full payment | I `sales` · E `sales` |
| Record partial payments | I `sales`: records partial payment, due date, overdue status and later payments |
| Process refunds | I `sales`: refunds account credit; refunds a paid walk-in return |
| Cancel or reverse a transaction | I `sales`: cancels a walk-in sale; reverses a payment and reopens what it settled · E `sales` |
| Prevent duplicate invoices and payments | I `sales`: never creates the same invoice twice; does not record the same payment twice · I `randomized`: replayed sales create nothing |
| Reconcile customer balances | I `reports`: customer and supplier balances match receivables and payables · data check `customer-balances` after every scenario |
| Payment methods reported correctly | I `reports`: expenses, cash, payment methods and GST match their accounts |

### Rentals

| Scenario | Tests |
|---|---|
| Create rental assets | I `rentals`: creates an item with rates and tagged units, each with an event trail |
| Issue an item | I `rentals`: issues a unit (charge invoiced, deposit held as a liability) · E `rentals` |
| Prevent double booking | I `rentals`: never books the same unit twice; refuses an extension into another booking |
| Extend a rental | I `rentals`: charges only the extra time, records old and new dates · E `rentals` |
| Flag overdue rentals, calculate late fees | I `rentals`: flags overdue rentals and charges late fees; no fee within the grace period · U `rentalPricing` |
| Record a return, a damaged item | I `rentals`: records a damaged return: charge, unit out of service, deposit used, rest refunded · E `rentals` |
| Collect and refund a deposit, valid deduction | I `rentals` · E `rentals` |
| Reconcile rental balances | I `reports`: deposits held equal the deposit liability; rental income agrees three ways |
| Verify complete rental history | I `rentals`: keeps a complete history of the rental and each unit |

### Purchases and suppliers

| Scenario | Tests |
|---|---|
| Create a supplier, record a purchase, update stock | I `purchases`: receives stock at landed cost, keeps input GST out of cost · E `purchases` |
| Record supplier payments | I `purchases`: pays at entry, settles the oldest bills first, uses an advance |
| Process supplier returns | I `purchases`: credits the supplier, reverses input GST, removes stock at average cost |
| Verify supplier outstanding balances | I `purchases`, I `reports`: supplier balances match payables |
| Edit a purchase, keeping its history | I `purchaseEdit`: a corrected version is saved and the earlier one kept; stock, input GST, accounts and what is owed follow the correction, dated on the bill's day; payments carry over; only changed products move stock; after sales, stock is corrected at average cost and an edit bringing in less than was sold is refused; repeated edits number -R2, -R3 and only the newest can be changed; refusals for returned, cancelled or unchanged bills and duplicate bill numbers; each edit recorded with every change, the user and the reason · I `randomized`: edits mixed into the random sequences · E `purchaseEdit` |
| Scan a supplier's bill into a purchase (optional AI, 1.2) | U `billRead`: amounts, dates, GST slabs, GSTINs, discounts and malformed answers · U `itemMatch`: abbreviations, sizes and units, a different size or number never matched, unit mapping, the network allowance · I `aiScan` (OpenRouter replaced by a stand-in): the key stored encrypted and never in the database, history or settings; connection test; refusals when off, without key or model, and over the monthly limit; only the bill is sent; supplier by GSTIN or name; matching and remembered names; a bill already recorded; every failure explained and recorded; PDF and models without structured output; data check clean after saving · E `billScan`: settings, scan, new supplier from the bill, a line pointed to an existing product, a line left out, a new product added only after its selling price is typed, stock brought in, the next bill matched by itself, history, item names, and the network limits |

### History

| Scenario | Tests |
|---|---|
| Before-and-after values for edits; timestamps and users | I `foundation`: records before and after values with the responsible user, and redacts secrets · E `foundation`, E `products` |
| Stock movements linked to their causes | I `inventory`: records the user, time, reason and link for every movement |
| Finalized transactions cannot be silently erased | I `sales`: cannot alter or delete issued invoices and payments · I `purchases`, I `inventory` (triggers) |
| Corrections preserve original records | I `sales` (cancellations, credit notes, reversals) · I `expenses`: a correction reverses the original on its own date |
| Audit records cannot be edited | I `foundation`: cannot be edited or deleted · data check `immutability-triggers` |
| History survives restarts | E `foundation`: restart persistence · I `foundation`: survives closing and reopening |
| Backup restoration preserves history | I `protection`: restore brings back the data and history and records the restore · E `protection` |
| Searching and exporting history | I `protection`: finds entries by product name or code, by record including linked entries, by transaction and by user; exports · E `protection` |

### Offline

| Scenario | Tests |
|---|---|
| Install and launch without internet access | Installer test: the installed app refuses network requests, and none of its processes holds a remote network connection (checked with Windows' own connection list) |
| Create and edit products, complete a sale, issue and return rentals, invoices and reports, back up and restore offline | Every end-to-end test runs with all network requests blocked by the application; `foundation` checks that a request is refused |
| Restart and verify persistence | E `foundation` · installer test (upgrade keeps data) |
| The optional AI assistant (1.2) reaches nothing but OpenRouter | U `itemMatch`: only `https://openrouter.ai/api/v1/…` is allowed · E `billScan`: with the assistant set up, the windows' requests are still refused and the assistant's own session refuses any other address · installer test: with the assistant off (the default), no process holds a remote connection |

### Recovery

| Scenario | Tests |
|---|---|
| Interrupt a database operation; application closure during a transaction | I `recovery`: a separate process running a sale, a payment, a purchase or a backup is killed part way through, without a clean close; the database afterwards is exactly as before (every row of every table compared), the data check passes, and the same operation then completes with gap-free numbering |
| Restore a valid backup | I `protection` · E `protection` (from the backup list, and on a new computer from the first screen) |
| Test a corrupt backup | I `backup`: rejects a corrupt file, an altered file, foreign files · I `protection`: a damaged backup is refused and nothing changes |
| Migrations preserve existing records | I `recovery`: upgrades from every earlier version; a populated database keeps every row of every table and its history; nothing changes if the backup before upgrading fails · I `upgradeCopy` on a copy of a real shop's data |
| Duplicate records and inconsistent balances | I `randomized`: 1,200 random operations (sales, payments, returns, cancellations, reversals, stock adjustments, purchases, supplier payments and returns, rentals, extensions, returns, expenses) over three seeds; full data check every 50 steps, gap-free numbers for every document type, no negative stock, refused operations change nothing, replayed requests create nothing |
| Interrupted restore | I `protection`: undoes a restore the application did not finish; puts the data back when the restored file cannot be upgraded |

### Other checks

- **Permissions:** I `protection`: every command has a handler; exactly the expected commands are open without sign-in or to any signed-in user; a sales employee is refused, and the refusal recorded, for every command their role lacks.
- **Usability at 1366 × 768:** E `screens`: 25 main screens open with data, without errors and without the page scrolling sideways; quick typing at the counter adds every item.
- **Data check after scenarios:** most integration tests end with the full data check (stock, ledger, invoice and purchase totals, allocations, balances, deposits, GST, history and accounting completeness), which must report no problems.

## Performance (run on 26 October 2026)

Measured with `npm run perf` on a laptop with an Intel Core i5-12450H, 16 GB RAM and an NVMe SSD, running Windows 11. The database is opened with the application's own settings (including `synchronous=FULL`, so every saved bill is on disk before it is confirmed).

**The dataset:** two years of a busy shop, generated through the application's own services, one transaction per operation, in date order.

| | |
|---|---|
| Products | 30,000 |
| Customers | 3,001 |
| Bills | 1,02,745 (3,02,842 lines) |
| Stock movements | 3,36,717 |
| Payments and refunds | 1,13,789 |
| Accounting entries | 14,17,477 |
| History entries | 2,56,648 |
| Purchases / rentals / returns / expenses | 849 / 2,340 / 622 / 1,018 |
| Database size | 865 MB |
| Full data check | no problems |

**Results** (milliseconds; 95th percentile = 19 runs out of 20 are at least this fast):

| Operation | Median | 95th pct | Limit |
|---|---:|---:|---:|
| Product search (by words, code, or no match) | 26–33 | 29–39 | 50 |
| Product list, first page / page 300 | 9 / 26 | 12 / 32 | 100 |
| Products low or out of stock | 57 | 74 | 200 |
| Customer search by name or phone | 4 | 5 | 50 |
| Customers who owe money | 362 | 437 | 500 |
| **Save a 3-line counter bill** | **6** | **27** | 100 |
| Save a credit bill | 5 | 18 | 100 |
| Receive a payment (settles the oldest bills) | 4 | 8 | 100 |
| Open a bill / a customer / the walk-in customer | 0.1 / 0.3 / 6 | 0.1 / 0.7 / 9 | 50 / 100 / 100 |
| Customer account, all time | 0.4 | 0.5 | 500 |
| Dashboard: today / this month / 12 months | 129 / 214 / 954 | 146 / 278 / 1,114 | 300 / 500 / 2,000 |
| Dashboard recent transactions | 56 | 70 | 200 |
| History: newest entries / one customer's | 0.4 / 0.1 | 0.6 / 0.1 | 100 / 200 |
| History text search ("hammer", a bill number) | 492 / 565 | 626 / 734 | 1,500 |
| Each of the 51 reports for 12 months | 0.2–1,242 | | 10,000 |
| Open the database at start-up | 2 | 3 | 1,000 |

The slowest reports for 12 months are customer balances (1.2 s), stock valuation (1.1 s), and the income and monthly profit summaries (0.8 s). Reports run in the background worker, so the window stays usable meanwhile.

**Background work** (runs off the main thread, so the window stays responsive meanwhile): the quick data check after every start takes 12 s, the full data check 29 s, and a verified backup of the whole 865 MB database 26 s. Upgrading this database from version 7 to 8 (one new index) took 13 s.

The history text search reads every history entry, so its limit is 1.5 s rather than the 0.5 s first set. It is a search screen, not a counter operation. Everything else is measured against the limits first chosen.

**Memory:** the application process stays at about 150–200 MB while working through the whole dataset.

## Problems found by the Phase 8 tests, and fixed

| Found by | Problem | Fix |
|---|---|---|
| Performance run | **Memory grew without limit** while the application stayed open: the SQLite library keeps every prepared statement until its connection closes (measured: 2.7 KB per call, 5.3 GB during data generation). | Each SQL text is prepared once per connection and reused (`openDatabase`). Memory now stays flat; a test checks that statements are reused. |
| Performance run | **The window froze** on a large shop: the quick data check after every start (12 s), the full data check (29 s) and verifying every backup, including automatic ones (26 s), ran on the main thread. | They run in the background worker. |
| End-to-end tests | The data check, moved to the worker, **wrongly reported file damage**: a read-only connection kept open while the application writes can hold an out-of-date picture of the product search index. | Each check uses a freshly opened connection. |
| Performance run | **Customer list and search took 1.7 s**, opening a customer 1.1 s, and a customer statement up to 27 s: balances were summed for every customer, and the database chose the wrong index. | Balances are worked out only for the customers shown; new index (migration 008). Now 4 ms, under 1 ms, and well under 1 s. |
| Performance run | A return on a walk-in bill looked through **every counter sale ever made** to find credit. | The credit note and bill concerned are looked up directly (under 1 ms). |
| Performance run | Upgrading a large shop showed **no window for about 40 s** (backup, then upgrade). | An "Updating the shop data…" notice is shown meanwhile. |
| Crash tests | A backup interrupted by a crash left a stray `.partial` file. | Removed at the next start. |
| Usability check | Typing quickly at the counter, pressing Enter before the list appeared, could **drop an item or add a half-typed one**. | Enter looks up exactly what was typed; a test types three items quickly. |
| Usability check (1366 × 768) | The new-rental screen opened scrolled to the bottom; the **Save bill** button sat below the window edge. | Fixed; Save bill stays in view. |
| Install test | The version shown in the application was fixed at build time. | The installed package's version is shown. |
| Release build | A packaging setting meant to make the installer smaller made the packager include the whole project folder (source code, tests, earlier builds: a 7 GB archive). | Setting removed. `npm run dist` and the test installers now fail unless the app archive holds only the built application and its runtime modules (`scripts/check-package.mjs`); the archive is 38 MB, the installer 124 MB. |
| Moving to a new computer | Restoring needed the setup steps to be completed with throwaway details first. | **Restore from a backup…** on the first screen. |

## Release checks (26 October 2026)

| Check | Result |
|---|---|
| `npm run typecheck` | No errors |
| `npm test` | 236 passed (1 skipped: the optional upgrade of a real shop's data, run separately below) |
| `npm run test:e2e` | 10 of 10 passed |
| `npm run perf` | Every operation within its limit (see Performance) |
| `npm run test:install` | Passed (installers 1.0.0 and 1.0.1, 124 MB each, package check passed): silent install; the installed application set up a shop, saved a bill and a backup, refused network requests, and none of its processes held a network connection; installing the next version over it kept all data and history and showed the new version; uninstalling removed the program and its shortcuts and kept the shop data and backups |
| Upgrade of a real shop's data | A copy of the data from the version 0.1.0 installed on the development computer (data version 4) upgraded to version 8: every row kept, verified backup first, data check clean. The original file was only read. |

### Not covered by automated tests

- **A clean second computer.** The installer was tested on the development computer only (Windows 11 Home, where Windows Sandbox is not available). Install it once on another Windows 10 or 11 computer before relying on it. The installed application needs nothing else (no runtime, no internet).
- **Disconnecting the network at the Windows level.** That needs administrator rights. Instead, the test confirms that the application refuses network requests and that none of its processes holds a network connection while it runs.
- **Code signing.** The installer is not signed, so Windows SmartScreen warns the first time (see [INSTALL.md](INSTALL.md)).
- **Printers.** Printing goes through Windows' own print dialog. PDF output is tested; printing on the shop's receipt or A4 printer should be checked once on site.

### The release installer

`Hardware Shop Manager Setup 1.0.0.exe`, 123,851,319 bytes, SHA-256 `0EE6E7A131BD86CD4A1D217EC60558576FEBE836FFB0E4C205469733905D6130`. Package check passed; the built application starts on a new data folder and reports version 1.0.0.

## Version 1.1.0: editing purchases (28 October 2026)

| Check | Result |
|---|---|
| `npm run typecheck` | No errors |
| `npm test` | 245 passed (1 skipped, as above), including 8 new tests for editing purchases and purchase edits in the randomized sequences |
| `npm run test:e2e` | 11 of 11 passed, including the new purchase edit test |
| `npm run test:install` | Passed (installers 1.1.0 and 1.1.1, package check passed) |
| Upgrade of a real shop's data | The development computer's shop data, already at version 8 (upgraded by a run of the application on 28 October, with its own backup first), upgraded on a copy to version 9: every row kept, data check clean |
| `npm run perf` | Not run again: editing adds no work to the operations measured |

The release installer is `Hardware Shop Manager Setup 1.1.0.exe`, 123,855,379 bytes, SHA-256 `C25777636A343FC834C537D55A0E01F772D3E341BD54FBEE9263564FF1D044F5`. The package check passed. The built application could not be started from the build folder for a last look, because a copy of the application was open on the same computer (only one can run at a time).

`HWS_INSTALLER_DIR=<folder> npm run test:install` builds the test installers into another folder, for when an editor keeps the previous build's files open.

## Version 1.2.0: scanning supplier bills with AI (29 October 2026)

| Check | Result |
|---|---|
| `npm run typecheck` | No errors |
| `npm test` | 279 passed (1 skipped, as above), including 33 new tests: 21 unit tests (`billRead`, `itemMatch`) and 12 integration tests (`aiScan`) |
| `npm run test:e2e` | 12 of 12 passed, including the new `billScan` test against a local stand-in for OpenRouter |
| `npm run test:install` | Passed (installers 1.2.0 and 1.2.1, package check passed) |
| Upgrade of a real shop's data | A copy of the development computer's shop data upgraded to version 10 (migration 010): every row kept, data check clean |
| `npm run perf` | Not run again: scanning adds no work to the operations measured; matching one bill reads at most 40 candidate products per line through the product search index |
| A real bill with a real OpenRouter key and model | **Not tested.** Needs the owner's own key. The requests follow OpenRouter's documented API (chat completions with an image or a PDF file part, structured output, the models and key endpoints); how well a given model reads a given bill can only be seen with real bills |

The release installer is `Hardware Shop Manager Setup 1.2.0.exe`, 123,873,431 bytes, SHA-256 `7AECAEC6E78106C2903D71B0AEAA244329217D9FA52401141DDE7A0EF5B8ECB5`. The package check passed.
