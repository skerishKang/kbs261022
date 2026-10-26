/*
 * company-data.test.mjs — 2025년 지명원 기반 회사정보 회귀 검사 (이슈 #97)
 *
 * website/assets/company.js 를 유일한 정본으로 보고,
 * 실제 페이지 HTML 에 그 값이 올바르게 반영되었는지 검사한다.
 * (company.js 는 빌드 없이 window 전역에 대입하므로 vm 으로 로드한다.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const sandbox = createContext({ window: {} });
runInContext(read('website/assets/company.js'), sandbox);
const CO = sandbox.window.CGI_COMPANY;

const home = read('website/index.html');
const mall = read('site/index.html');
const catalog = read('site/assets/js/cgi-catalog.js');
const allPages = home + mall + catalog;

test('company.js exposes the 2025 profile as the single source', () => {
  assert.ok(CO, 'window.CGI_COMPANY 가 있어야 한다');
  assert.equal(CO.meta.asOf, '2025');
  assert.match(CO.meta.source, /지명원/);
  assert.ok(CO.meta.caveat, '기준연도 주의 문구가 있어야 한다');
});

test('identity facts match the 2025 profile', () => {
  assert.equal(CO.identity.nameKo, '주식회사 시지아이');
  assert.equal(CO.identity.ceo, '김범신');
  assert.equal(CO.identity.founded, '2011년 1월');
  assert.equal(CO.identity.bizRegNo, '410-86-46283');
  assert.equal(CO.identity.employees, '6명');
  assert.equal(CO.identity.employeesAsOf, '2025년 지명원 기준');
});

test('headquarters is the Jangseong address, not the former Gwangju one', () => {
  assert.equal(CO.hq.addrFull, '전라남도 장성군 남면 나노산단로 102 (삼태리)');
  assert.equal(CO.hq.zip, '57248');
  for (const stale of ['하남산단천변좌로', '광주드림파크', '오선동']) {
    assert.ok(!allPages.includes(stale), `구 주소 표기가 남아있다: ${stale}`);
  }
  assert.ok(home.includes(CO.hq.addrFull), '홈페이지 본사 주소가 company.js 와 일치해야 한다');
  assert.ok(mall.includes('전라남도 장성군 남면'), '쇼핑몰 푸터 주소가 장성으로 갱신되어야 한다');
});

test('both profile phone numbers and the fax are published everywhere', () => {
  const nums = CO.contact.tels.map((t) => t.num);
  // company.js 는 vm 다른 realm 에서 오는 배열이므로 프로토타입 비교를 피하고 정확히 문자열로 비교한다
  assert.equal(nums.join('|'), '062) 576-8100|061) 801-8100');
  for (const num of nums) {
    assert.ok(home.includes(num), `홈페이지에 ${num} 가 없다`);
  }
  assert.ok(home.includes(CO.contact.fax));
  assert.ok(mall.includes('061) 801-8100'), '쇼핑몰에 2번째 대표번호가 없다');
  for (const tel of CO.contact.tels) {
    assert.ok(home.includes(`href="tel:${tel.dial}"`), `tel 링크 누락: ${tel.dial}`);
  }
});

test('employee count and credentials are labelled with the profile year', () => {
  assert.match(home, /6명[\s\S]{0,120}2025년 지명원 기준/);
  assert.match(home, /2025년 발간 공식 지명원 기준/);
  assert.match(home, /현재 유효성은 별도 확인이 필요합니다/);
});

test('business areas cover all 12 profile keywords', () => {
  assert.equal(CO.keywords.length, 12);
  const rendered = CO.business.map((b) => b.items.join(' ') + ' ' + b.name).join(' ');
  const missing = CO.keywords.filter((k) => !rendered.includes(k) && !k.includes('각종'));
  assert.equal(missing.join(', '), '', '지명원 주요사업 키워드가 사업분야에 반영되지 않았다');
  assert.ok(CO.business.length >= 8, '사업분야 카드가 지명원보다 적다');
  assert.ok(home.includes('id="bizGrid"'), '사업분야 렌더링 컨테이너가 없다');
});

test('history spans 2011 through 2025 and drops the old placeholder text', () => {
  const years = CO.history.map((h) => h.year);
  assert.equal(years[0], '2011');
  assert.equal(years[years.length - 1], '2025');
  assert.ok(!home.includes('anchor'), '연혁에 남아있던 anchor 자리표시자가 있다');
  assert.ok(!home.includes('detach'), '연혁에 남아있던 detach 자리표시자가 있다');
  assert.ok(!home.includes('회사소개서(2017)'), '연혁 기준년이 2017로 고정된 문구가 남아있다');
  const flat = CO.history.map((h) => h.items.join(' ')).join(' ');
  assert.match(flat, /특허등록\(제10-1544181호\)/);
  assert.match(flat, /정보통신공사업 등록/);
});

test('records and maintenance reference years are stated', () => {
  assert.ok(CO.records.length >= 5);
  assert.equal(CO.records[0].year, '2025');
  for (const row of CO.records) {
    assert.ok(row.count > 0, `${row.year} 건수가 없다`);
    assert.ok(row.samples.length > 0, `${row.year} 사례가 없다`);
  }
  assert.ok(CO.maintenanceCases.some((m) => m.period.includes('진행중')));
  assert.ok(home.includes('id="recordList"'));
  assert.ok(home.includes('id="maintList"'));
});

test('certificate originals and personal data are never published', () => {
  for (const forbidden of ['법인등기부등본 이미지', '사업자등록증 이미지', 'cgi-cert', '지명원_시지아이']) {
    assert.ok(!allPages.includes(forbidden), `공개 금지 자료 참조: ${forbidden}`);
  }
  // 쇼핑몰 가입/배송 폼의 입력 예시(010-0000-0000)는 개인 정보가 아니다.
  // "모두 0" 인 리터럴만 걷어내므로 실제 번호가 이 형태로 위장해 지나갈 수 없다.
  const scan = allPages.replace(/010[-\s]?0{4}[-\s]?0{4}/g, '[form-placeholder]');
  assert.doesNotMatch(scan, /010[-\s]?\d{4}[-\s]?\d{4}/, '휴대전화 번호가 게시되어 있다');
  assert.doesNotMatch(scan, /\d{6}-\d{7}/, '주민등록번호 형태 문자열이 있다');
  assert.ok(home.includes('개인정보가 포함되어 공개 게시하지 않습니다'));
  // 지명원 10쪽 세미나 포스터에 적힌 개인 성명·휴대전화는 이미지 제외 대상으로 판정했다.
  for (const rel of ['website/index.html', 'site/index.html', 'website/assets/company.js', 'website/assets/main.js']) {
    const t = read(rel);
    assert.ok(!t.includes('010-9226-4351'), `${rel} 에 지명원의 개인 휴대전화 번호가 있다`);
    assert.ok(!t.includes('박준석'), `${rel} 에 지명원의 개인 성명이 있다`);
  }
});

test('location offers map links built from the road-name address', () => {
  assert.match(CO.hq.naverMapUrl, /^https:\/\/map\.naver\.com\/p\/search\//);
  assert.match(CO.hq.googleMapUrl, /^https:\/\/www\.google\.com\/maps\/search/);
  assert.ok(home.includes('map.naver.com'), '홈페이지에 네이버지도 링크가 없다');
  assert.ok(home.includes('cgi-map-sketch.jpg'), '약도 이미지가 빠져있다');
  assert.ok(CO.hq.landmarks.length >= 3);
});

test('mall reads company facts from company.js instead of literals', () => {
  assert.ok(mall.includes('../website/assets/company.js'), '쇼핑몰이 company.js 를 불러오지 않는다');
  assert.ok(catalog.includes('window.CGI_COMPANY'), 'cgi-catalog.js 가 company.js 를 읽지 않는다');
  assert.ok(catalog.includes('companyContactHtml()'));
  assert.ok(!/about-contact[\s\S]{0,400}?광산구/.test(catalog), '쇼핑몰 문의 안내에 구 주소가 하드코딩되어 있다');
});

test('homepage loads the data module before the renderer', () => {
  const c = home.indexOf('assets/company.js');
  const m = home.indexOf('assets/main.js');
  assert.ok(c > 0 && m > 0, '스크립트 태그가 없다');
  assert.ok(c < m, 'company.js 가 main.js 보다 먼저 로드되어야 한다');
  assert.ok(read('website/assets/main.js').includes('renderCompany()'));
});
