-- Migration 0011: keep signup consent on the member row.
--
-- The signup consent (terms / privacy + their versions) was only written to
-- member_events, and the 90-day retention sweep deletes member_events. A consent
-- record that disappears after 90 days is not a consent record, so the durable
-- copy lives on members.
--
-- Google signup currently has no consent step; those accounts keep NULL here.

ALTER TABLE members ADD COLUMN terms_consent_version TEXT;
ALTER TABLE members ADD COLUMN privacy_consent_version TEXT;
ALTER TABLE members ADD COLUMN consented_at TEXT;

-- Backfill from whatever consent events still exist. Members whose events were
-- already purged cannot be reconstructed and stay NULL.
UPDATE members
   SET terms_consent_version = (
         SELECT json_extract(e.meta, '$.terms_version')
           FROM member_events e
          WHERE e.member_id = members.id
            AND e.type = 'consent'
            AND json_valid(e.meta)
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT 1
       ),
       privacy_consent_version = (
         SELECT json_extract(e.meta, '$.privacy_version')
           FROM member_events e
          WHERE e.member_id = members.id
            AND e.type = 'consent'
            AND json_valid(e.meta)
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT 1
       ),
       consented_at = (
         SELECT e.created_at
           FROM member_events e
          WHERE e.member_id = members.id
            AND e.type = 'consent'
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT 1
       )
 WHERE EXISTS (
         SELECT 1 FROM member_events e
          WHERE e.member_id = members.id AND e.type = 'consent'
       );