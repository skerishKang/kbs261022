/**
 * CGI product change detection.
 *
 * Given a product record, produces a stable hash of the fields that matter for
 * external sync (Naver, ERP). Two records with the same hash are considered
 * unchanged; a different hash means "something external needs to be re-sent".
 *
 * Only sync-relevant fields are hashed. Cosmetic or internal-only fields
 * (sync metadata, timestamps, internal notes) are deliberately excluded so
 * that re-running a classification pass does not trigger spurious re-syncs.
 */
import crypto from 'node:crypto';

/** Fields that, when changed, require re-transmission to Naver/ERP. */
export const SYNC_RELEVANT_FIELDS = [
  'prodDes',
  'price',
  'stockQty',
  'barCode',
  'unit',
  'prodType',
  'sizeDes',
  'taxRate',
  'outPrice',
  'sellerManagementCode',
  'naverCategoryNo',
  'naverItemId',
  'erpProdCd',
  'imageUrl',
  'availability',
];

function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(String(value));
}

/** Extract only sync-relevant fields from a product record. */
export function extractSyncFields(record) {
  const out = {};
  for (const field of SYNC_RELEVANT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      out[field] = record[field];
    }
  }
  return out;
}

/** Compute a SHA-256 hash of the sync-relevant fields. */
export function computeChangeHash(record) {
  const fields = extractSyncFields(record);
  const canonical = stableStringify(fields);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Compare two product records and return a change descriptor.
 * @returns {{ changed: boolean, added: string[], removed: string[], modified: string[], hashBefore: string|null, hashAfter: string }}
 */
export function detectChanges(before, after) {
  const hashBefore = before ? computeChangeHash(before) : null;
  const hashAfter = computeChangeHash(after);
  const changed = hashBefore !== hashAfter;

  const beforeFields = before ? extractSyncFields(before) : {};
  const afterFields = extractSyncFields(after);
  const allKeys = new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)]);
  const added = [];
  const removed = [];
  const modified = [];
  for (const key of allKeys) {
    const had = Object.prototype.hasOwnProperty.call(beforeFields, key);
    const has = Object.prototype.hasOwnProperty.call(afterFields, key);
    if (!had && has) added.push(key);
    else if (had && !has) removed.push(key);
    else if (stableStringify(beforeFields[key]) !== stableStringify(afterFields[key])) modified.push(key);
  }
  return { changed, added, removed, modified, hashBefore, hashAfter };
}

/**
 * Batch change detection: given a map of previous hashes and current records,
 * returns which records changed.
 * @param {Map<string,string>} previousHashes - cgiId -> hash
 * @param {Array} currentRecords - current product records
 * @returns {{ changed: Array, unchanged: Array, new: Array }}
 */
export function detectBatchChanges(previousHashes, currentRecords) {
  const changed = [];
  const unchanged = [];
  const isNew = [];
  for (const record of currentRecords) {
    const cgiId = record.cgiId || record.id || record.sourceId;
    const currentHash = computeChangeHash(record);
    const prevHash = previousHashes.get(cgiId);
    if (prevHash === undefined) {
      isNew.push({ record, hash: currentHash });
    } else if (prevHash !== currentHash) {
      changed.push({ record, hash: currentHash, previousHash: prevHash });
    } else {
      unchanged.push({ record, hash: currentHash });
    }
  }
  return { changed, unchanged, new: isNew };
}
