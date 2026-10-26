// Unit tests for the image measurement library — the code behind every resolution
// claim in the readiness report. The fixtures are hand-built container headers, so a
// parser reading the wrong byte offset fails here instead of quietly reporting a
// catalogue of 500px files as 1000px.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NAVER_ALLOWED_FORMATS, NAVER_IMAGE_DOC, readImageMeta, assessImageBytes, probeKey,
  variantUrlCandidates, planImageUpload, summarizeProbe, joinImageEvidence, assessMeasuredImage,
} from '../../lib/naver-images.mjs';

const u16le = (n) => [n & 0xff, (n >> 8) & 0xff];
const u16be = (n) => [(n >> 8) & 0xff, n & 0xff];
const u32be = (n) => [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const u32le = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const u24le = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const ascii = (text) => [...text].map((c) => c.charCodeAt(0));
const build = (...chunks) => new Uint8Array(chunks.flat());

const png = (width, height, { interlace = 0 } = {}) => build(
  [0x89], ascii('PNG'), [13, 10, 26, 10],
  u32be(13), ascii('IHDR'), u32be(width), u32be(height), [8, 6, 0, 0, interlace], u32be(0)
);
/** FF D8, an APP0 we must skip over, then a start-of-frame carrying the size. */
const jpeg = (width, height, { progressive = false } = {}) => build(
  [0xff, 0xd8, 0xff, 0xe0], u16be(16), ascii('JFIF'), [0, 1, 1, 0, ...u16be(1), ...u16be(1), 0, 0],
  [0xff, progressive ? 0xc2 : 0xc0], u16be(17), [8], u16be(height), u16be(width), [3, 1, 0x11]
);
const gif = (width, height, { animated = false } = {}) => build(
  ascii('GIF89a'), u16le(width), u16le(height), [0x80, 0, 0], animated ? ascii('NETSCAPE2.0') : [0x21, 0xf9, 0x04]
);
const bmp = (width, height, { flipped = false } = {}) => build(
  ascii('BM'), u32le(54), [0, 0, 0, 0], u32le(54), u32le(40), u32le(width), u32le(flipped ? -height : height), u16le(1), u16le(24)
);
const webp = (fourcc, width, height) => build(
  ascii('RIFF'), u32le(40), ascii('WEBP'), ascii(fourcc), u32le(20),
  fourcc === 'VP8 ' ? [[0, 0, 0], [0x9d, 0x01, 0x2a], u16le(width & 0x3fff), u16le(height & 0x3fff)].flat()
    : fourcc === 'VP8L' ? [0x2f, ...u32le(((height - 1) << 14) | (width - 1)), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
      : [[0, 0, 0, 0], u24le(width - 1), u24le(height - 1), 0, 0].flat()
);
/** assessImageBytes reads a parsed header, the way probeImageUrl hands it one. */
const meta = (buffer) => readImageMeta(buffer);

test('every container is parsed at the offset the format actually uses', () => {
  for (const [label, buffer, width, height, format] of [
    ['png 1000', png(1000, 1000), 1000, 1000, 'png'],
    ['png 500', png(500, 500), 500, 500, 'png'],
    ['jpeg 625', jpeg(625, 625), 625, 625, 'jpeg'],
    ['jpeg 2835', jpeg(2835, 2835), 2835, 2835, 'jpeg'],
    ['gif 320x240', gif(320, 240), 320, 240, 'gif'],
    ['bmp 200x100', bmp(200, 100), 200, 100, 'bmp'],
    ['webp VP8 1066', webp('VP8 ', 1066, 1066), 1066, 1066, 'webp'],
    ['webp VP8L 512x300', webp('VP8L', 512, 300), 512, 300, 'webp'],
    ['webp VP8X 1417', webp('VP8X', 1417, 1417), 1417, 1417, 'webp'],
  ]) {
    const meta = readImageMeta(buffer);
    assert.equal(meta.parsed, true, `${label} must parse`);
    assert.equal(meta.format, format, label);
    assert.equal(meta.width, width, `${label} width`);
    assert.equal(meta.height, height, `${label} height`);
    assert.equal(meta.bytes, buffer.length, `${label} byte count is the body length`);
  }
});

test('the header facts a human would ask about are kept, not folded away', () => {
  assert.equal(readImageMeta(gif(10, 10, { animated: true })).animationIndicator, true);
  assert.equal(readImageMeta(gif(10, 10)).animationIndicator, false);
  assert.equal(readImageMeta(gif(10, 10)).variant, 'GIF89a');
  assert.equal(readImageMeta(jpeg(8, 8, { progressive: true })).progressive, true);
  assert.equal(readImageMeta(png(8, 8, { interlace: 1 })).interlaced, true);
  assert.equal(readImageMeta(bmp(8, -8)).flipped, true, 'a negative BMP height is a top-down bitmap, not a negative size');
});

test('bytes that are not an image are reported as unreadable, never as zero-sized', () => {
  const html = readImageMeta(build(ascii('<html><body>404</body></html>'), [0, 0, 0, 0]));
  assert.equal(html.parsed, false);
  assert.equal(html.width, null);
  assert.match(html.reason, /unrecognised signature/);
  assert.equal(readImageMeta(new Uint8Array([0xff, 0xd8])).parsed, false, 'two bytes cannot be a jpeg');
  assert.equal(readImageMeta(new Uint8Array([])).parsed, false);
});

test('assessment: only the format is a hard rule, resolution is a recommendation', () => {
  const ok = assessImageBytes({ url: 'u', status: 200, meta: meta(png(1000, 1000)) });
  assert.deepEqual(ok.codes, ['image_bytes_measured', 'image_meets_recommended_pixels']);
  assert.equal(ok.formatAllowed, true);

  const short = assessImageBytes({ url: 'u', status: 200, meta: meta(png(500, 500)) });
  assert.ok(short.codes.includes('image_below_recommended_pixels'), 'below the recommendation is stated');
  assert.equal(short.formatAllowed, true, 'a short image is still an allowed format');

  const wide = assessImageBytes({ url: 'u', status: 200, meta: meta(jpeg(1538, 1537)) });
  assert.ok(wide.codes.includes('image_non_square_measured'), 'the recommendation is square, so a non-square file is named');
  assert.equal(wide.aspect, '1538x1537');

  for (const status of [404, 403, 500]) {
    assert.deepEqual(assessImageBytes({ url: 'u', status, meta: meta(png(10, 10)) }).codes, ['image_probe_http_error'], `status ${status} is an answer, not a fetch failure`);
  }
  assert.deepEqual(assessImageBytes({ url: 'u', status: 0, meta: meta(png(10, 10)) }).codes, ['image_probe_not_fetched']);
  assert.deepEqual(assessImageBytes({ url: 'u', status: 200, meta: meta(build(ascii('nope'))) }).codes, ['image_bytes_unreadable']);

  const webpAssessment = assessImageBytes({ url: 'u', status: 200, meta: meta(webp('VP8 ', 1000, 1000)) });
  assert.ok(webpAssessment.codes.includes('image_format_not_allowed'), 'webp is outside the documented allow-list');
  assert.equal(webpAssessment.formatAllowed, false);
  assert.ok(!NAVER_ALLOWED_FORMATS.includes('webp'));
  assert.equal(NAVER_IMAGE_DOC.byteSizeLimit, null, 'no byte ceiling is documented, so it stays null instead of passing silently');
  assert.equal(NAVER_IMAGE_DOC.minimumResolution, null, 'no minimum resolution is documented, so it stays null');
});

test('size-segment candidates are rewritten only for the URL shape that was measured', () => {
  const candidates = variantUrlCandidates('https://www.samasound.co.kr/web/product/small/202407/a.jpg');
  assert.deepEqual(candidates.map((c) => c.segment).sort(), ['', 'big', 'large', 'medium', 'original']);
  assert.ok(candidates.every((c) => c.url.startsWith('https://www.samasound.co.kr/web/product/')), 'the origin is preserved');
  assert.ok(!candidates.some((c) => /\/small\//.test(c.url)), 'the segment already measured is not asked again');
  assert.ok(candidates.some((c) => c.segment === '' && /\/web\/product\/202407\/a\.jpg$/.test(c.url)), 'the no-segment form is a real candidate');
  assert.deepEqual(variantUrlCandidates('https://cdn.example.com/img/a.jpg'), [], 'a URL of a shape we never measured yields no invented candidate');
  assert.deepEqual(variantUrlCandidates(''), []);
});

test('upload planning obeys 1 representative, 9 additional, 10 per call', () => {
  const images = Array.from({ length: 14 }, (_, i) => ({ url: `https://x/${i}.jpg`, formatAllowed: true }));
  const plan = planImageUpload(images);
  assert.equal(plan.representative, 'https://x/0.jpg');
  assert.equal(plan.additional.length, 9);
  assert.deepEqual(plan.dropped_over_limit, ['https://x/10.jpg', 'https://x/11.jpg', 'https://x/12.jpg', 'https://x/13.jpg']);
  assert.equal(plan.over_extra_limit, true);
  assert.equal(plan.upload_calls, 2, '14 files need 2 calls of at most 10');
  assert.deepEqual(plan.batches.map((b) => b.urls.length), [10, 4]);

  const rejected = planImageUpload([{ url: 'https://x/a.webp', formatAllowed: false }, { url: 'https://x/b.jpg', formatAllowed: true }]);
  assert.equal(rejected.representative, 'https://x/b.jpg', 'a format the API refuses cannot be the representative');
  assert.equal(planImageUpload([]).representative, '');
});

test('the probe aggregate counts URLs, and states absences rather than 0 defaults', () => {
  const rows = [
    { url: 'a', http_status: 200, format: 'jpeg', width: 1000, height: 1000, bytes: 2_000_000, parsed: true },
    { url: 'b', http_status: 200, format: 'png', width: 500, height: 500, bytes: 1000, parsed: true },
    { url: 'c', http_status: 404, format: 'unknown', width: null, height: null, bytes: 0, parsed: false },
    { url: 'd', http_status: 200, format: 'unknown', width: null, height: null, bytes: 500, parsed: false },
  ];
  const summary = summarizeProbe(rows);
  assert.equal(summary.urls_probed, 4);
  assert.equal(summary.fetched_ok, 3);
  assert.equal(summary.dimensions_measured, 2);
  assert.equal(summary.meets_recommended_1000, 1);
  assert.equal(summary.non_square, 0);
  assert.equal(summary.unreadable_bytes, 1, 'a 200 whose body is not an image is counted separately from a 404');
  assert.equal(summary.bytes_over_1mb, 1);
  assert.deepEqual(summary.by_status, { 200: 3, 404: 1 });
  assert.equal(summarizeProbe([]).bytes_min, null, 'an empty census says nothing was measured, not that size 0 was');
});

const measurementRow = (url, over = {}) => ({
  probe_key: probeKey(url), http_status: '200', container: 'jpeg', width: '1000', height: '1000', bytes: '30000',
  format_allowed: 'yes', meets_recommended_pixels: 'yes', reason_codes: '', header_variant: '', animation_indicator: 'no', ...over,
});
const variantRow = (url, over = {}) => ({
  probe_key: probeKey(url), base_width: '500', base_height: '500', variants_planned: '5', variants_attempted: '5',
  variants_answered: 'yes', variants_found: '0', variants_404: '5', larger_available: 'no', best_segment: 'representative',
  best_width: '500', best_height: '500', best_bytes: '9000', meets_recommended_now: 'no', ...over,
});

test('the evidence index keeps never-fetched and fetched-but-refused apart', () => {
  const index = joinImageEvidence(
    [measurementRow('a', { http_status: '0' }), measurementRow('b', { http_status: '404' }), measurementRow('c'), { probe_key: '', http_status: '200' }],
    [variantRow('c')]
  );
  assert.equal(index.size, 3, 'a row without a probe key cannot be joined to anything');
  assert.equal(index.get(probeKey('a')).base, null, 'status 0 means no observation exists at all');
  assert.equal(index.get(probeKey('b')).base.httpStatus, 404, 'a 404 is an observation about the URL');
  assert.equal(index.get(probeKey('c')).variant.found, 0);
  assert.equal(index.get(probeKey('c')).base.width, 1000);
  assert.equal(index.get(probeKey('a')).variant, null, 'a base with no variant row must not look like a completed sweep');
});

test('a measured verdict never invents a fact the tables do not carry', () => {
  const url = 'https://www.samamusic.co.kr/web/product/small/201807/x.jpg';
  const empty = new Map();
  assert.deepEqual(assessMeasuredImage({ url: '', evidence: empty }).codes, ['image_representative_blank']);
  assert.equal(assessMeasuredImage({ url, evidence: empty }).state, 'unmeasured');
  assert.match(assessMeasuredImage({ url, evidence: empty }).codes.join(';'), /image_measurement_missing/);

  const index = (over = {}, variant = null) => joinImageEvidence([measurementRow(url, over)], variant ? [variantRow(url, variant)] : []);
  assert.equal(assessMeasuredImage({ url, evidence: index({ http_status: '0' }) }).state, 'unreachable');
  assert.equal(assessMeasuredImage({ url, evidence: index({ http_status: '404' }) }).state, 'http_error');
  assert.equal(assessMeasuredImage({ url, evidence: index({ container: '' }) }).state, 'unreadable');
  assert.equal(assessMeasuredImage({ url, evidence: index({ container: 'webp', format_allowed: 'no' }) }).state, 'format_rejected');

  const rescued = assessMeasuredImage({
    url,
    evidence: index({ width: '440', height: '440', meets_recommended_pixels: 'no' },
      { variants_found: '2', larger_available: 'yes', best_segment: 'big', best_width: '1000', best_height: '1000', best_bytes: '45561', meets_recommended_now: 'yes' }),
  });
  assert.equal(rescued.state, 'ok_via_segment');
  assert.equal(rescued.width, 1000, 'the report carries the file an operator would actually upload');
  assert.equal(rescued.bytes, 45561);
  assert.ok(!rescued.codes.includes('image_below_recommended_pixels'), 'the short note is dropped once a meeting file exists');
  assert.ok(rescued.codes.includes('image_larger_segment_meets'), 'and the drop must not eat the code that was just pushed');
  assert.ok(rescued.codes.includes('image_bytes_measured'), 'the base measurement is still part of the record');
});

test('an unfinished segment sweep is withheld instead of called a negative', () => {
  const url = 'https://www.samamusic.co.kr/web/product/small/201807/y.jpg';
  const assess = (variant) => assessMeasuredImage({
    url,
    evidence: joinImageEvidence([measurementRow(url, { width: '500', height: '500', meets_recommended_pixels: 'no' })], [variantRow(url, variant)]),
  });
  assert.ok(assess({}).codes.includes('image_no_larger_segment_measured'), 'all 404 is a real answer');
  assert.ok(assess({ variants_found: '1', larger_available: 'yes', best_segment: 'big', best_width: '800', best_height: '800' }).codes.includes('image_larger_segment_still_small'));
  const partial = assess({ variants_answered: 'no', variants_attempted: '2', larger_available: 'not_measured', meets_recommended_now: 'not_measured' });
  assert.ok(partial.codes.includes('image_size_segment_not_fully_measured'));
  assert.ok(!partial.codes.includes('image_no_larger_segment_measured'), 'a run that stopped early cannot report that nothing larger exists');
  assert.equal(partial.state, 'below_recommended');
});
