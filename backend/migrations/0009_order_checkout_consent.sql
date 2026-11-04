-- Record when a checkout order was consented to (terms + privacy).
-- The booleans themselves are validated by the Worker before an order is
-- created; this timestamp is the audit trail for that decision.
ALTER TABLE orders ADD COLUMN terms_consent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN privacy_consent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN consent_at TEXT;
