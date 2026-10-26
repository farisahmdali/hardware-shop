-- 008_party_ledger_index: one customer's or supplier's account entries by account and date, for
-- statements, balances and the customer list. With only (party, time) and (account, date) indexes,
-- a large shop scanned every party's entries for the period. Index only; no data changes.

CREATE INDEX idx_ledger_party_account ON ledger_entries (party_type, party_id, account_id, business_date);
