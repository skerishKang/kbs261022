-- ============================================================
-- Migration 0002: CGI customer account system (issue #69)
--
-- Adds the customer/member tables and links existing order and quote rows to
-- an optional member id. Applied once by `wrangler d1 migrations apply`, which
-- records it in d1_migrations.
--
-- The two ALTER TABLE statements are NOT wrapped in IF NOT EXISTS because
-- SQLite cannot express that for ADD COLUMN. They are safe here because a
-- migration runs exactly once; `backend/lib/migrate.mjs` carries the same
-- upgrades behind a PRAGMA table_info guard for the /api/admin/schema/init path
-- and for fresh databases opened through backend/schema.sql.
--
-- Ordering rule: a database is shaped by EITHER the migrations OR schema.sql,
-- never both. A database created from backend/schema.sql already has
-- orders.customer_id and quote_requests.member_id, so replaying this migration
-- on it would fail with "duplicate column name". Production is shaped by the
-- migrations (0001 then this file); schema.sql is the superset used for the
-- Worker's /api/admin/schema/init repair path and for the local test shim,
-- both of which add the two columns through the guarded upgrades instead.
--
-- All existing rows keep working: customer_id / member_id are nullable, so
-- guest checkout and guest quote requests are unchanged.
-- ============================================================

ALTER TABLE orders ADD COLUMN customer_id INTEGER;

ALTER TABLE quote_requests ADD COLUMN member_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_quote_requests_member_id ON quote_requests(member_id);

-- ------------------------------------------------------------
-- Members
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  company TEXT,
  email_verified_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active|suspended|deleted
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_members_status ON members(status);
CREATE INDEX IF NOT EXISTS idx_members_created_at ON members(created_at);

-- ------------------------------------------------------------
-- Member delivery addresses
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- Auth tokens. The database keeps only a SHA-256 digest of each token, so a
-- leaked database cannot mint sessions, verification links or reset links.
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- Login / signup rate limits (sliding window counters)
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- Member audit trail
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_events (
  id INTEGER PRIMARY KEY,
  member_id INTEGER,
  type TEXT NOT NULL,              -- signup|email_verified|login|login_failed|logout|password_reset|...
  meta TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_member_events_member_id ON member_events(member_id);
CREATE INDEX IF NOT EXISTS idx_member_events_type ON member_events(type);
