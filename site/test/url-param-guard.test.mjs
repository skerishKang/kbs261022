// URL 파라미터 가드(PR-3): ?data= 는 같은 오리진의 data/ 하위 .json 만 허용하고,
// 홈페이지의 ?mall= 덮어쓰기는 제거되었다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const catalog = readFileSync(join(REPO, 'site', 'assets', 'js', 'cgi-catalog.js'), 'utf8');
const main = readFileSync(join(REPO, 'website', 'assets', 'main.js'), 'utf8');

test('the ?data= loader only accepts same-origin data/*.json', () => {
  assert.match(catalog, /function allowedDataUrl\(raw\)/);
  assert.match(catalog, /url\.origin !== location\.origin\) return null/);
  assert.match(catalog, /new URL\('data\/', location\.href\)\.pathname/);
  assert.match(catalog, /indexOf\(dataBase\) !== 0\) return null/);
  assert.match(catalog, /\/\\\.json\$\/i\.test\(url\.pathname\)/);
  assert.match(catalog, /var dataUrl = allowedDataUrl\(new URLSearchParams\(location\.search\)\.get\('data'\)\)/);
});

test('the catalog loader reads the light file and details on demand', () => {
  assert.match(catalog, /data\/catalog\.json/);
  assert.match(catalog, /data\/details\/part-/);
  assert.match(catalog, /function loadDetail\(product\)/);
});

test('the homepage no longer reads a ?mall= override', () => {
  assert.doesNotMatch(main, /get\('mall'\)/);
  assert.doesNotMatch(main, /URLSearchParams\(location\.search\)\.get\('mall'\)/);
  assert.match(main, /function mallBase\(\)[\s\S]{0,220}return CFG\.mallUrl/);
});

test('the homepage reads brands.json, not the product master', () => {
  assert.match(main, /CFG\.mallBrandsUrl/);
  assert.doesNotMatch(main, /CFG\.mallDataUrl/);
  const config = readFileSync(join(REPO, 'website', 'assets', 'config.js'), 'utf8');
  assert.match(config, /mallBrandsUrl:/);
  assert.doesNotMatch(config, /mallDataUrl/);
});
