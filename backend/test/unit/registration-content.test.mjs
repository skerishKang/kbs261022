// Unit tests for the registration content lane. Pure — no file is read and no
// request is made. What these pin down is the lane's whole purpose: a plan value
// is either copied out of a source column or it is a reason code, and the three
// tempting inventions (a detail body from the product name, a '기본' option child,
// a stock quantity from the documented auto-set) must stay unemitted.
//
//   node --test test/unit/registration-content.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { NCOM_LIMITS, NAVER_OPTION_TYPES, NCOM_ENDPOINTS } from '../../lib/ncommerce.mjs';
import { REASONS } from '../../lib/registration-readiness.mjs';
import {
  CONTENT_DOC, parseSupplierOptionSummary, buildOptionPlan, buildOptionInfo,
  buildDetailDraft, buildStockReadPlan, buildDuplicateGuard, buildPriceCheck,
  planRegistrationContent, summarizeContentPlan, findPlanViolations,
} from '../../lib/registration-content.mjs';

// A supplier row exactly as the collector writes it: product name / group / child
// with the 품절 marker and the (+N원) add price, '예|아니오' trailing flag.
const NAME = 'SHURE AONIC 5 슈어 사운드 아이솔레이팅 이어폰 (클리어/블랙/레드)';
const GROUPS = [{ option_name: '색상 선택' }, { option_name: '케이블 선택' }];
const SUMMARY = [
  `${NAME} / 색상 선택 / 클리어 [품절] / 예`,
  `${NAME} / 색상 선택 / 블랙 / 아니오`,
  `${NAME} / 색상 선택 / 레드 / 아니오`,
].join(' | ');

test('the summary parser splits group and child on a known group label, not on every slash', () => {
  const parsed = parseSupplierOptionSummary(SUMMARY, { productName: NAME, groupLabels: ['색상 선택'] });
  assert.equal(parsed.entries.length, 3);
  assert.equal(parsed.truncatedCount, 0);
  assert.deepEqual(parsed.entries.map((e) => [e.groupName, e.childName]), [['색상 선택', '클리어'], ['색상 선택', '블랙'], ['색상 선택', '레드']]);
  assert.deepEqual(parsed.entries.map((e) => e.soldOut), [true, false, false], 'the flag is 예/아니오 and only the first is sold out');
  assert.deepEqual(parsed.entries.map((e) => e.unparsed), [null, null, null]);
  // The same string parsed without the group table cannot be attributed: the
  // product name itself contains '/', so a naive split invents a boundary.
  const blind = parseSupplierOptionSummary(SUMMARY, { productName: NAME, groupLabels: [] });
  assert.deepEqual(blind.entries.map((e) => e.unparsed), ['group_label_not_in_option_table', 'group_label_not_in_option_table', 'group_label_not_in_option_table']);
  assert.equal(blind.entries.every((e) => e.childName === null), true, 'no child may be invented from an unanchored remainder');
});

test('a product name containing the group separator still resolves against its own name', () => {
  const bundled = 'SHURE SRH1840 슈어 헤드폰';
  const group = 'SHURE HPASCA2 / 슈어 SRH1440/1840 교체용 케이블';
  const summary = `${bundled} / ${group} / ${group} / 아니오`;
  const parsed = parseSupplierOptionSummary(summary, { productName: bundled, groupLabels: [group, '길이선택'] });
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].groupName, group, 'the longest known label wins over a shorter prefix match');
  assert.equal(parsed.entries[0].childName, group);
});

test('truncation and add prices are read as what they are', () => {
  const parsed = parseSupplierOptionSummary('P / 길이선택 / 1m (+3,000원) / 아니오 | P / 길이선택 / 3m (+8,000원) / 아니오 (+1 more)', { productName: 'P', groupLabels: ['길이선택'] });
  assert.equal(parsed.truncatedCount, 1);
  assert.deepEqual(parsed.entries.map((e) => e.addPrice), [3000, 8000]);
  assert.deepEqual(parsed.entries.map((e) => e.childName), ['1m', '3m'], 'the price text is separated from the option name');
  assert.equal(parsed.entries[1].soldOut, false, 'the collector appends (+N more) after the entry own flag, so the flag still reads; what is unknown is the entries that were cut');
});

test('an option plan is emittable only when the supplier list is whole', () => {
  const complete = buildOptionPlan({ cgiId: 'x:1', productName: NAME, summary: SUMMARY, optionCount: '3', groupRows: GROUPS });
  assert.equal(complete.status, 'complete');
  assert.equal(complete.emittable, true);
  assert.equal(complete.optionType, 'SINGLE');
  assert.deepEqual(complete.reasons, []);
  assert.equal(complete.children.length, 3);
  assert.equal(complete.soldOutChildren, 1);
  assert.equal(complete.usableKnownChildren, 3);

  const truncated = buildOptionPlan({ cgiId: 'x:2', productName: NAME, summary: `${SUMMARY} (+4 more)`, optionCount: '7', groupRows: GROUPS });
  assert.equal(truncated.emittable, false, 'a partial option list would register fewer choices than the supplier sells');
  assert.equal(truncated.status, 'partial');
  assert.ok(truncated.reasons.includes('option_children_truncated_in_source'));
  assert.equal(truncated.truncatedEntries, 1);

  const disagree = buildOptionPlan({ cgiId: 'x:3', productName: NAME, summary: SUMMARY, optionCount: '5', groupRows: GROUPS });
  assert.ok(disagree.reasons.includes('option_count_disagrees_with_summary'), 'count mismatch is named even when every entry parsed');

  const noSource = buildOptionPlan({ cgiId: 'x:4', productName: 'P', summary: '', optionCount: '0', groupRows: [] });
  assert.equal(noSource.status, 'no_options');
  assert.deepEqual(noSource.reasons, ['option_source_absent']);
  assert.equal(noSource.children.length, 0, 'the 3,988 option-less products do not get an invented 기본 child');

  const groupsOnly = buildOptionPlan({ cgiId: 'x:5', productName: 'P', summary: '', optionCount: '2', groupRows: [{ option_name: '사이즈' }] });
  assert.equal(groupsOnly.status, 'no_children');
  assert.deepEqual(groupsOnly.reasons, ['option_children_absent', 'option_group_labels_only']);
  assert.deepEqual(groupsOnly.groups, ['사이즈'], 'the group name is reported, never turned into a child option');
});

test('a group with repeated child names is dropped whole instead of picking a price', () => {
  const summary = 'P / 길이선택 / 3m (+5,000원) / 아니오 | P / 길이선택 / 5m / 아니오 | P / 길이선택 / 3m / 아니오';
  const plan = buildOptionPlan({ cgiId: 'x:6', productName: 'P', summary, optionCount: '3', groupRows: [{ option_name: '길이선택' }] });
  assert.deepEqual(plan.droppedGroups, ['길이선택']);
  assert.equal(plan.children.length, 0, 'no child of an ambiguous group survives');
  assert.equal(plan.status, 'ambiguous');
  assert.equal(plan.emittable, false);
  assert.ok(plan.reasons.includes('option_group_children_ambiguous'));
});

test('optionInfo is built only from an emittable plan and carries no invented id or stock', () => {
  const plan = buildOptionPlan({ cgiId: 'x:1', productName: NAME, summary: SUMMARY, optionCount: '3', groupRows: GROUPS });
  const info = buildOptionInfo(plan);
  assert.equal(info.optionSimple.length, 3);
  assert.deepEqual(info.optionSimple.map((o) => o.name), ['클리어', '블랙', '레드']);
  assert.deepEqual(info.optionSimple.map((o) => o.usable), [false, true, true]);
  assert.equal(info.optionSimple.some((o) => 'id' in o), false, 'Naver assigns option ids; we do not');
  assert.equal(info.optionSimple.some((o) => 'stockQuantity' in o), false, 'no per-option stock was read');
  assert.equal(info.useStockManagement, false);
  assert.equal(buildOptionInfo({ ...plan, emittable: false }), null, 'a non-emittable plan produces no payload at all');

  const priced = buildOptionPlan({ cgiId: 'x:7', productName: 'P', summary: 'P / 길이선택 / 1m / 아니오 | P / 길이선택 / 2m (+3,000원) / 아니오', optionCount: '2', groupRows: [{ option_name: '길이선택' }] });
  assert.equal(priced.optionType, 'COMBINATION', 'a per-child add price needs the combination form');
  const combination = buildOptionInfo(priced);
  assert.equal(combination.optionSimple, undefined);
  assert.equal(combination.emittableAsOptionCombinations, false, 'option price/stock bounds are unconfirmed, so the wire form is not claimed');
  assert.deepEqual(combination.optionGroups[0].children.map((c) => c.addPrice), [null, 3000], 'the add price is carried as evidence');
});

test('a detail draft is marked as not answering detailContent', () => {
  const draft = buildDetailDraft({ masterRow: { 상품명: 'SQ5+', 브랜드: 'ALLEN&HEATH', 모델명: 'SQ5+', 상세설명: '48채널 디지털 믹서', KC고시정보: '', 원산지코드: '', 수입사: '' } });
  assert.equal(draft.kind, 'draft');
  assert.equal(draft.counts_as_detail_content, false);
  assert.equal(draft.operator_approval_required, true);
  assert.ok(draft.html.includes('48채널 디지털 믹서'));
  assert.deepEqual(draft.sourceFields, ['상품명', '브랜드', '모델명', '공급처 한 줄 설명']);
  assert.deepEqual(draft.reasons.sort(), ['importer_absent', 'kc_info_absent', 'origin_code_absent']);
  const empty = buildDetailDraft({ masterRow: { 상품명: 'SQ5+' } });
  assert.ok(empty.reasons.includes('detail_content_absent'));
  assert.ok(!empty.html.includes('undefined'), 'a missing column must not leak the word undefined into the body');
});

test('the HTML escape holds the only place a supplier string can break out of the draft', () => {
  const draft = buildDetailDraft({ masterRow: { 상품명: '<img src=x onerror=alert(1)>', 상세설명: 'A & B "quoted" <b>' } });
  assert.ok(!draft.html.includes('<img'), 'a supplier name is never live markup');
  assert.ok(draft.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(draft.html.includes('A &amp; B'));
});

test('the stock plan reads nothing and invents nothing', () => {
  const plan = buildStockReadPlan({ records: [{ erpProdCdProposed: 'SS-1', stockQty: null }, { erpProdCdProposed: 'SS-2', stockQty: null }], batchSize: 1 });
  assert.equal(plan.endpointKey, 'listInventoryBalance');
  assert.equal(plan.oapiPath, '/OAPI/V2/InventoryBalance/GetListInventoryBalanceStatus');
  assert.equal(plan.requests.length, 0, 'an authenticated ERP read is forbidden in this lane');
  assert.equal(plan.quantitiesInvented, false);
  assert.equal(plan.numericStockInCatalogue, 0);
  assert.equal(plan.batches, 2);
  assert.equal(plan.transmitted, false);
  assert.deepEqual(plan.reasons, ['stock_quantity_column_absent', 'stock_requires_erp_balance_read']);
  assert.ok(NCOM_LIMITS.standardOptionStockWhenUnmanaged === 9999, 'the documented auto-set stays a documented number, not a plan value');
});

test('the duplicate guard measures its own half and reports the other as unexecuted', () => {
  const records = [{ sellerManagementCode: 'samamusic:1' }, { sellerManagementCode: 'samamusic:2' }, { sellerManagementCode: 'samamusic:1' }];
  const guard = buildDuplicateGuard({ records });
  assert.equal(guard.distinctCodes, 2);
  assert.equal(guard.duplicatedCodes, 1);
  assert.deepEqual(guard.duplicatedExamples, [{ code: 'samamusic:1', products: 2 }]);
  assert.ok(guard.reasons.includes('seller_code_duplicated_in_catalogue'));
  assert.ok(guard.reasons.includes('duplicate_search_not_executed'), 'search-before-register has not run; uniqueness alone is not the guard');
  assert.equal(guard.searchedRecords, 0);

  const clean = buildDuplicateGuard({ records: [{ sellerManagementCode: 'samamusic:1' }], searchEvidence: new Map([['samamusic:1', true]]) });
  assert.ok(clean.reasons.includes('naver_item_already_registered'), 'a hit means modify, not a second registration');
  assert.equal(clean.alreadyOnNaver, 1);
});

test('the price check compares only against the one documented bound', () => {
  const records = [{ price: { value: 279000, state: 'public' } }, { price: { value: null, state: 'inquiry' } }];
  const check = buildPriceCheck({ records });
  assert.equal(check.withNumericPrice, 1);
  assert.equal(check.inquiryOnly, 1);
  assert.equal(check.overDocumentedSalePriceMax, 0);
  assert.deepEqual(check.reasons, ['price_inquiry_only']);
  const huge = buildPriceCheck({ records: [{ price: { value: NCOM_LIMITS.salePriceMax + 10, state: 'public' } }] });
  assert.ok(huge.reasons.includes('price_over_naver_max'));
});

test('every reason the plan emits is declared in the readiness vocabulary', () => {
  const emitted = new Set();
  const collect = (codes) => { for (const code of codes) emitted.add(code); };
  collect(buildOptionPlan({ cgiId: 'a', productName: 'P', summary: '', optionCount: '0', groupRows: [] }).reasons);
  collect(buildOptionPlan({ cgiId: 'b', productName: 'P', summary: 'P / G / C / 아니오 (+1 more)', optionCount: '2', groupRows: [{ option_name: 'G' }] }).reasons);
  collect(buildDetailDraft({ masterRow: {} }).reasons);
  collect(buildStockReadPlan({ records: [] }).reasons);
  collect(buildDuplicateGuard({ records: [{ sellerManagementCode: 'x' }] }).reasons);
  collect(buildPriceCheck({ records: [] }).reasons);
  for (const code of emitted) assert.ok(REASONS[code], `${code} is emitted but not declared in REASONS`);
});

test('the plan census conserves products across option statuses', () => {
  const masterRows = [
    { 공급처원본ID: 's:1', 상품명: NAME, 옵션SKU요약: SUMMARY, 옵션수: '3', 판매자코드: 's:1' },
    { 공급처원본ID: 's:2', 상품명: 'P2', 옵션SKU요약: 'P2 / G / A / 아니오 (+2 more)', 옵션수: '3', 판매자코드: 's:2' },
    { 공급처원본ID: 's:3', 상품명: 'P3', 옵션SKU요약: '', 옵션수: '0', 판매자코드: 's:3' },
  ];
  const { rows, stockPlan, duplicateGuard, priceCheck } = planRegistrationContent({
    masterRows,
    recordsByCgiId: new Map([['s:1', { cgiId: 's:1', sellerManagementCode: 's:1', erpProdCdProposed: 'SS-1', price: { value: 1000, state: 'public' }, stockQty: null }]]),
    optionRowsByProduct: new Map([['s:1', GROUPS]]),
  });
  assert.equal(rows.length, 3);
  const census = summarizeContentPlan({ rows, stockPlan, duplicateGuard, priceCheck });
  assert.equal(census.products, 3);
  const statusTotal = Object.values(census.options.status_by_products).reduce((a, b) => a + b, 0);
  assert.equal(statusTotal, 3, 'every product is classified into exactly one option status');
  assert.equal(census.options.emittable_products, 1);
  assert.equal(census.options.option_children_emitted, 3);
  assert.equal(census.detail.counts_as_detail_content, 0, 'a draft never counts as content, for any product');
  assert.equal(census.detail.operator_approval_required, 3);
  assert.equal(census.stock.requests_executed, 0);
  assert.equal(census.stock.quantities_invented, false);
  assert.equal(census.duplicates.distinct_seller_codes, 3, 'codes come from the prep column when no record joined');
  assert.equal(census.transmitted, false);
  assert.equal(census.account_login, 'NO');
  assert.equal(census.naver_requests, 0);
  assert.equal(census.erp_requests, 0);
});

test('the fail-closed guard stays silent on a plan the library actually produces', () => {
  const masterRows = [
    { 공급처원본ID: 's:1', 상품명: NAME, 옵션SKU요약: SUMMARY, 옵션수: '3', 판매자코드: 's:1' },
    { 공급처원본ID: 's:3', 상품명: 'P3', 옵션SKU요약: '', 옵션수: '0', 판매자코드: 's:3' },
  ];
  const { rows, stockPlan } = planRegistrationContent({ masterRows, recordsByCgiId: new Map(), optionRowsByProduct: new Map([['s:1', GROUPS]]) });
  const summaryByCgiId = new Map(masterRows.map((r) => [r.공급처원본ID, r.옵션SKU요약]));
  assert.deepEqual(findPlanViolations({ rows, summaryByCgiId, stockPlan }), [], 'the honest output must not be blocked');
});

test('the fail-closed guard names every invention it is there to catch', () => {
  const masterRows = [{ 공급처원본ID: 's:1', 상품명: NAME, 옵션SKU요약: SUMMARY, 옵션수: '3', 판매자코드: 's:1' }];
  const build = (mutate) => {
    const { rows, stockPlan } = planRegistrationContent({ masterRows, recordsByCgiId: new Map(), optionRowsByProduct: new Map([['s:1', GROUPS]]) });
    mutate(rows[0], stockPlan);
    return { rows, stockPlan };
  };
  const summaryByCgiId = new Map([['s:1', SUMMARY]]);
  const flagged = (mutate) => findPlanViolations({ ...build(mutate), summaryByCgiId });

  assert.match(flagged((row) => row.optionPlan.children.push({ groupName: '색상 선택', childName: '기본' })).join('\n'), /공급처 요약에 없음/);
  assert.match(flagged((row) => row.optionPlan.children.push({ groupName: '색상 선택', childName: '' })).join('\n'), /빈 옵션명/);
  assert.match(flagged((row) => { row.detailDraft.counts_as_detail_content = true; }).join('\n'), /required를 해소/);
  assert.match(flagged((row) => { row.detailDraft.operator_approval_required = false; }).join('\n'), /운영자 확인 표시가 빠짐/);
  assert.match(flagged((row) => { row.optionInfo.optionSimple[0].id = 1; }).join('\n'), /id 를 우리 쪽에서 생성함/);
  assert.match(flagged((row) => { row.optionInfo.optionSimple[0].stockQuantity = 9999; }).join('\n'), /stockQuantity 를 우리 쪽에서 생성함/);
  assert.match(flagged((row) => { row.optionInfo.optionSimple[0].name = '몰라'; }).join('\n'), /optionSimple name/);
  assert.match(flagged((row) => { row.optionInfo.optionGroups = []; row.optionPlan.emittable = false; }).join('\n'), /emittable 아닌 계획이 페이로드를 냈음/);
  assert.match(findPlanViolations({ rows: [], summaryByCgiId, stockPlan: { quantitiesInvented: true, requests: [] } }).join('\n'), /수치를 생성함/);
  assert.match(findPlanViolations({ rows: [], summaryByCgiId, stockPlan: { quantitiesInvented: false, requests: [{ itemCodes: 1 }] } }).join('\n'), /requests 가 채워짐/);
  // A row whose option child came from a summary the run never had is the worst
  // case: with no source string at all, every child is unsourced.
  const clean = build(() => {});
  assert.equal(findPlanViolations({ rows: clean.rows, summaryByCgiId: new Map([['s:1', '']]), stockPlan: clean.stockPlan }).length, 6,
    'three real children and their three optionSimple copies are all unsourced');
});

test('the documented contract this lane writes against stays stated', () => {
  assert.deepEqual(Object.keys(NAVER_OPTION_TYPES).filter((k) => k !== 'sortTypes' && k !== 'stockSwitch').sort(), ['COMBINATION', 'CUSTOM', 'NONE', 'SINGLE', 'STANDARD']);
  assert.deepEqual(NAVER_OPTION_TYPES.SINGLE.childKeys, ['groupName', 'id', 'name', 'usable']);
  assert.deepEqual(NAVER_OPTION_TYPES.COMBINATION.childKeys, ['id', 'optionName1', 'optionName2', 'price', 'stockQuantity', 'usable']);
  assert.ok(CONTENT_DOC.sellerManagementCode.uniqueness.includes('고유성을 보장하지'), 'the non-uniqueness statement is the reason the guard exists');
  assert.equal(NCOM_ENDPOINTS.standardOptions.path, '/v1/options/standard-options');
  assert.ok(CONTENT_DOC.unconfirmed.length >= 5, 'limits the docs never printed stay named instead of encoded');
  for (const line of CONTENT_DOC.unconfirmed) assert.ok(!/\d{3,}/.test(line), `${line} would encode a number the docs never printed`);
});
