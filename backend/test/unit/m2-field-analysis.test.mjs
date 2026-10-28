// M2 사전개발 — field-analysis 모듈 계약 테스트.
//
// 두 가지를 고정한다:
//   1. 출처별 분류(classifyFieldGapsBySource)는 M1 준비도 사유 표와 어긋나지 않는다 —
//      M1_FIELD_REASONS 의 origin/delivery_returns/as_kc/stock 사유 전체가 선언돼 있고,
//      선언되지 않은 사유는 __residual 로 조용히 묻히지 않는다.
//   2. 서술된 BAL_QTY 규칙(M2_STOCK_RULES)은 실제 구현(stockFromErpBalance)과 일치한다 —
//      서술이 구현을 벗어나면 이 테스트가 먼저 울린다.
//
//   node --test test/unit/m2-field-analysis.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyFieldGapsBySource,
  stockCorrespondence,
  M2_FIELD_GAP_SOURCES,
  M2_SOURCE_CLASSES,
  M2_STOCK_RULES,
  M2_STOCK_AUTHORITY,
} from '../../lib/m2-field-analysis.mjs';
import { M1_FIELD_REASONS } from '../../lib/m1-readiness.mjs';
import { NCOM_LIMITS } from '../../lib/ncommerce.mjs';

const row = (cgiId, gapCodes) => ({ cgi_id: cgiId, gap_codes: gapCodes });

test('every M1 blocked reason for origin/delivery/AS/KC/stock has a declared source class', () => {
  for (const key of ['origin', 'delivery_returns', 'as_kc', 'stock']) {
    for (const code of M1_FIELD_REASONS[key].blocked) {
      assert.ok(M2_FIELD_GAP_SOURCES[code], `${key} 사유 ${code} 의 출처 분류가 선언되지 않았다`);
      assert.ok(M2_SOURCE_CLASSES[M2_FIELD_GAP_SOURCES[code].source_class], `${code} 의 source_class 가 정의된 네 개 밖에 있다`);
    }
  }
});

test('classification buckets rows by data source and conserves the blocked total', () => {
  const rows = [
    row('a:1', 'origin_code_absent'),
    row('a:2', 'shipping_policy_absent;return_policy_absent'),
    row('a:3', 'as_template_absent;kc_info_absent;stock_requires_erp_balance_read'),
    row('a:4', 'stock_displayed_positive_unverified'),
  ];
  const report = classifyFieldGapsBySource(rows);
  assert.equal(report.fields.origin.blocked, 1);
  assert.equal(report.fields.origin.source_counts.prep_column_blank, 1);
  assert.equal(report.fields.delivery_returns.blocked, 2);
  assert.equal(report.fields.as_kc.blocked, 2);
  assert.equal(report.fields.as_kc.source_counts.category_dependent, 1, 'KC 는 카테고리 코퍼스 의존으로 간다');
  assert.equal(report.fields.as_kc.source_counts.prep_column_blank, 1, 'AS 템플릿은 준비파일 공란으로 간다');
  assert.equal(report.fields.stock.source_counts.erp_read_pending, 2);
  for (const bucket of Object.values(report.fields)) {
    const summed = Object.values(bucket.source_counts).reduce((sum, n) => sum + n, 0);
    assert.equal(summed, bucket.blocked, '출처 합계는 blocked 합계와 같아야 한다');
  }
  assert.equal(report.undeclared_total, 0);
});

test('out-of-scope reasons are not the business of this analysis and leave no residual', () => {
  // 가격·이미지 사유는 M1 준비도의 몫이다 — M2 분석은 세지도 않고 잔여로 남기지도 않는다.
  const report = classifyFieldGapsBySource([row('a:1', 'price_inquiry_only;image_probe_http_error;origin_code_absent')]);
  assert.equal(Object.keys(report.fields).length, 1);
  assert.equal(report.fields.origin.blocked, 1);
  assert.equal(report.undeclared_total, 0);
});

test('an in-scope reason missing from the declared table survives as __residual', () => {
  const report = classifyFieldGapsBySource([row('a:1', 'origin_code_absent')], { declared: {} });
  assert.deepEqual(report.fields, {});
  assert.equal(report.undeclared_total, 1);
  assert.equal(report.undeclared_reasons.origin_code_absent, 1);
});

test('the described BAL_QTY rules are the implemented rules, not a parallel story', () => {
  const mapping = new Map([
    ['SS-3836', { naverItemId: 500001, optionManaged: false }],
    ['SS-OPT', { naverItemId: 500002, optionManaged: true }],
    ['SS-UNPUB', { naverItemId: null, optionManaged: false }],
  ]);
  const erpRows = [
    { PROD_CD: 'SS-3836', BAL_QTY: '3.0000000000' },
    { PROD_CD: 'SS-OPT', BAL_QTY: '7.9' },
    { PROD_CD: 'SS-3836', BAL_QTY: '-1.0000000000' },
    { PROD_CD: 'SS-3836', BAL_QTY: '999999999' },
    { PROD_CD: 'SS-3836', BAL_QTY: '재고없음' },
    { PROD_CD: 'ZZ-ZZZZ', BAL_QTY: '2' },
    { PROD_CD: 'SS-UNPUB', BAL_QTY: '5' },
  ];
  const result = M2_STOCK_AUTHORITY({ erpRows, mappingByProdCd: mapping });

  assert.equal(result.updates.length, 2);
  assert.equal(result.updates[0].stockQuantity, 3, 'decimal 문자열은 floor 로만 내린다 — M2_STOCK_RULES.bal_qty_format');
  assert.equal(result.updates[1].stockQuantity, 7, '7.9 는 8 이 아니라 7 — 올림 금지');
  assert.equal(result.updates[1].endpointKey, 'optionStock', '옵션 관리형은 option-stock 엔드포인트 — M2_STOCK_RULES.option_managed');
  assert.equal(result.updates[0].endpointKey, 'productModifyOrigin');

  const reasons = result.rejected.map((r) => r.reason).sort();
  assert.deepEqual(reasons, [...M2_STOCK_RULES.rejection_reasons].sort(), '거부 사유 어휘가 서술과 일치한다');
  assert.equal(result.rejected.find((r) => r.reason === 'out_of_bounds').max, NCOM_LIMITS.stockQuantityMax, '상한은 NCOM_LIMITS 의 문서 수치다');
  assert.equal(M2_STOCK_RULES.bounds.stockQuantityMax, NCOM_LIMITS.stockQuantityMax);
  assert.equal(M2_STOCK_RULES.authority.includes('stockFromErpBalance'), true);
});

test('stock correspondence measures the committed key structure, not invented quantities', () => {
  const mappingRows = [
    { '품목코드': 'SS-3836', '카페24품목코드': 'P0000FRO000A', '공급처원본ID': 'samasound:3836', '원산지_cont5': '' },
    { '품목코드': 'SM-1118', '카페24품목코드': '', '공급처원본ID': 'samamusic:1118', '원산지_cont5': '' },
    { '품목코드': '', '카페24품목코드': '', '공급처원본ID': 'samamusic:9999', '원산지_cont5': '' },
  ];
  const uploadRows = [
    { '품목코드': 'SS-3836', '재고수량관리': '0', '세트여부': '0' },
    { '품목코드': 'SM-1118', '재고수량관리': '1', '세트여부': '0' },
    { '품목코드': 'XX-ONLY', '재고수량관리': '0', '세트여부': '0' },
  ];
  const report = stockCorrespondence({ mappingRows, uploadRows });
  assert.equal(report.mapping.rows, 3);
  assert.equal(report.mapping.prod_cd_distinct, 2, '품목코드 공란 행은 대응 키가 아니다');
  assert.equal(report.mapping.cafe24_item_code_non_blank, 1, '옵션 SKU 는 일부 행에만 있다');
  assert.equal(report.mapping.origin_column_non_blank, 0, '원산지 열은 커밋된 준비파일에서 비어 있다');
  assert.equal(report.join.prod_cd_in_both, 2);
  assert.equal(report.join.only_in_upload, 1);
  assert.match(report.note, /라이브 잔량조회/);
});
