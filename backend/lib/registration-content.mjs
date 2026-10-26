// Which Naver registration fields can be filled from what this repository already
// holds — and which cannot be filled without inventing a product attribute.
//
// Four fields decide whether a CGI product can be registered at all: detailContent
// (상세설명), optionInfo (옵션), stockQuantity (숫자형 재고) and the duplicate guard
// (sellerManagementCode). This module converts the prep CSV and the supplier option
// table into a per-product plan for those four, and it is written so that an
// unanswered field stays unanswered: the plan names the source column it read, and
// where the source is silent it emits a reason code instead of a value.
//
// What the sources actually contain (measured, not assumed):
//   상세설명          4,252 of 4,575 rows carry one plain sentence, max 187 chars,
//                     0 rows >= 200 chars, 0 rows contain markup.
//   옵션SKU요약       580 products; the option tree flattened to
//                     "상품명 / 그룹명 / 옵션명 [품절] (+N원) / 예|아니오" per entry,
//                     "|" between entries, "(+N more)" where the collector truncated.
//   options_compact   4,233 rows over 587 products: option_name is the GROUP label,
//                     never a child, and option_sold_out is the single value 'N' on
//                     every row — so it cannot answer availability.
//   재고수량          0 of 4,575 numeric.
//   판매자코드        4,575 present, 4,575 distinct, equal to 공급처원본ID, 12-14 chars.
//
// The group labels in options_compact are what make the summary parseable: product
// names and option names both contain "/" ("SHURE HPASCA2 / 슈어 SRH1440/1840 …"),
// so the parser matches a known group label as a prefix and takes the rest as the
// child. Anchored that way, 2,139 of 2,139 parseable entries resolve to exactly one
// group (measured); the other 213 are truncated tails, which have no flag to split.
//
// No network, no credential, no fs. tools/registration-content-plan.mjs is the only
// caller that reads or writes files.

import { NCOM_LIMITS, NAVER_OPTION_TYPES } from './ncommerce.mjs';

const blank = (v) => String(v ?? '').trim();
const digitsOf = (v) => {
  const text = blank(v).replace(/[^\d.-]/g, '');
  return text === '' || text === '-' || !Number.isFinite(Number(text)) ? null : Number(text);
};
const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The documented contract this plan is written against, and where it stops. */
export const CONTENT_DOC = {
  source: 'apicenter.commerce.naver.com docs/commerce-api/current (transcriptions, v2.90.x)',
  optionTypes: NAVER_OPTION_TYPES,
  detailContent: {
    required: 'POST /v2/products — originProduct.detailContent 필수',
    overwriteExemption: 'PUT(수정)은 전체 덮어쓰기지만 detailContent 는 예외 3개 중 하나 — 보내지 않으면 기존 값이 유지된다',
    format: '문서는 HTML 문자열을 받는다. 어떤 편집기/이미지 API 에서 만들어야 하는지에 대한 최소 길이·필수 구조는 인쇄되어 있지 않다.',
  },
  stockQuantity: {
    required: '등록 시 필수, 정수, 0 이상, 최대 ' + NCOM_LIMITS.stockQuantityMax,
    unmanagedOptionAutoSet: `${NCOM_LIMITS.standardOptionStockWhenUnmanaged} — useStockManagement=false 일 때 표준형 옵션에 자동 설정되는 값. 실측 재고가 아니므로 등록 근거로 쓰지 않는다.`,
  },
  sellerManagementCode: {
    uniqueness: '문서 원문: 판매자관리코드는 사용자가 직접 값을 정하며 식별자로서의 고유성을 보장하지 않는다. 여러 상품에 동일한 코드를 입력할 수 있다.',
    duplicateGuard: '이 API 에는 idempotency key 가 없다 — 검색(SELLER_CODE) 후 미스일 때만 등록하는 쪽이 중복 방지책이다.',
  },
  unconfirmed: [
    'optionInfo 그룹명/옵션명의 문자 수 제한',
    '단독형 그룹 개수 상한과 그룹당 자식 개수 상한',
    '옵션 단위 price/stockQuantity 상한',
    'detailContent 최소 길이·필수 구조',
    'sellerManagementCode 최대 길이',
    '옵션 없는 상품의 표준 처리(문서에 예시 없음)',
  ],
};

/**
 * Splits one product's `옵션SKU요약` into entries. `groupLabels` (from
 * options_compact for the same product) anchor the group/child boundary.
 */
export function parseSupplierOptionSummary(summary, { productName = '', groupLabels = [] } = {}) {
  const text = blank(summary);
  if (text === '') return { entries: [], truncatedCount: 0, empty: true };
  const name = blank(productName);
  const labels = [...new Set(groupLabels.map(blank).filter((v) => v !== ''))].sort((a, b) => b.length - a.length);
  const entries = [];
  let truncatedCount = 0;
  for (const chunk of text.split('|')) {
    const raw = chunk.trim();
    if (raw === '') continue;
    const truncated = /\(\+\d+ more\)\s*$/.test(raw);
    if (truncated) truncatedCount += 1;
    const body = raw.replace(/\s*\(\+\d+ more\)\s*$/, '').trim();
    const flagMatch = /\/\s*(예|아니오)\s*$/.exec(body);
    const soldOut = flagMatch ? flagMatch[1] === '예' : null;
    const remainder = (flagMatch ? body.slice(0, flagMatch.index) : body).trim();
    const entry = { raw, groupName: null, childName: null, soldOut, addPrice: null, truncated, markerSoldOut: /\[품절\]/.test(body), unparsed: null };
    if (!name || !remainder.startsWith(name)) entry.unparsed = 'product_name_prefix_absent';
    else {
      const tail = remainder.slice(name.length).replace(/^\s*\/\s*/, '').trim();
      const matches = labels.filter((g) => tail === g || tail.startsWith(`${g} /`));
      if (matches.length === 0) entry.unparsed = 'group_label_not_in_option_table';
      else if (matches.length > 1) entry.unparsed = 'group_label_ambiguous';
      else {
        entry.groupName = matches[0];
        entry.childName = (tail === matches[0] ? '' : tail.slice(matches[0].length + 3).trim()) || null;
      }
    }
    if (entry.childName) {
      const priceMatch = /\s*\(\+([\d,]+)원\)\s*$/.exec(entry.childName);
      if (priceMatch) {
        entry.addPrice = Number(priceMatch[1].replace(/,/g, ''));
        entry.childName = entry.childName.slice(0, priceMatch.index).trim();
      }
      entry.childName = entry.childName.replace(/\s*\[품절\]\s*$/, '').trim();
      if (entry.childName === '') entry.childName = null;
    }
    entries.push(entry);
  }
  return { entries, truncatedCount, empty: false };
}

/**
 * Option plan for one product. `emittable` is deliberately narrow: it is true only
 * when the supplier's summary is complete (no "(+N more)"), every entry parsed, no
 * group lost, and the child count agrees with 옵션수. A truncated option list would
 * register a product with fewer choices than the supplier sells — a wrong listing,
 * not a partial one — so those products are kept as evidence but never emitted.
 *
 * A group whose children repeat the same visible name is dropped whole rather than
 * resolved by picking one: two entries named "3m" in one group carry no fact that
 * says which price belongs to which.
 */
export function buildOptionPlan({ cgiId, productName = '', summary = '', optionCount = '', groupRows = [] }) {
  const groupLabels = [...new Set(groupRows.map((r) => blank(r.option_name)).filter((v) => v !== ''))];
  const parsed = parseSupplierOptionSummary(summary, { productName, groupLabels });
  const reasons = [];
  const notes = [];
  if (parsed.empty) {
    if (groupRows.length === 0) {
      return { cgiId, optionType: 'NONE', status: 'no_options', emittable: false, reasons: ['option_source_absent'], groups: [], children: [], droppedGroups: [], unparsedEntries: 0, truncatedEntries: 0, usableKnownChildren: 0, soldOutChildren: 0, addPriceChildren: 0, claimedCount: digitsOf(optionCount), shownEntries: 0, notes: ['공급처 옵션 요약·옵션 테이블 모두 빈 칸 — 옵션이 정말 없는 상품인지 옵션이 수집되지 않은 상품인지 구분할 수 없다'] };
    }
    return { cgiId, optionType: 'NONE', status: 'no_children', emittable: false, reasons: ['option_children_absent', 'option_group_labels_only'], groups: groupLabels, children: [], droppedGroups: [], unparsedEntries: 0, truncatedEntries: 0, usableKnownChildren: 0, soldOutChildren: 0, addPriceChildren: 0, claimedCount: digitsOf(optionCount), shownEntries: 0, notes: ['옵션 테이블은 그룹명만 담고 있고 자식 옵션명이 없다 — 그룹명으로 자식을 만들지 않는다'] };
  }
  if (parsed.truncatedCount > 0) reasons.push('option_children_truncated_in_source');
  const children = [];
  const unparsed = [];
  for (const entry of parsed.entries) {
    if (entry.unparsed || !entry.groupName || !entry.childName) { unparsed.push(entry.unparsed || 'option_child_name_absent'); continue; }
    if (entry.soldOut === null && !entry.truncated) unparsed.push('option_usable_flag_absent');
    children.push({
      groupName: entry.groupName,
      childName: entry.childName,
      usable: entry.soldOut === null ? null : !entry.soldOut,
      addPrice: entry.addPrice,
      source: '옵션SKU요약',
    });
  }
  if (unparsed.length > 0) reasons.push('option_entries_unparsed');
  const byGroup = new Map();
  for (const child of children) {
    if (!byGroup.has(child.groupName)) byGroup.set(child.groupName, []);
    byGroup.get(child.groupName).push(child);
  }
  const droppedGroups = [];
  for (const [groupName, list] of byGroup) {
    const counts = new Map();
    for (const child of list) counts.set(child.childName, (counts.get(child.childName) || 0) + 1);
    const dupes = [...counts].filter(([, count]) => count > 1);
    if (dupes.length > 0) {
      droppedGroups.push(groupName);
      if (!reasons.includes('option_group_children_ambiguous')) reasons.push('option_group_children_ambiguous');
      notes.push(`그룹 '${groupName}' 안에서 같은 옵션명이 ${dupes.length}개 중복 — 어느 항목의 가격이 맞는지 공급처 데이터가 말하지 않아 그룹 전체를 등록 후보에서 제외`);
    }
  }
  const kept = children.filter((child) => !droppedGroups.includes(child.groupName));
  const groups = [...new Set(kept.map((child) => child.groupName))];
  const claimed = digitsOf(optionCount);
  const shown = parsed.entries.length;
  if (claimed != null && claimed !== shown && parsed.truncatedCount === 0) reasons.push('option_count_disagrees_with_summary');
  const priced = kept.filter((child) => child.addPrice != null);
  const optionType = kept.length === 0 ? 'NONE' : priced.length > 0 ? 'COMBINATION' : 'SINGLE';
  if (optionType === 'COMBINATION') notes.push('자식에 추가 금액(+N원)이 있어 옵션가 설정이 필요하다 — 문서의 옵션 단위 price 상한은 확인되지 않아 등록 전 값 검증이 필요하다');
  if (priced.some((child) => child.addPrice > NCOM_LIMITS.salePriceMax)) reasons.push('option_price_over_documented_sale_price_max');
  const status = kept.length === 0 ? (droppedGroups.length > 0 ? 'ambiguous' : 'unparsed') : parsed.truncatedCount > 0 || droppedGroups.length > 0 || unparsed.length > 0 ? 'partial' : 'complete';
  const emittable = status === 'complete' && groups.length > 0 && kept.length > 0;
  if (kept.length === 0 && !reasons.length) reasons.push('option_children_incomplete');
  const summaryGroups = new Set(children.map((child) => child.groupName));
  const groupsOnlyInTable = groupLabels.filter((g) => !summaryGroups.has(g));
  if (groupsOnlyInTable.length > 0) notes.push(`${groupsOnlyInTable.length}개 옵션 그룹이 옵션 테이블에만 있고 요약에 없다: ${groupsOnlyInTable.slice(0, 3).join(', ')}`);
  const soldOutChildren = kept.filter((child) => child.usable === false).length;
  return {
    cgiId,
    optionType,
    status,
    emittable,
    reasons,
    groups,
    children: kept,
    droppedGroups,
    unparsedEntries: unparsed.length,
    truncatedEntries: parsed.truncatedCount,
    usableKnownChildren: kept.filter((child) => child.usable !== null).length,
    soldOutChildren,
    addPriceChildren: priced.length,
    claimedCount: claimed,
    shownEntries: shown,
    singleChildGroups: [...byGroup].filter(([, list]) => list.length === 1).length,
    notes,
  };
}

/**
 * optionInfo shaped for the documented child keys, from an emittable plan only.
 * `id` and `stockQuantity` stay absent: ids are assigned by Naver and we hold no
 * per-option stock, and both are required for the combination form — which is
 * exactly why combination products are reported rather than emitted.
 */
export function buildOptionInfo(plan) {
  if (!plan || !plan.emittable) return null;
  const byGroup = new Map();
  for (const child of plan.children) {
    if (!byGroup.has(child.groupName)) byGroup.set(child.groupName, []);
    byGroup.get(child.groupName).push(child);
  }
  if (plan.optionType === 'SINGLE') {
    const [groupName, list] = [...byGroup][0];
    return {
      useStockManagement: false,
      optionSimple: list.map((child) => ({ groupName, name: child.childName, usable: child.usable === null ? true : child.usable })),
      evidence: 'optionSimple 자식 name/usable 은 공급처 옵션SKU요약의 옵션명·[품절] 표시를 그대로 옮긴 것. id 는 네이버가 배정하는 값이라 비워 둔다.',
    };
  }
  return {
    useStockManagement: false,
    optionGroups: [...byGroup].map(([groupName, list]) => ({ groupName, children: list.map((child) => ({ name: child.childName, usable: child.usable === null ? true : child.usable, addPrice: child.addPrice })) })),
    note: '옵션별 price/stockQuantity 상한이 문서에 없어 옵션가는 그대로 옮기지 않고 후보 값으로만 남긴다. 조합형 등록은 확인 후 가능.',
    emittableAsOptionCombinations: false,
  };
}

/**
 * Detail-content DRAFT. It repeats only what the supplier's own columns state and
 * is marked so no downstream lane can count it as answered:
 * counts_as_detail_content is false and operator_approval_required is true.
 */
export function buildDetailDraft({ masterRow = {} }) {
  const fields = [
    ['상품명', blank(masterRow['상품명'])],
    ['브랜드', blank(masterRow['브랜드'])],
    ['제조사', blank(masterRow['제조사'])],
    ['모델명', blank(masterRow['모델명'])],
    ['공급처 분류', blank(masterRow['카테고리경로_CGI'])],
    ['공급처 한 줄 설명', blank(masterRow['상세설명'])],
  ].filter(([, value]) => value !== '');
  const reasons = [];
  if (!fields.some(([k]) => k === '공급처 한 줄 설명')) reasons.push('detail_content_absent');
  if (blank(masterRow['KC고시정보']) === '') reasons.push('kc_info_absent');
  if (blank(masterRow['원산지코드']) === '') reasons.push('origin_code_absent');
  if (blank(masterRow['수입사']) === '') reasons.push('importer_absent');
  const html = [
    '<div class="cgi-detail-draft">',
    `<p><strong>${escapeHtml(blank(masterRow['상품명']))}</strong></p>`,
    fields.filter(([key]) => key !== '상품명').map(([key, value]) => `<p>${escapeHtml(key)}: ${escapeHtml(value)}</p>`).join(''),
    '</div>',
  ].join('');
  return {
    kind: 'draft',
    counts_as_detail_content: false,
    operator_approval_required: true,
    html,
    textLength: html.length,
    sourceFields: fields.map(([key]) => key),
    reasons,
    note: '공급처 컬럼에만 근거한 초안입니다. 실등록 전 운영자 확인이 필요하며, 이 값만으로 detailContent 필수 조건이 해소되지 않습니다.',
  };
}

/**
 * Numeric-stock read PLAN. The catalogue has no stock number for any product, and
 * the documented stand-in (useStockManagement=false auto-sets 9,999) would publish
 * inventory nobody counted — so the deliverable is the shape of the authenticated
 * ERP read that must happen first, with its requests array empty by design.
 */
export function buildStockReadPlan({ records = [], batchSize = 100 } = {}) {
  const codes = records.map((r) => blank(r.erpProdCdProposed || r.erpProdCd)).filter((v) => v !== '');
  const numeric = records.filter((r) => r.stockQty != null || digitsOf(r.stockQty) != null).length;
  return {
    endpointKey: 'listInventoryBalance',
    oapiPath: '/OAPI/V2/InventoryBalance/GetListInventoryBalanceStatus',
    authed: true,
    minIntervalMs: 600000,
    itemCodesTotal: codes.length,
    distinctItemCodes: new Set(codes).size,
    batchSize,
    batches: Math.ceil(codes.length / batchSize),
    requests: [],
    quantitiesInvented: false,
    numericStockInCatalogue: numeric,
    reasons: [numeric === 0 ? 'stock_quantity_column_absent' : 'stock_numeric_partial', 'stock_requires_erp_balance_read'],
    note: 'requests 가 비어 있는 것이 정상 — 인증된 ERP 재고현황 읽기가 끝난 뒤 채워진다. 읽지 않은 수량을 등록 본문에 넣지 않는다.',
    execute: false,
    transmitted: false,
    accountLogin: 'NO',
    erpRequests: 0,
  };
}

/**
 * Duplicate guard. Naver states 판매자관리코드 is not unique, so the guard has two
 * halves: our own catalogue must not reuse a code, and a search must precede each
 * register. Both are measured; neither is assumed.
 */
export function buildDuplicateGuard({ records = [], searchEvidence = new Map() } = {}) {
  const counts = new Map();
  for (const record of records) {
    const code = blank(record.sellerManagementCode);
    if (code === '') continue;
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  const duplicated = [...counts].filter(([, count]) => count > 1);
  const missing = records.filter((r) => blank(r.sellerManagementCode) === '').length;
  const lengths = [...counts].map(([code]) => code.length);
  const searched = records.filter((r) => searchEvidence.has(blank(r.sellerManagementCode)));
  const found = searched.filter((r) => searchEvidence.get(blank(r.sellerManagementCode)) === true);
  const reasons = [];
  if (missing === 0 && duplicated.length === 0) reasons.push('seller_code_present');
  if (missing > 0) reasons.push('seller_code_absent');
  if (duplicated.length > 0) reasons.push('seller_code_duplicated_in_catalogue');
  if (searched.length < records.length) reasons.push('duplicate_search_not_executed');
  if (found.length > 0) reasons.push('naver_item_already_registered');
  return {
    records: records.length,
    distinctCodes: counts.size,
    missingCode: missing,
    duplicatedCodes: duplicated.length,
    duplicatedExamples: duplicated.slice(0, 5).map(([code, count]) => ({ code, products: count })),
    codeLengthMin: lengths.length ? Math.min(...lengths) : null,
    codeLengthMax: lengths.length ? Math.max(...lengths) : null,
    nonAsciiCodes: [...counts].filter(([code]) => /[^\x20-\x7E]/.test(code)).length,
    searchedRecords: searched.length,
    alreadyOnNaver: found.length,
    unsearched: records.length - searched.length,
    reasons,
    note: '공식 문서: 판매자관리코드는 고유성을 보장하지 않는다 — 자 catalog 검사(여기)와 등록 전 검색(실행 안 함), 두 쪽이 다 맞아야 중복 등록을 막을 수 있다.',
    execute: false,
    transmitted: false,
    naverRequests: 0,
  };
}

/**
 * Price check against the single documented bound (salePrice max). Prices the
 * supplier marks 가격확인필요=예 stay unanswered — an inquiry price is not a salePrice
 * to invent a number for.
 */
export function buildPriceCheck({ records = [] } = {}) {
  const values = records.map((r) => (r.price && r.price.value != null ? Number(r.price.value) : null)).filter((v) => v != null);
  const states = {};
  for (const record of records) {
    const state = (record.price && record.price.state) || 'unknown';
    states[state] = (states[state] || 0) + 1;
  }
  const over = values.filter((v) => v > NCOM_LIMITS.salePriceMax).length;
  const negative = values.filter((v) => v < 0).length;
  return {
    records: records.length,
    withNumericPrice: values.length,
    inquiryOnly: (states.inquiry || 0),
    unknown: (states.unknown || 0),
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    overDocumentedSalePriceMax: over,
    negative: negative,
    salePriceMax: NCOM_LIMITS.salePriceMax,
    documentedVatRule: '공급처 데이터에 VAT 포함 여부에 대한 근거가 없어 공급처 수치를 그대로 사용 — 네이버 최종 표시가 어떻게 되는지 첫 실등록 시 확인 필요',
    reasons: [
      ...(values.length === records.length ? ['price_public_ok'] : ['price_inquiry_only']),
      ...(over ? ['price_over_naver_max'] : []),
    ],
  };
}

/**
 * The fail-closed check the CLI runs before it writes anything. A plan that names
 * an option child the supplier string does not contain, a draft that marks itself
 * as satisfying detailContent, or a stock plan that produced a quantity it never
 * read is a defect in this module — and the run must stop rather than publish it.
 */
export function findPlanViolations({ rows = [], summaryByCgiId = new Map(), stockPlan = {} } = {}) {
  const violations = [];
  for (const row of rows) {
    const summary = summaryByCgiId.get(row.cgiId) ?? '';
    for (const child of row.optionPlan.children) {
      if (!summary.includes(child.childName)) violations.push(`${row.cgiId}: 옵션 '${child.childName}'이 공급처 요약에 없음`);
      if (child.childName === '' || child.childName === null) violations.push(`${row.cgiId}: 빈 옵션명이 자식으로 등록됨`);
    }
    if (row.detailDraft.counts_as_detail_content === true) violations.push(`${row.cgiId}: 상세 초안이 required를 해소한 것으로 처리됨`);
    if (row.detailDraft.operator_approval_required !== true) violations.push(`${row.cgiId}: 상세 초안의 운영자 확인 표시가 빠짐`);
    // The payload itself, not a re-derivation of it: what the register lane would
    // send is the row's optionInfo, so that is the object the source check runs on.
    const info = row.optionInfo;
    if (info && info.optionSimple) {
      for (const simple of info.optionSimple) {
        if (!summary.includes(simple.name)) violations.push(`${row.cgiId}: optionSimple name '${simple.name}'이 원천에 없음`);
        if ('id' in simple) violations.push(`${row.cgiId}: optionSimple id 를 우리 쪽에서 생성함`);
        if ('stockQuantity' in simple) violations.push(`${row.cgiId}: optionSimple stockQuantity 를 우리 쪽에서 생성함`);
      }
    }
    if (info && row.optionPlan.emittable !== true) violations.push(`${row.cgiId}: emittable 아닌 계획이 페이로드를 냈음`);
  }
  if (stockPlan.quantitiesInvented !== false) violations.push('재고 계획을 넘어서 수치를 생성함');
  if ((stockPlan.requests || []).length > 0) violations.push('ERP 재고 읽기를 실행하지 않은 레인에서 requests 가 채워짐');
  return violations;
}

/** Whole-catalogue pass. Pure: the caller supplies parsed rows and joined records. */
export function planRegistrationContent({ masterRows = [], recordsByCgiId = new Map(), optionRowsByProduct = new Map(), searchEvidence = new Map() } = {}) {
  const rows = [];
  const records = [];
  for (const masterRow of masterRows) {
    const cgiId = blank(masterRow['공급처원본ID']);
    if (cgiId === '') continue;
    const record = recordsByCgiId.get(cgiId) || { cgiId, sellerManagementCode: blank(masterRow['판매자코드']) || cgiId, price: { value: digitsOf(masterRow['판매가']), state: blank(masterRow['가격확인필요']) === '예' ? 'inquiry' : 'public' } };
    const plan = buildOptionPlan({
      cgiId,
      productName: masterRow['상품명'],
      summary: masterRow['옵션SKU요약'],
      optionCount: masterRow['옵션수'],
      groupRows: optionRowsByProduct.get(cgiId) || [],
    });
    const detail = buildDetailDraft({ masterRow });
    const sellerManagementCode = blank(record.sellerManagementCode) || cgiId;
    records.push({ ...record, cgiId, sellerManagementCode, optionPlan: plan, detailDraft: detail });
    rows.push({ cgiId, sellerManagementCode, optionPlan: plan, detailDraft: detail, optionInfo: buildOptionInfo(plan) });
  }
  return {
    rows,
    records,
    stockPlan: buildStockReadPlan({ records }),
    duplicateGuard: buildDuplicateGuard({ records, searchEvidence }),
    priceCheck: buildPriceCheck({ records }),
  };
}

const tally = (values) => values.reduce((out, value) => { out[value] = (out[value] || 0) + 1; return out; }, {});

/** Census for the committed summary — counts and refusals, never product rows. */

export function summarizeContentPlan({ rows = [], stockPlan = {}, duplicateGuard = {}, priceCheck = {} }) {
  const plans = rows.map((r) => r.optionPlan);
  const allChildren = plans.flatMap((p) => p.children);
  const reasons = {};
  for (const plan of plans) for (const reason of plan.reasons) reasons[reason] = (reasons[reason] || 0) + 1;
  const detailReasons = {};
  for (const row of rows) for (const reason of row.detailDraft.reasons) detailReasons[reason] = (detailReasons[reason] || 0) + 1;
  return {
    products: rows.length,
    options: {
      status_by_products: tally(plans.map((p) => p.status)),
      type_by_products: tally(plans.map((p) => p.optionType)),
      emittable_products: plans.filter((p) => p.emittable).length,
      option_children_emitted: allChildren.length,
      children_with_known_usable: allChildren.filter((c) => c.usable !== null).length,
      children_marked_sold_out: allChildren.filter((c) => c.usable === false).length,
      children_with_add_price: allChildren.filter((c) => c.addPrice != null).length,
      groups_dropped_for_duplicate_children: plans.reduce((sum, p) => sum + p.droppedGroups.length, 0),
      truncated_entries: plans.reduce((sum, p) => sum + p.truncatedEntries, 0),
      unparsed_entries: plans.reduce((sum, p) => sum + p.unparsedEntries, 0),
      reason_counts: reasons,
    },
    detail: {
      drafts: rows.length,
      counts_as_detail_content: rows.filter((r) => r.detailDraft.counts_as_detail_content === true).length,
      operator_approval_required: rows.filter((r) => r.detailDraft.operator_approval_required === true).length,
      reason_counts: detailReasons,
    },
    stock: {
      numeric_in_catalogue: stockPlan.numericStockInCatalogue,
      item_codes: stockPlan.itemCodesTotal,
      batches_planned: stockPlan.batches,
      requests_executed: stockPlan.requests ? stockPlan.requests.length : 0,
      quantities_invented: stockPlan.quantitiesInvented,
    },
    duplicates: {
      distinct_seller_codes: duplicateGuard.distinctCodes,
      duplicated_codes: duplicateGuard.duplicatedCodes,
      searched: duplicateGuard.searchedRecords,
      already_on_naver: duplicateGuard.alreadyOnNaver,
      reasons: duplicateGuard.reasons,
    },
    price: {
      with_numeric_price: priceCheck.withNumericPrice,
      inquiry_only: priceCheck.inquiryOnly,
      over_documented_max: priceCheck.overDocumentedSalePriceMax,
      reasons: priceCheck.reasons,
    },
    transmitted: false,
    account_login: 'NO',
    naver_requests: 0,
    erp_requests: 0,
    live_writes: 0,
    rule: '옵션 자식은 공급처 옵션SKU요약에서 파싱되고 잘린 목록은 등록 후보로 내지 않는다. 상세설명 초안은 counts_as_detail_content=false 이며 운영자 승인 없이는 required 를 해소하지 않는다. 재고 수량은 읽지 않은 값이 0건이며, 판매자코드는 카탈로그 내부 고유성만 확인했다.',
  };
}
