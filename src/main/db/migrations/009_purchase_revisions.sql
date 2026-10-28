-- 009_purchase_revisions: purchases can be edited. A recorded purchase is never changed: an edit
-- saves a new version of the bill (a new purchase row, numbered like the original with -R2, -R3, ...)
-- and reverses the version it replaces, which keeps all its records and is marked cancelled so no
-- total counts it twice. This table links each replaced version to the version that replaced it,
-- with who edited it, when and why.

CREATE TABLE purchase_revisions (
  id                   INTEGER PRIMARY KEY,
  -- The version that was replaced (it also has a purchase_cancellations row from the same edit).
  purchase_id          INTEGER NOT NULL UNIQUE REFERENCES purchases (id),
  -- The version that replaced it.
  revised_purchase_id  INTEGER NOT NULL UNIQUE REFERENCES purchases (id),
  -- The first version of the bill; all versions of one bill share it.
  original_purchase_id INTEGER NOT NULL REFERENCES purchases (id),
  -- Version number of revised_purchase_id (the original is version 1).
  revision             INTEGER NOT NULL CHECK (revision >= 2),
  reason               TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  user_id              INTEGER REFERENCES users (id),
  revised_at           TEXT    NOT NULL,
  business_date        TEXT    NOT NULL,
  txn_ref              TEXT    NOT NULL,
  CHECK (purchase_id != revised_purchase_id)
);
CREATE INDEX idx_purchase_revisions_original ON purchase_revisions (original_purchase_id, revision);

CREATE TRIGGER purchase_revisions_no_update BEFORE UPDATE ON purchase_revisions
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: purchase revisions cannot be changed'); END;
CREATE TRIGGER purchase_revisions_no_delete BEFORE DELETE ON purchase_revisions
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: purchase revisions cannot be deleted'); END;
