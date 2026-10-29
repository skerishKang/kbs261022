// M2 사전개발 — 두 분석을 한 곳에 모은 순수 모듈 (fs 없음, 네트워크 없음).
//
//  1) 등록 필수 필드(원산지·배송·반품·AS·KC·재고)의 누락 원인을 '데이터 출처'로 분류한다.
//     분류의 근거는 준비도 사유 표(lib/registration-readiness.mjs 의 owner/kind)와 준비파일의
//     실제 열 구조다. 새로운 판정을 만들지 않는다 — 이미 분류된 gap_codes 를 출처별로
//     다시 묶을 뿐이다.
//  2) ERP BAL_QTY 와 상품별 판매가능 재고의 대응 관계를 서술한다. 변환 구현은
//     lib/ncommerce.mjs 의 stockFromErpBalance 가 유일한 권위이며 이 모듈은 재구현하지
//     않는다 — 규칙을 서술하고, 테스트가 서술과 구현의 일치를 고정한다.
//
// 파일 IO 와 4,575건 조립은 tools/m2-predev-report.mjs 가 담당한다.

import { NCOM_LIMITS, stockFromErpBalance } from './ncommerce.mjs';
import { M1_FIELD_REASONS } from './m1-readiness.mjs';

/** 누락 사유 → 출처 클래스. source_class 는 아래 넷으로 제한한다. */
export const M2_SOURCE_CLASSES = {
  prep_column_blank: '준비파일에 열은 있으나 값이 비어 있다 — 상품별 판단이 아니라 운영 정책 확정이 선행이다',
  category_dependent: '네이버 리프 카테고리의 메타데이터(certificationInfos 등) 코퍼스를 받아야만 판정할 수 있다',
  erp_read_pending: 'Ecount 잔량조회(BAL_QTY) 실측만 남아 있다 — 운영자 인증이 필요한 LIVE 단계다',
  pipeline_defect: '우리 파이프라인 결함 — 발견되면 레인을 고치고 재계산한다',
};

/** 준비도 사유 코드별 출처 분류. 준비 파일의 열 이름은 smartstore_registration_prep.csv 기준. */
export const M2_FIELD_GAP_SOURCES = {
  origin_code_absent: {
    field: 'origin', label: '원산지',
    source_class: 'prep_column_blank', column: '원산지코드',
    register_field: 'originProduct.detailAttribute.originAreaInfo.originAreaCode',
    resolution: '운영 정책 확정(제조국/수입 원산지) 후 준비파일 열을 채운다 — 상품별 수집이 아니라 전면 정책 하나다',
  },
  kc_info_absent: {
    field: 'as_kc', label: 'KC·인증',
    source_class: 'category_dependent', column: 'KC고시정보',
    register_field: 'originProduct.detailAttribute.certificationInfos (+ 리프 certificationInfos 요구 확인)',
    resolution: '카테고리 코퍼스 수집 후 리프별 인증 요구를 확인하고, 요구되는 리프만 운영 확정으로 채운다',
  },
  as_template_absent: {
    field: 'as_kc', label: 'AS',
    source_class: 'prep_column_blank', column: 'ASTemplateCode',
    register_field: 'originProduct.detailAttribute.afterServiceInfo',
    resolution: '스토어 대표 AS 안내(전화번호·안내 문구)를 운영 확정으로 하나 만들어 전 상품에 적용한다',
  },
  shipping_policy_absent: {
    field: 'delivery_returns', label: '배송',
    source_class: 'prep_column_blank', column: '배송비',
    register_field: 'smartstoreChannelProduct.deliveryInfo.deliveryFee',
    resolution: '배송비·배송 방식 정책을 운영 확정으로 하나 만들어 전 상품에 적용한다',
  },
  return_policy_absent: {
    field: 'delivery_returns', label: '반품·교환',
    source_class: 'prep_column_blank', column: '반품교환정책',
    register_field: 'smartstoreChannelProduct.claimDeliveryInfo',
    resolution: '반품·교환 배송비(편도/전액) 정책을 운영 확정으로 채운다',
  },
  stock_requires_erp_balance_read: {
    field: 'stock', label: '재고',
    source_class: 'erp_read_pending', column: '재고수량(공급처 표시 수량은 근거 아님)',
    register_field: 'originProduct.stockQuantity (옵션 관리형은 option-stock)',
    resolution: 'Ecount GetListInventoryBalanceStatus BAL_QTY 조회 후 stockFromErpBalance 로 변환한다',
  },
  stock_quantity_column_absent: {
    field: 'stock', label: '재고',
    source_class: 'prep_column_blank', column: '재고수량',
    register_field: 'originProduct.stockQuantity',
    resolution: '준비파일 재고 열이 공란 — ERP 잔량조회가 유일한 수량 출처이다',
  },
  stock_displayed_positive_unverified: {
    field: 'stock', label: '재고',
    source_class: 'erp_read_pending', column: '재고수량(표시 값)',
    register_field: 'originProduct.stockQuantity',
    resolution: '공급처 표시 수량은 참고용 — ERP 잔량으로 확정하기 전까지 등록 수량이 될 수 없다',
  },
  stock_displayed_zero: {
    field: 'stock', label: '재고',
    source_class: 'erp_read_pending', column: '재고수량(표시 0)',
    register_field: 'originProduct.stockQuantity',
    resolution: '표시 0 도 ERP 잔량으로만 확정한다 — 품절 판정은 운영 확인 후',
  },
  stock_displayed_but_supplier_unmanaged: {
    field: 'stock', label: '재고',
    source_class: 'erp_read_pending', column: '재고수량(미관리 표시)',
    register_field: 'originProduct.stockQuantity',
    resolution: '공급처 재고미관리(use_stock=false) 표기 — ERP 수량이 결정권을 가진다',
  },
  availability_fields_absent: {
    field: 'stock', label: '재고',
    source_class: 'pipeline_defect', column: 'availability JSON',
    register_field: '(판정 근거)',
    resolution: '수집 파이프라인 결함 — availability 4키 복원 후 재계산한다',
  },
};

/**
 * 분석 대상 필드(기본: M2 의 원산지·배송·AS/KC·재고). 범위 밖 사유(가격·이미지·중복 등)는
 * M1 준비도 리포트의 몫이므로 여기서 세지 않는다 — 잔여는 '범위 안인데 분류 표에 없는
 * 사유'만 남긴다. 범위 안 코드 집합은 M1_FIELD_REASONS 에서 유도한다(이중 정의 금지).
 */
export const M2_ANALYSIS_FIELDS = ['origin', 'delivery_returns', 'as_kc', 'stock'];

const inScopeCodes = (fields) => new Set(fields.flatMap((field) => M1_FIELD_REASONS[field]?.blocked || []));

/**
 * 분류된 준비도 행(gap_codes ; 구분)을 출처별로 묶는다. 분석 범위 안에서 선언되지 않은
 * 사유는 __residual 로 남겨 조용히 묻히지 않는다. 반환값의 모든 합계는 blocked 합계와
 * 일치해야 한다(테스트가 보존을 검증).
 */
export function classifyFieldGapsBySource(rows = [], { declared = M2_FIELD_GAP_SOURCES, columns = [], fields = M2_ANALYSIS_FIELDS } = {}) {
  const scope = inScopeCodes(fields);
  const fields2 = {};
  const residuals = {};
  for (const row of rows) {
    const codes = new Set(String(row.gap_codes || '').split(';').filter(Boolean));
    for (const code of codes) {
      if (!scope.has(code)) continue;
      const meta = declared[code];
      if (!meta) { residuals[code] = (residuals[code] || 0) + 1; continue; }
      const bucket = (fields2[meta.field] ||= { blocked: 0, source_counts: {}, reasons: {} });
      bucket.blocked += 1;
      bucket.source_counts[meta.source_class] = (bucket.source_counts[meta.source_class] || 0) + 1;
      const reason = (bucket.reasons[code] ||= { count: 0, source_class: meta.source_class, column: meta.column, register_field: meta.register_field, resolution: meta.resolution });
      reason.count += 1;
    }
  }
  for (const bucket of Object.values(fields2)) {
    bucket.source_classes_total = Object.values(bucket.source_counts).reduce((sum, n) => sum + n, 0);
  }
  const columns_present = {};
  for (const [column, count] of Object.entries(columns)) columns_present[column] = count;
  return {
    fields: fields2,
    analyzed_fields: [...fields],
    undeclared_reasons: residuals,
    undeclared_total: Object.values(residuals).reduce((sum, n) => sum + n, 0),
    source_classes: M2_SOURCE_CLASSES,
    measured_columns: columns_present,
  };
}

/** BAL_QTY → Naver 재고 변환 규칙. 구현 권위는 stockFromErpBalance (lib/ncommerce.mjs). */
export const M2_STOCK_RULES = {
  authority: 'lib/ncommerce.mjs stockFromErpBalance — 이 모듈은 규칙을 서술할 뿐 재구현하지 않는다',
  bal_qty_source: 'Ecount OAPI GetListInventoryBalanceStatus (minIntervalMs 600000 — 10분 제한)',
  bal_qty_format: 'decimal 문자열(예: "3.0000000000") → Number 로 해석하고 Math.floor 로만 내린다(올림 금지)',
  join_key: '품목코드(PROD_CD) ↔ data/erp_prep/erp_extended_mapping.csv 품목코드 ↔ 공급처원본ID',
  negative_balance: '음수 잔량은 실재 상태다 — Naver 음수 재고로 보내지 않고 OUTOFSTOCK/usable=false 로 표현한다',
  bounds: { stockQuantityMax: NCOM_LIMITS.stockQuantityMax },
  option_managed: 'optionManaged=true → PUT /v1/products/origin-products/{no}/option-stock, 아니면 PUT /v2/products/origin-products/{no}',
  rejection_reasons: ['unreadable_BAL_QTY', 'unmapped_prod_cd', 'no_naver_channel_product', 'negative_balance', 'out_of_bounds'],
  unconfirmed: [
    '창고/지점별 BAL_QTY 분배 규칙 (ByLocation 조회가 필요한지)',
    '소수점 잔량의 의미 (부분 박스 등) — floor 규칙의 안전성은 운영 확인 전까지 가정',
    '옵션 SKU(카페24품목코드) ↔ optionCombinations 매핑 규칙',
    'BAL_QTY 조회 시점과 등록/수정 시점 사이 재고 변동 허용 오차',
  ],
};

/**
 * 커밋된 ERP 준비 파일 두 개로 잰 대응 관계 실측. 어떤 수치도 추정이 아니라
 * 행 셀에서 센 값이다. 재고 수치 자체는 이 레인에 없다(라이브 조회 필요) —
 * 있을 수 있는 것은 '키 대응 구조'뿐이고, 그 구조를 잰다.
 */
export function stockCorrespondence({ mappingRows = [], uploadRows = [] } = {}) {
  const tally = (values) => values.reduce((out, value) => { out[value] = (out[value] || 0) + 1; return out; }, {});
  const nonBlank = (row, key) => String(row[key] ?? '').trim() !== '';

  const mappingCodes = new Set(mappingRows.map((row) => String(row['품목코드'] ?? '').trim()).filter(Boolean));
  const uploadCodes = new Set(uploadRows.map((row) => String(row['품목코드'] ?? '').trim()).filter(Boolean));
  const both = [...mappingCodes].filter((code) => uploadCodes.has(code));

  return {
    mapping: {
      rows: mappingRows.length,
      prod_cd_non_blank: mappingRows.filter((row) => nonBlank(row, '품목코드')).length,
      prod_cd_distinct: mappingCodes.size,
      prod_cd_prefixes: tally(mappingRows.map((row) => (String(row['품목코드'] ?? '').match(/^[A-Z]{2}/) || ['(none)'])[0])),
      cafe24_item_code_non_blank: mappingRows.filter((row) => nonBlank(row, '카페24품목코드')).length,
      supplier_id_non_blank: mappingRows.filter((row) => nonBlank(row, '공급처원본ID')).length,
      origin_column_non_blank: mappingRows.filter((row) => nonBlank(row, '원산지_cont5')).length,
    },
    upload: {
      rows: uploadRows.length,
      stock_management_flag: tally(uploadRows.map((row) => String(row['재고수량관리'] ?? '').trim() || '(blank)')),
      set_flag: tally(uploadRows.map((row) => String(row['세트여부'] ?? '').trim() || '(blank)')),
      prod_cd_distinct: uploadCodes.size,
    },
    join: {
      prod_cd_in_both: both.length,
      only_in_mapping: [...mappingCodes].filter((code) => !uploadCodes.has(code)).length,
      only_in_upload: [...uploadCodes].filter((code) => !mappingCodes.has(code)).length,
    },
    rules: M2_STOCK_RULES,
    note: 'BAL_QTY 자체는 이 레인에 없다 — 라이브 잔량조회(운영자 인증) 전까지 잰 것은 키 대응 구조뿐이다',
  };
}

/** 테스트와 도구가 같은 변환 권위를 쓰는지 확인하기 위한 노출(재구현 금지 표식). */
export const M2_STOCK_AUTHORITY = stockFromErpBalance;
