// CGI record -> ecountOS OAPI V2 request body, with the vendor's own field
// limits enforced before anything is transmitted.
//
// Why this is a separate layer: the transport in erp-oapi.mjs knows the wire
// contract, and the storefront knows the order/product model. The vendor
// rejects a batch row-by-row (Data.ResultDetails) and charges an account-wide
// consecutive-error quota for doing so, so an over-long or missing required
// field is caught HERE, locally, rather than paid for on the server.
//
// UPLOAD_SER_NO is the 전표 grouping key: rows sharing one value become one
// document. Every line of an order therefore carries the same serial, and a
// second order in the same batch must get a different one.

import { ERP_OAPI_ENDPOINTS, MULTI_VALUE_SEPARATOR } from './erp-oapi.mjs';
import { erpCodeFor } from './erp.mjs';

/** Documented maximum lengths, taken from the vendor field tables verbatim. */
export const OAPI_FIELD_LIMITS = {
  PROD_CD: 20,
  PROD_DES: 100,
  SIZE_DES: 100,
  UNIT: 6,
  PROD_TYPE: 1,
  WH_CD: 5,
  BAR_CODE: 30,
  CLASS_CD: 5,
  CLASS_CD2: 5,
  CLASS_CD3: 5,
  REMARKS_WIN: 100,
  REMARKS: 100,
  CUST: 30,
  CUST_DES: 100,
  BUSINESS_NO: 30,
  CUST_NAME: 100,
  BOSS_NAME: 50,
  TEL: 50,
  EMAIL: 100,
  POST_NO: 8,
  ADDR: 500,
  IO_DATE: 8,
  DOC_NO: 30,
  TTL_CTT: 200,
  REF_DES: 200,
  EMP_CD: 30,
  ITEM_CD: 14,
  UPLOAD_SER_NO: 4,
};

/** Endpoints whose docs mark these columns required (missing = guaranteed row fail). */
export const OAPI_REQUIRED_FIELDS = {
  saveBasicProduct: ['PROD_CD', 'PROD_DES'],
  saveBasicCust: ['BUSINESS_NO', 'CUST_NAME'],
  saveSaleOrder: ['UPLOAD_SER_NO', 'CUST', 'WH_CD', 'PROD_CD', 'QTY'],
  saveSale: ['UPLOAD_SER_NO', 'WH_CD', 'PROD_CD', 'QTY'],
  saveQuotation: ['UPLOAD_SER_NO', 'PROD_CD', 'QTY'],
  viewBasicProduct: ['PROD_CD'],
  getBasicProductsList: [],
  viewInventoryBalance: ['BASE_DATE', 'PROD_CD'],
  listInventoryBalance: ['BASE_DATE'],
  viewInventoryBalanceByLocation: ['BASE_DATE', 'PROD_CD'],
  listInventoryBalanceByLocation: ['BASE_DATE'],
};

const VAT_INCLUSIVE = '1';

export function ecountDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) throw new Error(`ecountDate: unparseable date ${JSON.stringify(String(value))}`);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** One row per BulkDatas element — the shape every Save* endpoint expects. */
export function bulkRows(rows) {
  return rows.map((row) => ({ BulkDatas: row }));
}

export function wrapList(endpointKey, rows) {
  const endpoint = ERP_OAPI_ENDPOINTS[endpointKey];
  if (!endpoint || !endpoint.listKey) throw new Error(`wrapList: ${endpointKey} has no list wrapper`);
  return { [endpoint.listKey]: bulkRows(rows) };
}

/** Returns [{field, reason}] — empty means the row is transmissible. */
export function validateRow(endpointKey, row) {
  const problems = [];
  for (const field of OAPI_REQUIRED_FIELDS[endpointKey] || []) {
    const value = row[field];
    if (value === undefined || value === null || String(value).trim() === '') {
      problems.push({ field, reason: 'required' });
    }
  }
  for (const [field, limit] of Object.entries(OAPI_FIELD_LIMITS)) {
    if (!(field in row)) continue;
    const value = row[field];
    if (value === undefined || value === null) continue;
    if (field.endsWith('_DATE') && String(value).length !== 8) problems.push({ field, reason: 'not_YYYYMMDD' });
    else if (String(value).length > limit) problems.push({ field, reason: 'too_long', length: String(value).length, limit });
  }
  if (row.PROD_TYPE !== undefined && row.PROD_TYPE !== '' && !'01234567'.includes(String(row.PROD_TYPE))) {
    problems.push({ field: 'PROD_TYPE', reason: 'not_a_code' });
  }
  if (row.QTY !== undefined && !(Number(row.QTY) > 0)) problems.push({ field: 'QTY', reason: 'must_be_positive' });
  return problems;
}

/** CGI product master row -> SaveBasicProduct BulkDatas. */
export function productRow({ productId, productName, unit = 'EA', prodType = '3', sizeDes = '', barCode = '', classCd = '', taxRate = 10, outPrice = null, inPrice = null, remarksWin = '' } = {}) {
  const row = {
    // A blank productId must stay blank: fabricating "XX-" would register a junk
    // item in the ERP master, which is far harder to undo than a local refusal.
    PROD_CD: productId ? String(productId) : '',
    PROD_DES: String(productName || ''),
    UNIT: unit,
    PROD_TYPE: String(prodType),
    BAL_FLAG: '1',
    SIZE_DES: String(sizeDes || ''),
    TAX: String(taxRate),
  };
  if (barCode) row.BAR_CODE = String(barCode);
  if (classCd) row.CLASS_CD = String(classCd);
  if (outPrice != null) { row.OUT_PRICE = String(outPrice); row.OUT_PRICE_VAT = VAT_INCLUSIVE; }
  if (inPrice != null) { row.IN_PRICE = String(inPrice); row.IN_PRICE_VAT = '0'; }
  if (remarksWin) row.REMARKS_WIN = String(remarksWin);
  return row;
}

/** CGI order customer -> SaveBasicCust BulkDatas (거래처 = 사업자등록번호 기준). */
export function custRow({ businessNo, name, ceo = '', tel = '', email = '', postNo = '', addr = '', remarksWin = '' } = {}) {
  return {
    BUSINESS_NO: String(businessNo || ''),
    CUST_NAME: String(name || ''),
    G_GUBUN: '01',
    GUBUN: '11',
    BOSS_NAME: String(ceo || ''),
    TEL: String(tel || ''),
    EMAIL: String(email || ''),
    POST_NO: String(postNo || ''),
    ADDR: String(addr || ''),
    REMARKS_WIN: String(remarksWin || ''),
  };
}

/**
 * CGI order + items -> slip rows. `serNo` groups the lines into one document;
 * a walk-in retail customer has no ERP 거래처, so caller must resolve CUST
 * first (see planCustomerSync) — otherwise every row fails on 거래처코드.
 *
 * No field is truncated here: a value the vendor column cannot hold is an
 * error the plan must report, not something to silently rewrite on the way into
 * an accounting document.
 */
export function slipRows({ order, items = [], serNo = 1, cust, custDes = '', whCd, ioDate = null, docNo = '', title = '', reference = '', vatInclusiveUnitPrice = true } = {}) {
  if (!order || !order.id) throw new Error('slipRows: order.id is required');
  const date = ioDate ? String(ioDate) : ecountDate(order.paid_at || order.created_at || Date.now());
  return items.map((item) => {
    const unitPrice = item.unit_price != null ? Number(item.unit_price) : 0;
    const qty = item.qty != null ? Number(item.qty) : 1;
    const row = {
      UPLOAD_SER_NO: String(serNo),
      IO_DATE: date,
      CUST: String(cust ?? order.erp_cust_cd ?? ''),
      WH_CD: String(whCd ?? order.erp_wh_cd ?? ''),
      PROD_CD: String(item.erp_code || (item.product_id ? erpCodeFor(item.product_id) : '')),
      PROD_DES: String(item.product_name || ''),
      QTY: String(qty),
      PRICE: String(unitPrice),
      USER_PRICE_VAT: vatInclusiveUnitPrice ? String(unitPrice) : '',
      REMARKS: String(item.option_label || ''),
    };
    if (custDes) row.CUST_DES = String(custDes);
    if (docNo) row.DOC_NO = String(docNo);
    if (title) row.TTL_CTT = String(title);
    if (reference) row.REF_DES = String(reference);
    return row;
  });
}

/**
 * Builds a send plan instead of sending. Every record is classified as either
 * a ready batch or a rejection with the local reason, so a dry run reports the
 * exact set the vendor would have refused without spending server errors.
 */
export function planSlip({ endpoint = 'saveSaleOrder', order, items = [], cust, custDes = '', whCd, ioDate = null, maxRowsPerCall = 50, dedupeKey = null, generatedAt = new Date() } = {}) {
  if (!ERP_OAPI_ENDPOINTS[endpoint]) throw new Error(`planSlip: unknown endpoint ${endpoint}`);
  const rows = slipRows({ order, items, serNo: 1, cust, custDes, whCd, ioDate });
  const rejected = [];
  const accepted = [];
  for (const row of rows) {
    const problems = validateRow(endpoint, row);
    if (problems.length) rejected.push({ PROD_CD: row.PROD_CD, problems });
    else accepted.push(row);
  }
  const batches = [];
  for (let i = 0; i < accepted.length; i += maxRowsPerCall) {
    batches.push({
      endpoint,
      body: wrapList(endpoint, accepted.slice(i, i + maxRowsPerCall)),
      rowCount: Math.min(maxRowsPerCall, accepted.length - i),
      dedupeKey: `${endpoint}:order:${order.id}:batch${i / maxRowsPerCall + 1}`,
    });
  }
  return {
    kind: 'slip',
    endpoint,
    order_id: order.id,
    dedupeKey: dedupeKey || `${endpoint}:order:${order.id}`,
    batches,
    acceptedCount: accepted.length,
    rejected,
    generated_at: generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt),
    transmitted: false,
    note: 'plan only — nothing was sent; run through the OAPI client with ERP_LIVE_WRITE=YES to transmit',
  };
}

export function planProductSync(records = [], { maxRowsPerCall = 1, generatedAt = new Date() } = {}) {
  const accepted = [];
  const rejected = [];
  for (const record of records) {
    const row = productRow(record);
    const problems = validateRow('saveBasicProduct', row);
    if (problems.length) rejected.push({ PROD_CD: row.PROD_CD, problems });
    else accepted.push(row);
  }
  const batches = [];
  for (let i = 0; i < accepted.length; i += maxRowsPerCall) {
    batches.push({
      endpoint: 'saveBasicProduct',
      body: wrapList('saveBasicProduct', accepted.slice(i, i + maxRowsPerCall)),
      prodCds: accepted.slice(i, i + maxRowsPerCall).map((r) => r.PROD_CD),
      dedupeKey: `saveBasicProduct:batch${i / maxRowsPerCall + 1}`,
    });
  }
  return { kind: 'product', acceptedCount: accepted.length, rejected, batches, generated_at: generatedAt.toISOString(), transmitted: false };
}

export function planCustomerSync(records = [], { maxRowsPerCall = 20, generatedAt = new Date() } = {}) {
  const accepted = [];
  const rejected = [];
  for (const record of records) {
    const row = custRow(record);
    const problems = validateRow('saveBasicCust', row);
    if (problems.length) rejected.push({ BUSINESS_NO: row.BUSINESS_NO, problems });
    else accepted.push(row);
  }
  const batches = [];
  for (let i = 0; i < accepted.length; i += maxRowsPerCall) {
    batches.push({
      endpoint: 'saveBasicCust',
      body: wrapList('saveBasicCust', accepted.slice(i, i + maxRowsPerCall)),
      dedupeKey: `saveBasicCust:batch${i / maxRowsPerCall + 1}`,
    });
  }
  return { kind: 'customer', acceptedCount: accepted.length, rejected, batches, generated_at: generatedAt.toISOString(), transmitted: false };
}

/**
 * Stock read plan. Codes are joined with the vendor's multi-value separator
 * and chunked, because the PROD_CD column is documented as "최대 20자" while
 * its declared type is STRING(2000) — the two do not agree, so the plan caps at
 * the smaller bound and reports the ambiguity rather than trusting either.
 */
export function planInventoryRead({ baseDate = ecountDate(Date.now()), prodCds = [], whCd = '', byLocation = false, chunkSize = 20, flags = {} } = {}) {
  const codes = prodCds.map((code) => String(code).trim()).filter(Boolean);
  const key = codes.length > 1 || codes.length === 0
    ? (byLocation ? 'listInventoryBalanceByLocation' : 'listInventoryBalance')
    : (byLocation ? 'viewInventoryBalanceByLocation' : 'viewInventoryBalance');
  if (codes.length > 1 && key.startsWith('view')) throw new Error('planInventoryRead: view endpoints take one PROD_CD');
  const chunks = [];
  for (let i = 0; i < (codes.length || 1); i += chunkSize) {
    const slice = codes.slice(i, i + chunkSize);
    chunks.push({
      endpoint: key,
      body: {
        BASE_DATE: String(baseDate),
        PROD_CD: slice.join(MULTI_VALUE_SEPARATOR),
        WH_CD: String(whCd || ''),
        ...flags,
      },
      prodCds: slice,
    });
  }
  return { kind: 'inventory_read', endpoint: key, chunks, minIntervalMs: ERP_OAPI_ENDPOINTS[key].minIntervalMs, note: 'list endpoints are 1 call / 10 minutes', transmitted: false };
}
