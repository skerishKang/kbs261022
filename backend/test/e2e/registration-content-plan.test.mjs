// End-to-end coverage for the registration content CLI. The lane cannot log in to
// Naver or 이카운트, so the only honest checks are: the committed aggregate is what
// the tool reproduces byte for byte; every number in it is re-measured here from the
// source CSVs rather than restated; every option child traces back to that product's
// own supplier string; and the two refusals — private rows into the repo, planning on
// a failed mapping join — actually stop the run.
//
//   node --test test/e2e/registration-content-plan.test.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { parseCsv, buildMappingSet } from '../../lib/product-mapping.mjs';
import { toCsv, REASONS } from '../../lib/registration-readiness.mjs';
import { planRegistrationContent, summarizeContentPlan, findPlanViolations } from '../../lib/registration-content.mjs';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = path.resolve(BACKEND, '..');
const TOOL = path.join(BACKEND, 'tools', 'registration-content-plan.mjs');
const COMMITTED = path.join(ROOT, 'reports', 'data', 'registration', 'content_plan_summary.json');
const WORK_REL = '.work/content-test';
const WORK = path.join(ROOT, WORK_REL);
// The per-product rows carry supplier text, so the happy path aims them at a throwaway
// directory the tool is allowed to write to: outside the repository, on this machine.
const PRIVATE = fs.mkdtempSync(path.join(os.tmpdir(), 'cgi-content-private-'));

after(() => {
  if (fs.existsSync(WORK)) fs.rmSync(WORK, { recursive: true, force: true });
  fs.rmSync(PRIVATE, { recursive: true, force: true });
});

const readCsv = (rel) => parseCsv(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const SOURCES = {
  prep: 'data/smartstore_prep/smartstore_registration_prep.csv',
  options: 'data/full_catalog/options_compact.csv',
  extended: 'data/erp_prep/erp_extended_mapping.csv',
  upload: 'data/erp_prep/ecount_item_upload.csv',
};

// The same inputs, resolved in-process, are the authority for the CLI's numbers.
const prepRows = readCsv(SOURCES.prep);
const optionRows = readCsv(SOURCES.options);
const records = buildMappingSet({ extendedRows: readCsv(SOURCES.extended), uploadRows: readCsv(SOURCES.upload), smartstoreRows: prepRows, erpMasterRows: [] });
const recordsByCgiId = new Map();
for (const record of records) {
  recordsByCgiId.set(record.cgiId, record);
  if (record.sourceId) recordsByCgiId.set(record.sourceId, record);
}
const optionRowsByProduct = new Map();
for (const row of optionRows) {
  const key = String(row.source_key ?? '').trim();
  if (key === '') continue;
  if (!optionRowsByProduct.has(key)) optionRowsByProduct.set(key, []);
  optionRowsByProduct.get(key).push(row);
}
const local = planRegistrationContent({ masterRows: prepRows, recordsByCgiId, optionRowsByProduct, searchEvidence: new Map() });
const localCensus = summarizeContentPlan({ rows: local.rows, stockPlan: local.stockPlan, duplicateGuard: local.duplicateGuard, priceCheck: local.priceCheck });
const summaryByCgiId = new Map(prepRows.map((row) => [String(row['공급처원본ID'] ?? '').trim(), String(row['옵션SKU요약'] ?? '')]));

const runTool = (label, args) => {
  fs.mkdirSync(path.join(WORK, label), { recursive: true });
  return execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', cwd: BACKEND, maxBuffer: 1 << 26 });
};
const failWith = (args) => {
  try {
    return { status: 0, text: execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', cwd: BACKEND, stdio: 'pipe', maxBuffer: 1 << 26 }) };
  } catch (error) {
    return { status: error.status, text: `${error.stderr || ''}${error.stdout || ''}` };
  }
};
const sha = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
const sameBytes = (a, b) => Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) === 0;

test('the committed aggregate is exactly what the tool reproduces, twice', () => {
  runTool('run-a', ['--summary', `${WORK_REL}/run-a/summary.json`]);
  runTool('run-b', ['--summary', `${WORK_REL}/run-b/summary.json`]);
  const a = path.join(WORK, 'run-a', 'summary.json');
  const b = path.join(WORK, 'run-b', 'summary.json');
  assert.ok(sameBytes(a, b), 'two runs must be byte-identical');
  assert.ok(sameBytes(COMMITTED, a), 'the committed aggregate is not what the tool reproduces');

  const aggregate = JSON.parse(fs.readFileSync(COMMITTED, 'utf8'));
  assert.equal(aggregate.kind, 'cgi-registration-content-plan');
  assert.equal(aggregate.generated_by, 'backend/tools/registration-content-plan.mjs');
  assert.deepEqual(aggregate.census, localCensus, 'the published census must equal the in-process pass over the same files');
  assert.equal(aggregate.census.products, prepRows.length);
  assert.equal(aggregate.input_row_counts.prep, prepRows.length);
  assert.equal(aggregate.input_row_counts.option_products, optionRowsByProduct.size);
  assert.equal(aggregate.input_row_counts.mapping_records, records.length);
  for (const [key, rel] of Object.entries(SOURCES)) {
    assert.equal(aggregate.inputs[key].path, rel, `${key} must name the file the tool actually reads`);
    assert.equal(aggregate.inputs[key].sha256, sha(rel), `${key} provenance hash is stale`);
  }
  assert.equal(aggregate.stock_read_plan.authed, true, 'the read that would be needed is an authenticated one');
  assert.deepEqual(aggregate.stock_read_plan.requests, [], 'an unexecuted read stays empty, which is the correct output here');
  assert.equal(aggregate.duplicate_guard.searchedRecords, 0, 'search-before-register is reported as unexecuted, not as clean');
  assert.equal(aggregate.duplicate_guard.unsearched, prepRows.length);
  assert.equal(aggregate.price_check.overDocumentedSalePriceMax, 0);
});

test('the aggregate is re-measured from the source columns, not restated', () => {
  const aggregate = JSON.parse(fs.readFileSync(COMMITTED, 'utf8'));
  const census = aggregate.census;
  const stockRaw = prepRows.map((r) => String(r['재고수량'] ?? '').trim());
  assert.equal(census.stock.numeric_in_catalogue, stockRaw.filter((v) => /^\d+$/.test(v)).length,
    'the numeric-stock count must be the count of digit-only 재고수량 cells');
  assert.equal(census.stock.numeric_in_catalogue, 0, 'not one product carries a counted quantity');

  const codes = prepRows.map((r) => String(r['판매자코드'] ?? '').trim()).filter(Boolean);
  assert.equal(census.duplicates.distinct_seller_codes, new Set(codes).size);
  assert.equal(census.duplicates.duplicated_codes, codes.length - new Set(codes).size, 'the catalogue-internal half of the guard is measured');
  assert.equal(aggregate.duplicate_guard.codeLengthMin, Math.min(...codes.map((c) => c.length)));
  assert.equal(aggregate.duplicate_guard.codeLengthMax, Math.max(...codes.map((c) => c.length)));

  const prices = prepRows.map((r) => String(r['판매가'] ?? '').replace(/[^\d.-]/g, '')).filter((v) => v !== '' && /^\d+$/.test(v));
  assert.equal(census.price.with_numeric_price, prices.length);
  assert.equal(Number(aggregate.price_check.max), Math.max(...prices.map(Number)));
  assert.equal(Number(aggregate.price_check.min), Math.min(...prices.map(Number)));

  // A product with no option text at all is the no_options bucket; the two must be
  // the same measurement seen from different sides of the same file.
  const emptySummaries = prepRows.filter((r) => String(r['옵션SKU요약'] ?? '').trim() === '').length;
  assert.equal(census.options.status_by_products.no_options + census.options.status_by_products.no_children, emptySummaries,
    'every empty summary is either no_options or groups-only-no_children, and nothing else is');

  const totals = Object.values(census.options.status_by_products).reduce((a, b) => a + b, 0);
  assert.equal(totals, census.products, 'the option statuses partition the catalogue');
  assert.equal(Object.values(census.options.type_by_products).reduce((a, b) => a + b, 0), census.products);
  assert.equal(census.detail.drafts, census.products);
  assert.ok(census.options.emittable_products > 0, 'the emittable count must be exercised, not vacuously zero');
  assert.ok(census.options.option_children_emitted > 0);

  for (const [key, value] of Object.entries({ transmitted: false, account_login: 'NO', naver_requests: 0, erp_requests: 0, live_writes: 0 })) {
    assert.equal(census[key], value);
  }
});

test('no option child is emitted that the supplier string does not contain', () => {
  const violations = findPlanViolations({ rows: local.rows, summaryByCgiId, stockPlan: local.stockPlan });
  assert.deepEqual(violations, [], 'the whole catalogue must pass its own source check');

  const emittable = local.rows.filter((row) => row.optionPlan.emittable);
  assert.ok(emittable.length > 0);
  for (const row of emittable) {
    const summary = summaryByCgiId.get(row.cgiId) ?? '';
    assert.ok(row.optionPlan.children.length > 0, `${row.cgiId} emits no child`);
    for (const child of row.optionPlan.children) assert.ok(summary.includes(child.childName), `${row.cgiId}: ${child.childName}`);
    assert.equal(row.optionPlan.status, 'complete');
    for (const simple of row.optionInfo.optionSimple || []) {
      assert.ok(!('id' in simple), `${row.cgiId}: option id is Naver's to assign`);
      assert.ok(!('stockQuantity' in simple), `${row.cgiId}: no per-option quantity was read`);
    }
  }
  // The truncation rule: a cut-off option list is never a registration candidate,
  // because it would publish fewer choices than the supplier actually sells.
  const truncated = local.rows.filter((row) => row.optionPlan.reasons.includes('option_children_truncated_in_source'));
  assert.ok(truncated.length > 0, 'the catalogue contains truncated option lists, so this guard is exercised');
  assert.equal(truncated.filter((row) => row.optionPlan.emittable).length, 0);
  assert.equal(localCensus.options.truncated_entries > 0, true);
  assert.equal(local.rows.filter((row) => row.detailDraft.counts_as_detail_content === true).length, 0);
  assert.equal(local.rows.filter((row) => row.detailDraft.operator_approval_required === true).length, local.rows.length);
});

test('the committed aggregate carries counts, never the supplier catalogue', () => {
  const text = fs.readFileSync(COMMITTED, 'utf8');
  // The only link this file may carry is the developer documentation it quotes.
  const urls = [...text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(urls)].sort(), ['apicenter.commerce.naver.com'], 'no supplier or product URL belongs in the published file');
  assert.ok(!/samamusic|samasound|samastore|yamaha/i.test(text), 'no supplier host appears');
  const ids = new Set(prepRows.map((r) => String(r['공급처원본ID'] ?? '').trim()));
  assert.equal([...ids].filter((id) => text.includes(id)).length, 0, 'no product id appears');
  const names = prepRows.map((r) => String(r['상품명'] ?? '').trim()).filter((n) => n.length > 5);
  assert.equal(names.filter((n) => text.includes(n)).length, 0, `no supplier product name appears (sampled ${names.length})`);
  const codes = prepRows.map((r) => String(r['판매자코드'] ?? '').trim()).filter(Boolean);
  assert.equal(codes.filter((c) => text.includes(c)).length, 0, 'no 판매자코드 appears');
  const children = local.rows.flatMap((row) => row.optionPlan.children.map((c) => c.childName)).filter((n) => n.length > 3);
  assert.ok(children.length > 0, 'the option children must exist for this to be a real check');
  assert.equal(children.filter((n) => text.includes(n)).length, 0, 'no option child label appears');
  // Structure: nothing shaped like a per-product row, and no array of rows.
  const seen = [];
  const walk = (node, trail) => {
    if (Array.isArray(node)) {
      seen.push([trail, node]);
      for (const item of node) walk(item, trail);
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        assert.ok(!['cgi_id', 'cgiId', '상품명', 'product_name', 'seller_management_code', 'sellerManagementCode', 'option_child'].includes(key),
          `${trail}.${key}: a per-product field must not reach the aggregate`);
        walk(value, `${trail}.${key}`);
      }
    }
  };
  const parsed = JSON.parse(text);
  walk(parsed, 'root');
  for (const [trail, node] of seen) {
    if (node.some((item) => item && typeof item === 'object')) {
      assert.ok(node.length <= 10, `${trail}: an array of ${node.length} objects is per-product detail`);
    }
  }
  const census = parsed.census;
  assert.equal(census.products, 4575, 'the only per-product number this file carries is the total');
  assert.deepEqual(Object.keys(census).sort(), ['account_login', 'detail', 'duplicates', 'erp_requests', 'live_writes', 'naver_requests', 'options', 'price', 'products', 'rule', 'stock', 'transmitted']);
});

// --- private rows ------------------------------------------------------------------

const FIXTURE_COLUMNS = ['공급처원본ID', '상품명', '브랜드', '제조사', '모델명', '카테고리경로_CGI', '상세설명', '옵션수', '옵션SKU요약', '원산지코드', '수입사', 'KC고시정보', '판매가', '가격확인필요', '재고수량', '판매자코드'];
const FIXTURE_NAME = 'TEST 무선 이어폰 (블랙/화이트)';
const FIXTURE_ROWS = [
  {
    공급처원본ID: 'test:1', 상품명: FIXTURE_NAME, 브랜드: 'TESTBRAND', 제조사: 'TESTMFG', 모델명: 'T-1',
    카테고리경로_CGI: '음향기기 > 이어폰', 상세설명: '액티브 노이즈 캔슬링 이어폰', 옵션수: '2', 판매자코드: 'TESTCODE0001',
    판매가: '189000', 가격확인필요: '', 재고수량: '', 원산지코드: '', 수입사: '', KC고시정보: '',
    옵션SKU요약: `${FIXTURE_NAME} / 색상 선택 / 블랙 / 아니오 | ${FIXTURE_NAME} / 색상 선택 / 화이트 / 아니오`,
  },
  {
    공급처원본ID: 'test:2', 상품명: 'TEST 케이블', 브랜드: 'TESTBRAND', 제조사: 'TESTMFG', 모델명: 'T-2',
    카테고리경로_CGI: '케이블', 상세설명: '마이크로폰 케이블', 옵션수: '4', 판매자코드: 'TESTCODE0002',
    판매가: '25000', 가격확인필요: '', 재고수량: '', 원산지코드: '', 수입사: '', KC고시정보: '',
    옵션SKU요약: 'TEST 케이블 / 길이선택 / 1m / 아니오 | TEST 케이블 / 길이선택 / 3m (+2,000원) / 아니오 (+2 more)',
  },
  {
    공급처원본ID: 'test:3', 상품명: 'TEST 파우치', 브랜드: 'TESTBRAND', 제조사: 'TESTMFG', 모델명: 'T-3',
    카테고리경로_CGI: '액세서리', 상세설명: 'X & "Y" <script>alert(1)</script>', 옵션수: '0', 판매자코드: 'TESTCODE0003',
    판매가: '', 가격확인필요: '예', 재고수량: '', 원산지코드: '', 수입사: '', KC고시정보: '', 옵션SKU요약: '',
  },
];
const OPTION_COLUMNS_FIXTURE = ['source_key', 'source_site', 'source_product_id', 'product_name', 'option_group', 'option_name', 'option_price', 'option_sold_out', 'option_item_code'];
const OPTION_FIXTURE_ROWS = [
  { source_key: 'test:1', source_site: 'test', source_product_id: '1', product_name: FIXTURE_NAME, option_group: '컬러', option_name: '색상 선택', option_price: '', option_sold_out: 'N', option_item_code: '' },
  { source_key: 'test:2', source_site: 'test', source_product_id: '2', product_name: 'TEST 케이블', option_group: '길이', option_name: '길이선택', option_price: '', option_sold_out: 'N', option_item_code: '' },
];
const EXTENDED_COLUMNS = ['품목코드', '상품명', '공급처원본ID'];
const EXTENDED_FIXTURE_ROWS = FIXTURE_ROWS.map((row, index) => ({ 품목코드: `TEST${index + 1}`, 상품명: row.상품명, 공급처원본ID: row.공급처원본ID }));
const UPLOAD_COLUMNS = ['품목코드', '품목명', '출고단가'];
const UPLOAD_FIXTURE_ROWS = EXTENDED_FIXTURE_ROWS.map((row) => ({ 품목코드: row.품목코드, 품목명: row.상품명, 출고단가: '' }));

const writeFixture = (label, name, content) => {
  const dir = path.join(WORK, label);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return path.relative(ROOT, file).replaceAll('\\', '/');
};

test('the private rows land outside the repository and carry one row per product', () => {
  const prep = writeFixture('private', 'prep.csv', toCsv(FIXTURE_ROWS, FIXTURE_COLUMNS));
  const options = writeFixture('private', 'options.csv', toCsv(OPTION_FIXTURE_ROWS, OPTION_COLUMNS_FIXTURE));
  const extended = writeFixture('private', 'extended.csv', toCsv(EXTENDED_FIXTURE_ROWS, EXTENDED_COLUMNS));
  const upload = writeFixture('private', 'upload.csv', toCsv(UPLOAD_FIXTURE_ROWS, UPLOAD_COLUMNS));
  const planDir = path.join(PRIVATE, '상품등록준비_20261026');
  const stdout = runTool('private', ['--prep', prep, '--options', options, '--extended', extended, '--upload', upload, '--plan-dir', planDir, '--summary', `${WORK_REL}/private/summary.json`]);
  assert.match(stdout, new RegExp(`PLAN_DIR=${planDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(!planDir.startsWith(ROOT), 'the fixture target must sit outside the repository');

  const optionCsv = fs.readFileSync(path.join(planDir, 'cgi_option_plan.csv'), 'utf8');
  const detailCsv = fs.readFileSync(path.join(planDir, 'cgi_detail_drafts.csv'), 'utf8');
  for (const [name, text] of [['cgi_option_plan.csv', optionCsv], ['cgi_detail_drafts.csv', detailCsv]]) {
    assert.ok(text.startsWith('\uFEFF'), `${name} needs the BOM for Excel`);
    assert.match(text, /\r\n$/, `${name} must end with a CRLF line`);
    assert.ok(!text.includes('\ufffd'), `${name} must not contain a replacement character`);
  }
  const planRows = parseCsv(optionCsv);
  assert.deepEqual(Object.keys(planRows[0]), ['cgi_id', 'option_type', 'status', 'emittable', 'reasons', 'groups', 'children', 'children_total', 'usable_known_children', 'sold_out_children', 'add_price_children', 'claimed_option_count', 'summary_entry_count', 'truncated_entries', 'unparsed_entries', 'dropped_groups', 'notes']);
  assert.equal(planRows.length, FIXTURE_ROWS.length, 'one option row per product');
  const byId = new Map(planRows.map((row) => [row.cgi_id, row]));
  assert.deepEqual([byId.get('test:1').status, byId.get('test:1').emittable, byId.get('test:1').children_total], ['complete', 'yes', '2']);
  assert.equal(byId.get('test:1').children, '색상 선택=블랙;색상 선택=화이트');
  assert.equal(byId.get('test:2').emittable, 'no', 'a truncated option list is not a registration candidate');
  assert.equal(byId.get('test:2').status, 'partial');
  assert.match(byId.get('test:2').reasons, /option_children_truncated_in_source/);
  assert.equal(byId.get('test:2').add_price_children, '1');
  assert.equal(byId.get('test:3').status, 'no_options');
  assert.match(byId.get('test:3').reasons, /option_source_absent/);
  for (const row of planRows) for (const code of row.reasons.split(';').filter(Boolean)) assert.ok(REASONS[code], `${code} is emitted but not declared`);

  const detailRows = parseCsv(detailCsv);
  assert.equal(detailRows.length, FIXTURE_ROWS.length);
  for (const row of detailRows) {
    assert.equal(row.counts_as_detail_content, 'no', 'a draft never answers the required detailContent on its own');
    assert.equal(row.operator_approval_required, 'yes');
  }
  assert.equal(byId.get('test:1').reasons, '');
  const pouch = detailRows.find((row) => row.cgi_id === 'test:3');
  assert.ok(!pouch.draft_html.includes('<script>'), 'supplier text is escaped, never live markup');
  assert.ok(pouch.draft_html.includes('&lt;script&gt;'));
  assert.deepEqual(pouch.missing_fields.split(';').sort(), ['importer_absent', 'kc_info_absent', 'origin_code_absent'],
    'a one-line supplier sentence is present, the compliance fields still are not');
  const summary = JSON.parse(fs.readFileSync(path.join(WORK, 'private', 'summary.json'), 'utf8'));
  assert.equal(summary.census.products, FIXTURE_ROWS.length);
  assert.equal(summary.census.stock.requests_executed, 0);
  assert.equal(summary.census.transmitted, false);
});

test('a plan-dir inside the repository is refused before anything is written', () => {
  const inside = path.join(WORK_REL, 'leak');
  const { status, text } = failWith(['--plan-dir', inside]);
  assert.equal(status, 2);
  assert.match(text, /must stay outside/);
  assert.ok(!fs.existsSync(path.join(ROOT, inside)), 'the private rows were written into the repository anyway');
});

// --- refusals ----------------------------------------------------------------------

test('the run refuses to plan on a failed mapping join, a missing source, or an escaping target', () => {
  const nothing = failWith([]);
  assert.equal(nothing.status, 2);
  assert.match(nothing.text, /nothing to write/);

  const missing = failWith(['--prep', 'data/smartstore_prep/no_such_file.csv', '--summary', `${WORK_REL}/guard/x.json`]);
  assert.equal(missing.status, 2);
  assert.match(missing.text, /source file not found: prep/);

  const escape = failWith(['--summary', '../content_escape.json']);
  assert.equal(escape.status, 2);
  assert.match(escape.text, /--summary target escapes the repository/);
  assert.ok(!fs.existsSync(path.resolve(ROOT, '..', 'content_escape.json')), 'the escaped aggregate was written anyway');

  // A prep id the mapping file does not know is the real failure mode here: the
  // record it joins to comes back under the normalised host while the lookup stays
  // on the short form, so the row would silently fall back to a synthetic record
  // carrying no seller code and no price. The run stops instead.
  const columns = Object.keys(prepRows[0]);
  const orphanId = `${String(prepRows[0]['공급처원본ID']).split(':')[0]}:999999999`;
  assert.ok(!recordsByCgiId.has(orphanId), `${orphanId} must be unknown for this refusal to be exercised`);
  const orphan = writeFixture('join', 'prep.csv', toCsv([prepRows[0], { ...prepRows[0], 공급처원본ID: orphanId }], columns));
  const join = failWith(['--prep', orphan, '--summary', `${WORK_REL}/join/summary.json`]);
  assert.equal(join.status, 1, 'an incomplete join must not produce a plan');
  assert.match(join.text, /mapping join incomplete: 1\/2/);
  assert.ok(!fs.existsSync(path.join(WORK, 'join', 'summary.json')), 'a refused run writes nothing');
});
