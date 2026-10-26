// Unit tests for the lane's only network path. fetch is stubbed here — every case
// asserts the stub answered, so a test that silently reached the real internet
// would fail rather than pass on somebody else's server.

import test from 'node:test';
import assert from 'node:assert/strict';

import { probeImageUrl, mapConcurrent } from '../../lib/image-fetch.mjs';

const jpegBytes = (width, height) => new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 3, 1, 0x11,
]);

const realFetch = globalThis.fetch;

/** Answers the scripted responses in order; an Error entry throws as a transport failure. */
const script = (steps) => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const step = steps.length > 1 ? steps.shift() : steps[0];
    if (step instanceof Error) throw step;
    const body = step.body ?? new Uint8Array();
    return {
      status: step.status,
      headers: { get: (name) => (String(name).toLowerCase() === 'content-length' ? (step.contentLength ?? body.length) : '') },
      arrayBuffer: async () => body.slice().buffer,
    };
  };
  return calls;
};

test('a full 200 body is measured and reported as measured', async () => {
  const calls = script([{ status: 200, body: jpegBytes(1000, 1000) }]);
  const row = await probeImageUrl('https://www.samasound.co.kr/web/product/small/202407/a.jpg', { retries: 0 });
  assert.deepEqual(calls, ['https://www.samasound.co.kr/web/product/small/202407/a.jpg'], 'the stub answered, not the network');
  assert.equal(row.http_status, 200);
  assert.equal(row.parsed, true);
  assert.equal(row.format, 'jpeg');
  assert.equal(row.width, 1000);
  assert.equal(row.format_allowed, true);
  assert.equal(row.meets_recommended_pixels, true);
  assert.equal(row.codes, 'image_bytes_measured;image_meets_recommended_pixels');
  assert.equal(row.attempts, 1);
  assert.equal(row.give_up, undefined, 'a probe row does not decide whether to give up; the caller does');
  globalThis.fetch = realFetch;
});

test('a body shorter than the declared Content-Length is a truncated observation, not a small image', async () => {
  const truncated = jpegBytes(1000, 1000).slice(0, 12);
  const calls = script([{ status: 200, body: truncated, contentLength: jpegBytes(1000, 1000).length }]);
  const row = await probeImageUrl('https://x/a.jpg', { retries: 1, backoffMs: 0 });
  assert.equal(calls.length, 2, 'the mismatch is retried before it is reported');
  assert.equal(row.http_status, 0, 'it may never be recorded as a 200 measurement');
  assert.equal(row.codes, 'image_probe_not_fetched');
  assert.match(row.unreadable_reason, /content_length_mismatch: header 32 body 12/);
  assert.equal(row.retry_note, 'retries_exhausted');
  globalThis.fetch = realFetch;
});

test('an HTTP status is an answer and is never retried or called a fetch failure', async () => {
  const calls = script([{ status: 404, body: new Uint8Array([0x3c, 0x68, 0x74, 0x6d]) }]);
  const row = await probeImageUrl('https://x/missing.jpg', { retries: 2, backoffMs: 0 });
  assert.equal(calls.length, 1, '404 means the file is not there; asking again proves nothing');
  assert.equal(row.http_status, 404);
  assert.equal(row.codes, 'image_probe_http_error');
  assert.equal(row.format_allowed, false);
  assert.equal(row.parsed, false);
  globalThis.fetch = realFetch;
});

test('a transport failure is retried, and success afterwards is labelled', async () => {
  const calls = script([new Error('socket hang up'), { status: 200, body: jpegBytes(500, 500) }]);
  const row = await probeImageUrl('https://x/a.jpg', { retries: 2, backoffMs: 0 });
  assert.equal(calls.length, 2);
  assert.equal(row.http_status, 200);
  assert.equal(row.attempts, 2);
  assert.equal(row.retry_note, 'succeeded_after_1_retries');
  assert.equal(row.meets_recommended_pixels, false);
  assert.match(row.codes, /image_below_recommended_pixels/);
  globalThis.fetch = realFetch;
});

test('a 200 whose body is not an image header says so instead of reporting dimensions', async () => {
  const html = new Uint8Array([...Buffer.from('<html><body>error</body></html>'), ...new Array(20).fill(0)]);
  const calls = script([{ status: 200, body: html }]);
  const row = await probeImageUrl('https://x/a.jpg', { retries: 0 });
  assert.equal(calls.length, 1, 're-fetching an error page is not a repair');
  assert.equal(row.parsed, false);
  assert.equal(row.codes, 'image_bytes_unreadable');
  assert.match(row.unreadable_reason, /unrecognised signature/);
  assert.equal(row.width, '');
  globalThis.fetch = realFetch;
});

test('mapConcurrent does not treat a 404 as the host stopping to answer', async () => {
  const worker = (item) => ({ key: item, http_status: 404, parsed: false });
  const { rows, stopped } = await mapConcurrent(Array.from({ length: 60 }, (_, i) => i), 4, worker, { stopAfterConsecutiveFailures: 10 });
  assert.equal(rows.length, 60, 'every 404 is asked, because "the segment does not exist" is the answer we want');
  assert.equal(stopped, null);
});

test('mapConcurrent stops on consecutive unanswered requests and hands back the reason', async () => {
  const dead = { key: 'x', http_status: 0, parsed: false, unreadable_reason: 'TimeoutError: signal timed out' };
  const { rows, stopped } = await mapConcurrent([1, 2, 3, 4, 5, 6], 1, () => dead, { stopAfterConsecutiveFailures: 3 });
  assert.equal(rows.length, 3, 'the run halts at the threshold instead of hammering the host');
  assert.match(stopped, /stopped after 3 consecutive unanswered or unreadable observations/);
  assert.match(stopped, /TimeoutError/);
});

test('a readable 200 resets the failure streak, so one slow file does not end a sweep', async () => {
  const good = { key: 'g', http_status: 200, parsed: true };
  const dead = { key: 'd', http_status: 0, parsed: false };
  const queue = [dead, dead, good, dead, dead, good, dead, dead, good];
  const { rows, stopped } = await mapConcurrent(queue, 1, (item) => item, { stopAfterConsecutiveFailures: 3 });
  assert.equal(rows.length, 9, 'the streak restarts at each answer, so the whole queue is walked');
  assert.equal(stopped, null);
});

test('progress is reported and every item is worked exactly once under concurrency', async () => {
  const seen = [];
  let inFlight = 0;
  let peak = 0;
  const ticks = [];
  const { rows } = await mapConcurrent(
    Array.from({ length: 501 }, (_, i) => i),
    8,
    async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      seen.push(item);
      return { item };
    },
    { onProgress: (done, total) => ticks.push([done, total]) }
  );
  assert.equal(rows.length, 501);
  assert.equal(new Set(seen).size, 501, 'no item is fetched twice by the shared cursor');
  assert.ok(peak <= 8, `never more than the declared concurrency, saw ${peak}`);
  assert.deepEqual(ticks, [[250, 501], [500, 501]], 'progress ticks every 250 rows');
});

test('_restore', async () => {
  assert.equal(globalThis.fetch, realFetch, 'no test here may leave a stubbed fetch behind');
});
