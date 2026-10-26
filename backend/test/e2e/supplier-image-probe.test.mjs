// The probe CLI is the only file in this lane that can touch the network, and the
// only writer of the two committed measurement tables that the readiness report
// joins against. A bug here does not show up as a wrong number in one row: it
// silently rewrites the evidence every later claim is measured against.
//
// These tests run it as a child process over synthetic fixtures with the ledger
// pre-filled, so every queue comes out empty and `to fetch 0` in stdout is the
// proof that nothing was requested. The pure libraries are covered by
// naver-images.test.mjs and image-fetch.test.mjs; what is pinned here is the
// wiring around them — resume, the URL-deduplicated join, re-interpretation at
// write time, the skip/retry flags, the output guards, and byte-for-byte reruns.
//
// Fixtures go through the same toCsv the production files are written with, and
// every path the tool guards (`--measurements`, `--aggregate`) stays under the
// repository's gitignored `.work`: the guard is a repository rule, so testing it
// with a path outside the repository would only prove that it fires.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseCsv } from '../../lib/product-mapping.mjs';
import { toCsv } from '../../lib/registration-readiness.mjs';
import { probeKey } from '../../lib/naver-images.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const TOOL = path.join(ROOT, 'backend/tools/supplier-image-probe.mjs');
const WORK_REL = '.work/probe-test';
const WORK = path.join(ROOT, WORK_REL);
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
after(() => fs.rmSync(WORK, { recursive: true, force: true }));

const SUPPLIER_URL = (name) => `https://www.samamusic.co.kr/web/product/small/202607/${name}.jpg`;
const FOREIGN_URL = 'https://cdn.example.net/img/x.jpg';
const PREP_COLUMNS = ['공급처원본ID', '대표이미지URL', '상세이미지수'];

/** A ledger row is one observation of one URL, shaped exactly as image-fetch writes it. */
const ledgerRow = (url, over = {}) => ({
  key: probeKey(url), url, http_status: 200, content_type: 'image/jpeg', format: 'jpeg', variant: '',
  animated: 'no', width: 1000, height: 1000, bytes: 30000, parsed: true,
  format_allowed: true, meets_recommended_pixels: true, codes: 'image_bytes_measured;image_meets_recommended_pixels',
  unreadable_reason: '', retry_note: '', attempts: 1, elapsed_ms: 40, probed_at: '2026-10-25T00:00:00.000Z',
  give_up: false, ...over,
});

const writeSource = (name, rows) => {
  fs.writeFileSync(path.join(WORK, `${name}.csv`), toCsv(rows, PREP_COLUMNS), 'utf8');
  return `${WORK_REL}/${name}.csv`;
};
const writeLedger = (name, rows) => {
  fs.writeFileSync(path.join(WORK, `${name}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n'), 'utf8');
  return `${WORK_REL}/${name}.jsonl`;
};

/**
 * Runs the tool offline and hands back everything it wrote. `label` isolates the
 * output directory so two runs of the same input can be compared byte for byte.
 */
function probe(label, { source, ledger, args = [] }) {
  const outRel = `${WORK_REL}/${label}`;
  const outDir = path.join(ROOT, outRel);
  fs.mkdirSync(outDir, { recursive: true });
  const stdout = execFileSync(process.execPath, [
    TOOL, '--source', source, '--ledger', ledger, '--out-dir', outRel,
    '--measurements', `${outRel}/image_measurements.csv`,
    '--aggregate', `${outRel}/published_summary.json`,
    ...args,
  ], { encoding: 'utf8' });
  const readCsv = (name) => parseCsv(fs.readFileSync(path.join(outDir, name), 'utf8'));
  const readJson = (name) => JSON.parse(fs.readFileSync(path.join(outDir, name), 'utf8'));
  return {
    stdout,
    outDir,
    measurements: readCsv('image_measurements.csv'),
    manifest: readCsv('naver_image_probe_manifest.csv'),
    published: readJson('published_summary.json'),
    private: readJson('image_probe_summary.json'),
    printed: JSON.parse(stdout.slice(stdout.lastIndexOf('\n{'))),
    // Every queue line ends in `to fetch N`; a nonzero N would have hit the network.
    noRequests: /to fetch 0 ·/.test(stdout),
  };
}

const sourceOneUrl = writeSource('one-url', [
  { 공급처원본ID: 'samamusic:1', 대표이미지URL: SUPPLIER_URL('a'), 상세이미지수: '4' },
  { 공급처원본ID: 'samamusic:2', 대표이미지URL: SUPPLIER_URL('b'), 상세이미지수: '0' },
  // Two products, one image: the evidence is per URL, so the join must not fan out.
  { 공급처원본ID: 'samamusic:3', 대표이미지URL: SUPPLIER_URL('a'), 상세이미지수: '2' },
]);
const ledgerBoth = writeLedger('both', [ledgerRow(SUPPLIER_URL('a')), ledgerRow(SUPPLIER_URL('b'))]);

test('a full ledger means an empty queue: the tables come from the observations alone', () => {
  const run = probe('dedup', { source: sourceOneUrl, ledger: ledgerBoth });
  assert.equal(run.noRequests, true, `nothing may be fetched: ${run.stdout.split('\n')[0]}`);
  assert.match(run.stdout, /^source rows 3 · distinct urls 2 · already probed 2 · skipped 0 · to fetch 0/m);

  assert.equal(run.measurements.length, 2, 'one row per distinct URL, not per product');
  const keys = run.measurements.map((row) => row.probe_key);
  assert.deepEqual(keys, [...keys].sort(), 'sorted by key so a restart can skip by key');
  assert.equal(new Set(keys).size, 2);
  assert.deepEqual(keys.sort(), [probeKey(SUPPLIER_URL('a')), probeKey(SUPPLIER_URL('b'))].sort(),
    'the join key is sha256 of the URL the table never carries');
  for (const row of run.measurements) {
    assert.equal(row.http_status, '200');
    assert.equal(row.reason_codes, 'image_bytes_measured;image_meets_recommended_pixels');
    assert.equal(row.format_allowed, 'yes');
    assert.equal(row.meets_recommended_pixels, 'yes');
  }

  assert.equal(run.manifest.length, 3, 'the private manifest is per product');
  assert.deepEqual(run.manifest.map((row) => row['공급처원본ID']), ['samamusic:1', 'samamusic:2', 'samamusic:3']);
  assert.equal(run.manifest[0]['가로'], run.manifest[2]['가로'], 'two products sharing an image share its measurement');
  assert.equal(run.manifest[0]['업로드배치수'], '1', 'one representative is one upload call');
  assert.equal(run.printed.FETCHED_OK, 2);
  assert.equal(run.printed.NOT_PROBED, 0, 'the third product reuses a measured URL, so no product is left unprobed');
  assert.equal(run.printed.STOPPED, null, 'an empty queue cannot stop on failures');
  assert.equal(run.private.products, 3, 'the private copy keeps the product census');

  // What may leave this machine is counts and shapes only.
  const text = JSON.stringify(run.published);
  assert.ok(!text.includes('http'), 'the published aggregate must carry no supplier URL');
  assert.ok(!text.includes('samamusic'), 'and no product id');
  assert.equal(run.published.source, undefined, 'the source path and observation window stay in the private copy');
  assert.equal(run.published.stopped, undefined);
  assert.ok(run.private.source.includes('probe-test'), 'the private copy names the file it read');
});

test('re-running the probe over the same ledger reproduces the committed table byte for byte', () => {
  const a = probe('rerun-a', { source: sourceOneUrl, ledger: ledgerBoth });
  const b = probe('rerun-b', { source: sourceOneUrl, ledger: ledgerBoth });
  for (const name of ['image_measurements.csv', 'naver_image_probe_manifest.csv', 'image_probe_summary.json']) {
    const sha = (dir) => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex');
    assert.equal(sha(a.outDir), sha(b.outDir), `${name} must be a pure function of the ledger`);
  }
  assert.equal(fs.readFileSync(path.join(ROOT, ledgerBoth), 'utf8').split('\n').length, 2,
    'an empty queue appends nothing to the ledger it read');
});

test('a reason code is an interpretation, so a stale ledger vocabulary cannot reach the table', () => {
  // The codes below were written by earlier versions of this lane's vocabulary.
  // The observation (1000x1000 jpeg, parsed) is what must be re-read at write time.
  const source = writeSource('stale', [{ 공급처원본ID: 'samamusic:1', 대표이미지URL: SUPPLIER_URL('a'), 상세이미지수: '0' }]);
  const ledger = writeLedger('stale', [ledgerRow(SUPPLIER_URL('a'), {
    codes: 'image_probe_http_404;thumbnail_variant_only', format_allowed: false, meets_recommended_pixels: false,
  })]);
  const run = probe('stale', { source, ledger });
  assert.equal(run.noRequests, true);
  const text = fs.readFileSync(path.join(run.outDir, 'image_measurements.csv'), 'utf8');
  assert.ok(!text.includes('image_probe_http_404'), 'a code this lane renamed must not survive in the committed table');
  assert.ok(!text.includes('thumbnail_variant_only'), 'and a retired guess must not be resurrected from a ledger');
  assert.equal(run.measurements[0].reason_codes, 'image_bytes_measured;image_meets_recommended_pixels');
  assert.equal(run.measurements[0].format_allowed, 'yes', 'allowed-ness follows the measured container, not the stored flag');
  assert.equal(run.measurements[0].meets_recommended_pixels, 'yes');
  assert.equal(run.manifest[0]['사유코드'], 'image_bytes_measured;image_meets_recommended_pixels');
});

test('a later 200 outranks an earlier transport failure, and a failure never erases a 200', () => {
  const source = writeSource('rank', [{ 공급처원본ID: 'samamusic:1', 대표이미지URL: SUPPLIER_URL('a'), 상세이미지수: '0' }]);
  const failed = ledgerRow(SUPPLIER_URL('a'), { http_status: 0, format: '', width: '', height: '', bytes: 0, parsed: false, codes: 'image_probe_not_fetched', give_up: true, unreadable_reason: 'TimeoutError: fetch failed' });
  const ok = ledgerRow(SUPPLIER_URL('a'));
  for (const [label, rows] of [['fail-then-ok', [failed, ok]], ['ok-then-fail', [ok, failed]]]) {
    const run = probe(label, { source, ledger: writeLedger(label, rows), args: ['--no-retry-failed'] });
    assert.equal(run.noRequests, true, `${label}: --no-retry-failed keeps a status-0 observation out of the queue`);
    assert.match(run.stdout, /already probed 1 · skipped 0 · to fetch 0/, label);
    assert.equal(run.measurements[0].http_status, '200', `${label}: the answer must win over the failure in either order`);
    assert.equal(run.measurements.length, 1, `${label}: two observations of one URL are still one row`);
  }
});

test('a skipped host and a never-fetched URL are stated differently from each other', () => {
  const source = writeSource('skip', [
    { 공급처원본ID: 'samamusic:1', 대표이미지URL: SUPPLIER_URL('a'), 상세이미지수: '0' },
    { 공급처원본ID: 'samamusic:2', 대표이미지URL: FOREIGN_URL, 상세이미지수: '0' },
  ]);
  const failed = ledgerRow(FOREIGN_URL, { http_status: 0, format: '', width: '', height: '', bytes: 0, parsed: false, codes: 'image_probe_not_fetched', give_up: true });
  const known = writeLedger('skip-known', [ledgerRow(SUPPLIER_URL('a'))]);

  // Outside the supplier hosts, nothing is requested and the row says why.
  const skippedRun = probe('skip-external', { source, ledger: known, args: ['--skip-external'] });
  assert.equal(skippedRun.noRequests, true);
  assert.match(skippedRun.stdout, /distinct urls 2 · already probed 1 · skipped 1 · to fetch 0/);
  const foreign = skippedRun.measurements.find((row) => row.probe_key === probeKey(FOREIGN_URL));
  assert.equal(foreign.reason_codes, 'image_probe_skipped_host', 'the table must not hide which URLs this run refused to reach');
  assert.equal(foreign.http_status, '0');
  assert.equal(foreign.format_allowed, '', 'no observation, no verdict');
  assert.equal(foreign.width, '');
  assert.equal(skippedRun.manifest.find((row) => row['공급처원본ID'] === 'samamusic:2')['사유코드'], 'image_not_probed',
    'the product-facing manifest says what happened to that product: it was not probed');

  // With --no-retry-failed the same URL is no longer "skipped" — it is a fetched
  // transport failure, which is a different fact and gets a different code.
  const giveUp = probe('skip-giveup', { source, ledger: writeLedger('skip-both', [ledgerRow(SUPPLIER_URL('a')), failed]), args: ['--no-retry-failed'] });
  assert.equal(giveUp.noRequests, true);
  assert.match(giveUp.stdout, /already probed 2 · skipped 0 · to fetch 0/, 'the flag, not the host list, kept the failed URL out of the queue');
  const row = giveUp.measurements.find((r) => r.probe_key === probeKey(FOREIGN_URL));
  assert.equal(row.reason_codes, 'image_probe_not_fetched', 'fetched-and-failed is not the same as never-fetched');
});

test('the repo-facing outputs cannot be redirected outside the repository, and a bad column fails loudly', () => {
  const base = ['--source', sourceOneUrl, '--ledger', ledgerBoth, '--out-dir', `${WORK_REL}/guard`];
  const failWith = (args) => {
    try {
      execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', stdio: 'pipe' });
      return { status: 0, text: '' };
    } catch (error) {
      return { status: error.status, text: `${error.stdout || ''}${error.stderr || ''}` };
    }
  };
  const escape = '../probe_escape_summary.json';
  for (const name of ['--aggregate', '--measurements']) {
    const result = failWith([...base, name, escape]);
    assert.equal(result.status, 2, `${name} outside the repository must exit 2, saw ${result.status}: ${result.text}`);
    assert.match(result.text, /escapes the repository/, name);
    assert.equal(fs.existsSync(path.join(ROOT, '..', 'probe_escape_summary.json')), false, `${name} must fail before writing`);
  }
  const nothing = failWith(['--source', sourceOneUrl]);
  assert.equal(nothing.status, 2, 'a run that writes nothing is a run that proves nothing');
  assert.match(nothing.text, /nothing to write/);

  const badColumn = writeSource('bad-column', [{ 공급처원본ID: 'samamusic:1', 대표이미지URL: SUPPLIER_URL('a'), 상세이미지수: '0' }]);
  const missing = failWith(['--source', badColumn, '--url-column', '없는열', '--aggregate', `${WORK_REL}/guard/x.json`]);
  assert.equal(missing.status, 2, 'a renamed column must not silently probe an empty URL set');
  assert.match(missing.text, /column 없는열 is not in/);
});
