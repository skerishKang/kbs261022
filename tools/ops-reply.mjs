#!/usr/bin/env node
// 운영센터 CLI — 의견 받은함 조회와 상태·답글·내부 메모 변경.
//
// 상태·답글 변경은 언제나 Worker API(PATCH /api/admin/feedback/:id)로만 한다.
// 입력 검사는 Worker 와 같은 함수(backend/lib/feedback.mjs validateFeedbackPatch)를
// 써서, 서버가 거절할 값은 보내기 전에 여기서 먼저 걸러낸다. DB 를 직접 만지지 않는다.
//
// 환경값
//   CGI_ADMIN_TOKEN (또는 ADMIN_TOKEN)  관리자 토큰 — 출력·로그에 남기지 않는다
//   CGI_API_URL                         Worker 주소 (기본: site/config.js 의 quoteApiUrl)
//
// 사용
//   node tools/ops-reply.mjs list [--status received] [--kind bug] [--q 검색어] [--ai only|exclude]
//   node tools/ops-reply.mjs show FB-261120-ABCDEF
//   node tools/ops-reply.mjs reply FB-261120-ABCDEF --status answered --reply "고쳤습니다" \
//        [--note "내부 메모"] [--issue 231] [--ai-member 리모네 | --no-ai-member] [--dry-run]

import { pathToFileURL } from 'node:url';
import {
  validateFeedbackPatch,
  FEEDBACK_STATUSES,
  FEEDBACK_KINDS,
} from '../backend/lib/feedback.mjs';

export const DEFAULT_API_URL = 'https://cgi-quote-api.charliekant.workers.dev';

const VALUE_FLAGS = new Set(['status', 'kind', 'q', 'ai', 'reply', 'note', 'issue', 'ai-member', 'limit', 'api']);
const BOOL_FLAGS = new Set(['dry-run', 'no-ai-member', 'json', 'help']);

export function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = (eq >= 0 ? arg.slice(2, eq) : arg.slice(2));
    if (BOOL_FLAGS.has(name)) { out.flags[name] = true; continue; }
    if (!VALUE_FLAGS.has(name)) throw new Error(`알 수 없는 옵션: --${name}`);
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[i + 1];
    if (eq < 0) i += 1;
    if (value === undefined) throw new Error(`--${name} 값이 필요합니다`);
    out.flags[name] = value;
  }
  return out;
}

/** reply 명령의 옵션 → PATCH 본문. Worker 와 같은 검사 함수를 통과해야 한다. */
export function buildReplyPatch(flags) {
  const body = {};
  if (flags.status !== undefined) body.status = flags.status;
  if (flags.reply !== undefined) body.admin_reply = flags.reply;
  if (flags.note !== undefined) body.admin_note = flags.note;
  if (flags.issue !== undefined) body.issue_ref = flags.issue;
  if (flags['no-ai-member']) body.ai_member = null;
  else if (flags['ai-member'] !== undefined) body.ai_member = flags['ai-member'];
  const checked = validateFeedbackPatch(body);
  if (!checked.ok) {
    const hint = checked.error === 'invalid status' ? ` (가능: ${FEEDBACK_STATUSES.join(', ')})` : '';
    throw new Error(`입력 오류: ${checked.error}${hint}`);
  }
  return body;
}

export function buildListQuery(flags) {
  const params = new URLSearchParams();
  if (flags.status) {
    if (!FEEDBACK_STATUSES.includes(flags.status)) throw new Error(`--status 는 ${FEEDBACK_STATUSES.join(', ')} 중 하나`);
    params.set('status', flags.status);
  }
  if (flags.kind) {
    if (!FEEDBACK_KINDS.includes(flags.kind)) throw new Error(`--kind 는 ${FEEDBACK_KINDS.join(', ')} 중 하나`);
    params.set('kind', flags.kind);
  }
  if (flags.q) params.set('q', flags.q);
  if (flags.ai) params.set('ai', flags.ai);
  if (flags.limit) params.set('limit', flags.limit);
  const s = params.toString();
  return s ? `?${s}` : '';
}

function formatRow(item) {
  const who = item.ai_member_label ? ` [${item.ai_member_label}]` : '';
  const issue = item.issue_ref ? ` ${item.issue_ref}` : '';
  return `${item.id}  ${item.created_at.slice(0, 16).replace('T', ' ')}  ${item.status_label.padEnd(5)}  ${item.kind_label}${who}${issue}\n    ${item.body_preview}`;
}

/**
 * CLI 실행. fetchImpl·env·log 를 주입할 수 있어 시험에서 Worker 를 그대로 붙인다.
 * 반환값은 종료 코드.
 */
export async function run(argv, { fetchImpl = globalThis.fetch, env = process.env, log = console.log, error = console.error } = {}) {
  let args;
  try { args = parseArgs(argv); } catch (e) { error(e.message); return 2; }
  const [command, id] = args._;
  if (!command || args.flags.help) {
    log('사용: ops-reply.mjs list|show <id>|reply <id> [옵션] — 파일 머리말 참고');
    return command ? 0 : 2;
  }
  const api = String(args.flags.api || env.CGI_API_URL || DEFAULT_API_URL).replace(/\/$/, '');
  const token = env.CGI_ADMIN_TOKEN || env.ADMIN_TOKEN || '';

  let method = 'GET';
  let path;
  let body;
  try {
    if (command === 'list') {
      path = '/api/admin/feedback' + buildListQuery(args.flags);
    } else if (command === 'show' || command === 'reply') {
      if (!id) throw new Error('접수번호가 필요합니다 (예: FB-261120-ABCDEF)');
      path = `/api/admin/feedback/${encodeURIComponent(id)}`;
      if (command === 'reply') { method = 'PATCH'; body = buildReplyPatch(args.flags); }
    } else {
      throw new Error(`알 수 없는 명령: ${command}`);
    }
  } catch (e) {
    error(e.message);
    return 2;
  }

  if (args.flags['dry-run']) {
    log(JSON.stringify({ method, url: api + path, body: body || null }, null, 2));
    return 0;
  }
  if (!token) { error('CGI_ADMIN_TOKEN 이 필요합니다'); return 2; }

  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetchImpl(api + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    error(`요청 실패: ${e && e.message ? e.message : e}`);
    return 1;
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!res.ok) {
    error(`HTTP ${res.status}: ${data && data.error ? data.error : text.slice(0, 200)}`);
    return 1;
  }
  if (args.flags.json || command !== 'list') {
    log(JSON.stringify(data, null, 2));
  } else {
    log(`총 ${data.total}건`);
    for (const item of data.items) log(formatRow(item));
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
