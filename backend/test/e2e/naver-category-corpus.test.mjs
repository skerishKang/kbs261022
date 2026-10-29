// M2 후속 — 카테고리 코퍼스 수집·검증 도구 e2e (루프백 mock, 실서버 접속 없음).
//
//   node --test test/e2e/naver-category-corpus.test.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { closeAllMockNcomServers, startMockNcomServer } from '../helpers/mock-ncom.mjs';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = path.resolve(BACKEND, '..');
const TOOL = path.join(BACKEND, 'tools', 'naver-category-corpus.mjs');
const WORK = path.join(ROOT, '.work', 'category-corpus-test');

after(() => { if (fs.existsSync(WORK)) fs.rmSync(WORK, { recursive: true, force: true }); return closeAllMockNcomServers(); });

// 공식 GET /v1/categories 응답 '형태'의 mock 트리 — 값은 모양을 흉내 낸 것이지
// 실제 네이버 분류체계의 인용이 아니다.
const CATEGORIES = [
  { id: '50000001', wholeCategoryName: '홈 > 음악기기 > 음향기기 > 이어폰', name: '이어폰', last: true },
  { id: '50000002', wholeCategoryName: '홈 > 음악기기 > 음향기기 > 스피커 > 모니터링 스피커', name: '모니터링 스피커', last: true },
  { id: '50000003', wholeCategoryName: '홈 > 음악기기 > 음향기기 > 헤드폰', name: '헤드폰', last: true },
  { id: '50000004', wholeCategoryName: '홈 > 음악기기 > 음향기기 > 마이크', name: '마이크', last: true },
  { id: '50000005', wholeCategoryName: '홈 > 음악기기 > 음향기기', name: '음향기기', last: false },
];

// 주의: execFileSync/spawnSync 는 부모 이벤트 루프를 막아 부모 프로세스의 mock 서버가
// 응답하지 못하게 된다(자식은 토큰 응답을 영원히 기다리는 교착). 그래서 비동기 spawn 이다.
const run = (args, envOverrides = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [TOOL, ...args], { cwd: BACKEND, env: { ...process.env, ...envOverrides } });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => resolve({ status: -1, stdout, stderr: `${stderr}${error.message}` }));
  child.on('close', (code) => resolve({ status: code, stdout, stderr }));
});

test('fetch refuses to leave the mock lane — no NCOM_MODE, no collection', async () => {
  const result = await run(['fetch', '--corpus-out', '.work/category-corpus-test/never.json'], { NCOM_MODE: '', NCOM_MOCK_BASE_URL: '' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /NCOM_MODE=mock 만 허용/);
  assert.equal(fs.existsSync(path.join(WORK, 'never.json')), false, '거부된 실행은 파일을 남기지 않는다');
});

test('fetch collects from the mock gateway and stamps provenance (sha256, counts)', async () => {
  const mock = await startMockNcomServer({ categories: CATEGORIES });
  const outRel = '.work/category-corpus-test/corpus.json';
  const result = await run(['fetch', '--corpus-out', outRel], {
    NCOM_MODE: 'mock', NCOM_MOCK_BASE_URL: mock.baseUrl, NCOM_CLIENT_ID: 'CID', NCOM_CLIENT_SECRET: 'SEC',
  });
  assert.equal(result.status, 0, result.stderr);
  const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, outRel), 'utf8'));
  assert.equal(corpus.kind, 'cgi-naver-category-corpus');
  assert.equal(corpus.mode, 'mock');
  assert.equal(corpus.row_count, CATEGORIES.length);
  assert.match(corpus.sha256, /^[0-9a-f]{64}$/);
  assert.match(corpus.fetched_at, /^\d{4}-/);
  assert.match(result.stdout, /naver_requests=/);
});

test('verify passes a sound corpus: zero invented ids, brand paths stay unmapped, proposals exist', async () => {
  const mock = await startMockNcomServer({ categories: CATEGORIES });
  const corpusRel = '.work/category-corpus-test/corpus-verify.json';
  const reportRel = '.work/category-corpus-test/verification.json';
  const fetched = await run(['fetch', '--corpus-out', corpusRel], { NCOM_MODE: 'mock', NCOM_MOCK_BASE_URL: mock.baseUrl, NCOM_CLIENT_ID: 'CID', NCOM_CLIENT_SECRET: 'SEC' });
  assert.equal(fetched.status, 0, fetched.stderr);
  const result = await run(['verify', '--corpus', corpusRel, '--report-out', reportRel]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(ROOT, reportRel), 'utf8'));
  assert.equal(report.passed, true);
  assert.equal(report.corpus.leaves, 4, 'last=false 행은 리프가 아니다');
  assert.equal(report.contract.invented_leaf_category_ids, 0);
  assert.equal(report.contract.structural_violations, 0);
  assert.ok(report.contract.proposed_products > 0, '이어폰 등 정확히 일치하는 경로는 후보가 나온다');
  assert.ok(report.contract.products_by_status.candidate > 0);
});

test('verify fails loudly on a leaf-less corpus and writes the failure report', async () => {
  const corpusRel = '.work/category-corpus-test/no-leaves.json';
  const reportRel = '.work/category-corpus-test/no-leaves-report.json';
  fs.mkdirSync(path.join(ROOT, '.work/category-corpus-test'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, corpusRel), JSON.stringify({
    kind: 'cgi-naver-category-corpus',
    categories: [{ id: '1', wholeCategoryName: '홈 > 음향기기', name: '음향기기', last: false }],
  }));
  const result = await run(['verify', '--corpus', corpusRel, '--report-out', reportRel]);
  assert.equal(result.status, 1);
  const report = JSON.parse(fs.readFileSync(path.join(ROOT, reportRel), 'utf8'));
  assert.equal(report.passed, false);
  assert.ok(report.failures.includes('no_leaves'));
});
