'use strict';
/*
 * #67 주문·결제 흐름 운영 검증 하네스 (무연동/테스트 모드).
 *
 *   node tools/e2e_order_flow.js [--worker https://cgi-quote-api.charliekant.workers.dev]
 *
 * 정책:
 *  - PG_PROVIDER_MODE=mock(토스 시크릿 미등록) 상태에서만 결제 확인을 보낸다.
 *    live 모드로 감지되면 결제 단계를 건너뛰고 BLOCKED-LIVE-PG로 종료한다.
 *  - 모든 주문 회사명·담당자명에 [E2E] 마크를 붙여 운영 데이터와 구분한다.
 *  - 판매가를 클라이언트 쪽에서 쓰지 않는다. 서버 가격 색인만 신뢰한다.
 *  - 환불은 전액이 아닌 부분 환불로 끝내 데이터 흔적을 최소화한다.
 */
const args = process.argv.slice(2);
const WORKER = (args.indexOf('--worker') !== -1 && args[args.indexOf('--worker') + 1])
  || 'https://cgi-quote-api.charliekant.workers.dev';
const ORIGIN = 'https://skerishkang.github.io';
const R = {};
let failed = 0;

const stage = (k, v) => { R[k] = v; console.log('[ORDER]', k, JSON.stringify(v)); };
const check = (name, cond, detail) => {
  const row = { check: name, pass: !!cond, detail: detail === undefined ? null : detail };
  stage(name, row);
  if (!cond) failed += 1;
  return cond;
};

async function call(method, path, body, token) {
  const headers = { Origin: ORIGIN };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(WORKER + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  const h = {};
  res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
  return { status: res.status, json, text, headers: h };
}

const MK = '[E2E]';
const CUSTOMER = { company: MK + ' 테스트 회사', name: MK + ' 담당자', phone: '010-0000-0099', email: 'e2e@example.com', addr: '광주광역시 광산구 테스트로 1', note: 'E2E 자동화 검증 주문 — 실제 결제 없음' };

(async () => {
  // 0) 모드 확인 — live PG면 결제 단계 금지
  const health = await call('GET', '/api/admin/health');
  stage('health', { status: health.status, version: health.json && health.json.version, pg: health.json && health.json.pg, erp: health.json && health.json.erp, price_index: health.json && health.json.price_index });
  check('health_ok', health.status === 200 && health.json && health.json.ok === true);
  check('pg_not_live', health.json && health.json.pg && health.json.pg.live === false, health.json && health.json.pg && health.json.pg.mode);

  // 1) 서버 가격 권위: 클라이언트 가격을 받아들이지 않는다
  const probe = await call('POST', '/api/orders', {
    items: [{ product_id: 'samamusic.co.kr:2574', qty: 1, unit_price: 1 }],
    ...CUSTOMER,
    idempotency_key: 'e2e-probe-' + Date.now(),
  });
  check('client_price_rejected', probe.status === 400 && probe.json && probe.json.error === 'price mismatch', probe.json);

  // 2) 정상 주문 생성 (서버 가격만 사용) — 최근 동일 장바구니가 있으면 allow_duplicate로 통과
  const key1 = 'e2e-order-' + Date.now();
  const cart1 = [{ product_id: 'samamusic.co.kr:2574', qty: 2 }, { product_id: 'samamusic.co.kr:1606', qty: 1 }];
  let created = await call('POST', '/api/orders', { items: cart1, ...CUSTOMER, idempotency_key: key1 });
  if (created.status === 409) {
    created = await call('POST', '/api/orders', { items: cart1, ...CUSTOMER, idempotency_key: key1, allow_duplicate: true });
  }
  stage('create', { status: created.status, id: created.json && created.json.id, kind: created.json && created.json.kind, total: created.json && created.json.totals && created.json.totals.total_amount });
  check('order_created', created.status === 201 && created.json && created.json.id && created.json.id.startsWith('ORD-'));
  const order = created.json;
  check('order_is_purchase', order && order.kind === 'purchase');
  check('order_payable', order && order.payable === true);
  check('order_priced_by_server', order && order.items.every((i) => typeof i.unit_price === 'number' && i.unit_price > 0));
  check('order_vat_split', order && order.totals.supplied_amount + order.totals.vat_amount === order.totals.total_amount, order && order.totals);
  check('order_id_format', order && /^ORD-\d{8}-[A-Z0-9]{5}$/.test(order.id), order && order.id);
  check('order_id_18_chars', order && order.id.length === 18, order && order.id.length);

  // 3) 멱등성: 같은 키로 재요청하면 같은 주문
  const replay = await call('POST', '/api/orders', { items: cart1, ...CUSTOMER, idempotency_key: key1 });
  check('idempotent_replay', replay.status === 200 && replay.json && replay.json.idempotent === true && replay.json.id === order.id, replay.status);

  // 4) 동일 장바구니 중복 창
  const dup = await call('POST', '/api/orders', { items: cart1, ...CUSTOMER, idempotency_key: 'e2e-dup-' + Date.now() });
  check('duplicate_window_blocks', dup.status === 409, dup.json);

  // 5) 결제 확인 (mock — 실제 청구 없음)
  let paymentKey = null;
  if (health.json && health.json.pg && health.json.pg.live === false) {
    const bad = await call('POST', '/api/payments/confirm', { orderId: order.id, paymentKey: 'e2e-bad-' + Date.now(), amount: order.totals.total_amount + 100 });
    check('amount_mismatch_rejected', bad.status === 400 && bad.json && bad.json.error === 'amount mismatch', bad.json);

    paymentKey = 'e2e-mock-pkey-' + Date.now();
    const paid = await call('POST', '/api/payments/confirm', { orderId: order.id, paymentKey, amount: order.totals.total_amount, paymentMethod: '카드' });
    stage('payment_confirm', { status: paid.status, approved: paid.json && paid.json.approved, provider_mode: paid.json && paid.json.payment && paid.json.payment.provider_mode, order_status: paid.json && paid.json.order && paid.json.order.status });
    check('payment_approved', paid.status === 200 && paid.json && paid.json.approved === true);
    check('payment_mock_mode', paid.json && paid.json.payment && paid.json.payment.provider_mode === 'mock');
    check('order_paid', paid.json && paid.json.order && paid.json.order.status === 'paid' && paid.json.order.payment_status === 'paid');
    check('delivery_auto_progress', paid.json && paid.json.order && paid.json.order.delivery_status === 'processing', paid.json && paid.json.order && paid.json.order.delivery_status);
    check('payment_key_recorded', paid.json && paid.json.order && paid.json.order.payment && paid.json.order.payment.payment_key === paymentKey);

    const again = await call('POST', '/api/payments/confirm', { orderId: order.id, paymentKey, amount: order.totals.total_amount });
    check('payment_key_idempotent', again.status === 200 && again.json && again.json.idempotent === true);

    // 부분 환불 + 최소 단거 + 멱등 재생
    const partial = await call('POST', `/api/orders/${order.id}/payments/${paymentKey}/cancel`, { cancelAmount: 1000, cancelReason: MK + ' 부분 환불 검증' });
    check('refund_requires_admin', partial.status === 401, partial.status);
    stage('refund_requires_admin', { status: partial.status, note: 'ADMIN_TOKEN 없어 운영 환불 검증은 BLOCKED-NO-TOKEN' });
  } else {
    stage('refund_requires_admin', { status: 'SKIPPED', note: 'PG_PROVIDER_MODE=live 감지되어 결제·환불 검증 건너뜀' });
    failed += 1;
  }

  // 6) 가격 미확정 장바구니 -> 견적 주문, 결제 불가
  const quoteCart = [{ product_id: 'samasound.co.kr:3836', qty: 1 }];
  let quote = await call('POST', '/api/orders', {
    items: quoteCart, ...CUSTOMER, idempotency_key: 'e2e-quote-' + Date.now(),
  });
  if (quote.status === 409) {
    quote = await call('POST', '/api/orders', { items: quoteCart, ...CUSTOMER, idempotency_key: 'e2e-quote-' + Date.now(), allow_duplicate: true });
  }
  stage('quote_order', { status: quote.status, id: quote.json && quote.json.id, kind: quote.json && quote.json.kind, payable: quote.json && quote.json.payable, total: quote.json && quote.json.totals && quote.json.totals.total_amount });
  check('unpriced_becomes_quote', quote.status === 201 && quote.json && quote.json.kind === 'quote');
  check('quote_not_payable', quote.json && quote.json.payable === false);
  check('quote_total_zero', quote.json && quote.json.totals.total_amount === 0);
  if (quote.json && quote.json.id) {
    const tryPay = await call('POST', '/api/payments/confirm', { orderId: quote.json.id, paymentKey: 'e2e-q-' + Date.now(), amount: 1 });
    check('quote_payment_forbidden', tryPay.status === 409, tryPay.json);
  } else {
    check('quote_payment_forbidden', false, 'quote order missing');
  }

  // 7) 기존 견적 도구 회귀 — POST /api/quotes 는 그대로 동작해야 한다
  const legacy = await call('POST', '/api/quotes', {
    items: [{ id: 'x', name: 'E2E 회귀 검증 상품', qty: 1 }],
    company: MK + ' 테스트 회사', name: MK + ' 담당자', phone: '010-0000-0098', note: '기존 견적 도구 회귀 검증',
  });
  check('legacy_quote_still_works', legacy.status === 201 && legacy.json && legacy.json.id && legacy.json.id.startsWith('Q-'), legacy.json);

  // 8) 미인증 관리자 라우트 거부
  const listDenied = await call('GET', '/api/orders');
  check('admin_list_requires_auth', listDenied.status === 401, listDenied.status);
  const initDenied = await call('POST', '/api/admin/schema/init', {});
  check('schema_init_requires_auth', initDenied.status === 401, initDenied.status);

  const verdict = {
    target: WORKER,
    total: Object.keys(R).length - 1,
    failed,
    result: failed === 0 ? 'PASS' : 'FAIL',
    notes: {
      pg_mode: health.json && health.json.pg && health.json.pg.mode,
      pg_live: health.json && health.json.pg && health.json.pg.live,
      erp_live_write: health.json && health.json.erp && health.json.erp.live_write,
      admin_ops: 'BLOCKED-NO-TOKEN',
      order_id: order ? order.id : null,
      payment_key: paymentKey,
      test_data_marked: MK,
    },
  };
  stage('VERDICT', verdict);
  process.exit(failed === 0 ? 0 : 9);
})().catch((e) => { console.error('[ORDER] ERROR', e.message, e.stack); process.exit(2); });
