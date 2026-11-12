// Launch-blocker regression: the storefront and company homepage must link to
// each other inside the same cgishop deployment, not to the retired
// cgihomepage Pages project.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

function loadConfig(rel, globalName) {
  const sandbox = createContext({ window: {} });
  runInContext(read(rel), sandbox);
  return sandbox.window[globalName];
}

const siteCfg = loadConfig('site/config.js', 'CGI_SITE_CONFIG');
const websiteCfg = loadConfig('website/assets/config.js', 'CGI_CONFIG');

test('the storefront company-home link stays inside cgishop', () => {
  assert.equal(siteCfg.homepageUrl, '../website/index.html');
  assert.equal(JSON.stringify(siteCfg).includes('cgihomepage'), false);
});

test('the company homepage links to the storefront with relative paths', () => {
  assert.equal(websiteCfg.mallUrl, '../site/index.html');
  assert.equal(websiteCfg.mallListUrl, '../site/index.html#/products');
  assert.equal(JSON.stringify(websiteCfg).includes('cgihomepage'), false);
});

test('the changed website config asset carries the next cache-busting version', () => {
  assert.match(read('website/index.html'), /assets\/config\.js\?v=104a/);
});
