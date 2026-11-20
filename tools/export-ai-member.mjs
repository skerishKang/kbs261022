#!/usr/bin/env node
// AI 명예회원별 소개·사용 일지를 md 로 내보낸다(러브트리 tools/export-ai-customer.mjs 와 같은 모양).
//
// 읽기 전용: 관리자 API(GET)만 부른다 — /api/admin/customers?kind=ai_member, /api/admin/customers/:id.
// 자세히 읽기는 운영센터 '열어 본 기록'에 '관리자 토큰'으로 남는다(90일 보관).
// 이메일·전화번호는 출력 전에 가린다. 관리자 토큰은 출력·로그에 남기지 않는다.
//
// 환경값
//   CGI_ADMIN_TOKEN (또는 ADMIN_TOKEN)  관리자 토큰
//   CGI_API_URL                         Worker 주소 (기본: site/config.js 의 quoteApiUrl)
//
// 사용
//   node tools/export-ai-member.mjs --out <폴더> [--day YYYY-MM-DD] [--dry-run]
//   → <폴더>/<이름>/소개.md (덮어씀), <폴더>/<이름>/일지_YYMMDD.md (그날 일지)

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { maskPersonal, FEEDBACK_STATUS_LABELS, FEEDBACK_KIND_LABELS } from '../backend/lib/feedback.mjs';

export const DEFAULT_API_URL = 'https://cgi-quote-api.charliekant.workers.dev';

const clean = (value) => maskPersonal(String(value ?? '').replace(/\r\n/g, '\n').trim());
const dayFileName = (day) => `일지_${String(day).replace(/-/g, '').slice(2)}.md`;

export function parseArgs(argv) {
  const out = { out: null, day: null, api: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--dry-run') out.dryRun = true;
    else if (key === '--out') out.out = argv[++i] ?? '';
    else if (key === '--day') out.day = argv[++i] ?? '';
    else if (key === '--api') out.api = argv[++i] ?? '';
    else throw new Error(`모르는 옵션: ${key}`);
  }
  if (!out.out) throw new Error('내보낼 폴더(--out)가 필요합니다.');
  if (out.day && !/^\d{4}-\d{2}-\d{2}$/.test(out.day)) throw new Error('--day 는 YYYY-MM-DD 모양이어야 합니다.');
  return out;
}

/** 폴더 이름으로 쓸 수 없는 글자를 걷어 낸다. */
export function safeName(name, fallback) {
  const s = clean(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return s || fallback;
}

export function renderIntroMarkdown(customer) {
  const journals = Array.isArray(customer.journals) ? customer.journals : [];
  const days = [...new Set(journals.map((j) => j.journal_date))].sort();
  const scored = journals.filter((j) => j.score != null).sort((a, b) => String(a.journal_date).localeCompare(String(b.journal_date)));
  const flow = scored.map((j) => `${j.journal_date} ${j.score}`).join(' · ') || '—';
  const feedback = Array.isArray(customer.feedback) ? customer.feedback : [];
  const lines = [
    `# AI 명예회원 ${clean(customer.name) || '이름 없음'} 소개`,
    '',
    `- **역할**: ${clean(customer.role_label) || 'AI 명예회원'}`,
    `- **가입**: ${String(customer.joined_at || '—').slice(0, 10)}`,
    `- **마지막 로그인**: ${String(customer.last_login_at || '—').slice(0, 10)}`,
    `- **일지 쓴 날**: ${days.length}일${days.length ? ` (${days[0]} ~ ${days[days.length - 1]})` : ''}`,
    `- **다시 올 점수 흐름**: ${flow}`,
    `- **보낸 의견**: ${feedback.length}건`,
  ];
  if (feedback.length) {
    lines.push('', '## 보낸 의견', '');
    for (const f of feedback) {
      lines.push(`- ${String(f.created_at || '').slice(0, 10)} · ${FEEDBACK_KIND_LABELS[f.kind] || f.kind} · ${FEEDBACK_STATUS_LABELS[f.status] || f.status}${f.issue_ref ? ` · ${f.issue_ref}` : ''} — ${clean(f.body_preview)}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function renderDayMarkdown(customer, journal) {
  const lines = [
    `# AI 명예회원 ${clean(customer.name) || '이름 없음'} · ${journal.journal_date}`,
    '',
    `## ${clean(journal.title) || '(제목 없음)'} · 다시 올 점수 ${journal.score ?? '—'}`,
    '',
    clean(journal.body),
    '',
  ];
  if (journal.admin_note) lines.push(`> 내부 메모: ${clean(journal.admin_note)}`, '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

async function getJson(fetchImpl, api, token, pathName) {
  const res = await fetchImpl(api + pathName, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${pathName}: ${data && data.error ? data.error : 'error'}`);
  return data;
}

/** 내보내기. 반환: 쓴(또는 쓸) 파일 목록과 고객 수. fetchImpl 을 주입해 시험에서 Worker 를 그대로 붙인다. */
export async function exportAiMembers({ out, day = null, dryRun = false, api, token, fetchImpl = globalThis.fetch, write = writeFile, makeDir = mkdir }) {
  const list = await getJson(fetchImpl, api, token, '/api/admin/customers?kind=ai_member');
  const customers = Array.isArray(list && list.customers) ? list.customers : [];
  const files = [];
  const used = new Set();
  for (const row of customers) {
    const detail = await getJson(fetchImpl, api, token, `/api/admin/customers/${encodeURIComponent(row.id)}`);
    const customer = detail && detail.customer ? detail.customer : row;
    let dirName = safeName(customer.name, `회원_${customer.id}`);
    if (used.has(dirName.toLowerCase())) dirName = `${dirName}_${customer.id}`;
    used.add(dirName.toLowerCase());
    const dir = path.join(out, dirName);
    const outputs = [[path.join(dir, '소개.md'), renderIntroMarkdown(customer)]];
    for (const j of customer.journals || []) {
      if (day && j.journal_date !== day) continue;
      outputs.push([path.join(dir, dayFileName(j.journal_date)), renderDayMarkdown(customer, j)]);
    }
    if (!dryRun) await makeDir(dir, { recursive: true });
    for (const [file, text] of outputs) {
      if (!dryRun) await write(file, text, 'utf8');
      files.push(file);
    }
  }
  return { customers: customers.length, files };
}

export async function run(argv, { env = process.env, fetchImpl = globalThis.fetch, log = console.log, error = console.error } = {}) {
  let args;
  try { args = parseArgs(argv); } catch (e) { error(e.message); return 2; }
  const token = env.CGI_ADMIN_TOKEN || env.ADMIN_TOKEN || '';
  if (!token) { error('CGI_ADMIN_TOKEN 이 필요합니다'); return 2; }
  const api = String(args.api || env.CGI_API_URL || DEFAULT_API_URL).replace(/\/$/, '');
  try {
    const result = await exportAiMembers({ out: args.out, day: args.day, dryRun: args.dryRun, api, token, fetchImpl });
    for (const f of result.files) log((args.dryRun ? '(쓰지 않음) ' : '') + f);
    log(`exported ai_members=${result.customers} files=${result.files.length}${args.dryRun ? ' (dry-run)' : ''}`);
    return 0;
  } catch (e) {
    error(String((e && e.message) || e));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
