// 운영센터 정렬(러브트리 운영센터와 같은 구성) E2E:
// AI 명예회원 역할 · 사용 일지 · 고객 덧붙이기 · 한눈에 숫자 · 고객 탭(열람 기록 90일) · 알림 규칙.
// Worker fetch 핸들러를 D1 shim 위에서 그대로 돌린다(네트워크·실결제 없음, 알림은 가짜 fetch 로 잡는다).
//
//   node --test --experimental-sqlite test/e2e/ops-center-align.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../../worker.js';
import { openD1 } from '../../d1-shim.mjs';
import { purgeExpiredCustomerViews } from '../../lib/ops-center.mjs';

const ORIGIN = 'https://skerishkang.github.io';
const ADMIN_TOKEN = 'example-admin-token';
const PW = 'ops-align-login-fixture-2026';
const CSRF = { Origin: ORIGIN, 'X-CSRF-Token': ORIGIN };
const BEARER = { Authorization: `Bearer ${ADMIN_TOKEN}` };

function env(overrides = {}) {
  return {
    DB: openD1(), ADMIN_TOKEN, PG_PROVIDER_MODE: 'mock', ERP_LIVE_WRITE: 'NO', ERP_MODE: 'test',
    SHIPPING_FEE_DEFAULT: '0', MAIL_MODE: 'echo', AUTH_PBKDF2_ITERATIONS: '1000',
    AUTH_RATE_LIMIT_MAX: '100000', AUTH_RATE_LIMIT_WINDOW_SECONDS: '60', CORS_ALLOWED_ORIGINS: ORIGIN,
    ...overrides,
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
  const cookie = res.headers.get('set-cookie');
  return { id: s.json.member.id, cookie, h: { ...CSRF, Cookie: cookie } };
}

async function makeAiMember(e, email = 'ai.one@cgi-test.kr', name = '리모네') {
  const m = await member(e, email, name);
  const r = await call(e, 'PATCH', `/api/admin/customers/${m.id}/role`, { role: 'ai_member' }, BEARER);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.customer.role, 'ai_member');
  return m;
}

function captureFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: init && init.body }); return { ok: true, status: 200, async text() { return '{}'; }, async json() { return {}; } }; };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('AI 명예회원 역할: 관리자만 지정, 관리자 계정은 잠금, /api/me 에 표시', async () => {
  const e = env();
  const m = await member(e, 'kim@cgi-test.kr', '김고객');
  assert.equal((await call(e, 'PATCH', `/api/admin/customers/${m.id}/role`, { role: 'ai_member' }, CSRF)).status, 401, '익명');
  assert.equal((await call(e, 'PATCH', `/api/admin/customers/${m.id}/role`, { role: 'ai_member' }, m.h)).status, 401, '일반 회원');
  assert.equal((await call(e, 'PATCH', `/api/admin/customers/${m.id}/role`, { role: 'admin' }, BEARER)).status, 400, '관리자 역할은 여기서 못 준다');
  const ok = await call(e, 'PATCH', `/api/admin/customers/${m.id}/role`, { role: 'ai_member' }, BEARER);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.customer.role_label, 'AI 명예회원');
  const me = await call(e, 'GET', '/api/me', null, m.h);
  assert.equal(me.json.member.role, 'ai_member');
  assert.equal(me.json.member.is_ai_member, true);
  assert.equal(me.json.member.is_admin, false, 'AI 명예회원은 관리자 권한이 없다');
  assert.equal((await call(e, 'GET', '/api/admin/feedback', null, m.h)).status, 401);

  const sa = await member(e, 'skerish@naver.com', '총관리자');
  const locked = await call(e, 'PATCH', `/api/admin/customers/${sa.id}/role`, { role: 'ai_member' }, BEARER);
  assert.equal(locked.status, 409);
  // 최고관리자 세션도 고객 탭 역할 지정을 할 수 있다.
  const back = await call(e, 'PATCH', `/api/admin/customers/${m.id}/role`, { role: 'member' }, sa.h);
  assert.equal(back.status, 200, back.text);
  assert.equal(back.json.customer.role, 'member');
});

test('사용 일지: AI 명예회원만, 하루 1건 · 같은 날 덧붙임 · 점수 1~5 · 8,000자 · 이메일·전화 가림 · 알림 없음', async () => {
  const e = env({
    MAIL_MODE: 'resend', B66_ALERT_RESEND_API_KEY: 're_fake_key_for_tests', ORDER_NOTIFY_TO: 'ops@cgi-test.kr',
    ORDER_NOTIFY_TELEGRAM_CHAT_IDS: '111', TELEGRAM_BOT_TOKEN: 'fake-token-for-tests',
  });
  const plain = await member(e, 'plain@cgi-test.kr', '일반');
  assert.equal((await call(e, 'POST', '/api/me/journal', { body: 'x' }, plain.h)).status, 403);
  assert.equal((await call(e, 'GET', '/api/me/journal', null, plain.h)).status, 403);
  const ai = await makeAiMember(e);

  const cap = captureFetch();
  let first;
  try {
    assert.equal((await call(e, 'POST', '/api/me/journal', { body: '', score: 3 }, ai.h)).status, 400);
    assert.equal((await call(e, 'POST', '/api/me/journal', { body: 'x', score: 6 }, ai.h)).status, 400);
    assert.equal((await call(e, 'POST', '/api/me/journal', { body: 'x', score: 2.5 }, ai.h)).status, 400);
    assert.equal((await call(e, 'POST', '/api/me/journal', { body: '가'.repeat(8001) }, ai.h)).status, 400);
    first = await call(e, 'POST', '/api/me/journal', { title: '첫 사용', body: '검색이 빨랐어요. 연락은 me@cgi-test.kr 또는 010-1234-5678', score: 4 }, ai.h);
    assert.equal(first.status, 201, first.text);
    assert.equal(first.json.appended, false);
    assert.ok(!first.text.includes('me@cgi-test.kr') && !first.text.includes('010-1234-5678'), '원문 개인정보가 남지 않는다');
    assert.match(first.json.journal.body, /\[이메일\].*\[전화번호\]/);
    assert.match(first.json.journal.journal_date, /^\d{4}-\d{2}-\d{2}$/);

    const second = await call(e, 'POST', '/api/me/journal', { body: '오후에 견적 목록도 써 봤어요.', score: 5 }, ai.h);
    assert.equal(second.status, 200, second.text);
    assert.equal(second.json.appended, true);
    assert.equal(second.json.journal.id, first.json.journal.id, '같은 날은 같은 일지');
    assert.match(second.json.journal.body, /검색이 빨랐어요[\s\S]*— 덧붙임 \d{2}:\d{2} —\n오후에 견적 목록도/);
    assert.equal(second.json.journal.score, 5);
    assert.equal(second.json.journal.title, '첫 사용');
    const keep = await call(e, 'POST', '/api/me/journal', { body: '점수 없이 한 줄 더' }, ai.h);
    assert.equal(keep.json.journal.score, 5, '점수를 비우면 앞의 점수를 둔다');
    const tooLong = await call(e, 'POST', '/api/me/journal', { body: '나'.repeat(7990) }, ai.h);
    assert.equal(tooLong.status, 400, '합쳐서 8,000자를 넘으면 거절');
  } finally {
    cap.restore();
  }
  assert.equal(cap.calls.length, 0, '일지는 알림을 보내지 않는다');

  const mine = await call(e, 'GET', '/api/me/journal', null, ai.h);
  assert.equal(mine.json.journal.id, first.json.journal.id);
  assert.equal(mine.json.items.length, 1);
  const rows = await e.DB.prepare('SELECT COUNT(*) AS n FROM feedback_journal').first();
  assert.equal(rows.n, 1);

  const admin = await call(e, 'GET', '/api/admin/journals', null, BEARER);
  assert.equal(admin.status, 200);
  assert.equal(admin.json.journals[0].customer, 'AI 명예회원 리모네');
  const note = await call(e, 'PATCH', `/api/admin/journals/${first.json.journal.id}`, { admin_note: '검색 칭찬 — 유지' }, BEARER);
  assert.equal(note.json.journal.admin_note, '검색 칭찬 — 유지');
  assert.ok(!(await call(e, 'GET', '/api/me/journal', null, ai.h)).text.includes('검색 칭찬'), '내부 메모는 고객에게 안 보인다');
  assert.equal((await call(e, 'GET', '/api/admin/journals', null, ai.h)).status, 401);
});

test('고객 덧붙이기: 본인 의견만 · 고치기 · 지우기(표시만 숨김) · 고침/닫음이면 확인 중으로 다시 열림 · 알림', async () => {
  const e = env({
    MAIL_MODE: 'resend', B66_ALERT_RESEND_API_KEY: 're_fake_key_for_tests', ORDER_NOTIFY_TO: 'ops@cgi-test.kr',
    ORDER_NOTIFY_TELEGRAM_CHAT_IDS: '111', TELEGRAM_BOT_TOKEN: 'fake-token-for-tests',
  });
  const a = await member(e, 'a@cgi-test.kr', '가');
  const b = await member(e, 'b@cgi-test.kr', '나');
  const fb = await call(e, 'POST', '/api/feedback', { kind: 'inconvenient', body: '장바구니 수량이 안 바뀌어요' }, a.h);
  assert.equal(fb.status, 201, fb.text);
  const guest = await call(e, 'POST', '/api/feedback', { kind: 'bug', body: '비회원 의견' }, { Origin: ORIGIN });
  await call(e, 'PATCH', `/api/admin/feedback/${fb.json.id}`, { status: 'fixed', admin_reply: '고쳤어요' }, BEARER);

  assert.equal((await call(e, 'POST', `/api/feedback/x`, null, a.h)).status, 404);
  assert.equal((await call(e, 'POST', `/api/me/feedback/${fb.json.id}/followup`, { body: '남의 글' }, b.h)).status, 404, '남의 의견');
  assert.equal((await call(e, 'POST', `/api/me/feedback/${guest.json.id}/followup`, { body: '비회원 글' }, a.h)).status, 404);
  assert.equal((await call(e, 'POST', `/api/me/feedback/${fb.json.id}/followup`, { body: '' }, a.h)).status, 400);
  assert.equal((await call(e, 'POST', `/api/me/feedback/${fb.json.id}/followup`, { body: 'x' }, CSRF)).status, 401);

  const cap = captureFetch();
  let added;
  try {
    added = await call(e, 'POST', `/api/me/feedback/${fb.json.id}/followup`, { body: '아직도 그래요. 010 2222 3333 으로 연락 주세요' }, a.h);
  } finally {
    cap.restore();
  }
  assert.equal(added.status, 201, added.text);
  assert.equal(added.json.followup.status, 'reviewing', '고침 → 확인 중으로 다시 열림');
  assert.equal(added.json.followup.mine, true);
  assert.match(added.json.followup.body, /\[전화번호\]/);
  assert.ok(cap.calls.some((c) => c.url.startsWith('https://api.telegram.org/') && /덧붙임/.test(c.body)), "덧붙이기는 notifyOps('inquiry_received')로 알린다");

  const fid = added.json.followup.id;
  assert.equal((await call(e, 'PATCH', `/api/me/feedback/${fb.json.id}/followup/${fid}`, { body: '남이 고침' }, b.h)).status, 404, '남은 글 자체가 안 보인다');
  await call(e, 'PATCH', `/api/admin/feedback/${fb.json.id}`, { status: 'closed' }, BEARER);
  const edited = await call(e, 'PATCH', `/api/me/feedback/${fb.json.id}/followup/${fid}`, { body: '다시 보니 새로고침하면 돼요' }, a.h);
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.json.followup.edited, true);
  assert.equal(edited.json.followup.status, 'reviewing', '닫음 → 확인 중으로 다시 열림');

  let mine = await call(e, 'GET', '/api/me/feedback', null, a.h);
  const row = mine.json.items.find((x) => x.id === fb.json.id);
  assert.equal(row.status, 'reviewing');
  assert.equal(row.status_label, '확인 중');
  assert.deepEqual(row.followups.map((f) => f.body), ['다시 보니 새로고침하면 돼요']);

  const del = await call(e, 'DELETE', `/api/me/feedback/${fb.json.id}/followup/${fid}`, null, a.h);
  assert.equal(del.status, 200, del.text);
  assert.equal(del.json.deleted, true);
  assert.equal((await call(e, 'DELETE', `/api/me/feedback/${fb.json.id}/followup/${fid}`, null, a.h)).status, 404, '이미 지운 것');
  mine = await call(e, 'GET', '/api/me/feedback', null, a.h);
  assert.equal(mine.json.items.find((x) => x.id === fb.json.id).followups.length, 0, '고객 화면에서 사라진다');
  const detail = await call(e, 'GET', `/api/admin/feedback/${fb.json.id}`, null, BEARER);
  assert.equal(detail.json.feedback.followups.length, 1, '운영센터에는 남는다');
  assert.equal(detail.json.feedback.followups[0].deleted, true);
  const stored = await e.DB.prepare('SELECT status FROM feedback_followup WHERE id = ?').bind(fid).first();
  assert.equal(stored.status, 'deleted', '실제 삭제가 아니라 표시만 숨김');
});

test('AI 명예회원 계정의 의견은 그 이름으로 표시된다', async () => {
  const e = env();
  const ai = await makeAiMember(e, 'ai.two@cgi-test.kr', '코드리뷰어');
  const fb = await call(e, 'POST', '/api/feedback', { kind: 'feature', body: '비교 기능' }, ai.h);
  const list = await call(e, 'GET', '/api/admin/feedback', null, BEARER);
  const row = list.json.items.find((x) => x.id === fb.json.id);
  assert.equal(row.ai_member_label, 'AI 명예회원 코드리뷰어');
});

test('한눈에: 전체·실제·AI 명예회원·시험 계정, 7일 신규, 새 의견 수', async () => {
  const e = env({ TEST_ACCOUNT_EMAILS: 'qa@cgi-test.kr' });
  await member(e, 'real1@cgi-test.kr', '실제1');
  await member(e, 'real2@cgi-test.kr', '실제2');
  await member(e, 'qa@cgi-test.kr', '시험(목록)');
  await member(e, 'bot@example.com', '시험(예약 도메인)');
  await makeAiMember(e, 'ai3@cgi-test.kr', 'AI셋');
  await e.DB.prepare("UPDATE members SET created_at = '2026-01-01T00:00:00.000Z' WHERE email = 'real2@cgi-test.kr'").run();
  await call(e, 'POST', '/api/feedback', { kind: 'bug', body: '새 의견 1' }, { Origin: ORIGIN });
  const two = await call(e, 'POST', '/api/feedback', { kind: 'product', body: '새 의견 2' }, { Origin: ORIGIN });
  await call(e, 'PATCH', `/api/admin/feedback/${two.json.id}`, { status: 'reviewing', issue_ref: '#77' }, BEARER);

  assert.equal((await call(e, 'GET', '/api/admin/ops/stats', null, { Origin: ORIGIN })).status, 401);
  const s = await call(e, 'GET', '/api/admin/ops/stats', null, BEARER);
  assert.equal(s.status, 200, s.text);
  const { accounts, feedback, issues } = s.json.stats;
  assert.deepEqual({ total: accounts.total, real: accounts.real, ai: accounts.ai_member, tester: accounts.tester }, { total: 5, real: 2, ai: 1, tester: 2 });
  assert.equal(accounts.real + accounts.ai_member + accounts.tester, accounts.total, '셋은 겹치지 않고 합이 전체');
  assert.deepEqual(accounts.new7, { total: 4, real: 1, ai_member: 1, tester: 2 });
  assert.equal(feedback.received, 1, '새 의견(접수 상태) 수');
  assert.equal(feedback.pending, 2);
  assert.equal(issues.linked, 1);
});

test('고객 탭: 목록·상세, 열어 본 기록을 남기고 90일 지난 기록은 지운다', async () => {
  const e = env();
  const c = await member(e, 'cust@cgi-test.kr', '손님');
  await call(e, 'POST', '/api/feedback', { kind: 'bug', body: '손님 의견' }, c.h);
  const sa = await member(e, 'skerish@naver.com', '총관리자');

  assert.equal((await call(e, 'GET', '/api/admin/customers', null, c.h)).status, 401);
  const list = await call(e, 'GET', '/api/admin/customers', null, sa.h);
  assert.equal(list.status, 200, list.text);
  const row = list.json.customers.find((x) => x.email === 'cust@cgi-test.kr');
  assert.equal(row.kind_label, '실제 고객');
  assert.equal(row.feedback_count, 1);
  assert.ok(row.last_login_at, '마지막 로그인');

  // 오래된 기록(91일 전)을 하나 넣어 둔다.
  const old = new Date(Date.now() - 91 * 86400000).toISOString();
  await e.DB.prepare("INSERT INTO admin_customer_views (admin_member_id, admin_label, customer_id, viewed_at) VALUES (NULL, 'old', ?, ?)").bind(c.id, old).run();
  const fresh = new Date(Date.now() - 89 * 86400000).toISOString();
  await e.DB.prepare("INSERT INTO admin_customer_views (admin_member_id, admin_label, customer_id, viewed_at) VALUES (NULL, 'fresh', ?, ?)").bind(c.id, fresh).run();

  const detail = await call(e, 'GET', `/api/admin/customers/${c.id}`, null, sa.h);
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.json.customer.email, 'cust@cgi-test.kr', '운영진은 고객 이메일을 본다');
  assert.equal(detail.json.customer.feedback.length, 1);
  assert.equal(detail.json.customer.quote_count, 0);
  const labels = detail.json.views.map((v) => v.admin_label);
  assert.ok(labels[0].includes('***'), '본 사람은 가린 이메일로 남는다');
  assert.ok(labels.includes('fresh'), '89일 기록은 남는다');
  assert.ok(!labels.includes('old'), '90일 지난 기록은 지운다');

  await call(e, 'GET', `/api/admin/customers/${c.id}`, null, BEARER);
  const views = await call(e, 'GET', '/api/admin/customer-views', null, BEARER);
  assert.equal(views.json.views[0].admin_label, '관리자 토큰');
  assert.equal(views.json.views[0].customer_email, 'cust@cgi-test.kr');
  assert.equal((await call(e, 'GET', '/api/admin/customers/99999', null, BEARER)).status, 404);

  // 예약 작업이 쓰는 같은 함수
  await e.DB.prepare("INSERT INTO admin_customer_views (admin_member_id, admin_label, customer_id, viewed_at) VALUES (NULL, 'old2', ?, ?)").bind(c.id, old).run();
  assert.equal(await purgeExpiredCustomerViews(e.DB), 1);
});
