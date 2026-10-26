// The second image pass: is a bigger file actually available?
//
// `reports/data/naver/image_variant_measurements.csv` is the evidence behind the
// readiness report's one rescue (a representative that measured too small but has a
// size segment that reaches 1000x1000) and behind 638 claims that no bigger file
// exists. Two things are checked here, and they are different things:
//
//  1. the committed verdict table, recomputed row by row from the committed attempt
//     table — the raw one-line-per-(image, segment) fetch log. A verdict that no
//     longer follows from the observations it summarises is a fabrication, whatever
//     the tool that wrote it says.
//  2. the tool itself, run as a child process over synthetic ledgers. Both ledgers
//     are pre-filled, so the queue comes out empty and `to try 0` in stdout is the
//     proof that nothing was requested. This is what pins the rule that an unasked
//     question is not a negative answer, and that a reason code is re-interpreted at
//     write time rather than copied out of an old observation log.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseCsv } from '../../lib/product-mapping.mjs';
import { probeKey, variantUrlCandidates } from '../../lib/naver-images.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const TOOL = path.join(ROOT, 'backend/tools/supplier-image-variant-probe.mjs');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const TABLES = {
  measurements: 'reports/data/naver/image_measurements.csv',
  verdicts: 'reports/data/naver/image_variant_measurements.csv',
  attempts: 'reports/data/naver/image_variant_attempts.csv',
  prep: 'data/smartstore_prep/smartstore_registration_prep.csv',
};
const RECOMMENDED = 1000;

const attempts = parseCsv(read(TABLES.attempts));
const verdicts = parseCsv(read(TABLES.verdicts));
const measurements = new Map(parseCsv(read(TABLES.measurements)).map((row) => [row.probe_key, row]));
// The committed tables carry no URL by design, so the base URL of a verdict is
// recovered from the prep file the catalogue itself publishes.
const urlByKey = new Map();
for (const row of parseCsv(read(TABLES.prep))) {
  const url = String(row.대표이미지URL || '').trim();
  if (url) urlByKey.set(probeKey(url), url);
}
const attemptsByBase = new Map();
for (const row of attempts) {
  if (!attemptsByBase.has(row.base_probe_key)) attemptsByBase.set(row.base_probe_key, []);
  attemptsByBase.get(row.base_probe_key).push(row);
}

test('every committed segment verdict follows from the fetch log it summarises', () => {
  assert.ok(verdicts.length > 600, `the sweep covers the whole shortfall set, saw ${verdicts.length}`);
  assert.equal(new Set(verdicts.map((row) => row.probe_key)).size, verdicts.length, 'one verdict per representative');
  for (const verdict of verdicts) {
    const base = measurements.get(verdict.probe_key);
    assert.ok(base, `${verdict.probe_key}: a verdict must belong to a measured representative`);
    assert.equal(verdict.base_width, base.width, `${verdict.probe_key}: the base width is the measured representative`);
    assert.equal(verdict.base_height, base.height, `${verdict.probe_key}: the base height is the measured representative`);
    assert.equal(base.meets_recommended_pixels, 'no',
      `${verdict.probe_key}: a verdict for an image that already meets the recommendation would be a sweep nobody needed`);

    const tried = attemptsByBase.get(verdict.probe_key) || [];
    assert.equal(verdict.variants_attempted, String(tried.length), `${verdict.probe_key}: attempted is the count of fetches made`);
    const url = urlByKey.get(verdict.probe_key);
    assert.ok(url, `${verdict.probe_key}: every verdict must be re-findable in the catalogue`);
    assert.equal(verdict.variants_planned, String(variantUrlCandidates(url).length),
      `${verdict.probe_key}: planned is the number of segment URLs the measured shape offers`);
    const answered = Number(verdict.variants_planned) > 0 && tried.length === Number(verdict.variants_planned);
    assert.equal(verdict.variants_answered, answered ? 'yes' : 'no', `${verdict.probe_key}: answered follows the plan`);

    const hits = tried.filter((row) => Number(row.http_status) === 200 && row.parsed === 'yes');
    assert.equal(verdict.variants_found, String(hits.length), `${verdict.probe_key}: found counts only fetched, readable images`);
    assert.equal(verdict.variants_404, String(tried.filter((row) => Number(row.http_status) === 404).length),
      `${verdict.probe_key}: the refusals are counted from the log`);

    if (!answered) {
      // The whole point of `not_measured`: a partially attempted sweep may not be
      // reported as "the supplier has nothing bigger".
      assert.equal(verdict.larger_available, 'not_measured', `${verdict.probe_key}: an unasked question is not a negative answer`);
      assert.equal(verdict.meets_recommended_now, 'not_measured', `${verdict.probe_key}: nor a positive one`);
      assert.equal(verdict.best_segment, '', `${verdict.probe_key}: a partial sweep names no file`);
      continue;
    }

    const baseArea = Number(verdict.base_width) * Number(verdict.base_height);
    const largest = hits.reduce((max, row) => Math.max(max, Number(row.width) * Number(row.height)), baseArea);
    assert.ok(hits.every((row) => Number(row.width) * Number(row.height) <= largest), `${verdict.probe_key}: best is the largest hit`);
    assert.equal(Number(verdict.best_width) * Number(verdict.best_height), largest, `${verdict.probe_key}: best_width x best_height is the largest area measured`);
    const bigger = hits.some((row) => Number(row.width) > Number(verdict.base_width) || Number(row.height) > Number(verdict.base_height));
    assert.equal(verdict.larger_available, bigger ? 'yes' : 'no', `${verdict.probe_key}: larger_available is decided by the fetched files`);
    if (verdict.best_segment === 'representative') {
      assert.equal(largest, baseArea, `${verdict.probe_key}: representative is only best when no fetched file beat it`);
      assert.equal(verdict.best_bytes, base.bytes, `${verdict.probe_key}: representative means the representative's own bytes`);
    } else {
      const winner = hits.find((row) => row.segment === verdict.best_segment);
      assert.ok(winner, `${verdict.probe_key}: best_segment must name a file that was fetched`);
      assert.equal(verdict.best_width, winner.width, `${verdict.probe_key}: best_width is that file's measured width`);
      assert.equal(verdict.best_height, winner.height, `${verdict.probe_key}: best_height is that file's measured height`);
      assert.equal(verdict.best_bytes, winner.bytes, `${verdict.probe_key}: best_bytes is that file's measured size`);
    }
    const meetsNow = Number(verdict.best_width) >= RECOMMENDED && Number(verdict.best_width) === Number(verdict.best_height);
    assert.equal(verdict.meets_recommended_now, meetsNow ? 'yes' : 'no', `${verdict.probe_key}: the rescue verdict follows the best measured file`);
  }

  // No verdict may be missing for a base that was swept, and no attempt may be
  // orphaned — the two tables are the same run, joined by one key.
  assert.deepEqual(
    [...new Set(attempts.map((row) => row.base_probe_key))].sort(),
    verdicts.map((row) => row.probe_key).sort(),
    'the attempt log and the verdict table describe exactly the same representatives',
  );
});

// ---------------------------------------------------------------- the tool itself

const WORK_REL = '.work/variant-probe-test';
const WORK = path.join(ROOT, WORK_REL);
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
after(() => fs.rmSync(WORK, { recursive: true, force: true }));

const SUPPLIER = (name) => `https://www.samamusic.co.kr/web/product/small/202607/${name}.jpg`;
const baseRow = (url, over = {}) => ({
  key: probeKey(url), url, http_status: 200, parsed: true, format: 'jpeg', width: 500, height: 500, bytes: 40000,
  animated: 'no', codes: 'image_bytes_measured;image_below_recommended_pixels', ...over,
});
/** The candidate URLs a base row would be swept with, as the tool itself derives them. */
const candidatesOf = (url) => variantUrlCandidates(url);
const attemptRow = (base, candidate, over = {}) => ({
  key: probeKey(candidate.url), baseKey: base.key, base_key: base.key, baseWidth: base.width, baseHeight: base.height,
  segment: candidate.segment, url: candidate.url, http_status: 404, content_type: 'text/html', format: 'unknown',
  variant: '', animated: 'no', width: '', height: '', bytes: 150, parsed: false, format_allowed: false,
  meets_recommended_pixels: false, codes: 'image_probe_http_404', unreadable_reason: '', retry_note: '', attempts: 1,
  elapsed_ms: 30, probed_at: '2026-10-25T00:00:00.000Z', give_up: false, ...over,
});
const refused = (base, candidate) => attemptRow(base, candidate);
const written = {};
const writeFile = (name, text) => { fs.writeFileSync(path.join(WORK, name), text, 'utf8'); return `${WORK_REL}/${name}`; };

// B is the rescue: its /big/ segment serves 1200x1200. C is non-square and has
// nothing bigger. D already meets the recommendation, so it must not be swept at all.
const A = baseRow(SUPPLIER('a'));
const B = baseRow(SUPPLIER('b'));
const C = baseRow(SUPPLIER('c'), { width: 500, height: 700 });
const D = baseRow(SUPPLIER('d'), { width: 1000, height: 1000, codes: 'image_bytes_measured;image_meets_recommended_pixels' });
const shortfallBases = [A, B, C];
const attemptLedger = [];
for (const base of shortfallBases) {
  for (const candidate of candidatesOf(base.url)) {
    const rescued = base === B && candidate.segment === 'big';
    attemptLedger.push(rescued
      ? attemptRow(base, candidate, { http_status: 200, content_type: 'image/png', format: 'png', width: 1200, height: 1200, bytes: 210000, parsed: true, animated: 'no', codes: 'image_bytes_measured;image_meets_recommended_pixels' })
      : refused(base, candidate));
  }
}
written.ledger = writeFile('image_probe_ledger.jsonl', [...shortfallBases, D].map((row) => JSON.stringify(row)).join('\n'));
written.attempts = writeFile('image_variant_ledger.jsonl', attemptLedger.map((row) => JSON.stringify(row)).join('\n'));
// An observation log is raw data, so this fixture deliberately stores the vocabulary
// an older build wrote (`image_probe_http_404`). Only the committed table has to speak
// today's codes, and that is what the run below is checked for.
written.legacy = writeFile('image_variant_ledger_legacy.jsonl', attemptLedger.map((row) => JSON.stringify(row)).join('\n'));

/**
 * Every fixture here pre-fills the attempt log, so the queue must come out empty.
 * The guard is inside the runner rather than in each test: a fixture edited later to
 * plan one more segment than it observed would make CI request images from a supplier.
 */
function runVariant(label, { ledger, attemptLedger: attemptsRel, args = [] }) {
  const outRel = `${WORK_REL}/${label}`;
  const outDir = path.join(ROOT, outRel);
  fs.mkdirSync(outDir, { recursive: true });
  const stdout = execFileSync(process.execPath, [
    TOOL, '--ledger', ledger, '--attempt-ledger', attemptsRel,
    '--variants-repo', `${outRel}/image_variant_measurements.csv`,
    '--aggregate', `${outRel}/image_variant_summary.json`,
    ...args,
  ], { encoding: 'utf8' });
  assert.match(stdout, /· to try 0 ·/, `the ${label} fixture reached the network: ${stdout.split('\n')[0]}`);
  return {
    stdout,
    outDir,
    verdicts: parseCsv(fs.readFileSync(path.join(outDir, 'image_variant_measurements.csv'), 'utf8')),
    attempts: parseCsv(fs.readFileSync(path.join(outDir, 'image_variant_attempts.csv'), 'utf8')),
    aggregate: JSON.parse(fs.readFileSync(path.join(outDir, 'image_variant_summary.json'), 'utf8')),
    printed: JSON.parse(stdout.slice(stdout.lastIndexOf('\n{'))),
  };
}

test('a pre-filled attempt log means no request, and the verdicts come out of the observations', () => {
  const run = runVariant('resume', { ledger: written.ledger, attemptLedger: written.attempts });
  assert.match(run.stdout, /^ledger rows 4 · below-recommendation urls 3 · variant urls planned 15 · already observed 15/m);

  assert.deepEqual(run.verdicts.map((row) => row.probe_key), [A.key, B.key, C.key].sort(), 'one verdict per shortfall, sorted by key');
  assert.equal(run.verdicts.some((row) => row.probe_key === D.key), false, 'an image that already meets the recommendation is not swept');
  for (const verdict of run.verdicts) {
    assert.equal(verdict.variants_planned, '5');
    assert.equal(verdict.variants_attempted, '5');
    assert.equal(verdict.variants_answered, 'yes');
  }

  // Looked up by key, because the table is sorted by probe key — not by anything a
  // reader would guess from the fixture order.
  const byKey = new Map(run.verdicts.map((row) => [row.probe_key, row]));
  const a = byKey.get(A.key);
  const b = byKey.get(B.key);
  const c = byKey.get(C.key);
  assert.equal(a.variants_found, '0');
  assert.equal(a.variants_404, '5');
  assert.equal(a.larger_available, 'no', 'five refusals is a real negative answer');
  assert.equal(a.best_segment, 'representative');
  assert.equal(a.meets_recommended_now, 'no');
  assert.equal(a.best_bytes, String(A.bytes), 'with nothing bigger the representative stays the best file');

  assert.equal(b.variants_found, '1');
  assert.equal(b.larger_available, 'yes');
  assert.equal(b.best_segment, 'big');
  assert.equal(b.best_width, '1200');
  assert.equal(b.meets_recommended_now, 'yes', 'this is the rescue the readiness report counts');
  assert.equal(b.best_bytes, '210000', 'the rescued file reports its own bytes, not the representative\'s');

  assert.equal(c.base_width, '500');
  assert.equal(c.base_height, '700', 'a non-square representative is a shortfall too, as the recommendation implies');
  assert.equal(c.larger_available, 'no');
  assert.equal(c.meets_recommended_now, 'no');

  assert.equal(run.aggregate.representatives_below_recommendation, 3);
  assert.equal(run.aggregate.variant_urls_observed, 15);
  assert.equal(run.aggregate.variant_urls_tried, 0, 'the census must say that this run requested nothing');
  assert.equal(run.aggregate.run_complete, true);
  assert.equal(run.printed.NOT_MEASURED, 0);
  assert.equal(run.printed.RESOLVED_TO_RECOMMENDED, 1);
});

test('a committed verdict table cannot inherit a stale reason code from the observation log', () => {
  const run = runVariant('stale', { ledger: written.ledger, attemptLedger: written.legacy });
  const text = fs.readFileSync(path.join(run.outDir, 'image_variant_attempts.csv'), 'utf8');
  assert.ok(!text.includes('image_probe_http_404'), 'the observation log may keep old vocabulary; the committed table may not');
  assert.ok(!text.includes('thumbnail_variant_only'), 'and a retired guess must not be resurrected');
  const codes = new Set(run.attempts.map((row) => row.reason_codes));
  assert.deepEqual([...codes].sort(), ['image_bytes_measured;image_meets_recommended_pixels', 'image_probe_http_error'],
    'a 404 and a readable 1200x1200 png are each named from what was fetched');

  // The half-swept case is deliberately not exercised here: producing it means leaving
  // candidates unobserved, and the tool would then request them from the supplier —
  // which a committed test must never do. `not_measured` is therefore pinned where it
  // can be proven offline: against the committed tables above (every verdict whose
  // attempts fall short of its plan must say not_measured, never "no larger file") and
  // against the readiness classifier in test/unit/naver-images.test.mjs.
  assert.equal(run.verdicts.every((verdict) => verdict.variants_answered === 'yes'), true,
    'this fixture is fully observed, so it cannot be the fixture that proves the partial rule');
});

test('the committed outputs cannot be redirected outside the repository, and a missing ledger is not a silent no-op', () => {
  const failWith = (args) => {
    try {
      execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', stdio: 'pipe' });
      return { status: 0, text: '' };
    } catch (error) {
      return { status: error.status, text: `${error.stdout || ''}${error.stderr || ''}` };
    }
  };
  const escape = '../variant_escape.csv';
  const repoFile = failWith(['--ledger', written.ledger, '--variants-repo', escape]);
  assert.equal(repoFile.status, 2, `--variants-repo outside the repository must exit 2, saw ${repoFile.status}`);
  assert.match(repoFile.text, /escapes the repository/);
  assert.equal(fs.existsSync(path.join(ROOT, '..', 'variant_escape.csv')), false, 'it must fail before writing');
  const aggEscape = failWith(['--ledger', written.ledger, '--attempt-ledger', written.attempts, '--aggregate', '../variant_escape.json']);
  assert.equal(aggEscape.status, 2, 'the aggregate is guarded the same way');
  assert.match(aggEscape.text, /escapes the repository/);

  const noLedger = failWith(['--variants-repo', `${WORK_REL}/guard/verdicts.csv`]);
  assert.equal(noLedger.status, 2, 'without the observation log this run would fetch everything');
  assert.match(noLedger.text, /nothing to do/);
});
