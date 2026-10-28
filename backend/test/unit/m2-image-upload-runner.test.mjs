// M2 후속 — 이미지 업로드 러너 동작 테스트 (루프백 mock, 전송은 mock 뿐).
//
// 고정하는 계약:
//   1. dry-run(execute=false)은 호출 0건.
//   2. 대표 1 + 추가 9 — 본문에 들어갈 10장만 업로드하고, 초과분(dropped_over_limit)은 보내지 않는다.
//   3. 라이브 모드는 러너가 스스로 거부한다(운영자 승인 레인 분리).
//   4. 응답 URL 수가 다르면 부분 채택 없이 배치 실패로 남는다.
//   5. ledger 에 없는 원본 URL 은 본문용 이미지 필드에 절대 들어가지 않는다.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { createImageUploadRunner, imagesFromLedger } from '../../lib/image-upload-runner.mjs';
import { createNcomAuthRuntime } from '../../lib/ncommerce-auth.mjs';
import { closeAllMockNcomServers, startMockNcomServer } from '../helpers/mock-ncom.mjs';

after(() => closeAllMockNcomServers());

const bcryptStub = async (plain, salt) => `$2a$10$${Buffer.from(`${plain}|${salt}`).toString('base64')}`;
const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const sampleImages = (n) => Array.from({ length: n }, (_, i) => ({
  url: `https://www.samasound.co.kr/web/product/big/source-${i + 1}.png`,
  formatAllowed: true,
  bytes: pngBytes,
  filename: `source-${i + 1}.png`,
}));

const buildRuntime = (mock, extra = {}) => createNcomAuthRuntime({
  env: { NCOM_MODE: 'mock', NCOM_MOCK_BASE_URL: mock.baseUrl, NCOM_CLIENT_ID: 'CID', NCOM_CLIENT_SECRET: 'SEC' },
  bcryptHashpw: bcryptStub,
  fetchFn: extra.fetchFn,
});

test('dry-run plans without a single call', async () => {
  const mock = await startMockNcomServer();
  const runner = createImageUploadRunner({ runtime: buildRuntime(mock) });
  const result = await runner.runUploads({ images: sampleImages(12), execute: false });
  assert.equal(result.batches_run, 0);
  assert.equal(result.naver_requests, 0);
  assert.equal(result.transmitted, false);
  assert.equal(result.plan.representative, 'https://www.samasound.co.kr/web/product/big/source-1.png');
  assert.equal(result.plan.additional.length, 9);
  assert.deepEqual(result.batches, [{ batch: 1, files: 10 }], '본문에 쓰일 10장만 배치된다');
  assert.equal(mock.calls.length, 0, 'dry-run 은 게이트웨이에 아무것도 보내지 않는다');
});

test('mock execution uploads exactly the 10 body images and records the ledger', async () => {
  const mock = await startMockNcomServer();
  const runner = createImageUploadRunner({ runtime: buildRuntime(mock) });
  const result = await runner.runUploads({ images: sampleImages(12), execute: true });

  assert.equal(result.mode, 'mock');
  assert.equal(result.batches_run, 1);
  assert.equal(result.transmitted, true);
  assert.equal(result.ledger.length, 10, '대표 1 + 추가 9 — 11번째·12번째는 업로드조차 하지 않는다');
  assert.ok(result.ledger.every((entry) => entry.uploaded.startsWith('https://mock-image.example/')), '업로드된 URL 은 API 반환값뿐이다');
  assert.ok(result.ledger.every((entry) => !result.uploaded_urls.includes(entry.source)), '원본 URL 이 업로드 URL 로 둔갑하지 않는다');

  const uploadCalls = mock.calls.filter((call) => call.path.endsWith('/v1/product-images/upload'));
  assert.equal(uploadCalls.length, 1);
  assert.equal((uploadCalls[0].raw.match(/filename=/g) || []).length, 10);
});

test('the runner refuses live mode by itself', async () => {
  const runtime = createNcomAuthRuntime({
    env: { NCOM_MODE: 'live', NCOM_LIVE_WRITE: 'YES', NCOM_CLIENT_ID: 'CID', NCOM_CLIENT_SECRET: 'SEC' },
    bcryptHashpw: bcryptStub,
  });
  const runner = createImageUploadRunner({ runtime });
  await assert.rejects(runner.runUploads({ images: sampleImages(2), execute: true }), (error) => error.code === 'upload_runner_live_refused');
});

test('a response with the wrong URL count fails the batch — no partial adoption', async () => {
  const mock = await startMockNcomServer();
  const realFetch = globalThis.fetch;
  // 업로드 응답만 URL 1개로 훼손한 fetch 래퍼 — 토큰/기타 호출은 그대로 통과시킨다.
  const sabotagedFetch = async (url, init) => {
    if (String(url).includes('/product-images/upload')) {
      return new Response(JSON.stringify({ urls: ['https://mock-image.example/only-one.png'] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, init);
  };
  const runner = createImageUploadRunner({ runtime: buildRuntime(mock, { fetchFn: sabotagedFetch }) });
  const result = await runner.runUploads({ images: sampleImages(3), execute: true });
  assert.equal(result.transmitted, false);
  assert.equal(result.ledger.length, 0, '수량이 안 맞는 응답은 하나도 채택하지 않는다');
  assert.equal(result.failed_batches.length, 1);
  assert.equal(result.failed_batches[0].sent, 3);
  assert.equal(result.failed_batches[0].received, 1);
});

test('imagesFromLedger never copies a source URL that the upload API did not return', async () => {
  const mock = await startMockNcomServer();
  const runner = createImageUploadRunner({ runtime: buildRuntime(mock) });
  const result = await runner.runUploads({ images: sampleImages(3), execute: true });
  const images = imagesFromLedger({ ledger: result.ledger, plan: result.plan });
  assert.equal(images.uploadedViaImageApi, true);
  assert.match(images.representative, /^https:\/\/mock-image\.example\//);
  assert.equal(images.additional.length, 2);
  for (const url of [images.representative, ...images.additional]) {
    assert.ok(!url.includes('samasound.co.kr'), '공급처 원본 URL 은 본문 필드에 들어갈 수 없다');
  }

  // ledger 가 비면(배치 실패) 대표 URL 도 비어야 한다 — 원본으로 폴백하지 않는다.
  const empty = imagesFromLedger({ ledger: [], plan: { representative: 'https://www.samasound.co.kr/web/product/big/source-1.png', additional: [] } });
  assert.equal(empty.representative, '');
  assert.equal(empty.uploadedViaImageApi, false);
});
