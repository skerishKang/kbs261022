// Unit contract for uploadedUrlsFromResponse — the image-upload response
// reader. Vendor reality (live run 2026-10-29) is a top-level
// {images:[{url}]} envelope, while the test mock has always replied {urls}.
// The reader must accept both and return null for anything else, so the
// caller's count-mismatch refusal (no partial adoption) still applies.
//
//   node --test test/unit/ncom-live-upload-response.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { uploadedUrlsFromResponse } from '../../lib/ncom-live-pipeline.mjs';

test('the vendor envelope (images[{url}]) yields the returned URLs', () => {
  const response = {
    raw: { images: [{ url: 'https://shop-phinf.pstatic.net/20261029_262/x_JPEG/y.jpg' }] },
    data: { images: [{ url: 'https://shop-phinf.pstatic.net/20261029_262/x_JPEG/y.jpg' }] },
  };
  assert.deepEqual(uploadedUrlsFromResponse(response), ['https://shop-phinf.pstatic.net/20261029_262/x_JPEG/y.jpg']);
});

test('the mock envelope ({urls}) keeps working', () => {
  assert.deepEqual(
    uploadedUrlsFromResponse({ raw: { urls: ['https://mock-image.example/upload-1.png'] } }),
    ['https://mock-image.example/upload-1.png'],
  );
});

test('an unrecognized or count-mismatched envelope returns null so no batch is partially adopted', () => {
  assert.equal(uploadedUrlsFromResponse({ raw: {} }), null);
  assert.equal(uploadedUrlsFromResponse({ raw: { images: [{ url: '' }, { url: 'https://x/y.png' }] } }), null, '빈 url 항목은 세지 않는다');
  assert.equal(uploadedUrlsFromResponse({ raw: { images: 'nope' } }), null);
  assert.equal(uploadedUrlsFromResponse(undefined), null);
});
