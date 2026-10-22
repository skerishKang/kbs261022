/**
 * search_completeness.mjs -- 이슈 #19: 검색 결과 총건수 ↔ 카테고리 목록 수집 건수 대조
 *
 * 카테고리 목록 크롤이 놓친 상품이 있는지 확인한다.
 *   - samasound: 검색 결과가 서버 렌더(총 N 개 텍스트) → 총건수를 읽어 대조
 *   - samamusic: 검색이 Dalue AJAX → 렌더 후 총건수 텍스트 추출
 * 브랜드별로 "검색 총건수 vs 목록 크롤 건수" 를 비교한다.
 *
 * 사용: node tools/full_catalog/search_completeness.mjs <list_products.json> <out_dir> [브랜드수] [all_detail.json]
 */
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import os from 'node:os';

const listPath = process.argv[2];
const OUT = resolve(process.argv[3] || 'docs/samples/issue-19');
const BRANDS_PER_SITE = Number(process.argv[4] || 8);
const detailPath = process.argv[5] || '';
const EXE = join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe');
mkdirSync(OUT, { recursive: true });

const lists = JSON.parse(readFileSync(listPath, 'utf8'));
const recs = detailPath ? JSON.parse(readFileSync(detailPath, 'utf8')) : [];
const HOST = { samasound: 'https://www.samasound.co.kr', samamusic: 'https://www.samamusic.co.kr' };

// 한국어 리터럴은 코드포인트로 만들어 인코딩에 의존하지 않는다.
const CH = {
  gae: String.fromCharCode(0xac1c),      // 개
  yi: String.fromCharCode(0xc758),       // 의
  sang: String.fromCharCode(0xc0c1),     // 상
  pum: String.fromCharCode(0xd488),      // 품
  chong: String.fromCharCode(0xcd1d),    // 총
  geon: String.fromCharCode(0xac74),     // 건
  geom: String.fromCharCode(0xac80),     // 검
  saek: String.fromCharCode(0xc0c9),     // 색
};

// 브랜드별 수집 건수는 상세 수집 결과(브랜드 필드가 실제 값) 기준
const brandCounts = {};
for (const site of Object.keys(lists)) {
  const map = {};
  const src = recs.length ? recs.filter((r) => r.source_site === site) : Object.values(lists[site]);
  for (const r of src) {
    const b = String(r.source_brand || r.brand || '').trim() || '(brand-unknown)';
    map[b] = (map[b] || 0) + 1;
  }
  brandCounts[site] = map;
}

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR' });
const page = await ctx.newPage();

async function searchFacts(site, keyword) {
  const url = `${HOST[site]}/product/search.html?keyword=${encodeURIComponent(keyword)}`;
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!resp || resp.status() >= 400) return { error: 'http_' + (resp ? resp.status() : '?') };
    await page.waitForTimeout(3000);
    return await page.evaluate((CH) => {
      const text = document.body.innerText.replace(/\s+/g, ' ');
      const ids = new Set();
      for (const a of Array.from(document.querySelectorAll('a[href*="product_no"], a[href*="/product/"]'))) {
        const m = a.href.match(/product_no=(\d+)/) || a.href.match(/\/(\d+)\/?(?:\?|$)/);
        if (m) ids.add(m[1]);
      }
      const patterns = [
        new RegExp(CH.chong + '\\s*([0-9,]{2,})\\s*' + CH.gae + '(?:\\s*' + CH.yi + ')?\\s*' + CH.sang + '\\s*' + CH.pum),
        new RegExp('([0-9,]{2,})\\s*' + CH.gae + '(?:\\s*' + CH.yi + ')?\\s*' + CH.sang + '\\s*' + CH.pum + '\\s*' + CH.geom + CH.saek),
        new RegExp(CH.geom + CH.saek + '\\s*' + CH.geom + '\\s*([0-9,]{2,})'),
        new RegExp('([0-9,]{2,})\\s*' + CH.gae + '(?:\\s*' + CH.yi + ')?\\s*' + CH.sang + '\\s*' + CH.pum),
        new RegExp('([0-9,]{2,})\\s*' + CH.geon + '\\s*' + CH.sang + '\\s*' + CH.pum),
        new RegExp(CH.chong + '\\s*([0-9,]{2,})\\s*' + CH.gae),
      ];
      let total = null;
      for (const p of patterns) {
        const m = text.match(p);
        if (m) { total = parseInt(m[1].replace(/,/g, ''), 10); break; }
      }
      const pager = Array.from(document.querySelectorAll("a[href*='page=']"))
        .map((a) => parseInt((a.getAttribute('href').match(/page=(\d+)/) || [])[1] || '0', 10)).filter(Boolean);
      return {
        total,
        idsOnPage: ids.size,
        lastPage: pager.length ? Math.max(...pager) : null,
        snippet: text.slice(0, 240),
      };
    }, CH);
  } catch (e) {
    return { error: String(e).slice(0, 140) };
  }
}

const rows = [];
for (const site of Object.keys(lists)) {
  const map = brandCounts[site];
  const brands = Object.entries(map)
    .filter(([b]) => b !== '(brand-unknown)')
    .sort((a, b) => b[1] - a[1]);
  const step = Math.max(1, Math.floor(brands.length / BRANDS_PER_SITE));
  const picked = [];
  for (let i = 0; i < brands.length && picked.length < BRANDS_PER_SITE; i += step) picked.push(brands[i]);
  for (const [brand, listCount] of picked) {
    const res = await searchFacts(site, brand);
    const total = res.total ?? null;
    rows.push({
      site, brand, listCrawlCount: listCount, searchTotal: total,
      diff: total === null ? null : total - listCount,
      idsOnPage: res.idsOnPage ?? null, lastPage: res.lastPage ?? null,
      error: res.error ?? null, snippet: res.snippet ?? null,
    });
    const last = rows[rows.length - 1];
    console.log(`${site} ${brand}: list=${listCount} search=${total} diff=${last.diff}`);
  }
}

const compared = rows.filter((r) => r.searchTotal !== null);
const gaps = compared.filter((r) => r.diff !== 0);
const bySite = {};
for (const site of Object.keys(lists)) {
  const rs = compared.filter((r) => r.site === site);
  bySite[site] = {
    compared: rs.length,
    sumList: rs.reduce((a, r) => a + r.listCrawlCount, 0),
    sumSearch: rs.reduce((a, r) => a + r.searchTotal, 0),
    gapBrands: rs.filter((r) => r.diff !== 0).length,
    extraFromSearch: rs.reduce((a, r) => a + Math.max(0, r.diff), 0),
  };
}
writeFileSync(join(OUT, 'search_completeness.json'),
  JSON.stringify({ compared: compared.length, gaps: gaps.length, bySite, rows }, null, 1), 'utf8');
console.log('SUMMARY ' + JSON.stringify(bySite));
await browser.close();
