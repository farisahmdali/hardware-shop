-- 004_rentals: rental items, rates, physical assets, bookings, agreements, charges, extensions, deposits.

-- ---------- Allow security deposits to settle rental bills ----------
-- SQLite cannot change a CHECK constraint in place, so the allocations table is rebuilt
-- (every row copied unchanged) together with the views that read it.

DROP VIEW v_receivables;
DROP VIEW v_credit_sources;
DROP VIEW v_invoice_balances;

CREATE TABLE allocations_new (
  id          INTEGER PRIMARY KEY,
  source_type TEXT    NOT NULL CHECK (source_type IN ('PAYMENT', 'CREDIT_NOTE', 'ADJUSTMENT', 'DEPOSIT')),
  source_id   INTEGER NOT NULL,
  target_type TEXT    NOT NULL CHECK (target_type IN ('INVOICE', 'ADJUSTMENT', 'REFUND')),
  target_id   INTEGER NOT NULL,
  amount      INTEGER NOT NULL CHECK (amount <> 0),
  reason      TEXT,
  created_at  TEXT    NOT NULL,
  user_id     INTEGER REFERENCES users (id),
  txn_ref     TEXT    NOT NULL
);
INSERT INTO allocations_new (id, source_type, source_id, target_type, target_id, amount, reason, created_at, user_id, txn_ref)
SELECT id, source_type, source_id, target_type, target_id, amount, reason, created_at, user_id, txn_ref FROM allocations;
DROP TABLE allocations;
ALTER TABLE allocations_new RENAME TO allocations;
CREATE INDEX idx_allocations_source ON allocations (source_type, source_id);
CREATE INDEX idx_allocations_target ON allocations (target_type, target_id);
CREATE TRIGGER allocations_no_update BEFORE UPDATE ON allocations
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: allocations cannot be changed'); END;
CREATE TRIGGER allocations_no_delete BEFORE DELETE ON allocations
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: allocations cannot be deleted'); END;

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

-- Deposits are deliberately not credit sources: they are only applied to rental charges on purpose.
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

-- Revenue account per invoice line (rental, late fee, damage...). NULL on older lines means Sales.
ALTER TABLE invoice_lines ADD COLUMN revenue_account TEXT;

-- ---------- Rental items and their physical units ----------

CREATE TABLE rental_products (
  id                 INTEGER PRIMARY KEY,
  code               TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name               TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  category_id        INTEGER REFERENCES categories (id),
  brand              TEXT    NOT NULL DEFAULT '',
  model              TEXT    NOT NULL DEFAULT '',
  description        TEXT    NOT NULL DEFAULT '',
  -- Security deposit per unit, paise.
  deposit_amount     INTEGER NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
  sac_code           TEXT    NOT NULL DEFAULT '997319',
  gst_rate_bp        INTEGER NOT NULL DEFAULT 1800 CHECK (gst_rate_bp BETWEEN 0 AND 10000),
  price_includes_tax INTEGER NOT NULL DEFAULT 1 CHECK (price_includes_tax IN (0, 1)),
  notes              TEXT    NOT NULL DEFAULT '',
  is_active          INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_rental_products_category ON rental_products (category_id);

CREATE TRIGGER rental_products_no_delete BEFORE DELETE ON rental_products
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: rental items are deactivated, never deleted'); END;

-- Rate history: a rate change retires the old row and adds a new one.
CREATE TABLE rental_rates (
  id                INTEGER PRIMARY KEY,
  rental_product_id INTEGER NOT NULL REFERENCES rental_products (id),
  unit              TEXT    NOT NULL CHECK (unit IN ('HOUR', 'DAY', 'WEEK', 'MONTH', 'CUSTOM')),
  unit_minutes      INTEGER NOT NULL CHECK (unit_minutes > 0),
  label             TEXT    NOT NULL DEFAULT '',
  price             INTEGER NOT NULL CHECK (price >= 0),
  created_at        TEXT    NOT NULL,
  retired_at        TEXT
);
CREATE INDEX idx_rental_rates_product ON rental_rates (rental_product_id, retired_at);

CREATE TABLE rental_assets (
  id                INTEGER PRIMARY KEY,
  asset_tag         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  rental_product_id INTEGER NOT NULL REFERENCES rental_products (id),
  serial_no         TEXT    NOT NULL DEFAULT '',
  purchase_cost     INTEGER NOT NULL DEFAULT 0 CHECK (purchase_cost >= 0),
  purchase_date     TEXT,
  condition         TEXT    NOT NULL DEFAULT 'GOOD' CHECK (condition IN ('NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED')),
  status            TEXT    NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN (
                      'AVAILABLE', 'RESERVED', 'RENTED', 'AWAITING_INSPECTION', 'DAMAGED', 'MAINTENANCE', 'RETIRED')),
  notes             TEXT    NOT NULL DEFAULT '',
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_rental_assets_product ON rental_assets (rental_product_id, status);

CREATE TRIGGER rental_assets_no_delete BEFORE DELETE ON rental_assets
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: rental assets are retired, never deleted'); END;

-- Everything that happened to a physical unit. Append-only.
CREATE TABLE asset_events (
  id          INTEGER PRIMARY KEY,
  asset_id    INTEGER NOT NULL REFERENCES rental_assets (id),
  event       TEXT    NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  condition   TEXT,
  notes       TEXT,
  ref_type    TEXT,
  ref_id      TEXT,
  user_id     INTEGER REFERENCES users (id),
  occurred_at TEXT    NOT NULL,
  txn_ref     TEXT    NOT NULL
);
CREATE INDEX idx_asset_events_asset ON asset_events (asset_id, id);
CREATE TRIGGER asset_events_no_update BEFORE UPDATE ON asset_events
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: asset_events rows cannot be changed'); END;
CREATE TRIGGER asset_events_no_delete BEFORE DELETE ON asset_events
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: asset_events rows cannot be deleted'); END;

-- ---------- Rental agreements ----------

CREATE TABLE rental_agreements (
  id                          INTEGER PRIMARY KEY,
  rental_no                   TEXT    NOT NULL UNIQUE,
  client_request_id           TEXT    NOT NULL UNIQUE,
  customer_id                 INTEGER NOT NULL REFERENCES customers (id),
  customer_name               TEXT    NOT NULL,
  customer_phone              TEXT    NOT NULL DEFAULT '',
  status                      TEXT    NOT NULL CHECK (status IN ('RESERVED', 'ACTIVE', 'PARTIALLY_RETURNED', 'RETURNED', 'CLOSED', 'CANCELLED')),
  start_at                    TEXT    NOT NULL,
  original_expected_return_at TEXT    NOT NULL,
  expected_return_at          TEXT    NOT NULL,
  -- Pricing and billing rules in force when the rental was made.
  pricing_json                TEXT    NOT NULL CHECK (json_valid(pricing_json)),
  terms                       TEXT    NOT NULL DEFAULT '',
  notes                       TEXT    NOT NULL DEFAULT '',
  linked_invoice_id           INTEGER REFERENCES invoices (id),
  created_at                  TEXT    NOT NULL,
  created_by                  INTEGER REFERENCES users (id),
  issued_at                   TEXT,
  closed_at                   TEXT,
  closed_by                   INTEGER REFERENCES users (id),
  close_note                  TEXT,
  version                     INTEGER NOT NULL DEFAULT 1,
  CHECK (expected_return_at > start_at)
);
CREATE INDEX idx_rental_agreements_customer ON rental_agreements (customer_id, created_at);
CREATE INDEX idx_rental_agreements_status ON rental_agreements (status, expected_return_at);

CREATE TRIGGER rental_agreements_no_delete BEFORE DELETE ON rental_agreements
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: rental agreements cannot be deleted'); END;
CREATE TRIGGER rental_agreements_closed BEFORE UPDATE ON rental_agreements
WHEN OLD.status IN ('CLOSED', 'CANCELLED')
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: a closed or cancelled rental cannot be changed'); END;

CREATE TABLE rental_items (
  id                 INTEGER PRIMARY KEY,
  agreement_id       INTEGER NOT NULL REFERENCES rental_agreements (id),
  asset_id           INTEGER NOT NULL REFERENCES rental_assets (id),
  rental_product_id  INTEGER NOT NULL REFERENCES rental_products (id),
  product_name       TEXT    NOT NULL,
  asset_tag          TEXT    NOT NULL,
  -- Rates in force when the rental was made; later rate changes do not affect it.
  rates_json         TEXT    NOT NULL CHECK (json_valid(rates_json)),
  sac_code           TEXT    NOT NULL,
  gst_rate_bp        INTEGER NOT NULL,
  price_includes_tax INTEGER NOT NULL,
  deposit_amount     INTEGER NOT NULL DEFAULT 0,
  status             TEXT    NOT NULL CHECK (status IN ('RESERVED', 'OUT', 'RETURNED', 'CANCELLED')),
  condition_at_issue TEXT,
  issued_at          TEXT,
  returned_at        TEXT,
  return_condition   TEXT,
  return_notes       TEXT,
  UNIQUE (agreement_id, asset_id)
);
CREATE INDEX idx_rental_items_asset ON rental_items (asset_id, status);

CREATE TRIGGER rental_items_no_delete BEFORE DELETE ON rental_items
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: rental items cannot be deleted'); END;

-- Time each asset is committed. Two unreleased bookings of one asset may never overlap.
CREATE TABLE asset_bookings (
  id             INTEGER PRIMARY KEY,
  asset_id       INTEGER NOT NULL REFERENCES rental_assets (id),
  rental_item_id INTEGER NOT NULL UNIQUE REFERENCES rental_items (id),
  start_at       TEXT    NOT NULL,
  end_at         TEXT    NOT NULL,
  released_at    TEXT,
  CHECK (end_at > start_at)
);
CREATE INDEX idx_asset_bookings_asset ON asset_bookings (asset_id, start_at);

CREATE TRIGGER asset_bookings_no_overlap BEFORE INSERT ON asset_bookings
WHEN EXISTS (
  SELECT 1 FROM asset_bookings b
  WHERE b.asset_id = NEW.asset_id AND b.released_at IS NULL AND b.start_at < NEW.end_at AND b.end_at > NEW.start_at
)
BEGIN SELECT RAISE(ABORT, 'ASSET_DOUBLE_BOOKED: this unit is already booked for an overlapping period'); END;

CREATE TRIGGER asset_bookings_no_overlap_update BEFORE UPDATE OF start_at, end_at, released_at ON asset_bookings
WHEN NEW.released_at IS NULL AND EXISTS (
  SELECT 1 FROM asset_bookings b
  WHERE b.asset_id = NEW.asset_id AND b.id != NEW.id AND b.released_at IS NULL
    AND b.start_at < NEW.end_at AND b.end_at > NEW.start_at
)
BEGIN SELECT RAISE(ABORT, 'ASSET_DOUBLE_BOOKED: this unit is already booked for an overlapping period'); END;

CREATE TRIGGER asset_bookings_no_delete BEFORE DELETE ON asset_bookings
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: bookings are released, never deleted'); END;

-- What was charged and how it was calculated. Append-only.
CREATE TABLE rental_charges (
  id           INTEGER PRIMARY KEY,
  agreement_id INTEGER NOT NULL REFERENCES rental_agreements (id),
  item_id      INTEGER REFERENCES rental_items (id),
  type         TEXT    NOT NULL CHECK (type IN ('BASE', 'EXTENSION', 'LATE_FEE', 'DAMAGE', 'OTHER')),
  description  TEXT    NOT NULL,
  calc_json    TEXT    NOT NULL CHECK (json_valid(calc_json)),
  amount       INTEGER NOT NULL CHECK (amount >= 0),
  invoice_id   INTEGER REFERENCES invoices (id),
  created_at   TEXT    NOT NULL,
  user_id      INTEGER REFERENCES users (id),
  txn_ref      TEXT    NOT NULL
);
CREATE INDEX idx_rental_charges_agreement ON rental_charges (agreement_id);
CREATE TRIGGER rental_charges_no_update BEFORE UPDATE ON rental_charges
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: rental_charges rows cannot be changed'); END;
CREATE TRIGGER rental_charges_no_delete BEFORE DELETE ON rental_charges
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: rental_charges rows cannot be deleted'); END;

CREATE TABLE rental_extensions (
  id                  INTEGER PRIMARY KEY,
  agreement_id        INTEGER NOT NULL REFERENCES rental_agreements (id),
  previous_expected   TEXT    NOT NULL,
  new_expected        TEXT    NOT NULL,
  reason              TEXT    NOT NULL,
  invoice_id          INTEGER REFERENCES invoices (id),
  created_at          TEXT    NOT NULL,
  user_id             INTEGER REFERENCES users (id),
  txn_ref             TEXT    NOT NULL,
  CHECK (new_expected > previous_expected)
);
CREATE INDEX idx_rental_extensions_agreement ON rental_extensions (agreement_id);
CREATE TRIGGER rental_extensions_no_update BEFORE UPDATE ON rental_extensions
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: rental_extensions rows cannot be changed'); END;
CREATE TRIGGER rental_extensions_no_delete BEFORE DELETE ON rental_extensions
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: rental_extensions rows cannot be deleted'); END;

-- Security deposits: collected, applied to charges, refunded. A liability, never revenue. Append-only.
CREATE TABLE deposit_transactions (
  id            INTEGER PRIMARY KEY,
  agreement_id  INTEGER NOT NULL REFERENCES rental_agreements (id),
  customer_id   INTEGER NOT NULL REFERENCES customers (id),
  type          TEXT    NOT NULL CHECK (type IN ('COLLECT', 'APPLY', 'REFUND')),
  amount        INTEGER NOT NULL CHECK (amount > 0),
  method_id     INTEGER REFERENCES payment_methods (id),
  reference_no  TEXT    NOT NULL DEFAULT '',
  reason        TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL,
  business_date TEXT    NOT NULL,
  user_id       INTEGER REFERENCES users (id),
  txn_ref       TEXT    NOT NULL,
  CHECK ((type = 'APPLY') = (method_id IS NULL))
);
CREATE INDEX idx_deposits_agreement ON deposit_transactions (agreement_id);
CREATE INDEX idx_deposits_date ON deposit_transactions (business_date);
CREATE TRIGGER deposit_transactions_no_update BEFORE UPDATE ON deposit_transactions
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: deposit_transactions rows cannot be changed'); END;
CREATE TRIGGER deposit_transactions_no_delete BEFORE DELETE ON deposit_transactions
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: deposit_transactions rows cannot be deleted'); END;

CREATE VIEW v_deposit_balances AS
SELECT a.id AS agreement_id, a.customer_id,
       COALESCE(SUM(CASE d.type WHEN 'COLLECT' THEN d.amount ELSE 0 END), 0) AS collected,
       COALESCE(SUM(CASE d.type WHEN 'APPLY' THEN d.amount ELSE 0 END), 0) AS applied,
       COALESCE(SUM(CASE d.type WHEN 'REFUND' THEN d.amount ELSE 0 END), 0) AS refunded,
       COALESCE(SUM(CASE d.type WHEN 'COLLECT' THEN d.amount ELSE -d.amount END), 0) AS held
FROM rental_agreements a LEFT JOIN deposit_transactions d ON d.agreement_id = a.id
GROUP BY a.id;

INSERT INTO categories (kind, name, created_at, updated_at)
SELECT 'RENTAL', value, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM json_each('["Power tools","Ladders & access","Concrete & masonry","Generators & power","Welding","Cleaning equipment","Other equipment"]');
