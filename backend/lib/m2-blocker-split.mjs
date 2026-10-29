// M2 후속 — 4,575건 등록 차단 사유를 '누가 풀 수 있는가'로 분리한다.
//
// 세 클래스이며 두 바구니로 롤업된다:
//   tooling_auto        외부 인증 없이 도구 실행(재수집·재측정·초안 생성)으로 해소
//   tooling_after_auth  판매자 토큰·ERP 인증 등 외부 인증이 선행되면 도구 실행으로 해소
//   customer_input      고객이 값·정책·서류를 제공해야만 해소 — 도구가 만들어낼 수 없다
//
// auto_resolvable = tooling_auto + tooling_after_auth ("자동 해소 가능").
// 어휘는 M1 준비도 사유 표(M1_FIELD_REASONS)의 차단 코드 전체와 1:1 이어야 하며,
// 빠진 코드는 unclassified 로 남아 보고서가 거짓 0을 말하지 않게 한다.
//
// 순수 모듈: fs 없음. 도구(tools/m2b-preparation.mjs)가 파일 IO 를 담당한다.

import { M1_FIELD_REASONS } from './m1-readiness.mjs';

export const M2_RESOLUTION_CLASSES = {
  tooling_auto: '외부 인증 없이 도구 실행(재수집·재측정·초안 생성)으로 해소된다',
  tooling_after_auth: '판매자 토큰·ERP 인증 등 외부 인증이 선행되면 도구 실행으로 해소된다',
  customer_input: '고객이 값·정책·서류를 제공해야만 해소된다 — 도구가 대신 만들어낼 수 없다',
};

/** M1 차단 코드 → 해소 주체. requires 는 해소에 선행해야 하는 구체적 입력이다. */
export const M2_BLOCKER_RESOLUTIONS = {
  // --- 네이버 카테고리 -------------------------------------------------------------
  naver_category_corpus_absent: {
    resolution: 'tooling_after_auth', requires: ['판매자 토큰', '코퍼스 수집 도구 실행'],
    note: 'GET /v1/categories?last=true — 수집·검증 도구는 mock으로 검증돼 있다',
  },
  naver_leaf_category_absent: {
    resolution: 'tooling_after_auth', requires: ['판매자 토큰', '코퍼스 수집', '운영자 리프 확인'],
    note: '후보 제안은 도구가 하고, confirmed 는 사람이 채운다 — 임의 배정은 계약상 금지',
  },
  supplier_category_not_mapped_to_naver: {
    resolution: 'tooling_after_auth', requires: ['판매자 토큰', '코퍼스 수집', '재매핑 실행'],
    note: '브랜드·프로모션 경로는 코퍼스가 있어도 매핑되지 않는다(구조 판정 계약)',
  },

  // --- 가격 ------------------------------------------------------------------------
  price_inquiry_only: {
    resolution: 'customer_input', requires: ['고객 판매가 확정 또는 판매 제외 판단'],
    note: '가격 문의 전용 상품 — 공개 가격이 없어 본문에 들어갈 값이 없다',
  },
  price_sold_out_no_public_price: {
    resolution: 'customer_input', requires: ['고객 판매 여부·재입고 정책'],
    note: '판매완료 상품 — 판매 지속 여부는 사업 판단이다',
  },
  price_absent_no_published_value: {
    resolution: 'customer_input', requires: ['고객 판매가 제공'],
  },
  price_numeric_but_inquiry_state: {
    resolution: 'tooling_auto', requires: ['공급처 페이지 재수집(상태 갱신)'],
    note: '숫자 가격이 있으나 문의 상태로 기록됐다 — 재수집이 상태를 바로잡는다',
  },
  price_value_untrusted_parse_artifact: {
    resolution: 'tooling_auto', requires: ['원문 가격 재수집 후 재판정'],
    note: '준비도가 파싱 산물로 거부한 1건 — 원문 확인이 유일한 해소',
  },

  // --- 재고 ------------------------------------------------------------------------
  stock_quantity_column_absent: {
    resolution: 'tooling_after_auth', requires: ['ERP 인증', 'BAL_QTY 조회', 'stockFromErpBalance 변환'],
  },
  stock_requires_erp_balance_read: {
    resolution: 'tooling_after_auth', requires: ['ERP 인증', 'BAL_QTY 조회'],
  },
  stock_displayed_positive_unverified: {
    resolution: 'tooling_after_auth', requires: ['ERP 인증', 'BAL_QTY 조회'],
    note: '공급처 표시 수량은 참고용 — ERP 잔량이 결정권',
  },
  stock_displayed_zero: {
    resolution: 'tooling_after_auth', requires: ['ERP 인증', 'BAL_QTY 조회', '품절 판정은 운영 확인'],
  },
  stock_displayed_but_supplier_unmanaged: {
    resolution: 'tooling_after_auth', requires: ['ERP 인증', 'BAL_QTY 조회'],
  },
  availability_fields_absent: {
    resolution: 'tooling_auto', requires: ['공급처 페이지 재수집(availability 4키)', '재수집 입력 검증 후 반영'],
    note: 'samamusic 배치 341건 — 값 발명 없이 재수집으로만 복구된다(감사 도구가 워크리스트 산출)',
  },

  // --- 상세설명 ---------------------------------------------------------------------
  detail_content_absent: {
    resolution: 'tooling_auto', requires: ['M1 템플릿 초안(전 건 생성됨)', '운영자 상세본문 승인'],
  },
  detail_content_summary_only: {
    resolution: 'tooling_auto', requires: ['M1 템플릿 초안', '운영자 상세본문 승인'],
    note: '공급처 한 줄 요약은 본문이 아니다 — 초안이 이미 만들어져 있다',
  },

  // --- 이미지 ----------------------------------------------------------------------
  image_external_host_upload_required: {
    resolution: 'tooling_after_auth', requires: ['판매자 토큰', '이미지 업로드 러너 실행'],
    note: '업로드 러너는 M2 계약 테스트로 고정돼 있다 — 반환 URL 만 본문에 허용',
  },
  image_representative_blank: {
    resolution: 'tooling_auto', requires: ['공급처 대체 이미지 재수집'],
    note: '대체가 존재하지 않으면 고객 제공(상품 이미지)으로 전환된다',
  },
  image_probe_not_fetched: { resolution: 'tooling_auto', requires: ['이미지 프로브 재실행'] },
  image_probe_http_error: { resolution: 'tooling_auto', requires: ['이미지 프로브 재실행'] },
  image_bytes_unreadable: { resolution: 'tooling_auto', requires: ['재수집 또는 대체 세그먼트 측정'] },
  image_measurement_missing: { resolution: 'tooling_auto', requires: ['이미지 프로브 재실행'] },
  image_format_not_allowed: {
    resolution: 'tooling_auto', requires: ['허용 형식(JPG/GIF/PNG/BMP) 대체 이미지 재수집'],
    note: '공급처에 대체가 없으면 고객 제공으로 전환된다',
  },
  image_below_recommended_pixels: {
    resolution: 'tooling_auto', requires: ['대형 세그먼트 재측정(variant)', '필요 시 대체 이미지'],
    note: '1000x1000 은 권장이지 바닥이 아니다 — 차단이라기보다 품질 표시에 가깝다',
  },
  image_non_square_measured: {
    resolution: 'tooling_auto', requires: ['대형 세그먼트 재측정(variant)'],
  },
  image_no_larger_segment_measured: {
    resolution: 'tooling_auto', requires: ['variant 프로브 재실행'],
  },
  image_larger_segment_still_small: {
    resolution: 'tooling_auto', requires: ['대체 이미지 재수집'],
    note: '큰 세그먼트가 있어도 권장에 못 미치면 대체 이미지 확보가 필요하다',
  },
  image_gif_animation_indicator: {
    resolution: 'tooling_auto', requires: ['정지 이미지 대체 재수집'],
    note: '움직이는 GIF 사용 여부는 정책 사항 — 기본은 정지 이미지로 대체',
  },
  image_extra_over_api_max: {
    resolution: 'tooling_auto', requires: ['추가 이미지 선별(대표 1+9 상한)'],
  },

  // --- 운영 정책(고객 제공) -----------------------------------------------------------
  origin_code_absent: {
    resolution: 'customer_input', requires: ['고객 원산지 정책 확정(제조국/수입 원산지)'],
    note: '전면 정책 하나 — 상품별 판단이 아니라 storewide 값이다',
  },
  shipping_policy_absent: {
    resolution: 'customer_input', requires: ['고객 배송비·배송 방식 정책'],
  },
  return_policy_absent: {
    resolution: 'customer_input', requires: ['고객 반품·교환 배송비 정책'],
  },
  as_template_absent: {
    resolution: 'customer_input', requires: ['고객 AS 안내(전화번호·안내 문구)'],
  },
  kc_info_absent: {
    resolution: 'customer_input', requires: ['고객 KC 인증 서류·신고 정보', '리프 certificationInfos 요구 확인(토큰)'],
    note: '카테고리가 요구하는 리프에만 필요 — 코퍼스 수집 후 대상 확정',
  },
};

/** M1 차단 어휘 전체가 분류 표에 있는지 검사한다 — 어휘 드리프트는 여기서 울린다. */
export function unclassifiedM1Codes({ declared = M2_BLOCKER_RESOLUTIONS } = {}) {
  const out = [];
  for (const [field, meta] of Object.entries(M1_FIELD_REASONS)) {
    for (const code of meta.blocked) {
      if (!declared[code]) out.push({ field, code });
    }
  }
  return out;
}

/**
 * 분류된 준비도 행(gap_codes ; 구분)을 해소 주체별로 분리한다.
 * 상품 단위 판정: customer_input 코드가 하나라도 있으면 'customer_required',
 * 전부 tooling 계열이면 'auto_resolvable', 차단 코드가 없으면 'no_gap'.
 */
export function splitBlockers(rows = [], { declared = M2_BLOCKER_RESOLUTIONS } = {}) {
  const perReason = new Map();
  const unclassified = new Map();
  let auto = 0, customer = 0, mixed = 0, noGap = 0;
  const autoIds = [], customerIds = [], mixedIds = [];
  for (const row of rows) {
    const codes = [...new Set(String(row.gap_codes || '').split(';').filter(Boolean))];
    let hasCustomer = false, hasTooling = false, countedAny = false;
    for (const code of codes) {
      const meta = declared[code];
      if (!meta) { unclassified.set(code, (unclassified.get(code) || 0) + 1); continue; }
      countedAny = true;
      const entry = perReason.get(code) || { reason: code, resolution: meta.resolution, requires: meta.requires, note: meta.note || '', products: 0 };
      entry.products += 1;
      perReason.set(code, entry);
      if (meta.resolution === 'customer_input') hasCustomer = true;
      else hasTooling = true;
    }
    if (!countedAny) { noGap += 1; continue; }
    const cgiId = row.cgi_id ?? row.cgiId ?? '';
    if (hasCustomer && hasTooling) { mixed += 1; mixedIds.push(cgiId); }
    else if (hasCustomer) { customer += 1; customerIds.push(cgiId); }
    else { auto += 1; autoIds.push(cgiId); }
  }
  const byResolution = { tooling_auto: 0, tooling_after_auth: 0, customer_input: 0 };
  for (const entry of perReason.values()) byResolution[entry.resolution] += entry.products;
  return {
    products: rows.length,
    product_split: {
      auto_resolvable: auto,
      customer_required: customer,
      mixed: mixed,
      no_gap: noGap,
      note: 'mixed 는 고객 제공과 도구 실행이 모두 남은 상품 — 고객 제공이 병목이다',
      cgi_ids_capped: 50,
      auto_resolvable_ids: autoIds.slice(0, 50),
      customer_required_ids: customerIds.slice(0, 50),
      mixed_ids: mixedIds.slice(0, 50),
    },
    reason_split: [...perReason.values()].sort((a, b) => (b.products - a.products) || (a.reason < b.reason ? -1 : 1)),
    resolution_totals: byResolution,
    resolution_classes: M2_RESOLUTION_CLASSES,
    unclassified_reasons: Object.fromEntries(unclassified),
    unclassified_total: [...unclassified.values()].reduce((sum, n) => sum + n, 0),
  };
}
