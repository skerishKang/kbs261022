// Cloudflare Worker + D1 backend for the CGI storefront.
// Deploy with: wrangler deploy
//
// Routes
//   POST   /api/quotes               (public)  existing quote intake
//   GET    /api/quotes               (admin)
//   GET    /api/quotes/:id           (admin)
//   PATCH  /api/quotes/:id           (admin)
//   POST   /api/orders               (public)  create order (idempotent)
//   GET    /api/orders/:id           (public)  customer order lookup
//   POST   /api/payments/confirm     (public)  PG approve + server amount check
//   GET    /api/orders               (admin)   list/search
//   PATCH  /api/orders/:id           (admin)   status / delivery / note
//   GET    /api/orders/:id/events    (admin)   audit trail
//   POST   /api/orders/:id/quote/prices (admin) confirm prices, optional convert
//   POST   /api/orders/:id/payments/:paymentKey/cancel (admin) refund
//   POST   /api/orders/:id/erp       (admin)   build + transmit ERP payload
//   POST   /api/orders/:id/erp/retry (admin)   retry ERP sync
//   POST   /api/admin/ecount/item-mappings/import (admin) import reviewed CSV approvals
//   GET    /api/admin/health         (admin)   mode readout, no secrets
//
// Customer accounts (issue #69) - cookie session + X-CSRF-Token, origin pinned:
//   POST   /api/auth/signup
//   POST   /api/auth/email-available
//   POST   /api/auth/verify-email
//   POST   /api/auth/resend-verification
//   POST   /api/auth/login
//   POST   /api/auth/logout
//   POST   /api/auth/password-reset/request
//   POST   /api/auth/password-reset/confirm
//   GET    /api/me                    profile
//   PATCH  /api/me                    update name / phone / company
//   DELETE /api/me                    delete account
//   POST   /api/me/password           change password
//   GET|POST   /api/me/addresses
//   PATCH|DELETE /api/me/addresses/:id
//   GET    /api/me/orders             my orders
//   GET    /api/me/orders/:id         my order detail
//   POST   /api/me/orders/:id/cancel  cancel an awaiting_payment order
//   POST   /api/me/orders/:id/repay   re-open PG payment for an unpaid order
//   POST   /api/me/orders/:id/refund/request  request a refund
//   GET    /api/me/quotes             my quote requests
//   GET    /api/me/quotes/:id         my quote detail
//
// Required secrets: ADMIN_TOKEN
// Optional secrets: TOSS_WIDGET_SECRET_KEY, TOSS_API_SECRET_KEY,
//                   ERP_OAPI_BASE_URL, ERP_OAPI_TOKEN
// Optional auth vars: AUTH_SESSION_COOKIE, AUTH_COOKIE_SECURE, AUTH_ORIGIN_STRICT,
//                     AUTH_CSRF_TOKEN, AUTH_PBKDF2_ITERATIONS, AUTH_SESSION_TTL_DAYS,
//                     AUTH_RATE_LIMIT_MAX, AUTH_RATE_LIMIT_WINDOW_SECONDS,
//                     EMAIL_VERIFY_REQUIRED, MAIL_MODE, MAIL_BASE_URL

import { computeTotals, cartHash, nextOrderId, toNonNegInt, isValidPgOrderId } from './lib/pricing.mjs';
import {
  initialStatus,
  isTransitionAllowed,
  isStatusKnown,
  isTerminalStatus,
  knownStatuses,
  ORDER_TRANSITIONS,
  DELIVERY_STATUSES,
  deliveryStatusFor,
  deliveryStatusOnTransition,
  paymentStatusFor,
  ORDER_STATUS_LABELS,
} from './lib/orders.mjs';
import { createPgAdapter } from './lib/pg.mjs';
import {
  NicepayApiError,
  createNicepayAdapter,
  createNicepayMockAdapter,
} from './lib/pg-nicepay-adapter.mjs';
import { cancelAmountOf } from './lib/pg-nicepay.mjs';
import { resolveNicepayEnv } from './lib/pg-nicepay-env.mjs';
import { erpCodeFor } from './lib/erp.mjs';
import {
  ECOUNT_ORDER_ACTION,
  ECOUNT_ORDER_ADAPTER,
  ecountOrderDedupeKey,
  ecountOrderMode,
  prepareEcountSaleOrder,
  transmitEcountSaleOrder,
} from './lib/ecount-order-adapter.mjs';
import {
  loadApprovedEcountItemMap,
  parseApprovedEcountMappingCsv,
  sha256Hex,
} from './lib/ecount-item-mapping.mjs';
import { PRICE_INDEX, PRICE_INDEX_META } from './data/price_index.mjs';
import {
  AUTH_POLICY,
  hashPassword,
  verifyPassword,
  randomToken,
  tokenDigest,
  validateEmail,
  validateName,
  validatePhone,
  validateOptionalText,
  validateText,
  validatePassword,
} from './lib/auth.mjs';
import { GOOGLE_SIGNUP_PASSWORD_SENTINEL } from './lib/migrate.mjs';
import { purgeExpiredShopLogs } from './lib/retention.mjs';
import { createMailAdapter } from './lib/mail.mjs';
import { createOAuthState, decodeOAuthState, normalizeOAuthReturn, resolveOAuthRedirect, buildAuthorizationUrl, exchangeCode, fetchUserInfo, OAUTH_STATE_COOKIE, oauthStateCookieOptions } from './lib/google-oauth.mjs';

const DEFAULT_ALLOWED_ORIGIN = 'https://cgishop.pages.dev';
const DEFAULT_SITE_BASE_URL = 'https://cgishop.pages.dev/site';
const MAX_BODY_BYTES = 64 * 1024;
const DUPLICATE_WINDOW_SECONDS = 120;
// Smallest partial refund the backend will accept (KRW). Anything below this is
// rounding dust rather than a refund; override with the MIN_PARTIAL_REFUND var.
const MIN_PARTIAL_REFUND = 1000;
const BACKEND_VERSION = '1.5.1';
const SUPERADMIN_EMAILS = new Set(['charliekant@gmail.com', 'skerish@naver.com']);

// Legacy credential-free header set: quote intake, order, payment and admin
// routes. Kept exactly as it is because they are not cookie-based, and because
// the CORS regression test asserts that these routes never grant credentials.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': DEFAULT_ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,Idempotency-Key,X-CSRF-Token',
  'Vary': 'Origin',
};

// Customer account routes (/api/auth/*, /api/me/*) authenticate with a session
// cookie, so they additionally advertise DELETE and credentials. ACAO stays
// pinned to the single production origin and is never echoed.
const CORS_HEADERS_CREDENTIALS = {
  ...CORS_HEADERS,
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Credentials': 'true',
};

export function isAuthPath(pathname) {
  return pathname === '/api/auth' || pathname.startsWith('/api/auth/') || pathname === '/api/me' || pathname.startsWith('/api/me/');
}

// A cookie-authenticated admin request always carries the custom CSRF header,
// so the preflight can opt into credentialed CORS without widening every
// legacy route. Public guest calls keep the credential-free response.
function preflightWantsCredentials(request) {
  const requested = String(request.headers.get('Access-Control-Request-Headers') || '').toLowerCase();
  return requested.split(',').map((h) => h.trim()).includes('x-csrf-token');
}

function corsHeadersFor(pathname, request) {
  return isAuthPath(pathname) || (request && preflightWantsCredentials(request))
    ? CORS_HEADERS_CREDENTIALS
    : CORS_HEADERS;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function json(data, status = 200, extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extra };
  if (status === 204) return new Response(null, { status, headers });
  return new Response(JSON.stringify(data), { status, headers });
}

function badRequest(error, detail) {
  return json({ error, ...(detail ? { detail } : {}) }, 400);
}

function conflict(error, detail) {
  return json({ error, ...(detail ? { detail } : {}) }, 409);
}

function unauthorized() {
  return json({ error: 'unauthorized' }, 401);
}

function notFound() {
  return json({ error: 'not found' }, 404);
}

function isAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  return !!env.ADMIN_TOKEN && token === env.ADMIN_TOKEN;
}

async function isSuperAdmin(request, db, env) {
  if (isAdmin(request, env)) return true;
  // Cookie-authenticated staff requests are browser state and must clear the
  // same Origin + X-CSRF-Token gate as /api/me; otherwise a malicious page
  // could fire refund / quote-convert / ERP-resend calls with a live session.
  const origin = request.headers.get('Origin');
  if (!origin || !csrfOk(request, env)) return false;
  const member = await requireMember(request, db, env);
  if (!member || member.status !== 'active' || !member.email_verified_at) return false;
  const email = String(member.email || '').trim().toLowerCase();
  return SUPERADMIN_EMAILS.has(email) || member.role === 'superadmin';
}

async function isAdminOrMember(request, db, env) {
  if (isAdmin(request, env)) return true;
  const origin = request.headers.get('Origin');
  if (!origin || !csrfOk(request, env)) return false;
  const member = await requireMember(request, db, env);
  if (!member) return false;
  if (member.status !== 'active') return false;
  if (!member.email_verified_at) return false;
  const role = member.role || (SUPERADMIN_EMAILS.has(String(member.email || '').trim().toLowerCase()) ? 'superadmin' : 'member');
  return role === 'admin' || role === 'superadmin';
}

/** Quote intake shared validation (guest + member): the privacy consent gate
 *  and the optional invoice / public-procurement fields. */
function validateQuoteIntake(body) {
  if (body.privacy_consent !== true) {
    return { error: 'privacy consent required', detail: '개인정보 수집·이용 동의가 필요합니다.' };
  }
  const invoiceType = body.invoice_type == null || body.invoice_type === '' ? null : String(body.invoice_type);
  if (invoiceType !== null && !['none', 'tax_invoice', 'cash_receipt'].includes(invoiceType)) {
    return { error: 'invalid invoice_type' };
  }
  const bizNoRaw = body.biz_no == null || body.biz_no === '' ? null : String(body.biz_no).trim().slice(0, 20);
  const bizNo = bizNoRaw === null ? null : bizNoRaw.replace(/[^0-9]/g, '');
  if (bizNoRaw !== null && !/^[0-9]{10}$/.test(bizNo)) return { error: 'invalid biz_no', detail: '사업자등록번호는 10자리 숫자입니다.' };
  if (invoiceType === 'tax_invoice' && !bizNo) return { error: 'biz_no required', detail: '세금계산서 발행에는 사업자등록번호가 필요합니다.' };
  const agencyNo = body.agency_no == null || body.agency_no === '' ? null : String(body.agency_no).trim().slice(0, 40);
  return { ok: true, privacy_consent: 1, invoice_type: invoiceType, biz_no: bizNo, agency_no: agencyNo };
}

/** Guest quote intake field checks: same caps the order path applies to the
 *  same customer fields, plus a bounded item list. */
function validateQuoteFields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid body' };
  if (!Array.isArray(body.items) || !body.items.length) return { error: 'items required' };
  if (body.items.length > 100) return { error: 'too many items', detail: 'maximum 100 items per quote request' };
  if (!body.items.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
    return { error: 'invalid item' };
  }
  const company = validateText(body.company, 'company', 200);
  if (!company.ok) return { error: company.error, detail: company.detail };
  const name = validateText(body.name, 'name', 100);
  if (!name.ok) return { error: name.error, detail: name.detail };
  const phone = validateText(body.phone, 'phone', 40);
  if (!phone.ok) return { error: phone.error, detail: phone.detail };
  const email = body.email == null || String(body.email).trim() === ''
    ? { ok: true, value: null }
    : validateOptionalText(body.email, 'email', 200);
  if (email.error) return { error: email.error, detail: email.detail };
  const location = validateOptionalText(body.location, 'location', 200);
  if (location.error) return { error: location.error, detail: location.detail };
  const note = validateOptionalText(body.note, 'note', 2000);
  if (note.error) return { error: note.error, detail: note.detail };
  const services = Array.isArray(body.services)
    ? body.services.filter((s) => typeof s === 'string').slice(0, 20)
    : [];
  return {
    ok: true,
    company: company.value, name: name.value, phone: phone.value,
    email: email.value, location: location.value, note: note.value, services,
  };
}

async function readJson(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY_BYTES) return { error: 'body too large' };
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) return { error: 'body too large' };
  if (buffer.byteLength === 0) return { body: {} };
  // A body that is not announced as JSON is not parsed as JSON: a cross-site
  // HTML form can post text/plain or form-encoded data without a preflight, and
  // accepting it would reopen the CSRF hole this header check closes.
  const type = String(request.headers.get('Content-Type') || '').toLowerCase();
  if (!type.includes('application/json')) {
    return { error: 'content_type_json_required', detail: 'JSON 헤더를 보내주세요' };
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (e) {
    // A body that is not valid UTF-8 decodes to U+FFFD, and that substitution is
    // irreversible once stored. Refuse it here rather than per field.
    return { error: 'body must be valid utf-8' };
  }
  if (!text.trim()) return { body: {} };
  try {
    return { body: JSON.parse(text) };
  } catch (e) {
    return { error: 'invalid json' };
  }
}

const nowIso = () => new Date().toISOString();

function shiftIso(now, deltaSeconds) {
  return new Date(new Date(now).getTime() + deltaSeconds * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// order item normalization (server is authoritative on prices)
// ---------------------------------------------------------------------------

/**
 * Normalize client items. The Worker looks up every price in PRICE_INDEX and
 * ignores client-supplied prices entirely, so a tampered browser cannot change
 * what it pays for or what is recorded.
 */
function normalizeItems(rawItems) {
  if (!Array.isArray(rawItems) || !rawItems.length) {
    return { error: 'items required', detail: 'at least one item is required' };
  }
  if (rawItems.length > 100) {
    return { error: 'too many items', detail: 'maximum 100 items per order' };
  }

  const items = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') return { error: 'invalid item' };
    const productId = String(raw.product_id != null ? raw.product_id : raw.id != null ? raw.id : '').trim();
    if (!productId) return { error: 'invalid item', detail: 'product_id is required' };

    const qty = Math.max(1, toNonNegInt(raw.qty, 1));
    if (qty > 9999) return { error: 'invalid item', detail: 'quantity must be 1..9999' };

    const entry = PRICE_INDEX[productId];
    const unitPrice = entry ? entry.p : null;
    const priceState = entry ? 'public' : 'inquiry';

    // Reject an explicit client price that disagrees with the catalog.
    const clientPrice = raw.unit_price != null ? raw.unit_price : raw.unitPrice;
    if (clientPrice !== undefined && clientPrice !== null && clientPrice !== '' && entry) {
      if (toNonNegInt(clientPrice) !== entry.p) {
        return { error: 'price mismatch', detail: `server price for ${productId} is ${entry.p}` };
      }
    }

    items.push({
      product_id: productId,
      product_name: entry && entry.n ? entry.n : String(raw.name || raw.product_name || productId).slice(0, 120),
      brand: entry && entry.b ? entry.b : (String(raw.brand || '').slice(0, 60) || null),
      category: raw.category ? String(raw.category).slice(0, 120) : null,
      option_label: raw.option_label ? String(raw.option_label).slice(0, 120) : null,
      price_state: priceState,
      unit_price: unitPrice,
      qty,
    });
  }
  return { items, cart_hash: cartHash(items) };
}

function customerFrom(body) {
  return {
    customer_company: String(body.company || body.customer_company || '').slice(0, 200),
    customer_name: String(body.name || body.customer_name || '').slice(0, 100),
    customer_phone: String(body.phone || body.customer_phone || '').slice(0, 40),
    customer_email: body.email || body.customer_email ? String(body.email || body.customer_email).slice(0, 200) : null,
    customer_addr: body.addr || body.customer_addr || body.location ? String(body.addr || body.customer_addr || body.location).slice(0, 200) : null,
    customer_addr_detail: body.addr_detail || body.customer_addr_detail ? String(body.addr_detail || body.customer_addr_detail).slice(0, 200) : null,
    customer_note: body.note ? String(body.note).slice(0, 2000) : null,
  };
}

function customerValid(c) {
  return !!c.customer_company && !!c.customer_name && !!c.customer_phone;
}

// ---------------------------------------------------------------------------
// order read/write
// ---------------------------------------------------------------------------

const ORDER_COLUMNS = `id, kind, idempotency_key, cart_hash, status, created_at, updated_at,
  customer_company, customer_name, customer_phone, customer_email, customer_addr, customer_addr_detail,
  customer_note, services, item_total, shipping_fee, total_amount, supplied_amount, vat_amount,
  payment_status, payment_method, payment_key, paid_at, refunded_amount,
  delivery_status, delivery_tracking, admin_prices, admin_note, erp_status, erp_sent_at, source_quote_id,
  customer_id`;

async function getOrder(db, id) {
  const row = await db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`).bind(id).first();
  return row || null;
}

async function getOrderItems(db, orderId) {
  const { results } = await db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY seq').bind(orderId).all();
  return results || [];
}

async function getOrderFull(db, id) {
  const order = await getOrder(db, id);
  if (!order) return null;
  const items = await getOrderItems(db, id);
  return { ...order, items };
}

function minimalOrderView(order) {
  if (!order) return null;
  return {
    id: order.id,
    kind: order.kind,
    status: order.status,
    status_label: ORDER_STATUS_LABELS[order.status] || order.status,
    payment_status: order.payment_status,
    delivery_status: order.delivery_status,
    created_at: order.created_at,
    restricted: true,
    note: '이메일 확인이 필요한 조회입니다. 주문 시 입력한 이메일과 함께 다시 요청하세요.',
  };
}

function publicOrderView(order, items) {
  if (!order) return null;
  return {
    id: order.id,
    kind: order.kind,
    status: order.status,
    payment_status: order.payment_status,
    delivery_status: order.delivery_status,
    status_label: ORDER_STATUS_LABELS[order.status] || order.status,
    created_at: order.created_at,
    updated_at: order.updated_at,
    customer: {
      company: order.customer_company,
      name: order.customer_name,
      phone: order.customer_phone,
      email: order.customer_email,
      addr: order.customer_addr,
      addr_detail: order.customer_addr_detail,
      note: order.customer_note,
    },
    totals: {
      item_total: order.item_total,
      shipping_fee: order.shipping_fee,
      total_amount: order.total_amount,
      supplied_amount: order.supplied_amount,
      vat_amount: order.vat_amount,
      refunded_amount: order.refunded_amount,
    },
    payable: order.kind === 'purchase' && order.payment_status === 'pending' && order.status === 'awaiting_payment',
    payment: {
      status: order.payment_status,
      method: order.payment_method,
      payment_key: order.payment_key,
      paid_at: order.paid_at,
    },
    delivery: {
      status: order.delivery_status,
      tracking: order.delivery_tracking,
    },
    erp_status: order.erp_status,
    erp_sent_at: order.erp_sent_at,
    source_quote_id: order.source_quote_id,
    customer_id: order.customer_id == null ? null : Number(order.customer_id),
    items: (items || order.items || []).map((item) => ({
      product_id: item.product_id,
      product_name: item.product_name,
      brand: item.brand,
      category: item.category,
      option_label: item.option_label,
      price_state: item.price_state,
      unit_price: item.unit_price,
      qty: item.qty,
      line_total: item.line_total,
    })),
  };
}

async function createOrder(db, body, env, options = {}) {
  const normalized = normalizeItems(body.items);
  if (normalized.error) return { status: 400, body: { error: normalized.error, detail: normalized.detail } };

  const customer = customerFrom(body);
  if (!customerValid(customer)) {
    return { status: 400, body: { error: 'company, name, phone required' } };
  }

  // 주문 직전 필수 동의(2026-11-04 대표 결정). 클라이언트 체크만으로 끝내지 않고
  // 서버에서도 두 동의가 모두 true 일 때만 주문을 만든다. 동의 시각을 저장할
  // orders 컬럼은 아직 없으므로 여기서는 생성 차단만 한다.
  if (body.terms_consent !== true || body.privacy_consent !== true) {
    return { status: 400, body: { error: 'order consent required', detail: '주문 조건 및 개인정보 수집·이용 동의가 필요합니다.' } };
  }

  const services = Array.isArray(body.services) ? body.services.filter((s) => typeof s === 'string').slice(0, 20) : [];
  const idempotencyKey = String(body.idempotency_key || options.idempotencyKey || '').slice(0, 100);

  // Idempotent retry: the same key returns the order it already created, so a
  // network retry never produces a second order.
  if (idempotencyKey) {
    const existing = await db.prepare('SELECT id FROM orders WHERE idempotency_key = ?').bind(idempotencyKey).first();
    if (existing) {
      const full = await getOrderFull(db, existing.id);
      return { status: 200, body: { idempotent: true, ...publicOrderView(full, full.items) } };
    }
  }

  // Duplicate-order prevention (second layer, in addition to the idempotency key).
  if (!body.allow_duplicate) {
    const now = nowIso();
    const cutoff = shiftIso(now, -DUPLICATE_WINDOW_SECONDS);
    const hit = await db
      .prepare('SELECT id FROM orders WHERE cart_hash = ? AND customer_phone = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1')
      .bind(normalized.cart_hash, customer.customer_phone, cutoff)
      .first();
    if (hit) {
      return {
        status: 409,
        body: { error: 'duplicate_order', existing_id: hit.id, detail: 'same cart was ordered recently; send allow_duplicate=true to proceed' },
      };
    }
  }

  const shippingFee = toNonNegInt(env.SHIPPING_FEE_DEFAULT, 0);
  const totals = computeTotals(normalized.items, { shippingFee });
  const kind = totals.payable && totals.total_amount > 0 ? 'purchase' : 'quote';
  const orderStatus = initialStatus(kind);
  const paymentStatus = paymentStatusFor(orderStatus);
  const orderNumber = options.orderId || nextOrderId(options.now || new Date(), options.randomFn || ((buf) => crypto.getRandomValues(buf)));

  if (!isValidPgOrderId(orderNumber)) {
    return { status: 500, body: { error: 'invalid order id generated' } };
  }

  const createdAt = options.now ? options.now.toISOString() : nowIso();
  const cartHashValue = normalized.cart_hash;

  const items = totals.lines.map((line, index) => {
    const src = normalized.items[index];
    return {
      seq: line.seq,
      product_id: src.product_id,
      product_name: src.product_name,
      brand: src.brand,
      category: src.category,
      option_label: src.option_label,
      price_state: src.price_state,
      unit_price: line.unit_price,
      qty: line.qty,
      line_total: line.line_total,
      erp_code: erpCodeFor(src.product_id),
    };
  });

  const orderRow = {
    id: orderNumber,
    kind,
    idempotency_key: idempotencyKey || null,
    cart_hash: cartHashValue,
    status: orderStatus,
    created_at: createdAt,
    updated_at: createdAt,
    ...customer,
    customer_id: options.customerId == null ? null : Number(options.customerId),
    services: JSON.stringify(services),
    item_total: totals.item_total,
    shipping_fee: totals.shipping_fee,
    total_amount: totals.total_amount,
    supplied_amount: totals.supplied_amount,
    vat_amount: totals.vat_amount,
    payment_status: paymentStatus,
    payment_method: null,
    payment_key: null,
    paid_at: null,
    refunded_amount: 0,
    delivery_status: 'pending',
    delivery_tracking: null,
    admin_prices: null,
    admin_note: null,
    erp_status: 'not_sent',
    erp_sent_at: null,
    source_quote_id: null,
    terms_consent: 1,
    privacy_consent: 1,
    consent_at: createdAt,
  };

  try {
    await db.batch([
       db.prepare(
         `INSERT INTO orders (id, kind, idempotency_key, cart_hash, status, created_at, updated_at,
           customer_company, customer_name, customer_phone, customer_email, customer_addr, customer_addr_detail,
           customer_note, services, item_total, shipping_fee, total_amount, supplied_amount, vat_amount,
           payment_status, erp_status, source_quote_id, customer_id,
           terms_consent, privacy_consent, consent_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
       ).bind(
         orderRow.id, orderRow.kind, orderRow.idempotency_key, orderRow.cart_hash, orderRow.status,
         orderRow.created_at, orderRow.updated_at, orderRow.customer_company, orderRow.customer_name,
         orderRow.customer_phone, orderRow.customer_email, orderRow.customer_addr, orderRow.customer_addr_detail,
         orderRow.customer_note, orderRow.services, orderRow.item_total, orderRow.shipping_fee, orderRow.total_amount,
         orderRow.supplied_amount, orderRow.vat_amount, orderRow.payment_status, orderRow.erp_status, orderRow.source_quote_id,
         orderRow.customer_id, orderRow.terms_consent, orderRow.privacy_consent, orderRow.consent_at
       ),
      db.prepare(
        'INSERT INTO order_events (order_id, type, actor, from_status, to_status, meta, created_at) VALUES (?,?,?,?,?,?,?)'
      ).bind(orderRow.id, 'created', 'customer', null, orderRow.status, JSON.stringify({ kind, total: orderRow.total_amount }), orderRow.created_at),
      ...items.map((item) =>
        db.prepare(
          `INSERT INTO order_items (order_id, seq, product_id, product_name, brand, category, option_label,
             price_state, unit_price, qty, line_total, erp_code)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          orderRow.id, item.seq, item.product_id, item.product_name, item.brand, item.category, item.option_label,
          item.price_state, item.unit_price, item.qty, item.line_total, item.erp_code
        )
      ),
    ]);
  } catch (e) {
    // Never echo the D1 message: it can name constraints, columns or row values.
    return { status: 500, body: { error: 'order insert failed' } };
  }

  // A quote order also writes the existing quote_requests row so the legacy
  // staff quote tool keeps working. The link is stored on orders.source_quote_id.
  let linkedQuote = null;
  if (kind === 'quote') {
    linkedQuote = await mirrorQuoteRequest(db, orderRow, items, services);
    if (linkedQuote) {
      await db.prepare('UPDATE orders SET source_quote_id = ?, updated_at = ? WHERE id = ?')
        .bind(linkedQuote.id, nowIso(), orderRow.id).run();
    }
  }

  const full = await getOrderFull(db, orderRow.id);
  return { status: 201, body: { ...publicOrderView(full, full.items), linked_quote_id: linkedQuote ? linkedQuote.id : null } };
}

/** Mirror a quote order into the existing quote_requests table. */
async function mirrorQuoteRequest(db, orderRow, items, services) {
  const quoteId = 'Q-' + orderRow.id.slice(-13);
  const quoteItems = items.map((item) => ({
    id: item.product_id,
    name: item.product_name,
    brand: item.brand,
    category: item.category,
    qty: item.qty,
    publicPrice: item.unit_price == null ? null : item.unit_price,
  }));
  const createdAt = orderRow.created_at;
  try {
    await db.prepare(
      `INSERT INTO quote_requests (id, created_at, company, contact_name, phone, email, location, note, services, items, status, member_id, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      quoteId, createdAt, orderRow.customer_company, orderRow.customer_name, orderRow.customer_phone,
      orderRow.customer_email, orderRow.customer_addr, orderRow.customer_note,
      JSON.stringify(services), JSON.stringify(quoteItems), 'received',
      orderRow.customer_id == null ? null : Number(orderRow.customer_id), createdAt
    ).run();
    return { id: quoteId };
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// payment
// ---------------------------------------------------------------------------

async function confirmPayment(db, body, env, pg) {
  const orderId = String(body.orderId || body.order_id || '').slice(0, 64);
  const paymentKey = String(body.paymentKey || body.payment_key || '').slice(0, 200);
  if (!orderId || !paymentKey) return { status: 400, body: { error: 'orderId and paymentKey required' } };

  const order = await getOrder(db, orderId);
  if (!order) return { status: 404, body: { error: 'order not found' } };

  if (order.kind !== 'purchase') {
    return { status: 409, body: { error: 'quote_order_not_payable', detail: 'this order has no confirmed price; request a quote instead' } };
  }
  if (isTerminalStatus(order.status)) {
    return { status: 409, body: { error: 'order_closed', detail: `order status is ${order.status}` } };
  }
  if (order.payment_status === 'paid') {
    const updated = await getOrderFull(db, order.id);
    const erpSync = await safeEnqueueErpSync(db, env, updated, updated.items);
    // A retry carrying the same paymentKey is the idempotent replay of the
    // payment that already succeeded.
    const replay = await db.prepare('SELECT status FROM payments WHERE payment_key = ?').bind(paymentKey).first();
    if (replay && replay.status === 'paid') {
      return {
        status: 200,
        body: { idempotent: true, already_paid: true, payment_key: paymentKey, order: publicOrderView(updated, updated.items), erp_sync: erpSync },
      };
    }
    return { status: 200, body: { already_paid: true, order: publicOrderView(updated, updated.items), erp_sync: erpSync } };
  }

  // Server-side amount verification. The amount must equal the amount the
  // server computed from the catalog when the order was created.
  if (!Number.isInteger(body.amount) || body.amount <= 0) {
    return { status: 400, body: { error: 'invalid amount' } };
  }
  if (body.amount !== order.total_amount) {
    return {
      status: 400,
      body: {
        error: 'amount mismatch',
        detail: { expected: order.total_amount, received: body.amount },
        note: 'the payment amount must match the order total computed by the server',
      },
    };
  }

  const existingPayment = await db.prepare('SELECT * FROM payments WHERE payment_key = ?').bind(paymentKey).first();
  if (existingPayment) {
    if (existingPayment.status === 'paid') {
      return { status: 200, body: { idempotent: true, payment_key: paymentKey, order: publicOrderView(order, await getOrderItems(db, orderId)) } };
    }
    return { status: 409, body: { error: 'payment_key_reused', detail: `paymentKey already used with status ${existingPayment.status}` } };
  }

  // Client-reported authentication failure (no approval call needed). Recording
  // it flips the order to failed, so it requires the email factor: without one,
  // anyone who guesses an order id could mark a live payment attempt as failed.
  if (body.failure || body.failed) {
    const declaredEmail = String(body.customer_email || '').trim().toLowerCase();
    if (!declaredEmail || declaredEmail !== String(order.customer_email || '').trim().toLowerCase()) {
      return { status: 403, body: { error: 'email factor required', detail: 'a payment failure report must confirm the order email' } };
    }
    const code = String(body.failure_code || 'PAY_PROCESS_CANCELED');
    const message = String(body.failure_message || '');
    await recordPaymentOutcome(db, {
      order, paymentKey, amount: order.total_amount, status: 'failed',
      failureCode: code, failureMessage: message, provider: pg.provider, providerMode: pg.mode,
      touchOrder: false,
    });
    return { status: 402, body: { error: 'payment_auth_failed', code, order_status: order.status, payment_status: 'failed' } };
  }

  const startedAt = nowIso();
  let outcome;
  try {
    const result = await pg.confirm({
      paymentKey,
      orderId: order.id,
      amount: order.total_amount,
      orderName: 'CGI 주문',
      method: body.paymentMethod || body.payment_method || null,
      // NICEPAY's Server-승인 model will not approve without the window payload it
      // signed; the adapter verifies it before the approve call. Toss ignores the
      // field, and a forged payload fails verification rather than approving.
      signatureData: body.signatureData || body.window || null,
      idempotencyKey: `cgi:confirm:${order.id}:${paymentKey}`,
    });
    outcome = {
      status: result.status === 'DONE' ? 'paid' : String(result.status || 'pending').toLowerCase(),
      amount: toNonNegInt(result.totalAmount, order.total_amount),
      suppliedAmount: toNonNegInt(result.suppliedAmount),
      vat: toNonNegInt(result.vat),
      method: result.method || null,
      requestedAt: result.requestedAt || null,
      approvedAt: result.approvedAt || null,
      balanceAmount: toNonNegInt(result.balanceAmount, order.total_amount),
      raw: JSON.stringify(result),
    };
  } catch (e) {
    outcome = {
      status: 'failed',
      failureCode: e && e.code ? String(e.code) : 'PG_ERROR',
      failureMessage: e && e.message ? String(e.message).slice(0, 500) : String(e),
      // A rejection means the supplied paymentKey never proved anything about
      // THIS order — log it, but leave the order awaiting_payment and retryable.
      touchOrder: false,
    };
  }

  await recordPaymentOutcome(db, {
    order, paymentKey, amount: order.total_amount, provider: pg.provider, providerMode: pg.mode,
    requestedAt: startedAt, ...outcome,
  });

  const updated = await getOrderFull(db, order.id);
  if (outcome.status === 'paid') {
    const enqueued = await safeEnqueueErpSync(db, env, updated, updated.items);
    return {
      status: 200,
      body: {
        approved: true,
        order: publicOrderView(updated, updated.items),
        payment: { payment_key: paymentKey, provider: pg.provider, provider_mode: pg.mode, method: outcome.method },
        erp_sync: enqueued,
      },
    };
  }

  return {
    status: 402,
    body: {
      approved: false,
      error: outcome.failureCode || 'payment_failed',
      message: outcome.failureMessage || null,
      order_status: updated.status,
      payment_status: updated.payment_status,
    },
  };
}

/**
 * The window posts returnUrl as an HTML form (application/x-www-form-urlencoded),
 * not JSON. Anything else falls back to JSON so a hand-built test can use either.
 */
async function readWindowForm(request) {
  const type = String(request.headers.get('content-type') || '');
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(await request.formData());
  }
  const parsed = await readJson(request);
  return parsed.error ? {} : (parsed.body || {});
}

function redirectTarget(site, orderId, ok) {
  const flag = ok ? 'nicepay=success' : 'nicepay=fail';
  return `${site}/?${flag}#/order/${encodeURIComponent(String(orderId).slice(0, 64))}`;
}

/**
 * A webhook is an at-least-once notification, so it is recorded by (tid, status)
 * and never re-applied. A 'paid' notification re-reads the transaction from the
 * gateway instead of trusting the body, and a cancel notification updates the
 * stored payment row from the gateway's own balance — the order state machine is
 * advanced by the same helpers the confirm path uses.
 */
async function applyNicepayWebhook(db, env, pg, payload) {
  const ack = pg.webhook.ack();
  const tid = String(payload.tid || '').slice(0, 200);
  if (!tid) return json({ error: 'webhook payload incomplete' }, 400);

  const row = await db.prepare('SELECT * FROM payments WHERE payment_key = ?').bind(tid).first();
  const verified = pg.webhook.verify(payload, { expectedAmount: row ? row.amount : undefined });
  if (!verified.ok) {
    // Not acking keeps NICE's retry/resend path alive instead of swallowing it.
    return json({ error: 'webhook_verification_failed', code: verified.reason }, 400);
  }

  const payloadStatus = String(payload.status || '');
  // (tid, status) is the at-least-once identity, but a partial cancel can repeat
  // with the same status while moving a different amount. The balance the
  // notification carries is part of the key so the second cancel is not
  // swallowed as a replay.
  const dedupeStatus = /cancel/i.test(payloadStatus)
    ? `${payloadStatus}:${payload.balanceAmt ?? payload.cancelAmt ?? ''}`
    : payloadStatus;
  const key = pg.webhook.dedupeKey({ tid, status: dedupeStatus });
  const seen = await db.prepare(
    "SELECT id FROM order_events WHERE type = 'payment_webhook' AND json_extract(meta, '$.dedupe_key') = ? LIMIT 1"
  ).bind(key).first();
  if (seen) return new Response(ack.body, { status: ack.status, headers: { 'Content-Type': ack.headers['Content-Type'] } });

  if (!row) {
    return json({ error: 'unknown_tid' }, 409);
  }
  const order = await getOrder(db, row.order_id);
  if (!order) return json({ error: 'unknown_order' }, 409);

  let tx;
  try {
    tx = await pg.fetchByPaymentKey(tid);
  } catch (e) {
    return json({ error: 'gateway_read_failed', code: e instanceof NicepayApiError ? e.code : 'PG_ERROR' }, 502);
  }
  const outcome = {
    status: String(tx.status || payload.status || '').toLowerCase(),
    balanceAmount: toNonNegInt(tx.balanceAmt, row.balance_amount),
    amount: toNonNegInt(tx.amount, row.amount),
    method: tx.payMethod || row.method,
    cancelledTid: tx.cancelledTid || null,
  };
  const ts = nowIso();

  // Cancellation is not a failed payment. It has its own order/payment status
  // vocabulary and it must never run through recordPaymentOutcome (which would
  // flip the order to failed and replace the payment row with a zeroed one).
  if (outcome.status === 'cancelled' || outcome.status === 'partialcancelled') {
    await applyNicepayCancellation(db, { order, row, tx, provider: pg.provider, providerMode: pg.mode, key, ts });
    return new Response(ack.body, { status: ack.status, headers: { 'Content-Type': ack.headers['Content-Type'] } });
  }

  // `ready` means a window (or a virtual-account order) exists but money has not
  // moved. It is a pending state, not a failure. A late/out-of-order `ready`
  // must never downgrade a row that has already moved money.
  if (outcome.status === 'ready') {
    const settled = ['paid', 'cancelled', 'partial_cancelled'].includes(String(row.status));
    const stmts = [
      db.prepare('INSERT INTO order_events (order_id, type, actor, from_status, to_status, meta, created_at) VALUES (?,?,?,?,?,?,?)')
        .bind(order.id, 'payment_webhook', 'pg', row.status, 'ready', JSON.stringify({ dedupe_key: key, status: outcome.status, tid, applied: !settled }), ts),
    ];
    if (!settled) {
      stmts.unshift(
        db.prepare("UPDATE payments SET status = 'pending', balance_amount = ?, updated_at = ? WHERE payment_key = ?")
          .bind(outcome.balanceAmount, ts, tid)
      );
    }
    await db.batch(stmts);
    return new Response(ack.body, { status: ack.status, headers: { 'Content-Type': ack.headers['Content-Type'] } });
  }

  if (row.status !== outcome.status) {
    await recordPaymentOutcome(db, {
      order, paymentKey: tid, amount: outcome.amount,
      status: outcome.status === 'paid' ? 'paid' : outcome.status === 'failed' ? 'failed' : outcome.status,
      method: outcome.method, balanceAmount: outcome.balanceAmount,
      provider: pg.provider, providerMode: pg.mode,
      approvedAt: outcome.status === 'paid' ? (tx.paidAt || ts) : (row.approved_at || null),
      requestedAt: row.requested_at || ts,
      raw: JSON.stringify(tx).slice(0, 4000),
    });
  }
  await db.prepare(
    'INSERT INTO order_events (order_id, type, actor, from_status, to_status, meta, created_at) VALUES (?,?,?,?,?,?,?)'
  ).bind(order.id, 'payment_webhook', 'pg', row.status, outcome.status, JSON.stringify({ dedupe_key: key, status: outcome.status, tid }), ts).run();
  if (outcome.status === 'paid') {
    const updated = await getOrderFull(db, order.id);
    await safeEnqueueErpSync(db, env, updated, updated.items);
  }
  return new Response(ack.body, { status: ack.status, headers: { 'Content-Type': ack.headers['Content-Type'] } });
}

/**
 * A gateway-side cancel (the operator refunded in the NICE console, so no
 * server-to-server cancel call ever ran through cancelPayment). Update the
 * EXISTING payment row in place — never INSERT OR REPLACE, which reset
 * cancel_amount to 0 — and derive the order status the same way the refund
 * handler does. Full cancel -> 'cancelled'; partial -> 'partial_refunded'.
 */
async function applyNicepayCancellation(db, { order, row, tx, provider, providerMode, key, ts }) {
  const gatewayStatus = String(tx.status || '').toLowerCase();
  const totalAmount = toNonNegInt(tx.amount, row.amount);
  const balanceAmount = toNonNegInt(tx.balanceAmt, row.balance_amount);
  const previousCancelled = toNonNegInt(row.cancel_amount, 0);
  const remainingBefore = Math.max(totalAmount - previousCancelled, 0);
  const newest = cancelAmountOf(tx, 0);
  const cancelledNow = newest > 0 ? newest : Math.max(remainingBefore - balanceAmount, 0);
  const cumulativeCancelled = Math.min(totalAmount, previousCancelled + cancelledNow);
  const full = gatewayStatus === 'cancelled' || balanceAmount <= 0;
  const paymentRowStatus = full ? 'cancelled' : 'partial_cancelled';
  const orderPaymentStatus = full ? 'cancelled' : 'partial_refunded';

  await db.batch([
    db.prepare('UPDATE payments SET status = ?, balance_amount = ?, cancel_amount = ?, method = ?, updated_at = ? WHERE payment_key = ?')
      .bind(paymentRowStatus, balanceAmount, cumulativeCancelled, tx.payMethod || row.method || null, ts, row.payment_key),
    db.prepare('UPDATE orders SET payment_status = ?, refunded_amount = ?, updated_at = ? WHERE id = ?')
      .bind(orderPaymentStatus, cumulativeCancelled, ts, order.id),
    db.prepare('INSERT INTO order_events (order_id, type, actor, from_status, to_status, meta, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(
        order.id, 'payment_cancelled', 'pg', order.status, null,
        JSON.stringify({
          payment_key: row.payment_key,
          cancel_amount: cancelledNow,
          cancelled_total: cumulativeCancelled,
          balance_amount: balanceAmount,
          source: 'webhook',
          provider,
          provider_mode: providerMode,
          dedupe_key: key,
        }),
        ts
      ),
    db.prepare('INSERT INTO order_events (order_id, type, actor, from_status, to_status, meta, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(order.id, 'payment_webhook', 'pg', row.status, paymentRowStatus, JSON.stringify({ dedupe_key: key, status: gatewayStatus, tid: row.payment_key }), ts),
  ]);
}

/** Persist a payment outcome and keep the order/payment status consistent.
 *  touchOrder=false records the payment row + event without flipping the order
 *  to failed: a PG rejection seen through an attacker-supplied paymentKey must
 *  not damage a live order — the customer can simply retry while it stays
 *  awaiting_payment. */
async function recordPaymentOutcome(db, { order, paymentKey, amount, status, failureCode, failureMessage, method, requestedAt, approvedAt, suppliedAmount, vat, balanceAmount, raw, provider, providerMode, touchOrder = true }) {
  const ts = nowIso();
  const stmts = [];

  stmts.push(
    db.prepare(
      `INSERT OR REPLACE INTO payments (order_id, payment_key, provider, provider_mode, pg_order_id, amount,
         supplied_amount, vat, method, status, requested_at, approved_at, balance_amount,
         failure_code, failure_message, raw, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      order.id, paymentKey, provider || 'nicepay', providerMode || 'mock', order.id, amount,
      suppliedAmount || 0, vat || 0, method || null, status, requestedAt || null, approvedAt || null,
      balanceAmount != null ? balanceAmount : amount,
      failureCode || null, failureMessage || null, raw || null, ts, ts
    )
  );

  if (status === 'paid') {
    stmts.push(
      db.prepare(
        'UPDATE orders SET status = ?, payment_status = ?, payment_key = ?, payment_method = ?, delivery_status = ?, paid_at = ?, updated_at = ? WHERE id = ?'
      ).bind('paid', 'paid', paymentKey, method || null, deliveryStatusOnTransition('paid', order.delivery_status), approvedAt || ts, ts, order.id)
    );
    stmts.push(
      db.prepare('INSERT INTO order_events (order_id, type, actor, from_status, to_status, meta, created_at) VALUES (?,?,?,?,?,?,?)')
        .bind(order.id, 'payment_confirmed', 'pg', order.status, 'paid', JSON.stringify({ payment_key: paymentKey, amount }), ts)
    );
  } else {
    if (touchOrder) {
      stmts.push(
        db.prepare('UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?').bind('failed', ts, order.id)
      );
    }
    stmts.push(
      db.prepare('INSERT INTO order_events (order_id, type, actor, from_status, to_status, meta, error, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .bind(order.id, 'payment_failed', 'pg', order.status, null, JSON.stringify({ payment_key: paymentKey, amount, order_touched: !!touchOrder }),
          `${failureCode || 'PG_ERROR'}: ${failureMessage || ''}`.slice(0, 500), ts)
    );
  }

  await db.batch(stmts);
}

// ---------------------------------------------------------------------------
// admin order operations
// ---------------------------------------------------------------------------

async function updateOrder(db, order, body, actor = 'admin') {
  const ts = nowIso();
  const stmts = [];
  const events = [];
  const changes = {};

  if (body.status !== undefined && body.status !== null) {
    const to = String(body.status);
    if (!isStatusKnown(order.kind, to)) {
      return { error: 'unknown status', detail: { status: to, valid: knownStatuses(order.kind) } };
    }
    if (order.status !== to && !isTransitionAllowed(order.kind, order.status, to)) {
      if (!body.force) {
        return { error: 'transition not allowed', detail: { from: order.status, to, allowed: ORDER_TRANSITIONS[order.kind] && ORDER_TRANSITIONS[order.kind][order.status] } };
      }
    }
    if (order.status !== to) {
      changes.status = to;
      changes.payment_status = paymentStatusFor(to);
      changes.delivery_status = deliveryStatusOnTransition(to, order.delivery_status);
      events.push({ type: 'status_changed', from: order.status, to, forced: !!body.force });
    }
  }

  if (body.delivery_status !== undefined && body.delivery_status !== null) {
    const to = String(body.delivery_status);
    if (!DELIVERY_STATUSES.includes(to)) return { error: 'unknown delivery_status', detail: { valid: DELIVERY_STATUSES } };
    changes.delivery_status = to;
    events.push({ type: 'delivery_status_changed', from: order.delivery_status, to });
  }

  if (body.delivery_tracking !== undefined) {
    changes.delivery_tracking = body.delivery_tracking ? String(body.delivery_tracking).slice(0, 100) : null;
    events.push({ type: 'delivery_tracking_set', to: changes.delivery_tracking });
  }

  if (body.admin_note !== undefined) {
    changes.admin_note = body.admin_note ? String(body.admin_note).slice(0, 2000) : null;
    events.push({ type: 'admin_note_set' });
  }

  if (!Object.keys(changes).length) return { noChange: true };

  const setParts = ['updated_at = ?'];
  const bindValues = [ts];
  for (const [key, value] of Object.entries(changes)) {
    setParts.push(`${key} = ?`);
    bindValues.push(value);
  }
  bindValues.push(order.id);
  stmts.push(db.prepare(`UPDATE orders SET ${setParts.join(', ')} WHERE id = ?`).bind(...bindValues));

  for (const event of events) {
    stmts.push(
      db.prepare('INSERT INTO order_events (order_id, type, actor, from_status, to_status, meta, created_at) VALUES (?,?,?,?,?,?,?)')
        .bind(order.id, event.type, actor, event.from || null, event.to || null, JSON.stringify(event), ts)
    );
  }

  await db.batch(stmts);
  return { changes };
}

/** Confirm staff-side prices on a quote order and optionally convert it to a payable order. */
async function confirmQuotePrices(db, env, order, body) {
  const adminPrices = body.admin_prices;
  if (!adminPrices || typeof adminPrices !== 'object') {
    return { status: 400, body: { error: 'admin_prices required', detail: 'object of productId -> unit price' } };
  }

  const items = await getOrderItems(db, order.id);
  const prices = {};
  for (const item of items) {
    const raw = adminPrices[item.product_id];
    const price = toNonNegInt(raw);
    if (raw === undefined || raw === null || price <= 0) {
      return { status: 400, body: { error: 'price missing', detail: `unit price required for ${item.product_id}` } };
    }
    prices[item.product_id] = price;
  }

  const paidItems = items.map((item) => ({ ...item, unit_price: prices[item.product_id], price_state: 'public' }));
  const totals = computeTotals(paidItems, { shippingFee: toNonNegInt(env.SHIPPING_FEE_DEFAULT, 0) });

  const convert = !!body.convert;
  const kind = convert ? 'purchase' : order.kind;
  const ts = nowIso();

  const stmts = [
    db.prepare(
      `UPDATE orders SET admin_prices = ?, item_total = ?, shipping_fee = ?, total_amount = ?, supplied_amount = ?,
         vat_amount = ?, kind = ?, status = ?, payment_status = ?, updated_at = ? WHERE id = ?`
    ).bind(
      JSON.stringify(prices), totals.item_total, totals.shipping_fee, totals.total_amount, totals.supplied_amount,
      totals.vat_amount, kind, convert ? 'awaiting_payment' : 'quoted', convert ? 'pending' : order.payment_status, ts, order.id
    ),
    db.prepare('INSERT INTO order_events (order_id, type, actor, from_status, to_status, meta, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(order.id, 'admin_prices_set', 'admin', order.status, convert ? 'awaiting_payment' : 'quoted',
        JSON.stringify({ admin_prices: prices, total: totals.total_amount, converted: convert }), ts),
  ];

  for (const item of totals.lines.map((line, index) => ({ ...line, seq: index + 1 }))) {
    const src = paidItems[item.seq - 1];
    stmts.push(
      db.prepare('UPDATE order_items SET unit_price = ?, line_total = ?, price_state = ? WHERE order_id = ? AND seq = ?')
        .bind(item.unit_price, item.line_total, 'public', order.id, src.seq)
    );
  }

  if (order.source_quote_id) {
    stmts.push(
      db.prepare("UPDATE quote_requests SET admin_prices = ?, total = ?, status = ?, updated_at = ? WHERE id = ?")
        .bind(JSON.stringify(prices), totals.total_amount, convert ? 'completed' : 'quoted', ts, order.source_quote_id)
    );
  }

  await db.batch(stmts);
  const updated = await getOrderFull(db, order.id);
  return {
    status: 200,
    body: { converted: convert, order: publicOrderView(updated, updated.items) },
  };
}

/** Admin refund / payment void. */
async function cancelPayment(db, env, order, paymentKey, body, pg) {
  const payment = await db.prepare('SELECT * FROM payments WHERE payment_key = ? AND order_id = ?').bind(paymentKey, order.id).first();
  if (!payment) return { status: 404, body: { error: 'payment not found' } };

  const refundable = toNonNegInt(payment.balance_amount, 0);
  const reason = String(body.cancelReason || body.reason || '고객 요청 취소/환불').slice(0, 200);
  const hasAmount = body.cancelAmount !== undefined && body.cancelAmount !== null && body.cancelAmount !== '';

  let requested = refundable;
  const minPartialRefund = toNonNegInt(env.MIN_PARTIAL_REFUND, MIN_PARTIAL_REFUND) || MIN_PARTIAL_REFUND;
  if (hasAmount) {
    requested = toNonNegInt(body.cancelAmount);
    // Below the partial-refund minimum the amount is rounding dust, not a
    // refund: reject it rather than create a balance that cannot be settled.
    if (!Number.isInteger(requested) || requested < minPartialRefund) {
      return {
        status: 400,
        body: { error: 'invalid cancelAmount', detail: { requested: body.cancelAmount, min: minPartialRefund } },
      };
    }
  }
  const cancelAmount = Math.min(requested, refundable);

  // A retry for the same (payment, reason, amount) returns the recorded outcome
  // instead of refunding twice. An explicit cancelAmount is part of the key: a
  // SECOND partial refund of a different size is a new intent, not a duplicate.
  // An amount-less call means "refund whatever is left for this reason": it only
  // dedupes once nothing is left (a true replay of the completed full refund);
  // while a balance remains it is a fresh refund, which is what previously got
  // wrongly swallowed as "already processed".
  let prior = null;
  if (hasAmount) {
    prior = await db
      .prepare("SELECT meta FROM order_events WHERE order_id = ? AND type = 'payment_cancelled' AND json_extract(meta, '$.payment_key') = ? AND json_extract(meta, '$.reason') = ? AND json_extract(meta, '$.cancel_amount') = ? ORDER BY created_at DESC LIMIT 1")
      .bind(order.id, paymentKey, reason, cancelAmount)
      .first();
  } else if (refundable <= 0) {
    prior = await db
      .prepare("SELECT meta FROM order_events WHERE order_id = ? AND type = 'payment_cancelled' AND json_extract(meta, '$.payment_key') = ? AND json_extract(meta, '$.reason') = ? ORDER BY created_at DESC LIMIT 1")
      .bind(order.id, paymentKey, reason)
      .first();
  }
  if (prior) {
    let meta = {};
    try { meta = JSON.parse(prior.meta) || {}; } catch (e) { meta = {}; }
    return {
      status: 200,
      body: {
        idempotent: true,
        payment_key: paymentKey,
        cancel_amount: toNonNegInt(meta.cancel_amount),
        refunded_amount: toNonNegInt(order.refunded_amount),
        payment_status: order.payment_status,
        order_status: order.status,
      },
    };
  }

  if (refundable <= 0 || cancelAmount <= 0) {
    return { status: 409, body: { error: 'nothing refundable', detail: { balance_amount: refundable } } };
  }


  let outcome;
  try {
    const result = await pg.cancel({
      paymentKey,
      // NICE cancels by its own orderId field and rejects the call without it;
      // Toss ignores the extra key, so both gateways get the truth about the row.
      orderId: order.pg_order_id || order.id,
      cancelAmount,
      cancelReason: reason,
      refundReceiveAccount: body.refundReceiveAccount || null,
      idempotencyKey: `cgi:cancel:${order.id}:${paymentKey}:${cancelAmount}`,
    });
    const transactions = Array.isArray(result.cancels) ? result.cancels : [];
    const lastCancel = transactions.length ? transactions[transactions.length - 1] : null;
    outcome = {
      ok: true,
      status: result.status || 'CANCELED',
      balanceAmount: toNonNegInt(result.balanceAmount),
      // The provider reports the amount refunded SO FAR on this payment, so adding
      // it to the stored refunded_amount would count every earlier refund twice.
      // Only the newest transaction belongs in the ledger.
      cancelAmount: toNonNegInt(lastCancel && lastCancel.cancelAmount, cancelAmount),
      raw: JSON.stringify(result),
    };
  } catch (e) {
    outcome = { ok: false, error: `${(e && e.code) || 'PG_ERROR'}: ${e && e.message ? e.message : e}`.slice(0, 500) };
  }

  const ts = nowIso();
  const stmts = [
    db.prepare('INSERT INTO order_events (order_id, type, actor, from_status, to_status, meta, error, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(
        order.id,
        outcome.ok ? 'payment_cancelled' : 'payment_cancel_failed',
        'admin',
        order.status,
        null,
        JSON.stringify({ payment_key: paymentKey, cancel_amount: cancelAmount, reason, provider_mode: pg.mode }),
        outcome.ok ? null : outcome.error,
        ts
      ),
  ];

  if (outcome.ok) {
    const totalCancelled = toNonNegInt(order.refunded_amount, 0) + outcome.cancelAmount;
    const fullyRefunded = totalCancelled >= toNonNegInt(order.total_amount, 0);
    stmts.push(
      db.prepare('UPDATE payments SET status = ?, balance_amount = ?, cancel_amount = ?, updated_at = ? WHERE payment_key = ?')
        .bind(outcome.status === 'CANCELED' ? 'cancelled' : 'partial_cancelled', outcome.balanceAmount != null ? outcome.balanceAmount : refundable - cancelAmount, totalCancelled, ts, paymentKey)
    );
    stmts.push(
      db.prepare('UPDATE orders SET refunded_amount = ?, payment_status = ?, updated_at = ? WHERE id = ?')
        .bind(totalCancelled, fullyRefunded ? 'refunded' : 'partial_refunded', ts, order.id)
    );
    if (fullyRefunded && isTransitionAllowed(order.kind, order.status, 'refunding')) {
      stmts.push(
        db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').bind('refunding', ts, order.id)
      );
      stmts.push(
        db.prepare('INSERT INTO order_events (order_id, type, actor, from_status, to_status, meta, created_at) VALUES (?,?,?,?,?,?,?)')
          .bind(order.id, 'status_changed', 'pg', order.status, 'refunding', JSON.stringify({ reason: 'full refund' }), ts)
      );
    }
  }

  await db.batch(stmts);

  if (!outcome.ok) return { status: 502, body: { error: 'refund_failed', detail: outcome.error } };

  const updated = await getOrderFull(db, order.id);
  return {
    status: 200,
    body: {
      refunded: true,
      cancel_amount: cancelAmount,
      refunded_amount: updated.refunded_amount,
      payment_status: updated.payment_status,
      order_status: updated.status,
      provider_mode: pg.mode,
    },
  };
}

function erpSyncSummary(row, { idempotent = false, note = null } = {}) {
  return {
    ...(idempotent ? { idempotent: true } : {}),
    id: row?.id ?? null,
    status: row?.status || 'not_configured',
    mode: row?.mode || 'disabled',
    delivered: row?.status === 'sent',
    attempts: toNonNegInt(row?.attempts, 0),
    dedupe_key: row?.dedupe_key || null,
    payload_lines: (() => {
      try { return JSON.parse(row?.payload || '{}')?.line_count ?? JSON.parse(row?.payload || '{}')?.batches?.[0]?.rowCount ?? 0; }
      catch { return 0; }
    })(),
    live_write: row?.status === 'sent' && row?.mode === 'prod',
    note: note || row?.last_error || null,
  };
}

async function recordErpSyncState(db, order, row, errorCode = null) {
  const ts = nowIso();
  const eventType = row.status === 'sent' ? 'erp_sent'
    : row.status === 'not_configured' ? 'erp_not_configured'
    : row.status === 'unknown' ? 'erp_review_required'
    : row.status === 'failed' ? 'erp_failed' : 'erp_skipped';
  await db.batch([
    db.prepare('UPDATE orders SET erp_status = ?, erp_sent_at = ?, updated_at = ? WHERE id = ?')
      .bind(row.status, row.status === 'sent' ? ts : null, ts, order.id),
    db.prepare('INSERT INTO order_events (order_id, type, actor, from_status, to_status, meta, error, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(order.id, eventType, 'erp', order.status, null,
        JSON.stringify({ adapter: ECOUNT_ORDER_ADAPTER, mode: row.mode, attempts: row.attempts, status: row.status }),
        errorCode, ts),
  ]);
}

async function latestErpSyncForOrder(db, orderId) {
  return db.prepare('SELECT * FROM erp_sync WHERE order_id = ? ORDER BY id DESC LIMIT 1').bind(orderId).first();
}

/** Build and persist an order-id claim before any ECOUNT request is sent. */
async function enqueueErpSync(db, env, order, items, force = false) {
  if (!order?.id || order.payment_status !== 'paid' || order.status !== 'paid') {
    return { status: 'not_configured', mode: ecountOrderMode(env), delivered: false, attempts: 0, live_write: false, note: 'payment_not_complete' };
  }

  let approvedItemMap = null;
  if (order.status === 'paid' && order.payment_status === 'paid' && ecountOrderMode(env) !== 'disabled') {
    const storedMap = await loadApprovedEcountItemMap(db, items);
    if (Object.keys(storedMap).length) approvedItemMap = storedMap;
  }
  const prepared = prepareEcountSaleOrder({ env, order, items, approvedItemMap });
  const dedupeKey = prepared.dedupeKey || ecountOrderDedupeKey(order.id);
  const ts = nowIso();
  let existing = await latestErpSyncForOrder(db, order.id);

  if (existing && ['sent', 'pending', 'unknown'].includes(existing.status)) {
    return erpSyncSummary(existing, { idempotent: true });
  }
  if (existing?.status === 'failed' && !force) return erpSyncSummary(existing, { idempotent: true });

  if (!prepared.ready) {
    const notConfiguredNote = `not_configured:${prepared.reason}`;
    if (existing?.status === 'not_configured' && existing.last_error === notConfiguredNote) {
      return erpSyncSummary(existing, { idempotent: true });
    }
    if (existing) {
      if (existing.status === 'failed' && !force) return erpSyncSummary(existing, { idempotent: true });
      const updated = await db.prepare(
        `UPDATE erp_sync SET adapter = ?, mode = ?, action = ?, dedupe_key = ?, payload = ?, status = 'not_configured',
           last_error = ?, updated_at = ? WHERE id = ? AND status IN ('not_configured','skipped','failed')`
      ).bind(ECOUNT_ORDER_ADAPTER, prepared.mode, ECOUNT_ORDER_ACTION, dedupeKey, JSON.stringify(prepared.payload), notConfiguredNote, ts, existing.id).run();
      if (Number(updated?.meta?.changes || 0) === 0) {
        existing = await latestErpSyncForOrder(db, order.id);
        return erpSyncSummary(existing, { idempotent: true });
      }
      existing = await latestErpSyncForOrder(db, order.id);
      await recordErpSyncState(db, order, existing, prepared.reason);
      return erpSyncSummary(existing, { note: notConfiguredNote });
    }

    const inserted = await db.prepare(
      `INSERT OR IGNORE INTO erp_sync (order_id, adapter, mode, action, dedupe_key, payload, status, attempts, last_error, created_at, updated_at)
       VALUES (?,?,?,?,?,?,'not_configured',0,?,?,?)`
    ).bind(order.id, ECOUNT_ORDER_ADAPTER, prepared.mode, ECOUNT_ORDER_ACTION, dedupeKey, JSON.stringify(prepared.payload), notConfiguredNote, ts, ts).run();
    if (Number(inserted?.meta?.changes || 0) === 0) {
      existing = await latestErpSyncForOrder(db, order.id);
      return erpSyncSummary(existing, { idempotent: true });
    }
    existing = await latestErpSyncForOrder(db, order.id);
    await recordErpSyncState(db, order, existing, prepared.reason);
    return erpSyncSummary(existing, { note: notConfiguredNote });
  }

  let claimedId = null;
  if (existing) {
    const retryableStatus = ['not_configured', 'skipped'].includes(existing.status)
      || (existing.status === 'failed' && force && existing.adapter === ECOUNT_ORDER_ADAPTER);
    if (!retryableStatus) return erpSyncSummary(existing, { idempotent: true });
    const claim = await db.prepare(
      `UPDATE erp_sync SET adapter = ?, mode = ?, action = ?, dedupe_key = ?, payload = ?, status = 'pending',
         attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ? AND status = ?`
    ).bind(ECOUNT_ORDER_ADAPTER, prepared.mode, ECOUNT_ORDER_ACTION, dedupeKey, JSON.stringify(prepared.payload), ts, existing.id, existing.status).run();
    if (Number(claim?.meta?.changes || 0) !== 1) {
      existing = await latestErpSyncForOrder(db, order.id);
      return erpSyncSummary(existing, { idempotent: true });
    }
    claimedId = existing.id;
  } else {
    const claim = await db.prepare(
      `INSERT OR IGNORE INTO erp_sync (order_id, adapter, mode, action, dedupe_key, payload, status, attempts, last_error, created_at, updated_at)
       VALUES (?,?,?,?,?,?,'pending',1,NULL,?,?)`
    ).bind(order.id, ECOUNT_ORDER_ADAPTER, prepared.mode, ECOUNT_ORDER_ACTION, dedupeKey, JSON.stringify(prepared.payload), ts, ts).run();
    if (Number(claim?.meta?.changes || 0) !== 1) {
      existing = await latestErpSyncForOrder(db, order.id);
      return erpSyncSummary(existing, { idempotent: true });
    }
    existing = await db.prepare('SELECT * FROM erp_sync WHERE dedupe_key = ?').bind(dedupeKey).first();
    claimedId = existing?.id ?? null;
  }

  const storedPayload = existing?.payload ? (() => { try { return JSON.parse(existing.payload); } catch { return null; } })() : null;
  const persistedPlan = storedPayload?.plan?.batches?.length === 1 ? storedPayload.plan : null;
  const planToSend = persistedPlan ? { ...prepared, plan: persistedPlan } : prepared;
  let sent;
  try {
    sent = await transmitEcountSaleOrder(planToSend, { env });
  } catch {
    sent = { status: 'failed', retryable: true, errorCode: 'adapter_error' };
  }

  const finalStatus = ['sent', 'failed', 'unknown'].includes(sent.status) ? sent.status : 'failed';
  const finalPayload = JSON.stringify({
    adapter: ECOUNT_ORDER_ADAPTER,
    action: ECOUNT_ORDER_ACTION,
    order_id: order.id,
    line_count: prepared.lineCount,
    plan: planToSend.plan,
    result: finalStatus === 'sent' ? { slip_nos: sent.slipNos || [], trace_id: sent.traceId || null } : undefined,
  });
  const errorCode = finalStatus === 'sent' ? null : String(sent.errorCode || 'oapi_error').slice(0, 80);
  const note = finalStatus === 'unknown' ? `delivery_uncertain:${errorCode}` : errorCode;
  await db.prepare(
    'UPDATE erp_sync SET payload = ?, status = ?, last_error = ?, mode = ?, updated_at = ? WHERE id = ? AND status = \'pending\''
  ).bind(finalPayload, finalStatus, note, prepared.mode, nowIso(), claimedId).run();
  const finalRow = await db.prepare('SELECT * FROM erp_sync WHERE id = ?').bind(claimedId).first();
  await recordErpSyncState(db, order, finalRow, errorCode);
  return erpSyncSummary(finalRow, { note });
}

// ERP persistence and transport failures must never turn a confirmed payment into a failed response.
async function safeEnqueueErpSync(db, env, order, items) {
  try { return await enqueueErpSync(db, env, order, items); }
  catch { return { status: 'failed', mode: ecountOrderMode(env), delivered: false, attempts: 0, live_write: false, note: 'erp_queue_unavailable' }; }
}

// ---------------------------------------------------------------------------
// customer accounts (issue #69)
//
// /api/auth/* and /api/me/* are the only cookie-based routes. Each one is
// guarded twice: a pinned-Origin check (no echo, same policy as the legacy
// CORS layer) and a custom X-CSRF-Token that must match the Origin.
//
// Isolation from the staff API: /api/* endpoints that need ADMIN_TOKEN still
// read only the Authorization header. A customer session cookie is never
// inspected there, so it cannot grant admin access, and no admin surface reads
// the members tables.
// ---------------------------------------------------------------------------

function authCookieName(env) {
  return String(env.AUTH_SESSION_COOKIE || 'cgi_member');
}

function authCookieSecure(env) {
  return String(env.AUTH_COOKIE_SECURE || 'YES').toUpperCase() !== 'NO';
}

function originStrict(env) {
  return String(env.AUTH_ORIGIN_STRICT || 'YES').toUpperCase() !== 'NO';
}

function emailVerifyRequired(env) {
  return String(env.EMAIL_VERIFY_REQUIRED || 'NO').toUpperCase() === 'YES';
}

function authPolicy(env) {
  const iterations = Number.parseInt(env.AUTH_PBKDF2_ITERATIONS, 10);
  const sessionDays = Number.parseInt(env.AUTH_SESSION_TTL_DAYS, 10);
  const maxAddresses = Number.parseInt(env.AUTH_MAX_ADDRESSES, 10);
  const rateMax = Number.parseInt(env.AUTH_RATE_LIMIT_MAX, 10);
  const rateWindow = Number.parseInt(env.AUTH_RATE_LIMIT_WINDOW_SECONDS, 10);
  const cooldownSec = Number.parseInt(env.AUTH_RESEND_COOLDOWN_SECONDS, 10);
  const policy = { ...AUTH_POLICY, rateLimit: { ...AUTH_POLICY.rateLimit } };
  if (Number.isFinite(iterations) && iterations > 0) policy.pbkdf2Iterations = iterations;
  if (Number.isFinite(sessionDays) && sessionDays > 0) policy.sessionTtlSeconds = Math.floor(sessionDays * 24 * 3600);
  if (Number.isFinite(maxAddresses) && maxAddresses > 0) policy.maxAddressesPerMember = maxAddresses;
  // Buckets that must keep their own max/window and are not overridden by the
  // global AUTH_RATE_LIMIT_MAX / AUTH_RATE_LIMIT_WINDOW_SECONDS.
  const protectedBuckets = new Set(['resend-verify-cooldown', 'login-ip', 'signup-ip', 'password-reset-ip', 'quote-intake-ip']);
  for (const name of Object.keys(policy.rateLimit)) {
    if (protectedBuckets.has(name)) {
      if (name === 'resend-verify-cooldown' && Number.isFinite(cooldownSec) && cooldownSec >= 0) {
        policy.rateLimit[name] = { ...policy.rateLimit[name], windowSeconds: cooldownSec };
      }
      continue;
    }
    const bucket = { ...policy.rateLimit[name] };
    if (Number.isFinite(rateMax) && rateMax > 0) bucket.max = rateMax;
    if (Number.isFinite(rateWindow) && rateWindow >= 0) bucket.windowSeconds = rateWindow;
    policy.rateLimit[name] = bucket;
  }
  return policy;
}

function authJson(data, status, extra) {
  return json(data, status, { ...CORS_HEADERS_CREDENTIALS, ...(extra || {}) });
}

/** Same-origin gate for cookie routes. A missing Origin (CLI, cron) is rejected. */
function originOk(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  const list = corsAllowedOrigins(env);
  // An empty allow list is a deliberate deny-all, not an invitation to fall
  // back to the old GitHub Pages origin. Deployments must name their origin.
  if (!list.length) return false;
  if (!originStrict(env) && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return list.includes(origin);
}

function corsAllowedOrigins(env) {
  return String(env.CORS_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function siteBaseUrl(env) {
  return String(env.SITE_BASE_URL || DEFAULT_SITE_BASE_URL).replace(/\/$/, '');
}

/** CSRF: the token must equal the request Origin, or a configured constant. */
function csrfOk(request, env) {
  const token = request.headers.get('X-CSRF-Token');
  if (!token) return false;
  if (token === request.headers.get('Origin')) return true;
  const expected = String(env.AUTH_CSRF_TOKEN || '').trim();
  return !!expected && token === expected;
}

function guardAuth(request, env) {
  if (!originOk(request, env)) {
    return authJson({ error: 'origin not allowed', detail: { allowed: corsAllowedOrigins(env) } }, 403);
  }
  if (!csrfOk(request, env)) {
    return authJson({ error: 'csrf token required', detail: 'X-CSRF-Token must equal the request Origin' }, 403);
  }
  return null;
}

function getMember(db, id) {
  return db.prepare('SELECT * FROM members WHERE id = ?').bind(id).first();
}

function getMemberByEmail(db, email) {
  return db.prepare('SELECT * FROM members WHERE email = ?').bind(String(email || '').trim().toLowerCase()).first();
}

function memberView(member) {
  if (!member) return null;
  const email = String(member.email || '').trim().toLowerCase();
  const superadmin = SUPERADMIN_EMAILS.has(email) && !!member.email_verified_at;
  const role = superadmin ? 'superadmin' : (member.role || 'member');
  return {
    id: member.id,
    email: member.email,
    name: member.name,
    phone: member.phone,
    company: member.company,
    email_verified: !!member.email_verified_at,
    email_verified_at: member.email_verified_at,
    role,
    is_admin: role === 'admin' || role === 'superadmin',
    status: member.status,
    created_at: member.created_at,
    updated_at: member.updated_at,
  };
}

function memberQuoteView(row) {
  if (!row) return null;
  return {
    id: row.id,
    created_at: row.created_at,
    status: row.status,
    total: row.total,
    company: row.company,
    contact_name: row.contact_name,
    phone: row.phone,
    location: row.location,
    note: row.note,
    services: JSON.parse(row.services || '[]'),
    items: JSON.parse(row.items || '[]'),
  };
}

/** The Cloudflare-set source address, or null when the runtime did not supply one. */
function clientIp(request) {
  const value = String(request.headers.get('CF-Connecting-IP') || '').trim();
  return value ? value.slice(0, 64) : null;
}

/** Clear one counter after a successful action (a successful login is not a strike). */
async function clearRateLimit(db, kind, key) {
  if (!key) return;
  await db.prepare('DELETE FROM auth_attempts WHERE kind = ? AND key = ?').bind(kind, key).run();
}

/** Sliding-window rate limit over auth_attempts(kind, key). */
async function rateLimitCheck(db, policy, kind, key) {
  const bucket = policy.rateLimit[kind];
  if (!bucket || !key) return { ok: true };
  const now = nowIso();
  const row = await db.prepare('SELECT * FROM auth_attempts WHERE kind = ? AND key = ?').bind(kind, key).first();
  if (row) {
    if (row.locked_until && String(row.locked_until) > now) {
      return { error: 'rate limited', detail: { retry_after: String(row.locked_until) } };
    }
    const inWindow = bucket.windowSeconds > 0 && shiftIso(now, -bucket.windowSeconds) <= String(row.last_at);
    if (inWindow && Number(row.count) >= bucket.max) {
      const lockedUntil = shiftIso(now, bucket.windowSeconds);
      await db.prepare('UPDATE auth_attempts SET count = count + 1, last_at = ?, locked_until = ? WHERE kind = ? AND key = ?')
        .bind(now, lockedUntil, kind, key).run();
      return { error: 'rate limited', detail: { retry_after: lockedUntil } };
    }
    await db.prepare('UPDATE auth_attempts SET count = ?, first_at = ?, last_at = ?, locked_until = ? WHERE kind = ? AND key = ?')
      .bind(inWindow ? Number(row.count) + 1 : 1, inWindow ? row.first_at : now, now, null, kind, key).run();
    return { ok: true };
  }
  try {
    await db.prepare('INSERT INTO auth_attempts (kind, key, count, first_at, last_at) VALUES (?, ?, 1, ?, ?)')
      .bind(kind, key, now, now).run();
  } catch (e) {
    await db.prepare('UPDATE auth_attempts SET count = count + 1, last_at = ? WHERE kind = ? AND key = ?')
      .bind(now, kind, key).run();
  }
  return { ok: true };
}

/** Insert a token by digest only, then deliver the matching mail message. */
async function issueToken(db, env, mail, member, kind, path, subject, text) {
  const policy = authPolicy(env);
  const now = nowIso();
  const ttlSeconds = kind === 'session'
    ? policy.sessionTtlSeconds
    : kind === 'password_reset' ? policy.passwordResetTtlSeconds : policy.verifyEmailTtlSeconds;
  const expiresAt = shiftIso(now, ttlSeconds);

  // Revoke any previous pending token of the same kind so only the newest
  // verification / reset link is valid. Sessions are exempt.
  if (kind !== 'session') {
    await db.prepare("UPDATE auth_tokens SET status = 'revoked', revoked_at = ? WHERE member_id = ? AND kind = ? AND status = 'pending'")
      .bind(now, member.id, kind).run();
  }

  const rawToken = randomToken();
  const url = mail.urlFor(path, rawToken);
  await db.prepare(
    'INSERT INTO auth_tokens (member_id, kind, token_hash, email, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(member.id, kind, await tokenDigest(rawToken), member.email, 'pending', expiresAt, now).run();
  const delivered = await mail.deliver({ to: member.email, subject, text, url, token: rawToken });
  return {
    token: rawToken,
    url,
    expires_at: expiresAt,
    mail: {
      delivered: !!delivered.delivered,
      channel: delivered.channel || mail.mode,
      note: delivered.note || null,
      echo_token: delivered.token || undefined,
      echo_url: delivered.url || undefined,
    },
  };
}

async function getAuthToken(db, token) {
  const row = await db.prepare('SELECT * FROM auth_tokens WHERE token_hash = ?').bind(await tokenDigest(token)).first();
  return row || null;
}

async function revokeMemberSessions(db, memberId) {
  const now = nowIso();
  await db.prepare("UPDATE auth_tokens SET status = 'revoked', revoked_at = ? WHERE member_id = ? AND kind = 'session' AND status = 'pending'")
    .bind(now, memberId).run();
}

/** Insert a session token and build the Set-Cookie value for it. */
async function issueSession(db, env, member) {
  const policy = authPolicy(env);
  const now = nowIso();
  const token = randomToken();
  const expiresAt = shiftIso(now, policy.sessionTtlSeconds);
  await db.prepare(
    'INSERT INTO auth_tokens (member_id, kind, token_hash, email, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(member.id, 'session', await tokenDigest(token), member.email, 'pending', expiresAt, now).run();
  const secure = authCookieSecure(env) ? 'Secure; ' : '';
  return { token, expires_at: expiresAt, cookie: `${authCookieName(env)}=${token}; HttpOnly; SameSite=None; ${secure}Path=/; Max-Age=${policy.sessionTtlSeconds}` };
}

async function loadSession(request, db, env) {
  const name = authCookieName(env);
  const raw = request.headers.get('Cookie') || '';
  const part = raw.split(/;\s*/).find((piece) => piece.startsWith(`${name}=`));
  if (!part) return null;
  let value;
  try {
    value = decodeURIComponent(part.slice(name.length + 1));
  } catch (e) {
    // A malformed percent-escape in the cookie header must read as "no session",
    // not crash the whole request with a URIError.
    return null;
  }
  if (!value) return null;
  const row = await getAuthToken(db, value);
  if (!row || row.kind !== 'session' || row.status !== 'pending') return null;
  if (String(row.expires_at) <= nowIso()) return null;
  return row;
}

/** Raised when a live session belongs to a member whose email is unverified. */
class EmailNotVerifiedError extends Error {
  constructor(member) {
    super('email not verified');
    this.name = 'EmailNotVerifiedError';
    this.code = 'email_not_verified';
    this.member = member;
  }
}

async function requireMember(request, db, env, { allowUnverified = false } = {}) {
  const session = await loadSession(request, db, env);
  if (!session) return null;
  const member = await getMember(db, session.member_id);
  if (!member) return null;
  if (SUPERADMIN_EMAILS.has(String(member.email || '').trim().toLowerCase()) && member.email_verified_at) {
    member.role = 'superadmin';
  } else if (!member.role) {
    member.role = 'member';
  }
  if (member.status === 'deleted') {
    await db.prepare("UPDATE auth_tokens SET status = 'revoked', revoked_at = ? WHERE id = ?").bind(nowIso(), session.id).run();
    return null;
  }
  // EMAIL_VERIFY_REQUIRED=YES used to gate login only; an already-issued session
  // kept full member access for its 30-day lifetime. Enforce it on every
  // requireMember call instead. GET /api/me, resend-verification and logout are
  // the only sanctioned exceptions (the session itself must stay usable so the
  // member can finish verification).
  if (!allowUnverified && emailVerifyRequired(env) && !member.email_verified_at) {
    throw new EmailNotVerifiedError(member);
  }
  return member;
}

// ---------------------------------------------------------------------------
// Google OAuth (issue #79)
// ---------------------------------------------------------------------------

function authRedirect(url) {
  return new Response(null, { status: 302, headers: { Location: url } });
}

async function getMemberByGoogleId(db, googleId) {
  try {
    const { results } = await db.prepare('SELECT * FROM members WHERE google_id = ? LIMIT 1').bind(googleId).all();
    return results && results[0] ? results[0] : null;
  } catch (e) {
    return null;
  }
}

async function handleGoogleStart(request, db, env) {
  const clientId = env.GOOGLE_CLIENT_ID || env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET || env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return authJson({ error: 'google oauth not configured' }, 503);
  }

  const redirectUri = new URL('/api/auth/google/callback', request.url).toString();
  const returnTo = normalizeOAuthReturn(new URL(request.url).searchParams.get('return'));
  const state = await createOAuthState(env.AUTH_SESSION_SECRET || 'cgi-dev-secret', Date.now(), returnTo);

  const authUrl = buildAuthorizationUrl({ clientId, redirectUri }, state);
  if (!authUrl) return authJson({ error: 'google oauth not configured' }, 503);

  const cookieOpts = oauthStateCookieOptions();
  const cookieAttrs = [];
  if (cookieOpts.httpOnly) cookieAttrs.push('HttpOnly');
  if (cookieOpts.secure) cookieAttrs.push('Secure');
  if (cookieOpts.sameSite) cookieAttrs.push(`SameSite=${cookieOpts.sameSite}`);
  if (cookieOpts.path) cookieAttrs.push(`Path=${cookieOpts.path}`);
  if (cookieOpts.maxAge != null) cookieAttrs.push(`Max-Age=${cookieOpts.maxAge}`);
  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl,
      'Set-Cookie': `${OAUTH_STATE_COOKIE}=${state}; ${cookieAttrs.join('; ')}`,
    },
  });
}

async function handleGoogleCallback(request, db, env) {
  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  if (error) {
    return authJson({ error: 'google auth failed', detail: error }, 400);
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    return authJson({ error: 'missing code or state' }, 400);
  }

  // Verify CSRF state from cookie
  const cookieState = request.headers.get('Cookie')?.match(new RegExp(OAUTH_STATE_COOKIE + '=([^;]+)'))?.[1];
  if (!cookieState || cookieState !== state) {
    return authJson({ error: 'invalid state', detail: 'CSRF state mismatch' }, 400);
  }
  // Verify the state token's signature and expiry, and read the origin page it
  // carries. The return target comes from the signed payload — never the query
  // string — and is clamped to the allowlist inside resolveOAuthRedirect.
  const stateSecret = env.AUTH_SESSION_SECRET || 'cgi-dev-secret';
  const statePayload = await decodeOAuthState(stateSecret, state);
  if (!statePayload) {
    return authJson({ error: 'invalid state', detail: 'state expired or tampered' }, 400);
  }

  const clientId = env.GOOGLE_CLIENT_ID || env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET || env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = new URL('/api/auth/google/callback', request.url).toString();

  // Clear state cookie
  const clearCookie = `${OAUTH_STATE_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;

  try {
    // Exchange code for access token
    const accessToken = await exchangeCode({ clientId, clientSecret }, code, redirectUri);

    // Fetch user info
    const userInfo = await fetchUserInfo(accessToken);

    // Find existing member by Google ID
    let member = await getMemberByGoogleId(db, userInfo.subject);

    if (!member) {
      // Find by email (account linking)
      member = await getMemberByEmail(db, userInfo.email);
      if (member) {
        const now = nowIso();
        // A member that never verified its mailbox may be a squatted placeholder:
        // whoever typed this email first, nobody proved ownership through email.
        // Google proves it now, so the Google identity takes the account over —
        // but the pre-set password must stop working and old sessions must die,
        // or the squatter keeps a back door (and superadmin if the email is on
        // the designated list).
        if (!member.email_verified_at) {
          await db.prepare('UPDATE members SET google_id = ?, password_hash = ?, updated_at = ? WHERE id = ?')
            .bind(userInfo.subject, 'revoked$google-takeover$0$0', now, member.id).run();
          await revokeMemberSessions(db, member.id);
          await db.prepare('INSERT INTO member_events (member_id, type, meta, created_at) VALUES (?, ?, ?, ?)')
            .bind(member.id, 'google_takeover_unclaimed', JSON.stringify({ google_id: userInfo.subject, password_revoked: true }), now).run();
        } else {
          await db.prepare('UPDATE members SET google_id = ?, updated_at = ? WHERE id = ?')
            .bind(userInfo.subject, now, member.id).run();
          await db.prepare('INSERT INTO member_events (member_id, type, meta, created_at) VALUES (?, ?, ?, ?)')
            .bind(member.id, 'google_linked', JSON.stringify({ google_id: userInfo.subject }), now).run();
        }
        member = { ...member, google_id: userInfo.subject };
      } else {
        // Create new member
        const now = nowIso();
        const passwordHash = GOOGLE_SIGNUP_PASSWORD_SENTINEL;
        const result = await db.prepare(
          'INSERT INTO members (email, password_hash, name, google_id, status, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(userInfo.email, passwordHash, userInfo.name || userInfo.email.split('@')[0], userInfo.subject, 'active', now, now, now).run();
        const memberId = result.meta.last_row_id ?? result.meta.last_rowid ?? 0;
        member = await getMember(db, memberId);
        await db.prepare('INSERT INTO member_events (member_id, type, meta, created_at) VALUES (?, ?, ?, ?)')
          .bind(memberId, 'google_signup', JSON.stringify({ google_id: userInfo.subject }), now).run();
      }
    }

    // Google has already verified this address, so an existing member matched
    // by Google ID or email must be marked verified as well. Without this, the
    // two designated superadmin accounts stay unverified (and therefore lose
    // admin access) whenever they first log in through Google.
    if (!member.email_verified_at) {
      const now = nowIso();
      await db.prepare('UPDATE members SET email_verified_at = ?, updated_at = ? WHERE id = ?')
        .bind(now, now, member.id).run();
      await db.prepare('INSERT INTO member_events (member_id, type, meta, created_at) VALUES (?, ?, ?, ?)')
        .bind(member.id, 'email_verified', JSON.stringify({ source: 'google' }), now).run();
      member = { ...member, email_verified_at: now };
    }

    // Issue session and redirect back to the site
    const session = await issueSession(db, env, member);
    const redirectUrl = resolveOAuthRedirect(env.SITE_BASE_URL, statePayload.u);
    const headers = new Headers();
    headers.set('Location', redirectUrl);
    headers.append('Set-Cookie', session.cookie);
    headers.append('Set-Cookie', clearCookie);
    return new Response(null, { status: 302, headers });

  } catch (e) {
    // Upstream OAuth failures can embed request URLs, codes or fragments of a
    // provider payload; the customer only needs to know the sign-in failed.
    return authJson({ error: 'google auth failed' }, 400);
  }
}

// ---------------------------------------------------------------------------
// auth routes
// ---------------------------------------------------------------------------

async function handleAuthRoute(pathname, method, request, db, env) {
  // Google OAuth endpoints are GET redirects that don't require CSRF token
  // (browser navigation via window.location.href doesn't send custom headers)
  if (pathname === '/api/auth/google/start' && method === 'GET') {
    return handleGoogleStart(request, db, env);
  }
  if (pathname === '/api/auth/google/callback' && method === 'GET') {
    return handleGoogleCallback(request, db, env);
  }

  const guard = guardAuth(request, env);
  if (guard) return guard;
  const mail = createMailAdapter(env, console.log);
  const parsed = await readJson(request);
  if (parsed.error) return authJson({ error: parsed.error, detail: 'send the body encoded as UTF-8' }, 400);
  const body = parsed.body && typeof parsed.body === 'object' ? parsed.body : {};

  // ---------------- signup ----------------

  if (pathname === '/api/auth/signup' && method === 'POST') {
    const email = validateEmail(body.email);
    if (!email.ok) return authJson({ error: email.error, detail: email.detail }, 400);
    const name = validateName(body.name);
    if (!name.ok) return authJson({ error: name.error, detail: name.detail }, 400);
    const phone = body.phone == null || String(body.phone).trim() === '' ? { ok: true, phone: null } : validatePhone(body.phone);
    if (!phone.ok) return authJson({ error: phone.error, detail: phone.detail }, 400);
    const company = validateOptionalText(body.company, 'company', 100);
    if (company.error) return authJson({ error: company.error, detail: company.detail }, 400);
    const policy = authPolicy(env);
    const password = validatePassword(body.password, { email: email.email, policy });
    if (!password.ok) return authJson({ error: password.error, detail: password.detail }, 400);
    // 회원가입 필수 동의(이용약관·개인정보 수집/이용) — 입력 검증 후, 미동의 가입은 거부하고 별도 이벤트로 기록한다.
    const terms = body.terms === true;
    const privacy = body.privacy === true;
    if (!terms || !privacy) {
      return authJson({ error: 'consent required', detail: '이용약관과 개인정보 수집·이용 동의가 필요합니다.' }, 400);
    }
    const termsVersion = typeof body.terms_version === 'string' && body.terms_version.trim() ? body.terms_version.trim().slice(0, 40) : 'unknown';
    const privacyVersion = typeof body.privacy_version === 'string' && body.privacy_version.trim() ? body.privacy_version.trim().slice(0, 40) : 'unknown';

    const ip = clientIp(request);
    if (ip) {
      const ipLimit = await rateLimitCheck(db, policy, 'signup-ip', ip);
      if (ipLimit.error) return authJson({ error: ipLimit.error, detail: ipLimit.detail }, 429);
    }
    const limit = await rateLimitCheck(db, policy, 'signup', email.email);
    if (limit.error) return authJson({ error: limit.error, detail: limit.detail }, 429);
    if (await getMemberByEmail(db, email.email)) {
      return authJson({ error: 'email already used', detail: 'this email address is already registered' }, 409);
    }

    const now = nowIso();
    const passwordHash = await hashPassword(password.password, policy);
    let memberId;
    try {
      const result = await db.prepare(
        `INSERT INTO members (email, password_hash, name, phone, company, status,
           terms_consent_version, privacy_consent_version, consented_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        email.email, passwordHash, name.name, phone.phone, company.value, 'active',
        termsVersion, privacyVersion, now, now, now
      ).run();
      memberId = result.meta.last_row_id ?? result.meta.last_rowid ?? 0;
    } catch (e) {
      return authJson({ error: 'email already used', detail: 'this email address is already registered' }, 409);
    }

    await db.prepare('INSERT INTO member_events (member_id, type, meta, created_at) VALUES (?, ?, ?, ?)')
      .bind(memberId, 'signup', JSON.stringify({ verified: false }), now).run();
    await db.prepare('INSERT INTO member_events (member_id, type, meta, created_at) VALUES (?, ?, ?, ?)')
      .bind(memberId, 'consent', JSON.stringify({ terms: true, privacy: true, terms_version: termsVersion, privacy_version: privacyVersion }), now).run();
    const member = await getMember(db, memberId);
    const issued = await issueToken(db, env, mail, member, 'verify_email', '/auth/verify', 'CGI 이메일 인증', '아래 링크에서 이메일 인증을 완료하세요.');
    const session = await issueSession(db, env, member);
    return authJson({
      member: memberView(member),
      email_verified: false,
      email_verify_required: emailVerifyRequired(env),
      mail: issued.mail,
    }, 201, { 'Set-Cookie': session.cookie });
  }

  // ---------------- email availability ----------------

  if (pathname === '/api/auth/email-available' && method === 'POST') {
    const email = validateEmail(body.email);
    if (!email.ok) return authJson({ error: email.error, detail: email.detail }, 400);
    const policy = authPolicy(env);
    const limit = await rateLimitCheck(db, policy, 'email-check', email.email);
    if (limit.error) return authJson({ error: limit.error, detail: limit.detail }, 429);
    const exists = !!(await getMemberByEmail(db, email.email));
    return authJson({ available: !exists });
  }

  // ---------------- email verification ----------------

  if (pathname === '/api/auth/verify-email' && method === 'POST') {
    const policy = authPolicy(env);
    const providedMemberId = body.member_id == null ? null : Number(body.member_id);
    if (providedMemberId !== null && (!Number.isInteger(providedMemberId) || providedMemberId <= 0)) {
      return authJson({ error: 'member_id required' }, 400);
    }
    if (!body.token) return authJson({ error: 'token required' }, 400);
    // Bucket per member when an id is sent, otherwise per token digest. The old
    // constant 'token' key shared one global bucket: ten failed clicks by anyone
    // locked email verification out for every customer for a day.
    const verifyBucketKey = providedMemberId != null
      ? String(providedMemberId)
      : `tok:${await tokenDigest(String(body.token || ''))}`;
    const limit = await rateLimitCheck(db, policy, 'email-verify', verifyBucketKey);
    if (limit.error) return authJson({ error: limit.error, detail: limit.detail }, 429);

    const row = await getAuthToken(db, body.token);
    // The mail link only carries the token, so member_id is optional: the token
    // hash is unique and points at its own member. When a member_id IS sent it is
    // still a binding that must match, so a leaked token cannot verify a
    // different account.
    const memberId = providedMemberId == null ? Number(row && row.member_id || 0) : providedMemberId;

    const member = await getMember(db, memberId);
    if (!member || member.status === 'deleted') return authJson({ error: 'member not found' }, 404);
    if (member.email_verified_at) return authJson({ email_verified: true, already_verified: true });

    if (!row || row.kind !== 'verify_email' || row.status !== 'pending') {
      return authJson({ error: 'invalid token', detail: 'verification token is invalid or already used' }, 400);
    }
    if (Number(row.member_id) !== memberId) {
      return authJson({ error: 'member not found' }, 404);
    }
    if (String(row.expires_at) <= nowIso()) {
      await db.prepare("UPDATE auth_tokens SET status = 'expired', revoked_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
      return authJson({ error: 'token expired', detail: 'request a new verification email' }, 400);
    }
    if (row.email && row.email !== member.email) {
      return authJson({ error: 'invalid token', detail: 'token does not match the account email' }, 400);
    }

    const now = nowIso();
    await db.batch([
      db.prepare("UPDATE auth_tokens SET status = 'consumed', consumed_at = ? WHERE id = ?").bind(now, row.id),
      db.prepare('UPDATE members SET email_verified_at = ?, updated_at = ? WHERE id = ?').bind(now, now, memberId),
      db.prepare('INSERT INTO member_events (member_id, type, created_at) VALUES (?, ?, ?)').bind(memberId, 'email_verified', now),
    ]);
    return authJson({ email_verified: true, verified_at: now });
  }

  // ---------------- resend verification ----------------

  if (pathname === '/api/auth/resend-verification' && method === 'POST') {
    const member = await requireMember(request, db, env, { allowUnverified: true });
    if (!member) return authJson({ error: 'unauthorized', detail: 'sign in to resend the verification email' }, 401);
    const policy = authPolicy(env);
    const cooldownLimit = await rateLimitCheck(db, policy, 'resend-verify-cooldown', member.email);
    if (cooldownLimit.error) {
      return authJson({ error: cooldownLimit.error, detail: cooldownLimit.detail, retry_after_seconds: 60 }, 429);
    }
    const limit = await rateLimitCheck(db, policy, 'resend-verify', member.email);
    if (limit.error) return authJson({ error: limit.error, detail: limit.detail }, 429);
    if (member.email_verified_at) return authJson({ email_verified: true, already_verified: true });
    const issued = await issueToken(db, env, mail, member, 'verify_email', '/auth/verify', 'CGI 이메일 인증', '아래 링크에서 이메일 인증을 완료하세요.');
    return authJson({ email_verified: false, email_verify_required: emailVerifyRequired(env), mail: issued.mail, resend_cooldown_seconds: 60 });
  }

  // ---------------- login ----------------

  if (pathname === '/api/auth/login' && method === 'POST') {
    const email = validateEmail(body.email);
    if (!email.ok) return authJson({ error: email.error, detail: email.detail }, 400);
    const policy = authPolicy(env);
    const ip = clientIp(request);
    if (ip) {
      const ipLimit = await rateLimitCheck(db, policy, 'login-ip', ip);
      if (ipLimit.error) return authJson({ error: ipLimit.error, detail: ipLimit.detail }, 429);
    }
    const limit = await rateLimitCheck(db, policy, 'login', email.email);
    if (limit.error) return authJson({ error: limit.error, detail: limit.detail }, 429);
    if (!body.password) return authJson({ error: 'password required' }, 400);

    const member = await getMemberByEmail(db, email.email);
    if (!member) return authJson({ error: 'invalid credentials', detail: 'email address or password is wrong' }, 401);
    if (member.status === 'deleted') return authJson({ error: 'account deleted', detail: 'this account has been deleted' }, 403);
    if (member.status === 'suspended') return authJson({ error: 'account suspended', detail: 'this account has been suspended' }, 403);

    const ok = await verifyPassword(body.password, member.password_hash, policy);
    if (!ok) return authJson({ error: 'invalid credentials', detail: 'email address or password is wrong' }, 401);
    if (emailVerifyRequired(env) && !member.email_verified_at) {
      return authJson({ error: 'email not verified', detail: 'verify the email address before signing in' }, 403);
    }

    const session = await issueSession(db, env, member);
    // A successful sign-in clears the failure counter for this address: keeping
    // successful attempts in the same bucket let an outsider lock a known
    // address (the seeded admin addresses are in source) with five failures.
    await clearRateLimit(db, 'login', email.email);
    await db.prepare('INSERT INTO member_events (member_id, type, created_at) VALUES (?, ?, ?)')
      .bind(member.id, 'login', nowIso()).run();
    return authJson({ member: memberView(member), email_verified: !!member.email_verified_at }, 200, { 'Set-Cookie': session.cookie });
  }

  // ---------------- logout ----------------

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const session = await loadSession(request, db, env);
    if (session) {
      await db.prepare("UPDATE auth_tokens SET status = 'revoked', revoked_at = ? WHERE id = ?").bind(nowIso(), session.id).run();
      await db.prepare('INSERT INTO member_events (member_id, type, created_at) VALUES (?, ?, ?)')
        .bind(session.member_id, 'logout', nowIso()).run();
    }
    const secure = authCookieSecure(env) ? 'Secure; ' : '';
    return authJson({ ok: true }, 200, {
      'Set-Cookie': `${authCookieName(env)}=; HttpOnly; SameSite=None; ${secure}Path=/; Max-Age=0`,
    });
  }

  // ---------------- password reset ----------------

  if (pathname === '/api/auth/password-reset/request' && method === 'POST') {
    const email = validateEmail(body.email);
    if (!email.ok) return authJson({ error: email.error, detail: email.detail }, 400);
    const policy = authPolicy(env);
    const ip = clientIp(request);
    if (ip) {
      const ipLimit = await rateLimitCheck(db, policy, 'password-reset-ip', ip);
      if (ipLimit.error) return authJson({ error: ipLimit.error, detail: ipLimit.detail }, 429);
    }
    const limit = await rateLimitCheck(db, policy, 'password-reset', email.email);
    if (limit.error) return authJson({ error: limit.error, detail: limit.detail }, 429);

    const member = await getMemberByEmail(db, email.email);
    if (member && member.status !== 'deleted') {
      const issued = await issueToken(db, env, mail, member, 'password_reset', '/auth/reset', 'CGI 비밀번호 재설정', '아래 링크에서 새 비밀번호를 설정하세요.');
      return authJson({ ok: true, requested: true, mail: issued.mail });
    }
    // Do not leak whether the address exists.
    return authJson({ ok: true, requested: true, mail: { delivered: false, channel: mail.mode } });
  }

  if (pathname === '/api/auth/password-reset/confirm' && method === 'POST') {
    if (!body.token) return authJson({ error: 'token required' }, 400);
    const policy = authPolicy(env);
    const row = await getAuthToken(db, body.token);
    if (!row || row.kind !== 'password_reset' || row.status !== 'pending') {
      return authJson({ error: 'invalid token', detail: 'reset token is invalid or already used' }, 400);
    }
    if (String(row.expires_at) <= nowIso()) {
      await db.prepare("UPDATE auth_tokens SET status = 'expired', revoked_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
      return authJson({ error: 'token expired', detail: 'request a new reset email' }, 400);
    }
    const member = await getMember(db, row.member_id);
    if (!member || member.status === 'deleted') {
      return authJson({ error: 'invalid token', detail: 'account no longer exists' }, 400);
    }
    const password = validatePassword(body.password, { email: member.email, policy });
    if (!password.ok) return authJson({ error: password.error, detail: password.detail }, 400);

    const now = nowIso();
    const passwordHash = await hashPassword(password.password, policy);
    await db.batch([
      db.prepare('UPDATE members SET password_hash = ?, updated_at = ? WHERE id = ?').bind(passwordHash, now, member.id),
      db.prepare("UPDATE auth_tokens SET status = 'consumed', consumed_at = ? WHERE id = ?").bind(now, row.id),
      db.prepare('INSERT INTO member_events (member_id, type, created_at) VALUES (?, ?, ?)').bind(member.id, 'password_reset', now),
    ]);
    await revokeMemberSessions(db, member.id);
    const session = await issueSession(db, env, member);
    return authJson({ ok: true, member: memberView({ ...member, updated_at: now }) }, 200, { 'Set-Cookie': session.cookie });
  }

  return null;
}

// ---------------------------------------------------------------------------
// my page (issue #69)
// ---------------------------------------------------------------------------

async function handleMeRoute(pathname, method, url, request, db, env) {
  const guard = guardAuth(request, env);
  if (guard) return guard;
  // GET /api/me is the one member route an unverified session may still call:
  // the site needs it to detect the account and show the "verify your email"
  // screen instead of signing the member out.
  const member = await requireMember(request, db, env, {
    allowUnverified: pathname === '/api/me' && method === 'GET',
  });
  if (!member) return authJson({ error: 'unauthorized', detail: 'sign in first' }, 401);
  const parsed = await readJson(request);
  if (parsed.error) return authJson({ error: parsed.error, detail: 'send the body encoded as UTF-8' }, 400);
  const body = parsed.body && typeof parsed.body === 'object' ? parsed.body : {};
  const policy = authPolicy(env);

  // ---------------- profile ----------------

  if (pathname === '/api/me') {
    if (method === 'GET') return authJson({ member: memberView(member) });

    if (method === 'PATCH') {
      const fields = {};
      if (body.name !== undefined) {
        const name = validateName(body.name);
        if (!name.ok) return authJson({ error: name.error, detail: name.detail }, 400);
        fields.name = name.name;
      }
      if (body.phone !== undefined) {
        if (body.phone == null || String(body.phone).trim() === '') {
          fields.phone = null;
        } else {
          const phone = validatePhone(body.phone);
          if (!phone.ok) return authJson({ error: phone.error, detail: phone.detail }, 400);
          fields.phone = phone.phone;
        }
      }
      if (body.company !== undefined) {
        const company = validateOptionalText(body.company, 'company', 100);
        if (company.error) return authJson({ error: company.error, detail: company.detail }, 400);
        fields.company = company.value;
      }
      if (body.email !== undefined) {
        const email = validateEmail(body.email);
        if (!email.ok) return authJson({ error: email.error, detail: email.detail }, 400);
        if (email.email !== member.email) return authJson({ error: 'email change not supported', detail: 'register a new account to change the email address' }, 400);
        fields.email = email.email;
      }
      if (Object.keys(fields).length === 0) return authJson({ error: 'no changes', detail: 'nothing to update' }, 400);
      const now = nowIso();
      const sets = Object.keys(fields).map((key) => `${key} = ?`);
      sets.push('updated_at = ?');
      const params = Object.values(fields).concat([now, member.id]);
      await db.prepare(`UPDATE members SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();
      const updated = await getMember(db, member.id);
      await db.prepare('INSERT INTO member_events (member_id, type, meta, created_at) VALUES (?, ?, ?, ?)')
        .bind(member.id, 'profile_updated', JSON.stringify(Object.keys(fields)), now).run();
      return authJson({ member: memberView(updated) });
    }

    if (method === 'DELETE') {
      const confirm = String(body.confirm || '').trim();
      if (confirm !== 'delete-member') {
        return authJson({ error: 'confirmation required', detail: 'send confirm="delete-member" to delete the account' }, 400);
      }
      const openCount = await db.prepare('SELECT COUNT(*) AS c FROM orders WHERE customer_id = ? AND status NOT IN (?, ?, ?)')
        .bind(member.id, 'cancelled', 'expired', 'refunded').first();
      if (openCount && Number(openCount.c) > 0) {
        return authJson({ error: 'open orders', detail: { count: Number(openCount.c) } }, 409);
      }
      const now = nowIso();
      await db.batch([
        db.prepare("UPDATE members SET status = 'deleted', deleted_at = ?, name = '탈퇴회원', phone = NULL, company = NULL, email = ?, updated_at = ? WHERE id = ?")
          .bind(now, `deleted-${member.id}-${nowIso().slice(0, 10)}@cgi.invalid`, now, member.id),
        db.prepare("UPDATE auth_tokens SET status = 'revoked', revoked_at = ? WHERE member_id = ?").bind(now, member.id),
        db.prepare('DELETE FROM member_addresses WHERE member_id = ?').bind(member.id),
        db.prepare('INSERT INTO member_events (member_id, type, created_at) VALUES (?, ?, ?)').bind(member.id, 'deleted', now),
      ]);
      const secure = authCookieSecure(env) ? 'Secure; ' : '';
      return authJson({ ok: true, deleted: true }, 200, {
        'Set-Cookie': `${authCookieName(env)}=; HttpOnly; SameSite=None; ${secure}Path=/; Max-Age=0`,
      });
    }
    return authJson({ error: 'method not allowed' }, 405);
  }

  // ---------------- password ----------------

  if (pathname === '/api/me/password' && method === 'POST') {
    const limit = await rateLimitCheck(db, policy, 'password-change', member.id);
    if (limit.error) return authJson({ error: limit.error, detail: limit.detail }, 429);
    const current = String(body.current_password || '');
    if (!current) return authJson({ error: 'current password required' }, 400);
    const ok = await verifyPassword(current, member.password_hash, policy);
    if (!ok) return authJson({ error: 'invalid credentials', detail: 'current password is wrong' }, 401);
    const password = validatePassword(body.password, { email: member.email, policy });
    if (!password.ok) return authJson({ error: password.error, detail: password.detail }, 400);
    const now = nowIso();
    await db.prepare('UPDATE members SET password_hash = ?, updated_at = ? WHERE id = ?')
      .bind(await hashPassword(password.password, policy), now, member.id).run();
    await revokeMemberSessions(db, member.id);
    const session = await issueSession(db, env, member);
    await db.prepare('INSERT INTO member_events (member_id, type, created_at) VALUES (?, ?, ?)')
      .bind(member.id, 'password_changed', now).run();
    return authJson({ ok: true }, 200, { 'Set-Cookie': session.cookie });
  }

  // ---------------- addresses ----------------

  if (pathname === '/api/me/addresses' && method === 'GET') {
    const { results } = await db.prepare('SELECT * FROM member_addresses WHERE member_id = ? ORDER BY is_default DESC, id DESC').bind(member.id).all();
    return authJson({ items: results || [] });
  }

  if (pathname === '/api/me/addresses' && method === 'POST') {
    const countRow = await db.prepare('SELECT COUNT(*) AS c FROM member_addresses WHERE member_id = ?').bind(member.id).first();
    if (countRow && Number(countRow.c) >= policy.maxAddressesPerMember) {
      return authJson({ error: 'too many addresses', detail: { max: policy.maxAddressesPerMember } }, 409);
    }
    const label = validateText(body.label, 'label', 40);
    if (!label.ok) return authJson({ error: label.error, detail: label.detail }, 400);
    const recipient = validateName(body.recipient_name);
    if (!recipient.ok) return authJson({ error: recipient.error, detail: recipient.detail }, 400);
    const phone = validatePhone(body.phone);
    if (!phone.ok) return authJson({ error: phone.error, detail: phone.detail }, 400);
    const addr = validateText(body.addr, 'addr', 120);
    if (!addr.ok) return authJson({ error: addr.error, detail: addr.detail }, 400);
    const addrDetail = validateOptionalText(body.addr_detail, 'addr_detail', 100);
    if (addrDetail.error) return authJson({ error: addrDetail.error, detail: addrDetail.detail }, 400);
    const company = validateOptionalText(body.company, 'company', 100);
    if (company.error) return authJson({ error: company.error, detail: company.detail }, 400);
    const now = nowIso();
    const isDefault = body.is_default ? 1 : 0;
    const stmts = [];
    if (isDefault) stmts.push(db.prepare('UPDATE member_addresses SET is_default = 0 WHERE member_id = ?').bind(member.id));
    await db.batch([
      ...stmts,
      db.prepare('INSERT INTO member_addresses (member_id, label, recipient_name, phone, addr, addr_detail, company, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(member.id, label.value, recipient.name, phone.phone, addr.value, addrDetail.value, company.value, isDefault, now, now),
    ]);
    const inserted = await db.prepare('SELECT * FROM member_addresses WHERE member_id = ? ORDER BY id DESC LIMIT 1').bind(member.id).first();
    return authJson({ address: inserted }, 201);
  }

  const addressMatch = pathname.match(/^\/api\/me\/addresses\/(\d+)$/);
  if (addressMatch) {
    const id = Number(addressMatch[1]);
    const address = await db.prepare('SELECT * FROM member_addresses WHERE id = ?').bind(id).first();
    if (!address || Number(address.member_id) !== Number(member.id)) return authJson({ error: 'address not found' }, 404);

    if (method === 'PATCH') {
      const label = validateText(body.label, 'label', 40);
      if (!label.ok) return authJson({ error: label.error, detail: label.detail }, 400);
      const recipient = validateName(body.recipient_name);
      if (!recipient.ok) return authJson({ error: recipient.error, detail: recipient.detail }, 400);
      const phone = validatePhone(body.phone);
      if (!phone.ok) return authJson({ error: phone.error, detail: phone.detail }, 400);
      const addr = validateText(body.addr, 'addr', 120);
      if (!addr.ok) return authJson({ error: addr.error, detail: addr.detail }, 400);
      const addrDetail = validateOptionalText(body.addr_detail, 'addr_detail', 100);
      if (addrDetail.error) return authJson({ error: addrDetail.error, detail: addrDetail.detail }, 400);
      const company = validateOptionalText(body.company, 'company', 100);
      if (company.error) return authJson({ error: company.error, detail: company.detail }, 400);
      const now = nowIso();
      const isDefault = body.is_default ? 1 : 0;
      if (isDefault) await db.prepare('UPDATE member_addresses SET is_default = 0 WHERE member_id = ?').bind(member.id).run();
      await db.prepare('UPDATE member_addresses SET label = ?, recipient_name = ?, phone = ?, addr = ?, addr_detail = ?, company = ?, is_default = ?, updated_at = ? WHERE id = ?')
        .bind(label.value, recipient.name, phone.phone, addr.value, addrDetail.value, company.value, isDefault, now, id).run();
      return authJson({ address: await db.prepare('SELECT * FROM member_addresses WHERE id = ?').bind(id).first() });
    }

    if (method === 'DELETE') {
      await db.prepare('DELETE FROM member_addresses WHERE id = ?').bind(id).run();
      const remaining = await db.prepare('SELECT COUNT(*) AS c FROM member_addresses WHERE member_id = ?').bind(member.id).first();
      if (remaining && Number(remaining.c) > 0 && address.is_default) {
        await db.prepare('UPDATE member_addresses SET is_default = 1 WHERE member_id = ? LIMIT 1').bind(member.id).run();
      }
      return authJson({ ok: true });
    }
    return authJson({ error: 'method not allowed' }, 405);
  }

  // ---------------- my orders ----------------

  if (pathname === '/api/me/orders' && method === 'POST') {
    // Member-scoped checkout. The guest path stays at POST /api/orders so the
    // legacy CORS contract (no credentials) is untouched.
    if (parsed.error) return authJson({ error: parsed.error }, 400);
    const result = await createOrder(db, body || {}, env, {
      idempotencyKey: request.headers.get('Idempotency-Key') || '',
      customerId: member.id,
    });
    return authJson(result.body, result.status);
  }

  if (pathname === '/api/me/orders' && method === 'GET') {
    const { results } = await db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT ?`)
      .bind(member.id, 100).all();
    return authJson({ items: (results || []).map((row) => publicOrderView(row, null)) });
  }

  if (pathname === '/api/me/quotes' && method === 'POST') {
    // Member-scoped quote intake; POST /api/quotes stays the guest path.
    if (parsed.error) return authJson({ error: parsed.error }, 400);
    const fields = validateQuoteFields(body);
    if (!fields.ok) return authJson({ error: fields.error, detail: fields.detail }, 400);
    const intake = validateQuoteIntake(body);
    if (!intake.ok) return authJson(intake, 400);
    const id = 'Q-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const createdAt = nowIso();
    await db.prepare(
      `INSERT INTO quote_requests (id, created_at, company, contact_name, phone, email, location, note, services, items, status, member_id, updated_at, privacy_consent, invoice_type, biz_no, agency_no)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, createdAt, fields.company, fields.name, fields.phone, fields.email, fields.location, fields.note,
      JSON.stringify(fields.services), JSON.stringify(body.items), member.id, createdAt,
      intake.privacy_consent, intake.invoice_type, intake.biz_no, intake.agency_no
    ).run();
    return authJson({ id, created_at: createdAt, status: 'received', member_id: member.id }, 201);
  }

  const myOrderMatch = pathname.match(/^\/api\/me\/orders\/([^/]+)$/);
  if (myOrderMatch && method === 'GET') {
    const id = decodeURIComponent(myOrderMatch[1]);
    const row = await getOrder(db, id);
    if (!row || String(row.customer_id) !== String(member.id)) return authJson({ error: 'order not found' }, 404);
    const items = await getOrderItems(db, id);
    return authJson({ order: publicOrderView(row, items) });
  }

  const cancelMatch = pathname.match(/^\/api\/me\/orders\/([^/]+)\/cancel$/);
  if (cancelMatch && method === 'POST') {
    const id = decodeURIComponent(cancelMatch[1]);
    const row = await getOrder(db, id);
    if (!row || String(row.customer_id) !== String(member.id)) return authJson({ error: 'order not found' }, 404);
    if (row.status !== 'awaiting_payment') {
      return authJson({ error: 'not cancellable', detail: { status: row.status } }, 409);
    }
    const result = await updateOrder(db, row, { status: 'cancelled' }, 'customer');
    if (result.noChange) return authJson({ changed: false, id });
    if (result.error) return authJson({ error: result.error, detail: result.detail }, 409);
    const updated = await getOrderFull(db, id);
    return authJson({ changed: true, id, order: publicOrderView(updated, updated.items) });
  }

  const repayMatch = pathname.match(/^\/api\/me\/orders\/([^/]+)\/repay$/);
  if (repayMatch && method === 'POST') {
    // Re-open payment for an order that was created but never approved. The
    // client must bind the PG widget to THIS orderId, so the server — not the
    // browser — decides payability and the amount. No new order is ever made.
    const id = decodeURIComponent(repayMatch[1]);
    const row = await getOrder(db, id);
    if (!row || String(row.customer_id) !== String(member.id)) return authJson({ error: 'order not found' }, 404);
    if (row.kind !== 'purchase') {
      return authJson({ error: 'not payable', detail: { reason: 'quote_order_not_payable', kind: row.kind } }, 409);
    }
    if (row.payment_status === 'paid') {
      return authJson({ error: 'already_paid', detail: { status: row.status, refunded_amount: row.refunded_amount } }, 409);
    }
    if (row.status !== 'awaiting_payment') {
      return authJson({ error: 'not payable', detail: { status: row.status, payment_status: row.payment_status } }, 409);
    }
    if (!Number.isInteger(row.total_amount) || row.total_amount <= 0) {
      return authJson({ error: 'invalid amount', detail: { total_amount: row.total_amount } }, 409);
    }
    const retryAt = nowIso();
    await db.batch([
      db.prepare('INSERT INTO order_events (order_id, type, actor, from_status, to_status, meta, created_at) VALUES (?,?,?,?,?,?,?)')
        .bind(id, 'payment_retry_requested', 'customer', row.status, row.status, JSON.stringify({ amount: row.total_amount }), retryAt),
      db.prepare('INSERT INTO member_events (member_id, type, meta, created_at) VALUES (?, ?, ?, ?)')
        .bind(member.id, 'payment_retry_requested', JSON.stringify({ order_id: id }), retryAt),
    ]);
    return authJson({
      payable: true,
      payment: {
        order_id: row.id,
        order_name: 'CGI 상품 주문',
        amount: row.total_amount,
        status: row.status,
        payment_status: row.payment_status,
      },
    });
  }

  const refundMatch = pathname.match(/^\/api\/me\/orders\/([^/]+)\/refund\/request$/);
  if (refundMatch && method === 'POST') {
    const id = decodeURIComponent(refundMatch[1]);
    const row = await getOrder(db, id);
    if (!row || String(row.customer_id) !== String(member.id)) return authJson({ error: 'order not found' }, 404);
    if (row.payment_status !== 'paid') {
      return authJson({ error: 'not payable', detail: { payment_status: row.payment_status } }, 409);
    }
    if (!['paid', 'processing', 'shipped', 'delivered'].includes(row.status)) {
      return authJson({ error: 'not refundable', detail: { status: row.status } }, 409);
    }
    if (row.refunded_amount >= row.total_amount) {
      return authJson({ error: 'fully refunded' }, 409);
    }
    const requested = body.amount == null || body.amount === '' ? null : toNonNegInt(body.amount);
    if (requested !== null && (requested <= 0 || requested > row.total_amount - row.refunded_amount)) {
      return authJson({ error: 'invalid amount', detail: { max: row.total_amount - row.refunded_amount } }, 400);
    }
    const reason = String(body.reason || '고객 환불 요청').slice(0, 200);
    const now = nowIso();
    await db.batch([
      db.prepare("UPDATE orders SET status = 'refunding', updated_at = ?, admin_note = ? WHERE id = ?")
        .bind(now, `[고객 환불 요청] ${reason}`.slice(0, 2000), id),
      db.prepare('INSERT INTO order_events (order_id, type, actor, from_status, to_status, meta, created_at) VALUES (?,?,?,?,?,?,?)')
        .bind(id, 'refund_requested', 'customer', row.status, 'refunding', JSON.stringify({ reason, amount: requested }), now),
      db.prepare('INSERT INTO member_events (member_id, type, meta, created_at) VALUES (?, ?, ?, ?)')
        .bind(member.id, 'refund_requested', JSON.stringify({ order_id: id, amount: requested }), now),
    ]);
    const updated = await getOrderFull(db, id);
    return authJson({ ok: true, order: publicOrderView(updated, updated.items) });
  }

  // ---------------- my quote requests ----------------

  if (pathname === '/api/me/quotes' && method === 'GET') {
    const { results } = await db.prepare('SELECT * FROM quote_requests WHERE member_id = ? ORDER BY created_at DESC LIMIT 100')
      .bind(member.id).all();
    return authJson({ items: (results || []).map(memberQuoteView) });
  }

  const myQuoteMatch = pathname.match(/^\/api\/me\/quotes\/([^/]+)$/);
  if (myQuoteMatch && method === 'GET') {
    const id = decodeURIComponent(myQuoteMatch[1]);
    const row = await db.prepare('SELECT * FROM quote_requests WHERE id = ?').bind(id).first();
    if (!row || String(row.member_id) !== String(member.id)) return authJson({ error: 'quote not found' }, 404);
    return authJson({ quote: memberQuoteView(row) });
  }

  return authJson({ error: 'not found' }, 404);
}

// ---------------------------------------------------------------------------
// worker
// ---------------------------------------------------------------------------

/**
 * Provider selection is deployment policy; a payment row's own provider is the
 * truth for refunds. Both stay resolvable at the same time, so switching the
 * mall to NICEPAY never strands a Toss-paid order (and vice versa).
 */
function buildTossPg(env) {
  const mode = String(env.PG_PROVIDER_MODE || 'auto').trim().toLowerCase();
  const secretKey = String(env.TOSS_WIDGET_SECRET_KEY || '').trim();
  if (mode === 'mock') {
    // The Toss mock approves any paymentKey. Sandbox and test environments may
    // keep using it; production must not (same rule as NICEPAY).
    if (mockForbidden(env)) {
      return {
        provider: 'tosspayments', configured: false, reason: 'mock_forbidden',
        mode: 'mock', sandbox: false, live: false, missing: [],
      };
    }
    return createPgAdapter({ secretKey, mode: 'mock' });
  }
  // A real Toss approval requires a live secret. No key used to fall through to
  // the source-visible mock; a test key still talks to the test gateway. Both
  // are refused: only live_* may approve, and never silently.
  if (!secretKey.startsWith('live_')) {
    return {
      provider: 'tosspayments', configured: false, reason: 'toss_live_key_required',
      mode: 'mock', sandbox: false, live: false, missing: ['TOSS_WIDGET_SECRET_KEY'],
    };
  }
  return createPgAdapter({ secretKey, mode: 'live' });
}

/**
 * A mock gateway approves anything that carries a correctly shaped payload
 * (NICEPAY's mock keys are constants in this repository). That is acceptable in
 * the sandbox Worker and fatal in production, so production refuses mock
 * outright: PG_NICEPAY_ENV=operating, or the deployed script name is
 * cgi-quote-api (WORKER_NAME is declared in each wrangler.toml).
 */
function mockForbidden(env) {
  if (String(env.PG_NICEPAY_ENV || '').trim().toLowerCase() === 'operating') return true;
  return String(env.WORKER_NAME || '').trim().toLowerCase() === 'cgi-quote-api';
}

function buildNicepayPg(env) {
  const mode = String(env.PG_PROVIDER_MODE || 'auto').trim().toLowerCase();
  if (mode === 'mock') {
    if (mockForbidden(env)) {
      return {
        provider: 'nicepay', configured: false, reason: 'mock_forbidden',
        environment: 'mock', mode: 'mock', missing: [], sandbox: false, live: false,
      };
    }
    return createNicepayMockAdapter();
  }
  const config = resolveNicepayEnv(env);
  if (!config.ok) {
    // An unusable provider must not look like a working one, and must never fall
    // back to the other gateway's credentials.
    return {
      provider: 'nicepay', configured: false, reason: config.reason,
      environment: config.environment || null, mode: config.mode || null,
      missing: config.missing || [], sandbox: false, live: false,
    };
  }
  return createNicepayAdapter(config);
}

function buildPg(env) {
  const provider = String(env.PG_PROVIDER || 'nicepay').trim().toLowerCase();
  const siteProvider = String(env.SITE_PG_PROVIDER || 'nicepay').trim().toLowerCase();
  if (!['nicepay', 'tosspayments'].includes(provider)) {
    return { provider, configured: false, reason: 'provider_unknown', mode: null, sandbox: false, live: false };
  }
  if (siteProvider !== provider) {
    return { provider, configured: false, reason: 'provider_mismatch', siteProvider, mode: null, sandbox: false, live: false };
  }
  return provider === 'nicepay' ? buildNicepayPg(env) : buildTossPg(env);
}

async function pgForPaymentKey(db, env, active, paymentKey) {
  if (!paymentKey || active.provider === 'nicepay') return active;
  const row = await db.prepare('SELECT provider FROM payments WHERE payment_key = ?').bind(paymentKey).first();
  return row && row.provider === 'nicepay' ? buildNicepayPg(env) : active;
}

function pgNotConfigured(pg) {
  return pg && pg.configured === false;
}

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeadersFor(url.pathname, request) });
    }

    const pg = buildPg(env);
    if (pg && (pg.reason === 'provider_mismatch' || pg.reason === 'provider_unknown')) {
      return json({ error: 'pg_provider_configuration_invalid', detail: pg.reason }, 503);
    }

    // ---------------- customer accounts (cookie + CSRF guarded) ----------------

    if (url.pathname.startsWith('/api/auth')) {
      return handleAuthRoute(url.pathname, request.method, request, env.DB, env);
    }
    if (url.pathname === '/api/me' || url.pathname.startsWith('/api/me/')) {
      return handleMeRoute(url.pathname, request.method, url, request, env.DB, env);
    }

    // A signed-in member checks out on their own account so /api/me/orders can
    // see the order. Guests keep the original customer_id-less behaviour.
    async function customerContext() {
      if (request.method === 'GET' || request.method === 'HEAD') return null;
      return requireMember(request, env.DB, env);
    }

    // ---------------- existing quote routes ----------------

    if (url.pathname === '/api/quotes' && request.method === 'POST') {
      // Unauthenticated intake: bound it per source address before parsing.
      const quoteIp = clientIp(request);
      if (quoteIp) {
        const quoteLimit = await rateLimitCheck(env.DB, authPolicy(env), 'quote-intake-ip', quoteIp);
        if (quoteLimit.error) return json({ error: quoteLimit.error, detail: quoteLimit.detail }, 429);
      }
      const parsed = await readJson(request);
      if (parsed.error) {
        if (parsed.error === 'content_type_json_required') {
          return json({ error: parsed.error, detail: parsed.detail }, 415);
        }
        return badRequest(parsed.error);
      }
      const body = parsed.body;
      const fields = validateQuoteFields(body);
      if (!fields.ok) return badRequest(fields.error, fields.detail);
      const intake = validateQuoteIntake(body);
      if (!intake.ok) return badRequest(intake.error, intake.detail);
      const id = 'Q-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const createdAt = nowIso();
      // A signed-in member is linked only when the request also clears the
      // Origin + CSRF gate; otherwise the legacy guest submission is unchanged.
      let quoteMemberId = null;
      if (originOk(request, env) && csrfOk(request, env)) {
        const quoteMember = await requireMember(request, env.DB, env);
        if (quoteMember) quoteMemberId = quoteMember.id;
      }
      await env.DB.prepare(
        `INSERT INTO quote_requests (id, created_at, company, contact_name, phone, email, location, note, services, items, status, member_id, updated_at, privacy_consent, invoice_type, biz_no, agency_no)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, createdAt, fields.company, fields.name, fields.phone, fields.email, fields.location, fields.note,
        JSON.stringify(fields.services), JSON.stringify(body.items), quoteMemberId, createdAt,
        intake.privacy_consent, intake.invoice_type, intake.biz_no, intake.agency_no
      ).run();
      return json({ id, created_at: createdAt, status: 'received', member_id: quoteMemberId }, 201);
    }

    if (url.pathname === '/api/quotes' && request.method === 'GET') {
      if (!(await isAdminOrMember(request, env.DB, env))) return json({ error: 'unauthorized' }, 401, CORS_HEADERS_CREDENTIALS);
      const status = url.searchParams.get('status');
      let stmt = env.DB.prepare('SELECT id, created_at, company, contact_name, phone, status, total FROM quote_requests ORDER BY created_at DESC');
      if (status) stmt = env.DB.prepare('SELECT id, created_at, company, contact_name, phone, status, total FROM quote_requests WHERE status = ? ORDER BY created_at DESC').bind(status);
      const { results } = await stmt.all();
      return json({ items: results }, 200, CORS_HEADERS_CREDENTIALS);
    }

    const getMatch = url.pathname.match(/^\/api\/quotes\/([^/]+)$/);
    if (getMatch && request.method === 'GET') {
      if (!(await isAdminOrMember(request, env.DB, env))) return unauthorized();
      const id = decodeURIComponent(getMatch[1]);
      const row = await env.DB.prepare('SELECT * FROM quote_requests WHERE id = ?').bind(id).first();
      if (!row) return notFound();
      return json(row);
    }

    if (getMatch && request.method === 'PATCH') {
      if (!(await isAdminOrMember(request, env.DB, env))) return unauthorized();
      const id = decodeURIComponent(getMatch[1]);
      const parsed = await readJson(request);
      if (parsed.error) return badRequest(parsed.error);
      const body = parsed.body;
      const existing = await env.DB.prepare('SELECT * FROM quote_requests WHERE id = ?').bind(id).first();
      if (!existing) return notFound();
      const status = body.status || existing.status;
      const adminPrices = body.admin_prices !== undefined ? JSON.stringify(body.admin_prices) : existing.admin_prices;
      const total = body.total !== undefined ? body.total : existing.total;
      const updatedAt = nowIso();
      await env.DB.prepare('UPDATE quote_requests SET status = ?, admin_prices = ?, total = ?, updated_at = ? WHERE id = ?')
        .bind(status, adminPrices, total, updatedAt, id).run();
      return json({ id, status, total, updated_at: updatedAt });
    }

    // ---------------- health ----------------

    if (url.pathname === '/api/admin/health' && request.method === 'GET') {
      if (!isAdmin(request, env)) return unauthorized();
      const policy = authPolicy(env);
      const mail = createMailAdapter(env, () => {});
      // A refused gateway is surfaced here instead of staying a silent 503 on
      // every payment route: the operator has to see that the deploy is
      // mis-configured before a customer discovers it at checkout.
      const warnings = [];
      if (pg.reason === 'mock_forbidden') warnings.push('pg_mock_forbidden');
      if (pg.reason === 'toss_live_key_required') warnings.push('toss_live_key_required');
      return json({
        version: BACKEND_VERSION,
        ok: true,
        warnings,
        pg: {
          provider: pg.provider, mode: pg.mode, sandbox: pg.sandbox, live: pg.live,
          configured: pg.configured !== false, reason: pg.reason || null,
          mock_forbidden: mockForbidden(env),
        },
        erp: {
          adapter: ECOUNT_ORDER_ADAPTER,
          mode: ecountOrderMode(env),
          enabled: String(env.ECOUNT_ORDER_SYNC_ENABLED || 'NO').toUpperCase() === 'YES',
          live_write: ecountOrderMode(env) === 'prod',
        },
        shipping_fee_default: toNonNegInt(env.SHIPPING_FEE_DEFAULT, 0),
        price_index: { products_total: PRICE_INDEX_META.products_total, products_with_price: PRICE_INDEX_META.products_with_price },
        site_base_url: siteBaseUrl(env),
        cors_allowed_origins: corsAllowedOrigins(env),
        auth: {
          enabled: true,
          cookie_name: authCookieName(env),
          cookie_secure: authCookieSecure(env),
          origin_strict: originStrict(env),
          csrf_configured: !!String(env.AUTH_CSRF_TOKEN || '').trim(),
          mail_mode: mail.mode,
          email_verify_required: emailVerifyRequired(env),
          pbkdf2_iterations: policy.pbkdf2Iterations,
          session_ttl_seconds: policy.sessionTtlSeconds,
          password_min: policy.passwordMin,
          password_max: policy.passwordMax,
        },
      });
    }

    if (url.pathname === '/api/admin/ecount/item-mappings/import' && request.method === 'POST') {
      if (!(await isAdminOrMember(request, env.DB, env))) return unauthorized();
      const contentType = String(request.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('text/csv') && !contentType.includes('text/plain') && !contentType.includes('application/vnd.ms-excel')) {
        return json({ error: 'content_type_must_be_csv' }, 415);
      }
      const csvBytes = new Uint8Array(await request.arrayBuffer());
      if (csvBytes.byteLength > 5_000_000) return json({ error: 'csv_too_large' }, 413);
      let csvText = null;
      for (const encoding of ['utf-8', 'windows-949', 'euc-kr']) {
        try { csvText = new TextDecoder(encoding, { fatal: true }).decode(csvBytes); break; }
        catch { /* try the next supported text encoding */ }
      }
      if (csvText === null) return badRequest('csv_encoding_unsupported');
      let parsed;
      try {
        parsed = parseApprovedEcountMappingCsv(csvText);
      } catch (error) {
        return badRequest(String(error?.message || 'invalid_mapping_csv').slice(0, 120));
      }
      const sourceHash = await sha256Hex(csvText);
      if (!parsed.approvals.length) {
        return json({ ok: true, imported: 0, unapproved_rows: parsed.unapprovedRows, source_sha256: sourceHash });
      }

      try {
        const approvedAt = nowIso();
        for (let offset = 0; offset < parsed.approvals.length; offset += 100) {
          const statements = parsed.approvals.slice(offset, offset + 100).map((approval) => env.DB.prepare(
            `INSERT INTO ecount_item_mapping
               (cgi_product_id, ecount_prod_cd, approved_by, approved_at, source_sha256, created_at, updated_at)
             VALUES (?,?, 'admin', ?, ?, ?, ?)
             ON CONFLICT(cgi_product_id) DO UPDATE SET
               ecount_prod_cd = excluded.ecount_prod_cd,
               approved_by = excluded.approved_by,
               approved_at = excluded.approved_at,
               source_sha256 = excluded.source_sha256,
               updated_at = excluded.updated_at`
          ).bind(approval.cgiProductId, approval.ecountProdCd, approvedAt, sourceHash, approvedAt, approvedAt));
          await env.DB.batch(statements);
        }
        return json({ ok: true, imported: parsed.approvals.length, unapproved_rows: parsed.unapprovedRows, source_sha256: sourceHash });
      } catch {
        return json({ error: 'ecount_mapping_import_failed' }, 500);
      }
    }

    // ---------------- product sync (admin) ----------------

    if (url.pathname === '/api/admin/sync/status' && request.method === 'GET') {
      if (!(await isAdminOrMember(request, env.DB, env))) return unauthorized();
      try {
        const { results } = await env.DB.prepare(
          `SELECT status, COUNT(*) AS n FROM product_sync_state GROUP BY status`
        ).all();
        const byStatus = {};
        for (const r of (results || [])) byStatus[r.status] = r.n;
        const { results: targetRows } = await env.DB.prepare(
          `SELECT target, status, COUNT(*) AS n FROM product_sync_state GROUP BY target, status`
        ).all();
        const byTarget = {};
        for (const r of (targetRows || [])) {
          byTarget[r.target] = byTarget[r.target] || {};
          byTarget[r.target][r.status] = r.n;
        }
        return json({ ok: true, byStatus, byTarget, total: Object.values(byStatus).reduce((a, b) => a + b, 0) });
      } catch (e) {
        return json({ error: 'sync status unavailable', detail: String(e && e.message || e) }, 500);
      }
    }

    if (url.pathname === '/api/admin/sync/products' && request.method === 'GET') {
      if (!(await isAdminOrMember(request, env.DB, env))) return unauthorized();
      const target = url.searchParams.get('target');
      const status = url.searchParams.get('status');
      const q = (url.searchParams.get('q') || '').trim();
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)));
      try {
        let sql = 'SELECT cgi_id, target, status, change_hash, last_success_at, last_attempt_at, last_error, retry_count, transmitted, locked FROM product_sync_state WHERE 1=1';
        const binds = [];
        if (target) { sql += ' AND target = ?'; binds.push(target); }
        if (status) { sql += ' AND status = ?'; binds.push(status); }
        if (q) { sql += ' AND cgi_id LIKE ?'; binds.push('%' + q + '%'); }
        sql += ' ORDER BY updated_at DESC LIMIT ?';
        binds.push(limit);
        const stmt = binds.length ? env.DB.prepare(sql).bind(...binds) : env.DB.prepare(sql);
        const { results } = await stmt.all();
        return json({ ok: true, items: results || [], count: (results || []).length });
      } catch (e) {
        return json({ error: 'sync products unavailable', detail: String(e && e.message || e) }, 500);
      }
    }

    if (url.pathname === '/api/admin/sync/retry' && request.method === 'POST') {
      if (!(await isAdminOrMember(request, env.DB, env))) return unauthorized();
      const parsed = await readJson(request);
      if (parsed.error) return badRequest(parsed.error);
      const ids = Array.isArray(parsed.body && parsed.body.cgiIds) ? parsed.body.cgiIds : [];
      if (!ids.length) return badRequest('cgiIds required');
      const now = nowIso();
      let retried = 0;
      for (const id of ids) {
        try {
          await env.DB.prepare(
            `UPDATE product_sync_state SET status = 'retry_pending', last_attempt_at = ?, updated_at = ? WHERE cgi_id = ?`
          ).bind(now, now, id).run();
          retried++;
        } catch (e) { /* ignore individual failures */ }
      }
      return json({ ok: true, retried, total: ids.length });
    }

    // ---------------- orders (public) ----------------

    if (url.pathname === '/api/orders' && request.method === 'POST') {
      const parsed = await readJson(request);
      if (parsed.error) {
        if (parsed.error === 'content_type_json_required') {
          return json({ error: parsed.error, detail: parsed.detail }, 415);
        }
        return badRequest(parsed.error);
      }
      // A cookie session on the shared SameSite=None cookie changes the trust
      // level of this call: the order will be linked to the member, so the
      // request must clear the same Origin + X-CSRF-Token gate as /api/me.
      // If it fails, reject — never silently downgrade to a guest order.
      const orderMember = await customerContext();
      if (orderMember && (!originOk(request, env) || !csrfOk(request, env))) {
        return json({ error: 'origin_csrf_required', detail: 'Origin과 X-CSRF-Token이 필요합니다.' }, 403);
      }
      const result = await createOrder(env.DB, parsed.body || {}, env, {
        idempotencyKey: request.headers.get('Idempotency-Key') || '',
        customerId: orderMember ? orderMember.id : null,
      });
      return json(result.body, result.status);
    }

    const paymentConfirmMatch = url.pathname === '/api/payments/confirm' && request.method === 'POST';
    if (paymentConfirmMatch && pgNotConfigured(pg)) {
      return json({ error: 'pg_not_configured', detail: pg.reason || pg.provider }, 503);
    }
    if (paymentConfirmMatch) {
      const parsed = await readJson(request);
      if (parsed.error) return badRequest(parsed.error);
      const result = await confirmPayment(env.DB, parsed.body || {}, env, pg);
      return json(result.body, result.status);
    }

    // ---------------- payment gateway readouts and NICEPAY callbacks ----------------

    if (url.pathname === '/api/payments/config' && request.method === 'GET') {
      const active = pg;
      // Every provider answers 503 when its adapter is unusable. Toss used to
      // report ok:true here even with no key, which hid the fail-closed guard.
      if (pgNotConfigured(active)) {
        return json({
          provider: active.provider, ok: false, reason: active.reason,
          mode: active.mode || null, missing: active.missing || [],
        }, 503);
      }
      if (active.provider === 'nicepay') {
        return json({
          provider: 'nicepay', ok: true, environment: active.environment, mode: active.mode,
          jsSdkUrl: active.sdkUrl,
          clientId: active.clientId,
          returnUrl: `${url.origin}/api/payments/nicepay/return`,
        });
      }
      return json({ provider: active.provider, ok: true, mode: active.mode, sandbox: active.sandbox === true });
    }

    const nicepayWindowMatch = url.pathname === '/api/payments/nicepay/window' && request.method === 'POST';
    if (nicepayWindowMatch) {
      if (pg.provider !== 'nicepay' || pgNotConfigured(pg)) {
        return json({ error: 'pg_not_configured', detail: pg.reason || 'nicepay' }, 503);
      }
      const parsed = await readJson(request);
      if (parsed.error) return badRequest(parsed.error);
      const orderId = String((parsed.body || {}).orderId || (parsed.body || {}).order_id || '').slice(0, 64);
      const order = await getOrder(env.DB, orderId);
      if (!order) return notFound();
      // The window carries the buyer's name, phone and email back to the browser.
      // An order number alone is not proof of ownership, so require the same
      // email factor GET /api/orders/:id uses, or an owning member session.
      const windowEmail = String((parsed.body || {}).email || '').trim().toLowerCase();
      const ownsEmail = windowEmail && windowEmail === String(order.customer_email || '').trim().toLowerCase();
      const windowMember = await requireMember(request, env.DB, env, { allowUnverified: true });
      const ownsSession = !!(windowMember && order.customer_id && windowMember.id === order.customer_id);
      if (!ownsEmail && !ownsSession && !isAdmin(request, env)) {
        return json({ error: 'email factor required', detail: '주문 이메일 확인이 필요합니다.' }, 403);
      }
      if (order.kind !== 'purchase') return conflict('quote_order_not_payable');
      if (isTerminalStatus(order.status)) return conflict('order_closed', { status: order.status });
      if (order.payment_status === 'paid') return conflict('already_paid');
      // Only the payment means NICE documents for the window; anything else stays
      // on the default rather than reaching the gateway as an arbitrary string.
      // vbank (가상계좌) is deliberately absent: an accepted window leaves the
      // order in `ready`, which the confirm path records as a failure. Virtual
      // account design is tracked in issue #187.
      const WINDOW_METHODS = { card: 'card', bank: 'bank', cellphone: 'cellphone' };
      const requested = String((parsed.body || {}).method || '').toLowerCase();
      const params = pg.windowParams({
        orderId: order.id,
        // The window amount is the server's order total, never a client claim.
        amount: order.total_amount,
        goodsName: 'CGI 주문',
        method: WINDOW_METHODS[requested] || 'card',
        buyerName: order.customer_name,
        buyerTel: order.customer_phone,
        buyerEmail: order.customer_email,
        returnUrl: `${url.origin}/api/payments/nicepay/return`,
      });
      if (!params) return badRequest('window_params_unavailable');
      return json({ ok: true, sdkUrl: params.sdkUrl, windowHost: params.windowHost, request: params.request });
    }

    const nicepayReturnMatch = url.pathname === '/api/payments/nicepay/return';
    if (nicepayReturnMatch && request.method === 'POST') {
      const payload = await readWindowForm(request);
      const site = String(env.NICEPAY_SITE_BASE_URL || siteBaseUrl(env)).replace(/\/$/, '');
      const orderId = String(payload.orderId || payload.order_id || '').slice(0, 64);
      if (!orderId || !payload.tid) {
        return json({ error: 'window payload incomplete' }, 400);
      }
      if (pg.provider !== 'nicepay' || pgNotConfigured(pg)) {
        return json({ error: 'pg_not_configured', detail: pg.reason || 'nicepay' }, 503);
      }
      const order = await getOrder(env.DB, orderId);
      if (!order) return notFound();
      if (payload.authResultCode !== '0000') {
        const failed = await confirmPayment(env.DB, {
          orderId, paymentKey: String(payload.tid), amount: order.total_amount,
          failure: true,
          failure_code: String(payload.authResultCode || 'NICE_AUTH_FAILED').slice(0, 80),
          failure_message: String(payload.authResultMsg || payload.resultMsg || '').slice(0, 120),
          customer_email: order.customer_email,
          // Record the failed attempt, but leave the order payable: an unsigned
          // window-cancel report is not proof that the customer abandoned it.
          touchOrder: false,
        }, env, pg);
        return Response.redirect(redirectTarget(site, order.id, false), 302);
      }
      const confirmed = await confirmPayment(env.DB, {
        orderId,
        paymentKey: String(payload.tid),
        amount: order.total_amount,
        signatureData: payload,
      }, env, pg);
      const ok = confirmed.status === 200 && (confirmed.body.approved || confirmed.body.already_paid);
      return Response.redirect(redirectTarget(site, order.id, ok), 302);
    }
    if (nicepayReturnMatch && request.method === 'GET') {
      // NICE redirects nothing to returnUrl on GET; a bare visit is not a payment.
      return json({ error: 'method_not_allowed' }, 405);
    }

    const nicepayWebhookMatch = url.pathname === '/api/payments/nicepay/webhook' && request.method === 'POST';
    if (nicepayWebhookMatch) {
      if (pg.provider !== 'nicepay' || pgNotConfigured(pg)) {
        return json({ error: 'pg_not_configured', detail: pg.reason || 'nicepay' }, 503);
      }
      const payload = await readWindowForm(request);
      const result = await applyNicepayWebhook(env.DB, env, pg, payload);
      return result;
    }

    const orderMatch = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
    if (orderMatch && request.method === 'GET') {
      const id = decodeURIComponent(orderMatch[1]);
      const order = await getOrderFull(env.DB, id);
      if (!order) return notFound();
      // PII gate: the order number alone must not reveal name/phone/address.
      // Full view requires the customer email factor, an owning member session,
      // or staff auth; everyone else gets a status-only view.
      const emailFactor = String(url.searchParams.get('email') || '').trim().toLowerCase();
      const ownsEmail = emailFactor && emailFactor === String(order.customer_email || '').trim().toLowerCase();
      // The order table has no member_id column; ownership is orders.customer_id.
      // Reading member_id made every member look like a stranger (undefined),
      // so the feature silently degraded to the status-only view.
      const sessionMember = await requireMember(request, env.DB, env, { allowUnverified: true });
      const ownsSession = !!(sessionMember && order.customer_id && sessionMember.id === order.customer_id);
      const isStaff = await isAdminOrMember(request, env.DB, env);
      if (ownsEmail || ownsSession || isStaff) {
        return json(publicOrderView(order, order.items));
      }
      return json(minimalOrderView(order));
    }

    // ---------------- orders (admin) ----------------

    if (url.pathname === '/api/orders' && request.method === 'GET') {
      if (!(await isAdminOrMember(request, env.DB, env))) return unauthorized();
      const q = url.searchParams.get('q');
      const kind = url.searchParams.get('kind');
      const status = url.searchParams.get('status');
      const paymentStatus = url.searchParams.get('payment_status');
      const limit = Math.min(100, Math.max(1, toNonNegInt(url.searchParams.get('limit'), 50)));

      const where = [];
      const params = [];
      if (kind && (kind === 'purchase' || kind === 'quote')) { where.push('kind = ?'); params.push(kind); }
      if (status) { where.push('status = ?'); params.push(status); }
      if (paymentStatus) { where.push('payment_status = ?'); params.push(paymentStatus); }
      if (q) {
        where.push('(id LIKE ? OR customer_company LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)');
        const like = `%${q}%`;
        params.push(like, like, like, like);
      }
      const sql = `SELECT ${ORDER_COLUMNS} FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
      const { results } = await env.DB.prepare(sql).bind(...params, limit).all();
      return json({ items: results, count: results ? results.length : 0 });
    }

    if (orderMatch && request.method === 'PATCH') {
      if (!(await isAdminOrMember(request, env.DB, env))) return unauthorized();
      const id = decodeURIComponent(orderMatch[1]);
      const parsed = await readJson(request);
      if (parsed.error) return badRequest(parsed.error);
      const order = await getOrder(env.DB, id);
      if (!order) return notFound();
      const result = await updateOrder(env.DB, order, parsed.body || {});
      if (result.noChange) return json({ changed: false, id });
      if (result.error) return badRequest(result.error, result.detail);
      const updated = await getOrderFull(env.DB, id);
      return json({ changed: true, id, changes: result.changes, order: publicOrderView(updated, updated.items) });
    }

    const eventsMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/events$/);
    if (eventsMatch && request.method === 'GET') {
      if (!(await isAdminOrMember(request, env.DB, env))) return unauthorized();
      const { results } = await env.DB.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at ASC, id ASC')
        .bind(decodeURIComponent(eventsMatch[1])).all();
      return json({ items: results || [] });
    }

    const pricesMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/quote\/prices$/);
    if (pricesMatch && request.method === 'POST') {
      if (!(await isAdminOrMember(request, env.DB, env))) return unauthorized();
      const id = decodeURIComponent(pricesMatch[1]);
      const parsed = await readJson(request);
      if (parsed.error) return badRequest(parsed.error);
      const order = await getOrder(env.DB, id);
      if (!order) return notFound();
      if (order.kind !== 'quote') return conflict('not_a_quote_order', { kind: order.kind });
      const result = await confirmQuotePrices(env.DB, env, order, parsed.body || {});
      return json(result.body, result.status);
    }

    const erpMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/erp(?:\/retry)?$/);
    if (erpMatch && request.method === 'POST') {
      if (!(await isAdminOrMember(request, env.DB, env))) return unauthorized();
      const id = decodeURIComponent(erpMatch[1]);
      const force = url.pathname.endsWith('/retry');
      const order = await getOrderFull(env.DB, id);
      if (!order) return notFound();
      const result = await enqueueErpSync(env.DB, env, order, order.items, force);
      return json(result, 200);
    }

    const cancelMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/payments\/([^/]+)\/cancel$/);
    if (cancelMatch && request.method === 'POST' && pgNotConfigured(pg) && String(env.PG_PROVIDER || '').toLowerCase() === 'nicepay') {
      return json({ error: 'pg_not_configured', detail: pg.reason || pg.provider }, 503);
    }
    if (cancelMatch && request.method === 'POST') {
      if (!(await isAdminOrMember(request, env.DB, env))) return unauthorized();
      const id = decodeURIComponent(cancelMatch[1]);
      const paymentKey = decodeURIComponent(cancelMatch[2]);
      const parsed = await readJson(request);
      if (parsed.error) return badRequest(parsed.error);
      const order = await getOrder(env.DB, id);
      if (!order) return notFound();
      const rowPg = await pgForPaymentKey(env.DB, env, pg, paymentKey);
      if (pgNotConfigured(rowPg)) {
        return json({ error: 'pg_not_configured', detail: rowPg.reason || rowPg.provider }, 503);
      }
      const result = await cancelPayment(env.DB, env, order, paymentKey, parsed.body || {}, rowPg);
      return json(result.body, result.status);
    }

const memberRoleMatch = url.pathname.match(/^\/api\/admin\/members\/([^/]+)\/role$/);
if (memberRoleMatch && request.method === 'PATCH') {
  if (!(await isSuperAdmin(request, env.DB, env))) return unauthorized();
  const id = Number(decodeURIComponent(memberRoleMatch[1]));
  if (!Number.isInteger(id) || id <= 0) return badRequest('invalid member id');
  const parsed = await readJson(request);
  if (parsed.error) return badRequest(parsed.error);
  const role = String((parsed.body || {}).role || '').trim().toLowerCase();
  if (role !== 'admin' && role !== 'member') return badRequest('role must be admin or member');
  const member = await getMember(env.DB, id);
  if (!member) return notFound();
  const email = String(member.email || '').trim().toLowerCase();
  if (SUPERADMIN_EMAILS.has(email)) return conflict('superadmin_role_immutable', { detail: 'superadmin role is fixed by verified email' });
  await env.DB.prepare('UPDATE members SET role = ?, updated_at = ? WHERE id = ?').bind(role, nowIso(), id).run();
  const updated = await getMember(env.DB, id);
  return json({ ok: true, member: memberView(updated) });
}

if (url.pathname === '/api/admin/members' && request.method === 'GET') {
  if (!(await isSuperAdmin(request, env.DB, env))) return unauthorized();
  const { results } = await env.DB.prepare('SELECT id, email, name, status, email_verified_at, role, created_at FROM members ORDER BY created_at DESC LIMIT 200').all();
  return json({ items: (results || []).map((m) => {
    const email = String(m.email || '').trim().toLowerCase();
    const role = SUPERADMIN_EMAILS.has(email) && m.email_verified_at ? 'superadmin' : (m.role || 'member');
    return {
      id: m.id, email: m.email, name: m.name, status: m.status,
      email_verified: !!m.email_verified_at, role,
      created_at: m.created_at,
    };
  }) });
}

return notFound();
  },
};

// A browser request that carries the session cookie is an admin/member call
// even when its path is a legacy route (for example GET /api/orders). Those
// responses must advertise credentials or the browser discards them. The
// origin stays pinned to the production site; only the credential flag is added.
export default {
  async scheduled(_controller, env, ctx) {
    const work = purgeExpiredShopLogs(env.DB)
      .then((counts) => {
        console.log(`SHOP_RETENTION_PURGE=ok detail=${JSON.stringify(counts)}`);
      })
      .catch(() => {
        // Never print database error values or row data from a scheduled pass.
        console.error('SHOP_RETENTION_PURGE=ERROR');
        throw new Error('shop retention purge failed');
      });
    ctx.waitUntil(work);
  },

  async fetch(request, env) {
    let response;
    try {
      response = await worker.fetch(request, env);
    } catch (e) {
      if (e && e.code === 'email_not_verified') {
        response = json({
          error: 'email not verified',
          detail: '인증 메일을 확인해 주세요.',
          email_verified: false,
        }, 403);
      } else {
        // Never surface an upstream/D1 message: it may carry row data or storage
        // internals. The operator log keeps only the class of failure.
        console.error(`WORKER_UNHANDLED=${e && e.name ? e.name : 'Error'}`);
        response = json({ error: 'internal error' }, 500);
      }
    }

    // CORS_ALLOWED_ORIGINS decided whether a request was *accepted*, but the
    // response still named the production origin, so every allow-listed second
    // origin (a sandbox deployment, a staging site) was refused by the browser
    // when it tried to read the body. Reflect only origins the policy already
    // accepts; anything else keeps the pinned value, which is what fails closed.
    const origin = request.headers.get('Origin');
    const reflected = !!origin && origin !== DEFAULT_ALLOWED_ORIGIN && originOk(request, env);
    if (reflected) {
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', origin);
      const vary = headers.get('Vary') || '';
      if (!/(^|,)\s*Origin/i.test(vary)) headers.set('Vary', vary ? `${vary}, Origin` : 'Origin');
      response = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }

    const contentType = response.headers.get('Content-Type') || '';
    const servedOrigin = response.headers.get('Access-Control-Allow-Origin');
    if (
      request.method !== 'OPTIONS'
      && request.headers.get('Cookie')
      && contentType.includes('application/json')
      && (servedOrigin === DEFAULT_ALLOWED_ORIGIN || (reflected && servedOrigin === origin))
      && !response.headers.has('Access-Control-Allow-Credentials')
    ) {
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Credentials', 'true');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return response;
  },
};
