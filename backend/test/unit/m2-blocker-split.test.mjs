// M2 후속 — blocker-split 계약 테스트.
//
// 고정하는 것:
//   1. M1 차단 어휘 34개 전체가 분류 표에 있다(어휘 드리프트 조기 경보).
//   2. 상품 단위 판정은 '고객 제공이 하나라도 있으면 customer_required' 이고,
//      전부 도구 계열이면 auto_resolvable, 섞이면 mixed 로 병목을 드러낸다.
//   3. 분류 표에 없는 코드는 조용히 묻히지 않고 unclassified 로 남는다.

import test from 'node:test';
import assert from 'node:assert/strict';

import { splitBlockers, unclassifiedM1Codes, M2_BLOCKER_RESOLUTIONS, M2_RESOLUTION_CLASSES } from '../../lib/m2-blocker-split.mjs';
import { M1_FIELD_REASONS } from '../../lib/m1-readiness.mjs';

const row = (cgiId, gapCodes) => ({ cgi_id: cgiId, gap_codes: gapCodes });

test('every M1 blocked code has a resolution — the vocabulary cannot drift apart', () => {
  assert.deepEqual(unclassifiedM1Codes(), []);
  for (const [field, meta] of Object.entries(M1_FIELD_REASONS)) {
    for (const code of meta.blocked) {
      assert.ok(M2_RESOLUTION_CLASSES[M2_BLOCKER_RESOLUTIONS[code].resolution], `${code} 의 resolution 클래스가 정의돼 있어야 한다`);
    }
  }
});

test('policy blanks are customer input; measurement gaps are tooling', () => {
  assert.equal(M2_BLOCKER_RESOLUTIONS.origin_code_absent.resolution, 'customer_input');
  assert.equal(M2_BLOCKER_RESOLUTIONS.shipping_policy_absent.resolution, 'customer_input');
  assert.equal(M2_BLOCKER_RESOLUTIONS.return_policy_absent.resolution, 'customer_input');
  assert.equal(M2_BLOCKER_RESOLUTIONS.as_template_absent.resolution, 'customer_input');
  assert.equal(M2_BLOCKER_RESOLUTIONS.kc_info_absent.resolution, 'customer_input');
  assert.equal(M2_BLOCKER_RESOLUTIONS.price_inquiry_only.resolution, 'customer_input');
  assert.equal(M2_BLOCKER_RESOLUTIONS.image_probe_not_fetched.resolution, 'tooling_auto');
  assert.equal(M2_BLOCKER_RESOLUTIONS.availability_fields_absent.resolution, 'tooling_auto');
  assert.equal(M2_BLOCKER_RESOLUTIONS.naver_category_corpus_absent.resolution, 'tooling_with_token');
  assert.equal(M2_BLOCKER_RESOLUTIONS.image_external_host_upload_required.resolution, 'tooling_with_token');
  assert.equal(M2_BLOCKER_RESOLUTIONS.stock_requires_erp_balance_read.resolution, 'tooling_with_token');
});

test('products split by who can resolve what, and mixed products surface the bottleneck', () => {
  const rows = [
    row('a:1', 'image_probe_not_fetched'),                                      // tooling only → auto
    row('a:2', 'origin_code_absent'),                                           // customer only
    row('a:3', 'origin_code_absent;image_probe_not_fetched'),                   // both → mixed
    row('a:4', 'price_inquiry_only;shipping_policy_absent'),                    // customer only
    row('a:5', 'price_inquiry_only;price_value_untrusted_parse_artifact'),      // mixed
    row('a:6', ''),                                                             // no gap
  ];
  const split = splitBlockers(rows);
  assert.equal(split.products, 6);
  assert.equal(split.product_split.auto_resolvable, 1);
  assert.equal(split.product_split.customer_required, 2);
  assert.equal(split.product_split.mixed, 2);
  assert.equal(split.product_split.no_gap, 1);
  assert.equal(split.resolution_totals.customer_input, 5, '고객 제공 코드 건수: origin 1 + price_inquiry 2 + shipping 1 + price_inquiry 1 = 5');
  assert.equal(split.resolution_totals.tooling_auto, 3);
  assert.equal(split.reason_split.find((r) => r.reason === 'price_inquiry_only').products, 2);
});

test('an unknown code is reported as unclassified, never silently dropped', () => {
  const split = splitBlockers([row('a:1', 'some_new_reason')]);
  assert.equal(split.product_split.auto_resolvable, 0, '미분류 코드는 어느 바구니에도 세지 않는다');
  assert.equal(split.unclassified_total, 1);
  assert.equal(split.unclassified_reasons.some_new_reason, 1);
});

test('per-product id lists are capped at 50 so the report stays a report', () => {
  const rows = Array.from({ length: 60 }, (_, i) => row(`s:${i}`, 'image_probe_not_fetched'));
  const split = splitBlockers(rows);
  assert.equal(split.product_split.auto_resolvable, 60);
  assert.equal(split.product_split.cgi_ids_capped, 50);
  assert.equal(split.product_split.auto_resolvable_ids.length, 50);
});
