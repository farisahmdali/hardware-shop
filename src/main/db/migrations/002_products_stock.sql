-- 002_products_stock: suppliers (basic), products, stock ledger, stock counts, financial ledger.

-- Suppliers are referenced by products now; the full supplier module arrives with purchases.
CREATE TABLE suppliers (
  id            INTEGER PRIMARY KEY,
  code          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT    NOT NULL,
  phone         TEXT    NOT NULL DEFAULT '',
  address       TEXT    NOT NULL DEFAULT '',
  business_name TEXT    NOT NULL DEFAULT '',
  gstin         TEXT    NOT NULL DEFAULT '',
  state_code    TEXT    NOT NULL DEFAULT '',
  notes         TEXT    NOT NULL DEFAULT '',
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_suppliers_name ON suppliers (name);

CREATE TABLE products (
  id                    INTEGER PRIMARY KEY,
  sku                   TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name                  TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  category_id           INTEGER REFERENCES categories (id),
  brand_id              INTEGER REFERENCES brands (id),
  description           TEXT    NOT NULL DEFAULT '',
  unit_id               INTEGER NOT NULL REFERENCES units (id),
  hsn_code              TEXT    NOT NULL DEFAULT '',
  gst_rate_bp           INTEGER NOT NULL DEFAULT 1800 CHECK (gst_rate_bp BETWEEN 0 AND 10000),
  price_includes_tax    INTEGER NOT NULL DEFAULT 1 CHECK (price_includes_tax IN (0, 1)),
  -- Reference cost per unit (paise, excluding GST). Inventory value uses the weighted average in stock_balances.
  purchase_price        INTEGER NOT NULL DEFAULT 0 CHECK (purchase_price >= 0),
  -- Selling price per unit (paise), including or excluding GST as price_includes_tax says.
  selling_price         INTEGER NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
  min_stock_qty         INTEGER NOT NULL DEFAULT 0 CHECK (min_stock_qty >= 0),
  preferred_supplier_id INTEGER REFERENCES suppliers (id),
  notes                 TEXT    NOT NULL DEFAULT '',
  is_active             INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL,
  version               INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_products_category ON products (category_id);
CREATE INDEX idx_products_brand ON products (brand_id);
CREATE INDEX idx_products_unit ON products (unit_id);
CREATE INDEX idx_products_supplier ON products (preferred_supplier_id);
CREATE INDEX idx_products_active_name ON products (is_active, name COLLATE NOCASE);

CREATE TRIGGER products_category_kind BEFORE INSERT ON products
WHEN NEW.category_id IS NOT NULL AND (SELECT kind FROM categories WHERE id = NEW.category_id) IS NOT 'PRODUCT'
BEGIN
  SELECT RAISE(ABORT, 'Product category must be a product category');
END;

CREATE TRIGGER products_category_kind_update BEFORE UPDATE OF category_id ON products
WHEN NEW.category_id IS NOT NULL AND (SELECT kind FROM categories WHERE id = NEW.category_id) IS NOT 'PRODUCT'
BEGIN
  SELECT RAISE(ABORT, 'Product category must be a product category');
END;

-- ---------- Product search ----------

CREATE VIRTUAL TABLE products_fts USING fts5(
  sku, name, brand, category, hsn, description,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '1 2 3'
);

-- ---------- Stock ----------

-- One row per product. Changed only by the stock_movements trigger below.
CREATE TABLE stock_balances (
  product_id       INTEGER PRIMARY KEY REFERENCES products (id),
  qty              INTEGER NOT NULL DEFAULT 0,
  -- Inventory value at weighted-average cost, in paise.
  value            INTEGER NOT NULL DEFAULT 0,
  last_movement_id INTEGER REFERENCES stock_movements (id),
  updated_at       TEXT    NOT NULL
);

CREATE TRIGGER products_after_insert AFTER INSERT ON products
BEGIN
  INSERT INTO stock_balances (product_id, qty, value, updated_at) VALUES (NEW.id, 0, 0, NEW.created_at);
  INSERT INTO products_fts (rowid, sku, name, brand, category, hsn, description)
  VALUES (
    NEW.id, NEW.sku, NEW.name,
    (SELECT name FROM brands WHERE id = NEW.brand_id),
    (SELECT name FROM categories WHERE id = NEW.category_id),
    NEW.hsn_code, NEW.description
  );
END;

CREATE TRIGGER products_after_update AFTER UPDATE OF sku, name, brand_id, category_id, hsn_code, description ON products
BEGIN
  DELETE FROM products_fts WHERE rowid = OLD.id;
  INSERT INTO products_fts (rowid, sku, name, brand, category, hsn, description)
  VALUES (
    NEW.id, NEW.sku, NEW.name,
    (SELECT name FROM brands WHERE id = NEW.brand_id),
    (SELECT name FROM categories WHERE id = NEW.category_id),
    NEW.hsn_code, NEW.description
  );
END;

CREATE TRIGGER products_no_delete BEFORE DELETE ON products
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE: products are deactivated, never deleted');
END;

CREATE TRIGGER brands_rename_fts AFTER UPDATE OF name ON brands
BEGIN
  UPDATE products_fts SET brand = NEW.name WHERE rowid IN (SELECT id FROM products WHERE brand_id = NEW.id);
END;

CREATE TRIGGER categories_rename_fts AFTER UPDATE OF name ON categories
BEGIN
  UPDATE products_fts SET category = NEW.name WHERE rowid IN (SELECT id FROM products WHERE category_id = NEW.id);
END;

-- Every increase or decrease of stock. Append-only.
CREATE TABLE stock_movements (
  id               INTEGER PRIMARY KEY,
  product_id       INTEGER NOT NULL REFERENCES products (id),
  type             TEXT    NOT NULL CHECK (type IN (
                     'OPENING', 'RECEIPT', 'PURCHASE', 'PURCHASE_CANCEL', 'ADJUST_IN', 'ADJUST_OUT',
                     'DAMAGE', 'LOSS', 'SALE', 'SALE_CANCEL', 'CUSTOMER_RETURN', 'SUPPLIER_RETURN', 'RECONCILE')),
  qty_before       INTEGER NOT NULL,
  qty_change       INTEGER NOT NULL CHECK (qty_change <> 0),
  qty_after        INTEGER NOT NULL,
  -- Cost per whole unit used for this movement (paise), for display.
  unit_cost        INTEGER NOT NULL DEFAULT 0,
  -- Signed change in inventory value (paise).
  cost_value       INTEGER NOT NULL DEFAULT 0,
  value_before     INTEGER NOT NULL,
  value_after      INTEGER NOT NULL,
  negative_override INTEGER NOT NULL DEFAULT 0 CHECK (negative_override IN (0, 1)),
  reason           TEXT,
  ref_type         TEXT,
  ref_id           TEXT,
  user_id          INTEGER REFERENCES users (id),
  occurred_at      TEXT    NOT NULL,
  business_date    TEXT    NOT NULL,
  txn_ref          TEXT    NOT NULL,
  CHECK (qty_after = qty_before + qty_change),
  CHECK (value_after = value_before + cost_value),
  CHECK (qty_after >= 0 OR negative_override = 1)
);
CREATE INDEX idx_movements_product ON stock_movements (product_id, id);
CREATE INDEX idx_movements_date ON stock_movements (business_date);
CREATE INDEX idx_movements_type ON stock_movements (type, business_date);
CREATE INDEX idx_movements_ref ON stock_movements (ref_type, ref_id);
CREATE INDEX idx_movements_txn ON stock_movements (txn_ref);

-- A movement must start exactly where the current balance is.
CREATE TRIGGER stock_movements_check BEFORE INSERT ON stock_movements
WHEN NEW.qty_before IS NOT (SELECT qty FROM stock_balances WHERE product_id = NEW.product_id)
  OR NEW.value_before IS NOT (SELECT value FROM stock_balances WHERE product_id = NEW.product_id)
BEGIN
  SELECT RAISE(ABORT, 'STOCK_OUT_OF_SYNC: movement does not start from the current balance');
END;

CREATE TRIGGER stock_movements_apply AFTER INSERT ON stock_movements
BEGIN
  UPDATE stock_balances
     SET qty = NEW.qty_after, value = NEW.value_after, last_movement_id = NEW.id, updated_at = NEW.occurred_at
   WHERE product_id = NEW.product_id;
END;

CREATE TRIGGER stock_movements_no_update BEFORE UPDATE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE: stock_movements rows cannot be changed');
END;

CREATE TRIGGER stock_movements_no_delete BEFORE DELETE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE: stock_movements rows cannot be deleted');
END;

-- Balances may only move forward to a newer movement of the same product, matching its result.
CREATE TRIGGER stock_balances_no_update BEFORE UPDATE ON stock_balances
WHEN NEW.product_id IS NOT OLD.product_id
  OR NEW.last_movement_id IS NULL
  OR NEW.last_movement_id <= COALESCE(OLD.last_movement_id, 0)
  OR (SELECT product_id FROM stock_movements WHERE id = NEW.last_movement_id) IS NOT NEW.product_id
  OR NEW.qty IS NOT (SELECT qty_after FROM stock_movements WHERE id = NEW.last_movement_id)
  OR NEW.value IS NOT (SELECT value_after FROM stock_movements WHERE id = NEW.last_movement_id)
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE: stock_balances change only through stock movements');
END;

CREATE TRIGGER stock_balances_no_delete BEFORE DELETE ON stock_balances
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE: stock_balances rows cannot be deleted');
END;

-- ---------- Stock counts (inventory reconciliation) ----------

CREATE TABLE stock_counts (
  id           INTEGER PRIMARY KEY,
  count_no     TEXT    NOT NULL UNIQUE,
  status       TEXT    NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'FINALIZED', 'CANCELLED')),
  category_id  INTEGER REFERENCES categories (id),
  notes        TEXT    NOT NULL DEFAULT '',
  started_at   TEXT    NOT NULL,
  started_by   INTEGER REFERENCES users (id),
  closed_at    TEXT,
  closed_by    INTEGER REFERENCES users (id),
  close_reason TEXT,
  version      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_stock_counts_status ON stock_counts (status, started_at);

CREATE TABLE stock_count_lines (
  id          INTEGER PRIMARY KEY,
  count_id    INTEGER NOT NULL REFERENCES stock_counts (id),
  product_id  INTEGER NOT NULL REFERENCES products (id),
  system_qty  INTEGER NOT NULL,
  counted_qty INTEGER CHECK (counted_qty IS NULL OR counted_qty >= 0),
  -- Filled in when the count is finalized.
  final_system_qty INTEGER,
  movement_id INTEGER REFERENCES stock_movements (id),
  note        TEXT    NOT NULL DEFAULT '',
  updated_at  TEXT,
  updated_by  INTEGER REFERENCES users (id),
  UNIQUE (count_id, product_id)
);
CREATE INDEX idx_count_lines_product ON stock_count_lines (product_id);

CREATE TRIGGER stock_count_lines_locked BEFORE UPDATE ON stock_count_lines
WHEN (SELECT status FROM stock_counts WHERE id = OLD.count_id) IS NOT 'OPEN'
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE: lines of a closed stock count cannot be changed');
END;

CREATE TRIGGER stock_counts_closed BEFORE UPDATE ON stock_counts
WHEN OLD.status IS NOT 'OPEN'
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE: a closed stock count cannot be changed');
END;

CREATE TRIGGER stock_count_lines_no_delete BEFORE DELETE ON stock_count_lines
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE: stock count lines cannot be deleted');
END;

-- ---------- Financial ledger (double entry) ----------

-- Every money and inventory-value effect, as balanced debit/credit lines sharing a txn_ref. Append-only.
CREATE TABLE ledger_entries (
  id            INTEGER PRIMARY KEY,
  txn_ref       TEXT    NOT NULL,
  occurred_at   TEXT    NOT NULL,
  business_date TEXT    NOT NULL,
  account_id    INTEGER NOT NULL REFERENCES accounts (id),
  party_type    TEXT    CHECK (party_type IN ('CUSTOMER', 'SUPPLIER')),
  party_id      INTEGER,
  debit         INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit        INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
  ref_type      TEXT    NOT NULL,
  ref_id        TEXT,
  memo          TEXT,
  user_id       INTEGER REFERENCES users (id),
  CHECK ((debit = 0) <> (credit = 0)),
  CHECK ((party_type IS NULL) = (party_id IS NULL))
);
CREATE INDEX idx_ledger_account ON ledger_entries (account_id, business_date);
CREATE INDEX idx_ledger_party ON ledger_entries (party_type, party_id, occurred_at);
CREATE INDEX idx_ledger_txn ON ledger_entries (txn_ref);
CREATE INDEX idx_ledger_ref ON ledger_entries (ref_type, ref_id);
CREATE INDEX idx_ledger_date ON ledger_entries (business_date);

CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE: ledger_entries rows cannot be changed');
END;

CREATE TRIGGER ledger_entries_no_delete BEFORE DELETE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE: ledger_entries rows cannot be deleted');
END;

INSERT INTO categories (kind, name, created_at, updated_at)
SELECT 'PRODUCT', value, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM json_each('["Hand tools","Power tools","Electrical","Plumbing","Paints & chemicals","Fasteners","Construction materials","Safety equipment","Accessories"]');
