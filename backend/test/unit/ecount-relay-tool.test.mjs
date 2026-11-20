import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import test from 'node:test';

import {
  parseArgs,
  defaultLedgerPath,
  createFileLedger,
  ledgerByDedupe,
  isUnknownTransmissionError,
  classifySendError,
  markSent,
  readEnvFile,
  redactSecrets,
  runRelay,
} from '../../tools/ecount-relay.mjs';

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
    dedupe_key: `dedupe:${orderId}`,
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

function memoryLedger(initial = []) {
  const entries = [...initial];
  return {
    entries,
    read: () => [...entries],
    append: (entry) => { entries.push({ ...entry }); },
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeFetch({ items = [], held = [], saveHandler = () => response({ Status: '200', Data: { SlipNos: '["SLIP-1"]', SuccessCnt: 1, FailCnt: 0 } }), onResult = () => {}, failResult = false, now = () => 0 } = {}) {
  const calls = [];
  const state = { logins: 0, saves: [], saveTimes: [], results: [] };
  const fetchFn = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed.toString(), path: parsed.pathname, method: init.method || 'GET', init });
    if (parsed.pathname === '/api/erp/outbox') return response({ items, held });
    if (parsed.pathname.endsWith('/result')) {
      const result = JSON.parse(init.body);
      state.results.push(result);
      onResult(result, parsed.pathname);
      if (failResult) return response({ error: 'result failed' }, 500);
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

function relayDeps(extra = {}) {
  return { ledger: memoryLedger(), log: () => {}, now: () => 0, sleep: async () => {}, ...extra };
}

test('argument parsing, ledger path and env-file loading handle the documented flags only', () => {
  const args = parseArgs(['--env', 'relay.env', '--ledger', 'ledger.jsonl', '--once', '--dry-run', '--limit', '3', '--confirm-prod']);
  assert.equal(args.envFile, 'relay.env');
  assert.equal(args.ledger, 'ledger.jsonl');
  assert.equal(args.once, true);
  assert.equal(args.dryRun, true);
  assert.equal(args.confirmProd, true);
  assert.equal(args.limit, 3);
  assert.throws(() => parseArgs([]), /--env is required/);
  assert.throws(() => parseArgs(['--env', 'f', '--limit', '0']), /positive integer/);
  assert.match(defaultLedgerPath('relay.env'), /ecount-relay-ledger\.jsonl$/);
  const values = readEnvFile('# comment\nECOUNT_COM_CODE=abc\nexport WORKER_BASE="http://worker.local"\n\nECOUNT_TARGET=prod\n');
  assert.deepEqual(values, {
    ECOUNT_COM_CODE: 'abc',
    WORKER_BASE: 'http://worker.local',
    ECOUNT_TARGET: 'prod',
  });
  assert.equal(redactSecrets('x FAKE-CERT-DO-NOT-PRINT y', [ENV.ECOUNT_API_CERT_KEY]), 'x [REDACTED] y');
});

test('the file ledger appends JSON lines and never stores secrets', () => {
  const filePath = join(tmpdir(), `ecount-relay-ledger-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  const ledger = createFileLedger(filePath);
  assert.deepEqual(ledger.read(), []);
  ledger.append({ id: 1, order_id: 'ORD-1', dedupe_key: 'D-1', at: '2026-11-18T00:00:00.000Z', state: 'sending' });
  ledger.append({ id: 1, order_id: 'ORD-1', dedupe_key: 'D-1', at: '2026-11-18T00:00:01.000Z', state: 'sent', slipNo: 'SLIP-1' });
  const entries = ledger.read();
  assert.equal(entries.length, 2);
  assert.deepEqual(ledgerByDedupe(entries).get('D-1').state, 'sent');
  const contents = JSON.stringify(entries);
  for (const secret of [ENV.ECOUNT_API_CERT_KEY, ENV.ERP_RELAY_TOKEN, ENV.ECOUNT_COM_CODE]) {
    assert.equal(contents.includes(secret), false);
  }
  unlinkSync(filePath);
});

test('a missing response body is uncertain, a rate limit is not', () => {
  assert.equal(isUnknownTransmissionError(new TypeError('fetch failed')), true);
  assert.equal(isUnknownTransmissionError({ code: 'body_unparseable' }), true);
  assert.equal(isUnknownTransmissionError({ code: 'envelope_unparseable' }), true);
  assert.equal(isUnknownTransmissionError({ code: 'rate_limited' }), false);
  assert.equal(isUnknownTransmissionError({ code: 'api_error' }), false);
  assert.equal(isUnknownTransmissionError({ code: 'session_invalid' }), false);
});

test('dry run prints the body without contacting ECOUNT or writing a ledger', async () => {
  const lines = [];
  const ledger = memoryLedger();
  const { fetchFn, calls } = fakeFetch({ items: [outboxItem(1, 'ORD-DRY')] });
  const summary = await runRelay({ env: ENV, once: true, dryRun: true, limit: 5 }, relayDeps({
    fetchFn,
    ledger,
    log: (message) => lines.push(message),
  }));
  assert.equal(summary.dry, 1);
  assert.equal(summary.sent, 0);
  assert.ok(calls[0].url.includes('dry=1'));
  assert.equal(calls.filter((call) => call.url.includes('/OAPI/')).length, 0);
  assert.deepEqual(ledger.entries, []);
  const output = lines.join('\n');
  assert.match(output, /ORD-DRY/);
  assert.match(output, /EC-A001/);
  assert.equal(output.includes(ENV.ECOUNT_API_CERT_KEY), false);
  assert.equal(output.includes(ENV.ERP_RELAY_TOKEN), false);
  assert.equal(output.includes(ENV.ECOUNT_COM_CODE), false);
});

test('one login is reused across orders and each result reports its slip number', async () => {
  const ledger = memoryLedger();
  const { fetchFn, calls, state } = fakeFetch({
    items: [outboxItem(1, 'ORD-1'), outboxItem(2, 'ORD-2')],
  });
  const summary = await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, relayDeps({ fetchFn, ledger }));
  assert.equal(summary.sent, 2);
  assert.equal(state.logins, 1, 'session is reused; login is not repeated per order');
  assert.equal(state.saves.length, 2);
  assert.deepEqual(state.results, [
    { ok: true, slipNo: 'SLIP-1' },
    { ok: true, slipNo: 'SLIP-1' },
  ]);
  assert.deepEqual(ledger.entries.map((entry) => entry.state), ['sending', 'sent', 'sending', 'sent']);
  assert.equal(JSON.stringify(ledger.entries).includes(ENV.ECOUNT_COM_CODE), false);
  assert.equal(calls.filter((call) => call.path.endsWith('/result')).length, 2);
  assert.equal(calls[0].init.headers['X-ERP-Relay-Token'], ENV.ERP_RELAY_TOKEN);
  assert.equal(calls.find((call) => call.path.endsWith('/result')).init.headers['X-ERP-Relay-Token'], ENV.ERP_RELAY_TOKEN);
});

test('session_invalid re-logs in once and still sends only one order', async () => {
  const ledger = memoryLedger();
  const { fetchFn, state } = fakeFetch({
    items: [outboxItem(1, 'ORD-SESSION')],
    saveHandler: (count) => count === 1
      ? response({ Error: { Code: 'EXP00001', Message: 'Please login.' } }, 500)
      : response({ Status: '200', Data: { SlipNos: '["SLIP-9"]', SuccessCnt: 1, FailCnt: 0 } }),
  });
  const summary = await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, relayDeps({ fetchFn, ledger }));
  assert.equal(summary.sent, 1);
  assert.equal(state.logins, 2);
  assert.equal(state.saves.length, 2);
  assert.equal(ledger.entries.at(-1).state, 'sent');
  assert.deepEqual(state.results, [{ ok: true, slipNo: 'SLIP-9' }]);
});

test('rate_limited is reported as pending, the rest of the batch is released unsent, and the next cycle sends', async () => {
  const ledger = memoryLedger();
  const sleeps = [];
  const first = fakeFetch({
    items: [outboxItem(1, 'ORD-RATE'), outboxItem(2, 'ORD-RATE-2')],
    saveHandler: () => response({ Status: '200', Error: { Code: 'LIMIT', Message: 'too many calls' } }, 412),
  });
  const summary = await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, relayDeps({
    fetchFn: first.fetchFn, ledger, sleep: async (ms) => { sleeps.push(ms); },
  }));
  assert.equal(summary.sent, 0);
  assert.equal(summary.failed, 0);
  assert.equal(summary.deferred, 2);
  assert.equal(first.state.saves.length, 1, 'rate_limited is never resent immediately, and the next order is not tried');
  assert.equal(first.state.results.length, 2);
  for (const result of first.state.results) {
    assert.equal(result.ok, false);
    assert.equal(result.pending, true);
    assert.equal(result.unknown, undefined);
  }
  assert.match(first.state.results[0].error, /rate_limited/);
  assert.deepEqual(ledger.entries.map((entry) => entry.state), ['sending', 'deferred'], 'the second order never reached the ledger');

  const second = fakeFetch({ items: [outboxItem(1, 'ORD-RATE'), outboxItem(2, 'ORD-RATE-2')] });
  const next = await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, relayDeps({ fetchFn: second.fetchFn, ledger }));
  assert.equal(next.sent, 2, 'a deferred order is sent on the next cycle');
  assert.equal(second.state.saves.length, 2);
});

test('rate_limited in loop mode waits the vendor window before the next poll', async () => {
  const sleeps = [];
  let polls = 0;
  const base = fakeFetch({
    items: [outboxItem(1, 'ORD-RATE-LOOP')],
    saveHandler: () => response({}, 412),
  });
  const fetchFn = async (url, init) => {
    if (new URL(String(url)).pathname === '/api/erp/outbox') {
      polls += 1;
      if (polls > 1) throw new Error('stop loop');
    }
    return base.fetchFn(url, init);
  };
  await assert.rejects(runRelay({ env: ENV, once: false, dryRun: false, limit: 5 }, relayDeps({
    fetchFn, sleep: async (ms) => { sleeps.push(ms); },
  })), /stop loop/);
  assert.ok(sleeps.includes(600_000), `sleeps=${sleeps}`);
  assert.equal(base.state.saves.length, 1);
});

test('a second session_invalid after re-login is deferred, never sent a third time', async () => {
  const ledger = memoryLedger();
  const { fetchFn, state } = fakeFetch({
    items: [outboxItem(1, 'ORD-SESSION-2')],
    saveHandler: () => response({ Error: { Code: 'EXP00001', Message: 'Please login.' } }, 500),
  });
  const summary = await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, relayDeps({ fetchFn, ledger }));
  assert.equal(state.saves.length, 2, 'one original send plus exactly one resend after re-login');
  assert.equal(state.logins, 2);
  assert.equal(summary.deferred, 1);
  assert.equal(state.results[0].pending, true);
  assert.equal(ledger.entries.at(-1).state, 'deferred');
});

test('a login failure sends nothing, writes no sending entry and releases every claimed order', async () => {
  const ledger = memoryLedger();
  const base = fakeFetch({ items: [outboxItem(1, 'ORD-L1'), outboxItem(2, 'ORD-L2')] });
  const fetchFn = async (url, init) => {
    if (new URL(String(url)).pathname === '/OAPI/V2/OAPILogin') {
      return response({ Status: '200', Error: { Code: 201, Message: 'login refused' } });
    }
    return base.fetchFn(url, init);
  };
  const summary = await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, relayDeps({ fetchFn, ledger }));
  assert.equal(base.state.saves.length, 0);
  assert.deepEqual(ledger.entries, []);
  assert.equal(summary.deferred, 2);
  assert.deepEqual(base.state.results.map((r) => r.pending), [true, true]);
});

test('server errors, partial row success, a missing slip number and a timeout are all unknown', async () => {
  const cases = [
    ['5xx', () => response({ Error: { Code: 'E500', Message: 'internal' } }, 503)],
    ['partial', () => response({ Status: '200', Data: {
      SuccessCnt: 1, FailCnt: 1, SlipNos: '[]',
      ResultDetails: JSON.stringify([{ IsSuccess: true }, { IsSuccess: false, TotalError: 'bad line' }]),
    } })],
    ['html200', () => new Response('<html>proxy</html>', { status: 200 })],
    ['timeout', () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }],
  ];
  for (const [name, saveHandler] of cases) {
    const ledger = memoryLedger();
    const first = fakeFetch({ items: [outboxItem(1, `ORD-${name}`)], saveHandler });
    const summary = await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, relayDeps({ fetchFn: first.fetchFn, ledger }));
    assert.equal(summary.unknown, 1, name);
    assert.equal(first.state.saves.length, 1, `${name}: no immediate resend`);
    assert.equal(first.state.results[0].unknown, true, name);
    assert.equal(ledger.entries.at(-1).state, 'unknown', name);
    const second = fakeFetch({ items: [outboxItem(1, `ORD-${name}`)] });
    await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, relayDeps({ fetchFn: second.fetchFn, ledger }));
    assert.equal(second.state.saves.length, 0, `${name}: not resent on the next run`);
  }
});

test('every SaveSaleOrder request carries a time limit', async () => {
  const signals = [];
  const base = fakeFetch({ items: [outboxItem(1, 'ORD-SIGNAL')] });
  const fetchFn = async (url, init = {}) => {
    if (String(url).includes('/OAPI/')) signals.push(init.signal);
    return base.fetchFn(url, init);
  };
  await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, relayDeps({ fetchFn }));
  assert.ok(signals.length >= 3);
  assert.ok(signals.every((signal) => signal && typeof signal.aborted === 'boolean'));
});

test('a fully rejected row set is rejected, not unknown', () => {
  assert.equal(classifySendError({ code: 'row_failures', rows: [{ IsSuccess: false }] }), 'rejected');
  assert.equal(classifySendError({ code: 'row_failures', rows: [{ IsSuccess: true }, { IsSuccess: false }] }), 'unknown');
  assert.equal(classifySendError({ code: 'status_500' }), 'rejected');
  assert.equal(classifySendError({ code: 'server_error' }), 'unknown');
  assert.equal(classifySendError({ code: 'rate_limited' }), 'deferred');
  assert.equal(classifySendError({ code: 'api_error', reauthAvailable: true }), 'deferred');
  assert.equal(classifySendError({ code: 'something_new' }), 'unknown');
  assert.equal(classifySendError(new TypeError('fetch failed')), 'unknown');
});

test('an operator retry (higher retry_gen) sends an unknown order exactly once', async () => {
  const ledger = memoryLedger([
    { id: 1, order_id: 'ORD-OP', dedupe_key: 'dedupe:ORD-OP', retry_gen: 0, at: 't0', state: 'sending' },
    { id: 1, order_id: 'ORD-OP', dedupe_key: 'dedupe:ORD-OP', retry_gen: 0, at: 't1', state: 'unknown' },
  ]);
  const same = fakeFetch({ items: [outboxItem(1, 'ORD-OP')] });
  await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, relayDeps({ fetchFn: same.fetchFn, ledger }));
  assert.equal(same.state.saves.length, 0, 'the same generation stays blocked');

  const retried = fakeFetch({
    items: [{ ...outboxItem(1, 'ORD-OP'), retry_gen: 1 }],
    saveHandler: () => { throw new TypeError('fetch failed'); },
  });
  await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, relayDeps({ fetchFn: retried.fetchFn, ledger }));
  assert.equal(retried.state.saves.length, 1, 'a higher retry_gen is sent once');
  assert.equal(ledger.entries.at(-1).retry_gen, 1);

  const again = fakeFetch({ items: [{ ...outboxItem(1, 'ORD-OP'), retry_gen: 1 }] });
  await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, relayDeps({ fetchFn: again.fetchFn, ledger }));
  assert.equal(again.state.saves.length, 0, 'that generation is blocked again after its own unknown');
});

test('--mark-sent reports a manual success and records sent in the ledger', async () => {
  const ledger = memoryLedger([
    { id: 7, order_id: 'ORD-M', dedupe_key: 'dedupe:ORD-M', retry_gen: 0, at: 't0', state: 'unknown' },
  ]);
  const { fetchFn, state } = fakeFetch();
  await markSent({ env: ENV, markSent: 7, slip: '20261120-3' }, { fetchFn, ledger, log: () => {}, now: () => 0 });
  assert.deepEqual(state.results, [{ ok: true, slipNo: '20261120-3' }]);
  assert.equal(ledger.entries.at(-1).state, 'sent');
  assert.equal(ledger.entries.at(-1).dedupe_key, 'dedupe:ORD-M');
  const next = fakeFetch({ items: [outboxItem(7, 'ORD-M')] });
  await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, relayDeps({ fetchFn: next.fetchFn, ledger }));
  assert.equal(next.state.saves.length, 0);
  assert.deepEqual(next.state.results, [{ ok: true, slipNo: '20261120-3' }]);
  assert.deepEqual(parseArgs(['--env', 'e', '--mark-sent', '7', '--slip', 'S']).markSent, 7);
  assert.throws(() => parseArgs(['--env', 'e', '--mark-sent', 'x']), /erp_sync id/);
});

test('an injected clock proves consecutive saves are ten seconds apart', async () => {
  let time = 1_700_000_000_000;
  const sleeps = [];
  const { fetchFn, state } = fakeFetch({ items: [outboxItem(1, 'ORD-T1'), outboxItem(2, 'ORD-T2')], now: () => time });
  await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, relayDeps({
    fetchFn,
    now: () => time,
    sleep: async (ms) => { sleeps.push(ms); time += ms; },
  }));
  assert.equal(state.saveTimes.length, 2);
  assert.ok(state.saveTimes[1] - state.saveTimes[0] >= 10_000);
  assert.ok(sleeps.includes(10_000));
});

test('a clear vendor rejection is reported as a retryable failure', async () => {
  const ledger = memoryLedger();
  const lines = [];
  const { fetchFn, state } = fakeFetch({
    items: [outboxItem(1, 'ORD-FAIL')],
    saveHandler: () => response({ Status: '200', Error: { Code: 'E001', Message: `${ENV.ECOUNT_COM_CODE} bad row` } }),
  });
  const summary = await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, relayDeps({
    fetchFn,
    ledger,
    log: (message) => lines.push(message),
  }));
  assert.equal(summary.failed, 1);
  assert.equal(summary.unknown, 0);
  assert.equal(ledger.entries.at(-1).state, 'rejected');
  assert.equal(state.results[0].ok, false);
  assert.equal(state.results[0].unknown, undefined);
  assert.match(state.results[0].error, /api_error/);
  assert.match(lines.join('\n'), /ORD-FAIL: FAIL/);
  assert.equal(lines.join('\n').includes(ENV.ECOUNT_COM_CODE), false);
});

test('a failed result report is repaired by re-reporting, never by re-sending', async () => {
  const ledger = memoryLedger();
  const first = fakeFetch({ items: [outboxItem(1, 'ORD-REPORT')], failResult: true });
  const firstSummary = await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, relayDeps({ fetchFn: first.fetchFn, ledger }));
  assert.equal(first.state.saves.length, 1);
  assert.equal(firstSummary.sent, 0, 'a failed result report is not counted as a send');
  assert.deepEqual(ledger.entries.map((entry) => entry.state), ['sending', 'sent']);

  const second = fakeFetch({ items: [outboxItem(1, 'ORD-REPORT')] });
  const secondSummary = await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, relayDeps({ fetchFn: second.fetchFn, ledger }));
  assert.equal(second.state.saves.length, 0, 'the already-sent dedupe key is never transmitted twice');
  assert.deepEqual(second.state.results, [{ ok: true, slipNo: 'SLIP-1' }]);
  assert.equal(secondSummary.reposted, 1);
  assert.equal(ledger.entries.length, 2);
});

test('a network error is reported unknown and is not re-sent on the next run', async () => {
  const ledger = memoryLedger();
  const lines = [];
  const first = fakeFetch({
    items: [outboxItem(1, 'ORD-NET')],
    saveHandler: () => { throw new TypeError('fetch failed'); },
  });
  const firstSummary = await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, relayDeps({
    fetchFn: first.fetchFn,
    ledger,
    log: (message) => lines.push(message),
  }));
  assert.equal(firstSummary.unknown, 1);
  assert.equal(firstSummary.sent, 0);
  assert.deepEqual(first.state.results, [{ ok: false, unknown: true, error: 'relay_error: fetch failed' }]);
  assert.equal(ledger.entries.at(-1).state, 'unknown');
  assert.match(lines.join('\n'), /ORD-NET: UNKNOWN relay_error/);

  const second = fakeFetch({ items: [outboxItem(1, 'ORD-NET')] });
  const secondLines = [];
  const secondSummary = await runRelay({ env: ENV, once: true, dryRun: false, limit: 5 }, relayDeps({
    fetchFn: second.fetchFn,
    ledger,
    log: (message) => secondLines.push(message),
  }));
  assert.equal(second.state.saves.length, 0);
  assert.deepEqual(second.state.results, []);
  assert.equal(secondSummary.unknown, 1);
  assert.match(secondLines.join('\n'), /ORD-NET: UNKNOWN 확인 필요/);
  assert.equal(JSON.stringify(ledger.entries).includes(ENV.ECOUNT_API_CERT_KEY), false);
});

test('prod target is refused without --confirm-prod and announced when allowed', async () => {
  const prodEnv = { ...ENV, ECOUNT_TARGET: 'prod' };
  const refusedLines = [];
  const refusedFetch = async () => { throw new Error('must not fetch'); };
  const blocked = await runRelay({ env: prodEnv, once: true, dryRun: false }, relayDeps({
    fetchFn: refusedFetch,
    log: (message) => refusedLines.push(message),
  }));
  assert.equal(blocked.blocked, true);
  assert.equal(refusedLines[0], 'target: PROD');
  assert.match(refusedLines.join('\n'), /--confirm-prod/);

  const allowedLines = [];
  const { fetchFn } = fakeFetch({ items: [] });
  const allowed = await runRelay({ env: prodEnv, once: true, dryRun: false, confirmProd: true }, relayDeps({
    fetchFn,
    log: (message) => allowedLines.push(message),
  }));
  assert.equal(allowed.blocked, false);
  assert.equal(allowedLines[0], 'target: PROD');
});
