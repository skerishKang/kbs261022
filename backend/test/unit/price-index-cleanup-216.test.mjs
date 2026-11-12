// 이슈 #216 G1 — 비상품(결제창·잔금·계약금) 페이지 제거 후 가격 인덱스 정합성.
//
// Worker 는 PRICE_INDEX 만 근거로 결제 금액을 검증한다. 제외된 id 는 인덱스에
// 없으므로 가격 공개 상품이 될 수 없고, 결제 주문로 결제 주문을 만들 수 없다.
//
//   node --test test/unit/price-index-cleanup-216.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { PRICE_INDEX, PRICE_INDEX_META } from '../../data/price_index.mjs';
import { makeEnv, call, CUSTOMER } from '../helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(HERE, '..', '..', '..', 'site', 'data', 'catalog.json'), 'utf8'),
);

const EXCLUDED_IDS = [
  'samamusic.co.kr:1100', 'samamusic.co.kr:1428', 'samamusic.co.kr:1611',
  'samamusic.co.kr:1613', 'samamusic.co.kr:1630', 'samamusic.co.kr:1891',
  'samamusic.co.kr:1892', 'samamusic.co.kr:1893', 'samamusic.co.kr:1910',
  'samamusic.co.kr:1911', 'samamusic.co.kr:1912', 'samamusic.co.kr:1913',
  'samamusic.co.kr:1914', 'samamusic.co.kr:1947', 'samamusic.co.kr:2055',
  'samamusic.co.kr:2358', 'samamusic.co.kr:2365', 'samamusic.co.kr:2366',
  'samamusic.co.kr:2419', 'samamusic.co.kr:2546', 'samamusic.co.kr:2583',
  'samamusic.co.kr:2668', 'samamusic.co.kr:2727', 'samamusic.co.kr:2745',
  'samamusic.co.kr:2758', 'samamusic.co.kr:2805', 'samamusic.co.kr:2918',
  'samamusic.co.kr:40', 'samamusic.co.kr:911',
];

test('G1: 가격 인덱스는 2,088건이고 제외 id 는 없다', () => {
  assert.equal(PRICE_INDEX_META.products_total, 4546);
  assert.equal(PRICE_INDEX_META.products_with_price, 2088);
  for (const id of EXCLUDED_IDS) {
    assert.equal(PRICE_INDEX[id], undefined, `제외된 id 가 인덱스에 남았다: ${id}`);
  }
});

test('G1: 남은 가격 공개 상품의 id·가격은 카탈로그와 인덱스가 같다', () => {
  const priced = catalog.products.filter((p) => p.price && p.price.state === 'public');
  assert.equal(priced.length, 2088);
  assert.equal(Object.keys(PRICE_INDEX).length, 2088);
  for (const p of priced) {
    const entry = PRICE_INDEX[p.id];
    assert.ok(entry, `인덱스에 없는 가격 공개 상품: ${p.id}`);
    assert.equal(entry.p, p.price.value, `가격 불일치: ${p.id}`);
  }
});

test('G1: 제외 id 로는 결제 주문을 만들 수 없다(견적으로만 접수)', async () => {
  const env = makeEnv();
  const res = await call(env, 'POST', '/api/orders', {
    items: [{ product_id: EXCLUDED_IDS[0], qty: 1 }],
    ...CUSTOMER,
  });
  assert.equal(res.status, 201, res.text);
  const order = res.json;
  assert.equal(order.kind, 'quote', '가격 미확인 상품은 견적으로 접수된다');
  assert.equal(order.payable, false, '결제 주문로 진행할 수 없다');
});
