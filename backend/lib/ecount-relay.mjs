import { planSlip } from './erp-plan.mjs';
import { ECOUNT_ORDER_ACTION, ECOUNT_ORDER_ADAPTER, ecountOrderDedupeKey } from './ecount-order-adapter.mjs';

export const DEFAULT_SYNC_MODE = 'relay';
export const RELAY_MODE = 'relay';
export const DIRECT_MODE = 'direct';
export const RELAY_CLAIM_TTL_MS = 15 * 60 * 1000;
export const RELAY_MAX_ATTEMPTS = 3;
export const RELAY_DEFAULT_CUST = 'ONLINE01';
export const RELAY_DEFAULT_WH_CD = '100';

const text = (value) => String(value ?? '').trim();

export function ecountSyncMode(env = {}) {
  return text(env.ECOUNT_SYNC_MODE).toLowerCase() === DIRECT_MODE ? DIRECT_MODE : DEFAULT_SYNC_MODE;
}

export function relayEnabled(env = {}) {
  return text(env.ECOUNT_ORDER_SYNC_ENABLED).toUpperCase() === 'YES';
}

export function constantTimeEquals(a, b) {
  const left = new TextEncoder().encode(String(a ?? ''));
  const right = new TextEncoder().encode(String(b ?? ''));
  const max = Math.max(left.length, right.length, 1);
  let diff = left.length ^ right.length;
  for (let i = 0; i < max; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

export function relayMaterial({ order, items = [], approvedItemMap = {}, env = {}, generatedAt = new Date() } = {}) {
  const cust = text(env.ECOUNT_DEFAULT_CUST_CODE) || RELAY_DEFAULT_CUST;
  const whCd = text(env.ECOUNT_DEFAULT_WH_CD) || RELAY_DEFAULT_WH_CD;
  const rawOrder = {
    id: String(order?.id || ''),
    paid_at: order?.paid_at || null,
    created_at: order?.created_at || null,
    shipping_fee: Number(order?.shipping_fee || 0) || 0,
  };
  const rawItems = (Array.isArray(items) ? items : []).map((item) => ({
    product_id: String(item?.product_id || '').trim(),
    product_name: String(item?.product_name || ''),
    qty: Number(item?.qty ?? 1),
    unit_price: item?.unit_price == null ? null : Number(item.unit_price),
    option_label: String(item?.option_label || ''),
  }));
  const base = {
    adapter: ECOUNT_ORDER_ADAPTER,
    action: ECOUNT_ORDER_ACTION,
    order_id: rawOrder.id,
    dedupe_key: ecountOrderDedupeKey(rawOrder.id),
    relay: {
      sync_mode: RELAY_MODE,
      cust,
      wh_cd: whCd,
      order: rawOrder,
      items: rawItems,
      claimed_at: null,
      slip_no: null,
    },
  };

  if (!rawOrder.id) return { ready: false, reason: 'order_id_missing', missingProductIds: [], payload: { ...base, note: 'order_id_missing' } };
  if (!rawItems.length) return { ready: false, reason: 'order_lines_missing', missingProductIds: [], payload: { ...base, note: 'order_lines_missing' } };

  const map = approvedItemMap && typeof approvedItemMap === 'object' ? approvedItemMap : {};
  const productIds = [...new Set(rawItems.map((item) => item.product_id).filter(Boolean))];
  const missingProductIds = productIds.filter((id) => !text(map[id]));
  if (missingProductIds.length) {
    return { ready: false, reason: 'product_mapping_missing', missingProductIds, payload: { ...base, note: 'product_mapping_missing' } };
  }

  const mappedItems = rawItems.map((item) => ({ ...item, erp_code: text(map[item.product_id]) }));
  const plan = planSlip({
    endpoint: 'saveSaleOrder',
    order: rawOrder,
    items: mappedItems,
    cust,
    whCd,
    dedupeKey: base.dedupe_key,
    maxRowsPerCall: 50,
    generatedAt,
  });
  if (plan.rejected.length || plan.acceptedCount !== mappedItems.length || plan.batches.length !== 1) {
    return { ready: false, reason: 'sale_order_validation_failed', missingProductIds: [], payload: { ...base, note: 'sale_order_validation_failed' } };
  }

  const body = plan.batches[0].body;
  const lines = mappedItems.map((item, index) => {
    const row = body.SaleOrderList[index].BulkDatas;
    return {
      product_id: item.product_id,
      prod_cd: row.PROD_CD,
      qty: Number(row.QTY),
      unit_price: Number(row.PRICE),
      note: String(row.REMARKS || ''),
    };
  });
  return {
    ready: true,
    reason: null,
    missingProductIds: [],
    payload: {
      ...base,
      line_count: lines.length,
      lines,
      body,
      note: 'relay outbox — awaiting transmission from the allow-listed PC',
      generated_at: plan.generated_at,
    },
  };
}

export function parseRelayPayload(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
