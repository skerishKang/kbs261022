import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const html = read('website/index.html');
const js = read('website/assets/main.js');
const css = read('website/assets/style.css');

test('footer shows the confirmed mail-order number and privacy officer', () => {
  assert.equal((html.match(/통신판매업신고 2025-전남장성-94/g) || []).length, 1);
  assert.match(html, /개인정보보호책임자 김범신/);
  assert.match(html, /062-576-8100/);
  assert.match(html, /cgiinc@naver\.com/);
  assert.match(html, /개인정보처리방침/);
});

test('business images use local company photos with visible SVG field-icon fallbacks', () => {
  const sandbox = createContext({ window: {} });
  runInContext(read('website/assets/company.js'), sandbox);
  for (const row of Array.from(sandbox.window.CGI_COMPANY.business)) {
    assert.ok(existsSync(join(ROOT, 'website', row.img)), '사진 파일 없음: ' + row.img);
  }
  for (const key of ['Media & Broadcast', 'LED Screen', 'Stage & Lighting', 'CCTV & Smart Farm', 'Control System', 'Rental', 'Training', 'Maintenance', 'Interior Architecture', 'R&D & Manufacturing']) {
    assert.ok(js.includes("'" + key + "'"), '분야 SVG 아이콘 누락: ' + key);
  }
  assert.match(js, /function fieldMedia[\s\S]*function addPhoto|function addPhoto[\s\S]*function fieldMedia/);
  assert.match(css, /\.field-media/);
  assert.ok(existsSync(join(ROOT, 'website/assets/img/ref_hall.jpg')));
  assert.ok(existsSync(join(ROOT, 'website/assets/img/biz_led.jpg')));
});

test('hero and bottom consult buttons open the in-page construction consult area, not the empty shop quote list', () => {
  const consultLinks = html.match(/<a [^>]*data-consult-link[^>]*>/g) || [];
  assert.ok(consultLinks.length >= 3, 'hero, CTA band and CONTACT note');
  for (const link of consultLinks) assert.match(link, /href="#consult"/, link);
  assert.match(html, /<a class="btn btn-primary" href="#consult" data-consult-link>공사·설치 상담 문의<\/a>/, 'hero');
  assert.match(html, /<li class="nav-consult"><a href="#consult">공사·설치 상담<\/a><\/li>/, 'top menu');
  assert.doesNotMatch(html, /quote-cart|data-quote-link/, 'no button sends visitors to the shop quote list');
  assert.doesNotMatch(js, /quote-cart|applyQuoteLinks/);
  assert.match(js, /applyMallLinks\(\);\s*applyConsult\(\);/);
  assert.match(js, /'consult'\]/, 'scroll spy highlights the consult menu');
});

test('the consult area lists phone, email, hours and what to tell us, with a separate shop button and no form', () => {
  const start = html.indexOf('<div class="panel consult" id="consult">');
  assert.ok(start > html.indexOf('id="support"'), 'inside SUPPORT');
  const block = html.slice(start, html.indexOf('<div class="grid-2 support-grid">'));
  assert.match(block, /href="tel:0625768100"/);
  assert.match(block, /href="tel:0618018100"/);
  assert.match(block, /href="mailto:cgiinc@naver\.com" data-company-email/);
  assert.match(block, /data-consult-hours>평일 09:00~18:00</);
  for (const word of ['장소', '규모', '일정', '예산']) assert.match(block, new RegExp('<strong>' + word + '</strong>'), word);
  assert.match(block, /<a class="btn btn-outline btn-mall" href="\.\.\/site\/index\.html" data-mall-link>장비 구매/);
  assert.doesNotMatch(block, /<form|<input|<textarea|feedback/i, 'no consult form, and not mixed with the feedback page');
  assert.match(css, /\.consult \{[^}]*scroll-margin-top/);
});

test('consult hours come from config.js (one place) and the page default matches it', () => {
  const sandbox = createContext({ window: {} });
  runInContext(read('website/assets/config.js'), sandbox);
  const hours = sandbox.window.CGI_CONFIG.consultHours;
  assert.equal(hours, '평일 09:00~18:00');
  const shown = html.match(/data-consult-hours>([^<]*)</g) || [];
  assert.equal(shown.length, 2, 'consult area and CONTACT');
  for (const s of shown) assert.ok(s.endsWith('>' + hours + '<'), s);
  assert.match(js, /CFG\.consultHours/);
  assert.match(js, /\[data-consult-hours\]/);
});

test('history, org chart, and references collapse with JavaScript and keep no-script content', () => {
  assert.match(html, /<details class="panel orgchart content-disclosure" id="orgDisclosure" open>/);
  assert.match(html, /id="historyMore" open/);
  assert.match(html, /<noscript>[\s\S]*?2011[\s\S]*?2025[\s\S]*?대한예수교장로회 은광교회/);
  assert.match(js, /Number\(row\.year\) >= 2023/);
  assert.match(js, /orgDisclosure[\s\S]*?disclosure\.open = false/);
  assert.match(js, /historyMore[\s\S]*?disclosure\.open = false/);
  assert.match(js, /ref-more[\s\S]*?분야 사례 더 보기/);
  assert.match(css, /\.content-disclosure/);
});

test('the repeated hero sentence appears once at most and the Naver map action is prominent', () => {
  assert.equal((html.match(/영상장비, 음향장비 및 각종 설계·시공·제작 전문업체/g) || []).length, 0);
  assert.match(html, /class="btn btn-primary btn-map"[^>]*>네이버지도에서 보기/);
  assert.match(css, /\.btn-map[^}]*box-shadow/);
});

test('the mobile menu swaps its label and focuses the first link when opened', () => {
  assert.match(js, /메뉴 닫기/);
  assert.match(js, /메뉴 열기/);
  assert.match(js, /nav\.querySelector\('a'\)/);
  assert.match(js, /void nav\.offsetWidth/, 'force the open styles before focusing');
  assert.match(js, /setTimeout\(focusFirst, 60\)/, 'retry once when the first focus is ignored');
});

test('homepage actions use real URLs so they work without JavaScript', () => {
  assert.doesNotMatch(html, /href="#"/, 'href="#" placeholder must not remain');
  const mallLinks = html.match(/<a [^>]*data-mall-link[^>]*>/g) || [];
  assert.ok(mallLinks.length > 0, 'mall links exist');
  for (const link of mallLinks) {
    assert.match(link, /href="\.\.\/site\/index\.html"/, link);
  }
  const consultLinks = html.match(/<a [^>]*data-consult-link[^>]*>/g) || [];
  assert.ok(consultLinks.length > 0, 'consult links exist');
  for (const link of consultLinks) {
    assert.match(link, /href="#consult"/, link);
  }
  assert.ok(html.includes('id="consult"'), 'the consult anchor exists');
});
