// M1 — detailContent template tests. The template may only repeat what the
// supplier columns state; every test here pins one way an invention could slip
// in: an absent field rendered anyway, an inquiry price turned into a number,
// a truncated option list advertised, HTML injection through a product name,
// or a draft that claims to satisfy the required field by itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  buildDetailTemplate, buildDetailSampleDocument, formatWon, DETAIL_TEMPLATE_DOC,
} from '../../lib/detail-template.mjs';
import { buildOptionPlan } from '../../lib/registration-content.mjs';

const baseRow = {
  '공급처원본ID': 'samasound:3836',
  '상품명': 'SQ5+ 디지털 믹서',
  '브랜드': 'ALLEN&HEATH',
  '제조사': 'Allen&Heath',
  '모델명': 'SQ5+',
  '카테고리경로_CGI': '홈 > 제품분류별 보기 > 프로 오디오 > 믹서',
  '판매가': '1680000',
  '가격확인필요': '아니오',
  '대표이미지URL': 'https://www.samasound.co.kr/web/product/small/202607/sq5.png',
  '상세설명': '48채널 44버스 17페이더 디지털 믹서',
  '옵션수': '0',
  '옵션SKU요약': '',
  '출처URL': 'https://samasound.co.kr/product/sq5/3836/',
};

// assessMeasuredImage probes by sha256(url) — the same key the committed
// measurement tables use, so the tests build evidence indexes with that key.
const evidenceFor = (url, base, variant = null) => new Map([
  [crypto.createHash('sha256').update(url).digest('hex'), { base, variant }],
]);

test('a full row renders every verified block and names its source', () => {
  const nonePlan = buildOptionPlan({ cgiId: 'samasound:3836', productName: baseRow['상품명'], summary: '', optionCount: '0', groupRows: [] });
  const template = buildDetailTemplate({ prepRow: baseRow, optionPlan: nonePlan });
  assert.equal(template.counts_as_detail_content, false);
  assert.equal(template.operator_approval_required, true);
  assert.equal(template.blocks.find((b) => b.key === 'image').present, true);
  assert.equal(template.blocks.find((b) => b.key === 'price').present, true);
  assert.equal(template.blocks.find((b) => b.key === 'options_table').present, false, 'no option data in the row');
  assert.ok(template.html.includes('판매가 1,680,000원'));
  assert.ok(template.html.includes('ALLEN&amp;HEATH'), 'the brand must be HTML-escaped');
  assert.ok(template.html.includes('https://samasound.co.kr/product/sq5/3836/'));
  assert.ok(template.html.includes('운영자 확인'), 'the approval notice must ride in the body');
  assert.ok(template.reasons.includes('options_not_emittable'), 'the absent option table is named, not skipped silently');
});

test('an absent field is never rendered, only reported', () => {
  const sparse = buildDetailTemplate({ prepRow: { '상품명': '미니 앰프', '가격확인필요': '예' } });
  assert.ok(!sparse.html.includes('제조사'), 'no manufactured-from-nothing label');
  assert.ok(!sparse.html.includes('판매가'), 'no invented price');
  assert.ok(!sparse.html.includes('<img'), 'no image without a URL');
  for (const reason of ['brand_absent', 'manufacturer_absent', 'model_absent', 'price_inquiry_omitted', 'detail_sentence_absent', 'source_url_absent']) {
    assert.ok(sparse.reasons.includes(reason), `${reason} must be reported`);
  }
});

test('an inquiry price is never displayed even when a number sits in the cell', () => {
  const template = buildDetailTemplate({ prepRow: { ...baseRow, '가격확인필요': '예' } });
  assert.ok(!template.html.includes('1,680,000'));
  assert.equal(template.blocks.find((b) => b.key === 'price').present, false);
  assert.ok(template.reasons.includes('price_inquiry_omitted'));
});

test('HTML in supplier text is escaped, not executed', () => {
  const template = buildDetailTemplate({
    prepRow: { ...baseRow, '상품명': 'Микшер <script>alert(1)</script>', '상세설명': '스펙 & "따옴표" 테스트' },
  });
  assert.ok(!template.html.includes('<script>alert(1)</script>'));
  assert.ok(template.html.includes('&lt;script&gt;'));
  assert.ok(template.html.includes('&quot;따옴표&quot;'));
});

test('the measured image size rides on the img tag; below-recommended stays a note, not a rejection', () => {
  const url = baseRow['대표이미지URL'];
  const ok = buildDetailTemplate({
    prepRow: baseRow,
    evidence: evidenceFor(url, { httpStatus: 200, container: 'png', width: 1000, height: 1000, bytes: 74535, formatAllowed: true, animationIndicator: false }),
  });
  assert.ok(ok.html.includes('width="1000" height="1000"'), 'measured dimensions must reserve the box');
  assert.ok(!ok.notes.some((n) => /권장 미만/.test(n)));

  const below = buildDetailTemplate({
    prepRow: baseRow,
    evidence: evidenceFor(url, { httpStatus: 200, container: 'png', width: 500, height: 500, bytes: 100, formatAllowed: true, animationIndicator: false }),
  });
  assert.ok(below.html.includes('width="500" height="500"'));
  assert.ok(below.notes.some((n) => /권장 미만/.test(n)), 'the shortfall is a note — the contract has no minimum');

  const unmeasured = buildDetailTemplate({ prepRow: baseRow, evidence: new Map() });
  assert.ok(unmeasured.html.includes('<img'), 'an unmeasured URL still renders — the note says so');
  assert.ok(unmeasured.notes.some((n) => /실측 레코드가 없다/.test(n)), 'unmeasured must be stated, not passed silently');
});

test('an emittable option plan renders a table; a truncated one is refused', () => {
  const completePlan = buildOptionPlan({
    cgiId: 'samamusic:2574',
    productName: '인터페이스',
    summary: '인터페이스 / 색상 / 블랙 / 아니오|인터페이스 / 색상 / 실버 / 아니오',
    optionCount: '2',
    groupRows: [{ option_name: '색상' }],
  });
  assert.equal(completePlan.emittable, true);
  const rendered = buildDetailTemplate({ prepRow: { '상품명': '인터페이스' }, optionPlan: completePlan });
  assert.ok(rendered.html.includes('블랙'));
  assert.ok(rendered.html.includes('실버'));

  const truncatedPlan = buildOptionPlan({
    cgiId: 'samamusic:1',
    productName: '인터페이스',
    summary: '인터페이스 / 색상 / 블랙 / 아니오(+2 more)',
    optionCount: '4',
    groupRows: [{ option_name: '색상' }],
  });
  assert.equal(truncatedPlan.emittable, false);
  const refused = buildDetailTemplate({ prepRow: { '상품명': '인터페이스' }, optionPlan: truncatedPlan });
  assert.ok(!refused.html.includes('옵션</h3>'), 'a truncated list must not be advertised');
  assert.ok(refused.reasons.includes('options_not_emittable'));
});

test('sold-out options and add-prices repeat the supplier markers verbatim', () => {
  const plan = buildOptionPlan({
    cgiId: 'samamusic:9',
    productName: '케이블',
    summary: '케이블 / 길이 / 3m / 아니오|케이블 / 길이 / 5m (+20000원) / 아니오|케이블 / 길이 / 10m [품절] / 예',
    optionCount: '3',
    groupRows: [{ option_name: '길이' }],
  });
  const template = buildDetailTemplate({ prepRow: { '상품명': '케이블' }, optionPlan: plan });
  assert.ok(template.html.includes('(+20,000원)'));
  assert.ok(template.html.includes('[품절]'));
});

test('the standalone preview document keeps the draft intact and adds only the preview chrome', () => {
  const template = buildDetailTemplate({ prepRow: baseRow });
  const doc = buildDetailSampleDocument({ template, cgiId: 'samasound:3836', supplierSite: 'samasound' });
  assert.ok(doc.startsWith('<!doctype html>'));
  assert.ok(doc.includes(template.html), 'the preview must embed the exact draft body');
  assert.ok(doc.includes('viewport'), 'the preview must render mobile-sized viewports properly');
  assert.ok(doc.includes('시안 프리뷰'));
});

test('formatWon is locale-independent and the doc keeps its unconfirmed list', () => {
  assert.equal(formatWon(1680000), '1,680,000');
  assert.equal(formatWon(999999990), '999,999,990');
  assert.equal(formatWon('abc'), null);
  assert.ok(DETAIL_TEMPLATE_DOC.unconfirmed.some((u) => /detailContent/.test(u)));
  assert.ok(/외부 URL/.test(DETAIL_TEMPLATE_DOC.detailImageRule));
});
