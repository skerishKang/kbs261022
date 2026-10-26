// Unit tests for the Issue #95 readiness classifier, driven by synthetic
// fixtures. The point of these fixtures is falsifiability: the production run
// reports 0 registerable products and 4,575 rows needing a business decision,
// and every one of those counters has to move when the input moves. A fixture
// that is actually complete therefore must come out `ready` with zero API
// problems — if the code ever hardcodes the zeros, this file goes red.
//
// Fixtures go through parseCsv(toCsv(...)) exactly like the production files.
// That is not ceremony: buildMappingSet reads the ASCII aliases the header table
// adds (판매가 -> salePrice, 출고단가 -> outPrice, 등록상태 -> regStatus), so a
// plain object literal would test a join the real pipeline never performs.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyCatalog, missingEntries, summarizeClassification, toCsv, vatCheck, cgiIdOfMaster,
  REASONS, REASON_KINDS, STOREWIDE_POLICY_FIELDS, STOREWIDE_DECISION_CODES,
} from '../../lib/registration-readiness.mjs';
import { parseCsv, buildMappingSet } from '../../lib/product-mapping.mjs';
import { joinImageEvidence, probeKey } from '../../lib/naver-images.mjs';

const PREP_COLUMNS = ['공급처원본ID', '네이버상품ID', '상품명', '판매가', '가격확인필요', '재고수량', '대표이미지URL',
  '상세이미지수', '상세설명', '옵션수', '옵션SKU요약', '카테고리경로_CGI', '스마트스토어카테고리번호', '판매자코드',
  '등록상태', '누락필수값', '준비도', '원산지코드', '수입사', 'ASTemplateCode', '배송비', '반품교환정책', 'KC고시정보'];
const EXTENDED_COLUMNS = ['공급처원본ID', '품목코드', '상품명', '카페24품목코드', '공개판매가', '대표이미지'];
const UPLOAD_COLUMNS = ['품목코드', '품목명', '바코드', '규격', '단위', '품목구분', '재고수량관리', '출고단가',
  '부가세율(매출)', '검색창내용'];

/** A real 상세페이지 본문: markup plus well over the measured 187-character ceiling. */
const DETAIL_BODY = '<h2>SQ5+</h2><p>48채널 44버스 17페이더 디지털 믹서. 96kHz FPGA 처리, Dual FX 엔진 2개, '
  + '2채널 AES-51 입출력, 17개 물리 페이더로 라이브·설치·방송 어느 환경에서든 동일한 mix를 유지합니다. '
  + '96kHz 내부 처리와 ME 2계열, 12개 bus를 제공합니다.</p><ul><li>96kHz 내부 처리</li><li>ME 및 12개 bus</li></ul>';

const LEDGER = {
  1: { representative: 'https://prd-phinf.pstatic.net/mock/1.png', additional: [] },
  2: { representative: 'https://prd-phinf.pstatic.net/mock/2.png', additional: [] },
};
const ledgerFor = (ids) => ({ imageLedger: new Map(ids.map((id) => [`samasound.co.kr:${id}`, LEDGER[id]])) });

/**
 * Image evidence in the exact column shape of the committed join table
 * (reports/data/naver/image_measurements.csv). Fixtures build it through
 * joinImageEvidence — the same function production reads those files with — so a
 * test that claims "measured 440x440" cannot pass on a field name the CSV does
 * not carry.
 */
const representativeUrl = (site) => `https://www.${site}.co.kr/web/product/small/202607/abc.jpg`;
const measurementRow = (url, over = {}) => ({
  probe_key: probeKey(url), http_status: '200', container: 'jpeg', width: '1200', height: '1200', bytes: '180000',
  format_allowed: 'yes', meets_recommended_pixels: 'yes', reason_codes: 'image_bytes_measured;image_meets_recommended_pixels',
  header_variant: '', animation_indicator: 'no', ...over,
});
const variantRow = (url, over = {}) => ({
  probe_key: probeKey(url), base_width: '500', base_height: '500', variants_planned: '5', variants_attempted: '5',
  variants_answered: 'yes', variants_found: '0', variants_404: '5', larger_available: 'no', best_segment: 'representative',
  best_width: '500', best_height: '500', best_bytes: '9000', meets_recommended_now: 'no', ...over,
});
const DEFAULT_IMAGE = { width: '1200', height: '1200', meets_recommended_pixels: 'yes' };
/** `variant` present means the size-segment sweep ran for these URLs. */
const evidenceForPrep = (smartstoreRows, { measurement = {}, variant = null } = {}) => {
  const urls = [...new Set(smartstoreRows.map((row) => String(row.대표이미지URL || '').trim()).filter(Boolean))];
  const base = { ...DEFAULT_IMAGE, ...measurement };
  return joinImageEvidence(
    urls.map((url) => measurementRow(url, base)),
    variant ? urls.map((url) => variantRow(url, { base_width: base.width, base_height: base.height, ...variant })) : []
  );
};

const aliased = (rows, columns) => parseCsv(toCsv(rows, columns));

const master = ({ site = 'samasound', id = '1', name = '테스트', brand = 'B', manufacturer = 'M', model = 'MOD-1',
  price = '100000', priceText = '100,000원', priceState = 'public', status = '판매중', images = '3', options = '0',
  availability = '{"stock_number_displayed":"5","use_stock":true,"use_soldout":"T","is_reserve_stat":"N"}',
  sale = 'approved', category = '12' } = {}) => ({
  master_product_key: `|${name.toUpperCase()}`,
  source_site: site,
  source_site_label: `${site}.co.kr`,
  source_product_id: id,
  product_name: name,
  brand,
  manufacturer,
  model,
  category_id: category,
  category_name: '음향기기',
  public_price: price,
  public_price_text: priceText,
  public_price_state: priceState,
  sales_status: status,
  image_count: images,
  option_value_count: options,
  availability,
  source_url: `https://${site}.co.kr/web/product/ov.asp?product_code=${id}`,
  collected_at: '2026-07-10',
  verification_status: 'verified_against_source_page',
  cgi_sale_status: sale,
});

/** Defaults mirror the committed prep file: no category, no quantity, summary text, blank policies. */
const prep = ({ site = 'samasound', id = '1', name = '테스트', price = '100000', inquiry = '아니오', stock = '',
  detail = '48채널 44버스 17페이더 디지털 믹서', images = '2', options = '0', category = '', naverItemId = '',
  regStatus = '미등록', policy = false,
  representative = representativeUrl(site) } = {}) => ({
  공급처원본ID: `${site}:${id}`,
  네이버상품ID: naverItemId,
  상품명: name,
  판매가: price,
  가격확인필요: inquiry,
  재고수량: stock,
  대표이미지URL: representative,
  상세이미지수: images,
  상세설명: detail,
  옵션수: options,
  옵션SKU요약: '',
  카테고리경로_CGI: '음향기기',
  스마트스토어카테고리번호: category,
  판매자코드: `${site}:${id}`,
  등록상태: regStatus,
  누락필수값: '',
  준비도: 'partial',
  ...Object.fromEntries(STOREWIDE_POLICY_FIELDS.map((column) => [column, policy ? '확정됨' : ''])),
});

const extended = ({ site = 'samasound', id = '1', name = '테스트', cafe24 = '', publicPrice = '100000' } = {}) => ({
  공급처원본ID: `${site}:${id}`,
  품목코드: `${site === 'samasound' ? 'SS' : 'SM'}-${id}`,
  상품명: name,
  카페24품목코드: cafe24,
  공개판매가: publicPrice,
  대표이미지: '',
});

const upload = ({ site = 'samasound', id = '1', name = '테스트', barCode = '', outPrice = '100000' } = {}) => ({
  품목코드: `${site === 'samasound' ? 'SS' : 'SM'}-${id}`,
  품목명: name,
  바코드: barCode,
  규격: 'MOD-1',
  단위: 'EA',
  품목구분: '3',
  재고수량관리: '0',
  출고단가: outPrice,
  '부가세율(매출)': '10',
  검색창내용: '테스트',
});

const COMPARISON = { erp_total_items: 964, exact_code_matches: 0, name_exact_pairs: 1, model_exact_pairs: 25, candidate_pairs: 62 };

/**
 * One call site feeds both the join and the classifier, both through the real
 * header table, so a fixture can never drift from how production reads a file.
 */
function catalogue({ masters = [master()], preps = [prep()], extensions = [extended()], uploads = [upload()],
  erpMasterRows = [{ PROD_CD: 'SS-1', BAR_CODE: '' }] } = {}) {
  const extendedRows = aliased(extensions, EXTENDED_COLUMNS);
  const smartstoreRows = aliased(preps, PREP_COLUMNS);
  const uploadRows = aliased(uploads, UPLOAD_COLUMNS);
  return {
    masterRows: masters,
    smartstoreRows,
    extendedRows,
    uploadRows,
    records: buildMappingSet({ extendedRows, uploadRows, smartstoreRows, erpMasterRows }),
  };
}

/** A production-shaped single product: every real blocker present. */
const fixture = ({ name = '테스트', masterFields = {}, prepFields = {}, extendedFields = {}, uploadFields = {},
  erpMasterRows = [{ PROD_CD: 'SS-1', BAR_CODE: '' }], masters } = {}) => catalogue({
  masters: masters || [master({ name, ...masterFields })],
  preps: [prep({ name, ...prepFields })],
  extensions: [extended({ name, ...extendedFields })],
  uploads: [upload({ name, ...uploadFields })],
  erpMasterRows,
});

const COMPLETE_PREP = { category: '50005556', stock: '5', detail: DETAIL_BODY, policy: true };

/** A product whose inputs are genuinely complete: every gate has a value to read. */
const completeFixture = (over = {}) => fixture({
  ...over,
  prepFields: { ...COMPLETE_PREP, ...over.prepFields },
  uploadFields: { barCode: 'C24-1', ...over.uploadFields },
  extendedFields: { cafe24: 'C24-1', ...over.extendedFields },
});

/**
 * Fixtures are measured by default, the way production rows are: the committed
 * join table covers every supplier URL in the catalogue. "Never measured" is a
 * real state the classifier has to report, so a test opts into it explicitly with
 * `{ imageEvidence: new Map() }` instead of getting it by accident.
 */
const run = (input, extra = {}) => {
  const { evidence, ...rest } = extra;
  return classifyCatalog({
    optionRows: [],
    duplicateRows: [],
    comparison: COMPARISON,
    summary: { unique_item_codes: 1, duplicate_codes: 0 },
    imageEvidence: evidenceForPrep(input.smartstoreRows, evidence || {}),
    ...input,
    ...rest,
  });
};

/** Classify a complete product with its images already uploaded, return its row. */
const complete = (over = {}, extra = {}) => run(completeFixture(over), { ...ledgerFor([1]), ...extra }).rows[0];

const priceFixture = ({ price, priceText, priceState, inquiry = '아니오' }) => completeFixture({
  masterFields: { price, priceText, priceState },
  prepFields: { price, inquiry },
  extendedFields: { cafe24: 'C24-1', publicPrice: price },
});

test('fixtures read the prep columns through the header alias table, not by luck', () => {
  const record = completeFixture().records[0];
  assert.equal(record.price.value, 100000, '공개판매가/판매가 -> publicPrice -> price.value');
  assert.equal(record.outPrice, 100000, '출고단가 -> outPrice');
  assert.equal(record.taxRate, '10', '부가세율(매출) -> taxRate');
  assert.equal(record.unit, 'EA');
  assert.equal(record.prodType, '3');
  assert.equal(record.barCode, 'C24-1', '바코드 -> barCode');
  assert.equal(record.naverCategoryNo, '50005556', '스마트스토어카테고리번호 -> naverCategoryNo');
  assert.equal(record.stockQty, 5, '재고수량 -> stockQty');
  assert.equal(record.naverRegStatus, '미등록', '등록상태 -> regStatus');
  assert.equal(record.sellerManagementCode, 'samasound:1', '판매자코드 -> sellerManagementCode');
  assert.deepEqual(record.joins, { extended: true, upload: true, smartstore: true });
});

test('a genuinely complete product reaches ready with no API problem', () => {
  const { rows } = run(completeFixture(), ledgerFor([1]));
  const row = rows[0];
  assert.equal(rows.length, 1, 'one input row, one output row');
  assert.ok(DETAIL_BODY.length >= 200, `the body must clear the measured 187자 ceiling, saw ${DETAIL_BODY.length}`);
  assert.equal(row.missing_codes, '', 'nothing may be reported as missing on a complete row');
  assert.equal(row.bucket, 'ready', 'nothing may block a complete row');
  assert.equal(row.bucket_if_policy_defaults, 'ready');
  assert.equal(row.naver_register_problems, '', 'buildRegisterBody must find a transmittable payload');
  assert.equal(row.price_usable, 'yes');
  assert.equal(row.stock_quantity_confirmed, 'yes');
  assert.equal(row.erp_master_match, 'yes');
  assert.equal(row.join_complete, 'yes');
  assert.equal(row.naver_uploaded_image, LEDGER[1].representative);
  assert.equal(row.naver_registration_status, '미등록', 'the registration path is a measured fact, not a gap');
});

test('without the image-upload ledger the same product still demands the upload call', () => {
  const row = complete({}, { imageLedger: new Map() });
  assert.match(row.missing_codes, /image_external_host_upload_required/);
  assert.match(row.gap_codes, /image_meets_recommended_pixels/, 'the resolution claim has to come from bytes that were read');
  assert.equal(row.image_measured_state, 'ok');
  assert.match(row.naver_register_problems, /images\.representative:required/, 'no transmittable image exists before the upload call');
  assert.equal(row.bucket, 'supplement', 'an upload is a live call, so this is not a business decision');
});

test('a /small/ URL is not a thumbnail verdict — only the measured bytes are', () => {
  // Production measured the same /web/product/small/ shape at both 1000x1000 and
  // 440x440, so the path the classifier used to read is not evidence of anything.
  const sameUrl = complete({}, {}).representative_image_url;
  const adequate = complete({}, { evidence: { measurement: { width: '1000', height: '1000', bytes: '45561' } } });
  const short = complete({}, { evidence: { measurement: { width: '440', height: '440', meets_recommended_pixels: 'no', bytes: '18637' } } });
  assert.equal(adequate.representative_image_url, sameUrl);
  assert.equal(short.representative_image_url, sameUrl);
  assert.equal(short.image_measured_state, 'below_recommended', 'the same path measures short, so the note follows the bytes');
  assert.ok(!adequate.gap_codes.split(';').includes('image_below_recommended_pixels'));
  assert.match(short.missing_codes, /image_below_recommended_pixels/);
  for (const row of [adequate, short]) {
    assert.ok(!row.gap_codes.split(';').includes('image_thumbnail_variant_only'), 'the path-shape code must stay gone');
  }
});

test('removing only the ERP master match moves the row out of ready', () => {
  const row = complete({ erpMasterRows: [] });
  assert.equal(row.erp_master_match, 'no');
  assert.equal(row.erp_register_required, 'yes');
  assert.match(row.missing_codes, /erp_code_proposed_only/);
  assert.match(row.missing_codes, /erp_master_snapshot_absent/);
  assert.match(row.missing_codes, /erp_candidate_pairs_not_persisted/);
  assert.equal(row.bucket, 'supplement', 'an ERP read is all that is left, and that is not a business decision');
});

test('a store-wide policy gap is manual_review and the second bucket separates it', () => {
  const unanswered = complete({ prepFields: { policy: false } });
  assert.match(unanswered.blocker_codes_storewide_policy, /origin_code_absent/);
  assert.match(unanswered.blocker_codes_storewide_policy, /shipping_policy_absent/);
  assert.equal(unanswered.bucket, 'manual_review', 'missing 원산지/배송/AS/CK 정책 is a human decision, not data to fetch');
  assert.equal(unanswered.bucket_if_policy_defaults, 'ready', 'those six answers are one-off, so report what they unblock');

  const categoryGap = run(fixture(), ledgerFor([1])).rows[0];
  assert.match(categoryGap.blocker_codes_storewide_policy, /naver_leaf_category_absent/, 'the leaf category is answered per supplier category, not per product');
  assert.ok(!categoryGap.blocker_codes_product_specific.split(';').includes('naver_leaf_category_absent'));
  assert.ok(!categoryGap.blocker_codes_product_specific.split(';').includes('image_extra_over_api_max'), 'choosing which images to keep is per product');
  for (const code of STOREWIDE_DECISION_CODES) assert.ok(REASONS[code], `${code} must be declared`);
});

test('price reasons are distinguished, never collapsed into one 누락', () => {
  const cases = [
    { price: '', priceText: '1,000,000원', priceState: 'sold_out_sale_completed', inquiry: '예', code: 'price_sold_out_no_public_price' },
    { price: '', priceText: '출시임박', priceState: 'missing', inquiry: '예', code: 'price_absent_no_published_value' },
    { price: '', priceText: '전화문의', priceState: 'inquiry_price', inquiry: '예', code: 'price_inquiry_only' },
    { price: '2022', priceText: '2022년부터 제작 가능', priceState: 'public', code: 'price_value_untrusted_parse_artifact' },
    { price: '9999999990', priceText: '9,999,999,990원', priceState: 'public', code: 'price_over_naver_max' },
    { price: '100000', priceText: '100,000원', priceState: 'inquiry_price', code: 'price_numeric_but_inquiry_state' },
  ];
  for (const { code, ...fields } of cases) {
    const row = run(priceFixture(fields), ledgerFor([1])).rows[0];
    assert.match(row.missing_codes, new RegExp(code), `${code} must be the emitted reason for ${JSON.stringify(fields)}`);
    assert.equal(row.price_usable, 'no', `${code} may not be counted as a usable price`);
    assert.ok(row.bucket !== 'ready' && row.bucket !== 'blocked', `${code} is neither registerable nor a wire defect`);
  }
});

test('a numeric price in the master with a blank price in the prep files reports both reasons', () => {
  const row = complete({
    masterFields: { price: '362000', priceText: '362,000 전화문의', priceState: 'inquiry_price' },
    prepFields: { price: '', inquiry: '예' },
    extendedFields: { cafe24: 'C24-1', publicPrice: '' },
  });
  assert.match(row.missing_codes, /price_inquiry_only/);
  assert.match(row.missing_codes, /price_numeric_but_inquiry_state/, 'the two committed files disagree, and that is its own finding');
  assert.equal(row.price_usable, 'no');
});

test('the VAT check fails on a price that cannot carry 10% tax', () => {
  const ok = vatCheck(1680000, 10);
  assert.equal(ok.ok, true);
  assert.equal(ok.base, 1527273);
  assert.equal(ok.vat, 152727);
  assert.equal(ok.base + ok.vat, 1680000, 'the decomposition must sum back to the measured price');
  assert.ok(Math.abs(ok.vat / ok.base - 0.1) < 1e-6);

  assert.equal(vatCheck(5, 10).ok, false, '5원 cannot be a 10%-inclusive price');
  assert.equal(vatCheck(5, 10).reason, 'vat_decomposition_inconsistent');
  assert.equal(vatCheck(null, 10).reason, 'price_not_integer_won');

  const row = complete({
    masterFields: { price: '5', priceText: '5원' },
    prepFields: { price: '5' },
    extendedFields: { cafe24: 'C24-1', publicPrice: '5' },
  });
  assert.match(row.missing_codes, /vat_decomposition_inconsistent/);
  assert.equal(row.vat_base, '');
  assert.equal(row.vat_amount, '');
});

test('a missing product name or image is blocked, not merely incomplete', () => {
  assert.equal(complete({ name: '' }).bucket, 'blocked');

  const noImage = complete({ masterFields: { images: '0' }, prepFields: { representative: '', images: '0' } });
  assert.equal(noImage.bucket, 'blocked');
  assert.match(noImage.missing_codes, /image_representative_blank/);
});

test('an over-long 품목명 fails the vendor column gate and blocks registration', () => {
  const tooLong = complete({ name: '가'.repeat(101) });
  assert.equal(tooLong.erp_wire_validation, 'invalid:PROD_DES');
  assert.equal(tooLong.bucket, 'blocked', 'a row the vendor would reject must not be sold as registerable');
  assert.match(tooLong.missing_codes, /erp_wire_invalid/);

  const atCap = complete({ name: '나'.repeat(100) });
  assert.match(atCap.missing_codes, /product_name_at_100_char_cap/, 'exactly 100자 passes the wire but needs a trim decision');
  assert.equal(atCap.erp_wire_validation, 'ok');
});

test('stock reasons separate displayed-unverified, zero, unmanaged and absent', () => {
  const cases = [
    { availability: '{"stock_number_displayed":"65","use_stock":true,"use_soldout":"T","is_reserve_stat":"N"}', code: 'stock_displayed_positive_unverified', bucket: 'supplement' },
    { availability: '{"stock_number_displayed":"0","use_stock":true,"use_soldout":"F","is_reserve_stat":"N"}', code: 'stock_displayed_zero', bucket: 'supplement' },
    { availability: '{"stock_number_displayed":"0","use_stock":false,"use_soldout":"F","is_reserve_stat":"N"}', code: 'stock_displayed_but_supplier_unmanaged', bucket: 'supplement' },
    { availability: '{"stock_number_displayed":null,"use_stock":null,"use_soldout":null,"is_reserve_stat":null}', code: 'availability_fields_absent', bucket: 'manual_review' },
    { availability: '', code: 'availability_fields_absent', bucket: 'manual_review' },
  ];
  for (const { availability, code, bucket } of cases) {
    const row = complete({ masterFields: { availability }, prepFields: { stock: '' } });
    assert.match(row.missing_codes, new RegExp(code), `${code} must be emitted for ${JSON.stringify(availability)}`);
    assert.match(row.missing_codes, /stock_requires_erp_balance_read/);
    assert.equal(row.stock_quantity_confirmed, 'no');
    assert.equal(row.bucket, bucket, 'a supplier display value is never a confirmed quantity');
  }
});

test('image reasons: 9-image cap, count divergence, ledger removal', () => {
  const overCap = complete({ masterFields: { images: '20' }, prepFields: { images: '5' } });
  assert.match(overCap.missing_codes, /image_extra_over_api_max/, '20 images cannot fit 1 representative + 9 additional');
  assert.match(overCap.missing_codes, /image_count_delta_not_one/, 'master 20 vs prep 5 is a pipeline inconsistency');
  assert.equal(overCap.image_extension, 'jpg');

  const detailZero = complete({ masterFields: { images: '1' }, prepFields: { images: '0' } });
  assert.match(detailZero.missing_codes, /image_detail_count_zero/);

  const uploaded = complete();
  assert.ok(!uploaded.gap_codes.split(';').includes('image_external_host_upload_required'), 'an uploaded product drops the upload reason');
});

test('every image verdict comes from the measured bytes, and each state has its own code', () => {
  const rescued = complete({}, { evidence: {
    measurement: { width: '440', height: '440', meets_recommended_pixels: 'no' },
    variant: { variants_found: '2', variants_404: '3', larger_available: 'yes', best_segment: 'big', best_width: '1000', best_height: '1000', best_bytes: '45561', meets_recommended_now: 'yes' },
  } });
  assert.match(rescued.gap_codes, /image_larger_segment_meets/);
  assert.ok(!rescued.gap_codes.split(';').includes('image_below_recommended_pixels'), 'a rescued segment must not keep the short note');
  assert.equal(rescued.image_measured_state, 'ok_via_segment');
  assert.equal(rescued.image_best_segment, 'big');
  assert.equal(rescued.image_width_measured, 1000);
  assert.equal(rescued.image_size_bytes_measured, 45561);

  const stillShort = complete({}, { evidence: {
    measurement: { width: '500', height: '500', meets_recommended_pixels: 'no' },
    variant: { variants_found: '1', variants_404: '4', larger_available: 'yes', best_segment: 'big', best_width: '800', best_height: '800', meets_recommended_now: 'no' },
  } });
  assert.match(stillShort.missing_codes, /image_larger_segment_still_small/);
  assert.equal(stillShort.image_width_measured, 800, 'the largest file that exists is what the operator gets to choose from');

  const noLarger = complete({}, { evidence: {
    measurement: { width: '500', height: '500', meets_recommended_pixels: 'no' },
    variant: {},
  } });
  assert.match(noLarger.missing_codes, /image_no_larger_segment_measured/, 'every bigger segment answered 404, so the supplier has nothing larger');
  assert.equal(REASONS.image_no_larger_segment_measured.kind, 'not_published_by_source', 'a supplier limit is not our data defect');

  const partial = complete({}, { evidence: {
    measurement: { width: '500', height: '500', meets_recommended_pixels: 'no' },
    variant: { variants_answered: 'no', larger_available: 'not_measured', meets_recommended_now: 'not_measured' },
  } });
  assert.match(partial.missing_codes, /image_size_segment_not_fully_measured/, 'an unfinished sweep is withheld, never read as a negative');
  assert.ok(!partial.gap_codes.split(';').includes('image_no_larger_segment_measured'), 'a partial run may not claim the supplier has nothing bigger');

  const nonSquare = complete({}, { evidence: { measurement: { width: '1538', height: '1537', meets_recommended_pixels: 'no' } } });
  assert.match(nonSquare.gap_codes, /image_non_square_measured/);
  assert.equal(nonSquare.image_measured_state, 'below_recommended');

  const webp = complete({}, { evidence: { measurement: { container: 'webp', format_allowed: 'yes' } } });
  assert.match(webp.missing_codes, /image_format_not_allowed/, 'the allow-list is recomputed from the container, so a yes flag cannot fake a pass');
  assert.equal(webp.image_measured_state, 'format_rejected');

  const animated = complete({}, { evidence: { measurement: { container: 'gif', animation_indicator: 'yes' } } });
  assert.match(animated.missing_codes, /image_gif_animation_indicator/);
});

test('an image that was never measured, unreachable, or answered 404 is each stated separately', () => {
  const unmeasured = complete({}, { imageEvidence: new Map() });
  assert.match(unmeasured.missing_codes, /image_measurement_missing/);
  assert.equal(unmeasured.image_measured_state, 'unmeasured');
  assert.ok(!unmeasured.gap_codes.split(';').includes('image_below_recommended_pixels'), 'no measurement may borrow a neighbour verdict');

  const unreachable = complete({}, { evidence: { measurement: { http_status: '0', container: '', width: '', height: '', bytes: '', format_allowed: '' } } });
  assert.match(unreachable.missing_codes, /image_probe_not_fetched/);
  assert.equal(unreachable.image_measured_state, 'unreachable');

  const gone = complete({}, { evidence: { measurement: { http_status: '404', container: '', width: '', height: '', bytes: '', format_allowed: '' } } });
  assert.match(gone.missing_codes, /image_probe_http_error/);
  assert.equal(gone.image_measured_state, 'http_error');

  const html = complete({}, { evidence: { measurement: { container: '', width: '1200', height: '1200' } } });
  assert.match(html.missing_codes, /image_bytes_unreadable/, 'a 200 whose body is not an image header is a defect, not a 1200x1200 file');
  assert.equal(html.image_measured_state, 'unreadable');
});

test('상세설명 is judged on its content, not assumed missing', () => {
  assert.match(complete({ prepFields: { detail: '' } }).missing_codes, /detail_content_absent/);
  assert.match(complete({ prepFields: { detail: '신형 Qu-6' } }).missing_codes, /detail_content_summary_only/);
  const markup = complete({ prepFields: { detail: '<p>짧은 본문</p>' } });
  assert.match(markup.gap_codes, /detail_content_present/, 'markup is an authored page even when short');
  assert.equal(markup.missing_codes, '');
  assert.equal(markup.bucket, 'ready');
});

const pairRows = (verdict, conflict) => [{
  판정: verdict,
  자동병합가능: verdict === 'confirmed' ? '예' : '아니오',
  출처: 'issue8_master',
  왼쪽통합키: 'samasound.co.kr:1',
  오른쪽통합키: 'samasound.co.kr:2',
  왼쪽상품명: '테스트',
  오른쪽상품명: '둘째상품',
  왼쪽브랜드: 'B',
  오른쪽브랜드: 'B',
  왼쪽모델명: 'MOD-1',
  오른쪽모델명: 'MOD-2',
  공통모델표현: 'SET',
  이름유사도: '0.9',
  변형충돌: conflict,
  브랜드값일치: '예',
  사유: '중복',
  조치: '검토 대기',
}];

const twoProductFixture = () => catalogue({
  masters: [master(), master({ id: '2', name: '둘째상품', model: 'MOD-2' })],
  preps: [prep(COMPLETE_PREP), prep({ ...COMPLETE_PREP, id: '2', name: '둘째상품' })],
  extensions: [extended({ cafe24: 'C24-1' }), extended({ id: '2', name: '둘째상품', cafe24: 'C24-2' })],
  uploads: [upload({ barCode: 'C24-1' }), upload({ id: '2', name: '둘째상품', barCode: 'C24-2' })],
  erpMasterRows: [{ PROD_CD: 'SS-1', BAR_CODE: 'C24-1' }, { PROD_CD: 'SS-2', BAR_CODE: 'C24-2' }],
});
const twoLedgers = { imageLedger: new Map([['samasound.co.kr:1', LEDGER[1]], ['samasound.co.kr:2', LEDGER[2]]]) };

test('duplicate pairs reach both sides and carry the committed verdict', () => {
  const exact = run(twoProductFixture(), { ...twoLedgers, duplicateRows: pairRows('same_site_exact', '아니오') });
  assert.equal(exact.rows.length, 2);
  for (const row of exact.rows) {
    assert.match(row.missing_codes, /duplicate_pair_same_site_exact/);
    assert.equal(row.duplicate_pair_count, 1);
    assert.equal(row.bucket, 'manual_review', 'a double registration would create two 품목 and two 네이버 products, so a human merges or splits first');
  }

  const conflict = run(twoProductFixture(), { ...twoLedgers, duplicateRows: pairRows('confirmed', '예') });
  assert.match(conflict.rows[0].missing_codes, /duplicate_pair_confirmed/);
  assert.match(conflict.rows[0].missing_codes, /duplicate_variant_conflict/);
  assert.match(conflict.rows[0].missing_codes, /duplicate_action_pending/);
  assert.equal(conflict.rows[0].duplicate_variant_conflict, 'yes');
  assert.equal(conflict.rows[0].bucket, 'manual_review', '변형 충돌 is a human call, never an automatic merge');
});

test('model collisions distinguish same-site sharing from cross-supplier sharing', () => {
  const sameSite = run(fixture({ masters: [master(), master({ id: '2', model: 'MOD-1' })] }), ledgerFor([1])).rows[0];
  assert.match(sameSite.missing_codes, /model_shared_by_multiple_products/);
  assert.ok(!sameSite.gap_codes.includes('model_shared_across_suppliers'), 'one supplier is not a cross-supplier collision');

  const twoSuppliers = run(fixture({ masters: [master(), master({ id: '3', site: 'samamusic', model: 'MOD-1' })] }), ledgerFor([1])).rows[0];
  assert.match(twoSuppliers.missing_codes, /model_shared_across_suppliers/, 'the same model at two suppliers becomes two products');
  assert.equal(twoSuppliers.bucket, 'manual_review');
});

test('barcode handling reports the intentional drop separately from an absent code', () => {
  const dropped = complete({ uploadFields: { barCode: '' }, extendedFields: { cafe24: 'C24-DUP' } });
  assert.equal(dropped.erp_barcode, '');
  assert.match(dropped.missing_codes, /erp_barcode_dropped_duplicate/);

  const absent = complete({ uploadFields: { barCode: '' }, extendedFields: { cafe24: '' } });
  assert.match(absent.missing_codes, /erp_barcode_absent/);

  const kept = complete();
  assert.equal(kept.erp_barcode, 'C24-1');
  assert.match(kept.gap_codes, /erp_barcode_unique_kept/);
});

test('option gaps count rows, not just products', () => {
  const row = run(completeFixture({ masterFields: { options: '2' }, prepFields: { options: '3' } }), {
    ...ledgerFor([1]),
    optionRows: [
      { source_site: 'samasound', source_product_id: '1', option_group: 'main', option_name: '검정', option_price: '', option_item_code: '' },
      { source_site: 'samasound', source_product_id: '1', option_group: 'main', option_name: '흰색', option_price: '5000', option_item_code: 'X-1' },
    ],
  }).rows[0];
  assert.equal(row.option_rows, 2);
  assert.equal(row.option_rows_missing_price, 1);
  assert.equal(row.option_rows_missing_item_code, 1);
  assert.match(row.missing_codes, /option_price_undifferentiated/);
  assert.match(row.missing_codes, /option_item_code_absent/);
  assert.match(row.missing_codes, /option_count_columns_diverge/, 'master says 2, prep says 3 — that disagreement is a defect');
  assert.equal(row.bucket, 'manual_review', 'two committed files disagreeing is a data defect');
});

test('a product absent from the prep files is reported as an incomplete join, not silently classified', () => {
  const row = run(catalogue({ preps: [] }), ledgerFor([1])).rows[0];
  assert.equal(row.join_complete, 'no');
  assert.match(row.missing_codes, /detail_content_absent/);
  assert.match(row.missing_codes, /image_representative_blank/);
  assert.equal(row.bucket, 'blocked');
});

test('an already-registered product is a modify decision, an absent product id is not a blocker', () => {
  const registered = complete({ prepFields: { regStatus: '판매중', naverItemId: '500001' } });
  assert.match(registered.missing_codes, /naver_item_already_registered/);
  assert.match(registered.gap_codes, /naver_product_id_present/);
  assert.equal(registered.bucket, 'manual_review', 'registering it again would create a second product');

  const unknown = complete({ prepFields: { regStatus: '' } });
  assert.match(unknown.missing_codes, /naver_registered_status_absent/);
  assert.equal(unknown.bucket, 'supplement');

  const fresh = complete();
  assert.ok(fresh.gap_codes.includes('naver_product_id_absent'), 'a new product has no 상품ID yet — that is the registration path');
  assert.ok(!fresh.missing_codes.includes('naver_product_id_absent'), 'it may not be counted as missing data');
});

test('every emitted reason code is declared, with a declared kind', () => {
  const { rows } = run(catalogue({
    masters: [master({ brand: '', manufacturer: '', model: '', sale: 'unapproved', status: '미확인' }), master({ id: '9', site: 'samamusic' })],
    preps: [prep(), prep({ id: '9', site: 'samamusic' })],
    extensions: [extended(), extended({ id: '9', site: 'samamusic' })],
    uploads: [upload(), upload({ id: '9', site: 'samamusic' })],
    erpMasterRows: [],
  }));
  const codes = new Set(rows.flatMap((row) => row.gap_codes.split(';')).filter(Boolean));
  assert.ok(codes.size > 10, `the fixture must exercise a wide slice of the vocabulary, saw ${codes.size}`);
  for (const code of codes) {
    const meta = REASONS[code];
    assert.ok(meta, `${code} is emitted but not declared in REASONS`);
    assert.ok(REASON_KINDS.includes(meta.kind), `${code} has an undeclared kind ${meta.kind}`);
    assert.ok(meta.meaning && meta.field && meta.owner, `${code} needs field, owner and meaning`);
  }
});

test('missingEntries splits blockers into store-wide policy and product-specific', () => {
  const { rows } = run(fixture());
  const entries = missingEntries(rows);
  const policy = entries.filter((e) => e.scope === 'storewide_policy');
  const own = entries.filter((e) => e.scope === 'product_specific');
  assert.ok(policy.length > 0 && own.length > 0);
  assert.deepEqual([...new Set(policy.map((e) => e.reason_code))].sort(), rows[0].blocker_codes_storewide_policy.split(';').sort());
  assert.ok(own.some((e) => e.reason_code === 'detail_content_summary_only'));
  assert.ok(own.every((e) => !STOREWIDE_DECISION_CODES.includes(e.reason_code)), 'a per-product list must not carry store-wide questions');
  assert.equal(entries[0].product_name, '테스트', 'the private artifact keeps the name for filtering');
  assert.ok(entries.every((e) => e.meaning && e.owner), 'a reason without an owner is an unanswered question');
});

test('the summary conserves inputs, buckets and the long table', () => {
  const { rows } = run(fixture());
  const missing = missingEntries(rows);
  const stats = summarizeClassification({
    rows,
    missing,
    inputs: { masterRows: 1, records: 1, optionRows: 0, duplicateRows: 0 },
    comparison: COMPARISON,
    summary: { unique_item_codes: 1, duplicate_codes: 0 },
  });
  assert.equal(stats.products_classified, 1);
  assert.equal(stats.conservation.input_equals_output, true);
  assert.equal(Object.values(stats.buckets).reduce((a, b) => a + b, 0), 1);
  assert.equal(stats.missing_entries, missing.length);
  assert.equal(Object.values(stats.reason_codes).reduce((a, b) => a + b, 0), missing.length, 'the reason tally must sum to the long table');
  assert.equal(stats.duplicates.pair_references_from_both_sides, 0);
  assert.equal(stats.inputs.master_rows, 1);
  assert.equal(stats.erp.candidate_pairs_aggregate, 62);
  const storewide = Object.values(stats.blockers_by_scope.storewide_policy).reduce((a, b) => a + b, 0);
  const own = Object.values(stats.blockers_by_scope.product_specific).reduce((a, b) => a + b, 0);
  assert.equal(storewide + own, rows[0].missing_codes.split(';').filter(Boolean).length, 'the two scope tallies must sum to the blocker column');
  assert.deepEqual(stats.naver.registration_status_counts, { 미등록: 1 }, 'the prep files own the 등록상태 column, so the tally must show what they say');
  assert.equal(stats.detail_content.judged_at_or_above_chars, 200);
  assert.equal(stats.detail_content.max_chars, rows[0].detail_content_chars);
});

test('the CSV writer survives Korean names with commas, quotes and newlines, and round-trips', () => {
  const nasty = 'SHURE SE846, "GEN2"\n클리어/그린';
  const csv = toCsv([{ cgi_id: 'a', product_name: nasty, plain: 0 }], ['cgi_id', 'product_name', 'plain']);
  assert.ok(csv.startsWith('﻿'), 'Excel needs the BOM to read UTF-8');
  const back = parseCsv(csv);
  assert.equal(back.length, 1);
  assert.equal(back[0].product_name, nasty);
  assert.ok(csv.includes(`"${nasty.replace(/"/g, '""')}"`), 'embedded quotes must be doubled');
  assert.equal(toCsv([], ['a', 'b']), '﻿a,b\r\n', 'a zero-row artifact still carries its header');
});

test('catalogue id construction reuses the join alias table', () => {
  assert.equal(cgiIdOfMaster(master({ site: 'samasound', id: '3836' })), 'samasound.co.kr:3836');
  assert.equal(cgiIdOfMaster(master({ site: 'samamusic', id: '2574' })), 'samamusic.co.kr:2574');
  assert.equal(cgiIdOfMaster(master({ site: 'samasound.co.kr', id: '1' })), 'samasound.co.kr:1');
});

test('rows come out in a stable order so restart keys line up', () => {
  const ids = ['1', '2', '3'];
  const input = catalogue({
    masters: ids.map((id) => master({ id })),
    preps: ids.map((id) => prep({ id })),
    extensions: ids.map((id) => extended({ id, cafe24: `C-${id}` })),
    uploads: ids.map((id) => upload({ id, barCode: `C-${id}` })),
    erpMasterRows: ids.map((id) => ({ PROD_CD: `SS-${id}`, BAR_CODE: `C-${id}` })),
  });
  assert.equal(input.records[0].naverCategoryNo, null, 'the production-shaped prep default carries no leaf category');
  input.records.reverse();
  const first = run(input, ledgerFor([1, 2, 3]));
  const second = run(input, ledgerFor([1, 2, 3]));
  assert.deepEqual(first.rows.map((r) => r.cgi_id), ['samasound.co.kr:1', 'samasound.co.kr:2', 'samasound.co.kr:3']);
  assert.deepEqual(first.rows, second.rows, 'the same input must produce the same rows');
  assert.deepEqual([...new Set(first.rows.map((r) => r.erp_dedupe_key))].sort(),
    ['saveBasicProduct:PROD_CD:SS-1', 'saveBasicProduct:PROD_CD:SS-2', 'saveBasicProduct:PROD_CD:SS-3']);
});
