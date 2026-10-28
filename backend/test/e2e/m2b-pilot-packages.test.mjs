// M2 후속 — 파일럿 패키지 도구의 재현성·안전 e2e. 바이트 비교가 아니라 JSON 내용 비교
// (Windows autocrlf 오탐 회피), 그리고 "전송 후보가 아님"의 자기 증명.
//
//   node --test test/e2e/m2b-pilot-packages.test.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = path.resolve(BACKEND, '..');
const TOOL = path.join(BACKEND, 'tools', 'm2b-pilot-packages.mjs');
const WORK_REL = '.work/m2b-pilot-test';
const COMMITTED = path.join(ROOT, 'reports', 'data', 'registration', 'm2b_pilot_packages.json');

after(() => { if (fs.existsSync(path.join(ROOT, WORK_REL))) fs.rmSync(path.join(ROOT, WORK_REL), { recursive: true, force: true }); });

// 부모가 기다리는 동안에도 이벤트 루프가 돌아야 한다 — 이 도구는 네트워크를 쓰지 않지만
// 관습을 맞춘다(교착 회피 규칙은 naver-category-corpus 테스트 참고).
const run = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [TOOL, ...args], { cwd: BACKEND });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => resolve({ status: code, stdout, stderr }));
});

test('the committed pilot packages are exactly what the tool reproduces', async () => {
  const outRel = `${WORK_REL}/packages.json`;
  const result = await run(['--out', outRel]);
  assert.equal(result.status, 0, result.stderr);
  const committed = JSON.parse(fs.readFileSync(COMMITTED, 'utf8'));
  const regenerated = JSON.parse(fs.readFileSync(path.join(ROOT, outRel), 'utf8'));
  assert.deepEqual(regenerated, committed);
});

test('three pilots, all blocked, with the safety gates self-proven', async () => {
  const report = JSON.parse(fs.readFileSync(COMMITTED, 'utf8'));
  assert.equal(report.kind, 'cgi-m2b-pilot-packages');
  assert.equal(report.products, 3);
  assert.equal(report.would_transmit, false);
  assert.equal(report.transmitted, false);
  assert.equal(report.naver_requests, 0);
  assert.equal(report.violations.length, 0);
  const expected = ['samamusic.co.kr:1769', 'samamusic.co.kr:3417', 'samamusic.co.kr:3418'];
  assert.deepEqual(report.packages.map((p) => p.cgi_id), expected);
  for (const pkg of report.packages) {
    const body = pkg.package.body.originProduct;
    assert.equal(pkg.package.status, 'blocked', '게이트가 열리기 전까지 파일럿도 전송 후보가 아니다');
    assert.ok(body.leafCategoryId == null, '확인되지 않은 카테고리 id 는 본문에 없다(키 자체가 생략됨)');
    assert.ok(body.detailContent == null, '승인 전 상세본문은 본문에 없다(키 자체가 생략됨)');
    assert.equal(body.stockQuantity, null, '재고 수치는 이 레인에서 만들지 않는다');
    assert.ok(pkg.package.problems.some((p) => p.reason === 'not_from_image_upload_api'), '공급처 직접 URL 은 게이트에 걸린다');
    assert.ok(pkg.package.problems.some((p) => p.reason === 'duplicate_search_not_executed'), '등록 전 중복검색 미실행이 표시된다');
    assert.ok(pkg.package.blocking_fields.includes('leafCategoryId'));
  }
});

test('the upload plan is prepared (dry-run) and the remaining work is split by owner', async () => {
  const report = JSON.parse(fs.readFileSync(COMMITTED, 'utf8'));
  for (const pkg of report.packages) {
    assert.equal(pkg.images.upload_plan.upload_calls, 1, '대표 이미지 1장 — 배치 1회 준비');
    assert.equal(pkg.images.upload_plan.additional.length, 0);
    assert.match(pkg.images.runner_note, /판매자 토큰/);
    assert.equal(pkg.blockers.product_class, 'auto_resolvable', '제품별 잔여는 도구 실행 클래스다(전면 정책은 별도)');
    assert.ok(pkg.blockers.reason_split.some((r) => r.resolution === 'tooling_with_token'), '토큰 선행 항목이 분류돼 있다');
    assert.deepEqual(pkg.customer_inputs_pending, ['원산지 정책', '배송비·배송 방식', '반품·교환 배송비', 'AS 안내', 'KC 인증(리프 요구 확인 후)']);
  }
});
