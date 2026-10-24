// Ecount ERP order-sync adapter.
//
// Status of the real integration (from issue #20): the Ecount OAPI credential
// set is NOT enabled, so `ERP_LIVE_WRITE=NO` and this adapter runs in
// "test" mode — it builds the exact payload that would be transmitted and
// records it locally. Nothing is written to Ecount.
//
// The payload targets the sales-slip screen (매출전표 I 입력) because #20
// established that Ecount is the order/inventory/accounting back office and
// product-master distribution belongs to the storefront, not Ecount.

export const ERP_ADAPTER = 'ecount-test';
export const ERP_ADAPTER_VERSION = '1.0.0';
export const ERP_SYSTEM = 'ecount';
export const ERP_SALES_SLIP_SCREEN = 'A6_매출전표_I';
export const ERP_ITEM_MASTER_SCREEN = 'E040103';
export const ERP_ACTION_SALES_SLIP = 'sales_slip_create';

const DEFAULT_VAT_RATE = 10; // Ecount 부가가치세율 (매출), per the #20 mapping

/** Source site -> Ecount item-code prefix (24-char codes are unavailable). */
const SITE_CODE_PREFIX = {
  'samasound.co.kr': 'SS',
  samasound: 'SS',
  'samamusic.co.kr': 'SM',
  samamusic: 'SM',
  'yamaha.co.kr': 'YM',
  yamaha: 'YM',
  'samastore.co.kr': 'SA',
};

/** Catalog id -> Ecount item code, e.g. samasound.co.kr:3836 -> SS-3836. */
export function erpCodeFor(productId) {
  const id = String(productId || '');
  const match = id.match(/^([^:]+):(.+)$/);
  if (!match) return `XX-${id}`;
  const prefix = SITE_CODE_PREFIX[match[1]] || 'XX';
  return `${prefix}-${match[2]}`;
}

/** Stable dedupe key: one ERP record per order + action. */
export function erpDedupeKey(orderId, action = ERP_ACTION_SALES_SLIP, adapter = ERP_ADAPTER) {
  return `${adapter}:${action}:order:${orderId}`;
}

/**
 * Build the Ecount sales-slip payload for an order.
 * Pure function: takes plain objects, returns plain JSON.
 */
export function buildEcountSalesSlip({ order, items, mode = 'test', liveWrite = false, generatedAt = new Date() } = {}) {
  if (!order || !order.id) throw new Error('order.id is required');

  const lines = (Array.isArray(items) ? items : []).map((item, index) => ({
    seq: item.seq != null ? item.seq : index + 1,
    prod_cd: item.erp_code || erpCodeFor(item.product_id),
    prod_des: item.product_name || '',
    qty: item.qty != null ? item.qty : 1,
    out_price: item.unit_price != null ? item.unit_price : null,
    out_price_vat: 1, // 출고단가 VAT포함여부 (Ecount J/K/M columns)
    vat_rate: DEFAULT_VAT_RATE,
    vat_inclusive: true,
    amt: item.line_total != null ? item.line_total : 0,
    remark: item.option_label || '',
  }));

  return {
    adapter: ERP_ADAPTER,
    adapter_version: ERP_ADAPTER_VERSION,
    mode,
    live_write: liveWrite,
    target: {
      erp: ERP_SYSTEM,
      screen: ERP_SALES_SLIP_SCREEN,
      screen_kind: '매출전표',
      action: ERP_ACTION_SALES_SLIP,
    },
    dedupe_key: erpDedupeKey(order.id, ERP_ACTION_SALES_SLIP),
    source: {
      system: 'cgi-storefront',
      order_id: order.id,
      kind: order.kind,
      status: order.status,
      created_at: order.created_at,
    },
    customer: {
      customer_name: order.customer_name || '',
      customer_company: order.customer_company || '',
      customer_phone: order.customer_phone || '',
      customer_email: order.customer_email || null,
      customer_addr: order.customer_addr || null,
      customer_addr_detail: order.customer_addr_detail || null,
    },
    payment: {
      provider: order.pg_provider || 'tosspayments',
      provider_mode: order.pg_provider_mode || mode,
      payment_key: order.payment_key || null,
      payment_method: order.payment_method || null,
      paid_at: order.paid_at || null,
      amount: order.total_amount != null ? order.total_amount : 0,
      supplied_amount: order.supplied_amount != null ? order.supplied_amount : 0,
      vat_amount: order.vat_amount != null ? order.vat_amount : 0,
      refunded_amount: order.refunded_amount != null ? order.refunded_amount : 0,
      payment_status: order.payment_status || 'none',
    },
    lines,
    totals: {
      item_total: order.item_total != null ? order.item_total : 0,
      shipping_fee: order.shipping_fee != null ? order.shipping_fee : 0,
      total_amount: order.total_amount != null ? order.total_amount : 0,
      supplied_amount: order.supplied_amount != null ? order.supplied_amount : 0,
      vat_amount: order.vat_amount != null ? order.vat_amount : 0,
    },
    note: order.customer_note || order.admin_note || null,
    admin_note: order.admin_note || null,
    generated_at: generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt),
    transmission: liveWrite ? 'live' : 'not_transmitted_test_mode',
  };
}

/** Field mapping used to build the payload (kept for auditability). */

export const ERP_FIELD_MAPPING = [
  { cgi: 'order.id', erp: '주문번호/메모', action: ERP_ACTION_SALES_SLIP },
  { cgi: 'order_items.erp_code', erp: 'prod_cd (품목코드)', action: ERP_ACTION_SALES_SLIP },
  { cgi: 'order_items.product_name', erp: 'prod_des (품목명)', action: ERP_ACTION_SALES_SLIP },
  { cgi: 'order_items.qty', erp: '수량', action: ERP_ACTION_SALES_SLIP },
  { cgi: 'order_items.unit_price', erp: 'out_price (출고단가, VAT포함)', action: ERP_ACTION_SALES_SLIP },
  { cgi: 'order.customer_name', erp: '거래처명/고객명', action: ERP_ACTION_SALES_SLIP },
  { cgi: 'order.total_amount', erp: '매출금액', action: ERP_ACTION_SALES_SLIP },
  { cgi: 'order.supplied_amount', erp: '공급가액', action: ERP_ACTION_SALES_SLIP },
  { cgi: 'order.vat_amount', erp: '부가세', action: ERP_ACTION_SALES_SLIP },
];

// ---------------------------------------------------------------------------
// ERP driver — separates "payload built" from "payload transmitted".
//
// Test driver  : builds the payload, records it, transmits NOTHING.
// Live driver  : POSTs to the Ecount OAPI endpoint. Requires BOTH
//                ERP_OAPI_BASE_URL and ERP_OAPI_TOKEN (Worker secrets) plus
//                ERP_LIVE_WRITE=YES. Not enabled as of issue #20 (OAPI creds
//                not issued), so this path is wired but unexercised.
// ---------------------------------------------------------------------------

export function erpModeFromEnv(env = {}) {
  const liveWrite = String(env.ERP_LIVE_WRITE || 'NO').toUpperCase() === 'YES';
  const requested = String(env.ERP_MODE || 'test').toLowerCase();
  return liveWrite && requested === 'live' ? 'live' : 'test';
}

export function createErpDriver(env = {}, fetchFn = fetch) {
  const mode = erpModeFromEnv(env);
  const baseUrl = env.ERP_OAPI_BASE_URL;
  const token = env.ERP_OAPI_TOKEN;
  const available = Boolean(baseUrl && token);

  if (mode === 'live') {
    return {
      adapter: ERP_ADAPTER,
      mode: 'live',
      available,
      ready: available,
      async transmit(payload) {
        if (!available) {
          return {
            delivered: false,
            status: 'skipped',
            note: 'ERP_LIVE_WRITE=YES but ERP_OAPI_BASE_URL/ERP_OAPI_TOKEN are not configured; nothing was transmitted.',
          };
        }
        const response = await fetchFn(`${baseUrl}/`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Idempotency-Key': payload.dedupe_key,
          },
          body: JSON.stringify(payload),
        });
        let body = null;
        try { body = await response.json(); } catch (e) { body = { text: (await response.text()).slice(0, 400) }; }
        if (!response.ok) {
          return { delivered: false, status: 'failed', error: `HTTP ${response.status}`, response: body };
        }
        return { delivered: true, status: 'sent', response: body };
      },
    };
  }

  return {
    adapter: ERP_ADAPTER,
    mode: 'test',
    available: false,
    ready: false,
    async transmit(payload) {
      return {
        delivered: false,
        status: 'skipped',
        note: 'TEST ADAPTER — ERP_LIVE_WRITE=NO. Payload built and stored locally; nothing was sent to Ecount.',
        dedupe_key: payload.dedupe_key,
      };
    },
  };
}
