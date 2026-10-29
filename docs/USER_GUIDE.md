# Hardware Shop Manager: User Guide

This guide is for the shop owner and staff. It explains how to do everyday work in the application. Words in **bold** are buttons, tabs or menu items exactly as they appear on screen.

The application works entirely on the shop computer and never needs the internet. The only exception is the optional AI assistant for reading supplier bills (section 9), which is off unless the owner switches it on.

## Contents

1. [First start](#1-first-start)
2. [Signing in and out](#2-signing-in-and-out)
3. [A normal day](#3-a-normal-day)
4. [Selling at the counter](#4-selling-at-the-counter)
5. [Customers, credit and payments](#5-customers-credit-and-payments)
6. [Correcting a sale](#6-correcting-a-sale)
7. [Renting out tools](#7-renting-out-tools)
8. [Products and stock](#8-products-and-stock)
9. [Suppliers and purchases](#9-suppliers-and-purchases)
10. [Expenses and the cash drawer](#10-expenses-and-the-cash-drawer)
11. [Dashboard and reports](#11-dashboard-and-reports)
12. [History](#12-history)
13. [Staff and permissions](#13-staff-and-permissions)
14. [Backups](#14-backups)
15. [When something goes wrong](#15-when-something-goes-wrong)

---

## 1. First start

The first time the application opens, it asks for:

1. **The shop's details:** name, address, state and GSTIN (leave GSTIN empty if the shop is not GST registered). These appear on every bill. Click **Continue**.
2. **The owner's account:** your name and a PIN (4 or more digits) or a password (6 or more characters). Click **Finish setup**.

The application then opens on the Dashboard. Nothing else is filled in: there are no sample products or customers.

**Moving from another computer?** Instead of filling in the shop details, click **Restore from a backup…** on the first screen and choose the old computer's newest backup. Everything comes across: records, history, settings and user accounts. See [BACKUP_RECOVERY.md](BACKUP_RECOVERY.md).

Before the first sale, the owner should check **Backup & Settings**:

- **Billing, tax & stock:** whether prices include GST, rounding of bill totals, and bill numbering.
- **Payments & printing:** the payment methods you accept (cash, UPI, card…) and the printer paper size (A4, or 80 mm / 58 mm receipt rolls).
- **Rental rules:** the grace period and how late returns are charged.
- **Users:** an account for each employee (see [Staff and permissions](#13-staff-and-permissions)).
- **Backup:** where backups are kept (see [Backups](#14-backups)).

## 2. Signing in and out

Each person signs in with their own name and PIN or password, so the history shows who did what. Sign out with the button at the bottom left when you leave the counter.

After 5 wrong PINs in a row, that account is locked for 5 minutes. The owner can set a new PIN for an employee in **Backup & Settings → Users → Reset PIN**. You can change your own PIN in **My account & display**.

A shop with a single owner can switch the sign-in screen off in **Backup & Settings → My account & display → Ask for a PIN when the application opens**. Everything is then recorded under the owner's name.

## 3. A normal day

| When | What to do | Where |
|---|---|---|
| Opening | Check the Dashboard: rentals due back today, overdue rentals, low stock, money owed | **Dashboard** |
| All day | Bills, payments, rentals and returns | **Sales & Billing**, **Rental Transactions**, **Payments & Outstanding** |
| Goods arrive | Enter the supplier's bill | **Suppliers & Purchases → New purchase** |
| Closing | Count the cash drawer | **Expenses & Cash → Cash book → Count cash** |
| Closing | Copy the latest backup to a USB drive (at least once a week) | **Backup & Settings → Backup** |

Backups are made automatically while the application is open. See [Backups](#14-backups).

## 4. Selling at the counter

Open **Sales & Billing**.

1. **Find the product.** Type part of its name, its code (e.g. P-000123) or its brand in the search box (**F3** jumps there). Use the arrow keys and press **Enter** to add it.
2. **Set the quantity.** Change the quantity on the bill line, or type it before the name when searching: `2*led bulb` adds two. Products sold by length or weight (metres, kg) accept decimals.
3. **Choose the customer** (**F4**). For a passer-by, leave it as *Walk-in*; you may type their name and phone. To sell on credit, the customer must be a registered customer.
4. **Discount** (if your role allows): click the discount on a line or on the whole bill. Each role has a maximum discount.
5. **Payment.** Enter the amount received for each method, e.g. part cash and part UPI. For cash, type what the customer handed over and the application shows the change to give.
6. **Save the bill** with **Save bill (F9)**. Stock, accounts and history are updated together, and only then does the screen confirm the sale.
7. **Print.** From the confirmation, **Preview** and print the bill, or **Save PDF**. Start the next bill with **New bill (Enter)**.

Good to know:

- The bill total is worked out with GST (CGST and SGST, or IGST for a customer in another state). The application checks the total again when saving; if a price changed meanwhile, it asks you to **Refresh prices**.
- You cannot sell more than is in stock. The owner can allow an exception, which needs a reason and is recorded.
- **Hold bill** parks a bill (for example while the customer fetches something). Open it again from **Held bills**.
- **F2** starts a new bill.
- Pressing **Save bill** twice, or a slow computer, never creates two bills.

Past bills are under **Sales & Billing → Invoices**. Open one to reprint it, see its payments and returns, or see its history.

## 5. Customers, credit and payments

**Customers** lists every customer with what they owe. Open a customer to see:

- **Account:** the statement of bills, payments and credits, with a running balance. **Statement** and **PDF** print or save it for the customer.
- **Open bills**, **Invoices**, **Payments**, **Details** and **History**.

**Credit sales.** A registered customer can take goods and pay later. Each bill is due after the customer's credit period (30 days unless set otherwise on the customer).

**Receiving a payment.** On the customer, click **Receive payment** (or **Payments & Outstanding → Receive payment**). Enter the amount and method, then **Record payment**. The payment settles the oldest open bills first unless you pick bills yourself. Money paid beyond what is owed stays as the customer's credit (an advance).

**Credit.** A customer's credit (an advance, or the value of returned goods) can be used for open bills with **Use credit for open bills**, or given back with **Refund credit**.

**Money owed.** **Payments & Outstanding** shows **Open bills**, **Ageing by customer** (how long amounts have been owed) and **Payments received**.

## 6. Correcting a sale

A saved bill is never edited or deleted, so the records always add up. Mistakes are corrected with a new, linked record, which keeps the original visible. Each correction asks for a reason and needs the right permission.

| Situation | What to do | Where |
|---|---|---|
| The customer returns some items | **Return items** on the bill: choose the items and quantities, whether they go back into stock, and refund or keep as credit | Open the invoice |
| A bill was made by mistake (nothing returned yet) | **Cancel invoice**: stock comes back, money paid becomes credit (or is handed back for a walk-in) | Open the invoice |
| A payment bounced or was entered wrongly | **Reverse** the payment; the bills it paid become open again | **Payments & Outstanding → Payments received** |
| A customer's balance is wrong for another reason | **Adjust balance** with a reason | Open the customer |

## 7. Renting out tools

**Rental Inventory** holds the items you rent out (for example "Impact drill 13 mm"), their rates (per hour, day, week or month) and deposit, and each physical unit with its own tag, numbered from the item's code (for example …-01, …-02). **Unit board** shows every unit's status at a glance.

**Issuing a rental.** **Rental Transactions → New rental**:

1. Choose the customer (rentals need a registered customer).
2. **Add unit**: only units free for the whole period can be chosen. The application never lets one unit be rented twice at the same time.
3. Set when it is due back. The charge is worked out automatically: the cheapest combination of your rates, after the grace period. The breakdown is shown before you confirm.
4. Enter the deposit and any payment, add products being sold with the rental if needed, then **Issue rental**. Or **Reserve** for later and **Hand over now** when the customer collects.
5. **Print agreement** for the customer to sign.

**While it is out:** the Dashboard and **Rental Transactions** show what is due and what is overdue. **Extend** a rental if the customer keeps it longer; the extra charge is billed then.

**Return:**

1. Open the rental and click **Return items**. For each unit, record its condition. Late time is charged automatically, and you can add a damage charge with a reason.
2. **Settle deposit**: use the deposit for what the customer owes and refund the rest. A deduction or waiver needs permission and a reason.
3. **Close rental** once every unit is back and the deposit is settled.

A damaged unit can be sent for repair (its status becomes *Damaged* or *Maintenance*) and made available again later. Each unit keeps its full history.

## 8. Products and stock

**Products & Stock** lists products with stock and prices. Search by name, code, brand or category, and filter by category, brand or stock level (**Low or out**).

- **Add product:** name, category, unit (pieces, metres, kg…), HSN code, GST rate, selling price, purchase price, minimum stock, and the quantity in stock now. A product code (P-000001…) is given automatically.
- **Edit** a product from its page. Price changes apply to new bills only; old bills keep the price they were sold at. Every change is kept in **Change history**.
- **Adjust stock** on the product page: *Stock received*, *Damaged*, *Lost*, or a correction. Removing stock needs a reason.
- **Stock counts:** **Start stock count**, enter what you count on the shelf, then **Finalize count**. The application corrects the stock to your count and records each difference.
- **Stock movements** shows every movement of every product: why, when, by whom, and the stock before and after.
- **Import** products from Excel or CSV (download the template first), and **Export Excel** / **CSV**.

A product that is no longer sold is made inactive, not deleted, so old bills still show it.

## 9. Suppliers and purchases

**Suppliers & Purchases** has **Purchases**, **To pay**, **Ageing by supplier**, **Payments** and **Suppliers**.

- **New purchase:** choose the supplier, enter their bill number and date, then each product with quantity and cost. Freight and other charges are spread over the items into their cost. GST paid to a registered supplier is kept separately as input tax credit (if the shop is GST registered). Saving adds the stock.
- **Pay supplier** or **Pay this bill:** record what you paid. Payments settle the oldest bills first; extra is kept as an advance.
- **Return goods** on a purchase: sends items back to the supplier and creates a debit note.
- **Edit** a purchase to correct anything on it: the supplier, their bill number or date, items, quantities, rates, GST, discounts, freight or notes. Give the reason for the change. The corrected bill is saved as a new version (for example PUR/2026-27/00012-R2); the bill as it was is kept, marked *replaced*, and the page shows every version. **History** shows exactly what changed, who changed it and why. Stock, what you owe the supplier and GST are corrected automatically, and payments already made count towards the corrected bill. A bill cannot be edited once goods have been returned against it, and the corrected bill cannot bring in fewer goods than have already been sold.
- **Cancel purchase** if a bill was entered by mistake. This is only possible while the goods it brought in are still in stock and none have been returned to the supplier.

### Scanning a supplier's bill with AI (optional)

Instead of typing a bill, you can let an AI model read a photo or PDF of it. You check what it read and save it yourself; the AI never saves anything.

**Setting it up (owner, once):**

1. Create an account at openrouter.ai, add a little credit, and create an API key (**Keys**). Reading one bill usually costs well under a rupee.
2. In **Backup & Settings → AI assistant**, paste the key and click **Save key**. It is kept encrypted on this computer for your Windows user. It is not part of backups, so after setting up a new computer, enter it again.
3. Enter the **AI model**: the model id from openrouter.ai/models. It must be able to read images (for example a Gemini, GPT or Claude model). Switch on **Scan supplier bills with AI**, set how many bills may be scanned per month, and click **Save AI settings**.
4. Click **Test connection**. It checks the key and tells you whether the model can read bills.

Only the bill file you choose is sent, to OpenRouter and the company running the model. Your products, customers, sales and accounts never leave the computer. Every bill read (and every failed attempt) is in **History** with the file name, the model and what it cost, but never the key or the bill itself.

**Scanning a bill:**

1. **New purchase → Scan supplier's bill…** and choose the photo (JPG, PNG, WEBP) or PDF. A clear, straight photo of the whole bill works best. Reading takes a few seconds to a minute; the computer needs the internet only for this.
2. The form is filled in: supplier, their bill number and date, whether rates include GST, each item's quantity, rate, discount and GST, freight and round-off. The bill is shown on the right with its printed total next to the purchase total, and a list of **things to check**. A supplier not yet in the shop can be added from the bill's details with **Add as a new supplier…**.
3. Items the app recognised are in the item list. **Remembered** means the same item was confirmed on an earlier bill from this supplier; **Matched, please check** means the app found it by name, size and HSN code. If a match is wrong, click **Not this product**. A product of a different size is never matched (a ½" pipe is never taken for a 1" pipe).
4. Items not found are listed under **New items on this bill**, and the purchase cannot be saved until each one is decided:
   - **Add as a new product:** the name, unit, HSN code and GST rate come from the bill (change them if needed); type the **selling price**, which the bill cannot tell. **Add all new items** becomes available once every new item has a selling price. New products start with no stock: saving the purchase brings it in.
   - **Point to existing product…** when you already have it under another name: pick one of the similar products shown or search.
   - **Leave out** a line that is not an item (for example a charge already paid). It is listed under the bill so the difference in the total is explained; **Put back** undoes it.
5. Compare with the bill and **Save purchase**. The supplier's names for the items are remembered, so their next bill is matched by itself. **Suppliers → (supplier) → Item names** lists them; **Forget** one that was linked to the wrong product.

## 10. Expenses and the cash drawer

**Expenses & Cash → Expenses:** **Add expense** with its category, amount, date and how it was paid. A mistaken expense can be corrected (the original is kept in its history) or voided with a reason. **Categories** manages the list of expense types.

**Cash book:** shows for any day the cash expected in the drawer: opening, cash sales and payments, refunds, expenses and other cash in or out.

- **Cash in / out:** opening float, money taken by the owner, cash deposited in the bank.
- **Count cash:** count the notes and coins (or type the total). Any difference is recorded as *cash over* or *cash short* with your note.

## 11. Dashboard and reports

The **Dashboard** shows a chosen period (today, this week, this month, this financial year…): sales, money collected, rental income, deposits held, expenses and estimated profit, each shown separately. These are different figures. Money collected is not profit, and deposits are the customers' money, not income. Each tile opens the matching list or report.

**Reports** has about 45 reports in five groups: sales, stock, rentals, money and profit (including GST), and customers and suppliers. Choose the period and filters; sort by clicking a column. **Excel**, **CSV**, **PDF** and **Print** give exactly what is on screen. Reports about costs, profit and GST are only shown to people with permission.

## 12. History

**History & Audit Log** records every significant action: who did it, when, what changed (before and after), and the reason given. Nobody can edit or delete these entries through the application.

- Search by a product, customer or supplier name, a bill, receipt or rental number, or a reason. Filter by date, module, action and user.
- Click an entry to see exactly what changed. **Everything recorded with this change** shows all records saved together (for example a sale, its payment and its stock movements). **Full history of this…** shows one record's whole story.
- **Export CSV** or **Export PDF** saves what is shown.

Most record pages (products, customers, invoices, rentals, suppliers, purchases) also have a **History** tab, and payments, expenses, cash entries and stock counts have a **History** button.

Refused attempts, such as someone trying something their role does not allow, are recorded too.

## 13. Staff and permissions

**Backup & Settings → Users:** **Add user** for each employee, with their role and a starting PIN. Deactivate an account when someone leaves; their history stays.

There are four roles. The owner can change what Manager, Sales and Inventory may do in **Roles & permissions**, including each role's maximum discount.

| Role | By default can |
|---|---|
| Owner | Everything, including restoring backups and managing users. Cannot be locked out. |
| Manager | Everything except users and roles, settings, restoring backups, and allowing a sale beyond the stock |
| Sales employee | Sell, give discounts up to the role limit, add customers, take payments, issue and return rentals, view sales/stock/rental reports, make backups |
| Inventory employee | Products, stock, rental items, suppliers and purchases, view sales/stock/rental reports, make backups |

## 14. Backups

A backup is a complete copy of all shop data and history. Full details are in [BACKUP_RECOVERY.md](BACKUP_RECOVERY.md). In short:

- The application backs up automatically: at the first start of each day, then every 4 hours while it is open. Old automatic backups are removed after a while; manual ones are kept.
- **Back up now** makes one immediately.
- **Copy latest backup to USB…** copies the newest backup to a USB drive. **Do this regularly and keep the drive away from the shop.** A backup on the same computer does not help if the computer fails or is stolen.
- **Restore…** (owner only) replaces all data with a backup. The current data is saved first, so a restore can be undone.

## 15. When something goes wrong

| What you see | What to do |
|---|---|
| "Not enough stock" when billing | Check the product's stock. If goods arrived but were not entered, enter the purchase or a stock adjustment first. |
| "Prices changed" when saving a bill | Click **Refresh prices**, check the total with the customer, and save again. |
| "You do not have permission" | Ask the owner. The attempt is recorded in the history. |
| The power went off during a sale | Start the application again. A sale is either saved completely or not at all. Check **Invoices**: if the bill is not there, make it again. |
| A number looks wrong | Open **Backup & Settings → Data health → Run full check**. It checks stock, accounts, balances and history and lists any problem it finds. |
| The application will not start | Note the message shown. Your data is not changed by a failed start. See [BACKUP_RECOVERY.md](BACKUP_RECOVERY.md). |
| The computer died | Install the application on another computer and restore your latest backup from the USB drive. See [BACKUP_RECOVERY.md](BACKUP_RECOVERY.md). |

### Keyboard shortcuts at the counter

| Key | Action |
|---|---|
| F2 | New bill |
| F3 | Search for a product |
| F4 | Choose the customer |
| F9 | Save the bill |
| ↑ ↓ then Enter | Pick from a search list |
| Esc | Close a list or dialog |
