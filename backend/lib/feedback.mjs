// 운영센터(의견 보내기 · 받은함 · 답변 · 내 의견 · 새 소식) 공통 로직.
//
// Worker 라우트(backend/worker.js)와 CLI(tools/ops-reply.mjs)가 같은 검증
// 함수를 쓴다. 상태·답글 변경은 언제나 Worker API를 거치고, CLI는 이 모듈로
// 입력을 먼저 검사한 다음 관리자 토큰으로 같은 API를 부른다.
//
// 개인정보: contact_email 은 관리자 상세 화면에서만 원문으로 내보낸다.
// 목록 화면은 가린 값만, 회원 본인 화면과 공개 화면에는 아예 싣지 않는다.

export const FEEDBACK_KINDS = ['bug', 'idea', 'product', 'other'];
export const FEEDBACK_KIND_LABELS = {
  bug: '불편·오류',
  idea: '기능 제안',
  product: '상품·가격 문의',
  other: '기타',
};

export const FEEDBACK_STATUSES = ['received', 'checking', 'fixed', 'answered', 'on_hold'];
export const FEEDBACK_STATUS_LABELS = {
  received: '접수',
  checking: '확인 중',
  fixed: '고침',
  answered: '답변 완료',
  on_hold: '보류',
};

export const NEWS_SOURCE_TAGS = ['ai_member', 'user_feedback'];
export const NEWS_SOURCE_LABELS = {
  ai_member: 'AI 명예회원이 알려 준 것',
  user_feedback: '사용자 의견으로 고친 것',
};

export const FEEDBACK_BODY_MAX = 2000;
export const FEEDBACK_REPLY_MAX = 2000;
export const FEEDBACK_NOTE_MAX = 4000;
export const FEEDBACK_LINK_LIMIT = 3; // 링크가 이 개수 이상이면 거절
export const FEEDBACK_PAGE_URL_MAX = 500;
export const FEEDBACK_ISSUE_REF_MAX = 120;
export const AI_MEMBER_NAME_MAX = 40;
export const NEWS_TITLE_MAX = 120;
export const NEWS_BODY_MAX = 4000;

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,63}$/;
const LINK_RE = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;

/** 문자열 길이(코드포인트 기준). 한글·이모지도 한 글자로 센다. */
export function charLength(value) {
  return [...String(value == null ? '' : value)].length;
}

export function countLinks(text) {
  const matches = String(text == null ? '' : text).match(LINK_RE);
  return matches ? matches.length : 0;
}

/** 같은 내용 반복 판정용: 공백·대소문자 차이는 같은 내용으로 본다. */
export function normalizeForDuplicate(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().toLowerCase();
}

function optionalString(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/** 보던 화면 주소: http(s) 절대 주소만 저장한다. 그 밖의 값은 버린다. */
export function normalizePageUrl(value) {
  const s = optionalString(value);
  if (!s) return null;
  try {
    const url = new URL(s);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    // 토큰이 실린 인증 링크가 그대로 남지 않도록 쿼리의 token 값은 지운다.
    for (const key of [...url.searchParams.keys()]) {
      if (/token|code|key|secret|password/i.test(key)) url.searchParams.set(key, '***');
    }
    const out = url.toString();
    return charLength(out) > FEEDBACK_PAGE_URL_MAX ? [...out].slice(0, FEEDBACK_PAGE_URL_MAX).join('') : out;
  } catch (e) {
    return null;
  }
}

export function validateContactEmail(value) {
  const s = optionalString(value);
  if (!s) return { ok: true, value: null };
  const lower = s.toLowerCase();
  if (charLength(lower) > 200 || !EMAIL_RE.test(lower)) {
    return { error: 'invalid contact_email', detail: '이메일 주소 형식을 확인해 주세요.' };
  }
  return { ok: true, value: lower };
}

/** 고객이 보내는 의견 입력 검사. */
export function validateFeedbackInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'invalid body' };
  const kind = String(input.kind || '').trim();
  if (!FEEDBACK_KINDS.includes(kind)) {
    return { error: 'invalid kind', detail: '의견 종류를 골라 주세요.' };
  }
  const body = String(input.body == null ? '' : input.body).replace(/\r\n?/g, '\n').trim();
  if (!body) return { error: 'body required', detail: '내용을 적어 주세요.' };
  if (charLength(body) > FEEDBACK_BODY_MAX) {
    return { error: 'body too long', detail: `내용은 ${FEEDBACK_BODY_MAX.toLocaleString('en-US')}자까지 적을 수 있어요.` };
  }
  if (countLinks(body) >= FEEDBACK_LINK_LIMIT) {
    return { error: 'too many links', detail: `링크는 ${FEEDBACK_LINK_LIMIT - 1}개까지만 넣을 수 있어요.` };
  }
  const email = validateContactEmail(input.contact_email);
  if (email.error) return email;
  return {
    ok: true,
    kind,
    body,
    page_url: normalizePageUrl(input.page_url),
    contact_email: email.value,
  };
}

/** "#12", "12", ".../issues/12" 를 모두 "#12" 로, 그 밖의 값은 잘라서 그대로. */
export function normalizeIssueRef(value) {
  const s = optionalString(value);
  if (!s) return null;
  const m = s.match(/^#?(\d{1,7})$/) || s.match(/\/issues\/(\d{1,7})(?:[/?#].*)?$/);
  if (m) return '#' + m[1];
  return [...s].slice(0, FEEDBACK_ISSUE_REF_MAX).join('');
}

/**
 * 관리자 변경 입력 검사. 들어온 항목만 fields 에 담는다.
 * Worker PATCH /api/admin/feedback/:id 와 tools/ops-reply.mjs 가 함께 쓴다.
 */
export function validateFeedbackPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'invalid body' };
  const fields = {};
  if (input.status !== undefined) {
    const status = String(input.status || '').trim();
    if (!FEEDBACK_STATUSES.includes(status)) return { error: 'invalid status', detail: FEEDBACK_STATUSES.join(', ') };
    fields.status = status;
  }
  if (input.admin_reply !== undefined) {
    const reply = optionalString(input.admin_reply);
    if (reply && charLength(reply) > FEEDBACK_REPLY_MAX) return { error: 'admin_reply too long' };
    fields.admin_reply = reply;
  }
  if (input.admin_note !== undefined) {
    const note = optionalString(input.admin_note);
    if (note && charLength(note) > FEEDBACK_NOTE_MAX) return { error: 'admin_note too long' };
    fields.admin_note = note;
  }
  if (input.issue_ref !== undefined) {
    fields.issue_ref = normalizeIssueRef(input.issue_ref);
  }
  if (input.ai_member !== undefined) {
    const name = input.ai_member === false ? null : optionalString(input.ai_member);
    if (name && charLength(name) > AI_MEMBER_NAME_MAX) return { error: 'ai_member too long' };
    fields.ai_member = name;
  }
  if (!Object.keys(fields).length) return { error: 'nothing to update' };
  return { ok: true, fields };
}

/**
 * AI 명예회원 페르소나 목록: "email:이름,email2:이름2" (환경값 AI_MEMBER_PERSONAS).
 * 이메일은 소문자로 맞춘다. 이름이 없으면 이메일 앞부분을 쓴다.
 */
export function parseAiPersonas(value) {
  const map = new Map();
  for (const part of String(value || '').split(',')) {
    const item = part.trim();
    if (!item) continue;
    const idx = item.indexOf(':');
    const email = (idx >= 0 ? item.slice(0, idx) : item).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) continue;
    const rawName = idx >= 0 ? item.slice(idx + 1).trim() : '';
    const name = [...(rawName || email.split('@')[0])].slice(0, AI_MEMBER_NAME_MAX).join('');
    map.set(email, name);
  }
  return map;
}

export function aiMemberFor(personas, ...emails) {
  for (const email of emails) {
    const key = String(email || '').trim().toLowerCase();
    if (key && personas.has(key)) return personas.get(key);
  }
  return null;
}

/** 목록용 이메일 가림: ab***@ex***.com */
export function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at < 1) return s ? '***' : null;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return local.slice(0, Math.min(2, local.length)) + '***@' + host.slice(0, Math.min(2, host.length)) + '***' + tld;
}

/** 접수번호: FB-YYMMDD-XXXXXX (날짜 + 무작위 6자) */
export function newFeedbackId(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const ymd = d.toISOString().slice(2, 10).replace(/-/g, '');
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const tail = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `FB-${ymd}-${tail}`;
}

export function aiMemberLabel(name) {
  return name ? `AI 명예회원 ${name}` : null;
}

/** 운영센터 받은함 목록: 연락 이메일은 가린다, 내부 메모는 있다는 표시만. */
export function feedbackListView(row) {
  if (!row) return null;
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    kind: row.kind,
    kind_label: FEEDBACK_KIND_LABELS[row.kind] || row.kind,
    status: row.status,
    status_label: FEEDBACK_STATUS_LABELS[row.status] || row.status,
    body_preview: [...String(row.body || '')].slice(0, 120).join(''),
    page_url: row.page_url,
    contact_email_masked: row.contact_email ? maskEmail(row.contact_email) : null,
    has_contact: !!row.contact_email,
    member_id: row.member_id,
    ai_member: row.ai_member || null,
    ai_member_label: aiMemberLabel(row.ai_member),
    has_reply: !!row.admin_reply,
    has_note: !!row.admin_note,
    issue_ref: row.issue_ref,
  };
}

/** 운영센터 상세: 관리자만 받는다. 연락 이메일 원문 포함. */
export function feedbackAdminView(row) {
  if (!row) return null;
  return {
    ...feedbackListView(row),
    body: row.body,
    contact_email: row.contact_email,
    admin_reply: row.admin_reply,
    admin_note: row.admin_note,
  };
}

/** 회원 본인 '내 의견': 내부 메모·이슈 번호·연락 이메일·AI 표시는 싣지 않는다. */
export function feedbackMemberView(row) {
  if (!row) return null;
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    kind: row.kind,
    kind_label: FEEDBACK_KIND_LABELS[row.kind] || row.kind,
    status: row.status,
    status_label: FEEDBACK_STATUS_LABELS[row.status] || row.status,
    body: row.body,
    page_url: row.page_url,
    admin_reply: row.admin_reply,
  };
}

/** 새 소식 입력 검사. partial=true 이면 들어온 항목만 검사한다(PATCH). */
export function validateNewsInput(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'invalid body' };
  const fields = {};
  if (!partial || input.title !== undefined) {
    const title = optionalString(input.title);
    if (!title) return { error: 'title required', detail: '제목을 적어 주세요.' };
    if (charLength(title) > NEWS_TITLE_MAX) return { error: 'title too long' };
    fields.title = title;
  }
  if (!partial || input.body !== undefined) {
    const body = optionalString(input.body);
    if (!body) return { error: 'body required', detail: '내용을 적어 주세요.' };
    if (charLength(body) > NEWS_BODY_MAX) return { error: 'body too long' };
    fields.body = body;
  }
  if (!partial || input.source_tag !== undefined) {
    const tag = String(input.source_tag || '').trim();
    if (!NEWS_SOURCE_TAGS.includes(tag)) return { error: 'invalid source_tag', detail: NEWS_SOURCE_TAGS.join(', ') };
    fields.source_tag = tag;
  }
  if (input.published !== undefined) {
    if (typeof input.published !== 'boolean') return { error: 'published must be boolean' };
    fields.published = input.published;
  }
  if (partial && !Object.keys(fields).length) return { error: 'nothing to update' };
  return { ok: true, fields };
}

/** 공개 새 소식: 누가 말했는지는 싣지 않는다(출처 묶음만). */
export function newsPublicView(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    source_tag: row.source_tag,
    source_label: NEWS_SOURCE_LABELS[row.source_tag] || '',
    published_at: row.published_at,
  };
}

export function newsAdminView(row) {
  if (!row) return null;
  return { ...newsPublicView(row), published: !!row.published_at };
}

// ---------------------------------------------------------------------------
// D1 접근
// ---------------------------------------------------------------------------

export async function insertFeedback(db, rec) {
  await db.prepare(
    `INSERT INTO feedback (id, created_at, kind, body, page_url, contact_email, member_id, ai_member, status, admin_reply, admin_note, issue_ref, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', NULL, NULL, NULL, ?)`
  ).bind(rec.id, rec.created_at, rec.kind, rec.body, rec.page_url, rec.contact_email, rec.member_id, rec.ai_member, rec.created_at).run();
}

export function getFeedback(db, id) {
  return db.prepare('SELECT * FROM feedback WHERE id = ?').bind(String(id)).first();
}

export async function listFeedback(db, { kind, status, q, ai, limit = 100, offset = 0 } = {}) {
  const where = [];
  const args = [];
  if (kind && FEEDBACK_KINDS.includes(kind)) { where.push('kind = ?'); args.push(kind); }
  if (status && FEEDBACK_STATUSES.includes(status)) { where.push('status = ?'); args.push(status); }
  if (ai === 'only') where.push('ai_member IS NOT NULL');
  else if (ai === 'exclude') where.push('ai_member IS NULL');
  const term = optionalString(q);
  if (term) {
    const like = '%' + [...term].slice(0, 80).join('').replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    where.push("(id LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR IFNULL(admin_reply,'') LIKE ? ESCAPE '\\' OR IFNULL(issue_ref,'') LIKE ? ESCAPE '\\' OR IFNULL(ai_member,'') LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like, like);
  }
  const lim = Math.max(1, Math.min(200, Number.parseInt(limit, 10) || 100));
  const off = Math.max(0, Number.parseInt(offset, 10) || 0);
  const sql = 'SELECT * FROM feedback' + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?';
  const { results } = await db.prepare(sql).bind(...args, lim, off).all();
  const countSql = 'SELECT COUNT(*) AS n FROM feedback' + (where.length ? ' WHERE ' + where.join(' AND ') : '');
  const countRow = await db.prepare(countSql).bind(...args).first();
  return { items: results || [], total: Number(countRow ? countRow.n : 0), limit: lim, offset: off };
}

export async function updateFeedback(db, id, fields, now) {
  const keys = Object.keys(fields);
  if (!keys.length) return getFeedback(db, id);
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  await db.prepare(`UPDATE feedback SET ${sets}, updated_at = ? WHERE id = ?`)
    .bind(...keys.map((k) => fields[k]), now, String(id)).run();
  return getFeedback(db, id);
}

export async function listMemberFeedback(db, memberId) {
  const { results } = await db.prepare('SELECT * FROM feedback WHERE member_id = ? ORDER BY created_at DESC, id DESC LIMIT 100')
    .bind(memberId).all();
  return results || [];
}

export async function insertNews(db, fields, now) {
  const publishedAt = fields.published ? now : null;
  const result = await db.prepare('INSERT INTO news (title, body, source_tag, published_at) VALUES (?, ?, ?, ?)')
    .bind(fields.title, fields.body, fields.source_tag, publishedAt).run();
  const id = result && result.meta && result.meta.last_row_id;
  if (id) return db.prepare('SELECT * FROM news WHERE id = ?').bind(id).first();
  return db.prepare('SELECT * FROM news ORDER BY id DESC LIMIT 1').first();
}

export function getNews(db, id) {
  return db.prepare('SELECT * FROM news WHERE id = ?').bind(Number(id)).first();
}

export async function updateNews(db, id, fields, now) {
  const existing = await getNews(db, id);
  if (!existing) return null;
  const sets = [];
  const args = [];
  for (const key of ['title', 'body', 'source_tag']) {
    if (fields[key] !== undefined) { sets.push(`${key} = ?`); args.push(fields[key]); }
  }
  if (fields.published !== undefined) {
    sets.push('published_at = ?');
    args.push(fields.published ? (existing.published_at || now) : null);
  }
  if (!sets.length) return existing;
  await db.prepare(`UPDATE news SET ${sets.join(', ')} WHERE id = ?`).bind(...args, Number(id)).run();
  return getNews(db, id);
}

export async function listNews(db, { publishedOnly = true, limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(200, Number.parseInt(limit, 10) || 50));
  const sql = publishedOnly
    ? 'SELECT * FROM news WHERE published_at IS NOT NULL ORDER BY published_at DESC, id DESC LIMIT ?'
    : 'SELECT * FROM news ORDER BY COALESCE(published_at, \'9999\') DESC, id DESC LIMIT ?';
  const { results } = await db.prepare(sql).bind(lim).all();
  return results || [];
}
