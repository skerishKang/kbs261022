// Contract tests for the signup consent flow (issue: UI/UX round 1).
//
// 회원가입은 이용약관·개인정보 수집/이용 동의를 필수로 받고, 프런트가 서버로
// 동의 플래그와 문서 버전을 함께 보내며, 서버(worker)는 미동의 가입을 거부하고
// 별도 consent 이벤트로 기록해야 한다. 정책 문서는 초안 상태로 존재해야 한다.
//
//   node --test site/test/signup-consent.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'assets', 'js', 'cgi-catalog.js'), 'utf8');
const WORKER = readFileSync(join(HERE, '..', '..', 'backend', 'worker.js'), 'utf8');

test('signup form renders required consent checkboxes with policy links', () => {
  assert.match(SRC, /name="agreeTerms"/, '이용약관 동의 체크박스가 있어야 한다');
  assert.match(SRC, /name="agreePrivacy"/, '개인정보 동의 체크박스가 있어야 한다');
  assert.match(SRC, /href="terms\.html"/, '이용약관 문서로 연결되어야 한다');
  assert.match(SRC, /href="privacy\.html"/, '개인정보 안내 문서로 연결되어야 한다');
  assert.match(SRC, /\[필수\]/, '필수 동의임이 화면에 표시되어야 한다');
});

test('signup submit blocks when consent is unchecked', () => {
  const idx = SRC.indexOf('renderSignup');
  const body = SRC.slice(idx, SRC.indexOf('function renderAuthVerify', idx));
  assert.match(body, /agreeTerms\.checked/, '약관 미동의 시 제출을 막아야 한다');
  assert.match(body, /agreePrivacy\.checked/, '개인정보 미동의 시 제출을 막아야 한다');
  assert.match(body, /동의가 필요합니다/, '미동의 안내 문구가 있어야 한다');
});

test('signup payload carries consent flags and document versions', () => {
  const idx = SRC.indexOf('function renderSignup');
  const body = SRC.slice(idx, SRC.indexOf('function renderAuthVerify', idx));
  assert.match(body, /terms:\s*true/);
  assert.match(body, /privacy:\s*true/);
  assert.match(body, /terms_version:\s*'draft-2026-10-28'/);
  assert.match(body, /privacy_version:\s*'draft-2026-10-28'/);
});

test('worker rejects signup without consent and records a consent event', () => {
  assert.match(WORKER, /error: 'consent required'/, '미동의 가입은 400으로 거부되어야 한다');
  assert.match(WORKER, /memberId, 'consent', JSON\.stringify\(\{ terms: true, privacy: true/, '동의는 별도 member_events(type=consent)로 기록된다');
  assert.match(WORKER, /terms_version: termsVersion, privacy_version: privacyVersion/);
});

test('policy draft documents exist and are marked as drafts', () => {
  for (const file of ['terms.html', 'privacy.html']) {
    const path = join(HERE, '..', file);
    assert.ok(existsSync(path), `${file} 이(가) 존재해야 한다`);
    const html = readFileSync(path, 'utf8');
    assert.match(html, /초안/, `${file} 은(는) 초안임이 명시되어야 한다(대표 확정 전)`);
    assert.match(html, /draft-2026-10-28/, `${file} 은(는) 버전 표기가 있어야 한다`);
  }
});
