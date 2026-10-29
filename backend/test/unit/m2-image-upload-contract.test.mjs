// M2 사전개발 — 이미지 업로드 계약 테스트 (mock 게이트웨이, 네트워크 없음).
//
// 문서 전사본이 고정하는 규칙:
//   - 업로드는 POST /v1/product-images/upload, multipart/form-data 이다.
//   - 한 번의 업로드 호출에 최대 10장(대표+추가 9장의 상품 본문 규칙과 별개의 호출 상한).
//   - 상품 대표/추가 이미지 URL 은 반드시 이 API 가 반환한 것만 허용된다
//     (외부 호스트 직접 링크 금지 — 상세페이지 HTML 내부 이미지와 구별).
//   - 해상도 1000x1000 은 '권장'이지 바닥이 아니다. 형식(JPG/GIF/PNG/BMP)만 하드 규칙.
//
// mock 의 { urls } 응답 모양과 multipart 필드명은 문서가 예시를 인쇄하지 않아
// mock 편의로 둔 것이다. 테스트가 고정하는 것은 요청 계약과 URL-only 규칙이다.
//
//   node --test test/unit/m2-image-upload-contract.test.mjs

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { planImageUpload, NAVER_IMAGE_DOC } from '../../lib/naver-images.mjs';
import { buildRegisterBody, createNcomClient, NCOM_ENDPOINTS } from '../../lib/ncommerce.mjs';
import { closeAllMockNcomServers, startMockNcomServer } from '../helpers/mock-ncom.mjs';

after(() => closeAllMockNcomServers());

const bcryptStub = async (plain, salt) => `$2a$10$${Buffer.from(`${plain}|${salt}`).toString('base64')}`;

const usable = (n, offset = 0) => Array.from({ length: n }, (_, i) => ({
  url: `https://mock-image.example/source-${offset + i + 1}.png`,
  formatAllowed: true,
}));

test('plan: one representative, at most nine additional, the rest is reported as dropped', () => {
  const plan = planImageUpload(usable(11));
  assert.equal(plan.representative, 'https://mock-image.example/source-1.png');
  assert.equal(plan.additional.length, NAVER_IMAGE_DOC.extraImagesMax);
  assert.deepEqual(plan.dropped_over_limit, ['https://mock-image.example/source-11.png']);
  assert.equal(plan.over_extra_limit, true);
});

test('plan: batches respect the documented 10-images-per-call cap', () => {
  const plan = planImageUpload(usable(25));
  assert.equal(plan.upload_calls, 3);
  assert.deepEqual(plan.batches.map((batch) => batch.urls.length), [10, 10, 5]);
});

test('plan: a format the contract does not allow never enters the plan', () => {
  const images = [...usable(2), { url: 'https://mock-image.example/animated.webp', formatAllowed: false }];
  const plan = planImageUpload(images);
  assert.equal(plan.representative, 'https://mock-image.example/source-1.png');
  assert.ok(!JSON.stringify(plan).includes('animated.webp'), '거부된 형식이 계획에 남으면 안 된다');
});

test('contract: the client uploads multipart/form-data with a Bearer token through imageUpload', async () => {
  const mock = await startMockNcomServer();
  const client = createNcomClient({
    env: { NCOM_MODE: 'mock', NCOM_MOCK_BASE_URL: mock.baseUrl, NCOM_CLIENT_ID: 'CID', NCOM_CLIENT_SECRET: 'SEC' },
    bcryptHashpw: bcryptStub,
  });

  const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const form = new FormData();
  for (const name of ['a.png', 'b.png', 'c.png']) {
    form.append('imageFiles', new File([bytes], name, { type: 'image/png' }));
  }
  const response = await client.call('imageUpload', { body: form });

  const record = mock.calls.find((call) => call.path.endsWith('/v1/product-images/upload'));
  assert.ok(record, '업로드 호출이 게이트웨이에 기록되지 않았다');
  assert.equal(record.method, 'POST');
  assert.ok(record.headers.authorization?.startsWith('Bearer '), 'Bearer 토큰 헤더가 필요하다');
  assert.ok(String(record.headers['content-type']).startsWith('multipart/form-data'), 'multipart/form-data 로 보내진다');
  assert.equal((record.raw.match(/filename=/g) || []).length, 3, '보낸 파일 수가 그대로 보인다');

  // 응답의 URL 은 mock 이 돌려준 것 그대로다 — 클라이언트가 URL 을 만들어내지 않는다.
  assert.equal(response.data.urls.length, 3);
  assert.match(response.data.urls[0], /^https:\/\/mock-image\.example\/upload-/);
});

test('contract: only upload-API URLs may sit in images.representative — a supplier link is refused by name', () => {
  const base = { prodDes: '테스트 상품', price: { value: 100000, state: 'public' }, stockQuantity: 3, sellerManagementCode: 'MOCK-1' };
  const external = buildRegisterBody(base, {
    leafCategoryId: '50000001',
    detailContent: '<p>승인된 본문</p>',
    images: { representative: 'https://www.samasound.co.kr/web/product/small/x.png', additional: [], uploadedViaImageApi: false },
  });
  assert.ok(external.problems.some((p) => p.field === 'images.representative' && p.reason === 'not_from_image_upload_api'));

  const uploaded = buildRegisterBody(base, {
    leafCategoryId: '50000001',
    detailContent: '<p>승인된 본문</p>',
    images: { representative: 'https://mock-image.example/upload-1.png', additional: [], uploadedViaImageApi: true },
  });
  assert.ok(!uploaded.problems.some((p) => p.field.startsWith('images')));
});

test('contract: the endpoint table stays the single door — imageUpload is POST multipart under /v1', () => {
  const entry = NCOM_ENDPOINTS.imageUpload;
  assert.equal(entry.method, 'POST');
  assert.equal(entry.path, '/v1/product-images/upload');
  assert.equal(entry.multipart, true);
});
