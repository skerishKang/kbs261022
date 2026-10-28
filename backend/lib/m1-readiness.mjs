// M1 — registration readiness report, organised the way the CTO brief asks:
// eight Naver registration fields, registerable candidates versus blockers,
// and the M1 additions (auth runtime + detail template drafts) as facts.
//
// This module is a READ of the classified catalogue — it reuses
// lib/registration-readiness.mjs (classifyCatalog) as the only classifier and
// lib/detail-template.mjs for the draft census. It introduces no new verdict
// of its own: every number below is a rollup of measured row fields, and every
// "candidate" is conditional on gates that are still open (policy decisions,
// category corpus, ERP stock read, image upload). 등록 가능 0건 remains the
// honest headline; the candidates answer "what clears when the gates clear".
//
// No network, no fs. The tool m1-readiness-report.mjs does the file IO.

export const M1_FIELD_REASONS = {
  naver_category: {
    label: '네이버 카테고리',
    blocked: ['supplier_category_not_mapped_to_naver', 'naver_leaf_category_absent', 'naver_category_corpus_absent'],
    usableOf: (row) => String(row.naver_leaf_category_id || '') !== '',
    note: 'leafCategoryId 의 유일한 출처는 GET /v1/categories (판매자 토큰) — 코퍼스 수집 전까지 임의 배정 금지',
  },
  sale_price: {
    label: '판매가',
    blocked: ['price_inquiry_only', 'price_sold_out_no_public_price', 'price_numeric_but_inquiry_state', 'price_value_untrusted_parse_artifact', 'price_absent_no_published_value'],
    usableOf: (row) => row.price_usable === 'yes',
    note: '공개 판매가만 usable — 가격 문의·판매완료는 고객 확정 전까지 등록 불가',
  },
  stock: {
    label: '재고',
    blocked: ['stock_quantity_column_absent', 'stock_requires_erp_balance_read', 'stock_displayed_zero', 'stock_displayed_but_supplier_unmanaged', 'stock_displayed_positive_unverified', 'availability_fields_absent'],
    usableOf: (row) => row.stock_quantity_confirmed === 'yes',
    note: '확정 수량은 Ecount 잔량조회(BAL_QTY)만 근거 — 공급처 표시 수량은 참고용',
  },
  detail_content: {
    label: '상세설명',
    blocked: ['detail_content_absent', 'detail_content_summary_only'],
    usableOf: () => false,
    note: '공급처 한 줄 요약(최대 187자)은 본문이 아니다 — M1 템플릿 초안이 전 건 생성되지만 운영자 승인 전까지 required 는 미해소',
  },
  images: {
    label: '이미지',
    blocked: ['image_representative_blank', 'image_measurement_missing', 'image_probe_not_fetched', 'image_probe_http_error', 'image_bytes_unreadable', 'image_format_not_allowed', 'image_below_recommended_pixels', 'image_non_square_measured', 'image_no_larger_segment_measured', 'image_larger_segment_still_small', 'image_extra_over_api_max', 'image_external_host_upload_required', 'image_gif_animation_indicator'],
    usableOf: (row) => String(row.naver_uploaded_image || '') !== '',
    sourceReadyStates: ['ok', 'ok_via_segment'],
    note: '등록 가능 판정은 업로드 API 반환 URL만 통과(image_external_host_upload_required 가 전 건의 기본 차단) — 소스 준비도(ok/ok_via_segment)는 업로드 대기 품질 지표',
  },
  origin: {
    label: '원산지',
    blocked: ['origin_code_absent'],
    usableOf: () => false,
    note: 'storewide 정책 — detailAttribute.originAreaInfo.originAreaCode 는 등록 시 필수',
  },
  delivery_returns: {
    label: '배송·반품',
    blocked: ['shipping_policy_absent', 'return_policy_absent'],
    usableOf: () => false,
    note: 'deliveryInfo.deliveryFee 와 claimDeliveryInfo(반품/교환 배송비)는 등록 시 필수 — 고객 정책 확정 필요',
  },
  as_kc: {
    label: 'AS·인증',
    blocked: ['as_template_absent', 'kc_info_absent'],
    usableOf: () => false,
    note: 'detailAttribute.afterServiceInfo(AS 전화번호·안내)는 필수. 카테고리별 인증(KC 등) 요구는 코퍼스 수집 전까지 미확인',
  },
};

export const M1_CANDIDATE_GATES = {
  price_gate: 'price_usable == yes',
  image_gate: 'image_measured_state in (ok, ok_via_segment)',
  duplicate_gate: 'duplicate_pair_count == 0 (쌍 자체가 없는 상품만 — 판정 대기 쌍은 제외)',
  pilot_status_gate: '공급처 판매상태 == 판매중',
  first_batch_status_gate: '공급처 판매상태 != 품절(판매중지) && != 판매완료',
  always_open_gates: ['naver_category', 'stock', 'origin', 'delivery_returns', 'as_kc', 'detail_content 승인', 'images 업로드 API 전환', 'cgi_sale_status 승인'],
};

const emptyTally = () => ({ usable: 0, blocked: 0, source_ready: 0, reason_counts: {} });

/**
 * Rolls the classified rows up into the eight-field view plus candidate sets.
 * `draftCensus` comes from the tool that ran the template over every row:
 * { drafts_built, approval_pending, reason_counts }.
 */
export function buildM1Readiness({ rows = [], draftCensus = null } = {}) {
  if (rows.length === 0) throw new Error('no classified rows — refusing to summarise an empty catalogue');

  const fields = {};
  for (const [key, meta] of Object.entries(M1_FIELD_REASONS)) {
    const tally = emptyTally();
    tally.label = meta.label;
    tally.note = meta.note;
    const reasonKeys = meta.blocked;
    for (const code of reasonKeys) tally.reason_counts[code] = 0;
    for (const row of rows) {
      if (meta.usableOf(row)) {
        tally.usable += 1;
        continue;
      }
      const codes = new Set(String(row.gap_codes || '').split(';').filter(Boolean));
      let counted = false;
      for (const code of reasonKeys) {
        if (codes.has(code)) {
          tally.reason_counts[code] += 1;
          counted = true;
        }
      }
      if (!counted) {
        // A row can be blocked on this field for a reason outside the declared
        // list (or not blocked at all while the usable check is conservative).
        // Name the residual instead of silently folding it into a bucket.
        tally.reason_counts.__residual = (tally.reason_counts.__residual || 0) + 1;
        tally.blocked += 1;
      } else {
        tally.blocked += 1;
      }
    }
    if (key === 'images') {
      tally.source_ready = rows.filter((row) => M1_FIELD_REASONS.images.sourceReadyStates.includes(row.image_measured_state)).length;
      const states = {};
      for (const row of rows) states[row.image_measured_state] = (states[row.image_measured_state] || 0) + 1;
      tally.state_census = states;
    }
    fields[key] = tally;
  }

  // Candidate sets — every gate below is explicit, and none of them clears the
  // always-open gates (category, stock, policy, approval, upload).
  const priceOk = (row) => row.price_usable === 'yes';
  const imageOk = (row) => ['ok', 'ok_via_segment'].includes(row.image_measured_state);
  const cleanDup = (row) => Number(row.duplicate_pair_count || 0) === 0;
  const pilot = rows.filter((row) => row.supplier_sales_status === '판매중' && priceOk(row) && imageOk(row) && cleanDup(row));
  const firstBatch = rows.filter((row) => !['품절(판매중지)', '판매완료'].includes(row.supplier_sales_status) && priceOk(row) && imageOk(row) && cleanDup(row));
  const byStatus = {};
  for (const row of rows) byStatus[row.supplier_sales_status || '(blank)'] = (byStatus[row.supplier_sales_status || '(blank)'] || 0) + 1;

  const candidates = {
    gates: M1_CANDIDATE_GATES,
    pilot: { count: pilot.length, cgi_ids: pilot.map((r) => r.cgi_id), note: '게이트 해제 시 최우선 파일럿 후보' },
    first_batch: {
      count: firstBatch.length,
      cgi_ids_capped: 50,
      cgi_ids: firstBatch.slice(0, 50).map((r) => r.cgi_id),
      by_supplier_status: Object.fromEntries([...new Set(firstBatch.map((r) => r.supplier_sales_status || '(blank)'))].map((s) => [s, firstBatch.filter((r) => (r.supplier_sales_status || '(blank)') === s).length])),
    },
    by_supplier_status: byStatus,
  };

  const registerable_now = rows.filter((row) => row.naver_register_problems === '').length;

  return {
    kind: 'cgi-m1-readiness-report',
    products: rows.length,
    registerable_now,
    registerable_now_note: 'naver_register_problems 가 빈 행이 0건 — 카테고리·재고·업로드 이미지·정책 게이트가 모두 열리기 전까지는 본문 전송 후보가 없다',
    fields,
    m1_detail_template: draftCensus,
    candidates,
  };
}
