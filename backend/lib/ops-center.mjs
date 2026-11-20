// 운영센터 '한눈에'·'고객' 탭 — 러브트리 운영센터(statsCards·customerRows·customerDetailModel·
// customerViewRows)와 같은 개념을 CGI Worker + D1 에 맞춘 것.
//
// - 계정은 실제 고객 / AI 명예회원 / 시험 계정 셋으로 나눈다. 셋은 겹치지 않고 전체 = 셋의 합이다.
//   (AI 명예회원이 먼저, 그다음 시험 계정. 관리자·최고관리자는 실제 고객 쪽에 센다.)
// - 고객 자세히 보기를 열면 누가·언제·누구를 봤는지 남기고, 그 기록은 90일 뒤 지운다.
// - 운영진은 고객 이메일·이름을 다 본다(러브트리 261116 결정과 같다). 고치거나 지우는 동작은 역할 지정뿐.

import { maskEmail } from './feedback.mjs';

export const ROLE_AI_MEMBER = 'ai_member';
export const ROLE_MEMBER = 'member';
/** 운영센터 고객 탭에서 관리자가 지정할 수 있는 역할(관리자 역할은 기존 총관리자 화면에서만). */
export const ASSIGNABLE_ROLES = [ROLE_MEMBER, ROLE_AI_MEMBER];
export const ROLE_LABELS = {
  member: '실제 고객',
  ai_member: 'AI 명예회원',
  admin: '관리자',
  superadmin: '최고관리자',
};
export const CUSTOMER_KIND_LABELS = { real: '실제 고객', ai_member: 'AI 명예회원', tester: '시험 계정' };
export const CUSTOMER_VIEW_RETENTION_DAYS = 90;
/** 시험 계정으로 보는 메일 도메인(예약 도메인). 운영 변수 TEST_ACCOUNT_EMAILS 로 주소를 더할 수 있다. */
export const TEST_DOMAINS = ['example.com', 'example.org', 'example.net', 'test.local'];

const DAY_MS = 24 * 3600 * 1000;

export function testAccountEmails(env = {}) {
  return new Set(String(env.TEST_ACCOUNT_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

export function isTestAccount(email, env = {}, listed = testAccountEmails(env)) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  if (listed.has(e)) return true;
  const domain = e.slice(e.lastIndexOf('@') + 1);
  return TEST_DOMAINS.includes(domain);
}

/** 계정 하나를 셋 중 하나로. */
export function customerKind(member, env = {}, listed) {
  if (member && member.role === ROLE_AI_MEMBER) return 'ai_member';
  if (isTestAccount(member && member.email, env, listed)) return 'tester';
  return 'real';
}

/** '한눈에' 숫자: 계정(전체·실제·AI 명예회원·시험), 7일 신규, 새 의견(받은 뒤 아직 안 본 것), 오늘 일지. */
export async function computeStats(db, env = {}, nowMs = Date.now(), todaySeoul = null) {
  const listed = testAccountEmails(env);
  const since = new Date(nowMs - 7 * DAY_MS).toISOString();
  const { results } = await db.prepare("SELECT id, email, role, created_at FROM members WHERE status != 'deleted'").all();
  const accounts = { total: 0, real: 0, ai_member: 0, tester: 0, new7: { total: 0, real: 0, ai_member: 0, tester: 0 } };
  for (const m of results || []) {
    const kind = customerKind(m, env, listed);
    accounts.total += 1;
    accounts[kind] += 1;
    if (String(m.created_at || '') >= since) { accounts.new7.total += 1; accounts.new7[kind] += 1; }
  }
  const fb = await db.prepare(
    "SELECT SUM(CASE WHEN status = 'received' THEN 1 ELSE 0 END) AS received, SUM(CASE WHEN status IN ('received','reviewing') THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS new7, COUNT(*) AS total FROM feedback"
  ).bind(since).first();
  const issues = await db.prepare("SELECT COUNT(DISTINCT issue_ref) AS n FROM feedback WHERE issue_ref IS NOT NULL AND issue_ref != ''").first();
  let journalsToday = 0;
  if (todaySeoul) {
    const j = await db.prepare('SELECT COUNT(*) AS n FROM feedback_journal WHERE journal_date = ?').bind(todaySeoul).first();
    journalsToday = Number(j ? j.n : 0);
  }
  return {
    accounts,
    feedback: {
      received: Number(fb && fb.received || 0),
      pending: Number(fb && fb.pending || 0),
      new7: Number(fb && fb.new7 || 0),
      total: Number(fb && fb.total || 0),
    },
    issues: { linked: Number(issues ? issues.n : 0) },
    journals: { today: journalsToday },
  };
}

function customerRow(m, env, listed) {
  const kind = customerKind(m, env, listed);
  return {
    id: m.id,
    email: m.email,
    name: m.name,
    role: m.role || ROLE_MEMBER,
    role_label: ROLE_LABELS[m.role] || ROLE_LABELS.member,
    kind,
    kind_label: CUSTOMER_KIND_LABELS[kind],
    status: m.status,
    email_verified: !!m.email_verified_at,
    joined_at: m.created_at,
    last_login_at: m.last_login_at || null,
    feedback_count: Number(m.feedback_count || 0),
    journal_count: Number(m.journal_count || 0),
    last_journal_date: m.last_journal_date || null,
  };
}

const CUSTOMER_SELECT = `SELECT m.id, m.email, m.name, m.role, m.status, m.email_verified_at, m.created_at,
  (SELECT MAX(t.created_at) FROM auth_tokens t WHERE t.member_id = m.id AND t.kind = 'session') AS last_login_at,
  (SELECT COUNT(*) FROM feedback f WHERE f.member_id = m.id) AS feedback_count,
  (SELECT COUNT(*) FROM feedback_journal j WHERE j.member_id = m.id) AS journal_count,
  (SELECT MAX(j2.journal_date) FROM feedback_journal j2 WHERE j2.member_id = m.id) AS last_journal_date
  FROM members m`;

export async function listCustomers(db, env = {}, { kind = '', q = '', limit = 300 } = {}) {
  const listed = testAccountEmails(env);
  const where = ["m.status != 'deleted'"];
  const args = [];
  const term = String(q || '').trim();
  if (term) {
    const like = '%' + [...term].slice(0, 80).join('').replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    where.push("(m.email LIKE ? ESCAPE '\\' OR m.name LIKE ? ESCAPE '\\')");
    args.push(like, like);
  }
  const lim = Math.max(1, Math.min(1000, Number.parseInt(limit, 10) || 300));
  const { results } = await db.prepare(`${CUSTOMER_SELECT} WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`)
    .bind(...args, lim).all();
  const rows = (results || []).map((m) => customerRow(m, env, listed));
  return kind ? rows.filter((r) => r.kind === kind) : rows;
}

export async function getCustomer(db, env, id) {
  const m = await db.prepare(`${CUSTOMER_SELECT} WHERE m.id = ? AND m.status != 'deleted'`).bind(Number(id)).first();
  return m ? customerRow(m, env, testAccountEmails(env)) : null;
}

/** 자세히 보기에 붙는 활동 수(견적·주문). 본문은 각 관리 화면에서 본다. */
export async function customerActivity(db, id) {
  const q = await db.prepare('SELECT COUNT(*) AS n FROM quote_requests WHERE member_id = ?').bind(Number(id)).first();
  const o = await db.prepare('SELECT COUNT(*) AS n FROM orders WHERE customer_id = ?').bind(Number(id)).first();
  return { quote_count: Number(q ? q.n : 0), order_count: Number(o ? o.n : 0) };
}

// ---- 열어 본 기록(90일 보관) ----

export async function purgeExpiredCustomerViews(db, nowMs = Date.now(), days = CUSTOMER_VIEW_RETENTION_DAYS) {
  const cutoff = new Date(nowMs - days * DAY_MS).toISOString();
  const res = await db.prepare('DELETE FROM admin_customer_views WHERE viewed_at < ?').bind(cutoff).run();
  return Number(res && res.meta && res.meta.changes || 0);
}

export async function logCustomerView(db, { adminMemberId = null, adminLabel, customerId, nowIso }) {
  await db.prepare('INSERT INTO admin_customer_views (admin_member_id, admin_label, customer_id, viewed_at) VALUES (?, ?, ?, ?)')
    .bind(adminMemberId, String(adminLabel || '').slice(0, 80), Number(customerId), nowIso).run();
  // 보관 기한이 지난 기록은 쓰는 김에 함께 지운다(예약 작업도 매일 지운다).
  await purgeExpiredCustomerViews(db, Date.parse(nowIso));
}

export async function listCustomerViews(db, { customerId = null, limit = 100 } = {}) {
  const lim = Math.max(1, Math.min(500, Number.parseInt(limit, 10) || 100));
  const base = `SELECT v.id, v.admin_label, v.customer_id, v.viewed_at, m.email AS customer_email, m.name AS customer_name
    FROM admin_customer_views v LEFT JOIN members m ON m.id = v.customer_id`;
  const stmt = customerId
    ? db.prepare(`${base} WHERE v.customer_id = ? ORDER BY v.viewed_at DESC, v.id DESC LIMIT ?`).bind(Number(customerId), lim)
    : db.prepare(`${base} ORDER BY v.viewed_at DESC, v.id DESC LIMIT ?`).bind(lim);
  const { results } = await stmt.all();
  return (results || []).map((r) => ({
    id: r.id,
    admin_label: r.admin_label,
    customer_id: r.customer_id,
    customer_email: r.customer_email || '',
    customer_name: r.customer_name || '',
    viewed_at: r.viewed_at,
  }));
}

/** 기록에 남길 관리자 이름: 토큰이면 '관리자 토큰', 회원 세션이면 가린 이메일. */
export function adminLabelFor(member) {
  return member && member.email ? maskEmail(member.email) : '관리자 토큰';
}
