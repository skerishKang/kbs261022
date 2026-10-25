-- Migration 0003: member role for CGI admin/superadmin (issue #76)
ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT 'member';

-- Backfill the two superadmin accounts once their email is verified.
-- (The worker also enforces this at runtime based on verified email.)
UPDATE members SET role = 'superadmin'
  WHERE lower(email) IN ('charliekant@gmail.com', 'skerish@naver.com')
    AND email_verified_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_members_role ON members(role);
