// Issue #95 — product registration readiness classification for the whole CGI
// catalogue (4,575 rows), computed offline.
//
// This module does not join the source files again: buildMappingSet() from
// product-mapping.mjs is the join authority, and the two gates are the ones the
// transmittable payload builders already use (validateRow for the ecount
// 품목등록 column rules, buildRegisterBody for the 네이버 커머스API required
// fields). What is added here is only the *reason vocabulary*: a missing value
// must be reported with the reason it is missing, because "누락" that conflates
// "the supplier never publishes this" with "we never asked the customer" sends
// someone to the wrong owner.
//
// Nothing here invents a value. Absent stays absent and carries an owner. Every
// reason is emitted from a measured field, never from a constant, so a row that
// genuinely became complete would leave the bucket — the zeros in the report are
// derived, not hardcoded.

import { normalizeCgiId } from './product-mapping.mjs';
import { productRow, validateRow } from './erp-plan.mjs';
import { buildRegisterBody, NCOM_LIMITS } from './ncommerce.mjs';

/** Why a field is not fillable right now. `bucket` precedence follows this order. */
export const REASON_KINDS = [
  'data_defect',
  'requires_business_decision',
  'requires_content_authoring',
  'requires_live_read',
  'not_published_by_source',
  'requires_confirm',
  'usable',
];

const DEFECT = 'data_defect';
const DECISION = 'requires_business_decision';
const AUTHORING = 'requires_content_authoring';
const LIVE = 'requires_live_read';
const SOURCE = 'not_published_by_source';
const CONFIRM = 'requires_confirm';
const OK = 'usable';

const OWNER = {
  source: 'supplier public page',
  cgi: 'CGI (customer) operator',
  erp: 'ecount ERP read',
  naver: 'Naver 커머스API read',
  pipeline: 'our data pipeline',
};

/**
 * reason code -> field/kind/owner/meaning. A code may only be emitted here if the
 * classifier can point at the measured value that produced it.
 */
export const REASONS = {
  // 식별 / 표시
  product_name_present: { field: 'PROD_DES / name', kind: OK, owner: OWNER.source, meaning: '100자 이내 상품명 존재' },
  product_name_blank: { field: 'PROD_DES / name', kind: DEFECT, owner: OWNER.pipeline, meaning: '상품명 없음 — 등록 자체가 불가' },
  product_name_at_100_char_cap: { field: 'PROD_DES / name', kind: CONFIRM, owner: OWNER.cgi, meaning: '상품명이 벤더 100자 상한에 도달(절단 여부 확인 필요)' },
  brand_present: { field: 'brand', kind: OK, owner: OWNER.source, meaning: '브랜드 값 존재' },
  brand_blank: { field: 'brand', kind: SOURCE, owner: OWNER.source, meaning: '공급처 페이지에 브랜드 없음' },
  manufacturer_present: { field: '제조사', kind: OK, owner: OWNER.source, meaning: '제조사 값 존재' },
  manufacturer_blank_not_collected: { field: '제조사', kind: SOURCE, owner: OWNER.source, meaning: '제조사 미수집(특정 공급처 전량)' },
  model_present: { field: 'SIZE_DES / 모델명', kind: OK, owner: OWNER.source, meaning: '모델명 존재' },
  model_blank: { field: 'model', kind: SOURCE, owner: OWNER.source, meaning: '모델명 없음(검색·매핑·충돌 판정 근거 상실)' },
  model_shared_by_multiple_products: { field: 'model', kind: CONFIRM, owner: OWNER.cgi, meaning: '동일 모델명 표기를 다른 상품ID가 공유 — 변형(용량/세트) 구분 확인 필요' },
  model_shared_across_suppliers: { field: 'model', kind: DECISION, owner: OWNER.cgi, meaning: '서로 다른 공급처 사이트가 같은 모델명 표기 — 두 품목코드·두 네이버 상품이 됨' },

  // 가격 / 부가세
  price_public_ok: { field: 'salePrice / OUT_PRICE', kind: OK, owner: OWNER.source, meaning: '공개 판매가(부가세 10% 포함) 실측' },
  price_inquiry_only: { field: 'salePrice', kind: DECISION, owner: OWNER.cgi, meaning: '공급처 가격 문의 — CGI 판매가 확정 없이는 등록 불가' },
  price_sold_out_no_public_price: { field: 'salePrice', kind: DECISION, owner: OWNER.cgi, meaning: '품절/판매완료 표기, 공개 가격 없음' },
  price_absent_no_published_value: { field: 'salePrice', kind: SOURCE, owner: OWNER.source, meaning: '가격 텍스트 자체가 없음(예: 출시임박)' },
  price_numeric_but_inquiry_state: { field: 'salePrice', kind: CONFIRM, owner: OWNER.cgi, meaning: '숫자는 있으나 상태가 문의가(전화문의 병기) — 확정가로 쓰면 불가' },
  price_value_untrusted_parse_artifact: { field: 'salePrice', kind: DEFECT, owner: OWNER.pipeline, meaning: '가격 필드가 가격 문장이 아닌 텍스트에서 뽑힌 숫자(예: 2022년부터 제작 가능 -> 2022)' },
  price_over_naver_max: { field: 'salePrice', kind: DEFECT, owner: OWNER.pipeline, meaning: '네이버 판매가 상한 초과' },
  price_not_integer_won: { field: 'salePrice', kind: DEFECT, owner: OWNER.pipeline, meaning: '원 단위 정수가 아님' },
  vat_decomposition_inconsistent: { field: 'TAX / taxType', kind: DEFECT, owner: OWNER.pipeline, meaning: '공급가액+부가세가 부가세율로 재구성되지 않음' },

  // 재고
  stock_quantity_column_absent: { field: 'stockQuantity', kind: SOURCE, owner: OWNER.pipeline, meaning: '준비파일 재고수량 컬럼 공란' },
  stock_displayed_positive_unverified: { field: 'stockQuantity', kind: CONFIRM, owner: OWNER.erp, meaning: '공급처 페이지 표시 수량은 확정 수량이 아님 — ERP 재고조회만 근거' },
  stock_displayed_zero: { field: 'stockQuantity', kind: CONFIRM, owner: OWNER.erp, meaning: '표시 수량 0' },
  stock_displayed_but_supplier_unmanaged: { field: 'stockQuantity', kind: CONFIRM, owner: OWNER.erp, meaning: '공급처는 재고미관리(use_stock=false)인데 표시 수량이 있음 — ERP 수량이 결정권' },
  stock_displayed_absent: { field: 'stockQuantity', kind: SOURCE, owner: OWNER.source, meaning: '표시 수량 필드 없음' },
  availability_fields_absent: { field: 'availability', kind: DEFECT, owner: OWNER.pipeline, meaning: 'availability JSON 4개 키 모두 없음 — 판매·재고 상태 판정 근거 상실' },
  stock_requires_erp_balance_read: { field: 'stockQuantity', kind: LIVE, owner: OWNER.erp, meaning: 'GetListInventoryBalanceStatus -> BAL_QTY 읽어야 확정(본 lane 금지)' },

  // 이미지
  image_representative_present: { field: 'images.representative', kind: OK, owner: OWNER.source, meaning: '대표 이미지 URL 존재' },
  image_representative_blank: { field: 'images.representative', kind: DEFECT, owner: OWNER.pipeline, meaning: '대표 이미지 없음' },
  image_external_host_upload_required: { field: 'images', kind: LIVE, owner: OWNER.naver, meaning: '외부 호스트 링크는 거부됨 — POST /v1/product-images/upload 응답 URL만 사용 가능' },
  image_thumbnail_variant_only: { field: 'images', kind: CONFIRM, owner: OWNER.pipeline, meaning: 'URL이 /web/product/small/ 썸네일 변형 — 원본 크기 변형 URL 확인 필요' },
  image_extra_over_api_max: { field: 'images.additional', kind: DECISION, owner: OWNER.cgi, meaning: '추가 이미지 수가 9장 상한 초과 — 어떤 장면을 남길지 선택 필요' },
  image_detail_count_zero: { field: 'images.additional', kind: CONFIRM, owner: OWNER.cgi, meaning: '상세 이미지 0장(대표 이미지만)' },
  image_count_delta_not_one: { field: 'image_count', kind: DEFECT, owner: OWNER.pipeline, meaning: '마스터 image_count와 준비파일 상세이미지수 차이가 1이 아님' },

  // 상세설명
  detail_content_present: { field: 'detailContent', kind: OK, owner: OWNER.source, meaning: '상세페이지 본문 실측(HTML 마크업 또는 200자 이상 문단)' },
  detail_content_summary_only: { field: 'detailContent', kind: AUTHORING, owner: OWNER.cgi, meaning: '준비파일 상세설명은 한 줄 스펙 요약이지 네이버 상세페이지 본문 아님(마크업 없음·실측 상한 미만)' },
  detail_content_absent: { field: 'detailContent', kind: AUTHORING, owner: OWNER.cgi, meaning: '상세설명 없음' },

  // 카테고리
  supplier_category_present: { field: '카테고리', kind: OK, owner: OWNER.source, meaning: '공급처 카테고리ID/명 존재' },
  supplier_category_not_mapped_to_naver: { field: 'leafCategoryId', kind: DECISION, owner: OWNER.cgi, meaning: '공급처 카테고리->네이버 leaf 카테고리 대응표 없음(저장소에 네이버 카테고리 자료 0건)' },
  naver_leaf_category_absent: { field: 'leafCategoryId', kind: DECISION, owner: OWNER.cgi, meaning: '네이버 카테고리번호 미확정 — 임의 배정 금지' },
  naver_category_lookup_endpoint_not_implemented: { field: 'leafCategoryId', kind: LIVE, owner: OWNER.naver, meaning: '네이버 카테고리 조회 API가 PR #94 계약에 없음(인증 직전 범위 밖)' },

  // 정책류(스토어 단위 일괄 확정 가능)
  origin_code_absent: { field: '원산지', kind: DECISION, owner: OWNER.cgi, meaning: '원산지코드 미확보(저장소 전량 공란)' },
  kc_info_absent: { field: 'KC고시정보', kind: DECISION, owner: OWNER.cgi, meaning: 'KC 신고 정보 없음' },
  as_template_absent: { field: 'ASTemplateCode', kind: DECISION, owner: OWNER.cgi, meaning: 'AS 템플릿 코드 없음' },
  shipping_policy_absent: { field: 'deliveryInfo', kind: DECISION, owner: OWNER.cgi, meaning: '배송비/배송 방식 없음' },
  return_policy_absent: { field: 'returnsInfo', kind: DECISION, owner: OWNER.cgi, meaning: '반품·교환 정책 없음' },
  importer_absent: { field: '수입사', kind: DECISION, owner: OWNER.cgi, meaning: '수입사 정보 없음(통신판매 표시)' },

  // 옵션 / SKU
  option_rows_present: { field: 'detailAttribute.optionInfo', kind: OK, owner: OWNER.source, meaning: '옵션 실데이터 행 존재' },
  no_options_listed: { field: 'optionInfo', kind: OK, owner: OWNER.source, meaning: '단일 상품(옵션 없음)' },
  option_price_undifferentiated: { field: 'option price', kind: CONFIRM, owner: OWNER.cgi, meaning: '옵션별 추가가격 공란 — 동일 가격 여부 확인 필요' },
  option_item_code_absent: { field: 'option sellerCode', kind: CONFIRM, owner: OWNER.cgi, meaning: '옵션별 판매자 관리코드 없음 — 재고·주문 조인 불가' },
  option_count_columns_diverge: { field: '옵션수', kind: DEFECT, owner: OWNER.pipeline, meaning: '마스터 option_value_count와 준비파일 옵션수 불일치' },

  // ERP 매핑
  erp_wire_ok: { field: 'SaveBasicProduct', kind: OK, owner: OWNER.pipeline, meaning: '품목등록 행이 벤더 컬럼 규칙 통과' },
  erp_wire_invalid: { field: 'SaveBasicProduct', kind: DEFECT, owner: OWNER.pipeline, meaning: '필수 컬럼 누락 또는 길이 초과' },
  erp_code_proposed_only: { field: 'PROD_CD', kind: CONFIRM, owner: OWNER.erp, meaning: 'PROD_CD는 CGI측 생성안(SS-/SM-<공급처원본ID>), ERP 마스터 대조 미통과' },
  erp_master_snapshot_absent: { field: 'PROD_CD', kind: LIVE, owner: OWNER.erp, meaning: '이 저장소에 ERP 품목 마스터 스냅샷 없음(gitignore) — 대조 근거는 2026-10-23 집계뿐' },
  erp_candidate_pairs_not_persisted: { field: 'PROD_CD', kind: LIVE, owner: OWNER.erp, meaning: '이름/모델 후보 쌍이 compare_erp_cgi.py에서 파일로 저장된 적 없음 — 상품별 재현 불가, 실조회 필요' },
  erp_barcode_unique_kept: { field: 'BAR_CODE', kind: OK, owner: OWNER.pipeline, meaning: '카페24 품목코드가 전역 고유 — 바코드 컬럼 채택(12자)' },
  erp_barcode_dropped_duplicate: { field: 'BAR_CODE', kind: CONFIRM, owner: OWNER.pipeline, meaning: '코드 중복으로 바코드 컬럼 의도적 공란(벤더 고유·30자 제약)' },
  erp_barcode_absent: { field: 'BAR_CODE', kind: SOURCE, owner: OWNER.source, meaning: '원본 품목코드 자체가 없음' },
  erp_out_price_absent: { field: 'OUT_PRICE', kind: CONFIRM, owner: OWNER.cgi, meaning: '출고단가(공개판매가 연동) 없음 — 가격 미확정 상품' },

  // 네이버 상품 상태
  seller_code_present: { field: 'sellerManagementCode', kind: OK, owner: OWNER.pipeline, meaning: '판매자 관리코드(<site>:<id>) 존재' },
  seller_code_absent: { field: 'sellerManagementCode', kind: DEFECT, owner: OWNER.pipeline, meaning: '판매자 관리코드 없음 — 네이버 검색·재고 조인 키 상실' },
  naver_product_id_absent: { field: 'originProductNo', kind: OK, owner: OWNER.naver, meaning: '네이버상품ID 없음 — 신규 등록에서는 응답으로 발급되므로 등록 불가 사유 아님(수정·옵션재고 API의 경로 파라미터로만 필요)' },
  naver_product_id_present: { field: 'originProductNo', kind: OK, owner: OWNER.naver, meaning: '네이버상품ID 실측 — 수정·옵션재고 경로 확보' },
  naver_registered_status_absent: { field: 'statusType', kind: LIVE, owner: OWNER.naver, meaning: '등록상태 컬럼 공란 — 상품ID reads 없이 신규/수정 구분 불가' },
  naver_status_not_registered: { field: 'statusType', kind: OK, owner: OWNER.naver, meaning: '등록상태=미등록 실측 — 신규 등록 경로' },
  naver_item_already_registered: { field: 'statusType', kind: DECISION, owner: OWNER.cgi, meaning: '이미 등록·판매중 표기 — 신규 등록이 아니라 수정 대상, 중첩 게시 결정 필요' },
  cgi_sale_status_unapproved: { field: 'gate', kind: DECISION, owner: OWNER.cgi, meaning: 'cgi_sale_status=unapproved — CGI 판매 승인 목록 확정 전' },
  supplier_status_selling: { field: 'statusType', kind: OK, owner: OWNER.source, meaning: '공급처 판매중' },
  supplier_status_stock_unmanaged: { field: 'statusType', kind: CONFIRM, owner: OWNER.cgi, meaning: '공급처 재고미관리 표기 — 매입 가능 상태 확인 필요' },
  supplier_status_discontinued: { field: 'statusType', kind: DECISION, owner: OWNER.cgi, meaning: '공급처 품절(판매중지) — 판매 여부 자체가 판단 필요' },
  supplier_status_sold_out_completed: { field: 'statusType', kind: DECISION, owner: OWNER.cgi, meaning: '공급처 판매완료' },
  supplier_status_unconfirmed: { field: 'statusType', kind: CONFIRM, owner: OWNER.pipeline, meaning: '공급처 판매상태 미확인' },

  // 중복
  duplicate_pair_confirmed: { field: 'dedupe', kind: CONFIRM, owner: OWNER.cgi, meaning: '자동병합 가능 판정(변형 서명 일치)이나 조치가 검토 대기' },
  duplicate_pair_candidate: { field: 'dedupe', kind: CONFIRM, owner: OWNER.cgi, meaning: '후보 쌍 — 서명 유사, 미확정' },
  duplicate_pair_probable: { field: 'dedupe', kind: CONFIRM, owner: OWNER.cgi, meaning: '유력 쌍 — 미확정' },
  duplicate_pair_same_site_exact: { field: 'dedupe', kind: DEFECT, owner: OWNER.pipeline, meaning: '동일 공급처 내 완전 중복 — 그대로 등록하면 품목 2건·네이버 상품 2건' },
  duplicate_variant_conflict: { field: 'dedupe', kind: DECISION, owner: OWNER.cgi, meaning: '변형 서명 충돌 — 자동 병합 금지 대상' },
  duplicate_action_pending: { field: 'dedupe', kind: CONFIRM, owner: OWNER.cgi, meaning: '조치 컬럼 검토 대기 — 병합 적용 0건' },
  no_duplicate_pair: { field: 'dedupe', kind: OK, owner: OWNER.pipeline, meaning: '중복 후보 쌍 없음' },
};

const reason = (code) => REASONS[code] || { field: '?', kind: CONFIRM, owner: OWNER.pipeline, meaning: `unmapped code ${code}` };

const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const asInt = (v) => {
  const digits = String(v ?? '').replace(/[^\d-]/g, '');
  const n = Number(digits);
  return digits !== '' && digits !== '-' && Number.isFinite(n) ? n : null;
};
const moneyText = (v) => /^[\d,]+원$/.test(String(v ?? '').trim());
const modelKey = (v) => String(v || '').trim().toUpperCase();
const extensionOf = (url) => {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(url || '').trim());
  return match ? match[1].toLowerCase() : '';
};
const jsonOf = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** master row -> catalogue id, through the same alias table the join uses. */
export function cgiIdOfMaster(row) {
  return normalizeCgiId(`${row.source_site}:${row.source_product_id}`);
}

const SUPPLIER_STATUS_CODE = {
  판매중: 'supplier_status_selling',
  재고미관리: 'supplier_status_stock_unmanaged',
  '품절(판매중지)': 'supplier_status_discontinued',
  판매완료: 'supplier_status_sold_out_completed',
  미확인: 'supplier_status_unconfirmed',
};

const PRICE_STATE_CODE = {
  inquiry_price: 'price_inquiry_only',
  sold_out_sale_completed: 'price_sold_out_no_public_price',
  missing: 'price_absent_no_published_value',
};

const DUPLICATE_VERDICT_CODE = {
  confirmed: 'duplicate_pair_confirmed',
  candidate: 'duplicate_pair_candidate',
  probable: 'duplicate_pair_probable',
  same_site_exact: 'duplicate_pair_same_site_exact',
};

/** Policy columns that could be answered once for the whole store. */
export const STOREWIDE_POLICY_FIELDS = ['원산지코드', 'KC고시정보', 'ASTemplateCode', '배송비', '반품교환정책', '수입사'];

const POLICY_COLUMNS = [
  ['원산지코드', 'origin_code_absent'],
  ['KC고시정보', 'kc_info_absent'],
  ['ASTemplateCode', 'as_template_absent'],
  ['배송비', 'shipping_policy_absent'],
  ['반품교환정책', 'return_policy_absent'],
  ['수입사', 'importer_absent'],
];

/**
 * Blockers that are answered once for the whole store (or once per supplier
 * category) rather than per product. `bucket_if_policy_defaults` and the
 * storewide/product_specific split use this list, not the reason kind, because
 * a per-product decision — keep which 9 images, sell a 품절 item or not — must
 * not be counted as a store-wide policy question.
 */
export const STOREWIDE_DECISION_CODES = [
  ...POLICY_COLUMNS.map(([, code]) => code),
  'supplier_category_not_mapped_to_naver',
  'naver_leaf_category_absent',
  'naver_category_lookup_endpoint_not_implemented',
];

const isStorewide = (code) => STOREWIDE_DECISION_CODES.includes(code);

/**
 * The prep files carry a one-line spec summary, never a 상세페이지 본문. Measured
 * over all 4,575 rows the longest value is 187 characters and no value contains
 * markup, so anything that looks like a body (or clears 200 characters) is a
 * genuinely authored page — the rule is data-driven, not a constant blocker.
 */
const DETAIL_BODY_MIN_CHARS = 200;
function detailAssessment(prep) {
  const text = String(prep.상세설명 || '').trim();
  if (!text) return ['detail_content_absent'];
  if (/<(p|div|br|img|table|ul|ol|li|span|section)\b/i.test(text) || text.length >= DETAIL_BODY_MIN_CHARS) return ['detail_content_present'];
  return ['detail_content_summary_only'];
}

function priceAssessment(master, record) {
  const value = record.price.value;
  if (value == null) {
    const codes = [PRICE_STATE_CODE[master.public_price_state] || 'price_absent_no_published_value'];
    // The master column can hold the numeric prefix of a "362,000 전화문의"
    // string while the prep files correctly blanked the price. The row is not
    // registerable either way, but the two files disagree and that is its own
    // reason.
    if (value == null && asInt(master.public_price) != null) codes.push('price_numeric_but_inquiry_state');
    return codes;
  }
  if (!Number.isInteger(value)) return ['price_not_integer_won'];
  if (master.public_price_state !== 'public') return ['price_numeric_but_inquiry_state'];
  if (!moneyText(master.public_price_text)) return ['price_value_untrusted_parse_artifact'];
  if (value > NCOM_LIMITS.salePriceMax) return ['price_over_naver_max'];
  return ['price_public_ok'];
}

/**
 * A VAT-inclusive published price must decompose into 공급가액 + 부가세 at the
 * row's own tax rate. The check is on the ratio, never on `base + vat === price`
 * — that sum is tautological once vat is defined as the remainder.
 */
export function vatCheck(priceValue, taxRate = 10) {
  if (priceValue == null || !(Number(taxRate) >= 0)) return { ok: false, reason: 'price_not_integer_won' };
  const base = Math.round(priceValue / (1 + Number(taxRate) / 100));
  const vat = priceValue - base;
  if (base <= 0 || vat < 0) return { ok: false, reason: 'price_not_integer_won', base, vat };
  const ratio = vat / base;
  if (Math.abs(ratio - Number(taxRate) / 100) > 0.005) return { ok: false, reason: 'vat_decomposition_inconsistent', base, vat, ratio };
  return { ok: true, base, vat, ratio };
}

function stockAssessment(master, prep, record) {
  const codes = [];
  if (blank(prep.재고수량)) codes.push('stock_quantity_column_absent');
  if (record.stockQty != null) return codes;
  codes.push('stock_requires_erp_balance_read');
  const availability = jsonOf(master.availability);
  if (availability == null) return [...codes, 'availability_fields_absent'];
  if (Object.values(availability).every((value) => value === null)) return [...codes, 'availability_fields_absent'];
  const displayed = asInt(availability.stock_number_displayed);
  const managed = availability.use_stock === true;
  if (displayed == null) return [...codes, 'stock_displayed_absent'];
  if (displayed > 0) return [...codes, managed ? 'stock_displayed_positive_unverified' : 'stock_displayed_but_supplier_unmanaged'];
  return [...codes, managed ? 'stock_displayed_zero' : 'stock_displayed_but_supplier_unmanaged'];
}

/**
 * `imageLedger` holds the 네이버 upload URLs already obtained for a product. It is
 * empty in this lane because the upload is a live call, so every row keeps the
 * upload requirement — and a caller that has really uploaded can prove the row
 * moves out of it.
 */
function imageAssessment(master, prep, ledger) {
  const url = String(prep.대표이미지URL || '').trim();
  const codes = [];
  codes.push(url ? 'image_representative_present' : 'image_representative_blank');
  if (url && !ledger) {
    codes.push('image_external_host_upload_required');
    if (/\/web\/product\/small\//.test(url)) codes.push('image_thumbnail_variant_only');
  }
  const total = asInt(master.image_count) ?? 0;
  if (total - 1 > NCOM_LIMITS.extraImagesMax) codes.push('image_extra_over_api_max');
  const detail = asInt(prep.상세이미지수) ?? 0;
  if (detail === 0) codes.push('image_detail_count_zero');
  if (total - detail !== 1) codes.push('image_count_delta_not_one');
  return codes;
}

function optionAssessment(cgiId, optionRowsByProduct, master, prep) {
  const rows = optionRowsByProduct.get(cgiId) || [];
  const codes = [];
  if (!rows.length) codes.push('no_options_listed');
  else {
    codes.push('option_rows_present');
    if (rows.some((r) => blank(r.option_price))) codes.push('option_price_undifferentiated');
    if (rows.some((r) => blank(r.option_item_code))) codes.push('option_item_code_absent');
  }
  if ((asInt(master.option_value_count) ?? 0) !== (asInt(prep.옵션수) ?? 0)) codes.push('option_count_columns_diverge');
  return codes;
}

const BLOCKED_CODES = ['product_name_blank', 'image_representative_blank', 'erp_wire_invalid'];

function bucketOf(codes) {
  if (codes.some((c) => BLOCKED_CODES.includes(c))) return 'blocked';
  const kinds = new Set(codes.map((c) => reason(c).kind));
  if (kinds.has(DEFECT) || kinds.has(DECISION)) return 'manual_review';
  return codes.every((c) => reason(c).kind === OK) ? 'ready' : 'supplement';
}

/** Same bucket, after the one-off store-wide policy and category decisions exist. */
function bucketWithoutPolicyDecisions(codes) {
  return bucketOf(codes.filter((code) => !isStorewide(code)));
}

const groupBy = (rows, keyOf) => {
  const out = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(row);
  }
  return out;
};

/**
 * One row per catalogue product. `gaps` is every reason code that applies
 * (measured-good facts included, so the per-row code count is auditable);
 * `missing` is the subset whose kind is not `usable`.
 */
export function classifyCatalog({ masterRows = [], extendedRows = [], smartstoreRows = [], optionRows = [], duplicateRows = [], records = [], comparison = {}, summary = {}, imageLedger = new Map() } = {}) {
  const masterByKey = new Map(masterRows.map((row) => [cgiIdOfMaster(row), row]));
  const prepByKey = new Map(smartstoreRows.map((row) => [normalizeCgiId(row.공급처원본ID || row.sourceId), row]));
  const extendedByKey = new Map(extendedRows.map((row) => [normalizeCgiId(row.공급처원본ID || row.sourceId), row]));
  const optionRowsByProduct = groupBy(optionRows, (row) => normalizeCgiId(`${row.source_site}:${row.source_product_id}`));
  const pairsByProduct = new Map();
  const addPair = (cgiId, pair) => {
    if (!pairsByProduct.has(cgiId)) pairsByProduct.set(cgiId, []);
    pairsByProduct.get(cgiId).push(pair);
  };
  for (const pair of duplicateRows) {
    addPair(normalizeCgiId(pair.왼쪽통합키), pair);
    addPair(normalizeCgiId(pair.오른쪽통합키), pair);
  }
  const modelCount = new Map();
  const modelSites = new Map();
  for (const row of masterRows) {
    const key = modelKey(row.model);
    if (!key) continue;
    modelCount.set(key, (modelCount.get(key) || 0) + 1);
    if (!modelSites.has(key)) modelSites.set(key, new Set());
    modelSites.get(key).add(row.source_site);
  }

  const rows = [];
  for (const record of records) {
    const cgiId = record.cgiId;
    const master = masterByKey.get(cgiId) || {};
    const prep = prepByKey.get(cgiId) || {};
    const extended = extendedByKey.get(cgiId) || {};
    const options = optionRowsByProduct.get(cgiId) || [];
    const pairs = pairsByProduct.get(cgiId) || [];
    const uploaded = imageLedger.get(cgiId);

    const erpRow = productRow({
      productId: record.erpProdCdProposed,
      productName: record.prodDes,
      unit: record.unit,
      prodType: record.prodType,
      barCode: record.barCode,
      taxRate: record.taxRate,
      outPrice: record.outPrice,
    });
    const wireProblems = validateRow('saveBasicProduct', erpRow);
    const priceCodes = priceAssessment(master, record);
    const vat = vatCheck(record.price.value, record.taxRate);
    const availability = jsonOf(master.availability) || {};
    const naver = buildRegisterBody(
      { prodDes: record.prodDes, price: record.price, stockQuantity: record.stockQty, sellerManagementCode: record.sellerManagementCode },
      {
        leafCategoryId: record.naverCategoryNo || '',
        detailContent: String(prep.상세설명 || ''),
        images: {
          representative: uploaded?.representative || '',
          additional: uploaded?.additional || [],
          // The ledger only ever gets an entry from a successful
          // POST /v1/product-images/upload response, so its presence is the
          // proof the API requires — an external URL never sets this.
          uploadedViaImageApi: Boolean(uploaded?.representative),
        },
      },
    );

    const gaps = [];
    const pushed = new Set();
    const push = (code, evidence = '') => {
      if (pushed.has(code)) return;
      pushed.add(code);
      const meta = reason(code);
      gaps.push({ code, field: meta.field, kind: meta.kind, owner: meta.owner, evidence: String(evidence) });
    };

    push(blank(record.prodDes) ? 'product_name_blank' : record.prodDes.length === 100 ? 'product_name_at_100_char_cap' : 'product_name_present', `${record.prodDes.length}자`);
    push(blank(master.brand) ? 'brand_blank' : 'brand_present', master.brand);
    push(blank(master.manufacturer) ? 'manufacturer_blank_not_collected' : 'manufacturer_present', master.manufacturer);
    push(blank(master.model) ? 'model_blank' : 'model_present', master.model);
    const shared = modelCount.get(modelKey(master.model)) || 0;
    if (shared > 1) {
      push('model_shared_by_multiple_products', `${shared}건 공유`);
      if ((modelSites.get(modelKey(master.model))?.size || 0) > 1) push('model_shared_across_suppliers', `${modelSites.get(modelKey(master.model)).size}개 공급처`);
    }
    for (const code of priceCodes) push(code, `${master.public_price_text || ''}|${record.price.value ?? ''}`);
    if (record.price.value != null && !vat.ok) push(vat.reason, `price=${record.price.value} rate=${record.taxRate}`);
    for (const code of stockAssessment(master, prep, record)) push(code, master.availability || '');
    for (const code of imageAssessment(master, prep, uploaded)) push(code, prep.대표이미지URL || '');
    for (const code of detailAssessment(prep)) push(code, String(prep.상세설명 || '').length);
    push(blank(master.category_id) ? 'supplier_category_not_mapped_to_naver' : 'supplier_category_present', `${master.category_id}|${master.category_name}`);
    if (blank(record.naverCategoryNo)) {
      push('supplier_category_not_mapped_to_naver', master.category_name);
      push('naver_leaf_category_absent', '');
      push('naver_category_lookup_endpoint_not_implemented', '');
    }
    for (const [column, code] of POLICY_COLUMNS) if (blank(prep[column])) push(code, '');
    for (const code of optionAssessment(cgiId, optionRowsByProduct, master, prep)) push(code, options.length ? `${options.length}행` : '');
    push(wireProblems.length ? 'erp_wire_invalid' : 'erp_wire_ok', wireProblems.map((p) => `${p.field}:${p.reason}`).join(','));
    if (!record.erpProdCdVerified) {
      push('erp_code_proposed_only', record.erpProdCdProposed);
      push('erp_master_snapshot_absent', `erp_total_items=${comparison.erp_total_items ?? ''}`);
      if ((comparison.candidate_pairs ?? 0) > 0) push('erp_candidate_pairs_not_persisted', `candidate_pairs=${comparison.candidate_pairs}`);
    }
    const cafe24Code = String(extended.cafe24ItemCd || '').trim();
    push(blank(record.barCode) ? (cafe24Code ? 'erp_barcode_dropped_duplicate' : 'erp_barcode_absent') : 'erp_barcode_unique_kept', record.barCode || cafe24Code);
    if (record.outPrice == null) push('erp_out_price_absent', '');
    push(blank(record.sellerManagementCode) ? 'seller_code_absent' : 'seller_code_present', record.sellerManagementCode);
    push(blank(record.naverItemId) ? 'naver_product_id_absent' : 'naver_product_id_present', record.naverItemId || '');
    const regStatus = String(record.naverRegStatus || '').trim();
    push(!regStatus ? 'naver_registered_status_absent' : regStatus === '미등록' ? 'naver_status_not_registered' : 'naver_item_already_registered', regStatus);
    if (master.cgi_sale_status === 'unapproved') push('cgi_sale_status_unapproved', master.cgi_sale_status);
    push(SUPPLIER_STATUS_CODE[master.sales_status] || 'supplier_status_unconfirmed', master.sales_status || '');
    if (!pairs.length) push('no_duplicate_pair', '');
    for (const pair of pairs) {
      const verdict = DUPLICATE_VERDICT_CODE[pair.판정];
      if (verdict) push(verdict, `${pair.왼쪽통합키}<->${pair.오른쪽통합키}`);
      if (pair.변형충돌 === '예') push('duplicate_variant_conflict', pair.공통모델표현 || '');
      if (pair.조치 === '검토 대기') push('duplicate_action_pending', pair.조치);
    }

    const codes = gaps.map((g) => g.code);
    const missing = gaps.filter((g) => g.kind !== OK);
    const missingCodes = missing.map((g) => g.code);
    const policyCodes = missingCodes.filter(isStorewide);
    rows.push({
      cgi_id: cgiId,
      source_site: master.source_site || cgiId.split(':')[0],
      source_product_id: master.source_product_id || cgiId.split(':').slice(1).join(':'),
      master_product_key: master.master_product_key || '',
      product_name: record.prodDes,
      brand: master.brand || '',
      manufacturer: master.manufacturer || '',
      model: master.model || '',
      supplier_category_id: master.category_id || '',
      supplier_category_name: master.category_name || '',
      supplier_category_path: extended.categoryPath || prep.카테고리경로_CGI || '',
      public_price_state: master.public_price_state || '',
      public_price_text: master.public_price_text || '',
      sale_price: record.price.value ?? '',
      price_usable: codes.includes('price_public_ok') ? 'yes' : 'no',
      vat_rate_percent: record.taxRate,
      vat_base: vat.ok ? vat.base : '',
      vat_amount: vat.ok ? vat.vat : '',
      erp_out_price: record.outPrice ?? '',
      out_price_matches_sale_price: record.outPrice != null && record.outPrice === record.price.value ? 'yes' : record.outPrice == null && record.price.value == null ? 'both_blank' : 'no',
      supplier_sales_status: master.sales_status || '',
      supplier_use_stock: String(availability.use_stock ?? ''),
      stock_displayed: String(availability.stock_number_displayed ?? ''),
      stock_quantity_confirmed: record.stockQty != null ? 'yes' : 'no',
      image_count_master: master.image_count || '',
      detail_image_count_prep: prep.상세이미지수 || '',
      representative_image_url: prep.대표이미지URL || '',
      image_extension: extensionOf(prep.대표이미지URL),
      naver_uploaded_image: uploaded?.representative || '',
      detail_content_chars: String(prep.상세설명 || '').length,
      option_value_count_master: master.option_value_count || '',
      option_count_prep: prep.옵션수 || '',
      option_rows: options.length,
      option_rows_missing_price: options.filter((r) => blank(r.option_price)).length,
      option_rows_missing_item_code: options.filter((r) => blank(r.option_item_code)).length,
      erp_prod_cd_proposed: record.erpProdCdProposed,
      erp_code_source: record.erpProdCdSource,
      erp_master_match: record.erpProdCdVerified ? 'yes' : 'no',
      erp_register_required: record.erpProdCdVerified ? 'no' : 'yes',
      erp_wire_validation: wireProblems.length ? `invalid:${wireProblems.map((p) => p.field).join('|')}` : 'ok',
      erp_dedupe_key: `saveBasicProduct:PROD_CD:${record.erpProdCdProposed}`,
      erp_bal_flag: record.balFlag,
      erp_barcode: record.barCode || '',
      erp_size_des: record.sizeDes || '',
      erp_unit: record.unit,
      erp_prod_type: record.prodType,
      naver_leaf_category_id: record.naverCategoryNo || '',
      naver_product_id: record.naverItemId || '',
      naver_registration_status: regStatus,
      naver_seller_management_code: record.sellerManagementCode || '',
      naver_sale_price: naver.body.originProduct.salePrice ?? '',
      naver_stock_quantity: naver.body.originProduct.stockQuantity ?? '',
      naver_register_problems: naver.problems.map((p) => `${p.field}:${p.reason}`).join(';'),
      duplicate_pair_count: pairs.length,
      duplicate_verdicts: [...new Set(pairs.map((p) => p.판정))].join('|'),
      duplicate_variant_conflict: pairs.some((p) => p.변형충돌 === '예') ? 'yes' : 'no',
      cgi_sale_status: master.cgi_sale_status || '',
      gap_count: codes.length,
      missing_count: missing.length,
      gap_codes: codes.join(';'),
      missing_codes: missingCodes.join(';'),
      blocker_codes_product_specific: missingCodes.filter((code) => !isStorewide(code)).join(';'),
      blocker_codes_storewide_policy: policyCodes.join(';'),
      bucket: bucketOf(codes),
      bucket_if_policy_defaults: bucketWithoutPolicyDecisions(codes),
      join_complete: record.joins.extended && record.joins.upload && record.joins.smartstore && !blank(master.source_product_id) ? 'yes' : 'no',
    });
  }
  rows.sort((a, b) => (a.cgi_id < b.cgi_id ? -1 : a.cgi_id > b.cgi_id ? 1 : 0));
  return { rows };
}

/** Long-format missing table: one row per (product, non-usable reason code). */
export function missingEntries(rows) {
  const out = [];
  for (const row of rows) {
    if (!row.missing_codes) continue;
    for (const code of row.missing_codes.split(';')) {
      if (!code) continue;
      const meta = reason(code);
      out.push({
        cgi_id: row.cgi_id,
        source_site: row.source_site,
        product_name: row.product_name,
        field: meta.field,
        reason_code: code,
        kind: meta.kind,
        owner: meta.owner,
        meaning: meta.meaning,
        bucket: row.bucket,
        scope: isStorewide(code) ? 'storewide_policy' : 'product_specific',
      });
    }
  }
  return out;
}

function tally(values) {
  const out = {};
  for (const value of values) out[value] = (out[value] || 0) + 1;
  return out;
}

export function summarizeClassification({ rows = [], missing = [], inputs = {}, comparison = {}, summary = {} }) {
  const counts = (key) => tally(rows.map((row) => row[key]));
  const usablePrice = rows.filter((row) => row.price_usable === 'yes').length;
  return {
    scope: 'offline classification only — no ERP login, no Naver call, no write',
    inputs: { master_rows: inputs.masterRows ?? null, mapping_records: inputs.records ?? null, option_rows: inputs.optionRows ?? null, duplicate_pairs: inputs.duplicateRows ?? null },
    products_classified: rows.length,
    products_with_full_join: rows.filter((row) => row.join_complete === 'yes').length,
    conservation: {
      records_in: inputs.records ?? rows.length,
      rows_out: rows.length,
      input_equals_output: (inputs.records ?? rows.length) === rows.length,
      buckets_sum: Object.values(tally(rows.map((r) => r.bucket))).reduce((a, b) => a + b, 0),
    },
    buckets: counts('bucket'),
    buckets_if_policy_defaults: counts('bucket_if_policy_defaults'),
    by_supplier_status: counts('supplier_sales_status'),
    by_price_state: counts('public_price_state'),
    price: {
      usable_count: usablePrice,
      unusable_codes: tally(rows.filter((r) => r.price_usable === 'no').flatMap((r) => (r.missing_codes || '').split(';').filter((c) => c.startsWith('price_')))),
      max_sale_price: rows.reduce((m, r) => (r.sale_price === '' ? m : Math.max(m, Number(r.sale_price))), 0),
    },
    vat: {
      rows_with_public_price: rows.filter((r) => r.sale_price !== '').length,
      rows_decomposed: rows.filter((r) => r.vat_base !== '').length,
      decomposition_failed: rows.filter((r) => r.sale_price !== '' && r.vat_base === '').length,
      out_price_equals_sale_price: rows.filter((r) => r.out_price_matches_sale_price === 'yes').length,
      out_price_blank_with_blank_price: rows.filter((r) => r.out_price_matches_sale_price === 'both_blank').length,
      out_price_conflicts_sale_price: rows.filter((r) => r.out_price_matches_sale_price === 'no').length,
    },
    stock: {
      numeric_confirmed: rows.filter((r) => r.stock_quantity_confirmed === 'yes').length,
      displayed_positive: rows.filter((r) => Number(r.stock_displayed) > 0).length,
      displayed_blank: rows.filter((r) => r.stock_displayed === '').length,
    },
    images: {
      representative_present: rows.filter((r) => r.representative_image_url).length,
      by_extension: counts('image_extension'),
      upload_required: rows.filter((r) => r.gap_codes.includes('image_external_host_upload_required')).length,
      thumbnail_variant: rows.filter((r) => r.gap_codes.includes('image_thumbnail_variant_only')).length,
      over_extra_limit: rows.filter((r) => r.gap_codes.includes('image_extra_over_api_max')).length,
      detail_zero: rows.filter((r) => r.gap_codes.includes('image_detail_count_zero')).length,
    },
    detail_content: {
      present: rows.filter((r) => r.detail_content_chars > 0).length,
      absent: rows.filter((r) => r.detail_content_chars === 0).length,
      summary_only: rows.filter((r) => r.gap_codes.includes('detail_content_summary_only')).length,
      authored_body: rows.filter((r) => r.gap_codes.includes('detail_content_present')).length,
      max_chars: rows.reduce((m, r) => Math.max(m, r.detail_content_chars), 0),
      judged_at_or_above_chars: DETAIL_BODY_MIN_CHARS,
    },
    blockers_by_scope: {
      storewide_policy: tally(rows.flatMap((r) => (r.blocker_codes_storewide_policy ? r.blocker_codes_storewide_policy.split(';') : []))),
      product_specific: tally(rows.flatMap((r) => (r.blocker_codes_product_specific ? r.blocker_codes_product_specific.split(';') : []))),
    },
    category: {
      supplier_categories_distinct: new Set(rows.map((r) => r.supplier_category_id).filter(Boolean)).size,
      naver_leaf_category_present: rows.filter((r) => r.naver_leaf_category_id).length,
    },
    options: {
      products_with_option_rows: rows.filter((r) => r.option_rows > 0).length,
      option_rows_total: rows.reduce((sum, r) => sum + r.option_rows, 0),
      rows_missing_price: rows.reduce((sum, r) => sum + r.option_rows_missing_price, 0),
      rows_missing_item_code: rows.reduce((sum, r) => sum + r.option_rows_missing_item_code, 0),
      count_columns_diverge: rows.filter((r) => r.gap_codes.includes('option_count_columns_diverge')).length,
    },
    erp: {
      wire_ok: rows.filter((r) => r.erp_wire_validation === 'ok').length,
      wire_invalid: rows.filter((r) => r.erp_wire_validation !== 'ok').length,
      register_required: rows.filter((r) => r.erp_register_required === 'yes').length,
      master_matches: rows.filter((r) => r.erp_master_match === 'yes').length,
      unique_dedupe_keys: new Set(rows.map((r) => r.erp_dedupe_key)).size,
      barcode_kept: rows.filter((r) => r.erp_barcode).length,
      candidate_pairs_aggregate: comparison.candidate_pairs ?? null,
      name_exact_pairs_aggregate: comparison.name_exact_pairs ?? null,
      model_exact_pairs_aggregate: comparison.model_exact_pairs ?? null,
      published_unique_item_codes: summary.unique_item_codes ?? null,
      published_duplicate_codes: summary.duplicate_codes ?? null,
    },
    naver: {
      registerable_now: rows.filter((r) => r.naver_register_problems === '').length,
      register_problems_by_field: tally(rows.flatMap((r) => (r.naver_register_problems ? r.naver_register_problems.split(';') : [])).map((p) => p.split(':')[0])),
      product_id_present: rows.filter((r) => r.naver_product_id).length,
      registration_status_counts: counts('naver_registration_status'),
      seller_code_present: rows.filter((r) => r.naver_seller_management_code).length,
    },
    duplicates: {
      products_in_a_pair: rows.filter((r) => r.duplicate_pair_count > 0).length,
      pair_references_from_both_sides: rows.reduce((sum, r) => sum + r.duplicate_pair_count, 0),
      pairs_in_source_file: inputs.duplicateRows ?? null,
      by_verdict: tally(rows.filter((r) => r.duplicate_verdicts).flatMap((r) => r.duplicate_verdicts.split('|'))),
      variant_conflict_products: rows.filter((r) => r.duplicate_variant_conflict === 'yes').length,
    },
    reason_codes: tally(missing.map((m) => m.reason_code)),
    reason_kinds: tally(missing.map((m) => m.kind)),
    owners: tally(missing.map((m) => m.owner)),
    missing_entries: missing.length,
  };
}

/** RFC-4180 writer with a BOM: these files carry Korean names with commas and quotes. */
export function toCsv(rows, columns) {
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const body = rows.map((row) => columns.map((column) => escape(row[column])).join(','));
  return `\uFEFF${[columns.join(','), ...body].join('\r\n')}\r\n`;
}
