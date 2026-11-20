// tools/export-ai-member.mjs — 관리자 API(GET)로 AI 명예회원 소개·일지를 md 로 내보낸다.
// fetch 를 Worker fetch 핸들러에 붙여 운영 API 없이 돈다. 이메일·전화는 가리고, 쓰기 호출은 없다.
//
//   node --test --experimental-sqlite test/e2e/export-ai-member.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import worker from '../../worker.js';
import { openD1 } from '../../d1-shim.mjs';
import { run, parseArgs, safeName } from '../../../tools/export-ai-member.mjs';

const ORIGIN = 'https://skerishkang.github.io';
const ADMIN_TOKEN = 'example-admin-token';
const PW = 'export-login-fixture-2026';
const CSRF = { Origin: ORIGIN, 'X-CSRF-Token': ORIGIN };

function env() {
  return {
    DB: openD1(), ADMIN_TOKEN, PG_PROVIDER_MODE: 'mock', ERP_LIVE_WRITE: 'NO', ERP_MODE: 'test', SHIPPING_FEE_DEFAULT: '0',
    MAIL_MODE: 'echo', AUTH_PBKDF2_ITERATIONS: '1000', AUTH_RATE_LIMIT_MAX: '100000', AUTH_RATE_LIMIT_WINDOW_SECONDS: '60', CORS_ALLOWED_ORIGINS: ORIGIN,
  };
}

async function call(e, method, p, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await worker.fetch(new Request(`http://cgi.local${p}`, init), e);
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
}

async function aiMember(e, email, name) {
  const s = await call(e, 'POST', '/api/auth/signup', { email, name, password: PW, terms: true, privacy: true, terms_version: 'draft-2026-10-28', privacy_version: 'draft-2026-10-28' }, CSRF);
  await call(e, 'POST', '/api/auth/verify-email', { member_id: s.json.member.id, token: s.json.mail.echo_token }, CSRF);
  const login = await call(e, 'POST', '/api/auth/login', { email, password: PW }, CSRF);
  await call(e, 'PATCH', `/api/admin/customers/${s.json.member.id}/role`, { role: 'ai_member' }, { Authorization: `Bearer ${ADMIN_TOKEN}` });
  return { id: s.json.member.id, h: { ...CSRF, Cookie: login.headers.get('set-cookie') } };
}

test('exports one folder per AI member with 소개.md and a day file, read-only and masked', async () => {
  const e = env();
  const a = await aiMember(e, 'limone@cgi-test.kr', '리모네');
  await aiMember(e, 'other@cgi-test.kr', '리모네'); // 같은 이름 → 폴더가 겹치지 않아야 한다
  const j = await call(e, 'POST', '/api/me/journal', { title: '첫날', body: '검색 좋아요. 연락 limone@cgi-test.kr 010-1111-2222', score: 4 }, a.h);
  assert.equal(j.status, 201, JSON.stringify(j.json));
  await call(e, 'POST', '/api/feedback', { kind: 'feature', body: '비교 기능 주세요' }, a.h);
  await call(e, 'POST', '/api/me/feedback/none/followup', { body: 'x' }, a.h);

  const methods = [];
  const fetchImpl = async (url, init) => {
    methods.push(init.method);
    return worker.fetch(new Request(url.replace('https://worker.test', 'http://cgi.local'), init), e);
  };
  const out = await mkdtemp(path.join(tmpdir(), 'cgi-ai-export-'));
  const logs = [];
  const code = await run(['--out', out], { env: { CGI_ADMIN_TOKEN: ADMIN_TOKEN, CGI_API_URL: 'https://worker.test' }, fetchImpl, log: (s) => logs.push(s), error: (s) => logs.push('ERR ' + s) });
  assert.equal(code, 0, logs.join('\n'));
  assert.ok(methods.every((m) => m === 'GET'), '읽기 전용');
  const dirs = (await readdir(out)).sort();
  assert.equal(dirs.length, 2, '같은 이름 둘은 폴더가 겹치지 않는다');
  assert.ok(dirs.includes('리모네'));
  assert.ok(dirs.some((d) => /^리모네_\d+$/.test(d)));
  const dir = (await Promise.all(dirs.map(async (d) => [d, (await readdir(path.join(out, d))).sort()]))).find(([, f]) => f.length === 2);
  assert.ok(dir, '일지를 쓴 회원 폴더');
  const [name, files] = dir;
  assert.equal(files[0], '소개.md');
  assert.match(files[1], /^일지_\d{6}\.md$/);
  const intro = await readFile(path.join(out, name, '소개.md'), 'utf8');
  assert.match(intro, /^# AI 명예회원 리모네 소개/);
  assert.match(intro, /일지 쓴 날\*\*: 1일/);
  assert.match(intro, /요청 · 접수 — 비교 기능 주세요/);
  const day = await readFile(path.join(out, name, files[1]), 'utf8');
  assert.match(day, /## 첫날 · 다시 올 점수 4/);
  for (const text of [intro, day, logs.join('\n')]) {
    assert.ok(!text.includes('limone@cgi-test.kr') && !text.includes('010-1111-2222'), '이메일·전화는 가린다');
    assert.ok(!text.includes(ADMIN_TOKEN), '토큰은 남기지 않는다');
  }
  const views = await e.DB.prepare("SELECT COUNT(*) AS n FROM admin_customer_views WHERE admin_label = '관리자 토큰'").first();
  assert.equal(views.n, 2, '읽은 기록은 운영센터 열람 기록에 남는다');
});

test('arguments and dry-run', async () => {
  assert.throws(() => parseArgs([]), /--out/);
  assert.throws(() => parseArgs(['--out', 'x', '--day', '20261120']), /YYYY-MM-DD/);
  assert.equal(safeName('a/b:c', 'f'), 'abc');
  assert.equal(safeName('', '회원_3'), '회원_3');
  const logs = [];
  assert.equal(await run(['--out', 'x'], { env: {}, log: (s) => logs.push(s), error: (s) => logs.push(s) }), 2, '토큰 없으면 중단');
  const e = env();
  await aiMember(e, 'dry@cgi-test.kr', '드라이');
  const fetchImpl = async (url, init) => worker.fetch(new Request(url.replace('https://worker.test', 'http://cgi.local'), init), e);
  const out = path.join(tmpdir(), 'cgi-ai-export-dry-should-not-exist-' + Date.now());
  const dry = [];
  assert.equal(await run(['--out', out, '--dry-run'], { env: { CGI_ADMIN_TOKEN: ADMIN_TOKEN, CGI_API_URL: 'https://worker.test' }, fetchImpl, log: (s) => dry.push(s), error: (s) => dry.push(s) }), 0);
  assert.match(dry.join('\n'), /\(쓰지 않음\).*소개\.md/);
  await assert.rejects(readdir(out), 'dry-run 은 폴더를 만들지 않는다');
});
