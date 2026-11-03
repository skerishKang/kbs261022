// Retention for operational records only. Transaction, member and token rows
// are deliberately absent from this fixed allowlist.

export const SHOP_LOG_RETENTION_DAYS = 90;
export const SHOP_LOG_BATCH_SIZE = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

const RETENTION_TARGETS = Object.freeze([
  { table: 'auth_attempts', column: 'last_at' },
  { table: 'member_events', column: 'created_at' },
  { table: 'product_change_log', column: 'detected_at' },
]);

/** Delete at most one bounded batch from each service-log table. */
export async function purgeExpiredShopLogs(
  db,
  { now = new Date(), batchSize = SHOP_LOG_BATCH_SIZE } = {},
) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('D1 database binding is required');
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > SHOP_LOG_BATCH_SIZE) {
    throw new RangeError(`batchSize must be between 1 and ${SHOP_LOG_BATCH_SIZE}`);
  }
  const moment = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(moment.getTime())) throw new TypeError('now must be a valid date');
  const cutoff = new Date(moment.getTime() - SHOP_LOG_RETENTION_DAYS * DAY_MS).toISOString();
  // product_change_log has historically used SQLite's "YYYY-MM-DD HH:mm:ss"
  // default, while application timestamps use ISO-8601 with "T" and "Z".
  const sqliteCutoff = cutoff.slice(0, 19).replace('T', ' ');
  const counts = {};

  for (const target of RETENTION_TARGETS) {
    const result = await db.prepare(
      `DELETE FROM ${target.table} WHERE rowid IN (`
      + `SELECT rowid FROM ${target.table} `
      + `WHERE ((${target.column} >= '1000-01-01 ' AND ${target.column} < ? `
      + `AND substr(${target.column}, 11, 1) = ' ') `
      + `OR (${target.column} >= '1000-01-01T' AND ${target.column} < ? `
      + `AND substr(${target.column}, 11, 1) = 'T')) `
      + `ORDER BY ${target.column} ASC LIMIT ?)`
    ).bind(sqliteCutoff, cutoff, batchSize).run();
    const changes = Number(result?.meta?.changes);
    counts[target.table] = Number.isSafeInteger(changes) && changes > 0 ? changes : 0;
  }

  return counts;
}
