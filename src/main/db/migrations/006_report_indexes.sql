-- 006_report_indexes: indexes for date-range reports and per-document lookups. No data changes.

CREATE INDEX IF NOT EXISTS idx_invoices_kind_date ON invoices (kind, business_date);
CREATE INDEX IF NOT EXISTS idx_invoices_rental ON invoices (rental_agreement_id) WHERE rental_agreement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_lines_charge ON invoice_lines (rental_charge_id) WHERE rental_charge_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_cancellations_date ON invoice_cancellations (business_date);
CREATE INDEX IF NOT EXISTS idx_credit_notes_date ON credit_notes (business_date);
CREATE INDEX IF NOT EXISTS idx_credit_note_lines_note ON credit_note_lines (credit_note_id);
CREATE INDEX IF NOT EXISTS idx_payment_reversals_date ON payment_reversals (business_date);
CREATE INDEX IF NOT EXISTS idx_balance_adjustments_date ON balance_adjustments (business_date);
CREATE INDEX IF NOT EXISTS idx_debit_note_lines_note ON debit_note_lines (debit_note_id);
CREATE INDEX IF NOT EXISTS idx_debit_notes_date ON debit_notes (business_date);
CREATE INDEX IF NOT EXISTS idx_purchases_bill_date ON purchases (supplier_invoice_date);
CREATE INDEX IF NOT EXISTS idx_supplier_adjustments_date ON supplier_adjustments (business_date);
CREATE INDEX IF NOT EXISTS idx_rental_charges_type ON rental_charges (type, created_at);
CREATE INDEX IF NOT EXISTS idx_rental_items_product ON rental_items (rental_product_id);
CREATE INDEX IF NOT EXISTS idx_rental_items_issued ON rental_items (issued_at);
CREATE INDEX IF NOT EXISTS idx_deposits_type_date ON deposit_transactions (type, business_date);
CREATE INDEX IF NOT EXISTS idx_cash_counts_diff ON cash_counts (business_date) WHERE difference != 0;
