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
//   POST   /api/admin/schema/init    (admin)   apply schema.sql to D1
//   GET    /api/admin/health         (public)  mode readout, no secrets
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
import { buildEcountSalesSlip, erpCodeFor, createErpDriver, erpModeFromEnv, ERP_ADAPTER } from './lib/erp.mjs';
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
import { ensureColumns, COLUMN_UPGRADES } from './lib/migrate.mjs';
import { createMailAdapter } from './lib/mail.mjs';
import { createOAuthState, verifyOAuthState, buildAuthorizationUrl, exchangeCode, fetchUserInfo, OAUTH_STATE_COOKIE, oauthStateCookieOptions } from './lib/google-oauth.mjs';

const ALLOWED_ORIGIN = 'https://skerishkang.github.io';
const MAX_BODY_BYTES = 64 * 1024;
const DUPLICATE_WINDOW_SECONDS = 120;
// Smallest partial refund the backend will accept (KRW). Anything below this is
// rounding dust rather than a refund; override with the MIN_PARTIAL_REFUND var.
const MIN_PARTIAL_REFUND = 1000;
const BACKEND_VERSION = '1.4.0';
const SUPERADMIN_EMAILS = new Set(['charliekant@gmail.com', 'skerish@naver.com']);

// Legacy credential-free header set: quote intake, order, payment and admin
// routes. Kept exactly as it is because they are not cookie-based, and because
// the CORS regression test asserts that these routes never grant credentials.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
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

function corsHeadersFor(pathname) {
  return isAuthPath(pathname) ? CORS_HEADERS_CREDENTIALS : CORS_HEADERS;
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
  const member = await requireMember(request, db, env);
  if (!member || member.status !== 'active' || !member.email_verified_at) return false;
  const email = String(member.email || '').trim().toLowerCase();
  return SUPERADMIN_EMAILS.has(email) || member.role === 'superadmin';
}

async function isAdminOrMember(request, db, env) {
  if (isAdmin(request, env)) return true;
  const member = await requireMember(request, db, env);
  if (!member) return false;
  if (member.status !== 'active') return false;
  if (!member.email_verified_at) return false;
  const role = member.role || (SUPERADMIN_EMAILS.has(String(member.email || '').trim().toLowerCase()) ? 'superadmin' : 'member');
  return role === 'admin' || role === 'superadmin';
}

async function readJson(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY_BYTES) return { error: 'body too large' };
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) return { error: 'body too large' };
  const text = new TextDecoder().decode(buffer);
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
  };

  try {
    await db.batch([
       db.prepare(
         `INSERT INTO orders (id, kind, idempotency_key, cart_hash, status, created_at, updated_at,
           customer_company, customer_name, customer_phone, customer_email, customer_addr, customer_addr_detail,
           customer_note, services, item_total, shipping_fee, total_amount, supplied_amount, vat_amount,
           payment_status, erp_status, source_quote_id, customer_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
       ).bind(
         orderRow.id, orderRow.kind, orderRow.idempotency_key, orderRow.cart_hash, orderRow.status,
         orderRow.created_at, orderRow.updated_at, orderRow.customer_company, orderRow.customer_name,
         orderRow.customer_phone, orderRow.customer_email, orderRow.customer_addr, orderRow.customer_addr_detail,
         orderRow.customer_note, orderRow.services, orderRow.item_total, orderRow.shipping_fee, orderRow.total_amount,
         orderRow.supplied_amount, orderRow.vat_amount, orderRow.payment_status, orderRow.erp_status, orderRow.source_quote_id,
         orderRow.customer_id
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
    return { status: 500, body: { error: 'order insert failed', detail: String(e && e.message || e) } };
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
    // A retry carrying the same paymentKey is the idempotent replay of the
    // payment that already succeeded.
    const replay = await db.prepare('SELECT status FROM payments WHERE payment_key = ?').bind(paymentKey).first();
    if (replay && replay.status === 'paid') {
      return {
        status: 200,
        body: { idempotent: true, already_paid: true, payment_key: paymentKey, order: publicOrderView(order, await getOrderItems(db, orderId)) },
      };
    }
    return { status: 200, body: { already_paid: true, order: publicOrderView(order, await getOrderItems(db, orderId)) } };
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

  // Client-reported authentication failure (no approval call needed).
  if (body.failure || body.failed) {
    const code = String(body.failure_code || 'PAY_PROCESS_CANCELED');
    const message = String(body.failure_message || '');
    await recordPaymentOutcome(db, {
      order, paymentKey, amount: order.total_amount, status: 'failed',
      failureCode: code, failureMessage: message, provider: pg.provider, providerMode: pg.mode,
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
    };
  }

  await recordPaymentOutcome(db, {
    order, paymentKey, amount: order.total_amount, provider: pg.provider, providerMode: pg.mode,
    requestedAt: startedAt, ...outcome,
  });

  const updated = await getOrderFull(db, order.id);
  if (outcome.status === 'paid') {
    const enqueued = await enqueueErpSync(db, env, updated, updated.items);
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

/** Persist a payment outcome and keep the order/payment status consistent. */
async function recordPaymentOutcome(db, { order, paymentKey, amount, status, failureCode, failureMessage, method, requestedAt, approvedAt, suppliedAmount, vat, balanceAmount, raw, provider, providerMode }) {
  const ts = nowIso();
  const stmts = [];

  stmts.push(
    db.prepare(
      `INSERT OR REPLACE INTO payments (order_id, payment_key, provider, provider_mode, pg_order_id, amount,
         supplied_amount, vat, method, status, requested_at, approved_at, balance_amount,
         failure_code, failure_message, raw, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      order.id, paymentKey, provider || 'tosspayments', providerMode || 'mock', order.id, amount,
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
    stmts.push(
      db.prepare('UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?').bind('failed', ts, order.id)
    );
    stmts.push(
      db.prepare('INSERT INTO order_events (order_id, type, actor, from_status, to_status, meta, error, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .bind(order.id, 'payment_failed', 'pg', order.status, null, JSON.stringify({ payment_key: paymentKey, amount }),
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

  // A retry for the same (payment, reason) returns the recorded outcome instead
  // of refunding twice. Exact JSON match, so "환불" never shadows "부분 환불".
  const prior = await db
    .prepare("SELECT meta FROM order_events WHERE order_id = ? AND type = 'payment_cancelled' AND json_extract(meta, '$.payment_key') = ? AND json_extract(meta, '$.reason') = ? ORDER BY created_at DESC LIMIT 1")
    .bind(order.id, paymentKey, reason)
    .first();
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
      cancelAmount,
      cancelReason: reason,
      refundReceiveAccount: body.refundReceiveAccount || null,
      idempotencyKey: `cgi:cancel:${order.id}:${paymentKey}:${cancelAmount}`,
    });
    outcome = {
      ok: true,
      status: result.status || 'CANCELED',
      balanceAmount: toNonNegInt(result.balanceAmount),
      cancelAmount: toNonNegInt(result.cancel_amount, cancelAmount),
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

/** Build (and attempt to transmit) the ERP payload for an order. */
async function enqueueErpSync(db, env, order, items, force = false) {
  const mode = erpModeFromEnv(env);
  const driver = createErpDriver(env);
  const orderForPayload = { ...order, pg_provider: 'tosspayments', pg_provider_mode: mode };
  const payload = buildEcountSalesSlip({ order: orderForPayload, items, mode, liveWrite: false });

  const existing = await db.prepare('SELECT * FROM erp_sync WHERE dedupe_key = ?').bind(payload.dedupe_key).first();
  if (existing && !force) {
    return {
      idempotent: true,
      id: existing.id,
      status: existing.status,
      mode: existing.mode,
      delivered: false,
      live_write: false,
      attempts: existing.attempts,
      dedupe_key: existing.dedupe_key,
      payload_lines: payload.lines.length,
      note: existing.last_error,
    };
  }

  let result;
  try {
    result = await driver.transmit(payload);
  } catch (e) {
    result = {
      delivered: false,
      status: 'failed',
      error: `ERP transmission error: ${(e && e.message) ? String(e.message) : String(e)}`.slice(0, 500),
    };
  }
  const status = result.delivered ? 'sent' : result.status === 'failed' ? 'failed' : 'skipped';
  const ts = nowIso();
  const attempts = existing ? toNonNegInt(existing.attempts, 0) + 1 : 1;

  if (existing) {
    await db.prepare('UPDATE erp_sync SET payload = ?, status = ?, attempts = ?, last_error = ?, mode = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(payload), status, attempts, result.note || result.error || null, mode, ts, existing.id).run();
  } else {
    await db.prepare(
      `INSERT INTO erp_sync (order_id, adapter, mode, action, dedupe_key, payload, status, attempts, last_error, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(order.id, ERP_ADAPTER, mode, payload.target.action, payload.dedupe_key, JSON.stringify(payload), status, attempts,
      result.note || result.error || null, ts, ts).run();
  }

  await db.batch([
    db.prepare('UPDATE orders SET erp_status = ?, erp_sent_at = ?, updated_at = ? WHERE id = ?').bind(status, status === 'sent' ? ts : null, ts, order.id),
    db.prepare('INSERT INTO order_events (order_id, type, actor, from_status, to_status, meta, error, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(order.id, status === 'sent' ? 'erp_sent' : status === 'failed' ? 'erp_failed' : 'erp_skipped', 'erp',
        order.status, null, JSON.stringify({ adapter: ERP_ADAPTER, mode, delivered: result.delivered, attempts }),
        result.error || null, ts),
  ]);

  return {
    id: existing ? existing.id : null,
    status,
    mode,
    delivered: result.delivered,
    attempts,
    dedupe_key: payload.dedupe_key,
    note: result.note || result.error || null,
    payload_lines: payload.lines.length,
    live_write: result.delivered,
  };
}

// ---------------------------------------------------------------------------
// schema init (deploy aid: apply schema.sql to the live D1)
// ---------------------------------------------------------------------------

const SCHEMA_STATEMENTS = `CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('purchase','quote')),
  idempotency_key TEXT UNIQUE, cart_hash TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  customer_company TEXT NOT NULL, customer_name TEXT NOT NULL, customer_phone TEXT NOT NULL, customer_email TEXT,
  customer_addr TEXT, customer_addr_detail TEXT, customer_note TEXT, services TEXT,
  item_total INTEGER NOT NULL DEFAULT 0, shipping_fee INTEGER NOT NULL DEFAULT 0,
  total_amount INTEGER NOT NULL DEFAULT 0, supplied_amount INTEGER NOT NULL DEFAULT 0, vat_amount INTEGER NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'none', payment_method TEXT, payment_key TEXT, paid_at TEXT,
  refunded_amount INTEGER NOT NULL DEFAULT 0,
  delivery_status TEXT NOT NULL DEFAULT 'pending', delivery_tracking TEXT,
  admin_prices TEXT, admin_note TEXT, erp_status TEXT NOT NULL DEFAULT 'not_sent', erp_sent_at TEXT,
  source_quote_id TEXT, customer_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_kind ON orders(kind);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_customer_company ON orders(customer_company);
CREATE INDEX IF NOT EXISTS idx_orders_cart_hash ON orders(cart_hash);
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
CREATE TABLE IF NOT EXISTS order_items (
  order_id TEXT NOT NULL, seq INTEGER NOT NULL, product_id TEXT NOT NULL, product_name TEXT NOT NULL,
  brand TEXT, category TEXT, option_label TEXT, price_state TEXT NOT NULL, unit_price INTEGER,
  qty INTEGER NOT NULL, line_total INTEGER NOT NULL, erp_code TEXT,
  PRIMARY KEY (order_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, order_id TEXT NOT NULL, payment_key TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL DEFAULT 'tosspayments', provider_mode TEXT NOT NULL DEFAULT 'test',
  pg_order_id TEXT NOT NULL, amount INTEGER NOT NULL, supplied_amount INTEGER NOT NULL DEFAULT 0,
  vat INTEGER NOT NULL DEFAULT 0, method TEXT, status TEXT NOT NULL, requested_at TEXT, approved_at TEXT,
  balance_amount INTEGER NOT NULL DEFAULT 0, cancel_amount INTEGER NOT NULL DEFAULT 0,
  failure_code TEXT, failure_message TEXT, raw TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY, order_id TEXT NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL DEFAULT 'system',
  from_status TEXT, to_status TEXT, meta TEXT, error TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id);
CREATE INDEX IF NOT EXISTS idx_order_events_type ON order_events(type);
CREATE TABLE IF NOT EXISTS erp_sync (
  id INTEGER PRIMARY KEY, order_id TEXT NOT NULL, adapter TEXT NOT NULL DEFAULT 'ecount-test',
  mode TEXT NOT NULL DEFAULT 'test', action TEXT NOT NULL DEFAULT 'sales_slip_create',
  dedupe_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_erp_sync_order_id ON erp_sync(order_id);
CREATE INDEX IF NOT EXISTS idx_erp_sync_status ON erp_sync(status);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL,
  phone TEXT, company TEXT, email_verified_at TEXT, role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_members_status ON members(status);
CREATE INDEX IF NOT EXISTS idx_members_created_at ON members(created_at);
CREATE INDEX IF NOT EXISTS idx_members_role ON members(role);
CREATE TABLE IF NOT EXISTS member_addresses (
  id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL, label TEXT NOT NULL, recipient_name TEXT NOT NULL,
  phone TEXT NOT NULL, addr TEXT NOT NULL, addr_detail TEXT, company TEXT,
  is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_member_addresses_member_id ON member_addresses(member_id);
CREATE TABLE IF NOT EXISTS auth_tokens (
  id INTEGER PRIMARY KEY, member_id INTEGER, kind TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  email TEXT, status TEXT NOT NULL DEFAULT 'pending', expires_at TEXT NOT NULL,
  consumed_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL, meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_member_kind ON auth_tokens(member_id, kind);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires_at ON auth_tokens(expires_at);
CREATE TABLE IF NOT EXISTS auth_attempts (
  kind TEXT NOT NULL, key TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1,
  first_at TEXT NOT NULL, last_at TEXT NOT NULL, locked_until TEXT, PRIMARY KEY (kind, key)
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_last_at ON auth_attempts(last_at);
CREATE TABLE IF NOT EXISTS member_events (
  id INTEGER PRIMARY KEY, member_id INTEGER, type TEXT NOT NULL, meta TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_member_events_member_id ON member_events(member_id);
CREATE INDEX IF NOT EXISTS idx_member_events_type ON member_events(type);`;

async function initSchema(db) {
  await db.exec(SCHEMA_STATEMENTS);
  const columns = await ensureColumns(db, COLUMN_UPGRADES);
  const tables = [];
  for (const name of [
    'orders', 'order_items', 'payments', 'order_events', 'erp_sync', 'quote_requests',
    'members', 'member_addresses', 'auth_tokens', 'auth_attempts', 'member_events',
  ]) {
    const row = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").bind(name).first();
    if (row) tables.push(name);
  }
  return { ok: true, tables, upgraded_columns: columns };
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
  const protectedBuckets = new Set(['resend-verify-cooldown']);
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
  if (origin === ALLOWED_ORIGIN) return true;
  const list = String(env.CORS_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return false;
  if (!originStrict(env) && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return list.includes(origin);
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
    return authJson({ error: 'origin not allowed', detail: { expected: ALLOWED_ORIGIN } }, 403);
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
  const value = decodeURIComponent(part.slice(name.length + 1));
  if (!value) return null;
  const row = await getAuthToken(db, value);
  if (!row || row.kind !== 'session' || row.status !== 'pending') return null;
  if (String(row.expires_at) <= nowIso()) return null;
  return row;
}

async function requireMember(request, db, env) {
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
  const state = await createOAuthState(env.AUTH_SESSION_SECRET || 'cgi-dev-secret');

  const authUrl = buildAuthorizationUrl({ clientId, redirectUri }, state);
  if (!authUrl) return authJson({ error: 'google oauth not configured' }, 503);

  const cookieOpts = oauthStateCookieOptions();
  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl,
      'Set-Cookie': `${OAUTH_STATE_COOKIE}=${state}; ${Object.entries(cookieOpts).map(([k, v]) => `${k}=${v}`).join('; ')}`,
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

  const clientId = env.GOOGLE_CLIENT_ID || env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET || env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = url.toString();

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
        // Link Google ID to existing account
        const now = nowIso();
        await db.prepare('UPDATE members SET google_id = ?, updated_at = ? WHERE id = ?')
          .bind(userInfo.subject, now, member.id).run();
        member = { ...member, google_id: userInfo.subject };
        await db.prepare('INSERT INTO member_events (member_id, type, meta, created_at) VALUES (?, ?, ?, ?)')
          .bind(member.id, 'google_linked', JSON.stringify({ google_id: userInfo.subject }), now).run();
      } else {
        // Create new member
        const now = nowIso();
        const passwordHash = await hashPassword('google-oauth-no-password', authPolicy(env));
        const result = await db.prepare(
          'INSERT INTO members (email, password_hash, name, google_id, status, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(userInfo.email, passwordHash, userInfo.name || userInfo.email.split('@')[0], userInfo.subject, 'active', now, now, now).run();
        const memberId = result.meta.last_row_id ?? result.meta.last_rowid ?? 0;
        member = await getMember(db, memberId);
        await db.prepare('INSERT INTO member_events (member_id, type, meta, created_at) VALUES (?, ?, ?, ?)')
          .bind(memberId, 'google_signup', JSON.stringify({ google_id: userInfo.subject }), now).run();
      }
    }

    // Issue session
    const session = await issueSession(db, env, member);
    return authJson({
      member: memberView(member),
      email_verified: !!member.email_verified_at,
      auth_provider: 'google',
    }, 200, { 'Set-Cookie': session.cookie + '; ' + clearCookie });

  } catch (e) {
    return authJson({ error: 'google auth failed', detail: e.message }, 400);
  }
}

// ---------------------------------------------------------------------------
// auth routes
// ---------------------------------------------------------------------------

async function handleAuthRoute(pathname, method, request, db, env) {
  const guard = guardAuth(request, env);
  if (guard) return guard;
  const mail = createMailAdapter(env, console.log);
  const parsed = await readJson(request);
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
        'INSERT INTO members (email, password_hash, name, phone, company, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(email.email, passwordHash, name.name, phone.phone, company.value, 'active', now, now).run();
      memberId = result.meta.last_row_id ?? result.meta.last_rowid ?? 0;
    } catch (e) {
      return authJson({ error: 'email already used', detail: 'this email address is already registered' }, 409);
    }

    await db.prepare('INSERT INTO member_events (member_id, type, meta, created_at) VALUES (?, ?, ?, ?)')
      .bind(memberId, 'signup', JSON.stringify({ verified: false }), now).run();
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
    const limit = await rateLimitCheck(db, policy, 'email-verify', String(providedMemberId || 'token'));
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
    const member = await requireMember(request, db, env);
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

  // ---------------- Google OAuth (issue #79) ----------------

  if (pathname === '/api/auth/google/start' && method === 'GET') {
    return handleGoogleStart(request, db, env);
  }

  if (pathname === '/api/auth/google/callback' && method === 'GET') {
    return handleGoogleCallback(request, db, env);
  }

  return null;
}

// ---------------------------------------------------------------------------
// my page (issue #69)
// ---------------------------------------------------------------------------

async function handleMeRoute(pathname, method, url, request, db, env) {
  const guard = guardAuth(request, env);
  if (guard) return guard;
  const member = await requireMember(request, db, env);
  if (!member) return authJson({ error: 'unauthorized', detail: 'sign in first' }, 401);
  const parsed = await readJson(request);
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
    if (!body || !Array.isArray(body.items) || !body.items.length) {
      return authJson({ error: 'items required' }, 400);
    }
    if (!body.company || !body.name || !body.phone) {
      return authJson({ error: 'company, name, phone required' }, 400);
    }
    const id = 'Q-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const createdAt = nowIso();
    await db.prepare(
      `INSERT INTO quote_requests (id, created_at, company, contact_name, phone, email, location, note, services, items, status, member_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)`
    ).bind(
      id, createdAt, body.company, body.name, body.phone, body.email || null, body.location || null, body.note || null,
      JSON.stringify(body.services || []), JSON.stringify(body.items), member.id, createdAt
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeadersFor(url.pathname) });
    }

    const pg = createPgAdapter({ secretKey: env.TOSS_WIDGET_SECRET_KEY, mode: env.PG_PROVIDER_MODE || 'auto' });

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
      const parsed = await readJson(request);
      if (parsed.error) return badRequest(parsed.error);
      const body = parsed.body;
      if (!body || !Array.isArray(body.items) || !body.items.length) {
        return badRequest('items required');
      }
      if (!body.company || !body.name || !body.phone) {
        return badRequest('company, name, phone required');
      }
      const id = 'Q-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const createdAt = nowIso();
      // A signed-in member is linked only when the request also clears the
      // Origin + CSRF gate; otherwise the legacy guest submission is unchanged.
      let quoteMemberId = null;
      if (request.headers.get('Origin') && csrfOk(request, env)) {
        const quoteMember = await requireMember(request, env.DB, env);
        if (quoteMember) quoteMemberId = quoteMember.id;
      }
      await env.DB.prepare(
        `INSERT INTO quote_requests (id, created_at, company, contact_name, phone, email, location, note, services, items, status, member_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)`
      ).bind(
        id, createdAt, body.company, body.name, body.phone, body.email || null, body.location || null, body.note || null,
        JSON.stringify(body.services || []), JSON.stringify(body.items), quoteMemberId, createdAt
      ).run();
      return json({ id, created_at: createdAt, status: 'received', member_id: quoteMemberId }, 201);
    }

    if (url.pathname === '/api/quotes' && request.method === 'GET') {
      if (!(await isAdminOrMember(request, env.DB, env))) return unauthorized();
      const status = url.searchParams.get('status');
      let stmt = env.DB.prepare('SELECT id, created_at, company, contact_name, phone, status, total FROM quote_requests ORDER BY created_at DESC');
      if (status) stmt = env.DB.prepare('SELECT id, created_at, company, contact_name, phone, status, total FROM quote_requests WHERE status = ? ORDER BY created_at DESC').bind(status);
      const { results } = await stmt.all();
      return json({ items: results });
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
      const policy = authPolicy(env);
      const mail = createMailAdapter(env, () => {});
      return json({
        version: BACKEND_VERSION,
        ok: true,
        pg: { provider: pg.provider, mode: pg.mode, sandbox: pg.sandbox, live: pg.live },
        erp: { adapter: ERP_ADAPTER, mode: erpModeFromEnv(env), live_write: String(env.ERP_LIVE_WRITE || 'NO').toUpperCase() === 'YES' },
        shipping_fee_default: toNonNegInt(env.SHIPPING_FEE_DEFAULT, 0),
        price_index: { products_total: PRICE_INDEX_META.products_total, products_with_price: PRICE_INDEX_META.products_with_price },
        cors_origin: ALLOWED_ORIGIN,
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

    if (url.pathname === '/api/admin/schema/init' && request.method === 'POST') {
      if (!(await isAdminOrMember(request, env.DB, env))) return unauthorized();
      try {
        const result = await initSchema(env.DB);
        return json(result, 200);
      } catch (e) {
        return json({ error: 'schema init failed', detail: String(e && e.message || e) }, 500);
      }
    }

    // ---------------- orders (public) ----------------

    if (url.pathname === '/api/orders' && request.method === 'POST') {
      const parsed = await readJson(request);
      if (parsed.error) return badRequest(parsed.error);
      const orderMember = await customerContext();
      const result = await createOrder(env.DB, parsed.body || {}, env, {
        idempotencyKey: request.headers.get('Idempotency-Key') || '',
        customerId: orderMember ? orderMember.id : null,
      });
      return json(result.body, result.status);
    }

    const paymentConfirmMatch = url.pathname === '/api/payments/confirm' && request.method === 'POST';
    if (paymentConfirmMatch) {
      const parsed = await readJson(request);
      if (parsed.error) return badRequest(parsed.error);
      const result = await confirmPayment(env.DB, parsed.body || {}, env, pg);
      return json(result.body, result.status);
    }

    const orderMatch = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
    if (orderMatch && request.method === 'GET') {
      const id = decodeURIComponent(orderMatch[1]);
      const order = await getOrderFull(env.DB, id);
      if (!order) return notFound();
      return json(publicOrderView(order, order.items));
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
    if (cancelMatch && request.method === 'POST') {
      if (!(await isAdminOrMember(request, env.DB, env))) return unauthorized();
      const id = decodeURIComponent(cancelMatch[1]);
      const paymentKey = decodeURIComponent(cancelMatch[2]);
      const parsed = await readJson(request);
      if (parsed.error) return badRequest(parsed.error);
      const order = await getOrder(env.DB, id);
      if (!order) return notFound();
      const result = await cancelPayment(env.DB, env, order, paymentKey, parsed.body || {}, pg);
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
