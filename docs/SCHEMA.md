# Database schema

The database is a single SQLite file, `shop.db`, changed only by numbered migrations in `src/main/db/migrations/`. Applied migrations are recorded with checksums in `schema_migrations`, and `PRAGMA user_version` holds the schema version.

## Conventions

| Kind of value | Stored as |
|---|---|
| Money | `INTEGER` paise |
| Quantity | `INTEGER` thousandths of a unit |
| Tax rate | `INTEGER` basis points (1800 = 18%) |
| Timestamp | `TEXT` UTC ISO-8601 (`2026-10-21T09:30:00.000Z`) |
| `business_date` | `TEXT` YYYY-MM-DD in shop time |
| Boolean | `INTEGER` 0/1 with a `CHECK` constraint |

Other conventions:

- Every editable row has `created_at`, `updated_at` and `version`. An update must match `version`, which prevents two people silently overwriting each other's edits.
- Primary keys are `INTEGER`. People see codes and document numbers, which are `UNIQUE`.
- Foreign keys are enforced. Rows that history refers to are deactivated (`is_active = 0`), never deleted.
- Append-only tables have `<table>_no_update` and `<table>_no_delete` triggers that abort the statement. The data-health check confirms these triggers exist.

## Migration 001: foundation

| Table | Purpose |
|---|---|
| `roles`, `role_permissions` | The four built-in roles, each with an editable permission set and maximum discount. The owner role is granted everything in code. |
| `users` | Local accounts: scrypt hash of the PIN or password, failed-attempt counter and lock time. |
| `settings` | One JSON row per section: `shop`, `tax`, `app`, `backup`, `stock`, `receivables`. Validated by `src/shared/settings.ts`. |
| `doc_sequences` | Next document number for each document type and financial year. |
| `idempotency_keys` | Stored results of commands that must not run twice. |
| `audit_log` | **Append-only.** When, who, module, record, action, before/after JSON, reason, transaction ref and related record. |
| `backup_history` | Every backup attempt: file, size, SHA-256, schema version and status. |
| `accounts` | Chart of accounts for the double-entry ledger: cash, bank, UPI, card, receivables, payables, GST, deposits, revenue, COGS, expenses and others. |
| `payment_methods` | Cash, UPI, card, bank transfer and cheque, each linked to an account. More can be added. |
| `units` | PCS, BOX, PKT, SET, PAIR, ROLL, BAG, KG, G, M, FT, L and SQFT, each with a flag saying whether decimals are allowed. |
| `categories` | Product, rental and expense categories (expense categories are seeded). |
| `brands` | Product brands. |

### Main audit_log indexes

| Index | Columns | Used for |
|---|---|---|
| `idx_audit_entity` | `(entity_type, entity_id, id)` | A record's own history |
| `idx_audit_time` | `occurred_at` | Date filters |
| `idx_audit_user` | `(user_id, occurred_at)` | "What did this person do?" |
| `idx_audit_txn` | `txn_ref` | All changes in one transaction |
| `idx_audit_related` | `(related_type, related_id)` | Corrections linked to an original |

## Migration 002: products and stock

| Table | Purpose |
|---|---|
| `suppliers` | Basic supplier records (name, phone, GSTIN and others), used as a product's preferred supplier. The purchases module extends them. |
| `products` | The catalogue: code, name, category, brand, unit, HSN, GST rate, whether the price includes GST, purchase price, selling price, minimum stock and preferred supplier. A trigger prevents deletion. |
| `products_fts` | FTS5 search index over code, name, brand, category, HSN and description. Triggers keep it current, including when a brand or category is renamed. |
| `stock_balances` | One row per product: quantity and value at weighted-average cost. **Only the `stock_movements` trigger writes it**; any direct update is refused. |
| `stock_movements` | **Append-only** stock ledger: type, quantity before / change / after, unit cost, value before / change / after, reason, reference, user, time and transaction ref. A movement that does not start from the current balance is refused. |
| `stock_counts`, `stock_count_lines` | Stock counts. Each line stores the system quantity when the count started, the counted quantity, and the system quantity and movement at finalization. Closed counts are locked. |
| `ledger_entries` | **Append-only** double-entry ledger. Each operation posts balanced debit and credit lines that share a transaction ref. Changes in inventory value are posted to the Inventory account. |

## Migration 003: sales

Every table here except `customers` and `held_bills` is **append-only**: triggers refuse updates and deletes.

| Table | Purpose |
|---|---|
| `customers` (+ `customers_fts`) | Customer profiles. One system **walk-in** row takes counter sales and never carries a balance. A trigger prevents deletion. |
| `invoices` | Issued invoices, including a copy of the customer details as printed, place of supply, intra- or inter-state, all totals, cost of goods and due date. A `CHECK` requires total = taxable + taxes + round-off. |
| `invoice_lines` | Product code, name, HSN, unit, price, discounts, taxable value, GST split, line total, cost and the stock movement, as at the time of sale. |
| `invoice_cancellations` | One row per cancelled invoice, with the reason. The invoice itself is never edited. |
| `credit_notes`, `credit_note_lines` | Returns against an invoice: proportional amounts, whether restocked, and how settled (credit or refund). |
| `payments` | Money received (`IN`) and refunds paid (`OUT`), with method, reference and receipt number. |
| `payment_reversals` | One row per reversed payment, with the reason. |
| `balance_adjustments` | Opening balances and authorised corrections (positive = customer owes more). |
| `allocations` | Links money (payments, credit notes, credit adjustments) to what it settles (invoices, opening balances, refunds). Negative rows release an earlier link. |
| `held_bills` | Parked counter bills. These are drafts, not financial records. |

Balances are views, never stored values:

| View | What it returns |
|---|---|
| `v_invoice_balances` | Amount settled and still owed per invoice |
| `v_receivables` | Open invoices and opening balances |
| `v_credit_sources` | Unused payments, credit notes and credits |

## Migration 004: rentals

`allocations` is rebuilt (its views dropped and recreated) so a security deposit can be a source of money. `invoice_lines` gains `revenue_account`, so a rental invoice line credits rental, late-fee or damage income.

| Table | Purpose |
|---|---|
| `rental_products` | Rental items: code (`RI-001`), name, category, deposit per unit, SAC and GST rate. Never deleted, only deactivated. |
| `rental_rates` | Hour, day, week, month or custom-length rates. A rate change retires the old row and inserts a new one. |
| `rental_assets` | Physical units (`RI-001-01`), serial number, purchase cost, condition and status: available, reserved, rented, awaiting inspection, damaged, maintenance or retired. Never deleted. |
| `asset_events` | Append-only history of every unit status change, with the rental it belongs to. |
| `rental_agreements` | Rentals (`RNT/`): customer copy, period, pricing rules as at creation, terms, status. A trigger refuses changes after closing. |
| `rental_items` | Units on a rental, with their rates as at creation, condition out and back, return time and status. |
| `asset_bookings` | The period each unit is held. Insert and update triggers refuse overlapping open bookings. |
| `rental_charges` | Append-only base, extension, late-fee, damage and other charges, with the working and the invoice line that billed them. |
| `rental_extensions` | Append-only record of each new due-back time, with the reason and extra charge. |
| `deposit_transactions` | Append-only deposits collected, applied to charges and refunded, with the payment or invoice involved. |

| View | What it returns |
|---|---|
| `v_deposit_balances` | Deposit held per rental |

## Planned tables (later migrations)

Each later phase adds its own migration. Existing data is never dropped or rewritten destructively.

| Phase | Tables |
|---|---|
| 5 | further supplier columns, `purchases`, `purchase_lines`, `purchase_cancellations`, `supplier_returns`, `supplier_return_lines`, `expenses`, `cash_entries`, `cash_reconciliations` |
