// 커머스API adapter tests against a mock of the documented gateway + domain
// behaviour. The bcrypt primitive is a stub, and the stub is asserted on its
// INPUT — the exact string that must be hashed and the exact value that must be
// used as the salt — because a wrong signature would otherwise read as a
// credential problem instead of the contract bug it is.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import {
  createNcomClient, classifyNcomResponse, buildClientSecretSign, buildRegisterBody,
  registerOrModify, stockFromErpBalance, clampOrderPageSize, searchBySellerCodeBody,
  ncomModeFromEnv, NCOM_ENDPOINTS, NCOM_LIMITS, NCOM_AUTH_GAP, NCOM_UNCONFIRMED,
} from '../../lib/ncommerce.mjs';
import { closeAllMockNcomServers, startMockNcomServer } from '../helpers/mock-ncom.mjs';

after(closeAllMockNcomServers);

const seen = [];
const bcryptStub = async (plain, salt) => {
  seen.push({ plain, salt });
  return `$2a$10$${btoa(`${plain}|${salt}`)}`;
};

function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, sleep: async () => {} };
}

async function withClient(overrides = {}, extraEnv = {}) {
  const mock = await startMockNcomServer(overrides);
  const time = clock();
  const client = createNcomClient({
    env: { NCOM_MODE: 'mock', NCOM_MOCK_BASE_URL: mock.baseUrl, NCOM_CLIENT_ID: 'CID', NCOM_CLIENT_SECRET: 'SEC', ...extraEnv },
    fetchFn: fetch,
    bcryptHashpw: bcryptStub,
    now: time.now,
    sleep: time.sleep,
  });
  return { mock, client, time };
}

const cleanRecord = {
  prodDes: 'SQ5+',
  price: { value: 1680000, state: 'public' },
  stockQuantity: 12,
  sellerManagementCode: 'samasound.co.kr:3836',
};
const uploadedImage = { representative: 'https://prd-phinf.pstatic.net/mock/1.png', additional: [], uploadedViaImageApi: true };

test('the sign is base64(bcrypt(client_id + "_" + timestamp)) with client_secret as the salt', async () => {
  seen.length = 0;
  // A crypt-format hash carrying "+" and "/" so the base64 alphabet is provable:
  // the vendor samples contradict each other (Java uses getUrlEncoder, the
  // Node/Python samples use standard base64), so the choice is asserted, not assumed.
  const hashOutput = '$2a$10$ab+cd/efghij012345678901ABCDEFGHIJKLMNOPQRSTUV0123456789012';
  const sign = await buildClientSecretSign({
    clientId: 'CID', timestampMs: 1700000000000, clientSecret: 'SEC',
    bcryptHashpw: async (plain, salt) => { seen.push({ plain, salt }); return hashOutput; },
  });
  assert.equal(seen[0].plain, 'CID_1700000000000');
  assert.equal(seen[0].salt, 'SEC');
  assert.equal(sign, Buffer.from(hashOutput, 'utf8').toString('base64'));
  assert.ok(!/[-_]/.test(sign), 'standard base64, per the Node/Python samples — not the URL-safe variant');
  assert.equal(Buffer.from(sign, 'base64').toString('utf8'), hashOutput, 'the sign decodes back to the exact bcrypt output');
  await assert.rejects(buildClientSecretSign({ clientId: 'C', timestampMs: 1, clientSecret: 'S', bcryptHashpw: null }), (e) => e.code === 'bcrypt_seam_missing' && e.gap === NCOM_AUTH_GAP);
  await assert.rejects(buildClientSecretSign({ clientId: 'C', timestampMs: 1, clientSecret: 'S', bcryptHashpw: async () => 'not-a-bcrypt-hash' }), (e) => e.code === 'bcrypt_output_invalid');
});

test('disabled unless NCOM_LIVE_WRITE=YES and NCOM_MODE=live; mock refuses a public host', () => {
  assert.equal(ncomModeFromEnv({}), 'disabled');
  assert.equal(ncomModeFromEnv({ NCOM_MODE: 'live' }), 'disabled');
  assert.equal(ncomModeFromEnv({ NCOM_MODE: 'live', NCOM_LIVE_WRITE: 'YES' }), 'live');
  assert.throws(() => createNcomClient({ env: { NCOM_MODE: 'mock', NCOM_MOCK_BASE_URL: 'https://api.commerce.naver.com/external' } }), (e) => e.code === 'mock_base_url_not_loopback');
  const client = createNcomClient({ env: {}, fetchFn: () => { throw new Error('must not fetch'); } });
  assert.equal(client.mode, 'disabled');
  return assert.rejects(client.call('productSearch', { body: {} }), (e) => e.code === 'disabled');
});

test('token request is body-only form-encoded and the access token rides as a Bearer header', async () => {
  const { mock, client } = await withClient();
  await client.call('productSearch', { body: searchBySellerCodeBody('samasound.co.kr:3836') });
  const tokenCall = mock.calls[0];
  assert.equal(tokenCall.path, '/external/v1/oauth2/token');
  assert.deepEqual(Object.keys(tokenCall.body).sort(), ['client_id', 'client_secret_sign', 'grant_type', 'timestamp', 'type']);
  assert.equal(tokenCall.body.grant_type, 'client_credentials');
  assert.equal(tokenCall.body.timestamp, '1700000000000', 'timestamp is milliseconds, per the docs');
  assert.equal(tokenCall.query.type, undefined, 'no auth parameter may leak into the query string');
  assert.ok(tokenCall.raw.includes('client_secret_sign='), 'the signature is sent in the body');
  const searchCall = mock.calls[1];
  assert.equal(searchCall.headers.authorization, 'Bearer MOCK_ACCESS_TOKEN');
  assert.equal(searchCall.path, '/external/v1/products/search');
  await mock.close();
});

test('expires_in is honoured and an absent expires_in caches nothing', async () => {
  const { mock, client, time } = await withClient({ expiresIn: 3600 });
  await client.authorize();
  assert.equal(client.accessTokenExpiresAt, time.now() + 3600 * 1000);
  await client.authorize();
  assert.equal(mock.calls.filter((c) => c.path.endsWith('/oauth2/token')).length, 1, 'a cached token must not be re-minted');

  const mock2 = await startMockNcomServer({ expiresIn: null });
  const client2 = createNcomClient({ env: { NCOM_MODE: 'mock', NCOM_MOCK_BASE_URL: mock2.baseUrl, NCOM_CLIENT_ID: 'CID', NCOM_CLIENT_SECRET: 'SEC' }, bcryptHashpw: bcryptStub, now: () => 1, sleep: async () => {} });
  await client2.authorize();
  await client2.authorize();
  assert.equal(mock2.calls.filter((c) => c.path.endsWith('/oauth2/token')).length, 2, 'with no documented TTL the client must not assume one');
  await mock.close();
  await mock2.close();
});

test('GW.AUTHN triggers exactly one re-authentication, and a second one surfaces', async () => {
  const { mock, client } = await withClient();
  await client.authorize();
  const tokenCalls = () => mock.calls.filter((c) => c.path.endsWith('/oauth2/token')).length;
  const searchCalls = () => mock.calls.filter((c) => c.path === '/external/v1/products/search').length;
  const before = tokenCalls();

  mock.state.failRequest = { http: 401, code: 'GW.AUTHN', message: '요청을 보낼 권한이 없습니다.' };
  const result = await client.call('productSearch', { body: searchBySellerCodeBody('anything') });
  assert.equal(result.verdict.ok, true, 'the retried request must actually have succeeded, not silently returned');
  assert.equal(tokenCalls(), before + 1, 're-minted exactly once');
  assert.equal(searchCalls(), 2, 'the request is replayed once after the fresh token');
  assert.equal(mock.calls.at(-1).headers.authorization, 'Bearer MOCK_ACCESS_TOKEN');

  // Now make the 401 persistent: the client must re-auth once and then surface
  // the error instead of looping against a credential it cannot fix.
  mock.state.failRequest = { http: 401, code: 'GW.AUTHN', message: '여전히 권한이 없습니다.', consume: false };
  const tokensBeforeSecond = tokenCalls();
  await assert.rejects(client.call('productSearch', { body: searchBySellerCodeBody('anything') }), (e) => {
    assert.equal(e.code, 'GW.AUTHN');
    assert.equal(e.family, 'gateway');
    assert.equal(e.traceId, 'mock-trace');
    return true;
  });
  assert.equal(tokenCalls(), tokensBeforeSecond + 1, 'a second 401 must not start a re-auth loop');
  assert.equal(searchCalls(), 4, 'exactly one replay per call, ever');
  mock.state.failRequest = null;
  await mock.close();
});

test('GW.IP_NOT_ALLOWED stops the client because only an operator can fix it', async () => {
  const { mock, client } = await withClient();
  mock.state.failRequest = { http: 403, code: 'GW.IP_NOT_ALLOWED', message: '호출이 허용되지 않은 IP입니다.' };
  await assert.rejects(client.call('productSearch', { body: {} }), (e) => e.code === 'GW.IP_NOT_ALLOWED');
  assert.equal(client.stopped, true);
  assert.match(client.stopReason, /IP_NOT_ALLOWED/);
  await assert.rejects(client.call('productRegister', { body: {} }), (e) => e.code === 'stopped');
  assert.equal(mock.calls.filter((c) => c.path === '/external/v1/products/search').length, 1, 'no retry against an unregistered IP');
  await mock.close();
});

test('a path the gateway has not registered is reported as path_not_registered, not retried', async () => {
  const { mock, client } = await withClient();
  await assert.rejects(client.call('orderQuery', { body: {} }), (e) => {
    assert.equal(e.code, 'path_not_registered');
    assert.equal(e.retryable, false);
    assert.equal(e.pathNotRegistered, true);
    assert.equal(client.stopped, false, 'one wrong path must not freeze the whole account');
    return true;
  });
  await mock.close();
});

test('429 GW.RATE_LIMIT is retryable and carries the rate-limit headers the docs point to', async () => {
  const { mock, client } = await withClient();
  mock.state.failRequest = { http: 429, code: 'GW.RATE_LIMIT', message: '요청이 많아 서비스를 일시적으로 사용할 수 없습니다.' };
  await assert.rejects(client.call('productSearch', { body: {} }), (e) => {
    assert.equal(e.retryable, true);
    assert.equal(e.rateHeaders['gncp-gw-ratelimit-remaining'], '0');
    return true;
  });
  assert.equal(client.lastRateHeaders['gncp-gw-ratelimit-limit'], '100');
  await mock.close();
});

test('domain errors keep their raw body because the docs publish no example shape', async () => {
  const { mock, client } = await withClient();
  mock.state.sellerCodeIndex.add('samasound.co.kr:3836');
  const { body } = buildRegisterBody(cleanRecord, { leafCategoryId: '50005556', images: uploadedImage, detailContent: '상세설명' });
  await assert.rejects(client.call('productRegister', { body }), (e) => {
    assert.equal(e.family, 'domain');
    assert.equal(e.code, 'DUPLICATE_SELLER_MANAGEMENT_CODE');
    assert.equal(e.retryable, false);
    assert.match(e.raw.message, /중복/);
    return true;
  });
  await mock.close();
});

test('without an idempotency key, a re-run modifies instead of registering twice', async () => {
  const { mock, client } = await withClient();
  const dry = await registerOrModify(client, { record: cleanRecord, leafCategoryId: '50005556', images: uploadedImage, detailContent: '상세설명' });
  assert.equal(dry.action, 'register');
  assert.equal(dry.transmitted, false, 'dry run by default: nothing was written');
  assert.equal(mock.calls.filter((c) => c.path === '/external/v2/products').length, 0);

  mock.state.sellerCodeIndex.add('samasound.co.kr:3836');
  const again = await registerOrModify(client, { record: cleanRecord, leafCategoryId: '50005556', images: uploadedImage, detailContent: '상세설명' });
  assert.equal(again.action, 'modify');
  assert.equal(again.existingOriginProductNo, 500001);
  assert.match(again.note, /전체 덮어쓰기/);
  const live = await registerOrModify(client, { record: cleanRecord, leafCategoryId: '50005556', images: uploadedImage, detailContent: '상세설명', execute: true });
  assert.equal(live.transmitted, true);
  assert.equal(live.result.data.receivedKind, 'origin');
  assert.equal(live.result.data.receivedMethod, 'PUT');
  await mock.close();
});

test('register boundaries are enforced locally, before any request leaves', () => {
  const problems = (record, opts) => buildRegisterBody(record, opts).problems.map((p) => `${p.field}:${p.reason}`);
  assert.deepEqual(problems(cleanRecord, { leafCategoryId: '', images: uploadedImage, detailContent: '' }), ['leafCategoryId:required_at_register', 'detailContent:required_at_register']);
  assert.ok(problems({ ...cleanRecord, price: { value: null, state: 'inquiry' } }, { leafCategoryId: '1', images: uploadedImage, detailContent: 'x' }).includes('salePrice:no_public_price'));
  assert.ok(problems({ ...cleanRecord, price: { value: NCOM_LIMITS.salePriceMax + 1 } }, { leafCategoryId: '1', images: uploadedImage, detailContent: 'x' }).some((p) => p.startsWith('salePrice:out_of_bounds')));
  assert.ok(problems({ ...cleanRecord, stockQuantity: NCOM_LIMITS.stockQuantityMax + 1 }, { leafCategoryId: '1', images: uploadedImage, detailContent: 'x' }).some((p) => p.startsWith('stockQuantity:out_of_bounds')));
  assert.ok(problems({ ...cleanRecord, stockQuantity: -2 }, { leafCategoryId: '1', images: uploadedImage, detailContent: 'x' }).includes('stockQuantity:negative'));
  // The single most consequential finding for the 4,575-row catalogue: external
  // image URLs are rejected by the vendor, so no row is registerable yet.
  assert.ok(problems(cleanRecord, { leafCategoryId: '1', images: { representative: 'https://www.samasound.co.kr/web/product/small/x.png' }, detailContent: 'x' })
    .includes('images.representative:not_from_image_upload_api'));
  assert.equal(NCOM_LIMITS.imagesPerUploadCall, 10);
});

test('ERP BAL_QTY becomes Naver stock only when it is a sane non-negative number', () => {
  const byProd = new Map([
    ['SM-2574', { naverItemId: 500001 }],
    ['SS-3836', { naverItemId: 500002, optionManaged: true }],
    ['SS-NOSTORE', {}],
    ['SM-9999', { naverItemId: 500003 }],
    ['SS-BIG', { naverItemId: 500004 }],
  ]);
  const result = stockFromErpBalance({
    erpRows: [
      { PROD_CD: 'SM-2574', BAL_QTY: '7.0000000000' },
      { PROD_CD: 'SS-3836', BAL_QTY: '0.0000000000' },
      { PROD_CD: 'SS-NOSTORE', BAL_QTY: '4' },
      { PROD_CD: 'SM-9999', BAL_QTY: '-1.0000000000' },
      { PROD_CD: 'SS-BIG', BAL_QTY: '999999999' },
      { PROD_CD: 'ZZ-ORPHAN', BAL_QTY: '2' },
      { PROD_CD: 'SM-0001', BAL_QTY: '재고없음' },
    ],
    mappingByProdCd: byProd,
  });
  assert.deepEqual(result.updates.map((u) => [u.prodCd, u.endpointKey, u.stockQuantity]), [['SM-2574', 'productModifyOrigin', 7], ['SS-3836', 'optionStock', 0]]);
  assert.deepEqual(result.rejected.map((r) => r.reason), ['no_naver_channel_product', 'negative_balance', 'out_of_bounds', 'unmapped_prod_cd', 'unreadable_BAL_QTY']);
  assert.equal(result.counts.updates, 2);
  assert.equal(result.counts.rejected, 5);
  // A rejected row never silently becomes "0 stock": the reason must name the fix.
  assert.ok(result.rejected.find((r) => r.reason === 'negative_balance').note.includes('OUTOFSTOCK'));
  assert.deepEqual(result.rejected.find((r) => r.reason === 'unmapped_prod_cd'), { prodCd: 'ZZ-ORPHAN', reason: 'unmapped_prod_cd', measured: 2, note: 'no CGI→ERP mapping row for this 품목코드' });
});

test('order polling clamps pageSize to the documented 300 and never invents a status enum', async () => {
  assert.equal(clampOrderPageSize(1000).pageSize, 300);
  assert.equal(clampOrderPageSize(undefined).pageSize, 300);
  assert.equal(clampOrderPageSize(50).clamped, false);
  const { mock, client } = await withClient();
  const page = clampOrderPageSize(900);
  await client.call('orderList', { query: { from: '2026-10-25T00:00:00+09:00', pageSize: page.pageSize } });
  assert.equal(mock.state.orderPageSizeSeen, '300');
  const call = mock.calls.at(-1);
  assert.equal(call.query.rangeType, undefined, 'rangeType allowed values are UNCONFIRMED, so nothing may be sent for it');
  assert.equal(call.query.productOrderStatuses, undefined);
  await mock.close();
});

test('the verified endpoint table is the only way to name a path, and gaps stay declared', () => {
  assert.deepEqual(NCOM_ENDPOINTS.token, { method: 'POST', path: '/v1/oauth2/token', authed: false, body: true });
  assert.ok(Object.values(NCOM_ENDPOINTS).every((e) => e.path.startsWith('/v1') || e.path.startsWith('/v2')));
  assert.ok(!Object.values(NCOM_ENDPOINTS).some((e) => /SOLD_OUT/i.test(e.path)));
  assert.equal(NCOM_ENDPOINTS.productModifyOrigin.path, '/v2/products/origin-products/{originProductNo}');
  assert.ok(NCOM_UNCONFIRMED.length >= 6);
  assert.ok(NCOM_UNCONFIRMED.some((u) => /idempotency/i.test(u)) === false, 'idempotency absence is a confirmed fact, not an unconfirmed one');
  assert.ok(NCOM_UNCONFIRMED.some((u) => /TTL/i.test(u)));
});
