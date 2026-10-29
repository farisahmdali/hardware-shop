# Business rules

These rules decide how money, tax, stock and rentals behave. A rule marked *(setting)* can be changed in Backup & Settings; the text describes its default. The **Since** column shows the phase in which a rule takes effect.

## Money, quantities and time

| # | Rule | Since |
|---|---|---|
| 1 | Amounts are stored as whole **paise**, never as floating point. Each line is rounded to the paisa, with halves rounded away from zero. | 1 |
| 2 | The invoice total is rounded to the nearest rupee *(setting, default on)*. The difference is stored and printed as a separate **round-off** line. | 3 |
| 3 | Quantities are stored as thousandths of a unit. Pieces, boxes and sets take whole numbers only; kg, g, m, ft, L and sq ft allow three decimals. | 1 |
| 4 | Times are stored in UTC. Each record also stores its **business date**, the calendar date in India (Asia/Kolkata), and daily reports group by that date. | 1 |
| 5 | Document numbers run per Indian financial year (April–March) and have no gaps: `INV/2026-27/00001`. A failed operation does not use up a number. | 1 |

## GST

| # | Rule | Since |
|---|---|---|
| 6 | Rates are stored per product in basis points (18% = 1800). | 2 |
| 7 | Prices may include or exclude GST *(setting; per-product override)*. Including GST: taxable value = round(price × 100 / (100 + rate)), and tax = price − taxable value, so the printed total equals the shelf price exactly. | 3 |
| 8 | When the customer's state matches the shop's, CGST = round(tax ÷ 2) and SGST = tax − CGST. When it differs, the whole tax is IGST. | 3 |
| 9 | A bill-level discount is spread across the lines **before** tax is calculated. | 3 |
| 10 | A shop that is not GST-registered issues bills of supply with no tax *(setting)*. | 3 |

## Stock

| # | Rule | Since |
|---|---|---|
| 11 | Stock is valued at **moving weighted-average cost**. Selling price is never used as cost. Cost of goods sold is the sum of the costs of the sale movements. | 2 |
| 12 | Every change to stock is a stock-movement row that records quantity before, change, quantity after, cost, reason, user and source document. The current quantity must always equal the sum of the movements. | 2 |
| 13 | Selling more than is in stock is blocked. An override exists but is off by default *(setting)*; it needs the override permission and a reason. | 2 |
| 14 | Editing a product's price never changes past invoices, which keep their own copies of name, code, price and tax. Every price change is recorded in the product's history as a **Price change** with old and new values. | 2 |
| 14a | Stock balances are changed **only** by stock movements. The database rejects a movement that does not start from the current balance, and rejects any direct edit of a balance. | 2 |
| 14b | Incoming stock without a known cost (e.g. a correction) comes in at the current average cost. When stock reaches exactly zero, all remaining value is removed. After an authorised negative balance, the next receipt resets the average to the incoming cost. | 2 |
| 14c | Corrections, damage and loss need a reason. Stock received without a purchase bill is valued at the cost entered (default: purchase price) and is credited to owner equity. Bills from suppliers are entered as purchases instead (rule 32), so the supplier is owed the amount. | 2 |
| 14d | A stock count compares each counted quantity with the stock **at the moment the count is finalized**, so sales can continue while counting. Products not counted are left unchanged. A finalized count cannot be edited. | 2 |
| 14e | Every inventory value change is posted to the double-entry ledger, so the inventory account always equals the total stock value. Data health checks this. | 2 |
| 14f | Purchase prices, average cost and stock value are shown only to roles that manage products or stock, or that see financial reports. | 2 |
| 14g | Products are deactivated, never deleted. Product codes are generated as P-000001 onward unless a code is typed in; codes are unique regardless of letter case. | 2 |

## Corrections and history

| # | Rule | Since |
|---|---|---|
| 15 | Finalized invoices, payments, stock movements, ledger entries and audit entries can never be changed or deleted. The database itself refuses (triggers). | 1 (audit), 2–5 (others) |
| 16 | Mistakes are corrected with new, linked records: cancellation, return / credit note, payment reversal, or balance adjustment. Each needs a reason and the right permission. | 3 |
| 17 | When an invoice is cancelled, stock comes back at exactly the cost it left with, and revenue, GST and the amount owed are reversed. For a registered customer, money already paid becomes account credit, which can be refunded or used. For a walk-in sale, the payments are reversed (the money is handed back). An invoice that already has returns cannot be cancelled; return the remaining items instead. | 3 |
| 17a | A return (credit note) is worked out line by line, in proportion to what the invoice charged, including discounts and GST, so several partial returns always add up exactly to the original line. Returned items go back into stock at their original cost if they can be resold; damaged items are not restocked. The credit first reduces what is still owed on that invoice. Any remainder is refunded or kept as account credit; walk-in returns are always refunded. | 3 |
| 17b | A payment is reversed (e.g. a bounced cheque or failed UPI) with a reason. The bills it paid become open again and the original payment record is kept. A payment whose credit was refunded cannot be reversed until the refund is reversed. | 3 |
| 18 | Products, customers, suppliers, rates, settings and expenses can be edited. Every edit records the before and after values, the user and an optional reason. Records that history refers to are deactivated, never deleted. | 1 (settings, users), 2–5 |
| 19 | Customer and supplier balances are always calculated from ledger entries. No balance is a figure someone can type over. | 3 |
| 20 | Every refused attempt is recorded in the history with the user and the permission it needed, whether refused at the door (a command the role does not allow) or inside a command (a discount above the role's limit, a report the role may not see). | 1, 7 |
| 20a | The history can be searched by product, customer, supplier or rental item name or code, and by bill, receipt, purchase, credit or debit note, rental, expense, count or cash entry number, as well as by reason and recorded values. It can be narrowed by dates, module, action and user. | 7 |
| 20b | A record's history includes the entries about records linked to it, e.g. a customer's history shows their payments. Every entry written in the same transaction can be shown together. | 7 |
| 20c | The history exports to CSV and PDF exactly as filtered, newest 10,000 entries at most, oldest first. Each export is itself recorded. | 7 |
| 20d | The full data check confirms that every finalized document (bills, cancellations, credit notes, payments and reversals, balance adjustments, stock movements, rentals, deposits, purchases, debit notes, cash entries and counts) has its history entry, and that every document that moves money or stock value has its accounting entries. | 7 |

## Customers and receivables

| # | Rule | Since |
|---|---|---|
| 21 | Walk-in sales need no customer profile. Credit (unpaid or part-paid) sales need a registered customer. | 3 |
| 22 | An invoice falls due after the customer's credit period *(setting, default 30 days)*. Ageing buckets default to 0–30, 31–60, 61–90 and over 90 days *(setting)*. | 3, 6 |
| 23 | Money owed **by** customers and money owed **to** suppliers are kept in separate accounts and are never netted. | 3, 5 |
| 23a | A payment settles the bills chosen for it first, then the oldest open bills (opening balances before invoices on the same day). Anything left over is kept as advance credit. | 3 |
| 23b | Existing credit is used for a new bill only when the cashier chooses to at the counter. Credit from a return or a credit adjustment settles the oldest open bills automatically. On a customer's page, "Use credit for open bills" applies any remaining credit. | 3 |
| 23c | A customer's balance always equals their open bills minus their unused credit. Data health checks this for every customer, and checks that the walk-in customer's balance is zero. | 3 |
| 23d | The sale is refused if a product price changed after the bill was built, or if the total differs from the server's calculation. The cashier refreshes prices and checks the total with the customer. | 3 |
| 23e | Payments at the counter are the amounts kept, never more than the bill. The "Cash received" box only works out the change; it is not recorded. | 3 |
| 23f | A credit limit set for a customer gives a warning at billing; it does not block the sale. | 3 |
| 23g | "Sales today" on the dashboard is the value of invoices issued today (not cancelled), minus returns issued today. It is not the money collected, which is shown separately by payment method. | 3 |

## Rentals

| # | Rule | Since |
|---|---|---|
| 24 | A rental day is a rolling 24 hours from the time of issue. The default grace period is 60 minutes *(setting)*: it is taken off the rental time before rounding up, so returning 40 minutes after a day ends costs one day. A return within the grace period after the due time has no late fee. | 4 |
| 25 | The charge is the **cheapest combination** of the item's active rates that covers the chargeable time (for example 9 days = 1 week + 2 days). The working is shown before the rental is confirmed and printed on the agreement. Other pricing modes *(setting)*: the rate unit chosen per item only, or daily round-up. | 4 |
| 25a | Rates and pricing rules are copied onto each rental when it is created. Changing an item's rates or the rental settings later never changes the price of an existing rental. A rate change keeps the old rate on record. | 4 |
| 25b | Rentals need a registered customer, so the shop can contact them and track the items. Walk-in customers cannot rent. | 4 |
| 26 | Time past the due return (after the grace period) is charged by the late fee rule *(setting)*: the same rates as the rental (default), a fixed amount per started day, or the same-rate charge times a multiplier (default 1.5×). The late fee is shown on return. Reducing or waiving it needs the deposit-deduction permission and a reason; it can never be raised by hand. | 4 |
| 27 | Rental income is recognised when billed, on a rental invoice (`RINV/`) separate from sales invoices: base charges at issue, extensions when granted, and late and damage charges at return. Alternative *(setting)*: bill everything at return, for the time actually used. With billing at issue, an early return does not refund the booked period. | 4 |
| 27a | Rental, late-fee and damage charges post to their own income accounts. A rental invoice cannot be cancelled; a charge is corrected with a credit note against that invoice. | 4 |
| 27b | A reservation holds units for a future period without any charge or deposit. Charges and the deposit are taken when the units are handed over. A reservation can be cancelled with a reason; it is kept on record as cancelled. | 4 |
| 28 | A security deposit is a **liability, not revenue**. It can be applied against the rental's unpaid charges (needs the deposit-deduction permission) and the rest refunded; every movement is recorded with a reason and posted to the ledger. Data health checks that recorded deposits equal the deposit liability account. | 4 |
| 29 | A rental closes only when every unit is back, no unit is awaiting inspection, and the deposit held is zero. If charges are still unpaid, closing needs a confirmation and the amount stays on the customer's account. A closed rental cannot be changed. | 4 |
| 30 | The same unit cannot be booked for overlapping periods. This is checked by the application and again by a database trigger. A unit that is out or overdue stays blocked until it is returned; it is never marked returned automatically. | 4 |
| 30a | On return, each unit's condition is recorded and the unit goes to available, awaiting inspection, damaged or maintenance. A damage charge needs a description. Every status change of a unit is kept in its history. | 4 |
| 31 | A rental that also sells products creates a sales invoice and a linked rental agreement and rental invoice in one step: either all are saved or none. | 4 |

## Purchases and suppliers

| # | Rule | Since |
|---|---|---|
| 32 | A purchase copies the supplier's bill: their bill number and date, each item's quantity, rate, GST rate and discount, and any freight or other charges. Stock comes in at **landed cost**: each line's taxable value plus its share of the charges, spread by value (by quantity if everything was free). | 5 |
| 32a | GST on a purchase is CGST + SGST from a supplier in the shop's state and IGST from another state. A supplier with no GSTIN cannot charge GST. The GST is **claimed** (kept out of stock cost and recorded as recoverable input GST) only when the shop is GST-registered, the supplier has a GSTIN and claiming is switched on *(setting)*. Otherwise the GST is part of the cost of the goods. | 5 |
| 32b | The saved total must equal the calculated total. A round-off of up to ₹10 *(setting)* matches a supplier's rounded total. The same supplier bill number can be recorded only once per supplier (unless that purchase was cancelled). A bill cannot be dated in the future. | 5 |
| 32c | Saving a purchase sets each product's purchase price to its new landed cost per unit (can be switched off per bill). The change is recorded in the product's history. | 5 |
| 32d | A supplier's bill falls due after their credit period *(setting, default 30 days; per-supplier override)*. | 5 |
| 32e | A payment to a supplier settles the chosen bill first, then the oldest open bills. Anything extra stays as an **advance**, which, like an unused debit note, settles the supplier's next bill automatically. A supplier can refund an advance. A payment or refund can be reversed with a reason; the bills it paid become open again. | 5 |
| 32f | A bill entered by mistake is **cancelled** with a reason: the stock comes back out, the amount owed and any claimed input GST are reversed, and payments made against it become an advance. If nothing else has happened to a product since, its stock value is restored exactly; otherwise the stock leaves at the current average cost and the difference goes to stock adjustments. Cancelling is refused when some of the stock has been sold or goods were already returned against the bill. | 5 |
| 32g | A purchase can be **edited**, with a reason. A recorded bill is never changed: the corrected bill is saved as a new **version**, numbered like the original with -R2, -R3… (the bill number sequence is not used again), and the version edited is kept unchanged and marked *replaced*; only the newest version can be edited, cancelled or returned against. Both versions' accounting entries are dated on the bill's own day, so the accounts read as if it had been entered correctly. Stock moves only for products whose quantity or cost changed: what the bill brought in is taken out (at its own cost if nothing else has happened to the product since, otherwise at the average cost, with the difference to stock adjustments) and the corrected quantity brought in at the corrected cost. Payments made against the bill settle the new version. An edit is refused if the corrected bill would bring in less than has already been sold, if goods were returned against the bill, if it was cancelled, or if nothing changed. | 1.1 |
| 32h | Every edit is recorded in the history with the reason, who made it and when, and each changed detail before and after (supplier, bill number and date, each item's quantity, rate, GST and discount, freight, round-off, notes, totals). A bill's history shows all its versions; each version stays viewable. | 1.1 |
| 32i | **Scanning a supplier's bill (optional).** An AI model reads a photo or PDF of a bill through OpenRouter, using the owner's own API key and chosen model. It only fills in the purchase form: nothing is saved until a person checks it and saves it as an ordinary purchase, with every rule above. Only the bill file is sent; no shop data. It is off by default *(setting)*, and it is refused without a key, without a model, or after the monthly number of scans *(setting, default 200; failed attempts count)*. Only roles that record purchases can scan. | 1.2 |
| 32j | What is read is checked, never trusted: amounts, quantities, dates (day first) and GSTINs are parsed and validated; GST rates are taken only as valid slabs (CGST or SGST alone is doubled); the shop's own GSTIN is never taken for the supplier's; a date in the future, an invalid GSTIN, a bill number already recorded for the supplier and anything unreadable are listed for the person to check. A discount on the whole bill is spread over the items. | 1.2 |
| 32k | Matching is done on the computer. The supplier by GSTIN, then by name. Items: first the name remembered for that supplier (or, failing that, one product remembered for it by any supplier), then the product code, then the closest names, with shop abbreviations expanded and sizes converted (4" = 101.6 mm, 1 kg = 1000 g). A product whose size or model number differs is never offered. Only a remembered name, a code or one clearly best match (score ≥ 75 and 15 ahead of the next) is filled in; everything else must be decided by the person: add it as a new product (its selling price must be typed; it starts with no stock and the purchase brings the stock in), point it to an existing product, or leave it out. | 1.2 |
| 32l | When a purchase filled from a scan is saved, the item text printed on the bill is remembered against the product it was saved as, for that supplier; a name linked to a different product follows the latest choice. A remembered name can be forgotten (recorded in the history). The purchase's history notes the bill file it was filled from. | 1.2 |
| 32m | The OpenRouter key is stored encrypted for the Windows user (Electron safeStorage) in the data folder, outside the database: it is never in backups, exports or the history, and it is never sent to the screen (the settings show only its last four characters). Saving, replacing and removing it are recorded without the key. Each bill read, or failed attempt, is recorded with the file name, size, model, time taken, tokens and cost, never the bill itself. | 1.2 |
| 33 | Goods returned to a supplier get a **debit note**. The supplier is credited each line's share of what the bill charged, including discount and GST, so returns in parts add up exactly; the share of freight is not credited. Stock leaves at the current average cost and any difference goes to stock adjustments. Claimed input GST on the returned goods is reversed. The credit first reduces what is owed on that bill; the rest settles other bills or stays as an advance, or the supplier refunds it. | 5 |
| 33a | Supplier balances are calculated from the ledger: what the shop owes = open bills − advances and unused debit notes. Data health checks this for every supplier, and checks that recorded input GST matches the bills and returns. | 5 |
| 33b | Purchase bills, supplier balances and supplier payments are shown only to roles that record purchases, pay suppliers or see financial reports. Supplier opening balances and corrections need their own permission. | 5 |

## Expenses and cash

| # | Rule | Since |
|---|---|---|
| 33c | An expense records the category, amount, the date it was paid and how. It appears on that date in the accounts and the cash book. It cannot be dated in the future. | 5 |
| 33d | An expense can be **corrected** with a reason. When the amount, date or method changes, the original entry is reversed and the corrected one posted, each on its own date, and the history keeps both versions. An expense recorded by mistake is **voided**: it stays on record marked void and its entry is reversed. Expenses are never deleted. Data health checks that recorded expenses match the expense account. | 5 |
| 33e | Cash moved in or out of the drawer for other reasons is a **cash entry**: cash added by the owner, owner drawings, bank deposits and bank withdrawals, each with a reason. An entry cannot take out more cash than the records show. Entries are reversed with a reason, never edited or deleted. | 5 |
| 33f | The **cash book** for a day is worked out from the ledger: opening cash (the end of the previous day), money in and out by kind, and the cash that should be in the drawer. UPI, card, bank and cheque movements that day are shown separately for reference. | 5 |
| 33g | A **cash count** is compared with what the records expect at that moment. A difference needs an explanation and is posted to cash over / short, so the expected cash matches the count from then on. Counts are kept as they were recorded. | 5 |

## Reports and dashboard

| # | Rule | Since |
|---|---|---|
| 33h | Every report and dashboard figure is worked out from the stored records when it is opened. Nothing is typed in or stored as a total. Reports only read; they run in a background worker on a read-only connection, so a long report never holds up billing. | 6 |
| 33i | **Sales** are product sales invoices by invoice date, including GST, with cancelled invoices left out and returns subtracted on the day of the credit note. Rental bills are reported separately. Sales are not money collected and not profit. | 6 |
| 33j | **Money collected** is payments received from customers, less payments reversed (on the day of the reversal). Refunds and rental security deposits are shown separately. | 6 |
| 33k | The **income and profit summary** follows the accounts: revenue excluding GST (product sales less returns, rental charges, late fees, damage charges), less cost of goods sold at weighted-average cost, gives gross profit; less operating expenses, stock write-offs, cash over/short, balance adjustments and round-off, gives an estimated net profit. Cancellations, returns and corrections count on the day they are made. | 6 |
| 33l | Purchases are not costs in the profit figures: stock bought becomes cost of goods sold only when it is sold, so nothing is counted twice. GST collected and input GST are shown for reference, never as income or cost. Security deposits are a liability, never income. | 6 |
| 33m | Stock valuation uses moving weighted-average cost and can be shown for any past date (the stock after the last movement on that date). Retail value at selling prices is shown only for comparison. Today's valuation equals the inventory account. | 6 |
| 33n | Rental income is counted when billed, under the rental billing rule in force; rental utilisation is the time units were out on rent divided by units × the length of the period. | 6 |
| 33o | Who sees which report: sales, stock quantities, rentals and customer reports need report access; purchase costs and stock value also need permission to see costs; supplier reports need the purchasing or supplier-payment permission; expense and cash reports need those permissions; profit, GST and the other money reports need the financial reports permission. A refused attempt is recorded in the history. | 6 |
| 33p | A report shows at most 10,000 rows. When there are more it says so and asks for a shorter period or a filter; its totals then cover the rows shown. Exports (Excel, CSV, PDF) and printing contain exactly what the screen shows, and each export or print is recorded in the history. | 6 |

## Users and permissions

| # | Rule | Since |
|---|---|---|
| 34 | There are four roles: Owner, Manager, Sales employee and Inventory employee. The owner always has every permission and can never be locked out. At least one active owner must remain. | 1 |
| 35 | Each role has a maximum discount percentage. | 1 (setting), 3 (enforced) |
| 36 | PINs and passwords are stored only as salted scrypt hashes. Five wrong attempts lock the account for 5 minutes. | 1 |
| 37 | The login screen can be switched off for a single-owner shop *(setting)*. Everything is then recorded as the owner. | 1 |

## Backups and restore

| # | Rule | Since |
|---|---|---|
| 38 | Automatic backups are taken while the application is open: at the first start of each day, then every few hours *(setting, default 4)*, counted from the last backup of any kind. A failed attempt is recorded and retried after half an hour. | 7 |
| 39 | Retention: the newest automatic backups *(default 30)* and the newest automatic backup of each day *(default 90 days)* are kept; older automatic backups are deleted. Manual backups, backups made before an upgrade and before a restore are never deleted, nor is the newest backup that passed its check. The history entry of a deleted backup is kept and marked removed, and each clean-up is recorded. | 7 |
| 40 | Restoring needs the restore permission (owner only by default) and the typed word RESTORE. The backup is checked first: a damaged, altered, foreign or newer-version file is refused and nothing changes. | 7 |
| 41 | Before anything is replaced, a verified copy of the current data is saved (kind "before restore"). If that copy cannot be made, nothing is restored. | 7 |
| 42 | A restore is all or nothing. The restored file is opened, upgraded if it comes from an older version, completed with the backups found in the backup folders, checked, and the restore recorded; if any step fails, or the application stops part way, the original data is put back. | 7 |
| 43 | The restore is recorded in the restored data, naming the backup, the copy saved before it and the person who restored it. If that person's account did not exist yet when the backup was taken, the name is recorded without linking to an account. A refused or failed restore is recorded in the data that stays in use. | 7 |
| 44 | After a restore everyone signs in again, because the accounts are those of the backup. | 7 |
| 45 | On a new installation, before the shop is set up, a backup can be restored from the first screen without signing in (moving to a new computer). Once the shop is set up, restoring needs a signed-in user with the restore permission; an attempt to use the first-screen restore is refused and recorded. | 8 |

## Limits of protection

The history is append-only within the application. Anyone with direct access to the database file and SQLite tools could still alter it. A local audit log is therefore strong evidence, not tamper-proof. Protect the computer with a Windows password, and keep backup copies away from the shop computer.

Backups on the same disk protect against mistakes, but not against disk failure or theft. Copy backups to a USB drive regularly.
