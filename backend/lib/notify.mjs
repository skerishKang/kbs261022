import { createMailAdapter } from './mail.mjs';

export const OPS_EVENTS = Object.freeze({
  ORDER_PAID: 'order_paid',
  QUOTE_RECEIVED: 'quote_received',
  REFUND_COMPLETED: 'refund_completed',
  SIGNUP: 'signup',
  INQUIRY_RECEIVED: 'inquiry_received',
  PAYMENT_FAILED: 'payment_failed',
});

const WINDOW_MS = 30 * 60 * 1000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const USER_CANCEL_CODES = new Set(['PAY_PROCESS_CANCELED', 'USER_CANCELED', 'USER_CANCEL', 'USERCANCEL']);

function splitList(value) {
  return String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function won(value) {
  const n = Number(value);
  return `${(Number.isFinite(n) ? n : 0).toLocaleString('ko-KR')}원`;
}

function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function itemLines(items) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return '- (품목 없음)';
  return rows.map((item) => {
    const name = item.product_name || item.name || item.id || '상품';
    const qty = item.qty ?? '';
    const price = item.unit_price == null ? '' : ` ${won(item.unit_price)}`;
    return `- ${name} ${qty}개${price}`.trim();
  }).join('\n');
}

function siteBase(env) {
  return String(env.SITE_BASE_URL || env.MAIL_BASE_URL || 'https://cgishop.pages.dev/site').replace(/\/+$/, '');
}

function orderAdminUrl(env, id) {
  const base = `${siteBase(env)}/orders.html`;
  return id ? `${base}?order=${encodeURIComponent(id)}` : base;
}

function customerOrderUrl(env, id) {
  return `${siteBase(env)}/#/order/${encodeURIComponent(id)}`;
}

function opsCenterUrl(env) {
  return `${siteBase(env)}/staff.html`;
}

async function readSecret(env, name) {
  const value = env[name];
  if (value === undefined || value === null) return '';
  if (typeof value === 'object' && typeof value.get === 'function') {
    return String((await value.get()) ?? '');
  }
  return String(value);
}

async function telegramToken(env) {
  return (await readSecret(env, 'TELEGRAM_BOT_TOKEN')) || (await readSecret(env, 'B66_ALERT_TELEGRAM_BOT_TOKEN'));
}

function eventEnabled(event, env) {
  const raw = String(env.ORDER_NOTIFY_EVENTS ?? '').trim();
  if (!raw || raw.toLowerCase() === 'all') return true;
  const enabled = new Set(splitList(raw).map((s) => s.toLowerCase()));
  return enabled.has(event);
}

function buildMessages(event, payload, env) {
  const id = payload.subjectId || payload.orderId || payload.quoteId || payload.memberId || payload.receiptId || '';
  const adminUrl = payload.adminUrl || orderAdminUrl(env, id);
  const detailUrl = payload.detailUrl || customerOrderUrl(env, id);
  const opsUrl = payload.opsUrl || opsCenterUrl(env);
  const company = payload.company ? String(payload.company) : '';
  const name = payload.name ? String(payload.name) : '';
  const who = [company, name].filter(Boolean).join(' / ') || '-';

  if (event === OPS_EVENTS.ORDER_PAID) {
    const amount = won(payload.amount);
    return {
      subject: `[CGI 쇼핑몰] 새 주문 ${id} ${amount}`,
      text: `주문번호: ${id}\n결제 금액: ${amount}\n상품:\n${itemLines(payload.items)}\n고객: ${who}\n연락처: ${payload.phone || '-'} / ${payload.email || '-'}\n관리자 주문 화면: ${adminUrl}`,
      telegram: `[새 주문] ${id} ${amount}\n${who}\n${adminUrl}`,
      customer: payload.email ? {
        to: String(payload.email),
        subject: `[CGI] 주문이 완료되었습니다 - ${id}`,
        text: `주문번호: ${id}\n결제 금액: ${amount}\n상품:\n${itemLines(payload.items)}\n회사·연락처: ${who} ${payload.phone || ''}\n주문 상세: ${detailUrl}`,
        url: detailUrl,
      } : null,
    };
  }
  if (event === OPS_EVENTS.QUOTE_RECEIVED) {
    return {
      subject: `[CGI 쇼핑몰] 견적 요청 ${id}`,
      text: `접수번호: ${id}\n회사·담당자: ${who}\n연락처: ${payload.phone || '-'} / ${payload.email || '-'}\n품목:\n${itemLines(payload.items)}\n요청 서비스: ${splitList(payload.services).join(', ') || '-'}\n관리자 링크: ${adminUrl}`,
      telegram: `[견적 요청] ${id} ${who}\n요청 서비스: ${splitList(payload.services).join(', ') || '-'}\n${opsUrl}`,
    };
  }
  if (event === OPS_EVENTS.REFUND_COMPLETED) {
    return {
      subject: `[CGI 쇼핑몰] 환불·취소 완료 ${id}`,
      text: `주문번호: ${id}\n취소 금액: ${won(payload.cancelAmount)}\n남은 금액: ${won(payload.remainingAmount)}\n관리자 링크: ${adminUrl}`,
      telegram: `[환불·취소] ${id} 취소 ${won(payload.cancelAmount)} / 잔액 ${won(payload.remainingAmount)}\n${adminUrl}`,
    };
  }
  if (event === OPS_EVENTS.SIGNUP) {
    const source = payload.source || 'email';
    const joinedAt = payload.joinedAt || '-';
    return {
      subject: `[CGI 쇼핑몰] 신규 회원가입`,
      text: `가입 시각: ${joinedAt}\n회사·이름: ${who}\n가입 경로: ${source}\n이메일: ${payload.email || '-'}`,
      telegram: `[신규 가입] ${joinedAt} ${who} (${source})`,
    };
  }
  if (event === OPS_EVENTS.INQUIRY_RECEIVED) {
    return {
      subject: `[CGI 쇼핑몰] 고객 의견 ${id}`,
      text: `접수번호: ${id}\n종류: ${payload.kind || '-'}\n내용: ${clip(payload.body, 200)}\n운영센터 링크: ${opsUrl}`,
      telegram: `[고객 의견] ${id} ${payload.kind || '-'}\n${clip(payload.body, 200)}\n${opsUrl}`,
    };
  }
  if (event === OPS_EVENTS.PAYMENT_FAILED) {
    const code = String(payload.failureCode || 'PG_ERROR').slice(0, 80);
    return {
      subject: `[CGI 쇼핑몰] 결제 실패 ${id} ${code}`,
      text: `주문번호: ${id}\n실패 사유 코드: ${code}\n사유: ${clip(payload.reason || '', 200)}\n주문 상세: ${detailUrl}`,
      telegram: `[결제 실패] ${id} ${code}\n${detailUrl}`,
    };
  }
  return null;
}

async function lastOutbox(db, event, subjectId) {
  return db.prepare(
    'SELECT created_at FROM ops_notify_outbox WHERE event = ? AND subject_id = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(event, String(subjectId)).first();
}

async function deliverMail(mailAdapter, message) {
  if (!message || !message.to) return { skipped: true, reason: 'no_recipient' };
  try {
    const result = await mailAdapter.deliver(message);
    return { delivered: !!(result && result.delivered), channel: result && result.channel || 'mail' };
  } catch (e) {
    return { delivered: false, error: String(e && e.message || e).slice(0, 200) };
  }
}

async function deliverTelegram(fetchFn, token, chatId, text) {
  if (!token || !chatId || !text) return { skipped: true, reason: 'unconfigured' };
  try {
    const response = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    return { delivered: !!response && response.ok !== false, status: response && response.status || null };
  } catch (e) {
    return { delivered: false, error: String(e && e.message || e).slice(0, 200) };
  }
}

function buildPlan(stored, env, opts) {
  const message = stored.message;
  const recipients = Array.isArray(stored.recipients) ? stored.recipients : splitList(env.ORDER_NOTIFY_TO);
  const chatIds = Array.isArray(stored.chatIds) ? stored.chatIds : splitList(env.ORDER_NOTIFY_TELEGRAM_CHAT_IDS);
  const token = opts.token;
  const mailAdapter = opts.mailAdapter || createMailAdapter(env, () => {});
  const fetchFn = opts.fetchFn || fetch;
  const plan = [];
  for (const to of recipients) {
    plan.push({ kind: 'mail', channel: `mail:${to}`, target: to, send: () => deliverMail(mailAdapter, { ...message, to }) });
  }
  if (message.telegram) {
    for (const chatId of chatIds) {
      plan.push({
        kind: 'telegram',
        channel: `telegram:${chatId}`,
        target: chatId,
        send: () => deliverTelegram(fetchFn, token, chatId, message.telegram),
      });
    }
  }
  if (message.customer) {
    const to = message.customer.to;
    plan.push({
      kind: 'customer',
      channel: `customer_mail:${to}`,
      target: to,
      send: () => deliverMail(mailAdapter, message.customer),
    });
  }
  return plan;
}

async function dispatchOutbox(row, env, opts = {}) {
  const db = env.DB;
  let stored = {};
  try { stored = JSON.parse(row.payload || '{}'); } catch (e) { stored = {}; }
  if (!stored.message) return { mail: [], telegram: [], customer: null, outboxId: row.id, done: false };

  const plan = buildPlan(stored, env, { ...opts, token: await telegramToken(env) });
  let delivered = [];
  try {
    const rows = await db.prepare('SELECT channel FROM ops_notify_delivery WHERE outbox_id = ?').bind(row.id).all();
    delivered = (rows.results || []).map((r) => r.channel);
  } catch (e) {
    delivered = [];
  }
  const already = new Set(delivered);

  const mail = [];
  const telegram = [];
  let customer = null;
  for (const entry of plan) {
    let result;
    if (already.has(entry.channel)) {
      result = { skipped: true, reason: 'already_delivered' };
    } else {
      result = await entry.send();
      if (result.delivered) {
        try {
          await db.prepare(
            'INSERT OR IGNORE INTO ops_notify_delivery (outbox_id, channel, delivered_at) VALUES (?,?,?)'
          ).bind(row.id, entry.channel, new Date().toISOString()).run();
        } catch (e) {
          result = { ...result, ledger_error: String(e && e.message || e).slice(0, 200) };
        }
      }
    }
    const targetResult = { ...result, [entry.kind === 'telegram' ? 'chat_id' : 'to']: entry.target };
    if (entry.kind === 'telegram') telegram.push(targetResult);
    else if (entry.kind === 'customer') customer = targetResult;
    else mail.push(targetResult);
  }

  let done = false;
  try {
    const counted = await db.prepare('SELECT COUNT(*) AS n FROM ops_notify_delivery WHERE outbox_id = ?').bind(row.id).first();
    if (Number(counted && counted.n) >= plan.length) {
      await db.prepare('UPDATE ops_notify_outbox SET done_at = ? WHERE id = ? AND done_at IS NULL')
        .bind(new Date().toISOString(), row.id).run();
      done = true;
    }
  } catch (e) {
    done = false;
  }
  return { mail, telegram, customer, outboxId: row.id, done };
}

export async function notifyOps(event, payload = {}) {
  const env = payload.env;
  if (!env || !env.DB) return { skipped: true, reason: 'no_env' };
  if (!eventEnabled(event, env)) return { skipped: true, reason: 'event_disabled' };
  if (event === OPS_EVENTS.PAYMENT_FAILED && USER_CANCEL_CODES.has(String(payload.failureCode || '').toUpperCase())) {
    return { skipped: true, reason: 'user_cancel' };
  }

  const now = typeof payload.now === 'function' ? payload.now() : new Date();
  const subjectId = payload.subjectId || payload.orderId || payload.quoteId || payload.memberId || payload.receiptId || '';
  if (!subjectId) return { skipped: true, reason: 'no_subject' };

  const message = buildMessages(event, payload, env);
  if (!message) return { skipped: true, reason: 'unknown_event' };

  const db = env.DB;
  try {
    const prior = await lastOutbox(db, event, subjectId);
    if (prior) {
      if (event !== OPS_EVENTS.PAYMENT_FAILED) return { skipped: true, reason: 'duplicate' };
      const at = Date.parse(prior.created_at);
      if (Number.isFinite(at) && now.getTime() - at < WINDOW_MS) {
        return { skipped: true, reason: 'within_window' };
      }
    }
  } catch (e) {
    return { skipped: true, reason: 'dedupe_unavailable' };
  }

  const stored = {
    event,
    subjectId: String(subjectId),
    message,
    recipients: splitList(env.ORDER_NOTIFY_TO),
    chatIds: splitList(env.ORDER_NOTIFY_TELEGRAM_CHAT_IDS),
  };
  let outboxId = null;
  try {
    const inserted = await db.prepare(
      'INSERT INTO ops_notify_outbox (event, subject_id, payload, created_at) VALUES (?,?,?,?)'
    ).bind(event, String(subjectId), JSON.stringify(stored), (typeof payload.now === 'function' ? now : new Date()).toISOString()).run();
    const meta = inserted && inserted.meta;
    outboxId = meta && (meta.last_row_id ?? meta.lastInsertRowid);
    if (!outboxId) {
      const found = await db.prepare(
        'SELECT id FROM ops_notify_outbox WHERE event = ? AND subject_id = ? ORDER BY id DESC LIMIT 1'
      ).bind(event, String(subjectId)).first();
      outboxId = found && found.id;
    }
  } catch (e) {
    return { skipped: true, reason: 'outbox_unavailable' };
  }

  const dispatch = await dispatchOutbox({ id: outboxId, payload: JSON.stringify(stored) }, env, payload);
  return { event, subjectId, outboxId, ...dispatch };
}

export async function retryPendingNotifications(env, { limit = 20, now = new Date(), mailAdapter = null, fetchFn = null } = {}) {
  if (!env || !env.DB) return { processed: 0, sent: 0, failed: 0 };
  const since = new Date(now.getTime() - RETENTION_MS).toISOString();
  let rows;
  try {
    const result = await env.DB.prepare(
      'SELECT id, event, payload FROM ops_notify_outbox WHERE done_at IS NULL AND created_at >= ? ORDER BY created_at ASC LIMIT ?'
    ).bind(since, Math.max(1, Math.min(Number(limit) || 20, 100))).all();
    rows = result.results || [];
  } catch (e) {
    return { processed: 0, sent: 0, failed: 0 };
  }

  let processed = 0;
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    if (!eventEnabled(row.event, env)) continue;
    processed += 1;
    try {
      const result = await dispatchOutbox(row, env, { mailAdapter, fetchFn });
      for (const item of [...result.mail, ...result.telegram, ...(result.customer ? [result.customer] : [])]) {
        if (item.delivered) sent += 1;
        else if (!item.skipped) failed += 1;
      }
    } catch (e) {
      failed += 1;
    }
  }
  return { processed, sent, failed };
}
