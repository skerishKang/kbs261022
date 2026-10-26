/**
 * CGI LOCAL 2 step ⑥ — the dry-run registration package.
 *
 * A package is the exact `POST /v2/products` body this catalogue would produce for
 * one product, assembled from nothing but the source columns, plus every documented
 * local gate that rejects it. Nothing here is transmittable: the lane cannot log in,
 * so the four values the vendor requires and nobody has supplied — leafCategoryId,
 * detailContent, a counted stockQuantity, and an image URL that came back from
 * POST /v1/product-images/upload — stay absent, and the run says so per product.
 *
 * Why a separate module rather than another pass over the readiness classifier: the
 * classifier answers "what is missing", this answers "what would be sent and which
 * documented check stops it". Both read the same rows, and the package body is built
 * by the same buildRegisterBody the real register lane would call, so a package that
 * passes here is a package that would pass there — and none of them do.
 *
 * No precedence between the blocking fields is claimed. The register endpoint was
 * never called, so which field Naver reports first is unknown; only the per-field
 * counts are measured.
 */

import { buildRegisterBody, NCOM_LIMITS } from './ncommerce.mjs';

/**
 * The problem reasons buildRegisterBody can emit, plus the one gate it cannot know
 * about (search-before-register, because 판매자관리코드 does not guarantee
 * uniqueness). Every emitted reason must be declared here or the run refuses to
 * write — an undeclared reason would reach the CSV with no owner and no action.
 */
export const REGISTER_GATE_DOC = {
  required_at_register: { field_authority: 'POST /v2/products originProduct', owner: '운영자 확인 후 수집', meaning: '실등록 시 필수인 값인데 카탈로그 어디에도 없다.', action: '값을 수집할 수 있는 유일한 경로를 실행한 뒤 다시 계산한다.' },
  required: { field_authority: 'POST /v2/products originProduct', owner: '상품 데이터', meaning: '본문이 비어 있다.', action: '원천 컬럼을 확인하고 채워진다.' },
  no_public_price: { field_authority: 'originProduct.salePrice', owner: '공급처', meaning: '공개 판매가가 없는 상품이다.', action: '문의가 전용인지 확인 — 가격이 API 본문에 들어갈 수 없다.' },
  out_of_bounds: { field_authority: 'NCOM_LIMITS', owner: '우리 쪽 검증', meaning: '문서에 적힌 상한을 넘는다.', action: '등록할 수 없는 상품으로 남긴다.' },
  negative: { field_authority: 'originProduct.stockQuantity', owner: 'ERP', meaning: '재고가 음수다.', action: '음수 재고는 OUTOFSTOCK/usable=false 로 표현한다.' },
  not_from_image_upload_api: { field_authority: 'originProduct.images.representative', owner: '이미지 업로드 API', meaning: '공급처 호스트 직접 링크는 거부된다. 업로드 API가 돌려준 URL만 허용.', action: '이미지 준비 파이프라인의 업로드 응답을 사용한다.' },
  only_SALE_at_register: { field_authority: 'originProduct.statusType', owner: '우리 쪽 검증', meaning: '등록 시 상태는 SALE만 허용.', action: '상태 값을 바로잡는다.' },
  price_untrusted_by_readiness: { field_authority: 'CGI 준비도 레인', owner: '우리 쪽 검증', meaning: '공급처에 숫자가 적혀 있지만 준비도 레인이 파싱 산물로 거부한 값이라 등록 본문에 넣지 않는다.', action: '공급처 원문 가격을 확인해 다시 수집한다.' },
  duplicate_search_not_executed: { field_authority: 'SELLER_CODE search', owner: '등록 레인', meaning: '네이버는 판매자관리코드 고유성을 보장하지 않아, 등록 전 검색이 따로 필요하다.', action: '인증된 검색을 상품별로 실행한다.' },
  gate_reason_undeclared: { field_authority: 'this module', owner: '우리 쪽 결함', meaning: '거부 사유가 이 어휘에 선언되지 않은 채 발생했다.', action: '이 레인을 고치지 말고 사유를 선언하고 재계산한다.' },
};

const GATES = [
  'leafCategoryId', 'detailContent', 'stockQuantity', 'images.representative', 'salePrice', 'name', 'statusType', 'sellerManagementCode',
];

/**
 * One product -> one package. `contentRow` comes from the content lane (option plan
 * and detail draft), `categoryRow` from the committed candidate table, `readyRow` from
 * the readiness classifier. Every value that enters the body is copied from one of
 * those three, and each is labelled with where it came from.
 */
export function buildDryRunPackage({ readyRow, contentRow = null, categoryRow = null, duplicateSearchExecuted = false }) {
  const problems = [];
  const evidence = {};

  const leafCategoryId = categoryRow && categoryRow.confirmed === 'yes' ? String(categoryRow.candidate_leaf_category_ids || '') : '';
  if (categoryRow) {
    evidence.category = { path: categoryRow.category_path, kind: categoryRow.path_kind, status: categoryRow.status, confirmed: categoryRow.confirmed, candidates: (categoryRow.candidate_leaf_category_ids || '').split('|').filter(Boolean) };
  }

  // The content lane's draft is real text but explicitly does not satisfy
  // detailContent, so it is reported as available and never passed as the body value.
  const detailContent = null;
  evidence.detail = contentRow
    ? { draft_available: true, counts_as_detail_content: contentRow.detailDraft.counts_as_detail_content, operator_approval_required: contentRow.detailDraft.operator_approval_required, missing: contentRow.detailDraft.reasons }
    : { draft_available: false };

  const optionInfo = contentRow && contentRow.optionPlan.emittable ? contentRow.optionInfo : null;
  evidence.option = contentRow
    ? { status: contentRow.optionPlan.status, option_type: contentRow.optionPlan.optionType, emittable: contentRow.optionPlan.emittable, children: contentRow.optionPlan.children.length, reasons: contentRow.optionPlan.reasons }
    : { status: 'not_planned' };

  // A counted quantity does not exist in this catalogue (measured: 0 of 4,575
  // 재고수량 cells), so the body is assembled with stockQuantity absent rather than
  // with the 9,999 that useStockManagement=false would auto-publish.
  const stockQuantity = null;
  // The readiness lane refuses one published price as an untrusted parse artifact.
  // A package that would send a number our own classifier refused is not a dry run, so
  // the value is dropped here and the refusal is named — the delta against the
  // readiness tally is then a measured count rather than a silent disagreement.
  const priceTrusted = readyRow.price_usable === 'yes';
  const built = buildRegisterBody(
    {
      prodDes: readyRow.product_name,
      price: { value: priceTrusted && readyRow.sale_price !== '' ? Number(readyRow.sale_price) : null, state: priceTrusted ? 'public' : 'unknown' },
      stockQuantity,
      sellerManagementCode: readyRow.naver_seller_management_code,
    },
    {
      leafCategoryId,
      detailContent,
      optionInfo,
      images: {
        representative: readyRow.naver_uploaded_image || readyRow.representative_image_url || '',
        additional: [],
        uploadedViaImageApi: Boolean(readyRow.naver_uploaded_image),
      },
    },
  );
  problems.push(...built.problems);
  if (!priceTrusted && String(readyRow.sale_price ?? '') !== '') {
    problems.push({ field: 'salePrice', reason: 'price_untrusted_by_readiness', measured: readyRow.sale_price });
  }
  if (!duplicateSearchExecuted) problems.push({ field: 'sellerManagementCode', reason: 'duplicate_search_not_executed' });
  evidence.image = {
    representative_is_upload_api_url: Boolean(readyRow.naver_uploaded_image),
    measured_state: readyRow.image_measured_state,
    supplier_url_present: Boolean(readyRow.representative_image_url),
  };
  evidence.stock = { numeric_in_catalogue: readyRow.stock_quantity_confirmed === 'yes', used_the_documented_auto_set: false };

  const undeclared = [];
  for (const problem of problems) {
    if (!REGISTER_GATE_DOC[problem.reason]) undeclared.push({ field: problem.field, reason: problem.reason });
  }
  if (undeclared.length) {
    for (const item of undeclared) problems.push({ field: item.field, reason: 'gate_reason_undeclared', measured: item.reason });
  }
  const blockingFields = GATES.filter((field) => problems.some((p) => p.field === field));
  return {
    cgiId: readyRow.cgi_id,
    productName: readyRow.product_name,
    sellerManagementCode: readyRow.naver_seller_management_code,
    body: built.body,
    problems,
    blocking_fields: blockingFields,
    blocking_field_count: blockingFields.length,
    status: problems.length === 0 ? 'awaiting_operator_approval' : 'blocked',
    would_transmit: false,
    execute: false,
    transmitted: false,
    evidence,
    bucket: readyRow.bucket,
    note: '이 패키지는 실등록 준비 확인용이며 전송되지 않는다. values 는 원천 컬럼 사본이거나 결측 사유이다.',
  };
}

/** Tripwires for a future edit that lets a real value into a body; tested directly, since no current input can trip them. */
export function findPackageViolations({ packages = [], readinessRows = [], emittableOptionPlans = null, duplicateSearchExecuted = false }) {
  const violations = [];
  if (packages.length !== readinessRows.length) violations.push(`패키지 수와 준비도 행 수가 다름: ${packages.length} vs ${readinessRows.length}`);
  if (emittableOptionPlans != null) {
    const withOptions = packages.filter((p) => p.body.originProduct.detailAttribute.optionInfo).length;
    if (withOptions > emittableOptionPlans) violations.push(`옵션 본문을 실은 패키지가 emittable 계획보다 많음: ${withOptions} > ${emittableOptionPlans}`);
  }
  packages.forEach((pkg, index) => {
    const readyRow = readinessRows[index] || {};
    if (pkg.cgiId !== readyRow.cgi_id) violations.push(`${pkg.cgiId}: 패키지가 준비도 행과 같은 순서에 있지 않음`);
    if (pkg.would_transmit !== false || pkg.execute !== false || pkg.transmitted !== false) violations.push(`${pkg.cgiId}: 전송 후보로 표시됨`);
    if (pkg.body.originProduct.stockQuantity != null) violations.push(`${pkg.cgiId}: 읽지 않은 재고 수량이 본문에 들어감`);
    if (pkg.body.originProduct.detailContent) violations.push(`${pkg.cgiId}: 승인되지 않은 상세 초안이 detailContent 로 들어감`);
    if (pkg.body.originProduct.leafCategoryId) violations.push(`${pkg.cgiId}: 확인되지 않은 카테고리 ID 가 본문에 들어감`);
    if (pkg.body.originProduct.salePrice != null && readyRow.price_usable !== 'yes') violations.push(`${pkg.cgiId}: 준비도가 거부한 가격을 본문에 실음`);
    for (const problem of pkg.problems) {
      if (!REGISTER_GATE_DOC[problem.reason]) violations.push(`${pkg.cgiId}: 선언되지 않은 거부 사유 ${problem.reason}`);
      if (problem.reason === 'gate_reason_undeclared') violations.push(`${pkg.cgiId}: 게이트 어휘에 없는 사유가 발생함 (${problem.measured})`);
    }
  });
  if (!duplicateSearchExecuted) {
    const unsearched = packages.filter((p) => p.problems.some((x) => x.field === 'sellerManagementCode' && x.reason === 'duplicate_search_not_executed')).length;
    if (unsearched !== packages.length) violations.push(`중복 검색 미실행 사유가 전 상품에 표시되지 않음: ${unsearched}/${packages.length}`);
  }
  return violations;
}

/** Committed census — counts and reason codes, never product rows. */
export function summarizeDryRunPackages(packages) {
  const problems = packages.flatMap((pkg) => pkg.problems);
  const tally = (items) => items.reduce((out, item) => { out[item] = (out[item] || 0) + 1; return out; }, {});
  return {
    products: packages.length,
    status_by_products: tally(packages.map((p) => p.status)),
    would_transmit_true: packages.filter((p) => p.would_transmit === true).length,
    undeclared_gate_reasons: problems.filter((p) => p.reason === 'gate_reason_undeclared').length,
    problems_total: problems.length,
    problems_by_field: tally(problems.map((p) => p.field)),
    // The readiness authority counts PRODUCTS per blocked field, while problems_by_field
    // counts problem INSTANCES. A gated price carries two instances on one product
    // (no_public_price + price_untrusted_by_readiness), so cross-artefact comparison must
    // use this per-product tally or the two bases silently disagree.
    products_by_blocking_field: tally(packages.flatMap((pkg) => pkg.blocking_fields)),
    problems_by_reason: tally(problems.map((p) => p.reason)),
    blocking_field_count_histogram: tally(packages.map((p) => String(p.blocking_field_count))),
    values_in_bodies: {
      leaf_category_ids: packages.filter((p) => p.body.originProduct.leafCategoryId).length,
      detail_content: packages.filter((p) => p.body.originProduct.detailContent).length,
      stock_quantities: packages.filter((p) => p.body.originProduct.stockQuantity != null).length,
      sale_prices: packages.filter((p) => p.body.originProduct.salePrice != null).length,
      option_infos: packages.filter((p) => p.body.originProduct.detailAttribute.optionInfo).length,
      images_from_upload_api: packages.filter((p) => p.evidence.image.representative_is_upload_api_url).length,
      images_supplying_url_only: packages.filter((p) => !p.evidence.image.representative_is_upload_api_url && p.body.originProduct.images.representative).length,
      seller_codes: packages.filter((p) => p.sellerManagementCode).length,
      duplicate_searches_executed: packages.filter((p) => !p.problems.some((x) => x.reason === 'duplicate_search_not_executed')).length,
    },
    documented_bounds: { sale_price_max: NCOM_LIMITS.salePriceMax, stock_quantity_max: NCOM_LIMITS.stockQuantityMax },
    transmitted: false,
    account_login: 'NO',
    naver_requests: 0,
    erp_requests: 0,
    live_writes: 0,
    precedence_claimed: false,
    rule: '패키지 본문 값은 원천 컬럼 사본만 허용하고, leafCategoryId·detailContent·숫자형 재고·업로드 API 이미지 URL은 확인된 것이 없을 때까지 비워 둔다. 차단 사유가 하나라도 있는 패키지는 전송 후보가 아니며, useStockManagement=false 의 9,999 자동 설정을 실측 재고로 쓰지 않는다. 어느 필드가 먼저 거부되는지는 등록 호출을 실행하지 않아 미확인이며, 필드별 차단 건수만 보고한다.',
  };
}

/**
 * Long-format failure table, aggregated across products: one row per
 * (field, reason) with the count and the declared owner/meaning/action. This is the
 * 실패사유 CSV, so it carries numbers rather than supplier text.
 */
export function dryRunFailureRows(packages) {
  const counts = new Map();
  for (const pkg of packages) {
    for (const problem of pkg.problems) {
      const key = `${problem.field}\u0000${problem.reason}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([key, products]) => {
      const [field, reason] = key.split('\u0000');
      const doc = REGISTER_GATE_DOC[reason] || {};
      return { field, reason, products, owner: doc.owner || '', meaning: doc.meaning || '', action: doc.action || '', field_authority: doc.field_authority || '' };
    })
    .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));
}
