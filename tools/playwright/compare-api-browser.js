'use strict';
/**
 * Cross-check the browser view against the public JSON API and the sitemap.
 *
 * Three questions this answers with measurements (not estimates):
 *   Q1  sitemap vs API   : how many product URLs does sitemap.xml expose, and how many
 *                          products does the Dalue JSON API return? What is the delta?
 *   Q2  API vs browser   : for products that exist in both, do price / model / brand /
 *                          soldOut agree? (API value is the baseline, browser is the check)
 *   Q3  sitemap-only     : are products that are missing from the sitemap still
 *                          reachable/visible in the actual storefront (browser search)?
 *
 * Usage:
 *   node compare-api-browser.js --sample 20 --out ../../reports/data/api-browser-parity.csv
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { launch, sleep, withRetry, logEvidence, shotPath, ROOT } = require('./lib/browser');
const X = require('./lib/extractors');

const ARGS = process.argv.slice(2);
const arg = (n, d) => { const i = ARGS.indexOf(`--${n}`); return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d; };

const OUT_CSV = path.resolve(__dirname, '..', '..', arg('out', 'reports/data/api-browser-parity.csv'));
const EVID = 'compare-api-browser.jsonl';
const SAMPLES = Number(arg('sample', 20));

/* ------------------------------------------------------------- HTTP helper */

function httpGet(url, { redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/153.0.0.0', 'Accept-Language': 'ko-KR,ko;q=0.9' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(httpGet(next, { redirects: redirects - 1 }));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

function httpPostForm(url, form) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(form).toString();
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Content-Length': Buffer.byteLength(data),
        'Origin': 'https://www.samamusic.co.kr',
        'Referer': 'https://www.samamusic.co.kr/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/153.0.0.0',
      },
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/* --------------------------------------------------------------- Dalue API */

const DALUE_FIELDS = [
  'productNo', 'productName', 'price', 'retailPrice', 'pointsAmount', 'image', 'soldOut',
  'pcDiscountPrice', 'mobileDiscountPrice', 'exposureLimitType', 'exposureGroupList',
  'categoryNos', 'brandName', 'display', 'selling', 'productCode', 'categoryRoot1No',
  'simpleDescription', 'modelName', 'icon', 'iconShowPeriod', 'listIcon',
  'summaryDescription', 'options', 'priceContent',
].join(',');
/**
 * The storefront itself talks to `POST https://api.dalue.io:10806/dcse/query`
 * (captured from a real browser session - see tools/playwright/probe-network.js).
 * The endpoint, the `apiKey` and the parameter set are all public values that the
 * storefront ships inside its own pages, so no credential is involved.
 */
async function fetchApiCatalog() {
  const url = 'https://api.dalue.io:10806/dcse/query';
  const form = {
    apiKey: 'Ak25dpcSKLXu',
    collName: 'products',
    query: '*',
    begin: '1',
    size: '2000',
    sortField: '',
    sortType: '',
    categoryIdFields: 'categoryRoot1No,categoryRoot2No',
    categoryNameFields: 'categoryRoot1,categoryRoot2',
    brandIdField: 'brandCode',
    brandNameField: 'brandName',
    brandCode: '',
    categoryId: '',
    rangeFields: 'pcDiscountPrice',
    rangeValues: '0,9999999999',
    categoryAuthFieldName: 'categoryNos',
    categoryAuthDevice: '1',
    categoryAuthMemberType: '0',
    vFields: DALUE_FIELDS,
    equalFields: 'display,selling',
    equalValues: '1,1',
    aclFlagField: 'exposureLimitType',
    aclFlagValue: 'M',
    aclField: 'exposureGroupList',
    aclFieldValue: '0',
    aclShow: '0',
    aclRemoveFields: 'price,mobilePrice,pcPrice',
    priceField: 'pcDiscountPrice',
    priceClusterNo: '3',
    mallId: 'sama2015',
    shopNo: '1',
    mallType: 'cafe24',
  };
  const res = await httpPostForm(url, form);
  if (res.status !== 200) throw new Error(`Dalue API HTTP ${res.status}`);
  const json = JSON.parse(res.body);
  if (!json.header || json.header.code !== 0) {
    throw new Error(`Dalue API code=${json.header && json.header.code} msg=${json.header && json.header.message}`);
  }
  return json;
}

/* ---------------------------------------------------------------- sitemap */

async function fetchSitemap() {
  const res = await httpGet('https://samastore.co.kr/sitemap.xml');
  const locs = [...res.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const productLocs = locs.filter((l) => /\/product\//.test(l) || /product_no=/.test(l));
  const categoryLocs = locs.filter((l) => /\/category\//.test(l));
  const otherLocs = locs.filter((l) => !/\/product\//.test(l) && !/\/category\//.test(l) && !/product_no=/.test(l));
  const ids = new Set();
  const idFromUrl = [];
  productLocs.forEach((l) => {
    // CAFE24 product URL shape: https://samastore.co.kr/product/<slug>/<product_no>/
    const m = l.match(/\/product\/[^/]*\/(\d+)\/?$/);
    const m2 = l.match(/product_no=(\d+)/);
    const id = m ? m[1] : (m2 ? m2[1] : null);
    if (id) { ids.add(id); idFromUrl.push({ id, url: l }); }
  });
  return {
    status: res.status,
    bytes: Buffer.byteLength(res.body),
    total_locs: locs.length,
    product_locs: productLocs.length,
    category_locs: categoryLocs.length,
    other_locs: otherLocs.length,
    other_sample: otherLocs.slice(0, 10),
    product_ids: [...ids],
    id_from_url: idFromUrl,
  };
}

/* ------------------------------------------------------------------- main */

(async () => {
  const outDir = path.dirname(OUT_CSV);
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'reports', 'evidence'), { recursive: true });

  const report = {};

  // --- API ---
  let api = null;
  try {
    api = await fetchApiCatalog();
    report.api = {
      header: api.header,
      result_count: (api.result || []).length,
    };
    logEvidence(EVID, { step: 'api', totalCount: api.header && api.header.totalCount, count: api.header && api.header.count });
  } catch (err) {
    report.api_error = String(err.message || err);
    logEvidence(EVID, { step: 'api', error: report.api_error });
  }

  // --- sitemap ---
  let sitemap = null;
  try {
    sitemap = await fetchSitemap();
    report.sitemap = sitemap;
    logEvidence(EVID, { step: 'sitemap', product_locs: sitemap.product_locs, total_locs: sitemap.total_locs });
  } catch (err) {
    report.sitemap_error = String(err.message || err);
    logEvidence(EVID, { step: 'sitemap', error: report.sitemap_error });
  }

  // --- set operations ---
  if (api && sitemap) {
    const apiIds = new Set((api.result || []).map((r) => String(r.productNo)));
    const smIds = new Set(sitemap.product_ids);
    const inBoth = [...apiIds].filter((i) => smIds.has(i));
    const apiOnly = [...apiIds].filter((i) => !smIds.has(i));
    const smOnly = [...smIds].filter((i) => !apiIds.has(i));
    report.set_operations = {
      api_total: apiIds.size,
      sitemap_total_product_ids: smIds.size,
      intersection: inBoth.length,
      api_only_count: apiOnly.length,
      sitemap_only_count: smOnly.length,
      api_only_sample: apiOnly.slice(0, 40),
      sitemap_only_sample: smOnly.slice(0, 40),
    };
    logEvidence(EVID, { step: 'setops', ...report.set_operations, api_only_sample: undefined, sitemap_only_sample: undefined });
  }

  fs.writeFileSync(path.join(ROOT, 'reports', 'evidence', 'api-sitemap-parity.json'), JSON.stringify(report, null, 2), 'utf8');

  /* --- Q3: are sitemap-only / api-only products reachable in the browser? --- */
  const { browser, context } = await launch({ headless: process.env.SAMASTORE_HEADLESS === '1' });
  const page = await context.newPage();
  const browserChecks = [];

  const probeProduct = async (pno, label) => {
    const url = `https://www.samamusic.co.kr/product/detail.html?product_no=${pno}&cate_no=42&display_group=1`;
    const rec = { product_no: pno, group: label, url };
    try {
      await withRetry(async () => {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(1500);
      }, { label: `probe:${pno}` });
      const d = await page.evaluate(() => {
        const t = (el) => (el ? (el.innerText || el.textContent).replace(/\s+/g, ' ').trim() : '');
        const spec = {};
        document.querySelectorAll('table').forEach((tb) => {
          const cap = (tb.querySelector('caption')?.textContent || '').trim();
          if (!cap.includes('기본 정보')) return;
          tb.querySelectorAll('tr').forEach((tr) => {
            const th = tr.querySelector('th'); const td = tr.querySelector('td');
            if (th && td) spec[(th.textContent || '').trim()] = (td.textContent || '').replace(/\s+/g, ' ').trim();
          });
        });
        return {
          title: document.title,
          h1: t(document.querySelector('h1,h2.item_name')),
          spec_name: spec['상품명'] || '',
          spec_price: spec['판매가'] || '',
          spec_brand: spec['브랜드'] || '',
          spec_model: spec['모델명'] || '',
          is_not_found: /상품이 존재하지|찾을 수 없|404|페이지가 존재하지/i.test(document.body.innerText || ''),
          body_len: (document.body.innerText || '').length,
        };
      });
      rec.detail = d;
      rec.reachable = !d.is_not_found && (d.spec_name || d.h1).length > 0;
    } catch (err) {
      rec.error = String(err.message || err);
      rec.reachable = false;
      logEvidence(EVID, { step: 'probeProduct', product_no: pno, error: rec.error });
    }
    browserChecks.push(rec);
    return rec;
  };

  if (report.set_operations) {
    const apiOnlySample = report.set_operations.api_only_sample.slice(0, 8);
    const smOnlySample = report.set_operations.sitemap_only_sample.slice(0, 8);
    for (const p of apiOnlySample) await probeProduct(p, 'api_only_not_in_sitemap');
    for (const p of smOnlySample) await probeProduct(p, 'sitemap_only_not_in_api');
    await sleep(500);
  }

  /* --- Q2: row-level parity between API and browser for a sample --- */
  const { browser: b2, context: c2 } = { browser, context }; // same browser
  const parityRows = [];
  if (api) {
    const apiById = new Map((api.result || []).map((r) => [String(r.productNo), r]));
    // sample across the catalog: every Nth item so brands are spread out
    const all = api.result || [];
    const stride = Math.max(1, Math.floor(all.length / SAMPLES));
    const picks = [];
    for (let i = 0; i < all.length && picks.length < SAMPLES; i += stride) picks.push(all[i]);

    for (const a of picks) {
      const pno = String(a.productNo);
      const url = `https://www.samamusic.co.kr/product/detail.html?product_no=${pno}&cate_no=42&display_group=1`;
      let b = null;
      try {
        await withRetry(async () => {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await sleep(1500);
        }, { label: `parity:${pno}` });
        b = await page.evaluate(() => {
          const spec = {};
          document.querySelectorAll('table').forEach((tb) => {
            const cap = (tb.querySelector('caption')?.textContent || '').trim();
            if (!cap.includes('기본 정보')) return;
            tb.querySelectorAll('tr').forEach((tr) => {
              const th = tr.querySelector('th'); const td = tr.querySelector('td');
              if (th && td) spec[(th.textContent || '').trim()] = (td.textContent || '').replace(/\s+/g, ' ').trim();
            });
          });
          const jl = [...document.querySelectorAll('script[type="application/ld+json"]')]
            .map((s) => { try { return JSON.parse(s.textContent); } catch { return null; } })
            .filter(Boolean);
          const prod = jl.find((j) => j && (j['@type'] === 'Product' || j['@type'] === 'ProductGroup'));
          return {
            spec_name: spec['상품명'] || '',
            spec_price: spec['판매가'] || '',
            spec_brand: spec['브랜드'] || '',
            spec_model: spec['모델명'] || '',
            jsonld_type: prod ? prod['@type'] : '',
            jsonld_price: prod && prod.offers ? prod.offers.price : (prod && prod.hasVariant ? prod.hasVariant[0]?.offers?.price : ''),
            jsonld_availability: prod && prod.offers ? prod.offers.availability : '',
            jsonld_sku: prod ? (prod.sku || prod.productGroupID || '') : '',
            soldout_icon_visible: [...document.querySelectorAll('img[alt="품절"], [class*=soldout i]')]
              .filter((e) => !!e.offsetParent && !/\{\$/.test(e.className || '')).length > 0,
            sold_out_in_buy_box: /SOLD\s*OUT/i.test((document.querySelector('.buy-box, .buy-scroll-box') || {}).textContent || ''),
            spec_price_kind: (() => {
              const v = spec['판매가'] || '';
              if (v.includes('\uC644\uB8CC')) return 'sale_closed';
              if (v.includes('\uBB38\uC758')) return 'inquiry';
              if (v.trim() === '') return 'missing';
              return /\d/.test(v) ? 'numeric' : 'unknown';
            })(),
            is_not_found: /상품이 존재하지|찾을 수 없/i.test(document.body.innerText || ''),
          };
        });
      } catch (err) {
        b = { error: String(err.message || err) };
        logEvidence(EVID, { step: 'parity', product_no: pno, error: b.error });
      }

      /*
       * PRICE FIELD SEMANTICS (measured on 5 mismatching products):
       *   API `price`          = the PUBLIC selling price (판매가 shown on the page)
       *   API `pcDiscountPrice`= a DISCOUNTED price (member/coupon tier), sometimes lower
       *   API `retailPrice`    = the consumer list price (소비자가)
       *   API `priceContent`   = the string actually rendered as 판매가; for price-on-
       *                           inquiry products it holds "가격 문의" / "판매문의"
       * => the browser's 판매가 row must be compared against API `price`,
       *    and `pcDiscountPrice` must NOT be used as the public price.
       */
      const apiPrice = Number(a.price ?? NaN);
      const apiDiscount = Number(a.pcDiscountPrice ?? NaN);
      const browserPriceText = b && b.spec_price ? String(b.spec_price) : '';
      const browserPriceKind = X.classifyPrice(browserPriceText).kind;
      const browserIsInquiry = browserPriceKind !== 'numeric';
      const browserPrice = browserPriceKind === 'numeric' ? browserPriceText.replace(/[^\d]/g, '') : null;
      const apiIsInquiry = String(a.priceContent || '').includes('\uBB38\uC758')
        || String(a.priceContent || '').includes('\uC644\uB8CC');
      const row = {
        product_no: pno,
        api_product_name: a.productName,
        browser_product_name: b ? b.spec_name : '',
        name_match: b ? (b.spec_name.trim() === String(a.productName).trim()) : false,
        api_price_public: Number.isFinite(apiPrice) ? apiPrice : '',
        api_price_discounted: Number.isFinite(apiDiscount) ? apiDiscount : '',
        browser_price: browserPrice === null ? '' : browserPrice,
        browser_price_kind: browserPriceKind,
        price_match: browserPrice !== null && apiPrice === Number(browserPrice),
        api_price_is_inquiry: apiIsInquiry,
        browser_price_is_inquiry: browserIsInquiry,
        api_price_content: a.priceContent === undefined ? '' : String(a.priceContent),
        api_brand: a.brandName || '',
        browser_brand: b ? b.spec_brand : '',
        brand_match: b ? (String(b.spec_brand).trim().toUpperCase() === String(a.brandName || '').trim().toUpperCase()) : false,
        api_model: a.modelName || '',
        browser_model: b ? b.spec_model : '',
        model_match: b ? (String(b.spec_model).trim() === String(a.modelName || '').trim()) : false,
        api_sold_out: a.soldOut,
        browser_sold_out_visible: b ? b.soldout_icon_visible : '',
        browser_sold_out_buy_box: b ? b.sold_out_in_buy_box : '',
        jsonld_type: b ? b.jsonld_type : '',
        jsonld_price: b ? b.jsonld_price : '',
        jsonld_sku: b ? b.jsonld_sku : '',
        jsonld_availability: b ? b.jsonld_availability : '',
        browser_error: b && b.error ? b.error : '',
      };
      parityRows.push(row);
      await sleep(400);
    }
  }

  // write parity csv
  const headers = Object.keys(parityRows[0] || { product_no: '' });
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  fs.writeFileSync(OUT_CSV, `\ufeff${[headers.join(','), ...parityRows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n')}`, 'utf8');

  // summary
  const tally = (k) => parityRows.filter((r) => r[k] === true).length;
  const apiSoldOutRows = parityRows.filter((r) => String(r.api_sold_out) === '1');
  const browserSoldOutRows = parityRows.filter((r) => r.browser_sold_out_visible === true || r.browser_sold_out_buy_box === true);
  const inquiryRows = parityRows.filter((r) => r.browser_price_is_inquiry === true || r.api_price_is_inquiry === true);
  const numericRows = parityRows.filter((r) => r.browser_price !== '' && r.api_price_public !== '');
  report.parity_summary = {
    sampled: parityRows.length,
    name_match: tally('name_match'),
    price_match: tally('price_match'),
    price_match_rate_numeric: `${tally('price_match')}/${numericRows.length}`,
    brand_match: tally('brand_match'),
    model_match: tally('model_match'),
    browser_errors: parityRows.filter((r) => r.browser_error).length,
    api_sold_out_true: apiSoldOutRows.length,
    browser_sold_out_visible: browserSoldOutRows.length,
    sold_out_agreement: `${browserSoldOutRows.length}/${apiSoldOutRows.length}`,
    false_sold_out: parityRows.filter((r) => String(r.api_sold_out) === '0' && (r.browser_sold_out_visible === true || r.browser_sold_out_buy_box === true)).length,
    price_inquiry_rows: inquiryRows.length,
    price_inquiry_agreement: `${inquiryRows.filter((r) => r.api_price_is_inquiry === r.browser_price_is_inquiry).length}/${inquiryRows.length}`,
  };
  report.browser_checks = browserChecks;
  report.parity_rows = parityRows;

  fs.writeFileSync(path.join(ROOT, 'reports', 'evidence', 'api-browser-parity.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`OK parity=${parityRows.length} csv=${OUT_CSV}`);

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
