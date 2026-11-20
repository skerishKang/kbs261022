// Local-only API for screenshots: the repo's real worker.fetch on the in-memory D1 shim.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname as pdir, join as pjoin } from 'node:path';
import { fileURLToPath } from 'node:url';
// 로컬 시험용 로그인 값: 고정 문자열 없이 실행 때마다 새로 만든다(.capture-login 은 커밋하지 않는다)
// 비밀번호 규칙(영문·숫자·기호)을 늘 만족하도록 접미사를 붙인다
const LOGIN = randomBytes(18).toString('base64url') + ['-', 'Aa', '9', '!'].join('');
writeFileSync(pjoin(pdir(fileURLToPath(import.meta.url)), '.capture-login'), LOGIN);
const REPO = process.argv[2];
const { default: worker } = await import(`${REPO}/backend/worker.js`);
const { openD1 } = await import(`${REPO}/backend/d1-shim.mjs`);
const PAGE = 'http://localhost:8765';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const env = {
  DB: openD1(), ADMIN_TOKEN: randomBytes(18).toString('base64url'), PG_PROVIDER: 'nicepay', SITE_PG_PROVIDER: 'nicepay', PG_PROVIDER_MODE: 'mock',
  ERP_LIVE_WRITE: 'NO', ERP_MODE: 'test', SHIPPING_FEE_DEFAULT: '0', MAIL_MODE: 'echo',
  AUTH_PBKDF2_ITERATIONS: '1000', AUTH_RATE_LIMIT_MAX: '100000', AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
  CORS_ALLOWED_ORIGINS: PAGE,
};
const CSRF = { Origin: PAGE, 'X-CSRF-Token': PAGE, 'Content-Type': 'application/json' };
async function call(method, path, body, headers = {}) {
  const r = await worker.fetch(new Request('https://api.local' + path, { method, headers: { ...CSRF, ...headers }, body: body ? JSON.stringify(body) : undefined }), env);
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  if (r.status >= 400) console.error('seed', method, path, r.status, t.slice(0, 200));
  return { status: r.status, json: j, cookie: r.headers.get('set-cookie') };
}
async function member(email, name) {
  const s = await call('POST', '/api/auth/signup', { email, name, password: LOGIN, terms: true, privacy: true, terms_version: 'draft-2026-10-28', privacy_version: 'draft-2026-10-28' });
  await call('POST', '/api/auth/verify-email', { member_id: s.json.member.id, token: s.json.mail.echo_token });
  return (await call('POST', '/api/auth/login', { email, password: LOGIN })).cookie;
}
await member('skerish@naver.com', '운영자');
const mem = await member('kim@example.com', '김회원');
await call('POST', '/api/feedback', { kind: 'bug', body: '견적 목록에서 수량을 바꿔도 합계가 바로 안 바뀝니다. 새로고침하면 맞게 나옵니다.', page_url: 'https://cgishop.pages.dev/site/index.html#/quote-cart', contact_email: 'guest@example.com' });
await call('POST', '/api/feedback', { kind: 'idea', body: '상품 상세에 설치 사례 사진이 있으면 좋겠습니다.', page_url: 'https://cgishop.pages.dev/site/index.html#/product/samamusic.co.kr:100' }, { Cookie: mem });
await call('POST', '/api/feedback', { kind: 'other', body: '세금계산서는 결제 후 언제 발행되나요?', contact_email: 'buyer@example.com' });
console.log('seeded');
http.createServer(async (req, res) => {
  if (!req.url.startsWith('/api/')) {
    const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^([.][.][/])+/, '');
    try { const body = await readFile(join(REPO, path)); res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' }); res.end(body); }
    catch { res.writeHead(404); res.end('nf'); }
    return;
  }
  const chunks = []; for await (const c of req) chunks.push(c);
  const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
  delete headers.host;
  if (!headers.origin) headers.origin = PAGE; // 실제 배포는 교차 출처라 항상 Origin 이 붙는다
  const r = await worker.fetch(new Request('https://api.local' + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
  const out = {}; r.headers.forEach((v, k) => { out[k] = v; });
  res.writeHead(r.status, out); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8765, 'localhost', () => console.log('listening 8765'));
