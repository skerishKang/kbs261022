// M2 사전개발 리포트 도구의 재현성 e2e. 바이트 비교가 아니라 JSON 내용 비교를 쓴다 —
// Windows autocrlf 체크아웃이 줄바꿈만 바꾼 커밋 산출물을 내용이 달라졌다고 거짓 보고하는
// 일을 이 레인에서 반복하지 않는다.
//
//   node --test test/e2e/m2-predev-report.test.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = path.resolve(BACKEND, '..');
const TOOL = path.join(BACKEND, 'tools', 'm2-predev-report.mjs');
const WORK_REL = '.work/m2-predev-test';
const WORK = path.join(ROOT, WORK_REL);
const COMMITTED = path.join(ROOT, 'reports', 'data', 'registration', 'm2_predev_report.json');

after(() => { if (fs.existsSync(WORK)) fs.rmSync(WORK, { recursive: true, force: true }); });

test('the committed M2 pre-dev report is exactly what the tool reproduces', () => {
  const outRel = `${WORK_REL}/report.json`;
  const stdout = execFileSync(process.execPath, [TOOL, '--out', outRel], { encoding: 'utf8', cwd: BACKEND });
  assert.match(stdout, /wrote .*m2-predev-test\/report\.json/);

  const committed = JSON.parse(fs.readFileSync(COMMITTED, 'utf8'));
  const regenerated = JSON.parse(fs.readFileSync(path.join(ROOT, outRel), 'utf8'));
  assert.deepEqual(regenerated, committed);
});

test('the report proves the safety gates instead of asserting them silently', () => {
  const report = JSON.parse(fs.readFileSync(COMMITTED, 'utf8'));
  assert.equal(report.would_transmit, false);
  assert.equal(report.transmitted, false);
  assert.equal(report.naver_requests, 0);
  assert.equal(report.account_login, 'NO');
  assert.equal(report.pilot.packages.length, 3, '파일럿은 정확히 3건이다');
  for (const pkg of report.pilot.packages) {
    assert.equal(pkg.would_transmit, false);
    assert.equal(pkg.status, 'blocked', '게이트가 열리기 전까지 파일럿도 전송 후보가 아니다');
    assert.ok(pkg.blocking_fields.includes('leafCategoryId'));
    assert.ok(pkg.problems.some((p) => p.reason === 'duplicate_search_not_executed'), '등록 전 중복 검색 미실행이 표시된다');
  }
  assert.equal(report.pilot.violations.length, 0);
});

test('the field-gap classification measures the columns it blames', () => {
  const report = JSON.parse(fs.readFileSync(COMMITTED, 'utf8'));
  const gaps = report.field_gaps_by_source;
  assert.equal(gaps.undeclared_total, 0, '범위 안 사유 전체가 분류 표에 선언돼 있어야 한다');
  assert.equal(gaps.fields.origin.source_counts.prep_column_blank, report.products);
  for (const [column, measured] of Object.entries(gaps.measured_columns)) {
    assert.equal(measured.present, true, `${column} 열이 준비파일에 존재하는지 실측됐다`);
    assert.equal(measured.non_blank, 0, `${column} 열은 전량 공란 — prep_column_blank 의 실측 근거다`);
  }
  assert.ok(gaps.fields.stock.source_counts.erp_read_pending > 0, '재고는 ERP 잔량조회 대기가 실측된다');
});

test('the stock correspondence joins every catalogue row to its ERP item code', () => {
  const report = JSON.parse(fs.readFileSync(COMMITTED, 'utf8'));
  const join = report.stock_correspondence.join;
  assert.equal(join.prod_cd_in_both, report.products, '품목코드는 매핑·업로드 양쪽에 모두 있다');
  assert.equal(join.only_in_mapping, 0);
  assert.equal(join.only_in_upload, 0);
  assert.equal(report.stock_correspondence.rules.authority.includes('stockFromErpBalance'), true);
});
