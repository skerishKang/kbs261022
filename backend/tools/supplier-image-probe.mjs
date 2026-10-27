// Runs the supplier-image probe for real, with resume.
//
//   node tools/supplier-image-probe.mjs \
//     --source data/smartstore_prep/smartstore_registration_prep.csv \
//     --url-column 대표이미지URL --key-column 공급처원본ID \
//     --out-dir tmp/naver-image-prep --aggregate reports/data/naver/image_probe_summary.json
//
// This is the only file in this lane that touches the network, and it only ever
// GETs a public supplier image URL already stored in this repository: no login,
// no credential, no header that would impersonate a browser, no write anywhere.
//
// The ledger is an append-only observation log (it carries a wall-clock per
// fetch, because "when was the image seen" is part of the evidence). Everything
// derived from it — the manifest CSV and the aggregate JSON — is a pure function
// of the ledger and is byte-identical for the same ledger, which is what the
// tests pin.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseCsv } from '../lib/product-mapping.mjs';
import { toCsv } from '../lib/registration-readiness.mjs';
import { probeImageUrl, mapConcurrent } from '../lib/image-fetch.mjs';
import { probeKey, planImageUpload, summarizeProbe, assessImageBytes, NAVER_ALLOWED_FORMATS, NAVER_IMAGE_DOC } from '../lib/naver-images.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const flag = (name) => argv.includes(`--${name}`);

const SOURCESPEC = option('source', 'data/smartstore_prep/smartstore_registration_prep.csv');
const URL_COLUMN = option('url-column', '대표이미지URL');
const KEY_COLUMN = option('key-column', '공급처원본ID');
const DETAIL_COLUMN = option('detail-column', '상세이미지수');
const OUT_DIR = option('out-dir', null);
const AGGREGATE = option('aggregate', null);
const LEDGER = option('ledger', null);
const MEASUREMENTS = option('measurements', null);
const KEYS_FROM = option('keys-from', null);
const CONCURRENCY = Math.max(1, Number(option('concurrency', 4)));
const LIMIT = Number(option('limit', 0));
const TIMEOUT_MS = Number(option('timeout-ms', 20000));
const RETRIES = Number(option('retries', 2));
const STALL_AFTER = Number(option('stop-after-errors', 40));
const NO_RETRY_FAILED = flag('no-retry-failed');

if (!OUT_DIR && !AGGREGATE && !LEDGER && !MEASUREMENTS) {
  console.error('nothing to write: pass --out-dir (private manifest), --measurements (join table for readiness), --aggregate (repo JSON) and/or --ledger (JSONL observation log)');
  process.exit(2);
}
// The measurement table and the aggregate are the two files this lane commits, so
// they may not be redirected outside the repository — that is where they would
// silently stop being reproducible evidence.
for (const [name, value] of [['--aggregate', AGGREGATE], ['--measurements', MEASUREMENTS]]) {
  if (!value) continue;
  const target = path.resolve(ROOT, value);
  if (!target.startsWith(path.resolve(ROOT) + path.sep)) {
    console.error(`${name} target escapes the repository: ${value}`);
    process.exit(2);
  }
}

const sourceRows = parseCsv(fs.readFileSync(path.join(ROOT, SOURCESPEC), 'utf8'));
if (!sourceRows.length) {
  console.error(`no rows read from ${SOURCESPEC}`);
  process.exit(2);
}
for (const column of [URL_COLUMN, KEY_COLUMN]) {
  if (!(column in sourceRows[0])) {
    console.error(`column ${column} is not in ${SOURCESPEC}: ${Object.keys(sourceRows[0]).join(',')}`);
    process.exit(2);
  }
}

/** Already-fetched URLs are skipped: a restart must not re-request the catalogue. */
const readLedger = (file) => {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
};
const ledgerPath = LEDGER ? path.resolve(ROOT, LEDGER) : (OUT_DIR ? path.resolve(ROOT, OUT_DIR, 'image_probe_ledger.jsonl') : null);
const existing = readLedger(ledgerPath);
// --keys-from names probe keys (any 64-hex token in the file — a measurement table
// or a ledger both work) that must be observed again instead of reused, so a
// bounded pilot's rows are refreshed inside the full run rather than shadowing it.
const refetch = new Set(KEYS_FROM ? (fs.readFileSync(path.resolve(ROOT, KEYS_FROM), 'utf8').match(/\b[0-9a-f]{64}\b/g) || []) : []);
// An HTTP status — even 404 — is an answer and is not asked twice. A transport
// failure (status 0) is not an answer, so it is requeued unless --no-retry-failed.
const done = new Set(existing.filter((row) => (Number(row.http_status) !== 0 || NO_RETRY_FAILED) && !refetch.has(row.key)).map((row) => row.key));

const targets = [];
const seen = new Set();
for (const row of sourceRows) {
  const url = String(row[URL_COLUMN] || '').trim();
  if (!url) continue;
  const key = probeKey(url);
  if (seen.has(key)) continue;
  seen.add(key);
  targets.push({ key, url, productKey: row[KEY_COLUMN], detailCount: Number(row[DETAIL_COLUMN] ?? 0) || 0 });
}
// --skip-external keeps the read inside the supplier hosts the catalogue already
// carries; anything else is reported as skipped_forbidden_host, not fetched.
const skipped = new Set(
  flag('skip-external') ? targets.filter((target) => !/^https?:\/\/[^/]*(samamusic|samasound|samastore)\./i.test(target.url)).map((target) => target.key) : []
);
const queue = targets.filter((target) => !done.has(target.key) && !skipped.has(target.key));
if (LIMIT > 0) queue.length = Math.min(queue.length, LIMIT);

console.log(`source rows ${sourceRows.length} · distinct urls ${targets.length} · already probed ${done.size} · skipped ${skipped.size} · to fetch ${queue.length} · concurrency ${CONCURRENCY}`);

if (ledgerPath) fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });

const { rows: results, stopped } = await mapConcurrent(
  queue,
  CONCURRENCY,
  async (target) => {
    const measured = await probeImageUrl(target.url, { timeoutMs: TIMEOUT_MS, retries: RETRIES });
    const row = { key: target.key, ...measured, give_up: measured.http_status === 0 };
    if (ledgerPath) fs.appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`, 'utf8');
    return row;
  },
  { stopAfterConsecutiveFailures: STALL_AFTER, onProgress: (done_, total) => console.log(`  probed ${done_}/${total}`) }
);

const all = [...existing.filter((row) => targets.some((target) => target.key === row.key)), ...results];
const byKey = new Map();
for (const row of all) {
  const previous = byKey.get(row.key);
  // A later success must outrank an earlier transport failure of the same URL.
  if (!previous || (Number(previous.http_status) !== 200 && Number(row.http_status) === 200)) byKey.set(row.key, row);
}
const probed = [...byKey.values()];
const probeByKey = new Map(probed.map((row) => [row.url, row]));

/**
 * A reason code is an interpretation of the recorded observation, not part of the
 * observation, so it is re-derived at write time. That keeps the committed table
 * speaking the current vocabulary: a ledger row fetched last month still reports
 * what its bytes measured, and a renamed code never leaves a stale string behind.
 */
const interpret = (hit) => {
  if (!hit) return null;
  const meta = {
    format: hit.format,
    width: Number(hit.width) || null,
    height: Number(hit.height) || null,
    bytes: Number(hit.bytes) || 0,
    parsed: hit.parsed === true,
    animationIndicator: hit.animated === 'yes',
  };
  const assessment = assessImageBytes({ url: hit.url, status: Number(hit.http_status), meta });
  return { codes: assessment.codes.join(';'), formatAllowed: assessment.formatAllowed, meetsRecommended: assessment.meetsRecommendedPixels };
};

const manifest = [];
for (const row of sourceRows) {
  const url = String(row[URL_COLUMN] || '').trim();
  const hit = url ? probeByKey.get(url) : undefined;
  const seen = interpret(hit);
  const plan = hit ? planImageUpload([{ url, formatAllowed: seen.formatAllowed }]) : null;
  manifest.push({
    공급처원본ID: row[KEY_COLUMN],
    이미지URL: url,
    조회상태: hit ? String(hit.http_status) : 'not_probed',
    콘텐츠형식: hit?.content_type || '',
    컨테이너: hit?.format || '',
    가로: hit?.width ?? '',
    세로: hit?.height ?? '',
    바이트: hit?.bytes ?? '',
    허용형식: seen ? (seen.formatAllowed ? 'yes' : 'no') : '',
    권장해상도충족: seen ? (seen.meetsRecommended ? 'yes' : 'no') : '',
    사유코드: seen ? seen.codes : 'image_not_probed',
    해석실패사유: hit?.unreadable_reason || '',
    시도시도: hit?.attempts ?? '',
    관측시각: hit?.probed_at || '',
    상세이미지수: Number(row[DETAIL_COLUMN] ?? 0) || 0,
    업로드배치수: plan ? plan.upload_calls : '',
  });
}
manifest.sort((a, b) => (String(a['공급처원본ID']) < String(b['공급처원본ID']) ? -1 : String(a['공급처원본ID']) > String(b['공급처원본ID']) ? 1 : 0));

/**
 * The repo-facing join table: sha256 of the URL (already public in the committed
 * prep CSV) and the measured header, with no URL and no supplier id. `classifyCatalog`
 * joins readiness to it by the same key, so a size claim is backed by bytes.
 */
const measurements = targets.map((target) => {
  const hit = probeByKey.get(target.url);
  const seen = interpret(hit);
  const notFetched = skipped.has(target.key) ? 'image_probe_skipped_host' : 'image_not_probed';
  return {
    probe_key: target.key,
    http_status: hit?.http_status ?? 0,
    container: hit?.format || '',
    width: hit?.width ?? '',
    height: hit?.height ?? '',
    bytes: hit?.bytes ?? '',
    format_allowed: seen ? (seen.formatAllowed ? 'yes' : 'no') : '',
    meets_recommended_pixels: seen ? (seen.meetsRecommended ? 'yes' : 'no') : '',
    reason_codes: seen ? seen.codes : notFetched,
    header_variant: hit?.variant || '',
    animation_indicator: hit?.animated || '',
  };
}).sort((a, b) => (a.probe_key < b.probe_key ? -1 : a.probe_key > b.probe_key ? 1 : 0));

const MEASUREMENT_COLUMNS = ['probe_key', 'http_status', 'container', 'width', 'height', 'bytes', 'format_allowed', 'meets_recommended_pixels', 'reason_codes', 'header_variant', 'animation_indicator'];
const MANIFEST_COLUMNS = Object.keys(manifest[0] || {});

const measured = measurements.filter((row) => row.http_status === 200);
const aggregate = {
  scope: 'read-only GET of supplier public image URLs already stored in this repository — no login, no credential, no upload call',
  source: SOURCESPEC,
  url_column: URL_COLUMN,
  concurrency: CONCURRENCY,
  stopped,
  products: sourceRows.length,
  distinct_image_urls: targets.length,
  urls_with_url: manifest.filter((row) => row.이미지URL).length,
  products_without_url: manifest.filter((row) => !row.이미지URL).length,
  not_probed: manifest.filter((row) => row.조회상태 === 'not_probed').length,
  give_up_rows: probed.filter((row) => row.give_up === true).length,
  upload_calls_required: measured.filter((row) => row.format_allowed === 'yes').length,
  products_with_detail_images: manifest.filter((row) => row.상세이미지수 > 0).length,
  detail_image_url_column_present: Object.keys(sourceRows[0]).includes('상세이미지URL'),
  allowed_formats: NAVER_ALLOWED_FORMATS,
  documented_limits: NAVER_IMAGE_DOC,
  ...summarizeProbe(probed),
};

/**
 * What may leave this machine: counts and shapes only. The observation window and
 * the source path stay in the private copy, so the published file cannot be turned
 * into a request log against the supplier.
 */
const published = {
  products: aggregate.products,
  distinct_image_urls: aggregate.distinct_image_urls,
  products_without_url: aggregate.products_without_url,
  urls_with_url: aggregate.urls_with_url,
  not_probed: aggregate.not_probed,
  allowed_formats: aggregate.allowed_formats,
  documented_limits: aggregate.documented_limits,
  urls_probed: aggregate.urls_probed,
  fetched_ok: aggregate.fetched_ok,
  by_status: aggregate.by_status,
  by_format: aggregate.by_format,
  by_header_variant: aggregate.by_header_variant,
  format_allowed: aggregate.format_allowed,
  format_rejected: aggregate.format_rejected,
  unreadable_bytes: aggregate.unreadable_bytes,
  square: aggregate.square,
  non_square: aggregate.non_square,
  meets_recommended_1000: aggregate.meets_recommended_1000,
  dimensions_measured: aggregate.dimensions_measured,
  distinct_dimensions: aggregate.distinct_dimensions,
  bytes_min: aggregate.bytes_min,
  bytes_p50: aggregate.bytes_p50,
  bytes_max: aggregate.bytes_max,
  bytes_over_1mb: aggregate.bytes_over_1mb,
};

const written = [];
const write = (target, content, records, unit = '행') => {
  fs.writeFileSync(target, content, 'utf8');
  written.push({ name: path.basename(target), bytes: Buffer.byteLength(content), records, unit });
};

if (OUT_DIR) {
  const dir = path.resolve(ROOT, OUT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  write(path.join(dir, 'naver_image_probe_manifest.csv'), toCsv(manifest, MANIFEST_COLUMNS), manifest.length);
  write(path.join(dir, 'image_probe_summary.json'), `${JSON.stringify(aggregate, null, 1)}\n`, 1, '개 문서');
}

if (MEASUREMENTS) {
  const target = path.resolve(ROOT, MEASUREMENTS);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  write(target, toCsv(measurements, MEASUREMENT_COLUMNS), measurements.length);
}

if (AGGREGATE) {
  const target = path.resolve(ROOT, AGGREGATE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  write(target, `${JSON.stringify(published, null, 1)}\n`, 1, '개 문서');
}

console.log(JSON.stringify({
  URLS_PROBED: aggregate.urls_probed,
  FETCHED_OK: aggregate.fetched_ok,
  FORMAT_ALLOWED: aggregate.format_allowed,
  FORMAT_REJECTED: aggregate.format_rejected,
  DIMENSIONS_MEASURED: aggregate.dimensions_measured,
  SQUARE: aggregate.square,
  NON_SQUARE: aggregate.non_square,
  MEETS_RECOMMENDED_1000: aggregate.meets_recommended_1000,
  UNREADABLE: aggregate.unreadable_bytes,
  NOT_PROBED: aggregate.not_probed,
  STOPPED: aggregate.stopped,
  OUTPUT_FILES: written.map((item) => item.name),
}, null, 1));
