import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs, readEnvFile, redactSecrets, runRelay } from '../../tools/ecount-relay.mjs';

const ENV = {
  ECOUNT_COM_CODE: 'FAKE-COM-DO-NOT-PRINT',
  ECOUNT_USER_ID: 'FAKE-USER-DO-NOT-PRINT',
  ECOUNT_API_CERT_KEY: 'FAKE-CERT-DO-NOT-PRINT',
  ECOUNT_TARGET: 'test',
  WORKER_BASE: 'http://worker.local',
  ERP_RELAY_TOKEN: 'FAKE-RELAY-DO-NOT-PRINT',
};

function outboxItem(id, orderId) {
  return {
    id,
    order_id: orderId,
    attempts: 0,
    cust: 'ONLINE01',
    wh_cd: '100',
    lines: [{ product_id: 'P-1', prod_cd: 'EC-A001', qty: 1, unit_price: 1000, note: '' }],
    body: {
      SaleOrderList: [{
        BulkDatas: { UPLOAD_SER_NO: '1', CUST: 'ONLINE01', WH_CD: '100', PROD_CD: 'EC-A001', QTY: '1', PRICE: '1000' },
      }],
    },
    note: 'relay outbox',
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeFetch({ items = [], held = [], saveHandler = () => response({ Status: '200', Data: { SlipNos: '["SLIP-1"]', SuccessCnt: 1, FailCnt: 0 } }), onResult = () => {}, now = () => 0 } = {}) {
  const calls = [];
  const state = { logins: 0, saves: [], saveTimes: [] };
  const fetchFn = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed.toString(), path: parsed.pathname, method: init.method || 'GET', init });
    if (parsed.pathname === '/api/erp/outbox') return response({ items, held });
    if (parsed.pathname.endsWith('/result')) {
      onResult(JSON.parse(init.body), parsed.pathname);
      return response({ ok: true });
    }
    if (parsed.pathname === '/OAPI/V2/Zone') return response({ Status: '200', Data: { ZONE: 'FAKE', DOMAIN: '.ecount.com' } });
    if (parsed.pathname === '/OAPI/V2/OAPILogin') {
      state.logins += 1;
      return response({ Status: '200', Data: { Datas: { SESSION_ID: 'FAKE-SESSION' } } });
    }
    if (parsed.pathname === '/OAPI/V2/SaleOrder/SaveSaleOrder') {
      state.saves.push(JSON.parse(init.body));
      state.saveTimes.push(now());
      return saveHandler(state.saves.length);
    }
    throw new Error(`unexpected fetch ${parsed.pathname}`);
  };
  return { fetchFn, calls, state };
}

test('argument parsing and env-file loading handle the documented flags and names only', () => {
  const args = parseArgs(['--env', 'relay.env', '--once', '--dry-run', '--limit', '3', '--confirm-prod']);
  assert.equal(args.envFile, 'relay.env');
  assert.equal(args.once, true);
  assert.equal(args.dryRun, true);
  assert.equal(args.confirmProd, true);
  assert.equal(args.limit, 3);
  assert.throws(() => parseArgs([]), /--env is required/);
  assert.throws(() => parseArgs(['--env', 'f', '--limit', '0']), /positive integer/);
  const values = readEnvFile('# comment\nECOUNT_COM_CODE=abc\nexport WORKER_BASE="http://worker.local"\n\nECOUNT_TARGET=prod\n');
  assert.deepEqual(values, {
    ECOUNT_COM_CODE: 'abc',
    WORKER_BASE: 'http://worker.local',
    ECOUNT_TARGET: 'prod',
  });
  assert.equal(redactSecrets('x FAKE-CERT-DO-NOT-PRINT y', [ENV.ECOUNT_API_CERT_KEY]), 'x [REDACTED] y');
});

test('dry run prints the body without contacting ECOUNT or leaking secrets', async () => {
  const lines = [];
  const { fetchFn, calls } = fakeFetch({ items: [outboxItem(1, 'ORD-DRY')] });
  const summary = await runRelay({ env: ENV, once: true, dryRun: true, limit: 5 }, {
    fetchFn,
    log: (message) => lines.push(message),
    now: () => 0,
    sleep: async () => {},
  });
  assert.equal(summary.dry, 1);
  assert.equal(summary.sent, 0);
  assert.ok(calls[0].url.includes('dry=1'));
  assert.equal(calls.filter((call) => call.url.includes('/OAPI/')).length, 0);
  const output = lines.join('\n');
  assert.match(output, /ORD-DRY/);
  assert.match(output, /EC-A001/);
  assert.equal(output.includes(ENV.ECOUNT_API_CERT_KEY), false);
  assert.equal(output.includes(ENV.ERP_RELAY_TOKEN), false);
  assert.equal(output.includes(ENV.ECOUNT_COM_CODE), false);
});

test('one login is reused across orders and each result reports its slip number', async () => {
  const results = [];
  const lines = [];
  const { fetchFn, calls, state } = fakeFetch({
    items: [outboxItem(1, 'ORD-1'), outboxItem(2, 'ORD-2')],
    onResult: (result) => results.push(result),
  });
  const summary = await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, {
    fetchFn,
    log: (message) => lines.push(message),
    now: () => 0,
    sleep: async () => {},
  });
  assert.equal(summary.sent, 2);
  assert.equal(state.logins, 1, 'session is reused; login is not repeated per order');
  assert.equal(state.saves.length, 2);
  assert.deepEqual(results, [
    { ok: true, slipNo: 'SLIP-1' },
    { ok: true, slipNo: 'SLIP-1' },
  ]);
  assert.match(lines.join('\n'), /ORD-1: OK slip=SLIP-1/);
  assert.equal(lines.join('\n').includes(ENV.ERP_RELAY_TOKEN), false);
  assert.equal(calls.filter((call) => call.path.endsWith('/result')).length, 2);
  assert.equal(calls[0].init.headers['X-ERP-Relay-Token'], ENV.ERP_RELAY_TOKEN);
  assert.equal(calls.find((call) => call.path.endsWith('/result')).init.headers['X-ERP-Relay-Token'], ENV.ERP_RELAY_TOKEN);
});

test('an expired session triggers one fresh login before the retry succeeds', async () => {
  const results = [];
  const { fetchFn, state } = fakeFetch({
    items: [outboxItem(1, 'ORD-SESSION')],
    onResult: (result) => results.push(result),
    saveHandler: (count) => count === 1
      ? response({ Error: { Code: 'EXP00001', Message: 'Please login.' } }, 500)
      : response({ Status: '200', Data: { SlipNos: '["SLIP-9"]', SuccessCnt: 1, FailCnt: 0 } }),
  });
  const summary = await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, {
    fetchFn,
    log: () => {},
    now: () => 0,
    sleep: async () => {},
  });
  assert.equal(summary.sent, 1);
  assert.equal(state.logins, 2);
  assert.equal(state.saves.length, 2);
  assert.deepEqual(results, [{ ok: true, slipNo: 'SLIP-9' }]);
});

test('an injected clock proves consecutive saves are ten seconds apart', async () => {
  let time = 1_700_000_000_000;
  const sleeps = [];
  const { fetchFn, state } = fakeFetch({
    items: [outboxItem(1, 'ORD-T1'), outboxItem(2, 'ORD-T2')],
    now: () => time,
  });
  await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, {
    fetchFn,
    log: () => {},
    now: () => time,
    sleep: async (ms) => { sleeps.push(ms); time += ms; },
  });
  assert.equal(state.saveTimes.length, 2);
  assert.ok(state.saveTimes[1] - state.saveTimes[0] >= 10_000, 'save interval is at least 10s');
  assert.ok(sleeps.includes(10_000));
});

test('a vendor error is reported as a failure with a redacted message', async () => {
  const results = [];
  const lines = [];
  const { fetchFn } = fakeFetch({
    items: [outboxItem(1, 'ORD-FAIL')],
    onResult: (result) => results.push(result),
    saveHandler: () => response({ Status: '200', Error: { Code: 'E001', Message: `${ENV.ECOUNT_COM_CODE} bad row` } }),
  });
  const summary = await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, {
    fetchFn,
    log: (message) => lines.push(message),
    now: () => 0,
    sleep: async () => {},
  });
  assert.equal(summary.failed, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /api_error/);
  assert.match(lines.join('\n'), /ORD-FAIL: FAIL/);
  assert.equal(lines.join('\n').includes(ENV.ECOUNT_COM_CODE), false, 'secrets are redacted from failure logs');
});

test('prod target is refused without --confirm-prod and announced when allowed', async () => {
  const prodEnv = { ...ENV, ECOUNT_TARGET: 'prod' };
  const refusedLines = [];
  const refusedFetch = async () => { throw new Error('must not fetch'); };
  const blocked = await runRelay({ env: prodEnv, once: true, dryRun: false }, {
    fetchFn: refusedFetch,
    log: (message) => refusedLines.push(message),
    now: () => 0,
    sleep: async () => {},
  });
  assert.equal(blocked.blocked, true);
  assert.equal(refusedLines[0], 'target: PROD');
  assert.match(refusedLines.join('\n'), /--confirm-prod/);

  const allowedLines = [];
  const { fetchFn } = fakeFetch({ items: [] });
  const allowed = await runRelay({ env: prodEnv, once: true, dryRun: false, confirmProd: true }, {
    fetchFn,
    log: (message) => allowedLines.push(message),
    now: () => 0,
    sleep: async () => {},
  });
  assert.equal(allowed.blocked, false);
  assert.equal(allowedLines[0], 'target: PROD');
});
