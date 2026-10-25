// Regression tests for the quote console's member-session wiring (staff.html).
//
// cgi-staff.js is a DOM-driven IIFE, so it is evaluated here inside a function
// whose parameters shadow window/document/localStorage/fetch. Each run therefore
// boots a fresh copy with its own recorded calls.
//
//   node --test site/test/*.test.mjs
//
// The harness fakes the rendered request card (element.querySelector returns a
// stub button carrying data-open) so the real wiring at cgi-staff.js:68 is
// exercised; HTML parsing itself is out of scope here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'assets', 'js', 'cgi-staff.js'), 'utf8');
const API = 'https://cgi-quote-api.example.workers.dev';
const ORIGIN = 'https://skerishkang.github.io';
const ADMIN = { email: 'owner@cgi.test', role: 'superadmin', is_admin: false };

const ROW = {
  id: 'Q1', company: 'CGI', name: '강사장', phone: '010', email: 'a@b.c',
  location: '판교', note: '', status: 'received', created_at: '2026-10-25T10:00:00Z',
  items: [{ id: 'p1', name: '서버', brand: 'Dell', category: 'hw', qty: 2 }],
  services: [], admin_prices: null,
};

function makeElement(id) {
  const listeners = {};
  let card = null;
  return {
    id,
    hidden: false,
    value: '',
    textContent: '',
    innerHTML: '',
    files: [],
    listeners,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, event) {
      const fns = listeners[type] || [];
      fns.forEach((fn) => fn(event || { preventDefault() {} }));
      return fns.length;
    },
    getAttribute(name) { return name === 'data-open' ? 'Q1' : null; },
    querySelector() { return null; },
    // Stands in for the one request card renderList() writes into #requestList.
    querySelectorAll() {
      card = card || makeElement(id + ':card');
      return [card];
    },
    insertAdjacentHTML() {},
    appendChild() {},
    removeChild() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
}

function makeDocument() {
  const elements = new Map();
  // Mirrors the `hidden` attributes in staff.html: #authBox and #logoutBtn are
  // written away in the markup and only revealed by the console's own code.
  const hiddenAtBoot = new Set(['authBox', 'logoutBtn']);
  return {
    getElementById(id) {
      if (!elements.has(id)) {
        const el = makeElement(id);
        if (hiddenAtBoot.has(id)) el.hidden = true;
        elements.set(id, el);
      }
      return elements.get(id);
    },
    createElement(tag) { return makeElement('<' + tag + '>'); },
    body: makeElement('body'),
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function makeStorage(initial) {
  const data = Object.assign({}, initial);
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    removeItem(key) { delete data[key]; },
    data,
  };
}

async function boot(options) {
  const opts = options || {};
  const fetches = [];
  const authCalls = [];
  const document = makeDocument();
  const storage = makeStorage({
    cgiQuoteRequests: JSON.stringify(opts.cachedRequests === undefined ? [ROW] : opts.cachedRequests),
    cgiAdminToken: opts.token === undefined ? null : opts.token,
  });
  const alerts = [];

  const fetchFn = (url, init) => {
    fetches.push({ url, init: init || {} });
    const body = /\/api\/quotes\//.test(url) ? ROW : { items: [ROW] };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };

  const window = {
    CGI_SITE_CONFIG: { quoteApiUrl: API },
    CGI_PRODUCTS: [{ id: 'p1', name: '서버', brand: 'Dell', category: 'hw' }],
    CGI_SERVICES: [],
    location: { origin: ORIGIN, href: '' },
  };
  if (!opts.noAuthModule) {
    window.CGI_AUTH = {
      login(payload) {
        authCalls.push({ kind: 'login', payload });
        return Promise.resolve(opts.loginResult !== undefined ? opts.loginResult : true);
      },
      refresh() {
        authCalls.push({ kind: 'refresh' });
        const first = authCalls.filter((c) => c.kind === 'refresh').length === 1;
        if (first && opts.refreshError) return Promise.reject(new Error('no session'));
        return Promise.resolve(opts.session === undefined ? null : opts.session);
      },
      logout() { authCalls.push({ kind: 'logout' }); return Promise.resolve(true); },
      googleLogin(returnTo) {
        authCalls.push({ kind: 'googleLogin', returnTo });
        window.location.href = API + '/api/auth/google/start' + (returnTo ? '?return=' + encodeURIComponent(returnTo) : '');
      },
    };
  }

  const run = new Function(
    'window', 'document', 'localStorage', 'fetch', 'alert', 'console', 'setTimeout',
    SRC
  );
  run(window, document, storage, fetchFn, (m) => alerts.push(m), { error() {}, log() {} }, setTimeout);
  await new Promise((resolve) => setTimeout(resolve, 0));

  return {
    window, document, storage, fetches, authCalls, alerts,
    quotesCalls: () => fetches.filter((f) => f.url === API + '/api/quotes'),
    loginButton: () => document.getElementById('memberLoginBtn'),
    message: () => document.getElementById('authMsg').textContent,
  };
}

test('the staff login form starts a CGI member session and loads the console', async () => {
  const env = await boot({ refreshError: true, session: ADMIN });
  assert.equal(env.document.getElementById('authBox').hidden, false, 'a signed-out operator should see the login form');
  assert.equal(env.quotesCalls().length, 0, 'nothing may be fetched without a session');

  env.document.getElementById('memberEmail').value = '  owner@cgi.test  ';
  env.document.getElementById('memberPassword').value = 'hunter2';
  const handlers = env.loginButton().dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(handlers > 0, '#memberLoginBtn has no click handler — the login form is dead');
  const login = env.authCalls.find((c) => c.kind === 'login');
  assert.ok(login, 'clicking 로그인 must call CGI_AUTH.login');
  assert.deepEqual(login.payload, { email: 'owner@cgi.test', password: 'hunter2' }, 'the email is trimmed and the password passed through');
  const quotes = env.quotesCalls()[0];
  assert.ok(quotes, 'an admin login must load /api/quotes');
  assert.equal(quotes.init.credentials, 'include', 'the member session rides the cookie, not a Bearer token');
  assert.equal(quotes.init.headers.Authorization, undefined);
  assert.match(quotes.init.headers['X-CSRF-Token'], /skerishkang\.github\.io/);
  assert.equal(env.document.getElementById('authBox').hidden, true, 'a successful login hides the form');
  assert.equal(env.message(), '');
});

test('a non-admin member is told so and signed straight back out', async () => {
  const env = await boot({ session: { email: 'customer@cgi.test', role: 'member', is_admin: false } });
  env.document.getElementById('memberEmail').value = 'customer@cgi.test';
  env.document.getElementById('memberPassword').value = 'pw';
  env.loginButton().dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(env.message(), /관리자 권한/);
  assert.equal(env.authCalls.filter((c) => c.kind === 'logout').length, 1, 'a non-admin session must not be kept');
  assert.equal(env.quotesCalls().length, 0, 'a non-admin may not read the quote console');
  assert.equal(env.document.getElementById('authBox').hidden, false);
});

test('a rejected login reports the failure and keeps the form open', async () => {
  const env = await boot({ loginResult: false, refreshError: true, session: ADMIN });
  env.document.getElementById('memberEmail').value = 'owner@cgi.test';
  env.document.getElementById('memberPassword').value = 'wrong';
  const refreshesBefore = env.authCalls.filter((c) => c.kind === 'refresh').length;
  env.loginButton().dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(env.message(), /로그인에 실패/);
  assert.equal(env.authCalls.filter((c) => c.kind === 'refresh').length, refreshesBefore, 'a failed login may not be probed with refresh');
  assert.equal(env.quotesCalls().length, 0);
});

test('missing credentials are refused before the server is called', async () => {
  for (const [email, password] of [['', 'pw'], ['owner@cgi.test', ''], ['   ', '   ']]) {
    const env = await boot({ refreshError: true });
    env.document.getElementById('memberEmail').value = email;
    env.document.getElementById('memberPassword').value = password;
    env.loginButton().dispatch('click');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(env.authCalls.filter((c) => c.kind === 'login').length, 0, JSON.stringify([email, password]));
    assert.match(env.message(), /이메일과 비밀번호/);
  }
});

test('a broken auth module is reported instead of a silent no-op', async () => {
  const env = await boot({ refreshError: true });
  env.window.CGI_AUTH = null;
  env.loginButton().dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(env.message(), /인증 모듈/);
});

test('a member-session admin can open a request from the server', async () => {
  const env = await boot({ session: { email: 'owner@cgi.test', role: 'superadmin', is_admin: false } });
  assert.equal(env.quotesCalls().length, 1, 'boot must load the list over the member session');

  const detailBefore = env.fetches.length;
  const card = env.document.getElementById('requestList').querySelectorAll('button[data-open]')[0];
  assert.equal(card.dispatch('click'), 1, 'the rendered card must have a detail handler');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const detail = env.fetches.slice(detailBefore).find((f) => f.url === API + '/api/quotes/Q1');
  assert.ok(detail, 'member-session admins must fetch the quote detail, not serve it from cache');
  assert.equal(detail.init.credentials, 'include');
  assert.equal(detail.init.headers.Authorization, undefined);
  assert.equal(env.document.getElementById('requestDetail').innerHTML !== '', true);
});

test('the legacy Bearer token path still reaches the server', async () => {
  const env = await boot({ token: 'legacy-token' });
  const quotes = env.quotesCalls()[0];
  assert.ok(quotes, 'a stored cgiAdminToken must still be honoured');
  assert.equal(quotes.init.headers.Authorization, 'Bearer legacy-token');

  const card = env.document.getElementById('requestList').querySelectorAll('button[data-open]')[0];
  card.dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const detail = env.fetches.find((f) => f.url === API + '/api/quotes/Q1');
  assert.ok(detail);
  assert.equal(detail.init.headers.Authorization, 'Bearer legacy-token');
});

// ---------------------------------------------------------------------------
// Google login (the superadmin account has no CGI password at all)
// ---------------------------------------------------------------------------

test('the Google button starts the existing OAuth flow aimed at staff.html', async () => {
  const env = await boot({ refreshError: true });
  const btn = env.document.getElementById('memberGoogleBtn');
  assert.equal(btn.dispatch('click'), 1, '#memberGoogleBtn has no click handler — the Google login is dead');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const call = env.authCalls.find((c) => c.kind === 'googleLogin');
  assert.ok(call, 'clicking Google로 계속하기 must call CGI_AUTH.googleLogin');
  assert.equal(call.returnTo, 'staff', 'the flow has to come back to the quote console');
  assert.equal(env.window.location.href, API + '/api/auth/google/start?return=staff');
  assert.equal(btn.disabled, true, 'the button must not be clickable twice mid-navigation');
  assert.equal(env.quotesCalls().length, 0, 'navigation is not a substitute for a session');
});

test('a missing auth module is reported for the Google button too', async () => {
  const env = await boot({ refreshError: true });
  env.window.CGI_AUTH = null;
  env.document.getElementById('memberGoogleBtn').dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(env.message(), /인증 모듈/);
});

test('returning from Google re-opens the console over the member session and offers logout', async () => {
  const env = await boot({ session: ADMIN });
  assert.equal(env.quotesCalls().length, 1, 'the cookie session alone must load the console');
  assert.equal(env.document.getElementById('authBox').hidden, true);
  assert.equal(env.document.getElementById('logoutBtn').hidden, false, 'a signed-in operator needs a way out');
  const quotes = env.quotesCalls()[0];
  assert.equal(quotes.init.credentials, 'include');
  assert.equal(quotes.init.headers.Authorization, undefined, 'no manual cgiAdminToken is involved');
});

test('logging out drops the session and wipes the cached quote requests', async () => {
  const env = await boot({ session: ADMIN });
  const card = env.document.getElementById('requestList').querySelectorAll('button[data-open]')[0];
  card.dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.notEqual(env.document.getElementById('requestDetail').innerHTML, '', 'the detail panel holds customer PII');

  const logoutBtn = env.document.getElementById('logoutBtn');
  assert.equal(logoutBtn.dispatch('click'), 1, '#logoutBtn has no click handler');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(env.authCalls.filter((c) => c.kind === 'logout').length, 1);
  assert.equal(env.storage.getItem('cgiAdminToken'), null);
  assert.equal(env.document.getElementById('authBox').hidden, false, 'logout must bring the login form back');
  assert.equal(logoutBtn.hidden, true);
  assert.deepEqual(JSON.parse(env.storage.getItem('cgiQuoteRequests')), [], 'customer PII may not survive in the cache');
  assert.equal(env.document.getElementById('requestDetail').innerHTML, '', 'an open detail must not stay on screen');
  assert.doesNotMatch(env.document.getElementById('requestList').innerHTML, /강사장|CGI/);

  const detailCalls = env.fetches.filter((f) => /\/api\/quotes\//.test(f.url)).length;
  assert.equal(detailCalls, 1, 'only the pre-logout click may have read a detail');
});

test('a signed-out operator sees no logout button', async () => {
  const env = await boot({ refreshError: true, session: null });
  assert.equal(env.document.getElementById('logoutBtn').hidden, true);
});

