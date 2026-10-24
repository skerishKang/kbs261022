import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  erpCodeFor,
  erpDedupeKey,
  buildEcountSalesSlip,
  createErpDriver,
  erpModeFromEnv,
  ERP_ADAPTER,
  ERP_ACTION_SALES_SLIP,
  ERP_SALES_SLIP_SCREEN,
} from '../../lib/erp.mjs';

test('erpCodeFor maps source sites to Ecount code prefixes', () => {
  assert.equal(erpCodeFor('samasound.co.kr:3836'), 'SS-3836');
  assert.equal(erpCodeFor('samamusic.co.kr:2574'), 'SM-2574');
  assert.equal(erpCodeFor('yamaha.co.kr:77'), 'YM-77');
  assert.equal(erpCodeFor('unknown.example.com:9'), 'XX-9');
  assert.equal(erpCodeFor('bare-id'), 'XX-bare-id');
});

test('erpDedupeKey is stable per order and action', () => {
  const a = erpDedupeKey('ORD-20261025-ABCDE');
  assert.equal(a, erpDedupeKey('ORD-20261025-ABCDE'));
  assert.notEqual(a, erpDedupeKey('ORD-20261025-BCDEF'));
  assert.notEqual(a, erpDedupeKey('ORD-20261025-ABCDE', 'other_action'));
  assert.ok(a.startsWith(`${ERP_ADAPTER}:`));
});

const ORDER = {
  id: 'ORD-20261025-ABCDE',
  kind: 'purchase',
  status: 'paid',
  created_at: '2026-10-25T04:00:00.000Z',
  customer_name: '김테스트',
  customer_company: '테스트회사',
  customer_phone: '010-1234-5678',
  customer_email: 'e2e@example.com',
  customer_addr: '광주광역시 광산구 테스트로 1',
  payment_status: 'paid',
  payment_key: 'pk_test',
  payment_method: '카드',
  paid_at: '2026-10-25T04:05:00.000Z',
  total_amount: 736000,
  supplied_amount: 669090,
  vat_amount: 66910,
  refunded_amount: 0,
  item_total: 731000,
  shipping_fee: 5000,
  customer_note: '새벽 배송 가능하면',
};

const ITEMS = [
  { seq: 1, product_id: 'samasound.co.kr:3836', product_name: 'SQ5+', brand: 'ALLEN&HEATH', qty: 2, unit_price: 365000, line_total: 730000, erp_code: 'SS-3836' },
  { seq: 2, product_id: 'samamusic.co.kr:2574', product_name: '테스트 상품', brand: 'Brand', qty: 1, unit_price: 1000, line_total: 1000, erp_code: 'SM-2574' },
];

test('buildEcountSalesSlip produces the sales-slip payload', () => {
  const payload = buildEcountSalesSlip({ order: ORDER, items: ITEMS, mode: 'test', liveWrite: false, generatedAt: new Date('2026-10-25T05:00:00Z') });

  assert.equal(payload.adapter, ERP_ADAPTER);
  assert.equal(payload.mode, 'test');
  assert.equal(payload.live_write, false);
  assert.equal(payload.transmission, 'not_transmitted_test_mode');
  assert.equal(payload.target.screen, ERP_SALES_SLIP_SCREEN);
  assert.equal(payload.target.action, ERP_ACTION_SALES_SLIP);
  assert.equal(payload.dedupe_key, erpDedupeKey('ORD-20261025-ABCDE'));
  assert.equal(payload.generated_at, '2026-10-25T05:00:00.000Z');

  assert.equal(payload.source.order_id, 'ORD-20261025-ABCDE');
  assert.equal(payload.customer.customer_name, '김테스트');
  assert.equal(payload.payment.payment_key, 'pk_test');
  assert.equal(payload.payment.amount, 736000);

  assert.equal(payload.lines.length, 2);
  assert.deepEqual(payload.lines[0], {
    seq: 1,
    prod_cd: 'SS-3836',
    prod_des: 'SQ5+',
    qty: 2,
    out_price: 365000,
    out_price_vat: 1,
    vat_rate: 10,
    vat_inclusive: true,
    amt: 730000,
    remark: '',
  });
  assert.equal(payload.lines[1].prod_cd, 'SM-2574');

  assert.equal(payload.totals.total_amount, 736000);
  assert.equal(payload.totals.supplied_amount + payload.totals.vat_amount, 736000);
  assert.equal(payload.note, '새벽 배송 가능하면');
});

test('buildEcountSalesSlip falls back to the derived ERP code', () => {
  const payload = buildEcountSalesSlip({
    order: ORDER,
    items: [{ seq: 1, product_id: 'samasound.co.kr:9999', product_name: 'X', qty: 1, unit_price: 100, line_total: 100 }],
    generatedAt: '2026-10-25T05:00:00.000Z',
  });
  assert.equal(payload.lines[0].prod_cd, 'SS-9999');
});

test('buildEcountSalesSlip requires an order id', () => {
  assert.throws(() => buildEcountSalesSlip({ order: {}, items: [] }), /order\.id/);
  assert.throws(() => buildEcountSalesSlip({}), /order\.id/);
});

test('erpModeFromEnv defaults to test and honours ERP_LIVE_WRITE', () => {
  assert.equal(erpModeFromEnv({}), 'test');
  assert.equal(erpModeFromEnv({ ERP_MODE: 'live' }), 'test', 'live mode needs ERP_LIVE_WRITE=YES');
  assert.equal(erpModeFromEnv({ ERP_MODE: 'live', ERP_LIVE_WRITE: 'YES' }), 'live');
  assert.equal(erpModeFromEnv({ ERP_MODE: 'live', ERP_LIVE_WRITE: 'NO' }), 'test');
  assert.equal(erpModeFromEnv({ ERP_MODE: 'live', ERP_LIVE_WRITE: 'yes' }), 'live');
});

test('test driver never transmits', async () => {
  const driver = createErpDriver({ ERP_MODE: 'test', ERP_LIVE_WRITE: 'NO' }, async () => {
    throw new Error('network must not be used in test mode');
  });
  assert.equal(driver.mode, 'test');
  assert.equal(driver.ready, false);
  const result = await driver.transmit({ dedupe_key: 'k' });
  assert.equal(result.delivered, false);
  assert.equal(result.status, 'skipped');
  assert.match(result.note, /ERP_LIVE_WRITE=NO/);
});

test('live driver without credentials skips instead of throwing', async () => {
  const driver = createErpDriver({ ERP_MODE: 'live', ERP_LIVE_WRITE: 'YES' }, async () => {
    throw new Error('no credentials, must not fetch');
  });
  assert.equal(driver.mode, 'live');
  assert.equal(driver.ready, false);
  const result = await driver.transmit({ dedupe_key: 'k' });
  assert.equal(result.delivered, false);
  assert.equal(result.status, 'skipped');
  assert.match(result.note, /not configured/);
});

test('live driver transmits through the injected client', async () => {
  let captured = null;
  const driver = createErpDriver(
    { ERP_MODE: 'live', ERP_LIVE_WRITE: 'YES', ERP_OAPI_BASE_URL: 'https://erp.example.test/oapi', ERP_OAPI_TOKEN: 'secret-token' },
    async (url, init) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return { ok: true, status: 200, json: async () => ({ code: '100' }) };
    }
  );
  assert.equal(driver.ready, true);
  const payload = { dedupe_key: 'ecount-test:sales_slip_create:order:ORD-1', lines: [] };
  const result = await driver.transmit(payload);
  assert.equal(result.delivered, true);
  assert.equal(result.status, 'sent');
  assert.equal(captured.url, 'https://erp.example.test/oapi/');
  assert.equal(captured.headers.Authorization, 'Bearer secret-token');
  assert.equal(captured.headers['Idempotency-Key'], payload.dedupe_key);
  assert.deepEqual(captured.body, payload);
});

test('live driver reports a failed transmission', async () => {
  const driver = createErpDriver(
    { ERP_MODE: 'live', ERP_LIVE_WRITE: 'YES', ERP_OAPI_BASE_URL: 'https://erp.example.test/oapi', ERP_OAPI_TOKEN: 't' },
    async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })
  );
  const result = await driver.transmit({ dedupe_key: 'k' });
  assert.equal(result.delivered, false);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /HTTP 500/);
});
