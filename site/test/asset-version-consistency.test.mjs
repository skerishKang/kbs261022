// 자산 캐시 버전(?v=) 불일치 회귀 방지.
//
// 2026-11-04: index.html의 cgi-order.js를 75a로 올렸지만 시험 파일 두 곳이
// 74a/80a를 그대로 기대하고 있어 CI가 깨졌다. 버전 문자열을 시험마다 따로
// 적어 두면 자산을 올릴 때마다 같은 일이 반복된다. 여기서는 페이지가 실제로
// 가리키는 파일과 버전만 검사한다.
//
//   - ?v=가 붙은 로컬 자산은 실제 파일이 있어야 한다.
//   - 같은 파일은 모든 페이지에서 같은 버전을 써야 한다(한 곳만 낡은 버전으로
//     남으면 그 페이지의 방문자만 옛 캐시를 받는다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SITE = join(REPO, 'site');
const WEBSITE = join(REPO, 'website');

function pagesIn(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.html'))
    .map((name) => join(dir, name));
}

/** { assetPath: [{ page, version }] } for every local `?v=` reference. */
function collectVersions(pages) {
  const found = new Map();
  const ref = /(?:src|href)="([^"?#]+)\?v=([0-9a-z]+)[^"]*"/g;
  for (const page of pages) {
    const html = readFileSync(page, 'utf8');
    for (const m of html.matchAll(ref)) {
      const url = m[1];
      if (/^(?:[a-z]+:)?\/\//i.test(url) || url.startsWith('data:')) continue;
      const asset = resolve(dirname(page), url);
      if (!found.has(asset)) found.set(asset, []);
      found.get(asset).push({ page: relative(REPO, page), version: m[2] });
    }
  }
  return found;
}

const pages = pagesIn(SITE).concat(pagesIn(WEBSITE));
const versions = collectVersions(pages);

test('every cache-busted local asset exists', () => {
  const missing = [...versions.keys()].filter((asset) => !existsSync(asset));
  assert.deepEqual(missing.map((asset) => relative(REPO, asset)), []);
});

test('one asset carries one cache-busting version across every page', () => {
  const divergent = [];
  for (const [asset, refs] of versions) {
    const distinct = [...new Set(refs.map((r) => r.version))];
    if (distinct.length > 1) {
      divergent.push(
        `${relative(REPO, asset)}: ` +
        refs.map((r) => `${r.page}=${r.version}`).join(', ')
      );
    }
  }
  assert.deepEqual(divergent, []);
});

test('the repository carries the Pages root redirect used at deploy time', () => {
  const redirects = join(REPO, '_redirects');
  assert.ok(existsSync(redirects), 'repo-root _redirects must exist so deploys do not rely on an untracked copy');
  assert.match(readFileSync(redirects, 'utf8'), /^\/ \/site\/ 302$/m);
});
