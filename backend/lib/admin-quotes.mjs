// 관리자 정식 견적서 (admin_quotes / admin_quote_items, migration 0015).
//
// - 고객 견적 요청(quote_requests)과 별개. 관리자만(isAdminOrMember) 쓴다.
// - 계산은 견적서 출력(site/assets/js/cgi-quote-print.js computeQuote)과 같은 규칙이다.
//     줄 금액 = 단가 × 수량 − 할인(금액 또는 %, % 는 1원 단위 반올림)
//     줄마다 splitTax(공급가액 = round(금액 / 1.1), 부가세 = 금액 − 공급가액)
//     합계 줄은 줄 금액 합에 splitTax 를 한 번 적용하고, 끝수 차이는 가장 큰 줄에서 맞춘다.
//   두 구현이 1원 단위까지 같은지는 backend/test/unit/admin-quotes.test.mjs 가 무작위 표본으로 확인한다.
// - 카탈로그 품목의 단가는 서버가 공개가 색인(PRICE_INDEX)으로 다시 확정한다(화면 값은 믿지 않는다).
//   공개가가 없는 품목(가격 문의)과 직접 입력 줄만 관리자가 단가를 넣는다. 비우면 '별도 견적'.
// - 견적번호 Q-YYMMDD-NNN 은 한국 날짜 기준 그날의 다음 번호. 같은 번호가 겹치면 다시 시도한다.

import { splitTax } from './pricing.mjs';

export const STATUSES = Object.freeze(['draft', 'sent', 'won', 'canceled']);
export const STATUS_LABEL = Object.freeze({ draft: '작성 중', sent: '발송', won: '수주', canceled: '취소' });
export const DEFAULT_VALID_DAYS = 14;
export const MAX_ITEMS = 100;
export const LIMITS = Object.freeze({
  company: 100, name: 50, phone: 40, email: 120, memo: 1000,
  terms: 300, itemName: 200, brand: 80, spec: 200, itemMemo: 300,
  qty: 99999, unit: 10_000_000_000, validDays: 365,
});

const text = (value) => (value == null ? '' : String(value)).trim();

function clipped(value, max) {
  const s = text(value);
  return [...s].length > max ? null : s;
}

function intOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[,\s원]/g, ''));
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return NaN;
  return n;
}

/** 할인 금액: amount 는 줄 금액을 넘지 않게, pct 는 0~100(소수 한 자리)을 1원 단위 반올림. */
export function discountAmount(gross, type, value) {
  const g = Math.max(0, Math.trunc(Number(gross) || 0));
  const v = Number(value) || 0;
  if (type === 'amount') return Math.min(g, Math.max(0, Math.trunc(v)));
  if (type === 'pct') return Math.min(g, Math.max(0, Math.round((g * Math.min(100, Math.max(0, v))) / 100)));
  return 0;
}

/**
 * 견적 계산. lines: [{ qty, unit(null=별도 견적), discount_type, discount_value }].
 * 반환 lines 의 supplied/vat/total 과 합계는 화면 computeQuote 와 같은 값이다.
 */
export function computeAdminQuote(lines) {
  const out = (lines || []).map((line, index) => {
    const qty = Math.max(1, Math.trunc(Number(line.qty) || 1));
    const unit = line.unit == null ? null : Math.max(0, Math.trunc(Number(line.unit) || 0));
    if (unit == null) {
      return { no: index + 1, qty, unit: null, priced: false, gross: null, discount: 0, supplied: null, vat: null, total: null };
    }
    const gross = unit * qty;
    const discount = discountAmount(gross, line.discount_type, line.discount_value);
    const total = gross - discount;
    const s = splitTax(total);
    return { no: index + 1, qty, unit, priced: true, gross, discount, supplied: s.suppliedAmount, vat: s.vatAmount, total };
  });
  const priced = out.filter((l) => l.priced);
  const grand = priced.reduce((sum, l) => sum + l.total, 0);
  const totals = splitTax(grand);
  const diff = totals.suppliedAmount - priced.reduce((sum, l) => sum + l.supplied, 0);
  if (diff !== 0 && priced.length) {
    const biggest = priced.reduce((a, b) => (b.total > a.total ? b : a), priced[0]);
    biggest.supplied += diff;
    biggest.vat -= diff;
  }
  return {
    lines: out,
    pricedCount: priced.length,
    inquiryCount: out.length - priced.length,
    supplied: totals.suppliedAmount,
    vat: totals.vatAmount,
    total: grand,
  };
}

/* ------------------------------------------------------------------ 날짜·번호 */

export function seoulYmd(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(ms));
}

export function addDaysYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

export function quoteNoPrefix(ymd) {
  return `Q-${ymd.slice(2, 4)}${ymd.slice(5, 7)}${ymd.slice(8, 10)}-`;
}

export function formatQuoteNo(ymd, seq) {
  return `${quoteNoPrefix(ymd)}${String(seq).padStart(3, '0')}`;
}

export const QUOTE_NO_RE = /^Q-\d{6}-\d{3,}$/;

/* ------------------------------------------------------------------ 입력 검증 */

/**
 * 본문을 검사해 저장할 값으로 바꾼다. priceIndex 로 카탈로그 단가를 확정한다.
 * 반환: { ok:true, quote, items } 또는 { ok:false, error, detail }
 */
export function validateQuoteBody(body, { priceIndex = {}, requireStatus = false } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const r = b.recipient && typeof b.recipient === 'object' ? b.recipient : {};
  const fail = (error, detail) => ({ ok: false, error, detail });

  const company = clipped(r.company, LIMITS.company);
  if (company === null) return fail('recipient_company_too_long', `회사·기관명은 ${LIMITS.company}자까지입니다.`);
  if (!company) return fail('recipient_company_required', '받는 곳(회사·기관명)을 입력해 주세요.');
  const name = clipped(r.name, LIMITS.name);
  const phone = clipped(r.phone, LIMITS.phone);
  const email = clipped(r.email, LIMITS.email);
  const memo = clipped(r.memo, LIMITS.memo);
  if (name === null || phone === null || email === null || memo === null) return fail('recipient_too_long', '받는 곳 입력이 너무 깁니다.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('recipient_email_invalid', '이메일 형식을 확인해 주세요.');
  if (phone && !/^[0-9+()\-.\s]{6,40}$/.test(phone)) return fail('recipient_phone_invalid', '연락처는 숫자와 - 로 입력해 주세요.');

  const validDays = b.valid_days == null || b.valid_days === '' ? DEFAULT_VALID_DAYS : Number(b.valid_days);
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > LIMITS.validDays) {
    return fail('valid_days_invalid', `유효기간은 1~${LIMITS.validDays}일입니다.`);
  }
  const delivery = clipped(b.delivery_terms, LIMITS.terms);
  const payment = clipped(b.payment_terms, LIMITS.terms);
  if (delivery === null || payment === null) return fail('terms_too_long', `납기·결제 조건은 ${LIMITS.terms}자까지입니다.`);

  let status = null;
  if (b.status != null && b.status !== '') {
    status = String(b.status);
    if (!STATUSES.includes(status)) return fail('status_invalid', '상태 값이 올바르지 않습니다.');
  } else if (requireStatus) {
    return fail('status_invalid', '상태 값이 올바르지 않습니다.');
  }

  const rawItems = Array.isArray(b.items) ? b.items : [];
  if (rawItems.length > MAX_ITEMS) return fail('too_many_items', `품목은 ${MAX_ITEMS}줄까지입니다.`);
  const items = [];
  for (let i = 0; i < rawItems.length; i += 1) {
    const it = rawItems[i] && typeof rawItems[i] === 'object' ? rawItems[i] : {};
    const where = `${i + 1}번째 줄`;
    const kind = it.kind === 'custom' ? 'custom' : 'product';
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > LIMITS.qty) return fail('qty_invalid', `${where}: 수량은 1~${LIMITS.qty} 사이 정수입니다.`);
    const productId = kind === 'product' ? text(it.product_id) : '';
    if (kind === 'product' && (!productId || productId.length > 200)) return fail('product_id_required', `${where}: 상품을 다시 골라 주세요.`);
    const entry = kind === 'product' ? priceIndex[productId] : null;
    const catalogUnit = entry && Number.isFinite(entry.p) && entry.p >= 0 ? Math.trunc(entry.p) : null;

    let unit;
    let unitSource;
    if (catalogUnit != null) {
      unit = catalogUnit; // 공개가 품목: 화면이 보낸 단가는 쓰지 않는다
      unitSource = 'catalog';
    } else {
      const manual = intOrNull(it.unit_price);
      if (Number.isNaN(manual) || (manual != null && manual > LIMITS.unit)) return fail('unit_price_invalid', `${where}: 단가는 0 이상의 정수(원)입니다.`);
      unit = manual;
      unitSource = manual == null ? 'inquiry' : 'manual';
    }

    const itemName = clipped(it.name, LIMITS.itemName);
    if (itemName === null) return fail('item_name_too_long', `${where}: 품명은 ${LIMITS.itemName}자까지입니다.`);
    const finalName = itemName || (entry && entry.n ? String(entry.n) : '');
    if (!finalName) return fail('item_name_required', `${where}: 품명을 입력해 주세요.`);
    const brand = clipped(it.brand, LIMITS.brand);
    const spec = clipped(it.spec, LIMITS.spec);
    const itemMemo = clipped(it.memo, LIMITS.itemMemo);
    if (brand === null || spec === null || itemMemo === null) return fail('item_too_long', `${where}: 입력이 너무 깁니다.`);

    const discountType = ['amount', 'pct'].includes(it.discount_type) ? it.discount_type : 'none';
    let discountValue = 0;
    if (discountType !== 'none') {
      discountValue = Number(it.discount_value);
      if (!Number.isFinite(discountValue) || discountValue < 0) return fail('discount_invalid', `${where}: 할인은 0 이상입니다.`);
      if (discountType === 'pct' && (discountValue > 100 || Math.round(discountValue * 10) !== discountValue * 10)) {
        return fail('discount_invalid', `${where}: 할인율은 0~100%, 소수 한 자리까지입니다.`);
      }
      if (discountType === 'amount' && !Number.isInteger(discountValue)) return fail('discount_invalid', `${where}: 할인 금액은 원 단위 정수입니다.`);
      if (discountType === 'amount' && unit != null && discountValue > unit * qty) {
        return fail('discount_invalid', `${where}: 할인 금액이 줄 금액보다 큽니다.`);
      }
    }

    items.push({
      line_no: i + 1,
      kind,
      product_id: productId || null,
      name: finalName,
      brand: brand || (entry && entry.b ? String(entry.b) : '') || null,
      spec: spec || null,
      qty,
      unit_price: unit,
      unit_source: unitSource,
      discount_type: discountType,
      discount_value: discountValue,
      memo: itemMemo || null,
    });
  }

  const calc = computeAdminQuote(items.map((it) => ({ qty: it.qty, unit: it.unit_price, discount_type: it.discount_type, discount_value: it.discount_value })));
  calc.lines.forEach((line, i) => {
    items[i].discount_amount = line.discount;
    items[i].supplied_amount = line.supplied;
    items[i].vat_amount = line.vat;
    items[i].total_amount = line.total;
  });

  return {
    ok: true,
    quote: {
      status,
      valid_days: validDays,
      recipient_company: company,
      recipient_name: name || null,
      recipient_phone: phone || null,
      recipient_email: email || null,
      recipient_memo: memo || null,
      delivery_terms: delivery || null,
      payment_terms: payment || null,
      supplied_amount: calc.supplied,
      vat_amount: calc.vat,
      total_amount: calc.total,
      item_count: items.length,
      inquiry_count: calc.inquiryCount,
    },
    items,
  };
}

/* ------------------------------------------------------------------ 화면용 모양 */

export function quoteView(row, items = null) {
  if (!row) return null;
  const view = {
    id: row.id,
    quote_no: row.quote_no,
    status: row.status,
    status_label: STATUS_LABEL[row.status] || row.status,
    quote_date: row.quote_date,
    valid_days: row.valid_days,
    valid_until: row.valid_until,
    recipient: {
      company: row.recipient_company,
      name: row.recipient_name || '',
      phone: row.recipient_phone || '',
      email: row.recipient_email || '',
      memo: row.recipient_memo || '',
    },
    delivery_terms: row.delivery_terms || '',
    payment_terms: row.payment_terms || '',
    supplied_amount: row.supplied_amount,
    vat_amount: row.vat_amount,
    total_amount: row.total_amount,
    item_count: row.item_count,
    inquiry_count: row.inquiry_count,
    source_quote_id: row.source_quote_id || null,
    ecount_status: row.ecount_status,
    created_by: row.created_by_label,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (items) {
    view.items = items.map((it) => ({
      line_no: it.line_no,
      kind: it.kind,
      product_id: it.product_id,
      name: it.name,
      brand: it.brand || '',
      spec: it.spec || '',
      qty: it.qty,
      unit_price: it.unit_price,
      unit_source: it.unit_source,
      discount_type: it.discount_type,
      discount_value: it.discount_value,
      discount_amount: it.discount_amount,
      memo: it.memo || '',
      supplied_amount: it.supplied_amount,
      vat_amount: it.vat_amount,
      total_amount: it.total_amount,
    }));
  }
  return view;
}

/* ------------------------------------------------------------------ D1 */

async function nextQuoteNo(db, ymd) {
  const prefix = quoteNoPrefix(ymd);
  const row = await db.prepare(
    'SELECT quote_no FROM admin_quotes WHERE quote_no LIKE ? ORDER BY LENGTH(quote_no) DESC, quote_no DESC LIMIT 1'
  ).bind(`${prefix}%`).first();
  const last = row ? Number(String(row.quote_no).slice(prefix.length)) || 0 : 0;
  return formatQuoteNo(ymd, last + 1);
}

function itemInsert(db, quoteId, it) {
  return db.prepare(
    `INSERT INTO admin_quote_items (quote_id, line_no, kind, product_id, name, brand, spec, qty, unit_price, unit_source,
       discount_type, discount_value, discount_amount, memo, supplied_amount, vat_amount, total_amount)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(quoteId, it.line_no, it.kind, it.product_id, it.name, it.brand, it.spec, it.qty, it.unit_price, it.unit_source,
    it.discount_type, it.discount_value, it.discount_amount, it.memo, it.supplied_amount, it.vat_amount, it.total_amount);
}

export async function getQuote(db, id) {
  const row = await db.prepare('SELECT * FROM admin_quotes WHERE id = ?').bind(id).first();
  if (!row) return null;
  const { results } = await db.prepare('SELECT * FROM admin_quote_items WHERE quote_id = ? ORDER BY line_no').bind(id).all();
  return quoteView(row, results || []);
}

/** 새 견적서. 번호가 겹치면(동시에 둘이 만들 때) 다음 번호로 다시 시도한다. */
export async function createQuote(db, checked, { actor, nowMs = Date.now(), sourceQuoteId = null } = {}) {
  const ymd = seoulYmd(nowMs);
  const ts = new Date(nowMs).toISOString();
  const q = checked.quote;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const quoteNo = await nextQuoteNo(db, ymd);
    let inserted;
    try {
      inserted = await db.prepare(
        `INSERT INTO admin_quotes (quote_no, status, quote_date, valid_days, valid_until, recipient_company, recipient_name,
           recipient_phone, recipient_email, recipient_memo, delivery_terms, payment_terms, supplied_amount, vat_amount,
           total_amount, item_count, inquiry_count, source_quote_id, ecount_status, created_by_id, created_by_label, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'not_sent',?,?,?,?)`
      ).bind(quoteNo, q.status || 'draft', ymd, q.valid_days, addDaysYmd(ymd, q.valid_days), q.recipient_company, q.recipient_name,
        q.recipient_phone, q.recipient_email, q.recipient_memo, q.delivery_terms, q.payment_terms, q.supplied_amount, q.vat_amount,
        q.total_amount, q.item_count, q.inquiry_count, sourceQuoteId, actor?.id ?? null, actor?.label || '관리자', ts, ts).run();
    } catch (error) {
      if (/UNIQUE/i.test(String(error && error.message))) continue;
      throw error;
    }
    const id = inserted?.meta?.last_row_id
      ?? (await db.prepare('SELECT id FROM admin_quotes WHERE quote_no = ?').bind(quoteNo).first())?.id;
    if (checked.items.length) await db.batch(checked.items.map((it) => itemInsert(db, id, it)));
    return getQuote(db, id);
  }
  throw new Error('quote_no_exhausted');
}

/** 내용 전체를 바꾼다(줄은 지우고 다시 넣음). 견적번호·견적일은 그대로, 유효기간은 견적일 기준으로 다시 센다. */
export async function updateQuote(db, id, checked, { nowMs = Date.now() } = {}) {
  const row = await db.prepare('SELECT * FROM admin_quotes WHERE id = ?').bind(id).first();
  if (!row) return null;
  const q = checked.quote;
  const ts = new Date(nowMs).toISOString();
  const statements = [
    db.prepare(
      `UPDATE admin_quotes SET status = ?, valid_days = ?, valid_until = ?, recipient_company = ?, recipient_name = ?,
         recipient_phone = ?, recipient_email = ?, recipient_memo = ?, delivery_terms = ?, payment_terms = ?,
         supplied_amount = ?, vat_amount = ?, total_amount = ?, item_count = ?, inquiry_count = ?, updated_at = ? WHERE id = ?`
    ).bind(q.status || row.status, q.valid_days, addDaysYmd(row.quote_date, q.valid_days), q.recipient_company, q.recipient_name,
      q.recipient_phone, q.recipient_email, q.recipient_memo, q.delivery_terms, q.payment_terms,
      q.supplied_amount, q.vat_amount, q.total_amount, q.item_count, q.inquiry_count, ts, id),
    db.prepare('DELETE FROM admin_quote_items WHERE quote_id = ?').bind(id),
    ...checked.items.map((it) => itemInsert(db, id, it)),
  ];
  await db.batch(statements);
  return getQuote(db, id);
}

export async function setQuoteStatus(db, id, status, { nowMs = Date.now() } = {}) {
  if (!STATUSES.includes(status)) return null;
  const done = await db.prepare('UPDATE admin_quotes SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status, new Date(nowMs).toISOString(), id).run();
  if (Number(done?.meta?.changes || 0) !== 1) return null;
  return getQuote(db, id);
}

/** 복제: 받는 곳·조건·줄을 그대로 새 '작성 중' 견적으로. 카탈로그 단가는 지금 공개가로 다시 확정된다. */
export function duplicateBody(view) {
  return {
    recipient: { ...view.recipient },
    valid_days: view.valid_days,
    delivery_terms: view.delivery_terms,
    payment_terms: view.payment_terms,
    status: 'draft',
    items: (view.items || []).map((it) => ({
      kind: it.kind,
      product_id: it.product_id,
      name: it.name,
      brand: it.brand,
      spec: it.spec,
      qty: it.qty,
      unit_price: it.unit_source === 'catalog' ? null : it.unit_price,
      discount_type: it.discount_type,
      discount_value: it.discount_value,
      memo: it.memo,
    })),
  };
}

export async function listQuotes(db, { q = '', status = '', limit = 200 } = {}) {
  const where = [];
  const binds = [];
  const term = text(q).slice(0, 100);
  if (term) {
    where.push('(quote_no LIKE ? OR recipient_company LIKE ? OR recipient_name LIKE ?)');
    const like = `%${term.replace(/[%_]/g, (ch) => `\\${ch}`)}%`;
    binds.push(like, like, like);
  }
  if (status && STATUSES.includes(status)) {
    where.push('status = ?');
    binds.push(status);
  }
  const lim = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 200)));
  const sql = `SELECT * FROM admin_quotes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`;
  const { results } = await db.prepare(term ? sql.replace(/LIKE \?/g, "LIKE ? ESCAPE '\\'") : sql).bind(...binds, lim).all();
  return (results || []).map((row) => quoteView(row));
}

/** 최근에 쓴 받는 곳(같은 회사·담당자·연락처·이메일은 한 번), 최근 순. */
export async function recentRecipients(db, { limit = 20 } = {}) {
  const lim = Math.min(50, Math.max(1, Math.trunc(Number(limit) || 20)));
  const { results } = await db.prepare(
    `SELECT recipient_company AS company, COALESCE(recipient_name,'') AS name, COALESCE(recipient_phone,'') AS phone,
            COALESCE(recipient_email,'') AS email, MAX(updated_at) AS last_used, COUNT(*) AS uses
       FROM admin_quotes
      GROUP BY recipient_company, COALESCE(recipient_name,''), COALESCE(recipient_phone,''), COALESCE(recipient_email,'')
      ORDER BY last_used DESC LIMIT ?`
  ).bind(lim).all();
  return results || [];
}
