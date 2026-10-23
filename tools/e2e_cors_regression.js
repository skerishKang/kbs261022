'use strict';
/*
 * #52 CORS 소스·배포 정합성 회귀 테스트.
 * 실배포 Worker의 응답 헤더가 ALLOWED_ORIGIN 고정 정책과 일치하는지 server-to-server(fetch)로 검증한다.
 * (브라우저가 아닌 노드에서 직접 Origin 헤더를 붙여 요청 → Worker가 반환하는 ACAO/Vary를 관찰.
 *  브라우저는 비허용 오리진의 ACAO를 읽지 못해 차단하므로, 정책 검증은 응답 헤더 기준으로 수행한다.)
 * 운영 자격증명 불필요 / 출력에 토큰 없음 / 고객 데이터 변경 없음(인증 없는 GET/PATCH는 401, OPTIONS는 상태 무변경).
 */
const WORKER = (process.argv.indexOf('--worker') !== -1 && process.argv[process.argv.indexOf('--worker') + 1])
  || 'https://cgi-quote-api.charliekant.workers.dev';
const ALLOWED = 'https://skerishkang.github.io';
const EVIL = 'http://evil.example.com';

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  console.log(ok ? '[PASS]' : '[FAIL]', name, detail || '');
}

async function req(method, path, headers, body) {
  const res = await fetch(WORKER + path, { method, headers, body });
  const h = {};
  res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
  let text = '';
  try { text = await res.text(); } catch (e) {}
  return { status: res.status, headers: h, text };
}

(async () => {
  console.log('[CORS] target', WORKER);

  // 1) preflight: 허용 오리진
  const preOk = await req('OPTIONS', '/api/quotes', {
    'Origin': ALLOWED,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,authorization',
  });
  check('OPTIONS allowed-origin -> 204', preOk.status === 204, 'status=' + preOk.status);
  check('OPTIONS allowed-origin ACAO==github.io',
    preOk.headers['access-control-allow-origin'] === ALLOWED,
    'ACAO=' + preOk.headers['access-control-allow-origin']);
  check('OPTIONS allowed-originMethods includes PATCH',
    /PATCH/.test(preOk.headers['access-control-allow-methods'] || ''),
    'ACAM=' + preOk.headers['access-control-allow-methods']);
  check('OPTIONS allowed-originAllow-Headers includes Authorization',
    /authorization/i.test(preOk.headers['access-control-allow-headers'] || ''),
    'ACAH=' + preOk.headers['access-control-allow-headers']);

  // 2) preflight: 비허용 오리진 — ACAO가 허용값으로 고정(에코/와일드카드 아님) + Vary: Origin
  const preEvil = await req('OPTIONS', '/api/quotes', {
    'Origin': EVIL,
    'Access-Control-Request-Method': 'POST',
  });
  check('OPTIONS evil-origin ACAO!=evil (고정 정책)',
    preEvil.headers['access-control-allow-origin'] !== EVIL,
    'ACAO=' + preEvil.headers['access-control-allow-origin']);
  check('OPTIONS Vary: Origin present (캐시 오용 방지)',
    /origin/i.test(preEvil.headers['vary'] || ''),
    'Vary=' + preEvil.headers['vary']);

  // 3) GET /api/quotes (인증 없음) — 헤더 정책 + 401
  const getEvil = await req('GET', '/api/quotes', { 'Origin': EVIL });
  check('GET evil-origin ACAO==github.io (에코 없음)',
    getEvil.headers['access-control-allow-origin'] === ALLOWED,
    'ACAO=' + getEvil.headers['access-control-allow-origin']);
  check('GET no-auth -> 401', getEvil.status === 401, 'status=' + getEvil.status);

  // 4) POST /api/quotes — CORS 헤더 유지 + 유효성 400 (빈 items; 실제 견적 생성 안 함)
  const post = await req('POST', '/api/quotes',
    { 'Origin': ALLOWED, 'Content-Type': 'application/json' }, JSON.stringify({ items: [] }));
  check('POST allowed-origin ACAO==github.io',
    post.headers['access-control-allow-origin'] === ALLOWED,
    'ACAO=' + post.headers['access-control-allow-origin']);
  check('POST empty-items -> 400 (생성 없음)', post.status === 400, 'status=' + post.status);

  // 5) PATCH /api/quotes/:id (인증 없음) — CORS 헤더 + 401
  const patch = await req('PATCH', '/api/quotes/Q-ping',
    { 'Origin': ALLOWED, 'Content-Type': 'application/json' }, JSON.stringify({ status: 'in_progress' }));
  check('PATCH allowed-origin ACAO==github.io',
    patch.headers['access-control-allow-origin'] === ALLOWED,
    'ACAO=' + patch.headers['access-control-allow-origin']);
  check('PATCH no-auth -> 401 (변경 없음)', patch.status === 401, 'status=' + patch.status);

  const failed = checks.filter((c) => !c.ok);
  console.log('[CORS] VERDICT', JSON.stringify({
    total: checks.length, passed: checks.length - failed.length, failed: failed.length,
    policy: failed.length === 0 ? 'CORS_ALLOWLIST_CONSISTENT' : 'CORS_MISMATCH',
  }));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('[CORS] ERROR', e.message); process.exit(2); });
