// Idempotent column upgrades for the CGI storefront database (issue #69).
//
// SQLite cannot express "ADD COLUMN IF NOT EXISTS", so a column added to an
// existing table has to be guarded in code. `schema.sql` declares the new
// columns inside the CREATE TABLE for fresh databases; this module adds them for
// databases that already exist. Both paths converge on the same shape, and the
// guard makes `schema.sql` safe to run repeatedly against production.

/** Columns added by migrations that outlive the original CREATE TABLE. */
export const COLUMN_UPGRADES = [
  { table: 'orders', column: 'customer_id', ddl: 'ALTER TABLE orders ADD COLUMN customer_id INTEGER' },
  { table: 'quote_requests', column: 'member_id', ddl: 'ALTER TABLE quote_requests ADD COLUMN member_id INTEGER' },
  { table: 'members', column: 'role', ddl: "ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'" },
  { table: 'members', column: 'google_id', ddl: 'ALTER TABLE members ADD COLUMN google_id TEXT' },
  { table: 'quote_requests', column: 'privacy_consent', ddl: 'ALTER TABLE quote_requests ADD COLUMN privacy_consent INTEGER NOT NULL DEFAULT 0' },
  { table: 'quote_requests', column: 'invoice_type', ddl: 'ALTER TABLE quote_requests ADD COLUMN invoice_type TEXT' },
  { table: 'quote_requests', column: 'biz_no', ddl: 'ALTER TABLE quote_requests ADD COLUMN biz_no TEXT' },
  { table: 'quote_requests', column: 'agency_no', ddl: 'ALTER TABLE quote_requests ADD COLUMN agency_no TEXT' },
];

/** A stored value that no password can ever match, for Google-only members. */
export const GOOGLE_SIGNUP_PASSWORD_SENTINEL = 'revoked$google-signup$0$0';

/**
 * Revoke the old shared 'google-oauth-no-password' hash from accounts created
 * through Google. Re-running is safe; a member who later set a password through
 * reset or change is explicitly left alone.
 */
export async function revokeGoogleSignupPasswords(db) {
  const result = await db.prepare(`
    UPDATE members
       SET password_hash = ?
     WHERE google_id IS NOT NULL
       AND google_id <> ''
       AND password_hash <> ?
       AND EXISTS (
         SELECT 1 FROM member_events e
          WHERE e.member_id = members.id AND e.type = 'google_signup'
       )
       AND NOT EXISTS (
         SELECT 1 FROM member_events e
          WHERE e.member_id = members.id AND e.type IN ('password_reset', 'password_changed')
       )
  `).bind(GOOGLE_SIGNUP_PASSWORD_SENTINEL, GOOGLE_SIGNUP_PASSWORD_SENTINEL).run();
  return Number(result.meta?.changes ?? 0);
}

/** Return the column names of a table, or [] when the table does not exist. */
export async function tableColumns(db, table) {
  try {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
    return (results || []).map((row) => row.name);
  } catch (e) {
    return [];
  }
}

/**
 * Apply the missing column upgrades. Returns the list of DDL statements that
 * were actually executed, so callers can report what changed.
 */
export async function ensureColumns(db, upgrades = COLUMN_UPGRADES) {
  const applied = [];
  for (const upgrade of upgrades) {
    const columns = await tableColumns(db, upgrade.table);
    if (columns.length && columns.includes(upgrade.column)) continue;
    await db.exec(upgrade.ddl);
    applied.push(upgrade.ddl);
  }
  return applied;
}
