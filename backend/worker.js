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
// Required secrets: ADMIN_TOKEN
// Optional secrets: TOSS_WIDGET_SECRET_KEY, TOSS_API_SECRET_KEY,
//                   ERP_OAPI_BASE_URL, ERP_OAPI_TOKEN

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

const ALLOWED_ORIGIN = 'https://skerishkang.github.io';
const MAX_BODY_BYTES = 64 * 1024;
const DUPLICATE_WINDOW_SECONDS = 120;
// Smallest partial refund the backend will accept (KRW). Anything below this is
// rounding dust rather than a refund; override with the MIN_PARTIAL_REFUND var.
const MIN_PARTIAL_REFUND = 1000;
const BACKEND_VERSION = '1.2.0';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,Idempotency-Key',
  'Vary': 'Origin',
};

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
  delivery_status, delivery_tracking, admin_prices, admin_note, erp_status, erp_sent_at, source_quote_id`;

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
          payment_status, erp_status, source_quote_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        orderRow.id, orderRow.kind, orderRow.idempotency_key, orderRow.cart_hash, orderRow.status,
        orderRow.created_at, orderRow.updated_at, orderRow.customer_company, orderRow.customer_name,
        orderRow.customer_phone, orderRow.customer_email, orderRow.customer_addr, orderRow.customer_addr_detail,
        orderRow.customer_note, orderRow.services, orderRow.item_total, orderRow.shipping_fee, orderRow.total_amount,
        orderRow.supplied_amount, orderRow.vat_amount, orderRow.payment_status, orderRow.erp_status, orderRow.source_quote_id
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
      `INSERT INTO quote_requests (id, created_at, company, contact_name, phone, email, location, note, services, items, status, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      quoteId, createdAt, orderRow.customer_company, orderRow.customer_name, orderRow.customer_phone,
      orderRow.customer_email, orderRow.customer_addr, orderRow.customer_note,
      JSON.stringify(services), JSON.stringify(quoteItems), 'received', createdAt
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

async function updateOrder(db, order, body) {
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
        .bind(order.id, event.type, 'admin', event.from || null, event.to || null, JSON.stringify(event), ts)
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
  source_quote_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_kind ON orders(kind);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_customer_company ON orders(customer_company);
CREATE INDEX IF NOT EXISTS idx_orders_cart_hash ON orders(cart_hash);
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
CREATE INDEX IF NOT EXISTS idx_erp_sync_status ON erp_sync(status);`;

async function initSchema(db) {
  await db.exec(SCHEMA_STATEMENTS);
  const tables = [];
  for (const name of ['orders', 'order_items', 'payments', 'order_events', 'erp_sync', 'quote_requests']) {
    const row = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").bind(name).first();
    if (row) tables.push(name);
  }
  return { ok: true, tables };
}

// ---------------------------------------------------------------------------
// worker
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const pg = createPgAdapter({ secretKey: env.TOSS_WIDGET_SECRET_KEY, mode: env.PG_PROVIDER_MODE || 'auto' });

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
      await env.DB.prepare(
        `INSERT INTO quote_requests (id, created_at, company, contact_name, phone, email, location, note, services, items, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`
      ).bind(
        id, createdAt, body.company, body.name, body.phone, body.email || null, body.location || null, body.note || null,
        JSON.stringify(body.services || []), JSON.stringify(body.items), createdAt
      ).run();
      return json({ id, created_at: createdAt, status: 'received' }, 201);
    }

    if (url.pathname === '/api/quotes' && request.method === 'GET') {
      if (!isAdmin(request, env)) return unauthorized();
      const status = url.searchParams.get('status');
      let stmt = env.DB.prepare('SELECT id, created_at, company, contact_name, phone, status, total FROM quote_requests ORDER BY created_at DESC');
      if (status) stmt = env.DB.prepare('SELECT id, created_at, company, contact_name, phone, status, total FROM quote_requests WHERE status = ? ORDER BY created_at DESC').bind(status);
      const { results } = await stmt.all();
      return json({ items: results });
    }

    const getMatch = url.pathname.match(/^\/api\/quotes\/([^/]+)$/);
    if (getMatch && request.method === 'GET') {
      if (!isAdmin(request, env)) return unauthorized();
      const id = decodeURIComponent(getMatch[1]);
      const row = await env.DB.prepare('SELECT * FROM quote_requests WHERE id = ?').bind(id).first();
      if (!row) return notFound();
      return json(row);
    }

    if (getMatch && request.method === 'PATCH') {
      if (!isAdmin(request, env)) return unauthorized();
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
      return json({
        version: BACKEND_VERSION,
        ok: true,
        pg: { provider: pg.provider, mode: pg.mode, sandbox: pg.sandbox, live: pg.live },
        erp: { adapter: ERP_ADAPTER, mode: erpModeFromEnv(env), live_write: String(env.ERP_LIVE_WRITE || 'NO').toUpperCase() === 'YES' },
        shipping_fee_default: toNonNegInt(env.SHIPPING_FEE_DEFAULT, 0),
        price_index: { products_total: PRICE_INDEX_META.products_total, products_with_price: PRICE_INDEX_META.products_with_price },
        cors_origin: ALLOWED_ORIGIN,
      });
    }

    if (url.pathname === '/api/admin/schema/init' && request.method === 'POST') {
      if (!isAdmin(request, env)) return unauthorized();
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
      const result = await createOrder(env.DB, parsed.body || {}, env, {
        idempotencyKey: request.headers.get('Idempotency-Key') || '',
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
      if (!isAdmin(request, env)) return unauthorized();
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
      if (!isAdmin(request, env)) return unauthorized();
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
      if (!isAdmin(request, env)) return unauthorized();
      const { results } = await env.DB.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at ASC, id ASC')
        .bind(decodeURIComponent(eventsMatch[1])).all();
      return json({ items: results || [] });
    }

    const pricesMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/quote\/prices$/);
    if (pricesMatch && request.method === 'POST') {
      if (!isAdmin(request, env)) return unauthorized();
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
      if (!isAdmin(request, env)) return unauthorized();
      const id = decodeURIComponent(erpMatch[1]);
      const force = url.pathname.endsWith('/retry');
      const order = await getOrderFull(env.DB, id);
      if (!order) return notFound();
      const result = await enqueueErpSync(env.DB, env, order, order.items, force);
      return json(result, 200);
    }

    const cancelMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/payments\/([^/]+)\/cancel$/);
    if (cancelMatch && request.method === 'POST') {
      if (!isAdmin(request, env)) return unauthorized();
      const id = decodeURIComponent(cancelMatch[1]);
      const paymentKey = decodeURIComponent(cancelMatch[2]);
      const parsed = await readJson(request);
      if (parsed.error) return badRequest(parsed.error);
      const order = await getOrder(env.DB, id);
      if (!order) return notFound();
      const result = await cancelPayment(env.DB, env, order, paymentKey, parsed.body || {}, pg);
      return json(result.body, result.status);
    }

    return notFound();
  },
};
