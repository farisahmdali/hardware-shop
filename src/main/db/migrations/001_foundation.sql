-- 001_foundation: system tables, users and roles, audit log, reference data.
-- Conventions:
--   * money columns are INTEGER paise; quantities are INTEGER milli-units
--   * timestamps are UTC ISO-8601 text (e.g. 2026-10-21T09:30:00.000Z)
--   * business_date columns are shop-local YYYY-MM-DD
--   * booleans are INTEGER 0/1 with CHECK constraints
--   * mutable rows carry a `version` for optimistic locking

CREATE TABLE roles (
  id              INTEGER PRIMARY KEY,
  code            TEXT    NOT NULL UNIQUE,
  name            TEXT    NOT NULL,
  is_system       INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  max_discount_bp INTEGER NOT NULL DEFAULT 0 CHECK (max_discount_bp BETWEEN 0 AND 10000),
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE role_permissions (
  role_id    INTEGER NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission TEXT    NOT NULL,
  PRIMARY KEY (role_id, permission)
) WITHOUT ROWID;

CREATE TABLE users (
  id              INTEGER PRIMARY KEY,
  username        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name    TEXT    NOT NULL,
  secret_hash     TEXT    NOT NULL,
  role_id         INTEGER NOT NULL REFERENCES roles (id),
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  last_login_at   TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_users_role ON users (role_id);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users (id)
) WITHOUT ROWID;

-- Gap-free document numbering per document type and financial year.
CREATE TABLE doc_sequences (
  doc_type    TEXT    NOT NULL,
  fiscal_year TEXT    NOT NULL,
  next_value  INTEGER NOT NULL CHECK (next_value >= 1),
  PRIMARY KEY (doc_type, fiscal_year)
) WITHOUT ROWID;

-- Results of commands that must not run twice (double clicks, retries).
CREATE TABLE idempotency_keys (
  key         TEXT PRIMARY KEY,
  command     TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at  TEXT NOT NULL
) WITHOUT ROWID;

-- Who changed what, when and why. Append-only: see triggers below.
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY,
  occurred_at  TEXT NOT NULL,
  user_id      INTEGER REFERENCES users (id),
  username     TEXT,
  module       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  action       TEXT NOT NULL,
  before_json  TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json   TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  reason       TEXT,
  txn_ref      TEXT,
  related_type TEXT,
  related_id   TEXT
);
CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id, id);
CREATE INDEX idx_audit_time ON audit_log (occurred_at);
CREATE INDEX idx_audit_user ON audit_log (user_id, occurred_at);
CREATE INDEX idx_audit_txn ON audit_log (txn_ref);
CREATE INDEX idx_audit_module ON audit_log (module, occurred_at);
CREATE INDEX idx_audit_related ON audit_log (related_type, related_id);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE: audit_log rows cannot be changed');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE: audit_log rows cannot be deleted');
END;

CREATE TABLE backup_history (
  id             INTEGER PRIMARY KEY,
  created_at     TEXT    NOT NULL,
  kind           TEXT    NOT NULL CHECK (kind IN ('MANUAL', 'AUTO', 'PRE_RESTORE', 'PRE_MIGRATION')),
  file_name      TEXT    NOT NULL,
  file_path      TEXT    NOT NULL,
  size_bytes     INTEGER,
  sha256         TEXT,
  schema_version INTEGER,
  status         TEXT    NOT NULL CHECK (status IN ('OK', 'FAILED')),
  message        TEXT,
  user_id        INTEGER REFERENCES users (id)
);
CREATE INDEX idx_backup_history_time ON backup_history (created_at);

-- Chart of accounts for the double-entry financial ledger (tables arrive with sales).
CREATE TABLE accounts (
  id         INTEGER PRIMARY KEY,
  code       TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL,
  type       TEXT    NOT NULL CHECK (type IN ('ASSET', 'LIABILITY', 'INCOME', 'EXPENSE', 'EQUITY')),
  is_system  INTEGER NOT NULL DEFAULT 1 CHECK (is_system IN (0, 1)),
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT    NOT NULL
);

CREATE TABLE payment_methods (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  kind       TEXT    NOT NULL CHECK (kind IN ('CASH', 'UPI', 'CARD', 'BANK', 'CHEQUE', 'OTHER')),
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_payment_methods_account ON payment_methods (account_id);

CREATE TABLE units (
  id            INTEGER PRIMARY KEY,
  code          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT    NOT NULL,
  allow_decimal INTEGER NOT NULL DEFAULT 0 CHECK (allow_decimal IN (0, 1)),
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE categories (
  id         INTEGER PRIMARY KEY,
  kind       TEXT    NOT NULL CHECK (kind IN ('PRODUCT', 'RENTAL', 'EXPENSE')),
  name       TEXT    NOT NULL COLLATE NOCASE,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  UNIQUE (kind, name)
);

CREATE TABLE brands (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1
);

-- ---------- Reference data ----------

INSERT INTO roles (code, name, is_system, max_discount_bp, created_at, updated_at) VALUES
  ('OWNER',     'Owner',              1, 10000, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('MANAGER',   'Manager',            1,  2000, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('SALES',     'Sales employee',     1,   500, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('INVENTORY', 'Inventory employee', 1,     0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- The owner role is granted everything in code; these rows are the editable defaults for other roles.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission FROM roles r
JOIN (
  SELECT 'MANAGER' AS role, value AS permission FROM json_each('["products.manage","stock.adjust","sales.create","sales.discount","sales.cancel","sales.return","customers.manage","customers.adjustBalance","payments.receive","payments.reverse","rentals.manage","rentals.issue","rentals.return","rentals.depositDeduct","suppliers.manage","purchases.manage","suppliers.pay","expenses.manage","cash.reconcile","reports.view","reports.financial","audit.view","backup.create"]')
  UNION ALL
  SELECT 'SALES', value FROM json_each('["sales.create","sales.discount","customers.manage","payments.receive","rentals.issue","rentals.return","reports.view","backup.create"]')
  UNION ALL
  SELECT 'INVENTORY', value FROM json_each('["products.manage","stock.adjust","rentals.manage","suppliers.manage","purchases.manage","reports.view","backup.create"]')
) p ON p.role = r.code;

INSERT INTO accounts (code, name, type, created_at) VALUES
  ('CASH',              'Cash in hand',                 'ASSET',     strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('BANK',              'Bank account',                 'ASSET',     strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('UPI',               'UPI collections',              'ASSET',     strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('CARD',              'Card settlements',             'ASSET',     strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('CHEQUE',            'Cheques in hand',              'ASSET',     strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('AR',                'Customer receivables',         'ASSET',     strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('INVENTORY',         'Inventory',                    'ASSET',     strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('INPUT_GST',         'Input GST (recoverable)',      'ASSET',     strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('AP',                'Supplier payables',            'LIABILITY', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('OUTPUT_CGST',       'Output CGST',                  'LIABILITY', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('OUTPUT_SGST',       'Output SGST',                  'LIABILITY', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('OUTPUT_IGST',       'Output IGST',                  'LIABILITY', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('DEPOSIT_LIABILITY', 'Security deposits held',       'LIABILITY', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('CUSTOMER_ADVANCES', 'Customer advances and credit', 'LIABILITY', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('SALES',             'Sales revenue',                'INCOME',    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('SALES_RETURNS',     'Sales returns',                'INCOME',    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('RENTAL_INCOME',     'Rental income',                'INCOME',    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('LATE_FEE_INCOME',   'Rental late fees',             'INCOME',    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('DAMAGE_INCOME',     'Rental damage charges',        'INCOME',    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('ROUND_OFF',         'Round-off',                    'INCOME',    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('COGS',              'Cost of goods sold',           'EXPENSE',   strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('INVENTORY_LOSS',    'Stock damage, loss and adjustments', 'EXPENSE', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('OPERATING_EXPENSES','Operating expenses',           'EXPENSE',   strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('CASH_OVER_SHORT',   'Cash over / short',            'EXPENSE',   strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('BALANCE_ADJUSTMENTS','Balance adjustments',         'EXPENSE',   strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('OWNER_EQUITY',      'Owner equity and opening balances', 'EQUITY', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO payment_methods (name, kind, account_id, sort_order, created_at, updated_at)
SELECT m.name, m.kind, a.id, m.sort_order, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (
  SELECT 'Cash' AS name, 'CASH' AS kind, 'CASH' AS account, 1 AS sort_order
  UNION ALL SELECT 'UPI', 'UPI', 'UPI', 2
  UNION ALL SELECT 'Card', 'CARD', 'CARD', 3
  UNION ALL SELECT 'Bank transfer', 'BANK', 'BANK', 4
  UNION ALL SELECT 'Cheque', 'CHEQUE', 'CHEQUE', 5
) m JOIN accounts a ON a.code = m.account;

INSERT INTO units (code, name, allow_decimal, created_at, updated_at) VALUES
  ('PCS', 'Pieces',      0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('BOX', 'Boxes',       0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('PKT', 'Packs',       0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('SET', 'Sets',        0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('PAIR','Pairs',       0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('ROLL','Rolls',       0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('BAG', 'Bags',        0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('KG',  'Kilograms',   1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('G',   'Grams',       1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('M',   'Metres',      1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('FT',  'Feet',        1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('L',   'Litres',      1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('SQFT','Square feet', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO categories (kind, name, created_at, updated_at)
SELECT 'EXPENSE', value, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM json_each('["Shop rent","Electricity","Salaries","Transport","Maintenance","Packaging","Telephone & internet","Other operating expenses"]');
