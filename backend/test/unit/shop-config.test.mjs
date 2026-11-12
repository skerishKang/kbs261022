// Issue #209 A3: 주문 화면이 배송비 기준값을 미리 보여 줄 수 있도록 하는
// 공개 상점 설정 엔드포인트 계약.
import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv } from '../helpers.mjs';

test('GET /api/shop/config 는 SHIPPING_FEE_DEFAULT 를 되돌려 준다', async () => {
  const zero = await call(makeEnv(), 'GET', '/api/shop/config');
  assert.equal(zero.status, 200);
  assert.equal(zero.json.shipping_fee_default, 0);

  const custom = await call(makeEnv({ SHIPPING_FEE_DEFAULT: '3000' }), 'GET', '/api/shop/config');
  assert.equal(custom.status, 200);
  assert.equal(custom.json.shipping_fee_default, 3000);
});

test('GET /api/shop/config 는 로그인 없이 CORS 와 함께 답한다', async () => {
  const res = await call(makeEnv(), 'GET', '/api/shop/config');
  assert.equal(res.status, 200);
  assert.match(String(res.headers['access-control-allow-origin'] || ''), /.+/);
});
