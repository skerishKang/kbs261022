// Unit tests for the dry-run package lane. Pure — no file read, no socket. The point
// of these is that the assembled body is the body the real register lane would send,
// so the four values nobody has confirmed must stay out of it, and every refusal the
// gate can raise has to be one this module declares an owner for.
//
//   node --test test/unit/registration-dry-run.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRegisterBody, NCOM_LIMITS, NCOM_ENDPOINTS } from '../../lib/ncommerce.mjs';
import { REGISTER_GATE_DOC, buildDryRunPackage, summarizeDryRunPackages, dryRunFailureRows, findPackageViolations } from '../../lib/registration-dry-run.mjs';

const readyRow = (over = {}) => ({
  cgi_id: 'test:1',
  source_site: 'test',
  source_product_id: '1',
  product_name: 'TEST 무선 이어폰',
  sale_price: '189000',
  price_usable: 'yes',
  naver_seller_management_code: 'TESTCODE0001',
  stock_quantity_confirmed: 'no',
  representative_image_url: 'https://test.example/img/1.jpg',
  naver_uploaded_image: '',
  image_measured_state: 'ok',
  supplier_category_path: '음향기기 > 이어폰',
  bucket: 'manual_review',
  ...over,
});
const contentRow = (over = {}) => ({
  cgiId: 'test:1',
  optionPlan: { status: 'no_options', optionType: 'NONE', emittable: false, children: [], reasons: ['option_source_absent'] },
  detailDraft: { counts_as_detail_content: false, operator_approval_required: true, reasons: ['kc_info_absent'], sourceFields: ['상품명'] },
  optionInfo: null,
  ...over,
});
const categoryRow = (over = {}) => ({
  category_path: '음향기기 > 이어폰', path_kind: 'product_classification', status: 'unresolved', confirmed: 'no',
  candidate_leaf_category_ids: '', ...over,
});

test('a package blocks on every value this lane has not confirmed', () => {
  const pkg = buildDryRunPackage({ readyRow: readyRow(), contentRow: contentRow(), categoryRow: categoryRow() });
  assert.equal(pkg.status, 'blocked');
  assert.equal(pkg.would_transmit, false);
  assert.equal(pkg.execute, false);
  assert.equal(pkg.transmitted, false);
  assert.deepEqual(pkg.blocking_fields, ['leafCategoryId', 'detailContent', 'stockQuantity', 'images.representative', 'sellerManagementCode'], 'the trusted price is the one field that is NOT blocking here');
  const reasons = Object.fromEntries(pkg.problems.map((p) => [p.field, p.reason]));
  assert.deepEqual(reasons, {
    leafCategoryId: 'required_at_register',
    detailContent: 'required_at_register',
    stockQuantity: 'required_at_register',
    'images.representative': 'not_from_image_upload_api',
    sellerManagementCode: 'duplicate_search_not_executed',
  });
  const origin = pkg.body.originProduct;
  assert.equal('leafCategoryId' in origin, false, 'an unconfirmed category id is absent, not empty-string');
  assert.equal('detailContent' in origin, false, 'the supplier 한 줄 설명 never becomes the register body');
  assert.equal(origin.stockQuantity, null, 'no counted quantity exists, and the 9,999 auto-set is not used as a value');
  assert.equal(origin.salePrice, 189000, 'the price is copied from the source column');
  assert.equal(origin.detailAttribute.sellerCodeInfo.sellerManagementCode, 'TESTCODE0001');
  assert.equal(origin.detailAttribute.optionInfo, undefined);
  assert.equal(pkg.evidence.stock.used_the_documented_auto_set, false);
});

test('a confirmed candidate id is copied verbatim and nothing else is', () => {
  const confirmed = buildDryRunPackage({
    readyRow: readyRow({ naver_uploaded_image: 'https://prd-phinf.pstatic.net/uploaded/1.png' }),
    contentRow: contentRow(),
    categoryRow: categoryRow({ status: 'mapped', confirmed: 'yes', candidate_leaf_category_ids: '50005167' }),
    duplicateSearchExecuted: true,
  });
  assert.equal(confirmed.body.originProduct.leafCategoryId, '50005167', 'the id comes out of the candidate table unchanged');
  assert.equal(confirmed.evidence.category.candidates.join(','), '50005167');
  assert.equal(confirmed.problems.some((p) => p.field === 'sellerManagementCode'), false, 'an executed search removes the lane gate');
  assert.equal(confirmed.problems.some((p) => p.field === 'images.representative'), false, 'an upload-API URL satisfies the image gate');
  assert.deepEqual(confirmed.problems.map((p) => p.field).sort(), ['detailContent', 'stockQuantity'], 'the two values that cannot be collected locally stay blocking');
  assert.equal(confirmed.status, 'blocked');
});

test('a number the readiness lane refuses to trust never enters the body', () => {
  const untrusted = buildDryRunPackage({ readyRow: readyRow({ sale_price: '180000', price_usable: 'no' }), contentRow: contentRow(), categoryRow: categoryRow() });
  assert.equal(untrusted.body.originProduct.salePrice, null, 'a price this project classified as a parse artifact is not sent just because the column holds digits');
  const priceProblems = untrusted.problems.filter((p) => p.field === 'salePrice');
  assert.deepEqual(priceProblems.map((p) => p.reason), ['no_public_price', 'price_untrusted_by_readiness'], 'the vendor gate and our own refusal are reported as two separate reasons');
  assert.equal(priceProblems[1].measured, '180000', 'the refused value is named so the operator can re-collect it');
  assert.deepEqual(untrusted.blocking_fields.filter((f) => f === 'salePrice'), ['salePrice'], 'salePrice blocks this product once, whatever the reason count');

  const absent = buildDryRunPackage({ readyRow: readyRow({ sale_price: '', price_usable: 'no' }), contentRow: contentRow(), categoryRow: categoryRow() });
  assert.deepEqual(absent.problems.filter((p) => p.field === 'salePrice').map((p) => p.reason), ['no_public_price'], 'a product with no number at all is not called untrusted');
  assert.equal(absent.problems.some((p) => p.reason === 'price_untrusted_by_readiness'), false);

  // The two tallies answer different questions, and the cross-check compares the
  // product one. If they ever collapse into each other, this is where it shows.
  const census = summarizeDryRunPackages([untrusted, absent]);
  assert.equal(census.problems_by_field.salePrice, 3, 'instance tally: the gated product carries two salePrice problems');
  assert.equal(census.products_by_blocking_field.salePrice, 2, 'product tally: two products are blocked on salePrice');
  assert.equal(census.values_in_bodies.sale_prices, 0);
});

test('an emittable option plan is the only way optionInfo reaches the body', () => {
  const optionInfo = { useStockManagement: false, optionSimple: [{ groupName: '색상 선택', name: '블랙', usable: true }] };
  const emittable = buildDryRunPackage({ readyRow: readyRow(), contentRow: contentRow({ optionPlan: { ...contentRow().optionPlan, status: 'complete', optionType: 'SINGLE', emittable: true, children: [{ groupName: '색상 선택', childName: '블랙', usable: true }], reasons: [] }, optionInfo }) });
  assert.deepEqual(emittable.body.originProduct.detailAttribute.optionInfo, optionInfo);
  assert.equal(emittable.problems.some((p) => p.field === 'optionInfo'), false, 'option info is not itself a gate');
  const partial = buildDryRunPackage({ readyRow: readyRow(), contentRow: contentRow({ optionPlan: { ...contentRow().optionPlan, status: 'partial', emittable: false }, optionInfo }) });
  assert.equal(partial.body.originProduct.detailAttribute.optionInfo, undefined, 'a truncated plan never becomes a payload');
});

test('every reason buildRegisterBody can raise has a declared owner and action', () => {
  const cases = [
    buildRegisterBody({ prodDes: '', price: { value: null }, stockQuantity: null, sellerManagementCode: 'x' }, {}),
    buildRegisterBody({ prodDes: 'P', price: { value: NCOM_LIMITS.salePriceMax + 1 }, stockQuantity: 1, sellerManagementCode: 'x' }, { leafCategoryId: '1', detailContent: '본문', images: { representative: 'https://x/y.png', uploadedViaImageApi: true } }),
    buildRegisterBody({ prodDes: 'P', price: { value: 1000 }, stockQuantity: NCOM_LIMITS.stockQuantityMax + 1, sellerManagementCode: 'x' }, { leafCategoryId: '1', detailContent: '본문', images: { representative: 'https://x/y.png', uploadedViaImageApi: true } }),
    buildRegisterBody({ prodDes: 'P', price: { value: 1000 }, stockQuantity: -3, sellerManagementCode: 'x' }, { leafCategoryId: '1', detailContent: '본문', images: { representative: 'https://x/y.png', uploadedViaImageApi: true } }),
    buildRegisterBody({ prodDes: 'P', price: { value: 1000 }, stockQuantity: 3, sellerManagementCode: 'x' }, { leafCategoryId: '1', detailContent: '본문', images: { representative: 'https://test.example/a.jpg' }, statusType: 'SALE' }),
  ];
  const emitted = new Set(cases.flatMap((c) => c.problems.map((p) => p.reason)));
  assert.ok(emitted.size >= 5, `the corpus must exercise the vocabulary, saw ${[...emitted]}`);
  for (const reason of emitted) {
    const doc = REGISTER_GATE_DOC[reason];
    assert.ok(doc, `${reason} is raised but not declared`);
    assert.ok(doc.owner && doc.meaning && doc.action && doc.field_authority, `${reason} needs owner, meaning, action and authority`);
  }
  assert.ok(REGISTER_GATE_DOC.duplicate_search_not_executed, 'the gate buildRegisterBody cannot see is declared anyway');
});

test('an undeclared gate reason is surfaced instead of silently dropping its owner', () => {
  const doc = REGISTER_GATE_DOC.out_of_bounds;
  delete REGISTER_GATE_DOC.out_of_bounds;
  try {
    const pkg = buildDryRunPackage({ readyRow: readyRow({ sale_price: String(NCOM_LIMITS.salePriceMax + 1000) }), contentRow: contentRow(), categoryRow: categoryRow() });
    assert.ok(pkg.problems.some((p) => p.field === 'salePrice' && p.reason === 'out_of_bounds'));
    assert.ok(pkg.problems.some((p) => p.reason === 'gate_reason_undeclared' && p.measured === 'out_of_bounds'), 'the undeclared refusal is named, with the reason that was missing');
  } finally {
    REGISTER_GATE_DOC.out_of_bounds = doc;
  }
  assert.equal(REGISTER_GATE_DOC.out_of_bounds, doc, 'the vocabulary comes back intact');
});

test('the package tripwires fire on the exact body defect each one names', () => {
  const rows = [
    readyRow(),
    readyRow({ cgi_id: 'test:2', sale_price: '', price_usable: 'no', naver_seller_management_code: 'TESTCODE0002' }),
  ];
  const clean = rows.map((row) => buildDryRunPackage({ readyRow: row, contentRow: contentRow({ cgiId: row.cgi_id }), categoryRow: categoryRow() }));
  const base = { packages: clean, readinessRows: rows, emittableOptionPlans: 0 };
  assert.deepEqual(findPackageViolations(base), [], 'the lane as written must be silent');
  assert.deepEqual(findPackageViolations({ ...base, duplicateSearchExecuted: true }), [], 'an executed search is not an error');

  const doctor = (mutate) => {
    const packages = JSON.parse(JSON.stringify(clean));
    mutate(packages);
    return findPackageViolations({ ...base, packages }).join('\n');
  };
  assert.match(doctor((p) => { p[0].body.originProduct.stockQuantity = 12; }), /test:1: 읽지 않은 재고 수량이 본문에 들어감/);
  assert.match(doctor((p) => { p[0].body.originProduct.detailContent = '승인 전 초안 본문'; }), /test:1: 승인되지 않은 상세 초안이 detailContent 로 들어감/);
  assert.match(doctor((p) => { p[0].body.originProduct.leafCategoryId = '50005167'; }), /test:1: 확인되지 않은 카테고리 ID 가 본문에 들어감/);
  assert.match(doctor((p) => { p[1].body.originProduct.salePrice = 189000; }), /test:2: 준비도가 거부한 가격을 본문에 실음/);
  assert.match(doctor((p) => { p[0].would_transmit = true; }), /test:1: 전송 후보로 표시됨/);
  assert.match(doctor((p) => { p[0].cgiId = 'test:9'; }), /test:9: 패키지가 준비도 행과 같은 순서에 있지 않음/);
  assert.match(doctor((p) => { p[0].problems.push({ field: 'name', reason: 'reason_nobody_declared' }); }), /test:1: 선언되지 않은 거부 사유 reason_nobody_declared/);
  assert.match(doctor((p) => { p[0].problems.push({ field: 'name', reason: 'gate_reason_undeclared', measured: 'reason_nobody_declared' }); }), /게이트 어휘에 없는 사유가 발생함/);
  assert.match(doctor((p) => { p[0].body.originProduct.detailAttribute.optionInfo = { optionSimple: [] }; }), /옵션 본문을 실은 패키지가 emittable 계획보다 많음: 1 > 0/);
  assert.match(doctor((p) => { p[0].problems = p[0].problems.filter((x) => x.reason !== 'duplicate_search_not_executed'); }), /중복 검색 미실행 사유가 전 상품에 표시되지 않음: 1\/2/);
  assert.match(findPackageViolations({ ...base, readinessRows: rows.slice(0, 1) }).join('\n'), /패키지 수와 준비도 행 수가 다름: 2 vs 1/);
});

test('the package census conserves products and never claims a transmittable body', () => {
  const packages = [
    buildDryRunPackage({ readyRow: readyRow(), contentRow: contentRow(), categoryRow: categoryRow() }),
    buildDryRunPackage({ readyRow: readyRow({ cgi_id: 'test:2', sale_price: '', price_usable: 'no', naver_seller_management_code: 'TESTCODE0002' }), contentRow: contentRow({ cgiId: 'test:2' }), categoryRow: categoryRow() }),
  ];
  const census = summarizeDryRunPackages(packages);
  assert.equal(census.products, 2);
  assert.equal(Object.values(census.status_by_products).reduce((a, b) => a + b, 0), 2);
  assert.equal(census.would_transmit_true, 0);
  assert.equal(census.undeclared_gate_reasons, 0);
  assert.equal(census.problems_total, packages.reduce((sum, p) => sum + p.problems.length, 0));
  assert.equal(Object.values(census.problems_by_field).reduce((a, b) => a + b, 0), census.problems_total, 'field tallies must sum to the problem list');
  assert.equal(Object.values(census.problems_by_reason).reduce((a, b) => a + b, 0), census.problems_total);
  assert.equal(Object.values(census.blocking_field_count_histogram).reduce((a, b) => a + b, 0), 2);
  assert.equal(census.values_in_bodies.leaf_category_ids, 0);
  assert.equal(census.values_in_bodies.detail_content, 0);
  assert.equal(census.values_in_bodies.stock_quantities, 0);
  assert.equal(census.values_in_bodies.images_from_upload_api, 0);
  assert.equal(census.values_in_bodies.duplicate_searches_executed, 0);
  assert.equal(census.transmitted, false);
  assert.equal(census.account_login, 'NO');
  assert.equal(census.naver_requests, 0);
  assert.equal(census.erp_requests, 0);
  assert.equal(census.live_writes, 0);
  assert.equal(census.precedence_claimed, false, 'the endpoint was never called, so no field is claimed to be refused first');
  assert.ok(census.rule.includes('9,999'));
});

test('the failure table aggregates by field and reason without product rows', () => {
  const packages = [
    buildDryRunPackage({ readyRow: readyRow(), contentRow: contentRow(), categoryRow: categoryRow() }),
    buildDryRunPackage({ readyRow: readyRow({ cgi_id: 'test:2', naver_seller_management_code: 'TESTCODE0002' }), contentRow: contentRow({ cgiId: 'test:2' }), categoryRow: categoryRow() }),
    buildDryRunPackage({ readyRow: readyRow({ cgi_id: 'test:3', naver_seller_management_code: 'TESTCODE0003', sale_price: '', price_usable: 'no' }), contentRow: contentRow({ cgiId: 'test:3' }), categoryRow: categoryRow() }),
  ];
  const rows = dryRunFailureRows(packages);
  assert.deepEqual(rows.map((r) => `${r.field}:${r.reason}`), [
    'detailContent:required_at_register',
    'images.representative:not_from_image_upload_api',
    'leafCategoryId:required_at_register',
    'salePrice:no_public_price',
    'sellerManagementCode:duplicate_search_not_executed',
    'stockQuantity:required_at_register',
  ], 'sorted by field then reason, one row per pair');
  assert.deepEqual(rows.map((r) => r.products), [3, 3, 3, 1, 3, 3]);
  assert.equal(rows.reduce((sum, r) => sum + r.products, 0), packages.reduce((sum, p) => sum + p.problems.length, 0));
  for (const row of rows) {
    assert.ok(row.owner && row.meaning && row.action, `${row.reason} reaches the CSV without an owner`);
    assert.ok(!/TEST| 이어폰/.test(JSON.stringify(row)), 'the failure table carries no supplier text');
  }
  const empty = dryRunFailureRows([]);
  assert.deepEqual(empty, []);
  assert.equal(summarizeDryRunPackages([]).products, 0);
  assert.deepEqual(summarizeDryRunPackages([]).status_by_products, {});
});

test('the package names the endpoint it would have called, as documented', () => {
  assert.equal(NCOM_ENDPOINTS.productRegister.method, 'POST');
  assert.equal(NCOM_ENDPOINTS.productRegister.path, '/v2/products');
  assert.equal(NCOM_ENDPOINTS.imageUpload.path, '/v1/product-images/upload', 'the image gate points at the endpoint that can satisfy it');
});
