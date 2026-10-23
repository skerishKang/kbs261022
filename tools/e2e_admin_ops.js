'use strict';
/*
 * #52 관리자 운영 검증 하네스 — COM1이 운영 자격증명으로 실행한다.
 * CGI LOCAL은 토큰을 발급·복사하지 않으므로, 토큰이 없는 환경에서는 BLOCKED-NO-TOKEN으로 종료한다.
 *
 * 사용법(COM1):
 *   ADMIN_TOKEN=<시크릿> node tools/e2e_admin_ops.js                 # 자동: [E2E 마크 테스트 견적 1건 선별
 *   ADMIN_TOKEN=<시크릿> node tools/e2e_admin_ops.js --id Q-xxxx      # 지정 테스트 견적만 PATCH
 *   ... --allow-real                                          # (기본 금지) 실고객 건을 명시히 허용할 때만
 *
 * 정책:
 *  - ADMIN_TOKEN은 환경변수로만 읽고 어디에도 출력/기록하지 않는다.
 *  - 기본은 company/name이 '[E2E' 마크로 시작하는 테스트 견적만 PATCH한다. 실고객 견적은 변경하지 않는다.
 *  - 검증 흐름: GET 목록 → GET 상세 → PATCH(status) → GET 재조회(영속 확인) → (선택) 롤백 PATCH.
 */
const WORKER = (process.argv.indexOf('--worker') !== -1 && process.argv[process.argv.indexOf('--worker') + 1])
  || 'https://cgi-quote-api.charliekant.workers.dev';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const args = process.argv.slice(2);
const argVal = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined; };
const SPECIFIED_ID = argVal('--id');
const ALLOW_REAL = args.includes('--allow-real');
const TEST_MARK = '[E2E';
const R = {};
const stage = (k, v) => { R[k] = v; console.log('[ADMIN]', k, JSON.stringify(v)); };

function authHeaders(withJson) {
  const h = { 'Authorization': 'Bearer ' + ADMIN_TOKEN, 'Origin': 'https://skerishkang.github.io' };
  if (withJson) h['Content-Type'] = 'application/json';
  return h;
}
async function call(method, path, body) {
  const res = await fetch(WORKER + path, {
    method, headers: authHeaders(body !== undefined), body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: res.status, json, text };
}
const isTest = (row) => typeof row.company === 'string' && row.company.startsWith(TEST_MARK)
  || typeof row.contact_name === 'string' && row.contact_name.startsWith(TEST_MARK);

(async () => {
  if (!ADMIN_TOKEN) {
    stage('verdict', { auth: 'BLOCKED-NO-TOKEN',
      note: 'CGI LOCAL은 운영 자격증명을 발급·복사하지 않는다. COM1이 ADMIN_TOKEN 환경변수로 실행해야 GET/PATCH 검증이 가능하다.' });
    console.log('[ADMIN] VERDICT', JSON.stringify(R.verdict));
    process.exit(3);
  }

  // 1) 인증 목록 GET
  const list = await call('GET', '/api/quotes');
  stage('GET_list', { status: list.status, count: list.json && list.json.items ? list.json.items.length : null });
  if (list.status === 401) {
    stage('verdict', { auth: 'REJECTED-401', note: 'ADMIN_TOKEN이 배포 Worker와 불일치. COM1에서 시크릿 재확인 필요(원문 비공개).' });
    process.exit(4);
  }
  if (list.status !== 200) { stage('verdict', { auth: 'LIST-ERROR', status: list.status }); process.exit(5); }

  // 2) 대상 테스트 견적 선별
  const items = (list.json && list.json.items) || [];
  let target = SPECIFIED_ID ? items.find((x) => x.id === SPECIFIED_ID) : items.filter(isTest)[0];
  if (SPECIFIED_ID && !target) {
    // 지정 ID가 목록에 없으면 상세로 존재 확인
    const det = await call('GET', '/api/quotes/' + encodeURIComponent(SPECIFIED_ID));
    if (det.status === 200) target = det.json;
  }
  if (!target) {
    stage('verdict', { auth: 'OK-NO-TEST-RECORD', note: '인증은 유효하나 [E2E 마크 테스트 견적이 없음. 선행: e2e_verify_issue39.js로 테스트 견적 1건 접수 후 재실행.' });
    process.exit(6);
  }
  if (!ALLOW_REAL && !isTest(target)) {
    stage('verdict', { auth: 'OK-REFUSE-REAL', id: target.id, note: '대상 건이 [E2E 마크가 아니다(실고객 가능성). PATCH를 건너뛴다. --id 또는 --allow-real로 명시하기 전까지 변경하지 않는다.' });
    process.exit(7);
  }
  const id = target.id;
  stage('target', { id, company: target.company, status_before: target.status });

  // 3) GET 상세
  const detail = await call('GET', '/api/quotes/' + encodeURIComponent(id));
  stage('GET_detail', { status: detail.status, has_items: !!(detail.json && detail.json.items) });

  // 4) PATCH 상태 변경 (received -> in_progress -> 회수)
  const beforeStatus = detail.json ? detail.json.status : target.status;
  const nextStatus = beforeStatus === 'in_progress' ? 'received' : 'in_progress';
  const patch = await call('PATCH', '/api/quotes/' + encodeURIComponent(id), { status: nextStatus });
  stage('PATCH', { status: patch.status, from: beforeStatus, to: nextStatus, echoed: patch.json && patch.json.status });

  // 5) GET 재조회로 D1 영속 확인
  const recheck = await call('GET', '/api/quotes/' + encodeURIComponent(id));
  const persisted = recheck.json && recheck.json.status === nextStatus;
  stage('GET_recheck', { status: recheck.status, status_now: recheck.json && recheck.json.status, persisted: !!persisted });

  // 6) 롤백(원상태 복원) — 테스트 건의 흔적을 남기지 않기 위함
  let rollback = null;
  if (persisted && nextStatus !== beforeStatus) {
    const rb = await call('PATCH', '/api/quotes/' + encodeURIComponent(id), { status: beforeStatus });
    const after = await call('GET', '/api/quotes/' + encodeURIComponent(id));
    rollback = { patch_status: rb.status, restored: after.json && after.json.status === beforeStatus };
    stage('PATCH_rollback', rollback);
  }

  stage('verdict', {
    auth: 'OK',
    admin_full_loop: (list.status === 200 && detail.status === 200 && patch.status === 200 && persisted) ? 'PASS' : 'PARTIAL',
    target_scope: isTest(target) ? 'TEST-E2E-MARK' : 'REAL(explicit)',
    rollback_restored: rollback ? rollback.restored : 'n/a',
  });
  process.exit(R.verdict.admin_full_loop === 'PASS' ? 0 : 8);
})().catch((e) => { console.error('[ADMIN] ERROR', e.message); process.exit(2); });
