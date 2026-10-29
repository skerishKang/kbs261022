// E2E regression for the multipart part Content-Type on POST /v1/product-images/upload.
// The vendor requires each part's Content-Type to be the image's real MIME type
// (commerce-api-naver/commerce-api discussion #1663: "JPEG: image/jpeg"). The live
// lane used to send `image/jpg` (the sniffed format name lowercased) and Naver
// rejected every batch with 400 "이미지 업로드중 오류가 발생하였습니다" — found on
// the 2026-10-29 live run where the K&M representative image is a JPEG.
//
//   node --test test/e2e/ncom-live-image-mime.test.mjs

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { runPilotImageUpload } from '../../lib/ncom-live-pipeline.mjs';
import { createNcomAuthRuntime } from '../../lib/ncommerce-auth.mjs';
import { closeAllMockNcomServers, startMockNcomServer } from '../helpers/mock-ncom.mjs';

after(() => closeAllMockNcomServers());

const bcryptStub = async (plain, salt) => `$2a$10$${Buffer.from(`${plain}|${salt}`).toString('base64')}`;
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex');
const permissive = () => ({ allowed: true, reasons: [], action: 'test' });

test('a JPEG representative is uploaded with Content-Type image/jpeg, never image/jpg', async () => {
  const mock = await startMockNcomServer();
  const runtime = createNcomAuthRuntime({
    env: { NCOM_MODE: 'mock', NCOM_MOCK_BASE_URL: mock.baseUrl, NCOM_CLIENT_ID: 'CID', NCOM_CLIENT_SECRET: 'SEC' },
    bcryptHashpw: bcryptStub,
  });
  const packages = [{
    cgiId: 'samamusic.co.kr:1769',
    sellerManagementCode: 'samamusic:1769',
    body: { smartstoreChannelProduct: { naverShoppingRegistration: false } },
    images: { upload_plan: { representative: 'https://www.samamusic.co.kr/web/product/small/20200624/a3a892a3c531bd7522d5eeaf32a09cdd.jpg', additional: [] } },
  }];
  const run = await runPilotImageUpload({
    runtime,
    packages,
    env: {},
    gates: permissive,
    execute: true,
    fetchBytes: async () => ({ status: 200, bytes: JPEG }),
  });
  assert.equal(run.refused, false);
  assert.equal(run.ledger.length, 1, 'the JPEG batch uploads and its URL is recorded');

  const uploadCall = mock.calls.find((c) => c.path === '/external/v1/product-images/upload');
  assert.ok(uploadCall, 'the upload reached the gateway');
  assert.match(uploadCall.raw, /Content-Type: image\/jpeg/, 'the part carries the real JPEG MIME type');
  assert.doesNotMatch(uploadCall.raw, /image\/jpg/, 'the sniffed format name must never become a MIME type');
});
