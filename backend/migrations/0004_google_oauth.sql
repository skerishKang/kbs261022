-- ============================================================
-- Migration 0004: Google OAuth support (issue #79)
--
-- Adds the google_id column to the members table so Google OAuth
-- users can be linked to their accounts. Applied once by
-- `wrangler d1 migrations apply`.
-- ============================================================

ALTER TABLE members ADD COLUMN google_id TEXT;

CREATE INDEX IF NOT EXISTS idx_members_google_id ON members(google_id);
