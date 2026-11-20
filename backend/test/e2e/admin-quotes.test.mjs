// 관리자 정식 견적서 E2E: 권한 · 번호 발급 · 공개가 확정 · 목록/검색 · 고치기 · 상태 · 복제 · 최근 받는 곳.
// Worker fetch 핸들러를 D1 shim 위에서 그대로 돌린다(네트워크 없음).

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../../worker.js';
import { openD1 } from '../../d1-shim.mjs';
import { PRICE_INDEX } from '../../data/price_index.mjs';

const ORIGIN = 'https://skerishkang.github.io';
const ADMIN_TOKEN = 'example-admin-token';
const PW = 'admin-quotes-login-fixture-2026';
const CSRF = { Origin: ORIGIN, 'X-CSRF-Token': ORIGIN };
const BEARER = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const [[PID, ENTRY], [PID2, ENTRY2]] = Object.entries(PRICE_INDEX).filter(([, e]) => e.p > 50_000).slice(0, 2);

function env() {
  return {
    DB: openD1(), ADMIN_TOKEN, PG_PROVIDER_MODE: 'mock', ERP_LIVE_WRITE: 'NO', ERP_MODE: 'test', SHIPPING_FEE_DEFAULT: '0',
    MAIL_MODE: 'echo', AUTH_PBKDF2_ITERATIONS: '1000', AUTH_RATE_LIMIT_MAX: '100000', AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
    CORS_ALLOWED_ORIGINS: ORIGIN,
  };
}

async function call(e, method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined && body !== null) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await worker.fetch(new Request(`http://cgi.local${path}`, init), e);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (err) { json = null; }
  return { status: res.status, json, text };
}

async function member(e, email, name) {
  const s = await call(e, 'POST', '/api/auth/signup', { email, name, password: PW, terms: true, privacy: true, terms_version: 'draft-2026-10-28', privacy_version: 'draft-2026-10-28' }, CSRF);
  assert.equal(s.status, 201, s.text);
  await call(e, 'POST', '/api/auth/verify-email', { member_id: s.json.member.id, token: s.json.mail.echo_token }, CSRF);
  const res = await worker.fetch(new Request('http://cgi.local/api/auth/login', {
    method: 'POST', headers: { ...CSRF, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PW }),
  }), e);
  assert.equal(res.status, 200);
  return { id: s.json.member.id, h: { ...CSRF, Cookie: res.headers.get('set-cookie') } };
}

const BODY = {
  recipient: { company: '광주○○초등학교 행정실', name: '김행정', phone: '062-000-0000', email: 'office@example.com', memo: '강당 2층' },
  valid_days: 30,
  delivery_terms: '발주 후 2주 이내 설치',
  payment_terms: '설치 완료 후 30일 이내',
  items: [
    { kind: 'product', product_id: PID, qty: 2, unit_price: 1, discount_type: 'pct', discount_value: 10, memo: '강당용' },
    { kind: 'product', product_id: 'samamusic.co.kr:117', name: 'PRESONUS StudioLive RM32 AI', qty: 1, unit_price: 4_950_000 },
    { kind: 'custom', name: '설치비', spec: '배선 포함', qty: 1, unit_price: 500_000, discount_type: 'amount', discount_value: 50_000 },
    { kind: 'custom', name: '출장비', qty: 1 },
  ],
};

test('only admins (token or admin session) can use the quote API; customers and guests get 401', async () => {
  const e = env();
  assert.equal((await call(e, 'GET', '/api/admin/quotes', null, { Origin: ORIGIN })).status, 401);
  assert.equal((await call(e, 'POST', '/api/admin/quotes', BODY, { Origin: ORIGIN })).status, 401);
  const customer = await member(e, 'customer.one@cgi-test.kr', '일반고객');
  assert.equal((await call(e, 'GET', '/api/admin/quotes', null, customer.h)).status, 401);
  assert.equal((await call(e, 'GET', '/api/admin/quotes/recipients', null, customer.h)).status, 401);
  const admin = await member(e, 'skerish@naver.com', '운영자');
  const made = await call(e, 'POST', '/api/admin/quotes', BODY, admin.h);
  assert.equal(made.status, 201, made.text);
  assert.match(made.json.quote.created_by, /\*/, 'creator is stored as a masked label');
  assert.equal((await call(e, 'GET', `/api/admin/quotes/${made.json.quote.id}`, null, customer.h)).status, 401);
  // 쿠키만 있고 CSRF 머리글이 없으면 거절
  assert.equal((await call(e, 'GET', '/api/admin/quotes', null, { Cookie: admin.h.Cookie })).status, 401);
});

test('a new quote gets a server number, catalog prices from the index, and server-computed totals', async () => {
  const e = env();
  const r = await call(e, 'POST', '/api/admin/quotes', BODY, BEARER);
  assert.equal(r.status, 201, r.text);
  const q = r.json.quote;
  assert.match(q.quote_no, /^Q-\d{6}-001$/);
  assert.equal(q.status, 'draft');
  assert.equal(q.valid_days, 30);
  assert.equal(q.ecount_status, 'not_sent');
  const [a, b, c, d] = q.items;
  assert.equal(a.unit_price, ENTRY.p, 'the screen-sent price 1 is ignored for a catalog item');
  assert.equal(a.unit_source, 'catalog');
  assert.equal(a.discount_amount, Math.round(ENTRY.p * 2 * 0.1));
  assert.equal(b.unit_source, 'manual');
  assert.equal(c.total_amount, 450_000);
  assert.equal(d.unit_source, 'inquiry');
  assert.equal(d.total_amount, null);
  const expected = ENTRY.p * 2 - Math.round(ENTRY.p * 2 * 0.1) + 4_950_000 + 450_000;
  assert.equal(q.total_amount, expected);
  assert.equal(q.supplied_amount + q.vat_amount, q.total_amount);
  assert.equal(q.inquiry_count, 1);
  const lineSum = q.items.filter((it) => it.total_amount != null).reduce((s, it) => s + it.supplied_amount, 0);
  assert.equal(lineSum, q.supplied_amount, 'line supplied amounts add up to the total row');
  // 같은 날 두 번째는 002
  const second = await call(e, 'POST', '/api/admin/quotes', { ...BODY, recipient: { company: '○○교회' } }, BEARER);
  assert.match(second.json.quote.quote_no, /-002$/);
  // 번호 형식이 같은 날짜로 시작
  assert.equal(second.json.quote.quote_no.slice(0, 9), q.quote_no.slice(0, 9));
});

test('validation errors come back as 400 with a Korean detail and nothing is stored', async () => {
  const e = env();
  const r = await call(e, 'POST', '/api/admin/quotes', { ...BODY, recipient: { company: '' } }, BEARER);
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'recipient_company_required');
  assert.match(r.json.detail, /받는 곳/);
  const r2 = await call(e, 'POST', '/api/admin/quotes', { ...BODY, items: [{ kind: 'custom', name: 'x', qty: 1, unit_price: 100, discount_type: 'pct', discount_value: 120 }] }, BEARER);
  assert.equal(r2.status, 400);
  assert.equal((await call(e, 'GET', '/api/admin/quotes', null, BEARER)).json.quotes.length, 0);
});

test('list searches number, company and contact; filters by status; newest first', async () => {
  const e = env();
  const a = (await call(e, 'POST', '/api/admin/quotes', BODY, BEARER)).json.quote;
  const b = (await call(e, 'POST', '/api/admin/quotes', { ...BODY, status: 'sent', recipient: { company: '○○교회', name: '박집사' } }, BEARER)).json.quote;
  const all = (await call(e, 'GET', '/api/admin/quotes', null, BEARER)).json.quotes;
  assert.deepEqual(all.map((q) => q.id), [b.id, a.id]);
  assert.equal(all[0].items, undefined, 'the list carries no item lines');
  assert.deepEqual((await call(e, 'GET', `/api/admin/quotes?q=${encodeURIComponent('교회')}`, null, BEARER)).json.quotes.map((q) => q.id), [b.id]);
  assert.deepEqual((await call(e, 'GET', `/api/admin/quotes?q=${encodeURIComponent('김행정')}`, null, BEARER)).json.quotes.map((q) => q.id), [a.id]);
  assert.deepEqual((await call(e, 'GET', `/api/admin/quotes?q=${a.quote_no}`, null, BEARER)).json.quotes.map((q) => q.id), [a.id]);
  assert.deepEqual((await call(e, 'GET', '/api/admin/quotes?status=sent', null, BEARER)).json.quotes.map((q) => q.id), [b.id]);
  assert.equal((await call(e, 'GET', `/api/admin/quotes?q=${encodeURIComponent('100%')}`, null, BEARER)).json.quotes.length, 0, '% is matched literally');
});

test('a full edit keeps the number and date, recomputes totals and valid-until; a status-only patch changes status', async () => {
  const e = env();
  const q = (await call(e, 'POST', '/api/admin/quotes', BODY, BEARER)).json.quote;
  const edited = await call(e, 'PATCH', `/api/admin/quotes/${q.id}`, {
    ...BODY, valid_days: 7, items: [{ kind: 'product', product_id: PID2, qty: 3 }, { kind: 'custom', name: '공사비', qty: 1, unit_price: 1_000_000 }],
  }, BEARER);
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.json.quote.quote_no, q.quote_no);
  assert.equal(edited.json.quote.quote_date, q.quote_date);
  assert.equal(edited.json.quote.items.length, 2);
  assert.equal(edited.json.quote.total_amount, ENTRY2.p * 3 + 1_000_000);
  const d = new Date(`${q.quote_date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 7);
  assert.equal(edited.json.quote.valid_until, d.toISOString().slice(0, 10));
  for (const status of ['sent', 'won', 'canceled', 'draft']) {
    const s = await call(e, 'PATCH', `/api/admin/quotes/${q.id}`, { status }, BEARER);
    assert.equal(s.status, 200);
    assert.equal(s.json.quote.status, status);
  }
  assert.equal((await call(e, 'PATCH', `/api/admin/quotes/${q.id}`, { status: 'paid' }, BEARER)).status, 400);
  assert.equal((await call(e, 'PATCH', '/api/admin/quotes/9999', { status: 'sent' }, BEARER)).status, 404);
  assert.equal((await call(e, 'GET', '/api/admin/quotes/9999', null, BEARER)).status, 404);
});

test('duplicate makes a new draft with a new number, same recipient and lines, linked to the source', async () => {
  const e = env();
  const q = (await call(e, 'POST', '/api/admin/quotes', { ...BODY, status: 'won' }, BEARER)).json.quote;
  const dup = await call(e, 'POST', `/api/admin/quotes/${q.id}/duplicate`, null, BEARER);
  assert.equal(dup.status, 201, dup.text);
  const c = dup.json.quote;
  assert.notEqual(c.quote_no, q.quote_no);
  assert.equal(c.status, 'draft');
  assert.equal(c.source_quote_id, q.id);
  assert.deepEqual(c.recipient, q.recipient);
  assert.equal(c.items.length, q.items.length);
  assert.equal(c.total_amount, q.total_amount);
  assert.equal(c.items[0].unit_price, ENTRY.p);
  assert.equal((await call(e, 'POST', '/api/admin/quotes/9999/duplicate', null, BEARER)).status, 404);
});

test('recent recipients are grouped and newest first', async () => {
  const e = env();
  await call(e, 'POST', '/api/admin/quotes', BODY, BEARER);
  await call(e, 'POST', '/api/admin/quotes', BODY, BEARER);
  await call(e, 'POST', '/api/admin/quotes', { ...BODY, recipient: { company: '○○교회', name: '박집사' } }, BEARER);
  const r = await call(e, 'GET', '/api/admin/quotes/recipients', null, BEARER);
  assert.equal(r.status, 200);
  assert.equal(r.json.recipients.length, 2);
  assert.equal(r.json.recipients[0].company, '○○교회');
  assert.equal(r.json.recipients[1].uses, 2);
  assert.equal(r.json.recipients[1].email, 'office@example.com');
});

test('the public shop quote request API is unchanged and never lists admin quotes', async () => {
  const e = env();
  await call(e, 'POST', '/api/admin/quotes', BODY, BEARER);
  const list = await call(e, 'GET', '/api/quotes', null, BEARER);
  assert.equal(list.status, 200);
  assert.equal(list.json.items.length, 0);
});
