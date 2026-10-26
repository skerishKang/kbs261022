// Does a bigger file actually exist for the images that measured too small?
//
//   node tools/supplier-image-variant-probe.mjs \
//     --ledger <private>/image_probe_ledger.jsonl \
//     --out-dir <private> \
//     --variants-repo reports/data/naver/image_variant_measurements.csv \
//     --aggregate reports/data/naver/image_variant_summary.json
//
// Re-deriving those two committed files from observations that already exist — the
// queue comes out empty, so the run requests nothing:
//
//   node tools/supplier-image-variant-probe.mjs \
//     --ledger <private>/image_probe_ledger.jsonl \
//     --attempt-ledger <private>/image_variant_ledger.jsonl \
//     --variants-repo reports/data/naver/image_variant_measurements.csv \
//     --aggregate reports/data/naver/image_variant_summary.json
//
// The representative probe (tools/supplier-image-probe.mjs) measures the URL the
// catalogue carries. This second pass takes only the URLs that measured below the
// documented 1000x1000 recommendation — or non-square, which the recommendation
// also implies — and asks the supplier's own size segments (/web/product/big|large|
// medium|original/) for the same file name. It answers one question per image: is a
// larger file available at the same path shape, yes or no.
//
// Read-only GETs of public supplier URLs, same as the first pass: no login, no
// credential, no upload, no write outside the named output files.
//
// Like the first pass it is append-only resumable: the variant ledger under
// --out-dir is read back and every candidate URL already observed there is dropped
// from the queue. Without that, re-running this file to fix one derived column would
// re-request 3,385 supplier URLs, and a report could not be regenerated offline.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseCsv } from '../lib/product-mapping.mjs';
import { toCsv } from '../lib/registration-readiness.mjs';
import { probeKey, variantUrlCandidates, assessImageBytes, NAVER_IMAGE_DOC } from '../lib/naver-images.mjs';
import { probeImageUrl, mapConcurrent } from '../lib/image-fetch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};

const LEDGER = option('ledger', null);
const VARIANTS_REPO = option('variants-repo', null);
const AGGREGATE = option('aggregate', null);
const OUT_DIR = option('out-dir', null);
// Naming the observation log separately from --out-dir is what lets the committed
// tables be re-derived from observations that already exist, without touching the
// private copy that recorded the run which made them.
const ATTEMPT_LEDGER = option('attempt-ledger', null);
const CONCURRENCY = Math.max(1, Number(option('concurrency', 6)));
const TIMEOUT_MS = Number(option('timeout-ms', 20000));
const RETRIES = Number(option('retries', 2));
const LIMIT = Number(option('limit', 0));
const NO_RETRY_FAILED = argv.includes('--no-retry-failed');
const RECOMMENDED = NAVER_IMAGE_DOC.representativePixels.width;

if (!LEDGER) {
  console.error('nothing to do: --ledger <image_probe_ledger.jsonl> is required (it carries the URLs that measured too small)');
  process.exit(2);
}
for (const [name, value] of [['--variants-repo', VARIANTS_REPO], ['--aggregate', AGGREGATE]]) {
  if (!value) continue;
  const target = path.resolve(ROOT, value);
  if (!target.startsWith(path.resolve(ROOT) + path.sep)) {
    console.error(`${name} target escapes the repository: ${value}`);
    process.exit(2);
  }
}

const ledgerRows = fs.readFileSync(path.resolve(ROOT, LEDGER), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

/** Only the representatives the bytes say are not usable at the recommended shape. */
const shortfalls = ledgerRows.filter((row) => {
  if (Number(row.http_status) !== 200 || row.parsed !== true) return false;
  const width = Number(row.width) || 0;
  const height = Number(row.height) || 0;
  return width < RECOMMENDED || height < RECOMMENDED || width !== height;
});
const seen = new Set();
const allItems = [];
for (const row of shortfalls) {
  const candidates = variantUrlCandidates(row.url);
  for (const candidate of candidates) {
    const key = probeKey(candidate.url);
    if (seen.has(key)) continue;
    seen.add(key);
    allItems.push({ key, baseKey: row.key, baseWidth: Number(row.width), baseHeight: Number(row.height), segment: candidate.segment, url: candidate.url });
  }
}
// Planned attempts are counted before --limit truncates, so a bounded run can never
// describe a representative it only partially attempted as fully answered.
const plannedByBase = new Map();
for (const item of allItems) plannedByBase.set(item.baseKey, (plannedByBase.get(item.baseKey) || 0) + 1);

/**
 * Resume, exactly as in the first pass: an HTTP status — even 404 — is an answer and
 * is not asked twice; a transport failure (status 0) is not, unless --no-retry-failed
 * says this run is only re-deriving files and must not request anything.
 */
const attemptLedgerPath = ATTEMPT_LEDGER ? path.resolve(ROOT, ATTEMPT_LEDGER)
  : (OUT_DIR ? path.resolve(ROOT, OUT_DIR, 'image_variant_ledger.jsonl') : null);
const previousAttempts = attemptLedgerPath && fs.existsSync(attemptLedgerPath)
  ? fs.readFileSync(attemptLedgerPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : [];
const answered = new Set(previousAttempts.filter((row) => Number(row.http_status) !== 0 || NO_RETRY_FAILED).map((row) => row.key));
let queue = allItems.filter((item) => !answered.has(item.key));
if (LIMIT > 0) queue = queue.slice(0, LIMIT);

console.log(`ledger rows ${ledgerRows.length} · below-recommendation urls ${shortfalls.length} · variant urls planned ${allItems.length} · already observed ${answered.size} · to try ${queue.length} · concurrency ${CONCURRENCY}`);

if (attemptLedgerPath) fs.mkdirSync(path.dirname(attemptLedgerPath), { recursive: true });

const { rows: fetched, stopped } = await mapConcurrent(
  queue,
  CONCURRENCY,
  async (item) => {
    const measuredUrl = await probeImageUrl(item.url, { timeoutMs: TIMEOUT_MS, retries: RETRIES });
    const row = { ...item, ...measuredUrl, base_key: item.baseKey };
    if (attemptLedgerPath) fs.appendFileSync(attemptLedgerPath, `${JSON.stringify(row)}\n`, 'utf8');
    return row;
  },
  { stopAfterConsecutiveFailures: Number(option('stop-after-errors', 120)), onProgress: (count, total) => console.log(`  tried ${count}/${total}`) }
);

// The committed tables describe the plan, so they are built from every observation of
// those candidate URLs — the ones fetched now and the ones a previous run left behind.
const byAttemptKey = new Map();
for (const row of [...previousAttempts, ...fetched]) {
  if (!seen.has(row.key)) continue;
  const previous = byAttemptKey.get(row.key);
  if (!previous || (Number(previous.http_status) === 0 && Number(row.http_status) !== 0)) byAttemptKey.set(row.key, row);
}
const variantRows = [...byAttemptKey.values()];

/**
 * One row per (representative, segment) attempt, joined back by the representative's
 * probe key. The repo copy carries no URL: only the key, the segment name and the
 * measured shape, which is enough for readiness and for a human to re-find the file.
 *
 * A representative whose variants were never all attempted is reported as
 * `not_measured`, not as "no larger file": an unasked question is not a negative answer.
 */
const byBase = new Map();
for (const row of variantRows) {
  if (!byBase.has(row.base_key)) byBase.set(row.base_key, []);
  byBase.get(row.base_key).push(row);
}
const verdicts = [];
for (const row of shortfalls) {
  const attempts = byBase.get(row.key) || [];
  const planned = plannedByBase.get(row.key) || 0;
  const complete = planned > 0 && attempts.length === planned;
  const hits = attempts.filter((attempt) => Number(attempt.http_status) === 200 && attempt.parsed === true);
  const larger = hits.some((attempt) => Number(attempt.width) > Number(row.width) || Number(attempt.height) > Number(row.height));
  const best = hits.reduce((acc, attempt) => (Number(attempt.width) * Number(attempt.height) > Number(acc.width) * Number(acc.height) ? attempt : acc), { segment: 'representative', width: row.width, height: row.height, bytes: row.bytes });
  verdicts.push({
    probe_key: row.key,
    base_width: row.width,
    base_height: row.height,
    variants_planned: planned,
    variants_attempted: attempts.length,
    variants_answered: complete ? 'yes' : 'no',
    variants_found: hits.length,
    variants_404: attempts.filter((attempt) => Number(attempt.http_status) === 404).length,
    larger_available: !complete ? 'not_measured' : larger ? 'yes' : 'no',
    best_segment: !complete ? '' : best.segment,
    best_width: !complete ? '' : best.width,
    best_height: !complete ? '' : best.height,
    best_bytes: !complete ? '' : best.bytes,
    meets_recommended_now: !complete ? 'not_measured' : Number(best.width) >= RECOMMENDED && Number(best.width) === Number(best.height) ? 'yes' : 'no',
  });
}
verdicts.sort((a, b) => (String(a.probe_key) < String(b.probe_key) ? -1 : String(a.probe_key) > String(b.probe_key) ? 1 : 0));

const attemptsTable = variantRows
  .map((row) => ({
    base_probe_key: row.base_key,
    segment: row.segment,
    http_status: row.http_status,
    container: row.format,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    parsed: row.parsed ? 'yes' : 'no',
    // Re-derived from the recorded observation, never copied from the ledger string:
    // a code is an interpretation of the header, and the vocabulary has changed twice.
    reason_codes: assessImageBytes({
      url: row.url,
      status: Number(row.http_status),
      meta: {
        format: row.format, width: Number(row.width) || null, height: Number(row.height) || null,
        bytes: Number(row.bytes) || 0, parsed: row.parsed === true, animationIndicator: row.animated === 'yes',
      },
    }).codes.join(';'),
  }))
  .sort((a, b) => (a.base_probe_key === b.base_probe_key ? String(a.segment).localeCompare(String(b.segment)) : a.base_probe_key < b.base_probe_key ? -1 : 1));

const aggregate = {
  scope: 'read-only GET of supplier size-segment variants for representatives measured below the documented 1000x1000 recommendation — no login, no credential, no upload',
  recommended_pixels: NAVER_IMAGE_DOC.representativePixels,
  representatives_below_recommendation: shortfalls.length,
  variant_urls_planned: allItems.length,
  variant_urls_observed: variantRows.length,
  variant_urls_tried: fetched.length,
  run_complete: variantRows.length === allItems.length && !stopped,
  variants_found_200: variantRows.filter((row) => Number(row.http_status) === 200).length,
  variants_404: variantRows.filter((row) => Number(row.http_status) === 404).length,
  variants_other_status: variantRows.filter((row) => ![200, 404].includes(Number(row.http_status))).length,
  by_variant_status: variantRows.reduce((out, row) => { out[row.http_status] = (out[row.http_status] || 0) + 1; return out; }, {}),
  representatives_fully_answered: verdicts.filter((row) => row.variants_answered === 'yes').length,
  representatives_partially_answered: verdicts.filter((row) => row.variants_answered === 'no').length,
  representatives_with_any_variant: verdicts.filter((row) => Number(row.variants_found) > 0).length,
  representatives_with_larger_variant: verdicts.filter((row) => row.larger_available === 'yes').length,
  representatives_no_larger_variant: verdicts.filter((row) => row.larger_available === 'no').length,
  representatives_not_measured: verdicts.filter((row) => row.larger_available === 'not_measured').length,
  representatives_resolved_to_recommended: verdicts.filter((row) => row.meets_recommended_now === 'yes').length,
  representatives_still_short: verdicts.filter((row) => row.meets_recommended_now === 'no').length,
  best_segment_counts: verdicts.reduce((out, row) => { if (row.best_segment) out[row.best_segment] = (out[row.best_segment] || 0) + 1; return out; }, {}),
  stopped,
};

const written = [];
const write = (target, content, records, unit = '행') => {
  fs.writeFileSync(target, content, 'utf8');
  written.push({ name: path.basename(target), bytes: Buffer.byteLength(content), records, unit });
};

if (VARIANTS_REPO) {
  const target = path.resolve(ROOT, VARIANTS_REPO);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  write(target, toCsv(verdicts, ['probe_key', 'base_width', 'base_height', 'variants_planned', 'variants_attempted', 'variants_answered', 'variants_found', 'variants_404', 'larger_available', 'best_segment', 'best_width', 'best_height', 'best_bytes', 'meets_recommended_now']), verdicts.length);
  const attemptsPath = path.join(path.dirname(target), 'image_variant_attempts.csv');
  write(attemptsPath, toCsv(attemptsTable, ['base_probe_key', 'segment', 'http_status', 'container', 'width', 'height', 'bytes', 'parsed', 'reason_codes']), attemptsTable.length);
}

if (AGGREGATE) {
  const target = path.resolve(ROOT, AGGREGATE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  write(target, `${JSON.stringify(aggregate, null, 1)}\n`, 1, '개 문서');
}

if (OUT_DIR) {
  const dir = path.resolve(ROOT, OUT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  // The append target already holds every observation (resumed rows plus new ones),
  // so rewriting it here would either duplicate the resumed lines or drop them.
  if (!attemptLedgerPath) write(path.join(dir, 'image_variant_ledger.jsonl'), variantRows.map((row) => JSON.stringify(row)).join('\n') + '\n', variantRows.length, '개 관측');
  write(path.join(dir, 'image_variant_summary.json'), `${JSON.stringify(aggregate, null, 1)}\n`, 1, '개 문서');
}

console.log(JSON.stringify({
  SHORTFALL_URLS: aggregate.representatives_below_recommendation,
  VARIANT_URLS_PLANNED: aggregate.variant_urls_planned,
  VARIANT_URLS_OBSERVED: aggregate.variant_urls_observed,
  VARIANT_URLS_FETCHED_THIS_RUN: aggregate.variant_urls_tried,
  RUN_COMPLETE: aggregate.run_complete,
  VARIANTS_FOUND_200: aggregate.variants_found_200,
  VARIANTS_404: aggregate.variants_404,
  WITH_ANY_VARIANT: aggregate.representatives_with_any_variant,
  WITH_LARGER_VARIANT: aggregate.representatives_with_larger_variant,
  NO_LARGER_VARIANT: aggregate.representatives_no_larger_variant,
  NOT_MEASURED: aggregate.representatives_not_measured,
  RESOLVED_TO_RECOMMENDED: aggregate.representatives_resolved_to_recommended,
  STILL_SHORT: aggregate.representatives_still_short,
  STOPPED: aggregate.stopped,
  OUTPUT_FILES: written.map((item) => item.name),
}, null, 1));
