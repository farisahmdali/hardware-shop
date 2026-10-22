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
| 14c | Corrections, damage and loss need a reason. Stock received without a purchase bill is valued at the cost entered (default: purchase price) and is credited to owner equity; supplier bills should be entered as purchases once that module is available. | 2 |
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
| 20 | Every denied attempt to perform an action is recorded in the history. | 1 |

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

## Purchases

| # | Rule | Since |
|---|---|---|
| 32 | Recoverable input GST is kept out of inventory cost *(setting)*. Freight and other additional costs are spread across the purchase lines by value. | 5 |
| 33 | A supplier return reduces stock at current average cost and credits the supplier at the agreed value. Any difference goes to the stock-adjustment account. | 5 |

## Users and permissions

| # | Rule | Since |
|---|---|---|
| 34 | There are four roles: Owner, Manager, Sales employee and Inventory employee. The owner always has every permission and can never be locked out. At least one active owner must remain. | 1 |
| 35 | Each role has a maximum discount percentage. | 1 (setting), 3 (enforced) |
| 36 | PINs and passwords are stored only as salted scrypt hashes. Five wrong attempts lock the account for 5 minutes. | 1 |
| 37 | The login screen can be switched off for a single-owner shop *(setting)*. Everything is then recorded as the owner. | 1 |

## Limits of protection

The history is append-only within the application. Anyone with direct access to the database file and SQLite tools could still alter it. A local audit log is therefore strong evidence, not tamper-proof. Protect the computer with a Windows password, and keep backup copies away from the shop computer.

Backups on the same disk protect against mistakes, but not against disk failure or theft. Copy backups to a USB drive regularly.
