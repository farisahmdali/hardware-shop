-- 010_supplier_item_names: what each supplier calls the shop's products. When a scanned supplier's
-- bill is saved, the item text printed on the bill is remembered against the product it was entered
-- as, so the next bill from that supplier is matched without asking. This is a lookup aid, not a
-- business record: a wrong link can be removed (the removal is in the history), and the purchases
-- themselves never refer to it.

CREATE TABLE supplier_item_names (
  id            INTEGER PRIMARY KEY,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers (id),
  -- Normalised text (lowercase, abbreviations expanded) used for looking up; see itemMatch.ts.
  item_key      TEXT    NOT NULL CHECK (length(item_key) > 0),
  -- The text as printed on the latest bill, for display.
  item_text     TEXT    NOT NULL,
  product_id    INTEGER NOT NULL REFERENCES products (id),
  uses          INTEGER NOT NULL DEFAULT 1 CHECK (uses >= 1),
  first_used_at TEXT    NOT NULL,
  last_used_at  TEXT    NOT NULL,
  UNIQUE (supplier_id, item_key)
);
CREATE INDEX idx_supplier_item_names_key ON supplier_item_names (item_key);
CREATE INDEX idx_supplier_item_names_product ON supplier_item_names (product_id);
