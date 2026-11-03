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

test('footer shows the confirmed mail-order number once', () => {
  assert.equal((html.match(/통신판매업신고 2025-전남장성-94/g) || []).length, 1);
  assert.doesNotMatch(html, /개인정보보호책임자/);
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

test('hero and bottom quote buttons link to the catalog quote list', () => {
  assert.ok((html.match(/data-quote-link/g) || []).length >= 2);
  assert.match(js, /function applyQuoteLinks\(\)[\s\S]*#\/quote-cart/);
  assert.match(js, /applyMallLinks\(\);\s*applyQuoteLinks\(\);/);
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
