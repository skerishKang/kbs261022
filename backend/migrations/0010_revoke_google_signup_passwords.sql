-- Google-created accounts used to store a publicly known password hash
-- ('google-oauth-no-password'). Replace it with an unparsable sentinel so the
-- only way to set a password is the reset flow. Members who already set a
-- password through reset or password change keep their usable hash.
UPDATE members
   SET password_hash = 'revoked$google-signup$0$0'
 WHERE google_id IS NOT NULL
   AND google_id <> ''
   AND password_hash <> 'revoked$google-signup$0$0'
   AND EXISTS (
     SELECT 1 FROM member_events e
      WHERE e.member_id = members.id AND e.type = 'google_signup'
   )
   AND NOT EXISTS (
     SELECT 1 FROM member_events e
      WHERE e.member_id = members.id AND e.type IN ('password_reset', 'password_changed')
   );
