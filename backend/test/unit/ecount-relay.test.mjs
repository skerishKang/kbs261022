import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ecountSyncMode,
  relayEnabled,
  constantTimeEquals,
  relayMaterial,
  parseRelayPayload,
  RELAY_DEFAULT_CUST,
  RELAY_DEFAULT_WH_CD,
} from '../../lib/ecount-relay.mjs';

const ORDER = {
  id: 'ORDER-RELAY-1',
  status: 'paid',
  payment_status: 'paid',
  shipping_fee: 0,
  paid_at: '2026-11-18T01:02:03.000Z',
  created_at: '2026-11-18T01:00:00.000Z',
};
const ITEMS = [
  { product_id: 'P-1', product_name: 'Item 1', qty: 2, unit_price: 1500, line_total: 3000, option_label: '옵션 A' },
  { product_id: 'P-2', product_name: 'Item 2', qty: 1, unit_price: 2500, line_total: 2500, option_label: '' },
];

test('sync mode defaults to relay and only an explicit direct value opts out', () => {
  assert.equal(ecountSyncMode({}), 'relay');
  assert.equal(ecountSyncMode({ ECOUNT_SYNC_MODE: '' }), 'relay');
  assert.equal(ecountSyncMode({ ECOUNT_SYNC_MODE: ' DIRECT ' }), 'direct');
  assert.equal(ecountSyncMode({ ECOUNT_SYNC_MODE: 'nonsense' }), 'relay');
  assert.equal(relayEnabled({ ECOUNT_ORDER_SYNC_ENABLED: 'YES' }), true);
  assert.equal(relayEnabled({ ECOUNT_ORDER_SYNC_ENABLED: 'NO' }), false);
  assert.equal(relayEnabled({}), false);
});

test('constant time token comparison accepts equality only', () => {
  assert.equal(constantTimeEquals('FAKE-TOKEN', 'FAKE-TOKEN'), true);
  assert.equal(constantTimeEquals('FAKE-TOKEN', 'fake-token'), false);
  assert.equal(constantTimeEquals('FAKE-TOKEN', 'FAKE-TOKE'), false);
  assert.equal(constantTimeEquals('', ''), true);
});

test('relay material reuses the SaleOrder body with mapped codes and default customer', () => {
  const result = relayMaterial({
    order: ORDER,
    items: ITEMS,
    approvedItemMap: { 'P-1': 'EC-A001', 'P-2': 'EC-B002' },
    env: { ECOUNT_API_CERT_KEY: 'FAKE-CERT-DO-NOT-PRINT' },
  });
  assert.equal(result.ready, true);
  assert.equal(result.payload.relay.cust, RELAY_DEFAULT_CUST);
  assert.equal(result.payload.relay.wh_cd, RELAY_DEFAULT_WH_CD);
  assert.deepEqual(result.payload.lines.map((line) => [line.prod_cd, line.qty, line.unit_price, line.note]), [
    ['EC-A001', 2, 1500, '옵션 A'],
    ['EC-B002', 1, 2500, ''],
  ]);
  assert.deepEqual(result.payload.body.SaleOrderList.map((row) => row.BulkDatas.PROD_CD), ['EC-A001', 'EC-B002']);
  assert.equal(new Set(result.payload.body.SaleOrderList.map((row) => row.BulkDatas.UPLOAD_SER_NO)).size, 1);
  assert.equal(JSON.stringify(result.payload).includes('FAKE-CERT-DO-NOT-PRINT'), false);
});

test('env customer and warehouse override the relay defaults', () => {
  const result = relayMaterial({
    order: ORDER,
    items: ITEMS,
    approvedItemMap: { 'P-1': 'EC-A001', 'P-2': 'EC-B002' },
    env: { ECOUNT_DEFAULT_CUST_CODE: 'WEB01', ECOUNT_DEFAULT_WH_CD: '99' },
  });
  assert.equal(result.payload.relay.cust, 'WEB01');
  assert.equal(result.payload.relay.wh_cd, '99');
});

test('a single unmapped product holds the whole order and names the product id', () => {
  const result = relayMaterial({ order: ORDER, items: ITEMS, approvedItemMap: { 'P-1': 'EC-A001' } });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'product_mapping_missing');
  assert.deepEqual(result.missingProductIds, ['P-2']);
  assert.equal(result.payload.body, undefined);
});

test('corrupt stored payloads are ignored', () => {
  assert.equal(parseRelayPayload('{not json'), null);
  assert.equal(parseRelayPayload('[]'), null);
  assert.deepEqual(parseRelayPayload('{"relay":{"cust":"X"}}'), { relay: { cust: 'X' } });
});
