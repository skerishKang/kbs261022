import { createErpOapiClient, ERP_OAPI_ENDPOINTS } from './erp-oapi.mjs';
import { planSlip } from './erp-plan.mjs';

export const ECOUNT_ORDER_ADAPTER = 'ecount-oapi-v2';
export const ECOUNT_ORDER_ACTION = 'sale_order_create';
export const ECOUNT_ORDER_SYNC_ENABLED = 'YES';
const MAX_LINES_PER_ORDER = 50;
const SALE_ORDER_PATH = '/OAPI/V2/SaleOrder/SaveSaleOrder';
// A new OAPI client is built per order, so retain the vendor endpoint interval
// across requests handled by this Worker isolate as well.
const liveEndpointLastCallAt = new Map();
const liveEndpointThrottleTails = new Map();

const text = (value) => String(value ?? '').trim();

async function waitForLiveEndpointInterval(path, { now, sleep }) {
  const endpoint = Object.values(ERP_OAPI_ENDPOINTS).find((item) => item.path === path);
  if (!endpoint) return;
  const previous = liveEndpointThrottleTails.get(path) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  liveEndpointThrottleTails.set(path, previous.then(() => gate));
  await previous;
  try {
    const lastCallAt = liveEndpointLastCallAt.get(path) ?? -Infinity;
    const waitMs = Math.max(0, endpoint.minIntervalMs - (now() - lastCallAt));
    if (waitMs > 0) await sleep(waitMs);
    liveEndpointLastCallAt.set(path, now());
  } finally {
    release();
  }
}

export function ecountOrderMode(env = {}) {
  if (text(env.ECOUNT_ORDER_SYNC_ENABLED).toUpperCase() !== ECOUNT_ORDER_SYNC_ENABLED) return 'disabled';
  if (text(env.ERP_MODE).toLowerCase() === 'mock') return 'mock';
  return text(env.ECOUNT_TARGET).toLowerCase() === 'prod' ? 'prod' : 'test';
}

export function ecountOrderDedupeKey(orderId) {
  return `${ECOUNT_ORDER_ADAPTER}:${ECOUNT_ORDER_ACTION}:order:${String(orderId || '')}`;
}

function notConfigured(mode, reason, orderId, lineCount) {
  return {
    ready: false,
    mode,
    status: 'not_configured',
    reason,
    orderId: String(orderId || ''),
    lineCount: Number(lineCount || 0),
    dedupeKey: orderId ? ecountOrderDedupeKey(orderId) : null,
    payload: {
      adapter: ECOUNT_ORDER_ADAPTER,
      action: ECOUNT_ORDER_ACTION,
      order_id: String(orderId || ''),
      line_count: Number(lineCount || 0),
      mapping_state: reason,
    },
  };
}

// The env JSON fallback is restricted to explicit mock mode for existing fixtures.
// Test and production modes read only records explicitly approved into D1.
function parseItemMap(raw) {
  if (!raw) return { ok: false, reason: 'item_mapping_missing', map: {} };
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'item_mapping_invalid', map: {} };
    const entries = Object.entries(parsed);
    if (!entries.length) return { ok: false, reason: 'item_mapping_missing', map: {} };
    const map = {};
    for (const [productId, prodCd] of entries) {
      if (!text(productId) || !text(prodCd)) return { ok: false, reason: 'item_mapping_invalid', map: {} };
      map[text(productId)] = text(prodCd);
    }
    return { ok: true, map };
  } catch {
    return { ok: false, reason: 'item_mapping_invalid', map: {} };
  }
}

/**
 * Build a fail-closed, one-request SaleOrder plan. CGI's stored `erp_code` is
 * currently a proposed SS-/SM- code, so only the explicit product map is
 * accepted as proof that an ECOUNT item exists.
 */
export function prepareEcountSaleOrder({ env = {}, order, items = [], approvedItemMap = null, generatedAt = new Date() } = {}) {
  const mode = ecountOrderMode(env);
  if (!order?.id) return notConfigured(mode, 'order_id_missing', '', items.length);
  if (order.payment_status !== 'paid' || order.status !== 'paid') {
    return notConfigured(mode, 'payment_not_complete', order.id, items.length);
  }
  if (mode === 'disabled') return notConfigured(mode, 'switch_off', order.id, items.length);

  const missingSecrets = ['ECOUNT_COM_CODE', 'ECOUNT_USER_ID', 'ECOUNT_API_CERT_KEY']
    .filter((key) => !text(env[key]));
  if (missingSecrets.length) return notConfigured(mode, `missing_secrets:${missingSecrets.join(',')}`, order.id, items.length);

  const target = text(env.ECOUNT_TARGET || 'test').toLowerCase();
  if (mode !== 'mock' && !['test', 'prod'].includes(target)) {
    return notConfigured(mode, 'invalid_target', order.id, items.length);
  }

  const customerCode = text(env.ECOUNT_DEFAULT_CUST_CODE);
  const warehouseCode = text(env.ECOUNT_DEFAULT_WH_CD);
  if (!customerCode || !warehouseCode) {
    const missing = [!customerCode && 'ECOUNT_DEFAULT_CUST_CODE', !warehouseCode && 'ECOUNT_DEFAULT_WH_CD'].filter(Boolean);
    return notConfigured(mode, `missing_mapping:${missing.join(',')}`, order.id, items.length);
  }
  if (!Array.isArray(items) || items.length === 0) return notConfigured(mode, 'order_lines_missing', order.id, 0);
  if (items.length > MAX_LINES_PER_ORDER) return notConfigured(mode, 'order_line_limit_exceeded', order.id, items.length);

  const approvedMap = approvedItemMap === null || approvedItemMap === undefined
    ? (text(env.ERP_MODE).toLowerCase() === 'mock' ? parseItemMap(env.ECOUNT_ITEM_CODE_MAP_JSON) : { ok: false, reason: 'item_mapping_missing', map: {} })
    : normalizeApprovedItemMap(approvedItemMap);
  const { ok: mapReady, reason: mapReason, map } = approvedMap;
  if (!mapReady) return notConfigured(mode, mapReason, order.id, items.length);
  const unmapped = items.filter((item) => !map[text(item.product_id)]);
  if (unmapped.length) return notConfigured(mode, 'product_mapping_missing', order.id, items.length);

  const mappedItems = items.map((item) => ({ ...item, erp_code: map[text(item.product_id)] }));
  const shippingFee = Math.max(0, Number(order.shipping_fee || 0));
  if (!Number.isFinite(shippingFee)) return notConfigured(mode, 'shipping_fee_invalid', order.id, items.length);
  if (shippingFee > 0) {
    const shippingCode = text(env.ECOUNT_SHIPPING_ITEM_CODE);
    if (!shippingCode) return notConfigured(mode, 'shipping_item_mapping_missing', order.id, items.length);
    mappedItems.push({
      product_id: '__cgi_shipping__',
      product_name: 'Shipping',
      erp_code: shippingCode,
      qty: 1,
      unit_price: shippingFee,
      line_total: shippingFee,
      option_label: '',
    });
  }
  if (mappedItems.length > MAX_LINES_PER_ORDER) return notConfigured(mode, 'order_line_limit_exceeded', order.id, mappedItems.length);

  const dedupeKey = ecountOrderDedupeKey(order.id);
  const plan = planSlip({
    endpoint: 'saveSaleOrder',
    order,
    items: mappedItems,
    cust: customerCode,
    whCd: warehouseCode,
    dedupeKey,
    maxRowsPerCall: MAX_LINES_PER_ORDER,
    generatedAt,
  });
  plan.note = 'plan only; transmission requires ECOUNT_ORDER_SYNC_ENABLED=YES';
  if (plan.acceptedCount !== mappedItems.length || plan.rejected.length || plan.batches.length !== 1) {
    return notConfigured(mode, 'sale_order_validation_failed', order.id, items.length);
  }

  return {
    ready: true,
    mode,
    status: 'pending',
    reason: null,
    orderId: String(order.id),
    lineCount: mappedItems.length,
    dedupeKey,
    plan,
    payload: plan,
  };
}

function normalizeApprovedItemMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'item_mapping_invalid', map: {} };
  const map = Object.create(null);
  for (const [productId, prodCd] of Object.entries(value)) {
    if (!text(productId) || !text(prodCd)) return { ok: false, reason: 'item_mapping_invalid', map: {} };
    map[text(productId)] = text(prodCd);
  }
  return Object.keys(map).length ? { ok: true, map } : { ok: false, reason: 'item_mapping_missing', map: {} };
}

/** Send a prepared single-order plan through the documented Zone → Login → SaveSaleOrder flow. */
export async function transmitEcountSaleOrder(prepared, {
  env = {},
  fetchFn = fetch,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!prepared?.ready) return { status: 'not_configured', retryable: false, errorCode: prepared?.reason || 'not_configured' };
  const enabled = text(env.ECOUNT_ORDER_SYNC_ENABLED).toUpperCase() === ECOUNT_ORDER_SYNC_ENABLED;
  if (!enabled) return { status: 'not_configured', retryable: false, errorCode: 'switch_off' };

  const mockMode = text(env.ERP_MODE).toLowerCase() === 'mock';
  if (mockMode && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(text(env.ERP_MOCK_BASE_URL))) {
    return { status: 'not_configured', retryable: false, errorCode: 'mock_base_url_not_loopback' };
  }
  const clientEnv = {
    ...env,
    ERP_MODE: mockMode ? 'mock' : 'live',
    ERP_LIVE_WRITE: mockMode ? 'NO' : 'YES',
  };
  let saleOrderRequestStarted = false;
  const guardedFetch = async (url, init) => {
    const pathname = new URL(String(url)).pathname;
    if (!mockMode) await waitForLiveEndpointInterval(pathname, { now, sleep });
    if (pathname === SALE_ORDER_PATH) saleOrderRequestStarted = true;
    return fetchFn(url, init);
  };
  const client = createErpOapiClient({ env: clientEnv, fetchFn: guardedFetch, now, sleep });
  if (!client.configured) return { status: 'not_configured', retryable: false, errorCode: 'credentials_missing' };

  try {
    await client.bootstrap();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await client.call('saveSaleOrder', prepared.plan.batches[0].body);
        if (!Array.isArray(response.slipNos) || response.slipNos.length !== 1 || !response.slipNos[0]) {
          return {
            status: 'unknown',
            retryable: false,
            errorCode: 'sale_order_slip_number_unconfirmed',
            traceId: response.traceId || null,
          };
        }
        return {
          status: 'sent',
          retryable: false,
          errorCode: null,
          slipNos: response.slipNos,
          traceId: response.traceId,
        };
      } catch (error) {
        if (error?.code === 'session_invalid' && error.retryable === true && attempt === 0) continue;
        return classifyTransmitError(error, saleOrderRequestStarted);
      }
    }
    return { status: 'failed', retryable: true, errorCode: 'session_retry_exhausted' };
  } catch (error) {
    return classifyTransmitError(error, saleOrderRequestStarted);
  }
}

function classifyTransmitError(error, saleOrderRequestStarted) {
  const errorCode = text(error?.code) || (error instanceof TypeError ? 'network_error' : 'oapi_error');
  const provenNotProcessed = error?.retryable === true || errorCode === 'http_404_path_absent';
  const uncertain = saleOrderRequestStarted && !provenNotProcessed;
  return {
    status: uncertain ? 'unknown' : 'failed',
    retryable: !uncertain,
    errorCode,
    traceId: text(error?.traceId) || null,
  };
}
