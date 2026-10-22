/**
 * browser_verify.mjs -- 이슈 #19: HTTP 수집 결과 ↔ 실제 브라우저 표시값 교차검증
 *
 * 표본은 임의가 아니라 계층화(stratified)한다:
 *   - 공급처 사이트 × 공개가 상태(public / inquiry / sold_out) × 옵션 유무
 *   - 브랜드별로 1건 이상
 * 각 표본에서 실제 브라우저로 원본 페이지를 열어 아래를 확인한다.
 *   상품 이미지 / 상품명·모델명 / 공개 판매가격 / 옵션·추가금 / 카테고리 /
 *   상세페이지 / 품절·판매중지 표시
 * 그리고 HTTP 수집 행과 필드별 불일치율을 기록한다.
 *
 * 사용: node tools/full_catalog/browser_verify.mjs <detail_json> <out_dir> [표본수]
 */
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import os from 'node:os';

const detailPath = process.argv[2];
const OUT = resolve(process.argv[3] || 'docs/samples/issue-19');
const TARGET = Number(process.argv[4] || 48);
const EXE = join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe');
mkdirSync(OUT, { recursive: true });

const recs = JSON.parse(readFileSync(detailPath, 'utf8'));
const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const nk = (v) => norm(v).toLowerCase().replace(/[^0-9a-z가-힣]/g, '');

/* ------------------------------------------------------------ 표본 계층화 */
function priceState(r) {
  const st = norm(r.published_price_state);
  if (st) return st;
  const t = norm(r.published_price_text);
  if (t.includes('문의')) return 'inquiry_price';
  if (t.includes('판매')) return 'sold_out_sale_completed';
  if (r.published_price) return 'public';
  return 'missing';
}
function hasOptions(r) {
  try {
    const o = typeof r.option_summary === 'string' ? JSON.parse(r.option_summary) : (r.option_summary || {});
    return Object.values(o).some((v) => Array.isArray(v) && v.length);
  } catch { return false; }
}
const strata = new Map();
for (const r of recs) {
  const site = r.source_site;
  const state = priceState(r);
  const opt = hasOptions(r) ? 'opt' : 'noopt';
  const cell = `${site}|${state}|${opt}`;
  if (!strata.has(cell)) strata.set(cell, []);
  strata.get(cell).push(r);
}
const byBrand = new Map();
for (const r of recs) {
  const b = norm(r.source_brand || r.brand) || '(unknown)';
  if (!byBrand.has(b)) byBrand.set(b, []);
  byBrand.get(b).push(r);
}
const sample = [];
const seen = new Set();
const keyOf = (r) => `${r.source_site}:${r.source_product_id}`;
const take = (r) => { const k = keyOf(r); if (r && !seen.has(k)) { seen.add(k); sample.push(r); } };
for (const [, rows] of strata) {
  const step = Math.max(1, Math.floor(rows.length / 3));
  for (let i = 0; i < rows.length && sample.length < TARGET; i += step) take(rows[i]);
}
let bi = 0;
for (const [, rows] of byBrand) {
  if (sample.length >= TARGET) break;
  if (bi % 3 === 0) take(rows[0]);
  bi++;
}
console.log(`sample size = ${sample.length} (strata=${strata.size}, brands=${byBrand.size})`);

/* ---------------------------------------------------------- 브라우저 추출 */
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR' });
const page = await ctx.newPage();

async function browserFacts(url) {
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!resp || resp.status() >= 400) return { error: 'http_' + (resp ? resp.status() : 'no_response') };
    await page.waitForTimeout(600);
    return await page.evaluate(() => {
      const T = (e) => (e ? (e.textContent || '').replace(/\s+/g, ' ').trim() : '');
      const rows = Array.from(document.querySelectorAll('table tr, .xans-product-detaildesign tr'))
        .map((tr) => [T(tr.querySelector('th, td:nth-child(1)')), T(tr.querySelector('td:nth-child(2)'))])
        .filter(([k]) => k);
      const map = Object.fromEntries(rows);
      const bigImg = document.querySelector('img.BigImage, #mainImage, .prod_img img');
      const thumbs = Array.from(document.querySelectorAll('ul.d_thumb img, .listImg img, .thumb img'))
        .map((i) => i.getAttribute('data-src') || i.getAttribute('src')).filter(Boolean);
      const selects = Array.from(document.querySelectorAll('select[option_title], select[name*="option"]')).map((s) => ({
        title: s.getAttribute('option_title') || s.name,
        values: Array.from(s.options).map((o) => o.textContent.trim()).filter((t) => t && t !== '- 선택 -' && t !== '선택'),
      }));
      const soldOut = !!document.querySelector('.soldout_icon, .soldout, img[src*="soldout"], .product_soldout');
      const soldOutText = T(document.querySelector('.soldout_icon, .product_soldout, .soldout')) || '';
      const breadcrumb = Array.from(document.querySelectorAll('.xans-product-headcategory a, .location a, .breadcrumb a'))
        .map(T).filter(Boolean);
      const addOptionData = (() => {
        const m = document.documentElement.innerHTML.match(/var\s+add_option_data\s*=\s*'([^']*)'/);
        if (!m) return null;
        try { return JSON.parse(m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\')); } catch { return 'parse_error'; }
      })();
      const jsVar = (name) => {
        const m = document.documentElement.innerHTML.match(new RegExp('var\\s+' + name + "\\s*=\\s*'([^']{0,300})'"));
        return m ? m[1] : '';
      };
      const ogTitle = (document.querySelector('meta[property="og:title"]') || {}).content || '';
      const docTitle = (document.title || '').split(' - ')[0].trim();
      return {
        title: document.title,
        productName: map['상품명'] || jsVar('product_name') || ogTitle || docTitle
          || T(document.querySelector('h1, .prod_title, .product_title')),
        priceText: map['판매가'] || T(document.querySelector('#span_product_price_text, .price .strong, .sell_price')),
        consumerPrice: map['소비자가'] || '',
        brand: map['브랜드'] || map['제조사'] || jsVar('product_brand') || '',
        model: map['모델명'] || map['모델명명'] || jsVar('product_model') || '',
        manufacturer: map['제조사'] || '',
        category: map['상품분류'] || '',
        bigImage: bigImg ? (bigImg.getAttribute('src') || bigImg.getAttribute('data-src')) : '',
        thumbCount: thumbs.length,
        selectCount: selects.length,
        selectValueCount: selects.reduce((a, s) => a + s.values.length, 0),
        selectSample: selects.slice(0, 2),
        soldOut,
        soldOutText,
        breadcrumb,
        addOptionData,
        canonical: (document.querySelector('link[rel=canonical]') || {}).href || '',
      };
    });
  } catch (e) {
    return { error: String(e).slice(0, 160) };
  }
}

const results = [];
for (const r of sample) {
  const url = r.canonical_url || r.source_list_url;
  const facts = await browserFacts(url);
  const httpPrice = norm(r.published_price_text);
  const httpImages = (() => {
    const raw = r.image_urls;
    if (!raw) return 0;
    if (Array.isArray(raw)) return raw.length;
    const s = String(raw).trim();
    if (s.startsWith('[')) { try { const v = JSON.parse(s); return Array.isArray(v) ? v.length : 0; } catch { return 0; } }
    return s.split('|').filter((x) => x.trim()).length;
  })();
  const httpOptions = (() => { try { const o = JSON.parse(r.option_summary || '{}'); return Object.values(o).reduce((a, v) => a + (Array.isArray(v) ? v.length : 0), 0); } catch { return 0; } })();
  const nameMatch = nk(facts.productName || '') && nk(r.product_name) ? (nk(facts.productName) === nk(r.product_name) ? 'match' : (nk(facts.productName).includes(nk(r.product_name)) || nk(r.product_name).includes(nk(facts.productName)) ? 'partial' : 'diff')) : 'unknown';
  const priceDigits = (t) => (norm(t).match(/[0-9,]+/g) || []).join('');
  const priceMatch = facts.error ? 'unknown'
    : (priceDigits(httpPrice) && priceDigits(httpPrice) === priceDigits(facts.priceText) ? 'match'
      : (priceDigits(httpPrice) === priceDigits(facts.priceText) ? 'match'
        : (priceDigits(httpPrice) && priceDigits(facts.priceText) ? 'diff' : 'partial')));
  const imageMatch = facts.error ? 'unknown' : (httpImages > 0 && facts.thumbCount > 0 ? 'match' : (httpImages === 0 && facts.thumbCount === 0 ? 'match' : 'diff'));
  const optionMatch = facts.error ? 'unknown' : ((httpOptions > 0) === (facts.selectValueCount > 0) ? 'match' : 'diff');
  results.push({
    source_key: r.source_key || `${r.source_site}:${r.source_product_id}`,
    url,
    stratum: `${r.source_site}|${priceState(r)}|${hasOptions(r) ? 'opt' : 'noopt'}`,
    http: {
      product_name: r.product_name, published_price_text: r.published_price_text,
      image_count: httpImages, option_value_count: httpOptions,
      brand: r.source_brand, model: r.model, category_name: r.source_category_name,
      soldout_display: r.soldout_display, verification_status: r.verification_status,
    },
    browser: facts,
    match: { name: nameMatch, price: priceMatch, image: imageMatch, option: optionMatch },
  });
  console.log(`${results.length}/${sample.length} ${results[results.length - 1].source_key} ` +
    `name=${nameMatch} price=${priceMatch} image=${imageMatch} option=${optionMatch}`);
}

const tally = (field) => {
  const out = {};
  for (const r of results) out[r.match[field]] = (out[r.match[field]] || 0) + 1;
  return out;
};
const summary = {
  verified_at: new Date().toISOString(),
  sample_size: results.length,
  strata: Object.fromEntries([...strata].map(([k, v]) => [k, v.length])),
  match_rate: {
    name: tally('name'), price: tally('price'), image: tally('image'), option: tally('option'),
  },
  full_match: results.filter((r) => Object.values(r.match).every((v) => v === 'match')).length,
  errors: results.filter((r) => r.browser.error).length,
};
writeFileSync(join(OUT, 'browser_verification.json'), JSON.stringify({ summary, results }, null, 1), 'utf8');
console.log('SUMMARY ' + JSON.stringify(summary.match_rate) + ' full_match=' + summary.full_match + '/' + summary.sample_size);
await browser.close();
