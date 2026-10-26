// The only network path in the Naver image lane.
//
// It reads a public supplier image URL that is already stored in this repository
// and nothing else: no credential, no login endpoint, no header that would
// impersonate a browser, and no write. Keeping it separate from
// registration-readiness/naver-images (which stay pure) is what lets the
// classifier be proven call-site-free in tests.

import { readImageMeta, assessImageBytes } from './naver-images.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One GET, measured. An HTTP status (even 404) is a real answer and is returned
 * as-is; a transport failure is retried and then reported as `image_probe_not_fetched`
 * so it can never be mistaken for a measurement. A body shorter than the declared
 * Content-Length is a truncated observation, so it is retried and, if it still
 * disagrees, reported as not measured rather than recorded as a small image.
 */
export async function probeImageUrl(url, { timeoutMs = 20000, retries = 2, backoffMs = 500 } = {}) {
  const started = Date.now();
  const failure = (reason, attempts, retryNote) => ({
    url,
    http_status: 0,
    content_type: '',
    format: '',
    variant: '',
    animated: 'no',
    width: '',
    height: '',
    bytes: 0,
    parsed: false,
    format_allowed: false,
    meets_recommended_pixels: false,
    codes: 'image_probe_not_fetched',
    unreadable_reason: reason,
    retry_note: retryNote,
    attempts,
    elapsed_ms: Date.now() - started,
    probed_at: new Date().toISOString(),
  });
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      const buffer = new Uint8Array(await response.arrayBuffer());
      const declared = Number(response.headers.get('content-length') || 0);
      if (response.status === 200 && declared > 0 && declared !== buffer.length) {
        lastError = `content_length_mismatch: header ${declared} body ${buffer.length}`;
        if (attempt < retries) { await sleep(backoffMs * (attempt + 1)); continue; }
        return failure(lastError, attempt + 1, 'retries_exhausted');
      }
      const meta = readImageMeta(buffer);
      const assessment = assessImageBytes({ url, status: response.status, meta });
      return {
        url,
        http_status: response.status,
        content_type: response.headers.get('content-type') || '',
        format: meta.format,
        variant: meta.variant || '',
        animated: meta.animationIndicator === true ? 'yes' : 'no',
        width: meta.width ?? '',
        height: meta.height ?? '',
        bytes: meta.bytes,
        parsed: meta.parsed === true,
        format_allowed: assessment.formatAllowed,
        meets_recommended_pixels: assessment.meetsRecommendedPixels,
        codes: assessment.codes.join(';'),
        unreadable_reason: meta.reason || '',
        retry_note: attempt > 0 ? `succeeded_after_${attempt}_retries` : '',
        attempts: attempt + 1,
        elapsed_ms: Date.now() - started,
        probed_at: new Date().toISOString(),
      };
    } catch (error) {
      lastError = `${error.name}: ${String(error.message).slice(0, 120)}`;
      if (attempt < retries) await sleep(backoffMs * (attempt + 1));
    }
  }
  return failure(lastError, retries + 1, retries > 0 ? 'retries_exhausted' : 'no_retry');
}

/**
 * Pulls work from one shared cursor instead of pre-slicing the list, so uneven
 * response times do not idle a worker, and hands the stop signal back so a run
 * that is failing can halt with a reason instead of hammering the host.
 */
export async function mapConcurrent(items, limit, worker, { stopAfterConsecutiveFailures = Infinity, onProgress } = {}) {
  const rows = [];
  let cursor = 0;
  let consecutiveFailures = 0;
  let stopped = null;
  // A 404 is an answer: it is exactly what "this size segment does not exist" looks
  // like over HTTP. Only a request that never got a status (transport failure) or a
  // 200 whose bytes are not an image means the host is not answering us.
  const isFailure = (row) => Number(row.http_status) === 0 || (Number(row.http_status) === 200 && row.parsed === false);
  const run = async () => {
    while (cursor < items.length && !stopped) {
      const item = items[cursor];
      cursor += 1;
      const row = await worker(item);
      rows.push(row);
      consecutiveFailures = isFailure(row) ? consecutiveFailures + 1 : 0;
      if (consecutiveFailures >= stopAfterConsecutiveFailures) {
        stopped = `stopped after ${consecutiveFailures} consecutive unanswered or unreadable observations (${row.unreadable_reason || `http ${row.http_status}`})`;
      }
      if (onProgress && rows.length % 250 === 0) onProgress(rows.length, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
  return { rows, stopped };
}
