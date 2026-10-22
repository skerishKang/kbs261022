'use strict';
/**
 * Guards the report against drifting away from the measured data.
 *
 * It re-reads reports/evidence/*.json and checks that every number that is
 * quoted in reports/site-analysis-playwright.md still matches reality:
 *   - the 20-row sample table (cell by cell)
 *   - the headline counters (parity, set operations, images, domain identity)
 *   - the sold-out agreement
 *
 * Run after every pipeline run:  node verify-report-consistency.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const E = path.join(ROOT, 'reports', 'evidence');
const MD = path.join(ROOT, 'reports', 'site-analysis-playwright.md');

const read = (f) => JSON.parse(fs.readFileSync(path.join(E, f), 'utf8'));
const md = fs.readFileSync(MD, 'utf8');
const mdLines = md.split('\n');

const issues = [];
const ok = [];
function check(name, condition, detail) {
  if (condition) ok.push(name);
  else issues.push(`${name}${detail ? ` -> ${detail}` : ''}`);
}

// ---------------------------------------------------------------- sample table
const rows = read('products-raw.json');
const headerIdx = mdLines.findIndex((l) => l.includes('| id | 브랜드 | 모델명 |'));
if (headerIdx < 0) {
  issues.push('sample table header not found in the report');
} else {
  const tableRows = mdLines.slice(headerIdx + 2).filter((l) => l.startsWith('| '))
    .map((l) => l.split('|').map((c) => c.trim()));
  let matched = 0;
  rows.forEach((r) => {
    const row = tableRows.find((cells) => cells[2] === r.source_product_id);
    if (!row) { issues.push(`sample table: row for ${r.source_product_id} missing`); return; }
    matched += 1;
    const price = r.published_price === '' ? '*(공란)*' : Number(r.published_price).toLocaleString('en-US');
    const want = {
      3: r.brand,
      4: r.model_name || '*(없음)*',
      5: price,
      6: r.published_price_kind === 'numeric' ? 'numeric' : `**${r.published_price_kind}** \`${r.published_price_text}\``,
      7: r.stock_status === 'in_stock' ? 'in_stock' : `**${r.stock_status}**`,
      8: r.option_group_count > 0 ? `**${r.option_group_count}**` : '0',
      9: r.cross_sell_group_count > 0 ? `**${r.cross_sell_group_count}**` : '0',
      10: String(r.image_count),
    };
    Object.entries(want).forEach(([idx, w]) => {
      if (String(row[idx]) !== String(w)) {
        issues.push(`sample table ${r.source_product_id} col${idx}: report="${row[idx]}" data="${w}"`);
      }
    });
  });
  check(`sample table rows match (${matched}/${rows.length})`, matched === rows.length && matched === 20);
}

// ------------------------------------------------------------ headline numbers
const parity = read('api-browser-parity.json');
const final = read('final-verification.json');
const sold = read('soldout-render.json');

const p = parity.parity_summary;
check('parity sample size is 40', p.sampled === 40, `got ${p.sampled}`);
check('parity name match 40/40', p.name_match === 40, `got ${p.name_match}`);
check('parity brand match 40/40', p.brand_match === 40, `got ${p.brand_match}`);
check('parity model match 40/40', p.model_match === 40, `got ${p.model_match}`);
check('parity numeric price match 37/37', p.price_match_rate_numeric === '37/37', p.price_match_rate_numeric);
check('parity sold-out agreement 12/12', p.sold_out_agreement === '12/12', p.sold_out_agreement);
check('parity has no false sold-out', p.false_sold_out === 0, `got ${p.false_sold_out}`);
check('parity has no browser error', p.browser_errors === 0, `got ${p.browser_errors}`);

const s = parity.set_operations;
check('api catalog is 1969', s.api_total === 1969, `got ${s.api_total}`);
check('sitemap products are 1597', s.sitemap_total_product_ids === 1597, `got ${s.sitemap_total_product_ids}`);
check('api-only (sitemap gap) is 372', s.api_only_count === 372, `got ${s.api_only_count}`);
check('sitemap-only is 0', s.sitemap_only_count === 0, `got ${s.sitemap_only_count}`);
check('intersection is 1597', s.intersection === 1597, `got ${s.intersection}`);

const imgOk = final.image_checks.filter((i) => i.status === 200).length;
check('all checked images return HTTP 200', imgOk === final.image_checks.length, `${imgOk}/${final.image_checks.length}`);

const idem = final.domain_checks.filter((d) => d.identical).length;
check('both domains serve identical products (5/5)', idem === 5 && final.domain_checks.length === 5, `${idem}/${final.domain_checks.length}`);

const soDetail = sold.details.filter((d) => d.visible_sold_out_badge).length;
check('sold-out badge visible on every sold-out detail page', soDetail === sold.details.length, `${soDetail}/${sold.details.length}`);
const soList = sold.lists.reduce((a, l) => a + l.cards.filter((c) => c.visible_sold_out_badge).length, 0);
check('no sold-out badge on list cards', soList === 0, `got ${soList}`);
const leftovers = sold.details.filter((d) => d.template_leftover_badge).length;
check('the soldout_{$productNo} template leftover is present on every page', leftovers === sold.details.length, `${leftovers}/${sold.details.length}`);

// ------------------------------------------------------------- report wording
const csvRows = fs.readFileSync(path.join(ROOT, 'reports', 'data', 'samastore-playwright-sample.csv'), 'utf8')
  .replace(/^\ufeff/, '').trim().split('\n').length - 1;
check('sample CSV has 20 data rows', csvRows === 20, `got ${csvRows}`);

const shots = fs.existsSync(path.join(ROOT, 'reports', 'screenshots'))
  ? fs.readdirSync(path.join(ROOT, 'reports', 'screenshots')).length : 0;
check('report mentions the real screenshot count', md.includes(`검증 스크린샷 ${shots}장`), `shots=${shots}`);

const cgiBlank = rows.every((r) => r.cgi_supply_price === '' || r.cgi_supply_price === undefined)
  && rows.every((r) => r.cgi_supply_price_status === 'unverified_no_authority');
check('CGI supply price is blank + unverified on every row', cgiBlank);

const inquiryOk = rows.filter((r) => r.published_price_kind !== 'numeric')
  .every((r) => r.published_price === '' || r.published_price === undefined);
check('no price is invented for inquiry / sale-closed rows', inquiryOk);

// -------------------------------------------------------------------- report
ok.forEach((n) => console.log(`  ok  ${n}`));
if (issues.length) {
  console.error(`\n${issues.length} PROBLEM(S):`);
  issues.forEach((i) => console.error(`  !!  ${i}`));
  process.exit(1);
}
console.log(`\n${ok.length} consistency checks passed`);
