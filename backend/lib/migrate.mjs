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
];

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
