/**
 * investigate_sources.mjs -- 이슈 #19: 공급처 관계·추가 공급처·카테고리 완결성 조사
 *
 * 확인 항목
 *   1) samamusic / samasound 홈의 외부 도메인 링크(추가 공급처 후보)
 *   2) 각 사이트의 상품 수 표기(등록 제품), 카테고리 구조
 *   3) 검색 결과 총건수(서버 렌더 vs AJAX) → 목록 크롤 누락 확인
 *   4) 페이지당 상품 수 / 마지막 페이지 → 페이지네이션 누락 확인
 *   5) 판매중지(품절) 표기 상품의 공개 노출 여부
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import os from 'node:os';

const OUT = resolve(process.argv[2] || 'docs/samples/issue-19');
mkdirSync(OUT, { recursive: true });
const EXE = join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe');

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR' });
const page = await ctx.newPage();
const out = {};

async function linksOf(url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1200);
  return page.evaluate(() => {
    const T = (e) => (e.textContent || '').replace(/\s+/g, ' ').trim();
    const all = Array.from(document.querySelectorAll('a[href]')).map((a) => ({
      text: T(a).slice(0, 40),
      href: a.href,
    }));
    const domains = {};
    for (const a of all) {
      try {
        const d = new URL(a.href).hostname;
        if (!d) continue;
        domains[d] = (domains[d] || 0) + 1;
      } catch { /* ignore */ }
    }
    const menus = Array.from(document.querySelectorAll('nav a, .gnb a, .lnb a, .category a'))
      .map((a) => T(a)).filter(Boolean).slice(0, 60);
    const registered = (document.body.innerText.match(/등록\s*제품\s*[:：]?\s*([0-9,]+)/) || [])[1] || null;
    return { title: document.title, url: location.href, domains, menus, registered, linkCount: all.length };
  });
}

out.samamusic_home = await linksOf('https://www.samamusic.co.kr/');
out.samasound_home = await linksOf('https://www.samasound.co.kr/');
out.samastore_home = await linksOf('https://samastore.co.kr/');

// 목록 페이지: 페이지당 건수 / 마지막 페이지 / 등록 제품 표기
async function listInfo(url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(800);
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll("a[href*='product_no'], a[href*='/product/']"));
    const ids = new Set();
    for (const a of anchors) {
      const m = a.href.match(/product_no=(\d+)/) || a.href.match(/\/(\d+)\/?(?:\?|$)/);
      if (m) ids.add(m[1]);
    }
    const pager = Array.from(document.querySelectorAll("a[href*='page=']")).map((a) => a.getAttribute('href')).filter(Boolean);
    const last = pager.map((h) => parseInt((h.match(/page=(\d+)/) || [])[1] || '0', 10)).filter(Boolean).sort((a, b) => b - a)[0] || null;
    const text = document.body.innerText;
    return {
      url: location.href,
      uniqueProductIdsOnPage: ids.size,
      lastPageFromPager: last,
      registered: (text.match(/등록\s*제품\s*[:：]?\s*([0-9,]+)/) || [])[1] || null,
      pageText: (text.match(/\d+\s*개|\d+\s*건/) || [])[0] || null,
    };
  });
}

out.list_samamusic_c42_p1 = await listInfo('https://www.samamusic.co.kr/product/list.html?cate_no=42&page=1');
out.list_samamusic_c42_p2 = await listInfo('https://www.samamusic.co.kr/product/list.html?cate_no=42&page=2');
out.list_samasound_c23_p1 = await listInfo('https://www.samasound.co.kr/product/list.html?cate_no=23&page=1');
out.list_samasound_c23_p112 = await listInfo('https://www.samasound.co.kr/product/list.html?cate_no=23&page=112');

// 검색 결과 총건수(서버 렌더 + AJAX 폴백)
async function searchInfo(base, keyword) {
  const url = `${base}/product/search.html?keyword=${encodeURIComponent(keyword)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  return page.evaluate(() => {
    const text = document.body.innerText;
    const ids = new Set();
    for (const a of Array.from(document.querySelectorAll('a[href*="product_no"], a[href*="/product/"]'))) {
      const m = a.href.match(/product_no=(\d+)/) || a.href.match(/\/(\d+)\/?(?:\?|$)/);
      if (m) ids.add(m[1]);
    }
    return {
      url: location.href,
      title: document.title,
      uniqueIds: ids.size,
      countText: (text.match(/[0-9,]+\s*개|[0-9,]+\s*건|검색결과[^\n]{0,20}/) || [])[0] || null,
      snippet: text.replace(/\s+/g, ' ').slice(0, 300),
    };
  });
}
out.search_samamusic_shure = await searchInfo('https://www.samamusic.co.kr', 'SHURE');
out.search_samasound_shure = await searchInfo('https://www.samasound.co.kr', 'SHURE');

writeFileSync(join(OUT, 'source_investigation.json'), JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out, null, 1).slice(0, 7000));
await browser.close();
