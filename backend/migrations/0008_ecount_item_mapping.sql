-- Approved CGI product ID to ECOUNT item-code pairs only.
-- This migration defines the table; it does not import or approve any product mapping.
CREATE TABLE IF NOT EXISTS ecount_item_mapping (
  cgi_product_id TEXT PRIMARY KEY,
  ecount_prod_cd TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
