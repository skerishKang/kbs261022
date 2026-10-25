// Regression tests for the admin order drawer (orders.html).
//
// GET /api/orders hands back a flat ORDER_COLUMNS row, while GET /api/orders/:id
// hands back publicOrderView — a nested object whose payment data lives under
// .payment and whose admin-only columns are absent entirely. The drawer renders
// flat fields and gates the refund form on `o.payment_key`, so writing only the
// detail response made every paid order look unrefundable. These tests run the
// real console against the real shapes captured from Production, then drive the
// refund chain 작업 D requires.
//
//   node --test site/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const readJs = (name) => readFileSync(join(HERE, '..', 'assets', 'js', name), 'utf8');
const ORDERS_SRC = readJs('cgi-staff-orders.js');
const REFUND_SRC = readJs('cgi-refund.js');

const API = 'https://cgi-quote-api.example.workers.dev';
const ORIGIN = 'https://skerishkang.github.io';
const ORDER_ID = 'ORD-20261025-QCMYF';
const PAYMENT_KEY = 'tgen_2610262k7aEshCBfY0L';

/** GET /api/orders/ORD-20261025-QCMYF — body recorded from Production 2026-10-26. */
const LIVE_DETAIL = {
  id: ORDER_ID,
  kind: 'purchase',
  status: 'paid',
  payment_status: 'paid',
  delivery_status: 'processing',
  status_label: '결제 완료',
  created_at: '2026-10-25T08:45:08.434Z',
  updated_at: '2026-10-25T16:04:41.182Z',
  customer: {
    company: '(주)CGI테스트', name: '홍길동', phone: '010-0000-0000', email: null,
    addr: '서울특별시 강남구 테헤란로 123', addr_detail: null, note: '튜토리얼 촬영용 테스트 주문입니다',
  },
  totals: {
    item_total: 368000, shipping_fee: 0, total_amount: 368000,
    supplied_amount: 334545, vat_amount: 33455, refunded_amount: 0,
  },
  payable: false,
  payment: { status: 'paid', method: '계좌이체', payment_key: PAYMENT_KEY, paid_at: '2026-10-26T01:04:40+09:00' },
  delivery: { status: 'processing', tracking: null },
  erp_status: 'skipped',
  erp_sent_at: null,
  source_quote_id: null,
  customer_id: 14,
  items: [{
    product_id: 'samamusic.co.kr:2574',
    product_name: 'SHURE RMCE-TW2 / 슈어 완전 무선 이어폰 어댑터 2세대',
    brand: 'SHURE', category: '이어폰', option_label: null, price_state: 'public',
    unit_price: 368000, qty: 1, line_total: 368000,
  }],
};

/** GET /api/orders row for the same order — flat, and it alone carries admin columns. */
const LIST_ROW = {
  id: ORDER_ID, kind: 'purchase', status: 'paid', payment_status: 'paid', delivery_status: 'processing',
  erp_status: 'skipped', erp_sent_at: null, created_at: '2026-10-25T08:45:08.434Z',
  customer_company: '(주)CGI테스트', customer_name: '홍길동', customer_phone: '010-0000-0000',
  customer_email: null, customer_addr: '서울특별시 강남구 테헤란로 123', customer_addr_detail: null,
  customer_note: '튜토리얼 촬영용 테스트 주문입니다', source_quote_id: null,
  item_total: 368000, shipping_fee: 0, total_amount: 368000, refunded_amount: 0,
  payment_method: '계좌이체', payment_key: PAYMENT_KEY, paid_at: '2026-10-26T01:04:40+09:00',
  delivery_tracking: null, admin_note: 'ERP 미전송 · 튜토리얼 주문', admin_prices: null,
};

const SUPERADMIN = { email: 'charliekant@gmail.com', role: 'superadmin', is_admin: false };

/** Ids whose elements #drawerBody's innerHTML write replaces. */
const DRAWER_CHILDREN = ['statusForm', 'deliveryForm', 'noteForm', 'refundForm', 'priceForm',
  'priceConvertBtn', 'erpBtn', 'erpRetryBtn', 'actionMsg', 'drawerEvents'];

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/* ------------------------------------------------------------ stub DOM */

function makeElement(id, onWrite) {
  const listeners = {};
  const children = new Map();
  let card = null;
  let html = '';
  return {
    id,
    hidden: false,
    disabled: false,
    selected: false,
    value: '',
    textContent: '',
    listeners,
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value;
      if (onWrite) onWrite(id);
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, event) {
      const fns = listeners[type] || [];
      fns.forEach((fn) => fn(event || { preventDefault() {} }));
      return fns.length;
    },
    getAttribute(name) {
      if (name === 'data-open') return ORDER_ID;
      if (name === 'data-promote' || name === 'data-demote') return '14';
      return name;
    },
    // Rendered forms are addressed by [name="…"], so every selector gets its own
    // stable stub whose value the test writes before dispatching submit.
    querySelector(selector) {
      const key = String(selector);
      if (!children.has(key)) children.set(key, makeElement(id + ' ' + key));
      return children.get(key);
    },
    querySelectorAll() {
      card = card || makeElement(id + ':card');
      return [card];
    },
    appendChild() {},
    insertAdjacentHTML() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
}

function makeDocument() {
  const elements = new Map();
  const listeners = {};
  // Only #drawerBody replaces the rendered forms, so only its write may drop
  // their elements; #drawerEvents/.order-list writes must leave them bound.
  const onWrite = () => DRAWER_CHILDREN.forEach((kid) => elements.delete(kid));
  return {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id, id === 'drawerBody' ? onWrite : null));
      return elements.get(id);
    },
    createElement(tag) { return makeElement('<' + tag + '>'); },
    body: makeElement('body'),
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, event) { (listeners[type] || []).forEach((fn) => fn(event || {})); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

/**
 * Stand-in for the Worker: serves the recorded shapes and posts cancels against
 * the payment balance the way cancelPayment does, so the drawer's numbers track
 * a refund ledger instead of a frozen fixture.
 */
function makeServer() {
  const calls = [];
  let refunded = 0;
  const total = LIVE_DETAIL.totals.total_amount;
  return {
    calls,
    refunded: () => refunded,
    handle(path, init) {
      calls.push({ path, init: init || {} });
      if (path === '/api/orders') {
        return { items: [Object.assign({}, LIST_ROW, { refunded_amount: refunded })] };
      }
      const cancel = path.match(/^\/api\/orders\/([^/]+)\/payments\/([^/]+)\/cancel$/);
      if (cancel) {
        const body = JSON.parse(init.body);
        const balance = total - refunded;
        if (!String(body.cancelReason || '').trim()) return { __fail: 'cancelReason required' };
        const amount = body.cancelAmount == null ? balance : Number(body.cancelAmount);
        if (amount > balance) return { __fail: 'amount exceeds balance' };
        refunded += amount;
        return { payment_key: cancel[2], cancel_amount: amount, balance_amount: total - refunded };
      }
      if (/^\/api\/orders\/[^/]+\/events$/.test(path)) return { items: [] };
      if (/^\/api\/orders\/[^/]+$/.test(path)) {
        return JSON.parse(JSON.stringify(Object.assign({}, LIVE_DETAIL, {
          totals: Object.assign({}, LIVE_DETAIL.totals, { refunded_amount: refunded }),
        })));
      }
      if (path === '/api/admin/members') {
        return { items: [{ id: 14, email: 'charliekant@gmail.com', name: '강사장', status: 'active', email_verified: true, role: 'superadmin' }] };
      }
      return {};
    },
  };
}

function evaluateConsole(env) {
  new Function('window', 'document', 'localStorage', 'fetch', 'alert', 'console', 'setTimeout', ORDERS_SRC)(
    env.window, env.document, env.storage, env.fetchFn, (m) => env.alerts.push(m),
    { log() {}, error() {}, warn() {} }, setTimeout);
}

/** Boots the real cgi-staff-orders.js with a superadmin member session already in place. */
async function bootConsole() {
  const document = makeDocument();
  const server = makeServer();
  const alerts = [];
  const storage = {
    data: {},
    getItem(key) { return key in this.data ? this.data[key] : null; },
    setItem(key, value) { this.data[key] = String(value); },
    removeItem(key) { delete this.data[key]; },
  };
  const window = {
    CGI_SITE_CONFIG: { orderApiUrl: API },
    CGI_AUTH: {
      refresh: () => Promise.resolve(SUPERADMIN),
      login: () => Promise.resolve(true),
      logout() {},
      googleLogin() {},
    },
    location: { origin: ORIGIN, href: ORIGIN + '/site/orders.html' },
  };
  // the shipped refund rules module, so the cancel body is the real one
  new Function('window', REFUND_SRC)(window);
  const fetchFn = (url, init) => {
    const res = server.handle(String(url).slice(API.length), init);
    const ok = !res.__fail;
    return Promise.resolve({ ok, status: ok ? 200 : 400, json: () => Promise.resolve(res) });
  };
  const env = { window, document, storage, server, alerts, fetchFn };
  evaluateConsole(env);
  document.dispatch('DOMContentLoaded');
  await tick();
  await tick();

  return {
    window, document, server, alerts,
    drawerBody: () => document.getElementById('drawerBody').innerHTML,
    actionMsg: () => document.getElementById('actionMsg').innerHTML,
    openDrawer: async () => {
      const card = document.getElementById('orderList').querySelectorAll('[data-open]')[0];
      assert.equal(card.dispatch('click'), 1, 'the rendered 상세 button must carry a detail handler');
      await tick();
      await tick();
    },
    refund: async (amount, reason) => {
      // The stub document hands out an element for any id, so a submit handler on
      // a form the drawer never rendered would read as green. Gate on the markup.
      assert.ok(document.getElementById('drawerBody').innerHTML.includes('id="refundForm"'),
        'the rendered drawer has no refund form — the payment key was lost');
      const form = document.getElementById('refundForm');
      assert.equal(form.listeners.submit ? form.listeners.submit.length : 0, 1,
        'the rendered refund form must be bound exactly once');
      form.querySelector('[name="cancelAmount"]').value = amount == null ? '' : String(amount);
      form.querySelector('[name="cancelReason"]').value = reason;
      form.dispatch('submit');
      await tick();
      await tick();
      await tick();
    },
  };
}

/* -------------------------------------------------------- drawerOrder unit */

function drawerOrder(row, detail) {
  if (!drawerOrder.fn) {
    const window = { CGI_SITE_CONFIG: {}, location: { origin: ORIGIN } };
    const document = makeDocument();
    const env = {
      window, document, storage: { getItem() { return null; }, setItem() {}, removeItem() {} },
      fetchFn: () => Promise.resolve({ ok: false, status: 0, json: () => Promise.resolve({}) }), alerts: [],
    };
    evaluateConsole(env);
    assert.equal(typeof window.CGI_STAFF_ORDERS.drawerOrder, 'function',
      'cgi-staff-orders.js must expose drawerOrder so the seam is testable');
    drawerOrder.fn = window.CGI_STAFF_ORDERS.drawerOrder;
  }
  return drawerOrder.fn(row, detail);
}

test('the production detail carries no flat payment_key, so the detail alone cannot open the refund form', () => {
  // The oracle is Production's own payload, not our code: the pre-fix drawer read
  // `state.drawer.payment_key` off exactly this object and got undefined.
  assert.equal(LIVE_DETAIL.payment_key, undefined);
  assert.equal(LIVE_DETAIL.admin_note, undefined);
  assert.equal(LIVE_DETAIL.total_amount, undefined);
});

test('drawerOrder flattens the nested detail over the list row', () => {
  const merged = drawerOrder(LIST_ROW, LIVE_DETAIL);
  assert.equal(merged.id, ORDER_ID);
  assert.equal(merged.payment_key, PAYMENT_KEY, 'the refund gate needs the key under .payment');
  assert.equal(merged.total_amount, 368000, 'and the balance maths needs totals');
  assert.equal(merged.refunded_amount, 0);
  assert.equal(merged.customer_company, '(주)CGI테스트');
  assert.equal(merged.customer_name, '홍길동');
  assert.equal(merged.customer_addr, '서울특별시 강남구 테헤란로 123');
  assert.equal(merged.payment_method, '계좌이체');
  assert.equal(merged.paid_at, '2026-10-26T01:04:40+09:00');
  // admin-only columns exist on the row only, so the row has to stay underneath
  assert.equal(merged.admin_note, 'ERP 미전송 · 튜토리얼 주문');
  assert.equal(merged.items, LIVE_DETAIL.items, 'the nested sections stay reachable for the item table');
});

test('a fresh detail outranks a stale list row', () => {
  const stale = Object.assign({}, LIST_ROW, { refunded_amount: 0 });
  const afterPartial = Object.assign({}, LIVE_DETAIL, {
    totals: Object.assign({}, LIVE_DETAIL.totals, { refunded_amount: 100000 }),
  });
  assert.equal(drawerOrder(stale, afterPartial).refunded_amount, 100000,
    'a refund already posted must not be hidden by the cached row');
});

test('a detail without an id falls back to the row instead of wiping the drawer', () => {
  assert.equal(drawerOrder(LIST_ROW, {}), LIST_ROW);
  assert.equal(drawerOrder(LIST_ROW, null), LIST_ROW);
  assert.equal(drawerOrder(null, {}), null);
});

/* --------------------------------------------------------- live drawer run */

test('the drawer of a paid order renders the refund form and the admin-only note', async () => {
  const env = await bootConsole();
  await env.openDrawer();
  const html = env.drawerBody();

  assert.ok(html.includes('id="refundForm"'), 'a paid, unrefunded order must offer a refund form');
  assert.ok(html.includes(PAYMENT_KEY), 'the payment key must be shown so the operator can cite it');
  assert.match(html, /환불 가능 잔액:\s*<strong>368,000원<\/strong>/);
  assert.ok(html.includes('(주)CGI테스트'), 'the nested customer block must reach the 주문자 section');
  assert.ok(html.includes('홍길동'));
  assert.ok(html.includes('계좌이체'), 'the payment method comes from the nested block too');
  assert.ok(html.includes('ERP 미전송 · 튜토리얼 주문'), '관리자 메모 exists only on the list row');
  assert.doesNotMatch(html, /환불할 결제가 없거나/);
});

test('partial refunds accumulate and the drawer re-renders the shrinking balance', async () => {
  const env = await bootConsole();
  await env.openDrawer();

  await env.refund(100000, '부분 환불 1 — 촬영 일정 변경');
  assert.match(env.drawerBody(), /환불 가능 잔액:\s*<strong>268,000원<\/strong>/);
  assert.match(env.drawerBody(), /환불액<\/dt><dd class="warn">100,000원/);

  await env.refund(50000, '부분 환불 2 — 일부 품목 취소');
  assert.match(env.drawerBody(), /환불 가능 잔액:\s*<strong>218,000원<\/strong>/);
  assert.match(env.drawerBody(), /환불액<\/dt><dd class="warn">150,000원/,
    'the second partial must read as cumulative 150,000, not 50,000');

  const cancels = env.server.calls.filter((c) => /\/cancel$/.test(c.path));
  assert.deepEqual(cancels.map((c) => JSON.parse(c.init.body)), [
    { cancelReason: '부분 환불 1 — 촬영 일정 변경', cancelAmount: 100000 },
    { cancelReason: '부분 환불 2 — 일부 품목 취소', cancelAmount: 50000 },
  ], 'exactly one request per refund, amount and reason sent as entered');
});

test('an omitted amount refunds the whole balance, and an over-balance amount never leaves the browser', async () => {
  const env = await bootConsole();
  await env.openDrawer();

  const before = env.server.calls.length;
  await env.refund(400000, '잔액 초과 시도');
  assert.match(env.actionMsg(), /환불 금액이 잔액보다 많습니다\./);
  assert.equal(env.server.calls.length, before, 'an over-balance request may not reach the Worker');

  await env.refund(null, '잔액 전액 환불');
  assert.equal(env.server.refunded(), 368000, 'a blank cancelAmount means the full remaining balance');
  const last = env.server.calls.filter((c) => /\/cancel$/.test(c.path)).pop();
  assert.equal(JSON.parse(last.init.body).cancelAmount, undefined);

  assert.doesNotMatch(env.drawerBody(), /id="refundForm"/, 'a zero balance must stop offering refunds');
  assert.match(env.drawerBody(), /환불할 결제가 없거나 잔액이 소진되었습니다\./);
  assert.match(env.drawerBody(), /환불액<\/dt><dd class="warn">368,000원/);
});

test('the drawer reads the list row for an order the detail response cannot describe alone', async () => {
  const env = await bootConsole();
  await env.openDrawer();
  // the textarea holds admin_note, which publicOrderView omits entirely
  assert.match(env.drawerBody(), /<textarea name="admin_note"[^>]*>ERP 미전송 · 튜토리얼 주문<\/textarea>/);
});

test('the console runs on the member session, with no Bearer token involved', async () => {
  const env = await bootConsole();
  const list = env.server.calls.find((c) => c.path === '/api/orders');
  assert.equal(list.init.credentials, 'include');
  assert.equal(list.init.headers.Authorization, undefined);
  assert.match(list.init.headers['X-CSRF-Token'], /skerishkang\.github\.io/);
});
