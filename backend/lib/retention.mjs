// Retention for operational records only. Transaction, member and token rows
// are deliberately absent from this fixed allowlist.

export const SHOP_LOG_RETENTION_DAYS = 90;
export const SHOP_LOG_BATCH_SIZE = 500;

// 개인정보처리방침 3조: "견적 문의만 하고 주문하지 않은 경우 문의 처리 완료 후 1년".
// quote_requests 에는 전용 완료 시각 컬럼이 없어(created_at/updated_at/status 만
// 존재) 생성 후 1년을 기준으로 삼는다. 행은 남기고 개인정보 칸만 비운다.
export const QUOTE_PII_RETENTION_DAYS = 365;
export const QUOTE_PII_BATCH_SIZE = 200;

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

/**
 * 주문으로 이어지지 않은 견적 요청의 개인정보를 지운다(행은 유지).
 * 주문·결제·회원 표는 건드리지 않는다. orders.source_quote_id 가 하나라도
 * 가리키는 견적은 "주문으로 이어짐"으로 보고 제외한다.
 */
export async function purgeExpiredQuotePii(
  db,
  { now = new Date(), batchSize = QUOTE_PII_BATCH_SIZE } = {},
) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('D1 database binding is required');
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > QUOTE_PII_BATCH_SIZE) {
    throw new RangeError(`batchSize must be between 1 and ${QUOTE_PII_BATCH_SIZE}`);
  }
  const moment = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(moment.getTime())) throw new TypeError('now must be a valid date');
  const cutoff = new Date(moment.getTime() - QUOTE_PII_RETENTION_DAYS * DAY_MS).toISOString();
  // created_at may be ISO-8601 ("T") or SQLite's space-separated form.
  const sqliteCutoff = cutoff.slice(0, 19).replace('T', ' ');
  const updatedAt = moment.toISOString();

  const result = await db.prepare(
    `UPDATE quote_requests
        SET contact_name = '', phone = '', email = NULL, location = NULL, updated_at = ?
      WHERE id IN (
        SELECT q.id FROM quote_requests q
         WHERE ((q.created_at >= '1000-01-01 ' AND q.created_at < ?
                 AND substr(q.created_at, 11, 1) = ' ')
                OR (q.created_at >= '1000-01-01T' AND q.created_at < ?
                 AND substr(q.created_at, 11, 1) = 'T'))
           AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.source_quote_id = q.id)
           AND (q.contact_name <> '' OR q.phone <> '' OR q.email IS NOT NULL OR q.location IS NOT NULL)
         ORDER BY q.created_at ASC
         LIMIT ?
      )`
  ).bind(updatedAt, sqliteCutoff, cutoff, batchSize).run();
  const changes = Number(result?.meta?.changes);
  return Number.isSafeInteger(changes) && changes > 0 ? changes : 0;
}
