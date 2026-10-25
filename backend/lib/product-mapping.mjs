// CGI product <-> ERP 품목 <-> 스마트스토어 상품 mapping, rebuilt from the
// mapping material already in this repository rather than invented again.
//
// Inputs (all committed, all de-identified product master — no customer data):
//   data/erp_prep/erp_extended_mapping.csv        4,575 rows, 품목코드 + 카페24 코드 + 공개판매가
//   data/erp_prep/ecount_item_upload.csv          4,575 rows, the vendor's 17-column 품목등록 sheet
//   data/smartstore_prep/smartstore_registration_prep.csv  4,575 rows, 네이버상품ID reserved empty
//   reports/data/erp/erp_readonly_comparison.json the measured CGI<->ERP overlap on 2026-10-23
//
// The measured overlap is the reason this module refuses to treat a code as
// transmittable: ERP held 964 품목, CGI holds 4,575, and exact 품목코드 matches
// were 0. Sixty-seven CGI items line up by name/model, which is an indicator,
// not a validated mapping. So a slip line may only carry a PROD_CD that either
// (a) we are about to register ourselves, or (b) an ERP read confirmed exists.
// Anything else is reported as unmapped instead of being sent and burning the
// account's consecutive-error quota on a guaranteed row failure.

import { erpCodeFor } from './erp.mjs';

const SITE_ALIAS = {
  samasound: 'samasound.co.kr',
  samamusic: 'samamusic.co.kr',
  yamaha: 'yamaha.co.kr',
  samastore: 'samastore.co.kr',
};

/** 공급처원본ID ("samasound:3836") -> CGI product id ("samasound.co.kr:3836"). */
export function normalizeCgiId(sourceId) {
  const raw = String(sourceId || '').trim();
  const match = raw.match(/^([^:]+):(.+)$/);
  if (!match) return raw;
  const site = match[1].includes('.') ? match[1] : (SITE_ALIAS[match[1]] || match[1]);
  return `${site}:${match[2]}`;
}

/**
 * Minimal RFC-4180 CSV reader: BOM, CRLF, quoted fields, embedded "" and
 * newlines inside quotes. These files carry Korean product names with commas
 * and quotes, so a split on ',' would corrupt rows silently.
 */
export function parseCsv(text) {
  const source = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((c) => String(c).trim() !== ''))
    .map((r) => Object.fromEntries(header.map((key, index) => [key, r[index] === undefined ? '' : String(r[index])])))
    .map(normalizeHeaderKeys);
}

/** Korean headers are the source of truth; ASCII aliases keep callers readable. */
const HEADER_ALIAS = {
  품목코드: 'erpProdCd', 상품명: 'prodDes', 바코드: 'barCode', 규격: 'sizeDes', 단위: 'unit',
  품목구분: 'prodType', 세트여부: 'setFlag', 재고수량관리: 'balFlag', 입고단가: 'inPrice',
  출고단가: 'outPrice', '출고단가 VAT포함여부': 'outPriceVat', '부가세율(매출)': 'taxRate',
  검색창내용: 'remarksWin', '공급처원본ID': 'sourceId', 카페24상품코드: 'cafe24ProductCd',
  카페24품목코드: 'cafe24ItemCd', 카테고리경로: 'categoryPath', 공개판매가: 'publicPrice',
  대표이미지: 'imageUrl', 출처URL: 'sourceUrl', 네이버상품ID: 'naverItemId',
  '네이버 상품ID': 'naverItemId', 브랜드: 'brand', 제조사: 'manufacturer', 모델명: 'model',
  '카테고리경로_CGI': 'categoryPath', '스마트스토어카테고리번호': 'naverCategoryNo',
  판매가: 'salePrice', 가격확인필요: 'priceInquiryOnly', 재고수량: 'stockQty',
  '상세이미지수': 'detailImageCount', '옵션수': 'optionCount', '옵션SKU요약': 'optionSummary',
  판매자코드: 'sellerManagementCode', '등록상태': 'regStatus', '등록가능여부_DB': 'dbRegistrable',
  '사유_DB': 'dbReason', '누락필수값': 'missingRequired', 준비도: 'readiness',
  '입고단가 VAT포함여부': 'inPriceVat', '부가세율(매입)': 'taxRateBuy', 품목공유여부: 'csFlag',
  원산지코드: 'originCode', 수입사: 'importer', ASTemplateCode: 'asTemplateCode',
  배송비: 'shipping', 반품교환정책: 'returnPolicy', KC고시정보: 'kcInfo',
};

function normalizeHeaderKeys(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    const alias = HEADER_ALIAS[key] || key;
    out[key] = value;
    if (alias !== key) out[alias] = value;
  }
  return out;
}

const blank = (v) => v === undefined || v === null || String(v).trim() === '';

function priceOf(record) {
  const raw = !blank(record.publicPrice) ? record.publicPrice : (!blank(record.salePrice) ? record.salePrice : '');
  const digits = String(raw).replace(/[^\d.-]/g, '');
  if (digits === '' || digits === '-' || !Number.isFinite(Number(digits))) {
    return { value: null, text: String(raw || ''), state: blank(record.priceInquiryOnly) || /^(아니오|no|n|0)$/i.test(String(record.priceInquiryOnly)) ? 'unknown' : 'inquiry' };
  }
  return { value: Math.round(Number(digits)), text: String(raw), state: 'public' };
}

/**
 * Joins the three prep files on 공급처원본ID and produces one record per CGI
 * product. Missing joins are kept and flagged — a record that exists in only
 * one file is a data defect worth counting, not a row to drop.
 */
export function buildMappingSet({ extendedRows = [], uploadRows = [], smartstoreRows = [], erpMasterRows = [] } = {}) {
  const extended = new Map(extendedRows.map((r) => [normalizeCgiId(r['공급처원본ID'] || r.sourceId), r]));
  const upload = new Map(uploadRows.map((r) => [String(r.erpProdCd || r['품목코드'] || '').trim(), r]));
  const smartstore = new Map(smartstoreRows.map((r) => [normalizeCgiId(r.sourceId || r['공급처원본ID']), r]));
  const erpCodes = new Set(erpMasterRows.map((r) => String(r.PROD_CD ?? r.prod_cd ?? r.erpProdCd ?? '').trim()).filter(Boolean));
  const erpBarcodes = new Map(erpMasterRows
    .map((r) => [String(r.BAR_CODE ?? r.bar_code ?? '').trim(), String(r.PROD_CD ?? r.prod_cd ?? '').trim()])
    .filter(([code]) => code));

  const ids = new Set([...extended.keys(), ...smartstore.keys(), ...uploadRows.map((r) => normalizeCgiId(r.sourceId || ''))].filter((id) => id && id !== ''));
  const records = [];
  for (const cgiId of ids) {
    const ext = extended.get(cgiId) || {};
    const ss = smartstore.get(cgiId) || {};
    const syntheticCode = ext.erpProdCd || ext['품목코드'] || erpCodeFor(cgiId);
    const up = upload.get(syntheticCode) || {};
    const barcode = String(up.barCode || ext.barCode || '').trim();
    const matchedByCode = erpCodes.has(syntheticCode);
    // Boolean, not the short-circuit value: `barcode && …` would leak "" into a
    // flag that callers compare with === false and that lands in JSON reports.
    const matchedByBarcode = !matchedByCode && barcode !== '' && erpBarcodes.has(barcode);
    const price = priceOf({ ...ss, ...ext });
    records.push({
      cgiId,
      sourceId: ext.sourceId || ext['공급처원본ID'] || ss.sourceId || cgiId.split(':').slice(1).join(':'),
      erpProdCd: matchedByBarcode ? erpBarcodes.get(barcode) : syntheticCode,
      erpProdCdProposed: syntheticCode,
      erpProdCdSource: matchedByCode ? 'erp_code_exact' : (matchedByBarcode ? 'erp_barcode' : 'cgi_synthetic'),
      erpProdCdVerified: matchedByCode || matchedByBarcode,
      prodDes: String(ext.prodDes || ext['상품명'] || up.prodDes || ss.prodDes || ss['상품명'] || '').trim(),
      barCode: barcode,
      unit: String(up.unit || 'EA').trim(),
      prodType: String(up.prodType || '3').trim(),
      balFlag: String(up.balFlag || '').trim(),
      sizeDes: String(ext.sizeDes || up.sizeDes || '').trim(),
      taxRate: String(up.taxRate || '10').trim(),
      outPrice: up.outPrice && !blank(up.outPrice) ? Number(String(up.outPrice).replace(/[^\d.-]/g, '')) : price.value,
      price,
      stockQty: blank(ss.stockQty) ? null : Number(ss.stockQty),
      availability: blank(ss['재고 여부']) ? null : String(ss['재고 여부']).trim(),
      naverItemId: blank(ss.naverItemId) ? null : String(ss.naverItemId).trim(),
      sellerManagementCode: blank(ss.sellerManagementCode) ? cgiId : String(ss.sellerManagementCode).trim(),
      naverCategoryNo: blank(ss.naverCategoryNo) ? null : String(ss.naverCategoryNo).trim(),
      naverRegStatus: blank(ss.regStatus) ? null : String(ss.regStatus).trim(),
      naverMissingRequired: blank(ss.missingRequired) ? [] : String(ss.missingRequired).split(';').map((s) => s.trim()).filter(Boolean),
      joins: { extended: extended.has(cgiId), upload: upload.has(syntheticCode), smartstore: smartstore.has(cgiId) },
    });
  }
  return records;
}

/** Column-level coverage, measured from the joined set. Reported, never assumed. */
export function coverageOf(records) {
  const total = records.length;
  const count = (predicate) => records.filter(predicate).length;
  return {
    total,
    erpProdCdVerified: count((r) => r.erpProdCdVerified),
    erpProdCdSynthetic: count((r) => r.erpProdCdSource === 'cgi_synthetic'),
    barCode: count((r) => !blank(r.barCode)),
    pricePublic: count((r) => r.price.state === 'public' && r.price.value != null),
    priceInquiry: count((r) => r.price.state === 'inquiry'),
    priceUnknown: count((r) => r.price.state === 'unknown'),
    stockNumeric: count((r) => r.stockQty != null),
    naverItemId: count((r) => r.naverItemId),
    naverCategoryNo: count((r) => r.naverCategoryNo),
    sellerManagementCode: count((r) => !blank(r.sellerManagementCode)),
    naverRegistered: count((r) => r.naverRegStatus && r.naverRegStatus !== '미등록'),
    fullyJoinedAllThree: count((r) => r.joins.extended && r.joins.upload && r.joins.smartstore),
    rates: {
      erpProdCdVerified: total ? count((r) => r.erpProdCdVerified) / total : 0,
      naverItemId: total ? count((r) => r.naverItemId) / total : 0,
      pricePublic: total ? count((r) => r.price.state === 'public') / total : 0,
    },
  };
}

/**
 * The gate the order->ERP path needs. `verified` may be transmitted against an
 * existing ERP master; `register_first` means the item is only a CGI-side
 * proposal and must go through SaveBasicProduct before any slip references it;
 * `unmapped` means we have no code at all.
 */
export function resolveErpProdCd(cgiId, records) {
  const record = records.find((r) => r.cgiId === cgiId);
  if (!record) return { status: 'unmapped', prodCd: null, reason: `no mapping row for ${cgiId}` };
  if (record.erpProdCdVerified) return { status: 'verified', prodCd: record.erpProdCd, source: record.erpProdCdSource };
  return {
    status: 'register_first',
    prodCd: record.erpProdCdProposed,
    reason: 'CGI- proposed 품목코드 with no ERP master match; ERP held 964 items and 0 exact code matches on 2026-10-23, so this code must be registered first',
  };
}

/** Rows the storefront can send today: those with a public price and a code. */
export function saleableRows(records) {
  return records.filter((r) => !blank(r.prodDes) && r.price.value != null);
}

/** Duplicate PROD_CD would make the vendor reject or merge rows — measured here. */
export function duplicateProdCds(records) {
  const seen = new Map();
  for (const r of records) seen.set(r.erpProdCdProposed, (seen.get(r.erpProdCdProposed) || 0) + 1);
  return [...seen.entries()].filter(([, n]) => n > 1).map(([code, n]) => ({ code, count: n }));
}
