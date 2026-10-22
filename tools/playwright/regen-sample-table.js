'use strict';
/**
 * Regenerates the 20-row sample table inside reports/site-analysis-playwright.md
 * straight from reports/evidence/products-raw.json, so the report can never
 * drift from the measured data.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'evidence', 'products-raw.json'), 'utf8'));
const MD = path.join(ROOT, 'reports', 'site-analysis-playwright.md');
const md = fs.readFileSync(MD, 'utf8');

const HEADER = '| # | id | 브랜드 | 모델명 | 공개 판매가 | 가격 종류 | 재고 | own 옵션 | 크로스셀 옵션 | 이미지 수 | 비고 |';
const SEP = '|---|---|---|---|---|---|---|---|---|---|---|';

const note = (r) => {
  const bits = [];
  if (r.sample_reason === 'edge_case_api_flagged') bits.push('엣지(API 플래그)');
  if (r.sample_reason === 'list_placeholder_defect') bits.push('SSR 결함');
  if (r.sample_reason && r.sample_reason.startsWith('category:')) bits.push(r.sample_source_category);
  if (r.jsonld_type === 'ProductGroup') bits.push('ProductGroup');
  if (r.retail_price !== '') bits.push(`소비자가 ${Number(r.retail_price).toLocaleString('en-US')}`);
  return bits.join(', ');
};

const table = [
  HEADER,
  SEP,
  ...rows.map((r, i) => {
    const price = r.published_price === '' ? '*(공란)*' : Number(r.published_price).toLocaleString('en-US');
    const priceKind = r.published_price_kind === 'numeric'
      ? 'numeric'
      : `**${r.published_price_kind}** \`${r.published_price_text}\``;
    const stock = r.stock_status === 'in_stock' ? 'in_stock' : `**${r.stock_status}**`;
    const own = r.option_group_count > 0 ? `**${r.option_group_count}**` : '0';
    const cross = r.cross_sell_group_count > 0 ? `**${r.cross_sell_group_count}**` : '0';
    return `| ${i + 1} | ${r.source_product_id} | ${r.brand} | ${r.model_name || '*(없음)*'} | ${price} | ${priceKind} | ${stock} | ${own} | ${cross} | ${r.image_count} | ${note(r)} |`;
  }),
].join('\n');

const lines = md.split('\n');
const start = lines.indexOf(HEADER);
if (start < 0) { console.error('sample table header not found'); process.exit(1); }
let end = start;
while (end < lines.length && lines[end].startsWith('|')) end += 1;
const out = [...lines.slice(0, start), ...table.split('\n'), ...lines.slice(end)];
fs.writeFileSync(MD, out.join('\n'), 'utf8');
console.log(`sample table regenerated (${rows.length} rows)`);
