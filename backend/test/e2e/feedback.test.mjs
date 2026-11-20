// 운영센터 E2E: 의견 보내기 → 받은함 → 상태·답글·메모 → 내 의견 → 새 소식.
// Worker fetch 핸들러를 D1 shim 위에서 그대로 돌린다(네트워크·실결제 없음).
//
//   node --test --experimental-sqlite test/e2e/feedback.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../../worker.js';
import { openD1 } from '../../d1-shim.mjs';

const ORIGIN = 'https://skerishkang.github.io';
const ADMIN_TOKEN = 'example-admin-token';
const LOGIN_PW = 'feedback-login-fixture-2026';
const SUPERADMIN = 'skerish@naver.com';
const CSRF = { Origin: ORIGIN, 'X-CSRF-Token': ORIGIN };
const BEARER = { Authorization: `Bearer ${ADMIN_TOKEN}` };

function env(overrides = {}) {
  return {
    DB: openD1(),
    ADMIN_TOKEN,
    PG_PROVIDER_MODE: 'mock',
    ERP_LIVE_WRITE: 'NO',
    ERP_MODE: 'test',
    SHIPPING_FEE_DEFAULT: '0',
    MAIL_MODE: 'echo',
    AUTH_PBKDF2_ITERATIONS: '1000',
    AUTH_RATE_LIMIT_MAX: '100000',
    AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
    CORS_ALLOWED_ORIGINS: ORIGIN,
    ...overrides,
  };
}

async function call(environment, method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const response = await worker.fetch(new Request(`http://cgi.local${path}`, init), environment);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: response.status, json, text };
}

async function memberCookie(environment, email, name = '회원') {
  const signup = await call(environment, 'POST', '/api/auth/signup', {
    email, name, password: LOGIN_PW,
    terms: true, privacy: true, terms_version: 'draft-2026-10-28', privacy_version: 'draft-2026-10-28',
  }, CSRF);
  assert.equal(signup.status, 201, signup.text);
  const verify = await call(environment, 'POST', '/api/auth/verify-email', {
    member_id: signup.json.member.id, token: signup.json.mail.echo_token,
  }, CSRF);
  assert.equal(verify.status, 200, verify.text);
  const response = await worker.fetch(new Request('http://cgi.local/api/auth/login', {
    method: 'POST',
    headers: { ...CSRF, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: LOGIN_PW }),
  }), environment);
  assert.equal(response.status, 200);
  return { cookie: response.headers.get('set-cookie'), id: signup.json.member.id };
}

function send(environment, body, headers = {}) {
  return call(environment, 'POST', '/api/feedback', body, { Origin: ORIGIN, ...headers });
}

test('guest feedback is accepted with a receipt number and lands in the inbox', async () => {
  const e = env();
  const r = await send(e, {
    kind: 'bug', body: '견적 목록에서 수량이 안 바뀝니다.',
    page_url: 'https://cgishop.pages.dev/site/index.html#/quote-cart', contact_email: 'guest@example.com',
  });
  assert.equal(r.status, 201, r.text);
  assert.match(r.json.id, /^FB-\d{6}-[A-Z2-9]{6}$/);
  assert.equal(r.json.status, 'received');
  assert.equal(r.json.member_linked, false);

  const list = await call(e, 'GET', '/api/admin/feedback', null, BEARER);
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.total, 1);
  const item = list.json.items[0];
  assert.equal(item.id, r.json.id);
  assert.equal(item.kind_label, '불편·오류');
  assert.equal(item.status_label, '접수');
  assert.equal(item.contact_email_masked, 'gu***@ex***.com');
  assert.ok(!list.text.includes('guest@example.com'), '목록 응답에 원문 이메일이 없어야 한다');

  const detail = await call(e, 'GET', `/api/admin/feedback/${r.json.id}`, null, BEARER);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.feedback.contact_email, 'guest@example.com');
  assert.equal(detail.json.feedback.page_url, 'https://cgishop.pages.dev/site/index.html#/quote-cart');
});

test('page url falls back to the Referer header', async () => {
  const e = env();
  const r = await send(e, { kind: 'other', body: '리퍼러 확인' }, { Referer: 'https://cgishop.pages.dev/site/returns.html' });
  assert.equal(r.status, 201);
  const detail = await call(e, 'GET', `/api/admin/feedback/${r.json.id}`, null, BEARER);
  assert.equal(detail.json.feedback.page_url, 'https://cgishop.pages.dev/site/returns.html');
});

test('validation: kind, empty body, 2,000 chars, 3 links, non-JSON', async () => {
  const e = env();
  assert.equal((await send(e, { kind: 'x', body: 'a' })).status, 400);
  assert.equal((await send(e, { kind: 'bug', body: '' })).status, 400);
  assert.equal((await send(e, { kind: 'bug', body: '가'.repeat(2001) })).status, 400);
  const links = await send(e, { kind: 'other', body: 'https://a.com https://b.com https://c.com' });
  assert.equal(links.status, 400);
  assert.equal(links.json.error, 'too many links');
  const form = await call(e, 'POST', '/api/feedback', 'kind=bug&body=x', { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(form.status, 415);
  assert.equal((await send(e, { kind: 'bug', body: '가'.repeat(2000) })).status, 201);
});

test('same source + same content is refused for a short while; other content passes', async () => {
  const e = env();
  const ip = { 'CF-Connecting-IP': '203.0.113.7' };
  assert.equal((await send(e, { kind: 'idea', body: '비교 기능 부탁드려요' }, ip)).status, 201);
  const again = await send(e, { kind: 'idea', body: '  비교   기능 부탁드려요 ' }, ip);
  assert.equal(again.status, 429);
  assert.equal(again.json.error, 'duplicate feedback');
  assert.equal((await send(e, { kind: 'idea', body: '다른 내용입니다' }, ip)).status, 201);
  // 다른 출처의 같은 내용은 막지 않는다.
  assert.equal((await send(e, { kind: 'idea', body: '비교 기능 부탁드려요' }, { 'CF-Connecting-IP': '198.51.100.2' })).status, 201);
});

test('one source address is capped at 10 submissions per window', async () => {
  const e = env();
  const ip = { 'CF-Connecting-IP': '203.0.113.99' };
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await send(e, { kind: 'other', body: `반복 ${i}` }, ip)).status, 201, `#${i}`);
  }
  const blocked = await send(e, { kind: 'other', body: '열한 번째' }, ip);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error, 'rate limited');
});

test('signed-in member is linked and sees status + reply (never the internal note)', async () => {
  const e = env();
  const { cookie, id } = await memberCookie(e, 'member1@example.com', '일반회원');
  const r = await send(e, { kind: 'product', body: '이 스피커 단가 문의드립니다' }, { ...CSRF, Cookie: cookie });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.member_linked, true);

  // 쿠키만 있고 CSRF 헤더가 없으면 비회원 접수로 처리한다(접수 자체는 됨).
  const noCsrf = await send(e, { kind: 'product', body: 'CSRF 없는 접수' }, { Cookie: cookie });
  assert.equal(noCsrf.status, 201);
  assert.equal(noCsrf.json.member_linked, false);

  const patch = await call(e, 'PATCH', `/api/admin/feedback/${r.json.id}`, {
    status: 'answered', admin_reply: '견적 메일로 보내드렸습니다.', admin_note: '대리점가 확인 필요', issue_ref: '231',
  }, BEARER);
  assert.equal(patch.status, 200, patch.text);
  assert.equal(patch.json.feedback.status, 'answered');
  assert.equal(patch.json.feedback.issue_ref, '#231');
  assert.equal(patch.json.feedback.admin_note, '대리점가 확인 필요');

  const mine = await call(e, 'GET', '/api/me/feedback', null, { ...CSRF, Cookie: cookie });
  assert.equal(mine.status, 200, mine.text);
  assert.equal(mine.json.items.length, 1, '내 의견에는 회원으로 연결된 것만');
  const row = mine.json.items[0];
  assert.equal(row.id, r.json.id);
  assert.equal(row.status, 'answered');
  assert.equal(row.status_label, '답변 완료');
  assert.equal(row.admin_reply, '견적 메일로 보내드렸습니다.');
  assert.ok(!mine.text.includes('대리점가 확인 필요'), '내부 메모는 고객에게 보이지 않는다');
  assert.ok(!mine.text.includes('#231'), '이슈 번호도 고객 화면에 싣지 않는다');
  assert.ok(id > 0);

  const anon = await call(e, 'GET', '/api/me/feedback', null, CSRF);
  assert.equal(anon.status, 401);
});

test('ops center is admin-only: anon and plain members get 401, superadmin session passes', async () => {
  const e = env();
  const r = await send(e, { kind: 'bug', body: '권한 시험' });
  assert.equal((await call(e, 'GET', '/api/admin/feedback', null, { Origin: ORIGIN })).status, 401);
  assert.equal((await call(e, 'GET', `/api/admin/feedback/${r.json.id}`, null, { Origin: ORIGIN })).status, 401);
  assert.equal((await call(e, 'PATCH', `/api/admin/feedback/${r.json.id}`, { status: 'fixed' }, { Origin: ORIGIN })).status, 401);
  assert.equal((await call(e, 'GET', '/api/admin/feedback', null, { Authorization: 'Bearer wrong' })).status, 401);

  const member = await memberCookie(e, 'plain@example.com');
  assert.equal((await call(e, 'GET', '/api/admin/feedback', null, { ...CSRF, Cookie: member.cookie })).status, 401);
  assert.equal((await call(e, 'PATCH', `/api/admin/feedback/${r.json.id}`, { status: 'fixed' }, { ...CSRF, Cookie: member.cookie })).status, 401);

  const sa = await memberCookie(e, SUPERADMIN, '총관리자');
  assert.equal((await call(e, 'GET', '/api/admin/feedback', null, { Cookie: sa.cookie })).status, 401, 'CSRF 헤더 없는 쿠키 호출은 거절');
  const ok = await call(e, 'GET', '/api/admin/feedback', null, { ...CSRF, Cookie: sa.cookie });
  assert.equal(ok.status, 200, ok.text);
  const fix = await call(e, 'PATCH', `/api/admin/feedback/${r.json.id}`, { status: 'fixed' }, { ...CSRF, Cookie: sa.cookie });
  assert.equal(fix.status, 200, fix.text);
  assert.equal(fix.json.feedback.status_label, '고침');

  assert.equal((await call(e, 'PATCH', '/api/admin/feedback/FB-000000-NOPE00', { status: 'fixed' }, BEARER)).status, 404);
  assert.equal((await call(e, 'PATCH', `/api/admin/feedback/${r.json.id}`, { status: 'done' }, BEARER)).status, 400);
});

test('AI honorary members: persona emails are flagged, admin can set or clear, inbox filters', async () => {
  const e = env({ AI_MEMBER_PERSONAS: 'limone@example.com:리모네' });
  const ai = await send(e, { kind: 'idea', body: '검색 결과에 브랜드 필터가 있으면 좋아요', contact_email: 'Limone@example.com' });
  const human = await send(e, { kind: 'bug', body: '사람이 보낸 의견' });
  assert.equal(ai.status, 201);

  const all = await call(e, 'GET', '/api/admin/feedback', null, BEARER);
  const aiRow = all.json.items.find((x) => x.id === ai.json.id);
  assert.equal(aiRow.ai_member, '리모네');
  assert.equal(aiRow.ai_member_label, 'AI 명예회원 리모네');

  const onlyAi = await call(e, 'GET', '/api/admin/feedback?ai=only', null, BEARER);
  assert.deepEqual(onlyAi.json.items.map((x) => x.id), [ai.json.id]);

  const set = await call(e, 'PATCH', `/api/admin/feedback/${human.json.id}`, { ai_member: '코드리뷰어' }, BEARER);
  assert.equal(set.json.feedback.ai_member_label, 'AI 명예회원 코드리뷰어');
  const cleared = await call(e, 'PATCH', `/api/admin/feedback/${human.json.id}`, { ai_member: null }, BEARER);
  assert.equal(cleared.json.feedback.ai_member, null);
});

test('inbox filters by kind and status, searches text, newest first', async () => {
  const e = env();
  const a = await send(e, { kind: 'bug', body: '첫 번째 결제 화면 오류' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const b = await send(e, { kind: 'idea', body: '두 번째 제안 위시리스트' });
  await call(e, 'PATCH', `/api/admin/feedback/${a.json.id}`, { status: 'checking' }, BEARER);

  const all = await call(e, 'GET', '/api/admin/feedback', null, BEARER);
  assert.deepEqual(all.json.items.map((x) => x.id), [b.json.id, a.json.id], '최신순');
  const bugs = await call(e, 'GET', '/api/admin/feedback?kind=bug', null, BEARER);
  assert.deepEqual(bugs.json.items.map((x) => x.id), [a.json.id]);
  const checking = await call(e, 'GET', '/api/admin/feedback?status=checking', null, BEARER);
  assert.deepEqual(checking.json.items.map((x) => x.id), [a.json.id]);
  const search = await call(e, 'GET', '/api/admin/feedback?q=' + encodeURIComponent('위시리스트'), null, BEARER);
  assert.deepEqual(search.json.items.map((x) => x.id), [b.json.id]);
  const pct = await call(e, 'GET', '/api/admin/feedback?q=%25', null, BEARER);
  assert.equal(pct.json.items.length, 0, '% 는 와일드카드가 아니라 글자로 찾는다');
});

test('news: drafts stay private, publishing shows grouped source only, admin-only writes', async () => {
  const e = env();
  assert.equal((await call(e, 'POST', '/api/admin/news', { title: 't', body: 'b', source_tag: 'ai_member' }, { Origin: ORIGIN })).status, 401);
  const draft = await call(e, 'POST', '/api/admin/news', {
    title: '검색 정확도 개선', body: '브랜드명으로 찾을 때 비슷한 상품이 먼저 나옵니다.', source_tag: 'ai_member',
  }, BEARER);
  assert.equal(draft.status, 201, draft.text);
  assert.equal(draft.json.news.published, false);

  let pub = await call(e, 'GET', '/api/news', null, { Origin: ORIGIN });
  assert.equal(pub.status, 200);
  assert.equal(pub.json.items.length, 0, '초안은 공개되지 않는다');

  const published = await call(e, 'PATCH', `/api/admin/news/${draft.json.news.id}`, { published: true }, BEARER);
  assert.equal(published.status, 200, published.text);
  assert.ok(published.json.news.published_at);
  await call(e, 'POST', '/api/admin/news', { title: '수량 버튼 수정', body: '견적 목록 수량이 바로 바뀝니다.', source_tag: 'user_feedback', published: true }, BEARER);

  pub = await call(e, 'GET', '/api/news', null, { Origin: ORIGIN });
  assert.equal(pub.json.items.length, 2);
  assert.deepEqual(pub.json.items.map((x) => x.source_label).sort(), ['AI 명예회원이 알려 준 것', '사용자 의견으로 고친 것']);
  for (const item of pub.json.items) {
    assert.deepEqual(Object.keys(item).sort(), ['body', 'id', 'published_at', 'source_label', 'source_tag', 'title']);
  }

  const unpub = await call(e, 'PATCH', `/api/admin/news/${draft.json.news.id}`, { published: false }, BEARER);
  assert.equal(unpub.json.news.published, false);
  assert.equal((await call(e, 'GET', '/api/news')).json.items.length, 1);
  assert.equal((await call(e, 'PATCH', '/api/admin/news/9999', { title: 'x' }, BEARER)).status, 404);
  assert.equal((await call(e, 'POST', '/api/admin/news', { title: 't', body: 'b', source_tag: 'person' }, BEARER)).status, 400);
  const adminList = await call(e, 'GET', '/api/admin/news', null, BEARER);
  assert.equal(adminList.json.items.length, 2);
});
