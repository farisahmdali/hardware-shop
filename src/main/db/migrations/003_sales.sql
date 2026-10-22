-- 003_sales: customers, invoices, credit notes, payments, allocations, balance adjustments, held bills.
-- Every financial document is append-only. Corrections are new linked rows:
-- cancellations, credit notes, payment reversals, negative allocations and balance adjustments.

CREATE TABLE customers (
  id            INTEGER PRIMARY KEY,
  code          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  phone         TEXT    NOT NULL DEFAULT '',
  address       TEXT    NOT NULL DEFAULT '',
  business_name TEXT    NOT NULL DEFAULT '',
  gstin         TEXT    NOT NULL DEFAULT '',
  state_code    TEXT    NOT NULL DEFAULT '',
  -- NULL means the shop default from settings.
  credit_days   INTEGER CHECK (credit_days IS NULL OR credit_days BETWEEN 0 AND 365),
  -- 0 means no limit. Paise.
  credit_limit  INTEGER NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  notes         TEXT    NOT NULL DEFAULT '',
  is_walkin     INTEGER NOT NULL DEFAULT 0 CHECK (is_walkin IN (0, 1)),
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_customers_phone ON customers (phone);
CREATE INDEX idx_customers_name ON customers (is_active, name COLLATE NOCASE);
CREATE UNIQUE INDEX idx_customers_single_walkin ON customers (is_walkin) WHERE is_walkin = 1;

CREATE TRIGGER customers_no_delete BEFORE DELETE ON customers
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE: customers are deactivated, never deleted');
END;

CREATE VIRTUAL TABLE customers_fts USING fts5(
  code, name, phone, business_name, gstin,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '1 2 3'
);

CREATE TRIGGER customers_after_insert AFTER INSERT ON customers
BEGIN
  INSERT INTO customers_fts (rowid, code, name, phone, business_name, gstin)
  VALUES (NEW.id, NEW.code, NEW.name, NEW.phone, NEW.business_name, NEW.gstin);
END;

CREATE TRIGGER customers_after_update AFTER UPDATE OF code, name, phone, business_name, gstin ON customers
BEGIN
  DELETE FROM customers_fts WHERE rowid = OLD.id;
  INSERT INTO customers_fts (rowid, code, name, phone, business_name, gstin)
  VALUES (NEW.id, NEW.code, NEW.name, NEW.phone, NEW.business_name, NEW.gstin);
END;

-- The walk-in customer receives counter sales that do not need a profile. It never carries a balance.
INSERT INTO customers (code, name, is_walkin, created_at, updated_at)
VALUES ('WALKIN', 'Walk-in customer', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- ---------- Invoices ----------

CREATE TABLE invoices (
  id                  INTEGER PRIMARY KEY,
  invoice_no          TEXT    NOT NULL UNIQUE,
  client_request_id   TEXT    NOT NULL UNIQUE,
  kind                TEXT    NOT NULL DEFAULT 'SALE' CHECK (kind IN ('SALE', 'RENTAL')),
  customer_id         INTEGER NOT NULL REFERENCES customers (id),
  -- Customer details as printed; later edits to the customer never change an issued invoice.
  customer_name       TEXT    NOT NULL,
  customer_phone      TEXT    NOT NULL DEFAULT '',
  customer_address    TEXT    NOT NULL DEFAULT '',
  customer_gstin      TEXT    NOT NULL DEFAULT '',
  customer_state_code TEXT    NOT NULL DEFAULT '',
  shop_state_code     TEXT    NOT NULL,
  is_interstate       INTEGER NOT NULL CHECK (is_interstate IN (0, 1)),
  gst_registered      INTEGER NOT NULL CHECK (gst_registered IN (0, 1)),
  gross_total         INTEGER NOT NULL,
  discount_total      INTEGER NOT NULL CHECK (discount_total >= 0),
  taxable_total       INTEGER NOT NULL,
  cgst_total          INTEGER NOT NULL,
  sgst_total          INTEGER NOT NULL,
  igst_total          INTEGER NOT NULL,
  round_off           INTEGER NOT NULL,
  grand_total         INTEGER NOT NULL CHECK (grand_total >= 0),
  cost_total          INTEGER NOT NULL DEFAULT 0,
  issued_at           TEXT    NOT NULL,
  business_date       TEXT    NOT NULL,
  due_date            TEXT    NOT NULL,
  notes               TEXT    NOT NULL DEFAULT '',
  user_id             INTEGER REFERENCES users (id),
  rental_agreement_id INTEGER,
  linked_invoice_id   INTEGER REFERENCES invoices (id),
  txn_ref             TEXT    NOT NULL,
  CHECK (grand_total = taxable_total + cgst_total + sgst_total + igst_total + round_off)
);
CREATE INDEX idx_invoices_customer ON invoices (customer_id, business_date);
CREATE INDEX idx_invoices_date ON invoices (business_date);
CREATE INDEX idx_invoices_due ON invoices (due_date);

CREATE TABLE invoice_lines (
  id                 INTEGER PRIMARY KEY,
  invoice_id         INTEGER NOT NULL REFERENCES invoices (id),
  line_no            INTEGER NOT NULL,
  line_kind          TEXT    NOT NULL DEFAULT 'PRODUCT' CHECK (line_kind IN ('PRODUCT', 'RENTAL_CHARGE')),
  product_id         INTEGER REFERENCES products (id),
  rental_charge_id   INTEGER,
  sku                TEXT    NOT NULL DEFAULT '',
  name               TEXT    NOT NULL,
  hsn_code           TEXT    NOT NULL DEFAULT '',
  unit_code          TEXT    NOT NULL DEFAULT '',
  qty                INTEGER NOT NULL CHECK (qty > 0),
  unit_price         INTEGER NOT NULL CHECK (unit_price >= 0),
  price_includes_tax INTEGER NOT NULL CHECK (price_includes_tax IN (0, 1)),
  gross              INTEGER NOT NULL,
  line_discount      INTEGER NOT NULL DEFAULT 0 CHECK (line_discount >= 0),
  bill_discount      INTEGER NOT NULL DEFAULT 0 CHECK (bill_discount >= 0),
  taxable            INTEGER NOT NULL,
  gst_rate_bp        INTEGER NOT NULL,
  cgst               INTEGER NOT NULL,
  sgst               INTEGER NOT NULL,
  igst               INTEGER NOT NULL,
  line_total         INTEGER NOT NULL,
  cost_value         INTEGER NOT NULL DEFAULT 0,
  movement_id        INTEGER REFERENCES stock_movements (id),
  UNIQUE (invoice_id, line_no),
  CHECK (line_total = taxable + cgst + sgst + igst)
);
CREATE INDEX idx_invoice_lines_product ON invoice_lines (product_id);

CREATE TABLE invoice_cancellations (
  id            INTEGER PRIMARY KEY,
  invoice_id    INTEGER NOT NULL UNIQUE REFERENCES invoices (id),
  reason        TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  user_id       INTEGER REFERENCES users (id),
  cancelled_at  TEXT    NOT NULL,
  business_date TEXT    NOT NULL,
  txn_ref       TEXT    NOT NULL
);

-- ---------- Credit notes (customer returns) ----------

CREATE TABLE credit_notes (
  id                INTEGER PRIMARY KEY,
  credit_note_no    TEXT    NOT NULL UNIQUE,
  client_request_id TEXT    NOT NULL UNIQUE,
  invoice_id        INTEGER NOT NULL REFERENCES invoices (id),
  customer_id       INTEGER NOT NULL REFERENCES customers (id),
  reason            TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  settlement        TEXT    NOT NULL CHECK (settlement IN ('CREDIT', 'REFUND')),
  taxable_total     INTEGER NOT NULL,
  cgst_total        INTEGER NOT NULL,
  sgst_total        INTEGER NOT NULL,
  igst_total        INTEGER NOT NULL,
  total             INTEGER NOT NULL CHECK (total > 0),
  cost_total        INTEGER NOT NULL DEFAULT 0,
  issued_at         TEXT    NOT NULL,
  business_date     TEXT    NOT NULL,
  user_id           INTEGER REFERENCES users (id),
  txn_ref           TEXT    NOT NULL,
  CHECK (total = taxable_total + cgst_total + sgst_total + igst_total)
);
CREATE INDEX idx_credit_notes_invoice ON credit_notes (invoice_id);
CREATE INDEX idx_credit_notes_customer ON credit_notes (customer_id, business_date);

CREATE TABLE credit_note_lines (
  id              INTEGER PRIMARY KEY,
  credit_note_id  INTEGER NOT NULL REFERENCES credit_notes (id),
  invoice_line_id INTEGER NOT NULL REFERENCES invoice_lines (id),
  qty             INTEGER NOT NULL CHECK (qty > 0),
  restock         INTEGER NOT NULL CHECK (restock IN (0, 1)),
  taxable         INTEGER NOT NULL,
  cgst            INTEGER NOT NULL,
  sgst            INTEGER NOT NULL,
  igst            INTEGER NOT NULL,
  line_total      INTEGER NOT NULL,
  cost_value      INTEGER NOT NULL DEFAULT 0,
  movement_id     INTEGER REFERENCES stock_movements (id),
  CHECK (line_total = taxable + cgst + sgst + igst)
);
CREATE INDEX idx_credit_note_lines_line ON credit_note_lines (invoice_line_id);

-- ---------- Payments ----------

CREATE TABLE payments (
  id                INTEGER PRIMARY KEY,
  payment_no        TEXT    NOT NULL UNIQUE,
  client_request_id TEXT    NOT NULL UNIQUE,
  direction         TEXT    NOT NULL CHECK (direction IN ('IN', 'OUT')),
  purpose           TEXT    NOT NULL CHECK (purpose IN (
                      'RECEIPT', 'REFUND', 'DEPOSIT_COLLECT', 'DEPOSIT_REFUND', 'SUPPLIER_PAYMENT', 'SUPPLIER_REFUND')),
  party_type        TEXT    NOT NULL CHECK (party_type IN ('CUSTOMER', 'SUPPLIER')),
  party_id          INTEGER NOT NULL,
  amount            INTEGER NOT NULL CHECK (amount > 0),
  method_id         INTEGER NOT NULL REFERENCES payment_methods (id),
  reference_no      TEXT    NOT NULL DEFAULT '',
  notes             TEXT    NOT NULL DEFAULT '',
  received_at       TEXT    NOT NULL,
  business_date     TEXT    NOT NULL,
  user_id           INTEGER REFERENCES users (id),
  txn_ref           TEXT    NOT NULL
);
CREATE INDEX idx_payments_party ON payments (party_type, party_id, business_date);
CREATE INDEX idx_payments_date ON payments (business_date);
CREATE INDEX idx_payments_method ON payments (method_id, business_date);

CREATE TABLE payment_reversals (
  id            INTEGER PRIMARY KEY,
  payment_id    INTEGER NOT NULL UNIQUE REFERENCES payments (id),
  reason        TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  user_id       INTEGER REFERENCES users (id),
  reversed_at   TEXT    NOT NULL,
  business_date TEXT    NOT NULL,
  txn_ref       TEXT    NOT NULL
);

-- Customer balance adjustments: opening balances and authorised corrections.
-- Positive amounts increase what the customer owes; negative amounts are credits.
CREATE TABLE balance_adjustments (
  id            INTEGER PRIMARY KEY,
  customer_id   INTEGER NOT NULL REFERENCES customers (id),
  kind          TEXT    NOT NULL CHECK (kind IN ('OPENING', 'ADJUSTMENT')),
  amount        INTEGER NOT NULL CHECK (amount <> 0),
  reason        TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  created_at    TEXT    NOT NULL,
  business_date TEXT    NOT NULL,
  user_id       INTEGER REFERENCES users (id),
  txn_ref       TEXT    NOT NULL
);
CREATE INDEX idx_balance_adjustments_customer ON balance_adjustments (customer_id, business_date);

-- Links money that reduces a balance (payments, credit notes, credit adjustments) to what
-- it settles (invoices, debit adjustments, refunds). Negative rows release an earlier link.
CREATE TABLE allocations (
  id          INTEGER PRIMARY KEY,
  source_type TEXT    NOT NULL CHECK (source_type IN ('PAYMENT', 'CREDIT_NOTE', 'ADJUSTMENT')),
  source_id   INTEGER NOT NULL,
  target_type TEXT    NOT NULL CHECK (target_type IN ('INVOICE', 'ADJUSTMENT', 'REFUND')),
  target_id   INTEGER NOT NULL,
  amount      INTEGER NOT NULL CHECK (amount <> 0),
  reason      TEXT,
  created_at  TEXT    NOT NULL,
  user_id     INTEGER REFERENCES users (id),
  txn_ref     TEXT    NOT NULL
);
CREATE INDEX idx_allocations_source ON allocations (source_type, source_id);
CREATE INDEX idx_allocations_target ON allocations (target_type, target_id);

-- Parked bills at the counter. Not financial records, so they can be deleted.
CREATE TABLE held_bills (
  id          INTEGER PRIMARY KEY,
  label       TEXT    NOT NULL,
  customer_id INTEGER REFERENCES customers (id),
  cart_json   TEXT    NOT NULL CHECK (json_valid(cart_json)),
  created_at  TEXT    NOT NULL,
  user_id     INTEGER REFERENCES users (id)
);

-- ---------- Immutability ----------

CREATE TRIGGER invoices_no_update BEFORE UPDATE ON invoices
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: invoices cannot be changed; cancel or issue a credit note instead'); END;
CREATE TRIGGER invoices_no_delete BEFORE DELETE ON invoices
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: invoices cannot be deleted'); END;
CREATE TRIGGER invoice_lines_no_update BEFORE UPDATE ON invoice_lines
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: invoice lines cannot be changed'); END;
CREATE TRIGGER invoice_lines_no_delete BEFORE DELETE ON invoice_lines
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: invoice lines cannot be deleted'); END;
CREATE TRIGGER invoice_cancellations_no_update BEFORE UPDATE ON invoice_cancellations
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: cancellations cannot be changed'); END;
CREATE TRIGGER invoice_cancellations_no_delete BEFORE DELETE ON invoice_cancellations
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: cancellations cannot be deleted'); END;
CREATE TRIGGER credit_notes_no_update BEFORE UPDATE ON credit_notes
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: credit notes cannot be changed'); END;
CREATE TRIGGER credit_notes_no_delete BEFORE DELETE ON credit_notes
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: credit notes cannot be deleted'); END;
CREATE TRIGGER credit_note_lines_no_update BEFORE UPDATE ON credit_note_lines
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: credit note lines cannot be changed'); END;
CREATE TRIGGER credit_note_lines_no_delete BEFORE DELETE ON credit_note_lines
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: credit note lines cannot be deleted'); END;
CREATE TRIGGER payments_no_update BEFORE UPDATE ON payments
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: payments cannot be changed; reverse them instead'); END;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: payments cannot be deleted'); END;
CREATE TRIGGER payment_reversals_no_update BEFORE UPDATE ON payment_reversals
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: payment reversals cannot be changed'); END;
CREATE TRIGGER payment_reversals_no_delete BEFORE DELETE ON payment_reversals
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: payment reversals cannot be deleted'); END;
CREATE TRIGGER balance_adjustments_no_update BEFORE UPDATE ON balance_adjustments
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: balance adjustments cannot be changed'); END;
CREATE TRIGGER balance_adjustments_no_delete BEFORE DELETE ON balance_adjustments
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: balance adjustments cannot be deleted'); END;
CREATE TRIGGER allocations_no_update BEFORE UPDATE ON allocations
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: allocations cannot be changed'); END;
CREATE TRIGGER allocations_no_delete BEFORE DELETE ON allocations
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: allocations cannot be deleted'); END;

-- ---------- Balances (always derived, never stored) ----------

CREATE VIEW v_invoice_balances AS
SELECT
  i.id AS invoice_id,
  i.customer_id,
  i.grand_total,
  (c.invoice_id IS NOT NULL) AS cancelled,
  COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.target_type = 'INVOICE' AND a.target_id = i.id), 0) AS settled,
  CASE WHEN c.invoice_id IS NOT NULL THEN 0
       ELSE i.grand_total - COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.target_type = 'INVOICE' AND a.target_id = i.id), 0)
  END AS outstanding
FROM invoices i
LEFT JOIN invoice_cancellations c ON c.invoice_id = i.id;

-- Money available to settle something: payments received (not reversed), credit notes, credit adjustments.
CREATE VIEW v_credit_sources AS
SELECT 'PAYMENT' AS source_type, p.id AS source_id, p.party_id AS customer_id, p.amount AS amount, p.business_date,
       p.amount - COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.source_type = 'PAYMENT' AND a.source_id = p.id), 0) AS unallocated,
       (r.payment_id IS NOT NULL) AS reversed
FROM payments p LEFT JOIN payment_reversals r ON r.payment_id = p.id
WHERE p.direction = 'IN' AND p.purpose = 'RECEIPT' AND p.party_type = 'CUSTOMER'
UNION ALL
SELECT 'CREDIT_NOTE', cn.id, cn.customer_id, cn.total, cn.business_date,
       cn.total - COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.source_type = 'CREDIT_NOTE' AND a.source_id = cn.id), 0),
       0
FROM credit_notes cn
UNION ALL
SELECT 'ADJUSTMENT', b.id, b.customer_id, -b.amount, b.business_date,
       -b.amount - COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.source_type = 'ADJUSTMENT' AND a.source_id = b.id), 0),
       0
FROM balance_adjustments b WHERE b.amount < 0;

-- Amounts a customer owes: invoices and debit adjustments (opening balances), with what is still open.
CREATE VIEW v_receivables AS
SELECT 'INVOICE' AS doc_type, ib.invoice_id AS doc_id, ib.customer_id, i.invoice_no AS doc_no, i.business_date, i.due_date,
       i.grand_total AS amount, ib.outstanding, ib.cancelled
FROM v_invoice_balances ib JOIN invoices i ON i.id = ib.invoice_id
UNION ALL
SELECT 'ADJUSTMENT', b.id, b.customer_id, CASE b.kind WHEN 'OPENING' THEN 'Opening balance' ELSE 'Balance adjustment' END,
       b.business_date, b.business_date, b.amount,
       b.amount - COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.target_type = 'ADJUSTMENT' AND a.target_id = b.id), 0),
       0
FROM balance_adjustments b WHERE b.amount > 0;
