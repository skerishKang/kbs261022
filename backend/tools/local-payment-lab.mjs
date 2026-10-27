// Local payment lab — serves the CGI site and the Worker from ONE origin so a
// browser can round-trip a payment window against a real gateway or the mock.
//
// It exists because the completion bar for the NICEPAY integration is a real
// test order travelling through the checkout and back, which no in-process test
// can show. Nothing here deploys anything: no wrangler, no Cloudflare calls.
//
// Credentials come from the operator's environment. The tool never prints a
// value it read from env; it prints names and booleans only.
//
//   NICEPAY_TEST_CLIENT_KEY=... NICEPAY_TEST_SECRET_KEY=... \
//     node backend/tools/local-payment-lab.mjs --provider nicepay --mode live --port 8790
//   node backend/tools/local-payment-lab.mjs --provider nicepay --mode mock

import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import worker from '../worker.js';
import { openD1File } from '../d1-shim.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '..', '..');
const SITE = join(REPO, 'site');
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(name + '='));
  return eq ? eq.split('=')[1] : fallback;
}

const provider = arg('--provider', 'nicepay');
const mode = arg('--mode', 'mock');
const port = Number(arg('--port', '8790'));
const dbPath = join(REPO, `.lab-payments-${port}.sqlite`);
if (!process.argv.includes('--keep-db') && existsSync(dbPath)) rmSync(dbPath);

const nicepayPresent = ['NICEPAY_TEST_CLIENT_KEY', 'NICEPAY_TEST_SECRET_KEY']
  .map((k) => ({ name: k, loaded: Boolean(process.env[k] && process.env[k].trim()) }));

const labControls = {
  PG_PROVIDER: provider,
  PG_PROVIDER_MODE: mode,
  PG_NICEPAY_ENV: 'test',
  NICEPAY_SITE_BASE_URL: `http://localhost:${port}`,
  CORS_ALLOWED_ORIGINS: `http://localhost:${port}`,
  AUTH_ORIGIN_STRICT: 'NO',
  ERP_LIVE_WRITE: 'NO',
  ERP_MODE: 'test',
  SHIPPING_FEE_DEFAULT: '0',
};
const LAB_HANDLE = 'lab-admin-handle';
const env = {
  DB: openD1File(dbPath),
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || LAB_HANDLE,
  ...process.env,
  // the lab, not the ambient shell, decides which gateway and which origin
  ...labControls,
};

function labConfigJs() {
  const base = readFileSync(join(SITE, 'config.js'), 'utf-8');
  const origin = `http://localhost:${port}`;
  return base
    // the checkout screen refuses to run without an explicit API base, so the lab
    // points it at itself instead of at the empty string a file:// preview would use
    .replace(/quoteApiUrl:\s*'[^']*'/, `quoteApiUrl: '${origin}'`)
    .replace(/orderApiUrl:\s*'[^']*'/, `orderApiUrl: '${origin}'`)
    .replace(/pgProvider:\s*'[^']*'/, `pgProvider: '${provider}'`)
    .replace(/tossClientId:\s*'[^']*'/, provider === 'nicepay' ? "tossClientId: ''" : "tossClientId: 'test_gck_docs_Ovk5rk1EwkEbP0W43n07xlzm'")
    + `\n/* lab: same-origin API, provider=${provider}, mode=${mode} */\n`;
}

async function handleWorker(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: chunks.length && !['GET', 'HEAD'].includes(req.method) ? Buffer.concat(chunks) : undefined,
    redirect: 'manual',
  });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(await response.text());
}

function serveStatic(pathname, res) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
    res.end(labConfigJs());
    return;
  }
  const file = join(SITE, pathname.replace(/^\/+/, ''));
  if (!file.startsWith(SITE) || !existsSync(file)) {
    res.writeHead(404, { 'Content-Type': TYPES['.txt'] });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
}

createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) {
    handleWorker(req, res).catch((e) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'lab_failure', detail: String(e && e.message).slice(0, 120) })); });
    return;
  }
  if (['GET', 'HEAD'].includes(req.method)) { serveStatic(pathname, res); return; }
  res.writeHead(405); res.end();
}).listen(port, () => {
  process.stdout.write(JSON.stringify({
    lab: 'cgi-local-payment-lab', port, provider, mode,
    db: dbPath, site: SITE,
    nicepayEnv: nicepayPresent,
    checkout: `http://localhost:${port}/index.html#/checkout`,
    returnUrl: `http://localhost:${port}/api/payments/nicepay/return`,
    webhook: `http://localhost:${port}/api/payments/nicepay/webhook`,
  }) + '\n');
});
