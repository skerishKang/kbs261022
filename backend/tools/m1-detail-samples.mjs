#!/usr/bin/env node
// M1 — render the first 10 detailContent TEMPLATES from the real catalogue.
//
// Reads the committed prep CSV + measured image evidence + supplier option
// table, builds the responsive draft for every product, and picks 10 samples
// deterministically: fully measurable images first, then the most complete
// verified field set, ties broken by cgi_id — with at least three samples per
// supplier site when the pool allows, so both 삼아사운드 and 삼아스토어 are
// visible to the operator.
//
// Outputs (reports/data/registration/detail_samples/):
//   sample-NN-<cgiId>.html   standalone preview (PC/mobile render check input)
//   index.html               gallery linking the samples
//   manifest.json            selection rule, per-sample blocks/reasons/sources
//
// Nothing is uploaded, nothing is registered, no network call happens here.
// 상품 원본 데이터는 읽기만 한다 — prep CSV·마스터는 변경하지 않는다.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseCsv } from '../lib/product-mapping.mjs';
import { joinImageEvidence, assessMeasuredImage } from '../lib/naver-images.mjs';
import { buildOptionPlan } from '../lib/registration-content.mjs';
import { buildDetailTemplate, buildDetailSampleDocument } from '../lib/detail-template.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCES = {
  prep: 'data/smartstore_prep/smartstore_registration_prep.csv',
  imageMeasurements: 'reports/data/naver/image_measurements.csv',
  imageVariantMeasurements: 'reports/data/naver/image_variant_measurements.csv',
  options: 'data/full_catalog/options_compact.csv',
};
const OUT_DIR_REL = 'reports/data/registration/detail_samples';
const SAMPLE_COUNT = 10;

const readCsv = (rel) => parseCsv(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const prepRows = readCsv(SOURCES.prep);
const optionRows = readCsv(SOURCES.options);
const evidence = joinImageEvidence(readCsv(SOURCES.imageMeasurements), readCsv(SOURCES.imageVariantMeasurements));

const groupRowsByProduct = new Map();
for (const row of optionRows) {
  const key = `${String(row.source_site || '').trim()}:${String(row.source_product_id || '').trim()}`;
  if (!groupRowsByProduct.has(key)) groupRowsByProduct.set(key, []);
  groupRowsByProduct.get(key).push(row);
}

const scored = [];
for (const prepRow of prepRows) {
  const cgiId = String(prepRow['공급처원본ID'] || '').trim();
  if (!cgiId) continue;
  const site = cgiId.split(':')[0] || '';
  const optionPlan = buildOptionPlan({
    cgiId,
    productName: prepRow['상품명'] || '',
    summary: prepRow['옵션SKU요약'] || '',
    optionCount: prepRow['옵션수'] || '',
    groupRows: groupRowsByProduct.get(cgiId) || [],
  });
  const template = buildDetailTemplate({ prepRow, optionPlan, evidence });
  const present = new Set(template.blocks.filter((b) => b.present).map((b) => b.key));
  // Selection score: how much verified material the draft can show. The image
  // gate is binary on the measured state (ok or rescued by a larger segment) —
  // an unmeasured or broken image never becomes the operator's first sample.
  const imageOk = ['ok', 'ok_via_segment'].includes(template.blocks.find((b) => b.key === 'image')?.state || '');
  const score =
    (imageOk ? 8 : 0) +
    (present.has('price') ? 4 : 0) +
    (present.has('options_table') ? 2 : 0) +
    (present.has('sentence') ? 1 : 0) +
    (present.has('spec_table') ? 1 : 0) +
    (present.has('source_link') ? 1 : 0);
  scored.push({ cgiId, site, score, imageOk, template, prepRow });
}

const pick = (pool, count, taken) => {
  const chosen = [];
  for (const item of pool) {
    if (chosen.length >= count) break;
    if (taken.has(item.cgiId)) continue;
    taken.add(item.cgiId);
    chosen.push(item);
  }
  return chosen;
};

const taken = new Set();
const byScore = [...scored].sort((a, b) => b.score - a.score || (a.cgiId < b.cgiId ? -1 : 1));
const sites = [...new Set(scored.map((s) => s.site))].sort();
// 최소 사이트당 3건(가능한 경우) → 나머지는 점수순으로 채운다.
const perSite = Math.min(3, Math.floor(SAMPLE_COUNT / Math.max(1, sites.length)));
let samples = [];
for (const site of sites) {
  samples = samples.concat(pick(byScore.filter((s) => s.site === site), perSite, taken));
}
samples = samples.concat(pick(byScore, SAMPLE_COUNT - samples.length, taken));
samples = samples.slice(0, SAMPLE_COUNT);

fs.mkdirSync(path.join(ROOT, OUT_DIR_REL), { recursive: true });
const manifest = {
  kind: 'cgi-m1-detail-samples',
  generated_from: SOURCES,
  selection_rule: 'image measured ok/ok_via_segment 가산, price·options·sentence·spec·source 블록 가산, cgi_id 타이브레이크, 사이트당 최소 3건(가능 시)',
  sample_count: samples.length,
  candidates_considered: scored.length,
  candidates_image_ok: scored.filter((s) => s.imageOk).length,
  samples: [],
};

const outDir = path.join(ROOT, OUT_DIR_REL);
samples.forEach((sample, index) => {
  const fileName = `sample-${String(index + 1).padStart(2, '0')}-${sample.cgiId.replace(/[^A-Za-z0-9_-]+/g, '_')}.html`;
  const doc = buildDetailSampleDocument({ template: sample.template, cgiId: sample.cgiId, supplierSite: sample.site });
  fs.writeFileSync(path.join(outDir, fileName), doc, 'utf8');
  manifest.samples.push({
    index: index + 1,
    cgi_id: sample.cgiId,
    site: sample.site,
    product_name: sample.prepRow['상품명'] || '',
    file: fileName,
    score: sample.score,
    blocks: sample.template.blocks,
    reasons: sample.template.reasons,
    notes: sample.template.notes,
    counts_as_detail_content: false,
    operator_approval_required: true,
  });
});

const indexHtml = `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>M1 상세설명 시안 색인</title></head>
<body style="font-family:sans-serif;max-width:900px;margin:0 auto;padding:16px;">
<h1>M1 상세설명 시안 ${samples.length}건</h1>
<p>규칙: ${manifest.selection_rule}</p>
<p>후보 ${manifest.candidates_considered}건 중 이미지 실측 통과 ${manifest.candidates_image_ok}건. 본문은 공급처 게시 정보만으로 구성 — 등록 전 운영자 승인 필요.</p>
<ol>${manifest.samples.map((s) => `<li><a href="${s.file}">${s.cgi_id}</a> — ${s.product_name}</li>`).join('')}</ol>
</body></html>`;
fs.writeFileSync(path.join(outDir, 'index.html'), indexHtml, 'utf8');
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log(JSON.stringify({
  out_dir: OUT_DIR_REL,
  sample_count: manifest.samples.length,
  candidates_considered: manifest.candidates_considered,
  candidates_image_ok: manifest.candidates_image_ok,
  samples: manifest.samples.map((s) => ({ cgi_id: s.cgi_id, site: s.site, score: s.score, file: s.file })),
}, null, 2));
