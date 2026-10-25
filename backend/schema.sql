-- ============================================================
-- CGI storefront backend schema (D1)
--
-- Part 1: quote_requests  (existing, unchanged — issue #37/#39)
-- Part 2: orders / order_items / payments / order_events / erp_sync
--         (order + payment + ERP-sync pipeline, issue #67)
-- Part 3: members / member_addresses / auth_tokens / auth_attempts / member_events
--         (customer account system, issue #69 — isolated from PADIEM)
--
-- Every statement is idempotent (CREATE TABLE IF NOT EXISTS /
-- CREATE INDEX IF NOT EXISTS) so the whole file can be executed
-- against a live database without breaking existing rows.
-- Amounts are stored as INTEGER KRW. Timestamps are ISO-8601 UTC.
--
-- Columns added to pre-existing tables (orders.customer_id,
-- quote_requests.member_id) are declared here for fresh databases; for existing
-- databases backend/lib/migrate.mjs applies the guarded ALTER TABLE.
-- ============================================================

-- ------------------------------------------------------------
-- Part 1. Quote requests (existing)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quote_requests (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  company TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  location TEXT,
  note TEXT,
  services TEXT, -- JSON array
  items TEXT NOT NULL, -- JSON array
  status TEXT NOT NULL DEFAULT 'received',
  admin_prices TEXT, -- JSON object
  total REAL,
  member_id INTEGER,              -- null for guest submissions (issue #69)
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_quote_requests_created_at ON quote_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_quote_requests_status ON quote_requests(status);
CREATE INDEX IF NOT EXISTS idx_quote_requests_member_id ON quote_requests(member_id);

-- ------------------------------------------------------------
-- Part 2. Orders
--
-- kind='purchase' : every item has a confirmed public price -> payment possible
-- kind='quote'     : at least one item price is unconfirmed  -> payment forbidden
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,                -- e.g. ORD-20261024-A1B2C (also used as PG orderId)
  kind TEXT NOT NULL CHECK (kind IN ('purchase','quote')),
  idempotency_key TEXT UNIQUE,        -- client generated; duplicate order prevention
  cart_hash TEXT,                     -- fingerprint of items+qty (duplicate detection)
  status TEXT NOT NULL,               -- see ORDER_TRANSITIONS in lib/orders.mjs
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  customer_company TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_email TEXT,
  customer_addr TEXT,
  customer_addr_detail TEXT,
  customer_note TEXT,
  services TEXT,                      -- JSON array of service ids

  item_total INTEGER NOT NULL DEFAULT 0,
  shipping_fee INTEGER NOT NULL DEFAULT 0,
  total_amount INTEGER NOT NULL DEFAULT 0,
  supplied_amount INTEGER NOT NULL DEFAULT 0,  -- total / (1+vatRate), VAT-exclusive
  vat_amount INTEGER NOT NULL DEFAULT 0,

  payment_status TEXT NOT NULL DEFAULT 'none', -- none|pending|paid|failed|expired|partial_refunded|refunded
  payment_method TEXT,
  payment_key TEXT,
  paid_at TEXT,
  refunded_amount INTEGER NOT NULL DEFAULT 0,

  delivery_status TEXT NOT NULL DEFAULT 'pending', -- pending|processing|shipped|delivered|returned
  delivery_tracking TEXT,

  admin_prices TEXT,                  -- JSON object productId -> confirmed unit price
  admin_note TEXT,
   erp_status TEXT NOT NULL DEFAULT 'not_sent', -- not_sent|sent|confirmed|failed|skipped
   erp_sent_at TEXT,
   source_quote_id TEXT,                -- link to quote_requests.id when converted
   customer_id INTEGER                  -- null for guest checkout (issue #69)
);

CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_kind ON orders(kind);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_customer_company ON orders(customer_company);
CREATE INDEX IF NOT EXISTS idx_orders_cart_hash ON orders(cart_hash);
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);

-- ------------------------------------------------------------
-- Part 2. Order line items
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
  order_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  brand TEXT,
  category TEXT,
  option_label TEXT,
  price_state TEXT NOT NULL,          -- public|inquiry|unknown
  unit_price INTEGER,                 -- null when price_state != 'public'
  qty INTEGER NOT NULL,
  line_total INTEGER NOT NULL,        -- 0 when unit_price is null
  erp_code TEXT,                      -- Ecount item code (SS-3836 / SM-2574 / ...)
  PRIMARY KEY (order_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id);

-- ------------------------------------------------------------
-- Part 2. Payments (one row per paymentKey)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL,
  payment_key TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL DEFAULT 'tosspayments',
  provider_mode TEXT NOT NULL DEFAULT 'test', -- test|mock|live
  pg_order_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  supplied_amount INTEGER NOT NULL DEFAULT 0,
  vat INTEGER NOT NULL DEFAULT 0,
  method TEXT,
  status TEXT NOT NULL,               -- pending|paid|failed|cancelled|partial_cancelled|expired|aborted
  requested_at TEXT,
  approved_at TEXT,
  balance_amount INTEGER NOT NULL DEFAULT 0,
  cancel_amount INTEGER NOT NULL DEFAULT 0,
  failure_code TEXT,
  failure_message TEXT,
  raw TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- ------------------------------------------------------------
-- Part 2. Order event ledger (audit trail: status/payment/erp/admin)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL,
  type TEXT NOT NULL,                 -- created|status_changed|payment_confirmed|payment_failed|...
  actor TEXT NOT NULL DEFAULT 'system',
  from_status TEXT,
  to_status TEXT,
  meta TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id);
CREATE INDEX IF NOT EXISTS idx_order_events_type ON order_events(type);

-- ------------------------------------------------------------
-- Part 2. ERP sync queue (test adapter first, live later)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp_sync (
  id INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL,
  adapter TEXT NOT NULL DEFAULT 'ecount-test',
  mode TEXT NOT NULL DEFAULT 'test',  -- test|live  (ERP_LIVE_WRITE=NO until Ecount OAPI is enabled)
  action TEXT NOT NULL DEFAULT 'sales_slip_create',
  dedupe_key TEXT UNIQUE NOT NULL,    -- duplicate transmission prevention
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|sent|confirmed|failed|skipped
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_erp_sync_order_id ON erp_sync(order_id);
CREATE INDEX IF NOT EXISTS idx_erp_sync_status ON erp_sync(status);

-- ============================================================
-- Part 3. Customer accounts (issue #69)
--
-- CGI members live in this database, isolated from every PADIEM.NET
-- account system. These tables are never shared with the staff ADMIN_TOKEN
-- path: admin endpoints authenticate with a bearer token only, and a valid
-- customer session is explicitly rejected at those endpoints (role_denied).
--
-- auth_tokens stores a SHA-256 digest of each token, so a leaked database
-- cannot mint sessions, verification links or reset links.
-- ============================================================

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  company TEXT,
  email_verified_at TEXT,
  role TEXT NOT NULL DEFAULT 'member',  -- member|admin|superadmin
  google_id TEXT,                        -- Google OAuth subject (issue #79)
  status TEXT NOT NULL DEFAULT 'active',  -- active|suspended|deleted
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_members_status ON members(status);
CREATE INDEX IF NOT EXISTS idx_members_created_at ON members(created_at);

CREATE TABLE IF NOT EXISTS member_addresses (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  addr TEXT NOT NULL,
  addr_detail TEXT,
  company TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_member_addresses_member_id ON member_addresses(member_id);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id INTEGER PRIMARY KEY,
  member_id INTEGER,
  kind TEXT NOT NULL,              -- verify_email|password_reset|session|logout
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|consumed|revoked|expired
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  meta TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_member_kind ON auth_tokens(member_id, kind);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires_at ON auth_tokens(expires_at);

CREATE TABLE IF NOT EXISTS auth_attempts (
  kind TEXT NOT NULL,              -- login|signup|email-check|password-reset|email-verify|password-change
  key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  locked_until TEXT,
  PRIMARY KEY (kind, key)
);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_last_at ON auth_attempts(last_at);

CREATE TABLE IF NOT EXISTS member_events (
  id INTEGER PRIMARY KEY,
  member_id INTEGER,
  type TEXT NOT NULL,              -- signup|email_verified|login|login_failed|logout|password_reset|...
  meta TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_member_events_member_id ON member_events(member_id);
CREATE INDEX IF NOT EXISTS idx_member_events_type ON member_events(type);
