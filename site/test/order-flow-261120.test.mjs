// 주문·결제 흐름 회귀 시험 (2026-11-20)
//
//  1. 로그인 회원이 주문서 이메일을 비워도 결제창 요청이 회원 세션(CGI_AUTH.api,
//     쿠키·CSRF 포함)으로 나가야 한다. 일반 fetch 로 보내면 워커가 소유 회원을
//     알 수 없어 "email factor required" 로 거절했다.
//  2. 비회원·이메일 없음은 기존처럼 거절되고, 화면에는 한글 이메일 입력 안내가 뜬다.
//  3. 회원 이메일이 있으면 주문서 이메일 칸을 미리 채운다.
//  4. 중복 주문(duplicate_order)은 영문 코드 대신 한글 안내와 기존 주문 버튼.
//  5. 가격 공개 상품 상세의 주 버튼은 "바로 구매", 견적 요청은 보조.
//
// 실제 cgi-order.js 를 작은 가짜 DOM 위에서 실행하고, 실제 제출·클릭 핸들러를
// 호출해 어느 경로로 요청이 나갔는지와 화면 문구를 확인한다.
//
//   node --test site/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORDER_SRC = readFileSync(join(HERE, '..', 'assets', 'js', 'cgi-order.js'), 'utf8');
const CATALOG_SRC = readFileSync(join(HERE, '..', 'assets', 'js', 'cgi-catalog.js'), 'utf8');
const API = 'https://cgi-quote-api.example.workers.dev';

const PRODUCT = {
  id: 'samamusic.co.kr:2574', name: 'SHURE RMCE-TW2', brand: 'SHURE', category: '이어폰',
  images: [], price: { state: 'public', value: 368000 },
};
const ORDER = {
  id: 'CGI-20261120-0001', kind: 'purchase', status: 'awaiting_payment',
  customer: { email: '' },
  totals: { total_amount: 368000, item_total: 368000, shipping_fee: 0, supplied_amount: 334546, vat_amount: 33454 },
};

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

function element(selector, root) {
  const listeners = {};
  return {
    querySelector: (sel) => root.querySelector(sel),
    selector, value: '', checked: false, disabled: false, textContent: '', innerHTML: '',
    listeners,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type, ev = {}) { for (const fn of listeners[type] || []) fn({ preventDefault() {}, ...ev }); },
  };
}

/** One element per selector, kept across re-renders: enough for the handlers under test. */
function makeApp() {
  const memo = new Map();
  const app = {
    innerHTML: '',
    querySelector(sel) {
      if (!memo.has(sel)) memo.set(sel, element(sel, this));
      return memo.get(sel);
    },
    el(sel) { return this.querySelector(sel); },
  };
  return app;
}

function response(ok, status, data) {
  return { ok, status, json: async () => data };
}

function boot({ member = null, createResult, windowResult }) {
  const fetchCalls = [];
  const sessionCalls = [];
  const store = new Map([['cgiQuoteCart', JSON.stringify([{ id: PRODUCT.id, qty: 1 }])]]);
  const answer = (method, path) => {
    if (path === '/api/payments/config') return { ok: true, status: 200, data: { provider: 'nicepay', mode: 'mock' } };
    if (path === '/api/shop/config') return { ok: true, status: 200, data: { shipping_fee_default: 0 } };
    if (path === '/api/me/orders' || path === '/api/orders') return createResult;
    if (path === '/api/payments/nicepay/window') return windowResult;
    return { ok: false, status: 404, data: { error: 'not found' } };
  };
  const window = {
    CGI_SITE_CONFIG: { orderApiUrl: API, pgProvider: 'nicepay' },
    CGI_PRODUCTS: [PRODUCT],
    CGI_SERVICES: [],
    AUTHNICE: { requests: [], requestPay(req) { this.requests.push(req); } },
    CGI_AUTH: {
      isLoggedIn: () => !!member,
      me: () => member,
      api(method, path, body) {
        sessionCalls.push({ method, path, body });
        return Promise.resolve(answer(method, path));
      },
    },
  };
  const context = {
    window,
    document: { head: { appendChild() {} }, createElement: () => ({}), title: '' },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    fetch(url, init = {}) {
      const path = String(url).slice(API.length).split('?')[0];
      fetchCalls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : null, credentials: init.credentials });
      const r = answer(init.method, path);
      return Promise.resolve(response(r.ok, r.status, r.data));
    },
    URLSearchParams, Promise, JSON, Math, Date, Number, String, Array, Object, setTimeout, clearTimeout, console,
  };
  window.localStorage = context.localStorage;
  vm.createContext(context);
  vm.runInContext(ORDER_SRC, context);
  return { order: window.CGI_ORDER, fetchCalls, sessionCalls, window, store };
}

async function submitCheckout(env, app, { email = '' } = {}) {
  env.order.renderCheckout(app);
  await flush();
  app.el('[name="company"]').value = '(주)시험';
  app.el('[name="name"]').value = '홍길동';
  app.el('[name="phone"]').value = '010-0000-0000';
  if (email !== null) app.el('[name="email"]').value = email;
  app.el('[name="terms_consent"]').checked = true;
  app.el('[name="privacy_consent"]').checked = true;
  app.el('#orderForm').fire('submit');
  await flush();
}

test('회원·이메일 없음: 결제창 요청이 회원 세션(CGI_AUTH.api)으로 나가 성공한다', async () => {
  const env = boot({
    member: { id: 7, email: '' },
    createResult: { ok: true, status: 201, data: ORDER },
    windowResult: { ok: true, status: 200, data: { sdkUrl: 'mock://nicepay-window', request: { orderId: ORDER.id, amount: 368000 } } },
  });
  const app = makeApp();
  await submitCheckout(env, app, { email: '' });
  assert.ok(env.sessionCalls.some((c) => c.path === '/api/me/orders'), 'the member order goes through the session');
  app.el('#payBtn').fire('click');
  await flush();
  const viaSession = env.sessionCalls.filter((c) => c.path === '/api/payments/nicepay/window');
  const viaPlain = env.fetchCalls.filter((c) => c.path === '/api/payments/nicepay/window');
  assert.equal(viaSession.length, 1, 'window request uses the member session');
  assert.equal(viaPlain.length, 0, 'no session-less window request');
  assert.equal(viaSession[0].body.orderId, ORDER.id);
  assert.equal(env.window.AUTHNICE.requests.length, 1, 'the payment window opened');
  assert.doesNotMatch(app.el('#paymentStatus').innerHTML, /결제창을 열 수 없습니다/);
});

test('비회원·이메일 없음: 기존처럼 거절되고 한글 이메일 입력 안내가 뜬다', async () => {
  const env = boot({
    member: null,
    createResult: { ok: true, status: 201, data: ORDER },
    windowResult: { ok: false, status: 403, data: { error: 'email factor required', detail: '주문 이메일 확인이 필요합니다.' } },
  });
  const app = makeApp();
  await submitCheckout(env, app, { email: '' });
  app.el('#payBtn').fire('click');
  await flush();
  const plain = env.fetchCalls.filter((c) => c.path === '/api/payments/nicepay/window');
  assert.equal(plain.length, 1, 'a guest has no session to send');
  assert.equal(env.sessionCalls.length, 0);
  const msg = app.el('#paymentStatus').innerHTML;
  assert.match(msg, /결제창을 열 수 없습니다/);
  assert.match(msg, /이메일을 입력/);
  assert.match(msg, /회원으로 로그인/);
  assert.doesNotMatch(msg, /email factor required/);
  assert.equal(env.window.AUTHNICE.requests.length, 0);
});

test('회원 이메일이 있으면 주문서 이메일 칸을 미리 채운다', async () => {
  const env = boot({ member: { id: 7, email: 'member@example.com' }, createResult: { ok: true, status: 201, data: ORDER }, windowResult: { ok: true, status: 200, data: {} } });
  const app = makeApp();
  env.order.renderCheckout(app);
  assert.equal(app.el('[name="email"]').value, 'member@example.com');
});

test('중복 주문: 영문 코드 대신 한글 안내와 기존 주문 상세 버튼', async () => {
  const env = boot({
    member: null,
    createResult: { ok: false, status: 409, data: { error: 'duplicate_order', existing_id: 'CGI-20261120-0009', detail: 'same cart was ordered recently' } },
    windowResult: { ok: true, status: 200, data: {} },
  });
  const app = makeApp();
  await submitCheckout(env, app, { email: 'guest@example.com' });
  const html = app.el('#orderStatus').innerHTML;
  assert.match(html, /방금 같은 주문이 접수되었습니다\. 주문 상세에서 결제를 계속하세요\./);
  assert.match(html, /href="#\/order\/CGI-20261120-0009"/);
  assert.doesNotMatch(html, /duplicate_order/);
  assert.doesNotMatch(html, /주문 생성 실패/);
  assert.equal(env.store.get('cgiOrderEmail:CGI-20261120-0009'), 'guest@example.com', 'the detail page can show the guest order');
});

test('주문 상세·승인 조회도 회원이면 세션으로 조회한다', async () => {
  const env = boot({ member: { id: 7, email: '' }, createResult: { ok: true, status: 201, data: ORDER }, windowResult: { ok: true, status: 200, data: {} } });
  const app = makeApp();
  env.order.renderOrderDetail(app, ORDER.id);
  await flush();
  assert.ok(env.sessionCalls.some((c) => c.method === 'GET' && c.path.startsWith('/api/orders/' + ORDER.id)));
  assert.equal(env.fetchCalls.filter((c) => c.path.startsWith('/api/orders/')).length, 0);
});

test('가격 공개 상품 상세: 주 버튼은 바로 구매, 견적 요청은 보조, 가격 문의는 그대로', () => {
  const block = CATALOG_SRC.slice(CATALOG_SRC.indexOf('function renderDetailBody'), CATALOG_SRC.indexOf('function renderQuote('));
  assert.match(block, /price\.inquiry\s*\?\s*'<button type="button" class="btn btn-primary btn-lg" data-action="quote-now"[^']*'[^:]*견적 요청하기/);
  assert.match(block, /class="btn btn-primary btn-lg" data-action="buy-now"[^>]*>바로 구매</);
  assert.match(block, /class="btn btn-secondary" data-action="quote-now"[^>]*>견적 요청하기</);
  assert.match(block, /data-action="buy-now"[^>]*>바로 구매<\/button>'\)/, 'mobile bar also leads with 바로 구매');
  const handler = CATALOG_SRC.slice(CATALOG_SRC.indexOf("action === 'buy-now'"), CATALOG_SRC.indexOf("action === 'quote-now'"));
  assert.match(handler, /addToQuoteCart\(productId, readDetailQty\(\), true\)/);
  assert.match(handler, /navigate\('#\/checkout'\)/);
});
