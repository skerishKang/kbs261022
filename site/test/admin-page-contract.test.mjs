// Admin page ↔ console script contract (작업 A/C).
//
// The behavioural tests in cgi-staff-auth.test.mjs run against a stub document
// that hands out an element for any id, so a handler wired to #memberGoogleBtn
// reads as "green" even when the button is absent from staff.html. This file
// parses the real markup and refuses that mismatch.
//
//   node --test site/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { normalizeOAuthReturn, resolveOAuthRedirect } from '../../backend/lib/google-oauth.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..');
const read = (rel) => readFileSync(join(SITE, rel), 'utf8');

const PAGES = {
  'staff.html': { script: 'assets/js/cgi-staff.js', returnKey: 'staff' },
  'orders.html': { script: 'assets/js/cgi-staff-orders.js', returnKey: 'orders' },
};

/** Ids the login/logout/Google wiring looks up. Each must exist in the markup. */
const AUTH_IDS = ['authBox', 'authMsg', 'memberPanel', 'memberEmail', 'memberPassword', 'memberLoginBtn', 'memberGoogleBtn', 'logoutBtn'];

function idsIn(html) {
  const found = new Set();
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) found.add(m[1]);
  return found;
}

for (const [page, cfg] of Object.entries(PAGES)) {
  test(`${page} carries every element the ${cfg.returnKey} console looks up`, () => {
    const html = read(page);
    const present = idsIn(html);
    const missing = AUTH_IDS.filter((id) => !present.has(id));
    assert.deepEqual(missing, [], `${page} is missing ids referenced by ${cfg.script}: ${missing.join(', ')}`);
    assert.match(html, /<script src="[^"]*cgi-auth\.js/, `${page} must load the shared auth helper`);
    assert.match(html, new RegExp(`<script src="[^"]*${cfg.script.replace('/', '\\/')}\\?v=`), `${page} must cache-bust ${cfg.script}`);
  });

  test(`${page} logs in through the allowlisted Google return target`, () => {
    const html = read(page);
    const button = html.match(/<button[^>]*id="memberGoogleBtn"[^>]*>([\s\S]*?)<\/button>/);
    assert.ok(button, `${page} has no #memberGoogleBtn button`);
    const body = button[1];
    assert.match(body, /Google로 계속하기/, `${page} needs the blessed Google button label`);
    assert.match(body, /<svg[\s\S]*#4285F4[\s\S]*#34A853[\s\S]*#FBBC05[\s\S]*#EA4335[\s\S]*<\/svg>/,
      `${page} must reuse the four-path Google mark, not a placeholder`);
    assert.match(button[0], /class="[^"]*btn btn-google/, `${page} must reuse the existing .btn-google styling`);
    assert.equal(normalizeOAuthReturn(cfg.returnKey), cfg.returnKey,
      `${page} asks for return=${cfg.returnKey}, which the Worker allowlist does not serve`);
    const base = 'https://skerishkang.github.io/kbs261022/site/#/login';
    assert.match(resolveOAuthRedirect(base, cfg.returnKey), new RegExp('/' + page.replace('.', '\\.') + '$'));
  });

  test(`${page} loads the staff stylesheet that styles .auth-box and .staff-msg`, () => {
    const html = read(page);
    assert.match(html, /<link rel="stylesheet" href="assets\/css\/cgi-staff-orders\.css">/);
    assert.match(html, /<link rel="stylesheet" href="assets\/css\/cgi-catalog\.css">/);
  });
}

test('the stylesheet keeps the hidden attribute winning over .btn display', () => {
  // .btn is `display: inline-flex`, which outranks the UA [hidden] rule, so a
  // console button written away in the markup renders anyway.
  const css = read('assets/css/cgi-catalog.css');
  assert.match(css, /\.btn\w*\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/,
    'cgi-catalog.css must nullify .btn display for [hidden], as the header rules already do');
});

test('the shared auth helper is cache-busted identically on every page', () => {
  const versions = Object.keys(PAGES).concat(['index.html']).map((page) => {
    const m = read(page).match(/cgi-auth\.js\?v=([0-9a-z]+)/);
    assert.ok(m, `${page} loads cgi-auth.js without a cache-buster`);
    return m[1];
  });
  assert.equal(new Set(versions).size, 1, `cgi-auth.js versions diverge: ${versions.join(', ')}`);
});

test('cgi-auth.js sends the return target to the existing OAuth start route', () => {
  const src = read('assets/js/cgi-auth.js');
  assert.match(src, /\/api\/auth\/google\/start/, 'the reused start route must still be the one called');
  assert.match(src, /\?return=' \+ encodeURIComponent\(returnTo\)/, 'googleLogin(returnTo) must forward the target');
});

test('the console scripts never invent an admin credential', () => {
  for (const cfg of Object.values(PAGES)) {
    const src = read(cfg.script);
    assert.doesNotMatch(src, /localStorage\.setItem\(\s*'cgiAdminToken'/,
      `${cfg.script} must not mint an admin token; the member session is the sanctioned path`);
  }
});
