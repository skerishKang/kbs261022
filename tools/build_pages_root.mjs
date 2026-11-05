#!/usr/bin/env node
// Cloudflare Pages 배포 루트를 저장소에서 조립한다.
//
//   node tools/build_pages_root.mjs --out C:\temp\cgishop-deploy
//   wrangler pages deploy C:\temp\cgishop-deploy --project-name cgishop --branch main
//
// 배포 루트에는 site/·website/와 루트의 _redirects·_headers·404.html 만 들어간다.
// site/data/products.json·products.js 는 빌드 입력이므로 배포에서 제외한다
// (목록은 catalog.json, 상세는 details/part-*.json, 홈페이지는 brands.json).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const EXCLUDE = [
  join(ROOT, 'site', 'data', 'products.json'),
  join(ROOT, 'site', 'data', 'products.js'),
];
const EXCLUDE_DIRS = [
  join(ROOT, 'site', 'data', '_source_category_catalog.csv'),
  join(ROOT, 'site', 'data', '_source_product_master_sample.csv'),
  join(ROOT, 'site', 'data', '_source_product-master.schema.json'),
  join(ROOT, 'site', 'data', '_source_sample-products.json'),
];

function parseArgs(argv) {
  const out = { out: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) { out.out = argv[i + 1]; i += 1; }
  }
  return out;
}

function assertPresent(relative) {
  const full = join(ROOT, relative);
  if (!existsSync(full)) throw new Error(`missing deploy input: ${relative}`);
  return full;
}

function filter(source) {
  const resolved = resolve(source);
  if (EXCLUDE.includes(resolved) || EXCLUDE_DIRS.includes(resolved)) return false;
  return true;
}

function walk(dir) {
  let files = 0;
  let bytes = 0;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      const sub = walk(full);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      files += 1;
      bytes += stat.size;
    }
  }
  return { files, bytes };
}

const { out } = parseArgs(process.argv.slice(2));
if (!out) {
  console.error('usage: node tools/build_pages_root.mjs --out <deploy-root>');
  process.exit(2);
}
const target = resolve(out);
if (target === ROOT || ROOT.startsWith(target)) {
  console.error('refusing to write the deploy root over the repository');
  process.exit(2);
}

assertPresent('site');
assertPresent('website');
assertPresent('_redirects');
assertPresent('_headers');
assertPresent('404.html');
assertPresent(join('site', 'data', 'catalog.json'));
assertPresent(join('site', 'data', 'brands.json'));
assertPresent(join('site', 'data', 'details'));

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(join(ROOT, 'site'), join(target, 'site'), { recursive: true, filter });
cpSync(join(ROOT, 'website'), join(target, 'website'), { recursive: true, filter });
for (const name of ['_redirects', '_headers', '404.html']) {
  cpSync(join(ROOT, name), join(target, name));
}

const total = walk(target);
const catalogBytes = statSync(join(target, 'site', 'data', 'catalog.json')).size;
const brandsBytes = statSync(join(target, 'site', 'data', 'brands.json')).size;
console.log(`[pages-root] wrote ${target}`);
console.log(`[pages-root] files=${total.files} bytes=${total.bytes}`);
console.log(`[pages-root] catalog=${catalogBytes}B brands=${brandsBytes}B`);
console.log('[pages-root] excluded site/data/products.json, site/data/products.js, _source_*');