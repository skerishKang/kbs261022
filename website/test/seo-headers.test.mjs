// 홈페이지 SEO·보안 헤더·404 회귀(PR-3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const WEBSITE = join(REPO, 'website');
const html = readFileSync(join(WEBSITE, 'index.html'), 'utf8');

function company() {
  const window = {};
  new Function('window', readFileSync(join(WEBSITE, 'assets', 'company.js'), 'utf8'))(window);
  return window.CGI_COMPANY;
}

function phones(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

/** +82-62-576-8100 and 062) 576-8100 describe the same line. */
function phoneKey(value) {
  let digits = phones(value);
  if (digits.startsWith('82')) digits = digits.slice(2);
  return digits.replace(/^0/, '');
}

test('homepage carries canonical, og:url and og:image that agree with each other', () => {
  const canonical = html.match(/<link rel="canonical" href="([^"]+)">/);
  const ogUrl = html.match(/<meta property="og:url" content="([^"]+)">/);
  const ogImage = html.match(/<meta property="og:image" content="([^"]+)">/);
  assert.ok(canonical, 'canonical');
  assert.ok(ogUrl, 'og:url');
  assert.ok(ogImage, 'og:image');
  assert.equal(canonical[1], ogUrl[1]);
  assert.match(canonical[1], /^https:\/\/cgishop\.pages\.dev\/website\/$/);
  assert.match(ogImage[1], /^https:\/\//);
  const imagePath = ogImage[1].replace('https://cgishop.pages.dev/', '');
  assert.ok(existsSync(join(REPO, imagePath)), `og:image exists: ${imagePath}`);
});

test('LocalBusiness structured data matches company.js', () => {
  const match = html.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(match, 'JSON-LD block');
  const data = JSON.parse(match[1]);
  const c = company();
  assert.equal(data['@type'], 'LocalBusiness');
  assert.equal(data.name, c.identity.nameKo);
  assert.equal(data.alternateName, c.identity.nameEn);
  assert.equal(data.taxID, c.identity.bizRegNo);
  assert.equal(phoneKey(data.telephone), phoneKey(c.contact.tels[0].num));
  assert.equal(phoneKey(data.faxNumber), phoneKey(c.contact.fax));
  assert.match(data.email, /^cgiinc@naver\.com$/);
  assert.equal(data.foundingDate.slice(0, 4), c.identity.founded.slice(0, 4));
  assert.equal(data.address.postalCode, c.hq.zip);
  assert.ok(c.hq.addrFull.includes(data.address.addressLocality));
  assert.ok(c.hq.addrFull.includes(data.address.streetAddress.split(' (')[0]));
  assert.deepEqual(data.founder.map((f) => f.name), c.identity.ceo.split(',').map((s) => s.trim()));
  assert.ok(data.sameAs.includes(c.contact.blogUrl.replace(/^http:/, 'https:')));
  assert.equal(data.url, 'https://cgishop.pages.dev/website/');
});

test('all blog links use https', () => {
  assert.doesNotMatch(html, /http:\/\/blog\.naver\.com/);
  const c = company();
  assert.match(c.contact.blogUrl, /^https:\/\/blog\.naver\.com\/cgiinc$/);
});

test('_headers carries noindex and the baseline security headers, without CSP', () => {
  const headers = readFileSync(join(REPO, '_headers'), 'utf8');
  assert.match(headers, /^\/\*$/m);
  assert.match(headers, /X-Robots-Tag:\s*noindex/i);
  assert.match(headers, /X-Content-Type-Options:\s*nosniff/i);
  assert.match(headers, /Referrer-Policy:\s*strict-origin-when-cross-origin/i);
  assert.match(headers, /X-Frame-Options:\s*DENY/i);
  assert.match(headers, /Permissions-Policy:/i);
  assert.doesNotMatch(headers, /Content-Security-Policy/i, 'CSP is a later step');
});

test('404.html exists with links to both sections and company footer', () => {
  const page = readFileSync(join(REPO, '404.html'), 'utf8');
  assert.match(page, /href="\/site\/"/);
  assert.match(page, /href="\/website\/"/);
  assert.match(page, /410-86-46283/);
  assert.match(page, /062\) 576-8100/);
});

test('the six unused homepage images are gone and nothing references them', () => {
  const removed = ['cgi-location', 'cgi-lockup-white', 'hero_office', 'proj_civic', 'proj_edu', 'proj_rental_2'];
  for (const name of removed) {
    const files = readdirSync(join(WEBSITE, 'assets', 'img')).filter((f) => f.startsWith(name + '.'));
    assert.deepEqual(files, [], `${name} was deleted`);
    for (const root of ['website/index.html', 'website/assets/main.js', 'website/assets/company.js', 'site/index.html']) {
      const full = join(REPO, root);
      if (!existsSync(full) || statSync(full).isDirectory()) continue;
      assert.ok(!readFileSync(full, 'utf8').includes(name), `${root} no longer references ${name}`);
    }
  }
});
