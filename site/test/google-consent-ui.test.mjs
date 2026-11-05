// Google 최초 로그인 동의 화면(PR-3) — 사이트 배선 회귀.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const catalog = readFileSync(join(REPO, 'site', 'assets', 'js', 'cgi-catalog.js'), 'utf8');
const auth = readFileSync(join(REPO, 'site', 'assets', 'js', 'cgi-auth.js'), 'utf8');

test('the site renders a Google consent screen with both mandatory checkboxes', () => {
  assert.match(catalog, /parts\[1\] === 'google-consent'/);
  assert.match(catalog, /function renderGoogleConsent\(app\)/);
  assert.match(catalog, /name="agreeTerms"/);
  assert.match(catalog, /name="agreePrivacy"/);
  assert.match(catalog, /href="terms\.html"/);
  assert.match(catalog, /href="privacy\.html"/);
  assert.match(catalog, /draft-2026-10-28/);
  assert.match(catalog, /p\.googleConsent\(token/);
});

test('the consent API wrapper posts to the Worker endpoint and keeps the redirect', () => {
  assert.match(auth, /function googleConsent\(token, payload\)/);
  assert.match(auth, /'\/api\/auth\/google\/consent'/);
  assert.match(auth, /redirect: res\.data\.redirect/);
  assert.match(auth, /googleConsent: googleConsent/);
});

test('the consent screen returns to the page the sign-in started from', () => {
  assert.match(catalog, /if \(res\.redirect\) window\.location\.href = res\.redirect/);
});
