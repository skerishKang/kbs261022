/**
 * verify_report.mjs -- 경과보고서 HTML 렌더링 검증 (데스크톱/모바일/인쇄용)
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import os from 'node:os';

const file = process.argv[2];
const outDir = resolve(process.argv[3] || 'C:/cgi-work/catalog-data/report_shots');
mkdirSync(outDir, { recursive: true });
const EXE = join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe');
const url = 'file:///' + file.replace(/\\/g, '/');

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const errors = [];
const out = {};

async function check(width, height, tag, mobile) {
  const ctx = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: mobile ? 2 : 1,
    isMobile: !!mobile, hasTouch: !!mobile, locale: 'ko-KR',
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(tag + ': ' + e.message));
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(400);
  const info = await page.evaluate(() => {
    const body = document.body;
    return {
      title: document.title,
      h1: (document.querySelector('h1') || {}).textContent,
      kpis: document.querySelectorAll('.kpi').length,
      timelineItems: document.querySelectorAll('.tl-item').length,
      tables: document.querySelectorAll('table').length,
      links: document.querySelectorAll('a[href^="http"]').length,
      scrollW: body.scrollWidth, clientW: document.documentElement.clientWidth,
      textLen: body.innerText.length,
    };
  });
  info.horizontalOverflow = info.scrollW > info.clientW + 1;
  await page.screenshot({ path: join(outDir, `report-${tag}.png`), fullPage: true });
  await ctx.close();
  return info;
}

out.desktop = await check(1440, 1000, 'desktop-1440', false);
out.mobile = await check(390, 844, 'mobile-390', true);
out.tablet = await check(820, 1180, 'tablet-820', false);

// A4 인쇄 가능성: print media 적용 후 페이지 폭 확인
const ctx = await browser.newContext({ viewport: { width: 794, height: 1123 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'load' });
await page.emulateMedia({ media: 'print' });
out.print = await page.evaluate(() => ({
  scrollW: document.documentElement.scrollWidth,
  clientW: document.documentElement.clientWidth,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  kpiShadow: getComputedStyle(document.querySelector('.kpi')).boxShadow,
}));
await ctx.close();

out.errors = errors;
console.log(JSON.stringify(out, null, 1));
await browser.close();
