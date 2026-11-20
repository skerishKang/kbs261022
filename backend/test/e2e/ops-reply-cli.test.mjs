// tools/ops-reply.mjs 가 Worker API 를 그대로 거쳐 상태·답글을 바꾸는지 시험한다.
// fetch 를 Worker fetch 핸들러에 붙이므로 네트워크·운영 토큰 없이 돈다.
//
//   node --test --experimental-sqlite test/e2e/ops-reply-cli.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../../worker.js';
import { openD1 } from '../../d1-shim.mjs';
import { run, buildReplyPatch, parseArgs, buildListQuery } from '../../../tools/ops-reply.mjs';

const ORIGIN = 'https://skerishkang.github.io';
const ADMIN_TOKEN = 'example-admin-token';

function env() {
  return {
    DB: openD1(), ADMIN_TOKEN, PG_PROVIDER_MODE: 'mock', ERP_LIVE_WRITE: 'NO', ERP_MODE: 'test',
    SHIPPING_FEE_DEFAULT: '0', CORS_ALLOWED_ORIGINS: ORIGIN,
  };
}

function bridge(environment) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return worker.fetch(new Request(url.replace('https://worker.test', 'http://cgi.local'), init), environment);
  };
  return { fetchImpl, calls };
}

function capture() {
  const out = [];
  const err = [];
  return { out, err, log: (s) => out.push(String(s)), error: (s) => err.push(String(s)) };
}

async function submit(environment, body) {
  const res = await worker.fetch(new Request('http://cgi.local/api/feedback', {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), environment);
  return res.json();
}

test('reply patch is validated by the same function the Worker uses', () => {
  assert.deepEqual(buildReplyPatch({ status: 'fixed', reply: '고쳤어요', issue: '12' }), {
    status: 'fixed', admin_reply: '고쳤어요', issue_ref: '12',
  });
  assert.throws(() => buildReplyPatch({ status: 'done' }), /invalid status/);
  assert.throws(() => buildReplyPatch({}), /nothing to update/);
  assert.deepEqual(buildReplyPatch({ 'no-ai-member': true }), { ai_member: null });
  assert.equal(buildListQuery({ status: 'received', q: '결제' }), '?status=received&q=%EA%B2%B0%EC%A0%9C');
  assert.throws(() => buildListQuery({ kind: 'nope' }));
  assert.deepEqual(parseArgs(['reply', 'FB-1', '--status=fixed', '--dry-run']).flags, { status: 'fixed', 'dry-run': true });
});

test('CLI list / reply / show go through the Worker API with the admin token', async () => {
  const e = env();
  const fb = await submit(e, { kind: 'bug', body: 'CLI 시험용 의견', contact_email: 'cli@example.com' });
  const { fetchImpl, calls } = bridge(e);
  const cliEnv = { CGI_ADMIN_TOKEN: ADMIN_TOKEN, CGI_API_URL: 'https://worker.test' };

  let io = capture();
  assert.equal(await run(['list', '--status', 'received'], { fetchImpl, env: cliEnv, ...io }), 0, io.err.join('\n'));
  assert.match(io.out.join('\n'), /총 1건/);
  assert.match(io.out.join('\n'), new RegExp(fb.id));
  assert.ok(!io.out.join('\n').includes(ADMIN_TOKEN), '토큰은 출력에 남지 않는다');

  io = capture();
  const code = await run(['reply', fb.id, '--status', 'fixed', '--reply', '수정 배포했습니다', '--note', '원인: 캐시', '--issue', '240'], { fetchImpl, env: cliEnv, ...io });
  assert.equal(code, 0, io.err.join('\n'));
  const last = calls[calls.length - 1];
  assert.equal(last.init.method, 'PATCH');
  assert.equal(last.init.headers.Authorization, `Bearer ${ADMIN_TOKEN}`);
  const updated = JSON.parse(io.out.join('\n')).feedback;
  assert.equal(updated.status, 'fixed');
  assert.equal(updated.admin_reply, '수정 배포했습니다');
  assert.equal(updated.admin_note, '원인: 캐시');
  assert.equal(updated.issue_ref, '#240');

  io = capture();
  assert.equal(await run(['show', fb.id], { fetchImpl, env: cliEnv, ...io }), 0);
  assert.equal(JSON.parse(io.out.join('\n')).feedback.contact_email, 'cli@example.com');
});

test('CLI refuses bad input before calling, and reports server refusals', async () => {
  const e = env();
  const { fetchImpl, calls } = bridge(e);
  let io = capture();
  assert.equal(await run(['reply', 'FB-1', '--status', 'done'], { fetchImpl, env: { CGI_ADMIN_TOKEN: ADMIN_TOKEN, CGI_API_URL: 'https://worker.test' }, ...io }), 2);
  assert.equal(calls.length, 0, '잘못된 상태는 보내지 않는다');

  io = capture();
  assert.equal(await run(['list'], { fetchImpl, env: { CGI_API_URL: 'https://worker.test' }, ...io }), 2, '토큰 없으면 중단');

  io = capture();
  assert.equal(await run(['list'], { fetchImpl, env: { CGI_ADMIN_TOKEN: 'wrong', CGI_API_URL: 'https://worker.test' }, ...io }), 1);
  assert.match(io.err.join('\n'), /HTTP 401/);

  io = capture();
  assert.equal(await run(['reply', 'FB-1', '--status', 'fixed', '--dry-run'], { fetchImpl, env: {}, ...io }), 0);
  assert.deepEqual(JSON.parse(io.out.join('\n')).body, { status: 'fixed' });
});
