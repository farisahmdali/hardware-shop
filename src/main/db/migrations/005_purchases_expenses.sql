-- 005_purchases_expenses: supplier accounts, purchase bills, supplier returns (debit notes),
-- supplier payments and what they settle, expenses, cash entries and cash counts.
-- As with sales, every financial document is append-only; corrections are new linked rows.

-- ---------- Suppliers ----------

-- NULL means the shop default from settings.
ALTER TABLE suppliers ADD COLUMN credit_days INTEGER CHECK (credit_days IS NULL OR credit_days BETWEEN 0 AND 365);

CREATE TRIGGER suppliers_no_delete BEFORE DELETE ON suppliers
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE: suppliers are deactivated, never deleted');
END;

-- Supplier opening balances and authorised corrections.
-- Positive amounts increase what the shop owes the supplier; negative amounts are in the shop's favour.
CREATE TABLE supplier_adjustments (
  id            INTEGER PRIMARY KEY,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers (id),
  kind          TEXT    NOT NULL CHECK (kind IN ('OPENING', 'ADJUSTMENT')),
  amount        INTEGER NOT NULL CHECK (amount <> 0),
  reason        TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  created_at    TEXT    NOT NULL,
  business_date TEXT    NOT NULL,
  user_id       INTEGER REFERENCES users (id),
  txn_ref       TEXT    NOT NULL
);
CREATE INDEX idx_supplier_adjustments_supplier ON supplier_adjustments (supplier_id, business_date);

-- ---------- Purchases ----------

CREATE TABLE purchases (
  id                    INTEGER PRIMARY KEY,
  purchase_no           TEXT    NOT NULL UNIQUE,
  client_request_id     TEXT    NOT NULL UNIQUE,
  supplier_id           INTEGER NOT NULL REFERENCES suppliers (id),
  -- Supplier details as on the bill; later edits to the supplier never change a recorded purchase.
  supplier_name         TEXT    NOT NULL,
  supplier_gstin        TEXT    NOT NULL DEFAULT '',
  supplier_state_code   TEXT    NOT NULL DEFAULT '',
  supplier_invoice_no   TEXT    NOT NULL DEFAULT '',
  supplier_invoice_date TEXT    NOT NULL,
  shop_state_code       TEXT    NOT NULL,
  is_interstate         INTEGER NOT NULL CHECK (is_interstate IN (0, 1)),
  prices_include_tax    INTEGER NOT NULL CHECK (prices_include_tax IN (0, 1)),
  -- 1: input GST is recoverable and kept out of stock cost. 0: GST is part of the cost of the goods.
  itc_claimed           INTEGER NOT NULL CHECK (itc_claimed IN (0, 1)),
  gross_total           INTEGER NOT NULL,
  discount_total        INTEGER NOT NULL CHECK (discount_total >= 0),
  taxable_total         INTEGER NOT NULL,
  cgst_total            INTEGER NOT NULL,
  sgst_total            INTEGER NOT NULL,
  igst_total            INTEGER NOT NULL,
  -- Freight, loading and similar charges on the bill, spread across the lines by value.
  additional_costs      INTEGER NOT NULL DEFAULT 0 CHECK (additional_costs >= 0),
  additional_costs_note TEXT    NOT NULL DEFAULT '',
  round_off             INTEGER NOT NULL DEFAULT 0,
  grand_total           INTEGER NOT NULL CHECK (grand_total >= 0),
  -- Total added to the stock value (landed cost).
  inventory_value       INTEGER NOT NULL,
  received_at           TEXT    NOT NULL,
  business_date         TEXT    NOT NULL,
  due_date              TEXT    NOT NULL,
  notes                 TEXT    NOT NULL DEFAULT '',
  user_id               INTEGER REFERENCES users (id),
  txn_ref               TEXT    NOT NULL,
  CHECK (grand_total = taxable_total + cgst_total + sgst_total + igst_total + additional_costs + round_off)
);
CREATE INDEX idx_purchases_supplier ON purchases (supplier_id, supplier_invoice_date);
CREATE INDEX idx_purchases_date ON purchases (business_date);
CREATE INDEX idx_purchases_due ON purchases (due_date);
CREATE INDEX idx_purchases_supplier_bill ON purchases (supplier_id, supplier_invoice_no);

CREATE TABLE purchase_lines (
  id              INTEGER PRIMARY KEY,
  purchase_id     INTEGER NOT NULL REFERENCES purchases (id),
  line_no         INTEGER NOT NULL,
  product_id      INTEGER NOT NULL REFERENCES products (id),
  sku             TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  hsn_code        TEXT    NOT NULL DEFAULT '',
  unit_code       TEXT    NOT NULL,
  qty             INTEGER NOT NULL CHECK (qty > 0),
  -- Rate per unit as on the supplier's bill.
  unit_cost       INTEGER NOT NULL CHECK (unit_cost >= 0),
  gross           INTEGER NOT NULL,
  line_discount   INTEGER NOT NULL DEFAULT 0 CHECK (line_discount >= 0),
  bill_discount   INTEGER NOT NULL DEFAULT 0 CHECK (bill_discount >= 0),
  taxable         INTEGER NOT NULL,
  gst_rate_bp     INTEGER NOT NULL CHECK (gst_rate_bp BETWEEN 0 AND 10000),
  cgst            INTEGER NOT NULL,
  sgst            INTEGER NOT NULL,
  igst            INTEGER NOT NULL,
  line_total      INTEGER NOT NULL,
  additional_cost INTEGER NOT NULL DEFAULT 0 CHECK (additional_cost >= 0),
  landed_value    INTEGER NOT NULL CHECK (landed_value >= 0),
  movement_id     INTEGER REFERENCES stock_movements (id),
  UNIQUE (purchase_id, line_no),
  CHECK (line_total = taxable + cgst + sgst + igst)
);
CREATE INDEX idx_purchase_lines_product ON purchase_lines (product_id);

CREATE TABLE purchase_cancellations (
  id            INTEGER PRIMARY KEY,
  purchase_id   INTEGER NOT NULL UNIQUE REFERENCES purchases (id),
  reason        TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  user_id       INTEGER REFERENCES users (id),
  cancelled_at  TEXT    NOT NULL,
  business_date TEXT    NOT NULL,
  txn_ref       TEXT    NOT NULL
);

-- ---------- Supplier returns (debit notes) ----------

CREATE TABLE debit_notes (
  id                INTEGER PRIMARY KEY,
  debit_note_no     TEXT    NOT NULL UNIQUE,
  client_request_id TEXT    NOT NULL UNIQUE,
  purchase_id       INTEGER NOT NULL REFERENCES purchases (id),
  supplier_id       INTEGER NOT NULL REFERENCES suppliers (id),
  reason            TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  -- ADJUST: reduces what the shop owes the supplier. REFUND: the supplier pays the money back.
  settlement        TEXT    NOT NULL CHECK (settlement IN ('ADJUST', 'REFUND')),
  taxable_total     INTEGER NOT NULL,
  cgst_total        INTEGER NOT NULL,
  sgst_total        INTEGER NOT NULL,
  igst_total        INTEGER NOT NULL,
  total             INTEGER NOT NULL CHECK (total > 0),
  -- Stock value removed, at weighted-average cost.
  cost_total        INTEGER NOT NULL DEFAULT 0,
  issued_at         TEXT    NOT NULL,
  business_date     TEXT    NOT NULL,
  user_id           INTEGER REFERENCES users (id),
  txn_ref           TEXT    NOT NULL,
  CHECK (total = taxable_total + cgst_total + sgst_total + igst_total)
);
CREATE INDEX idx_debit_notes_purchase ON debit_notes (purchase_id);
CREATE INDEX idx_debit_notes_supplier ON debit_notes (supplier_id, business_date);

CREATE TABLE debit_note_lines (
  id               INTEGER PRIMARY KEY,
  debit_note_id    INTEGER NOT NULL REFERENCES debit_notes (id),
  purchase_line_id INTEGER NOT NULL REFERENCES purchase_lines (id),
  qty              INTEGER NOT NULL CHECK (qty > 0),
  taxable          INTEGER NOT NULL,
  cgst             INTEGER NOT NULL,
  sgst             INTEGER NOT NULL,
  igst             INTEGER NOT NULL,
  line_total       INTEGER NOT NULL,
  cost_value       INTEGER NOT NULL DEFAULT 0,
  movement_id      INTEGER REFERENCES stock_movements (id),
  CHECK (line_total = taxable + cgst + sgst + igst)
);
CREATE INDEX idx_debit_note_lines_line ON debit_note_lines (purchase_line_id);

-- ---------- What supplier payments settle ----------

-- Links what reduces the shop's debt (payments made, debit notes, corrections in the shop's favour)
-- to what it settles (purchases, amounts owed from opening balances, refunds received). Negative rows
-- release an earlier link. Kept apart from customer allocations so the two sides are never netted.
CREATE TABLE supplier_allocations (
  id          INTEGER PRIMARY KEY,
  source_type TEXT    NOT NULL CHECK (source_type IN ('PAYMENT', 'DEBIT_NOTE', 'ADJUSTMENT')),
  source_id   INTEGER NOT NULL,
  target_type TEXT    NOT NULL CHECK (target_type IN ('PURCHASE', 'ADJUSTMENT', 'REFUND')),
  target_id   INTEGER NOT NULL,
  amount      INTEGER NOT NULL CHECK (amount <> 0),
  reason      TEXT,
  created_at  TEXT    NOT NULL,
  user_id     INTEGER REFERENCES users (id),
  txn_ref     TEXT    NOT NULL
);
CREATE INDEX idx_supplier_allocations_source ON supplier_allocations (source_type, source_id);
CREATE INDEX idx_supplier_allocations_target ON supplier_allocations (target_type, target_id);

-- ---------- Expenses ----------

-- Expenses can be corrected (with reversing ledger entries and a history entry) or voided, never deleted.
CREATE TABLE expenses (
  id                INTEGER PRIMARY KEY,
  expense_no        TEXT    NOT NULL UNIQUE,
  client_request_id TEXT    NOT NULL UNIQUE,
  category_id       INTEGER NOT NULL REFERENCES categories (id),
  description       TEXT    NOT NULL CHECK (length(trim(description)) > 0),
  amount            INTEGER NOT NULL CHECK (amount > 0),
  -- The day the money was spent; the cash book shows it on that day.
  expense_date      TEXT    NOT NULL,
  method_id         INTEGER NOT NULL REFERENCES payment_methods (id),
  payee             TEXT    NOT NULL DEFAULT '',
  reference_no      TEXT    NOT NULL DEFAULT '',
  notes             TEXT    NOT NULL DEFAULT '',
  status            TEXT    NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'VOID')),
  void_reason       TEXT,
  voided_at         TEXT,
  voided_by         INTEGER REFERENCES users (id),
  created_at        TEXT    NOT NULL,
  created_by        INTEGER REFERENCES users (id),
  updated_at        TEXT    NOT NULL,
  updated_by        INTEGER REFERENCES users (id),
  version           INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_expenses_date ON expenses (expense_date);
CREATE INDEX idx_expenses_category ON expenses (category_id, expense_date);
CREATE INDEX idx_expenses_method ON expenses (method_id);

CREATE TRIGGER expenses_no_delete BEFORE DELETE ON expenses
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE: expenses are voided, never deleted');
END;

CREATE TRIGGER expenses_void_final BEFORE UPDATE ON expenses
WHEN OLD.status = 'VOID'
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE: a voided expense cannot be changed');
END;

CREATE TRIGGER expenses_category_kind BEFORE INSERT ON expenses
WHEN (SELECT kind FROM categories WHERE id = NEW.category_id) IS NOT 'EXPENSE'
BEGIN
  SELECT RAISE(ABORT, 'Expense category must be an expense category');
END;

CREATE TRIGGER expenses_category_kind_update BEFORE UPDATE OF category_id ON expenses
WHEN (SELECT kind FROM categories WHERE id = NEW.category_id) IS NOT 'EXPENSE'
BEGIN
  SELECT RAISE(ABORT, 'Expense category must be an expense category');
END;

-- ---------- Cash ----------

-- Cash moved in or out of the drawer other than by sales, payments and expenses.
CREATE TABLE cash_entries (
  id                INTEGER PRIMARY KEY,
  entry_no          TEXT    NOT NULL UNIQUE,
  client_request_id TEXT    NOT NULL UNIQUE,
  type              TEXT    NOT NULL CHECK (type IN ('CASH_IN', 'DRAWING', 'BANK_DEPOSIT', 'BANK_WITHDRAWAL')),
  amount            INTEGER NOT NULL CHECK (amount > 0),
  reason            TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  created_at        TEXT    NOT NULL,
  business_date     TEXT    NOT NULL,
  user_id           INTEGER REFERENCES users (id),
  txn_ref           TEXT    NOT NULL
);
CREATE INDEX idx_cash_entries_date ON cash_entries (business_date);

CREATE TABLE cash_entry_reversals (
  id            INTEGER PRIMARY KEY,
  cash_entry_id INTEGER NOT NULL UNIQUE REFERENCES cash_entries (id),
  reason        TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  user_id       INTEGER REFERENCES users (id),
  reversed_at   TEXT    NOT NULL,
  business_date TEXT    NOT NULL,
  txn_ref       TEXT    NOT NULL
);

-- Each count of the cash drawer, with what the records expected at that moment.
CREATE TABLE cash_counts (
  id                 INTEGER PRIMARY KEY,
  business_date      TEXT    NOT NULL,
  counted_at         TEXT    NOT NULL,
  expected           INTEGER NOT NULL,
  counted            INTEGER NOT NULL CHECK (counted >= 0),
  difference         INTEGER NOT NULL,
  denominations_json TEXT    CHECK (denominations_json IS NULL OR json_valid(denominations_json)),
  note               TEXT    NOT NULL DEFAULT '',
  user_id            INTEGER REFERENCES users (id),
  txn_ref            TEXT    NOT NULL,
  CHECK (difference = counted - expected)
);
CREATE INDEX idx_cash_counts_date ON cash_counts (business_date, id);

-- ---------- Immutability ----------

CREATE TRIGGER supplier_adjustments_no_update BEFORE UPDATE ON supplier_adjustments
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: supplier balance adjustments cannot be changed'); END;
CREATE TRIGGER supplier_adjustments_no_delete BEFORE DELETE ON supplier_adjustments
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: supplier balance adjustments cannot be deleted'); END;
CREATE TRIGGER purchases_no_update BEFORE UPDATE ON purchases
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: purchases cannot be changed; cancel or record a supplier return instead'); END;
CREATE TRIGGER purchases_no_delete BEFORE DELETE ON purchases
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: purchases cannot be deleted'); END;
CREATE TRIGGER purchase_lines_no_update BEFORE UPDATE ON purchase_lines
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: purchase lines cannot be changed'); END;
CREATE TRIGGER purchase_lines_no_delete BEFORE DELETE ON purchase_lines
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: purchase lines cannot be deleted'); END;
CREATE TRIGGER purchase_cancellations_no_update BEFORE UPDATE ON purchase_cancellations
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: purchase cancellations cannot be changed'); END;
CREATE TRIGGER purchase_cancellations_no_delete BEFORE DELETE ON purchase_cancellations
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: purchase cancellations cannot be deleted'); END;
CREATE TRIGGER debit_notes_no_update BEFORE UPDATE ON debit_notes
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: debit notes cannot be changed'); END;
CREATE TRIGGER debit_notes_no_delete BEFORE DELETE ON debit_notes
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: debit notes cannot be deleted'); END;
CREATE TRIGGER debit_note_lines_no_update BEFORE UPDATE ON debit_note_lines
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: debit note lines cannot be changed'); END;
CREATE TRIGGER debit_note_lines_no_delete BEFORE DELETE ON debit_note_lines
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: debit note lines cannot be deleted'); END;
CREATE TRIGGER supplier_allocations_no_update BEFORE UPDATE ON supplier_allocations
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: supplier allocations cannot be changed'); END;
CREATE TRIGGER supplier_allocations_no_delete BEFORE DELETE ON supplier_allocations
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: supplier allocations cannot be deleted'); END;
CREATE TRIGGER cash_entries_no_update BEFORE UPDATE ON cash_entries
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: cash entries cannot be changed; reverse them instead'); END;
CREATE TRIGGER cash_entries_no_delete BEFORE DELETE ON cash_entries
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: cash entries cannot be deleted'); END;
CREATE TRIGGER cash_entry_reversals_no_update BEFORE UPDATE ON cash_entry_reversals
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: cash entry reversals cannot be changed'); END;
CREATE TRIGGER cash_entry_reversals_no_delete BEFORE DELETE ON cash_entry_reversals
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: cash entry reversals cannot be deleted'); END;
CREATE TRIGGER cash_counts_no_update BEFORE UPDATE ON cash_counts
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: cash counts cannot be changed'); END;
CREATE TRIGGER cash_counts_no_delete BEFORE DELETE ON cash_counts
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: cash counts cannot be deleted'); END;

-- ---------- Supplier balances (always derived, never stored) ----------

CREATE VIEW v_purchase_balances AS
SELECT
  p.id AS purchase_id,
  p.supplier_id,
  p.grand_total,
  (c.purchase_id IS NOT NULL) AS cancelled,
  COALESCE((SELECT SUM(a.amount) FROM supplier_allocations a WHERE a.target_type = 'PURCHASE' AND a.target_id = p.id), 0) AS settled,
  CASE WHEN c.purchase_id IS NOT NULL THEN 0
       ELSE p.grand_total - COALESCE((SELECT SUM(a.amount) FROM supplier_allocations a WHERE a.target_type = 'PURCHASE' AND a.target_id = p.id), 0)
  END AS outstanding
FROM purchases p
LEFT JOIN purchase_cancellations c ON c.purchase_id = p.id;

-- Amounts the shop owes: purchases and opening balances/corrections in the supplier's favour.
CREATE VIEW v_payables AS
SELECT 'PURCHASE' AS doc_type, pb.purchase_id AS doc_id, pb.supplier_id, p.purchase_no AS doc_no, p.supplier_invoice_no,
       p.supplier_invoice_date AS bill_date, p.due_date, p.grand_total AS amount, pb.outstanding, pb.cancelled
FROM v_purchase_balances pb JOIN purchases p ON p.id = pb.purchase_id
UNION ALL
SELECT 'ADJUSTMENT', a.id, a.supplier_id, CASE a.kind WHEN 'OPENING' THEN 'Opening balance' ELSE 'Balance adjustment' END, '',
       a.business_date, a.business_date, a.amount,
       a.amount - COALESCE((SELECT SUM(x.amount) FROM supplier_allocations x WHERE x.target_type = 'ADJUSTMENT' AND x.target_id = a.id), 0),
       0
FROM supplier_adjustments a WHERE a.amount > 0;

-- What can settle those amounts: payments made (not reversed), debit notes, corrections in the shop's favour.
CREATE VIEW v_supplier_credits AS
SELECT 'PAYMENT' AS source_type, p.id AS source_id, p.party_id AS supplier_id, p.amount AS amount, p.business_date,
       p.amount - COALESCE((SELECT SUM(a.amount) FROM supplier_allocations a WHERE a.source_type = 'PAYMENT' AND a.source_id = p.id), 0) AS unallocated,
       (r.payment_id IS NOT NULL) AS reversed
FROM payments p LEFT JOIN payment_reversals r ON r.payment_id = p.id
WHERE p.party_type = 'SUPPLIER' AND p.direction = 'OUT' AND p.purpose = 'SUPPLIER_PAYMENT'
UNION ALL
SELECT 'DEBIT_NOTE', d.id, d.supplier_id, d.total, d.business_date,
       d.total - COALESCE((SELECT SUM(a.amount) FROM supplier_allocations a WHERE a.source_type = 'DEBIT_NOTE' AND a.source_id = d.id), 0),
       0
FROM debit_notes d
UNION ALL
SELECT 'ADJUSTMENT', s.id, s.supplier_id, -s.amount, s.business_date,
       -s.amount - COALESCE((SELECT SUM(a.amount) FROM supplier_allocations a WHERE a.source_type = 'ADJUSTMENT' AND a.source_id = s.id), 0),
       0
FROM supplier_adjustments s WHERE s.amount < 0;

-- ---------- Permissions ----------

INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT id, 'suppliers.adjustBalance' FROM roles WHERE code = 'MANAGER';
