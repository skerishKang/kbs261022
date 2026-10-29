// M1 — readiness rollup tests on a small fixture. The rollup must add no new
// verdicts of its own: every number is derived from the classified row fields,
// every candidate is gated explicitly, and an unmapped blocker must surface as
// a named residual instead of disappearing into a bucket.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildM1Readiness, M1_FIELD_REASONS } from '../../lib/m1-readiness.mjs';

const row = (overrides = {}) => ({
  cgi_id: 'samamusic:1',
  gap_codes: 'supplier_category_not_mapped_to_naver;naver_leaf_category_absent;naver_category_corpus_absent;price_inquiry_only;stock_quantity_column_absent;stock_requires_erp_balance_read;detail_content_summary_only;image_external_host_upload_required;origin_code_absent;shipping_policy_absent;return_policy_absent;as_template_absent;kc_info_absent;model_blank;manufacturer_blank_not_collected;cgi_sale_status_unapproved;supplier_status_selling;no_duplicate_pair',
  naver_leaf_category_id: '',
  price_usable: 'no',
  stock_quantity_confirmed: 'no',
  naver_uploaded_image: '',
  image_measured_state: 'ok',
  naver_register_problems: 'leafCategoryId:required_at_register;stockQuantity:required_at_register;images.representative:not_from_image_upload_api',
  duplicate_pair_count: 0,
  supplier_sales_status: '판매중',
  ...overrides,
});

test('an empty catalogue is refused, not summarised as zeros', () => {
  assert.throws(() => buildM1Readiness({ rows: [] }), /no classified rows/);
});

test('the clean selling product is the pilot candidate while registerable_now stays zero', () => {
  const priced = row({ cgi_id: 'priced', price_usable: 'yes' });
  const report = buildM1Readiness({
    rows: [row(), priced],
    draftCensus: { drafts_built: 2, approval_pending: 2, reason_counts: {} },
  });
  assert.equal(report.registerable_now, 0, 'a payload with any register problem is not transmittable');
  assert.deepEqual(report.candidates.pilot.cgi_ids, ['priced'], 'the price gate keeps an inquiry-priced seller out of the pilot set');
  assert.equal(report.fields.sale_price.usable, 1);
  assert.equal(report.fields.images.source_ready, 2, 'measured-ok images are source-ready for the upload queue');
});

test('every declared field blocker lands on its reason, with no residual', () => {
  const report = buildM1Readiness({ rows: [row()] });
  for (const [key, field] of Object.entries(report.fields)) {
    const residual = field.reason_counts.__residual || 0;
    assert.equal(residual, 0, `${key} must not carry an unmapped blocker`);
    assert.equal(field.blocked, 1, `${key}: the fixture row is blocked`);
  }
  const priceReasons = report.fields.sale_price.reason_counts;
  assert.equal(priceReasons.price_inquiry_only, 1);
  assert.equal(priceReasons.price_sold_out_no_public_price, 0);
});

test('a residual blocker is named, never folded away', () => {
  const odd = row({
    gap_codes: 'image_something_new_under_the_sun',
    image_measured_state: 'unmeasured',
  });
  const report = buildM1Readiness({ rows: [odd] });
  assert.equal(report.fields.images.reason_counts.__residual, 1, 'an unknown image blocker must stay visible');
  assert.equal(report.fields.images.reason_counts.image_measurement_missing, 0, 'unmeasured state alone is not a declared gap in this fixture');
});

test('the upload-API requirement is the default image blocker for measured-ok rows', () => {
  const report = buildM1Readiness({ rows: [row()] });
  assert.equal(report.fields.images.reason_counts.image_external_host_upload_required, 1);
  assert.equal(report.fields.images.usable, 0);
});

test('candidate gates: status, duplicates and the two batches', () => {
  const rows = [
    row({ cgi_id: 'a', supplier_sales_status: '판매중' }),
    row({ cgi_id: 'b', supplier_sales_status: '재고미관리' }),
    row({ cgi_id: 'c', supplier_sales_status: '품절(판매중지)' }),
    row({ cgi_id: 'd', supplier_sales_status: '판매완료' }),
    row({ cgi_id: 'e', supplier_sales_status: '판매중', duplicate_pair_count: 2 }),
    row({ cgi_id: 'f', supplier_sales_status: '판매중', image_measured_state: 'below_recommended' }),
    row({ cgi_id: 'g', supplier_sales_status: '판매중', price_usable: 'yes' }),
  ];
  const report = buildM1Readiness({ rows });
  assert.deepEqual(report.candidates.pilot.cgi_ids, ['g'], '판매중 + price + measured-ok image + no duplicate pair');
  assert.equal(report.candidates.first_batch.count, 1, '재고미관리 passes the status gate but this fixture is inquiry-priced');
  assert.equal(report.candidates.by_supplier_status['판매중'], 4);
});

test('first_batch counts 재고미관리 and excludes 품절·판매완료 even when priced', () => {
  const rows = [
    row({ cgi_id: 'x1', supplier_sales_status: '재고미관리', price_usable: 'yes' }),
    row({ cgi_id: 'x2', supplier_sales_status: '품절(판매중지)', price_usable: 'yes' }),
    row({ cgi_id: 'x3', supplier_sales_status: '판매완료', price_usable: 'yes' }),
  ];
  const report = buildM1Readiness({ rows });
  assert.deepEqual(report.candidates.first_batch.cgi_ids, ['x1']);
  assert.equal(report.candidates.pilot.count, 0, '재고미관리 is not the pilot status');
});

test('the draft census is carried through untouched and stays an unapproved draft', () => {
  const census = { drafts_built: 3, approval_pending: 3, reason_counts: { detail_sentence_absent: 1 }, counts_as_detail_content: false, operator_approval_required: true };
  const report = buildM1Readiness({ rows: [row(), row({ cgi_id: 'b' }), row({ cgi_id: 'c' })], draftCensus: census });
  assert.equal(report.m1_detail_template.drafts_built, 3);
  assert.equal(report.m1_detail_template.operator_approval_required, true);
});

test('the eight CTO fields are exactly the report keys, each with a Korean label and note', () => {
  const report = buildM1Readiness({ rows: [row()] });
  assert.deepEqual(Object.keys(report.fields).sort(), Object.keys(M1_FIELD_REASONS).sort());
  for (const field of Object.values(report.fields)) {
    assert.ok(field.label && field.note, 'operators read Korean labels and notes, not codes only');
  }
});
