import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createErpOapiClient } from '../lib/erp-oapi.mjs';

export const DEFAULT_LIMIT = 20;
export const DEFAULT_LEDGER_NAME = 'ecount-relay-ledger.jsonl';
export const SEND_TIMEOUT_MS = 60_000;
export const RATE_LIMIT_WAIT_MS = 600_000;
const POLL_MS = 30_000;

// 장부 상태
//   sending  : SaveSaleOrder 를 보내기 직전에 기록. 다음 기록이 없으면 결과를 모르는 것.
//   sent     : 이카운트가 전표번호를 돌려줌. 같은 dedupe_key 는 다시 보내지 않고 결과만 재회신.
//   unknown  : 응답을 못 받았거나 해석할 수 없음(들어갔을 수 있음). 사람이 확인하기 전엔 보내지 않음.
//   rejected : 이카운트가 명확히 거절(전표 미생성). 다음 주기에 다시 보낼 수 있음.
//   deferred : 이카운트가 처리하지 않은 것이 확실함(rate_limited·세션 만료). 다음 주기에 다시 보냄.
const BLOCKING_STATES = new Set(['sending', 'unknown']);

export function parseArgs(argv = []) {
  const options = { envFile: null, ledger: null, once: false, dryRun: false, confirmProd: false, limit: DEFAULT_LIMIT, markSent: null, slip: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg === '--once') options.once = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--confirm-prod') options.confirmProd = true;
    else if (arg === '--env') { options.envFile = argv[++index]; }
    else if (arg === '--ledger') { options.ledger = argv[++index]; }
    else if (arg === '--limit') { options.limit = Number(argv[++index]); }
    else if (arg === '--mark-sent') { options.markSent = Number(argv[++index]); }
    else if (arg === '--slip') { options.slip = String(argv[++index] ?? '').trim() || null; }
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.envFile) throw new Error('--env is required');
  if (!Number.isInteger(options.limit) || options.limit <= 0) throw new Error('--limit must be a positive integer');
  if (options.markSent !== null && (!Number.isInteger(options.markSent) || options.markSent <= 0)) throw new Error('--mark-sent needs an erp_sync id');
  return options;
}

export function defaultLedgerPath(envFilePath) {
  return join(dirname(resolve(String(envFilePath || 'ecount-relay.env'))), DEFAULT_LEDGER_NAME);
}

export function createFileLedger(filePath) {
  return {
    path: filePath,
    read() {
      let source;
      try { source = readFileSync(filePath, 'utf8'); }
      catch { return []; }
      const entries = [];
      for (const line of source.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry && typeof entry === 'object' && !Array.isArray(entry)) entries.push(entry);
        } catch {
          continue;
        }
      }
      return entries;
    },
    append(entry) {
      appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    },
  };
}

export function ledgerByDedupe(entries) {
  const map = new Map();
  for (const entry of entries || []) {
    const key = String(entry?.dedupe_key || entry?.id || '');
    if (key) map.set(key, entry);
  }
  return map;
}

// 이카운트가 요청을 처리하지 않은 것이 확실한 코드: 다시 보내도 중복이 생기지 않는다.
const NOT_PROCESSED_CODES = new Set([
  'rate_limited', 'session_invalid', 'http_404_path_absent',
  'stopped', 'disabled', 'not_configured', 'unknown_endpoint',
  'zone_failed', 'login_failed', 'login_no_session',
]);
// 이카운트가 요청을 받아 명확히 거절한 코드(전표가 생기지 않음).
const REJECTED_CODES = new Set(['api_error']);

/**
 * SaveSaleOrder 실패를 세 갈래로 나눈다.
 *   'deferred' — 처리되지 않았음이 확실(다음 주기 재전송 가능)
 *   'rejected' — 이카운트가 명확히 거절
 *   'unknown'  — 들어갔을 수 있음(응답 없음·시간 초과·5xx·해석 불가·일부 행 성공)
 * 모르는 코드는 unknown 으로 둔다: 중복 전표는 지울 수 없으므로 사람이 확인하는 쪽이 안전하다.
 */
export function classifySendError(error) {
  const code = String(error?.code || '');
  if (!code) return 'unknown';
  if (error?.reauthAvailable === true || NOT_PROCESSED_CODES.has(code)) return 'deferred';
  if (REJECTED_CODES.has(code) || /^status_\d+$/.test(code)) return 'rejected';
  if (code === 'row_failures') {
    const rows = Array.isArray(error?.rows) ? error.rows : [];
    return rows.some((row) => row && row.IsSuccess === true) ? 'unknown' : 'rejected';
  }
  return 'unknown';
}

export function isUnknownTransmissionError(error) {
  return classifySendError(error) === 'unknown';
}

function withTimeout(fetchFn, timeoutMs) {
  return (url, init = {}) => {
    if (init.signal || !timeoutMs || typeof AbortSignal?.timeout !== 'function') return fetchFn(url, init);
    return fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  };
}

export function readEnvFile(source) {
  const values = {};
  for (const line of String(source || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim().replace(/^export\s+/, '');
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function redactSecrets(text, secrets = []) {
  let output = String(text ?? '');
  for (const secret of secrets) {
    const value = String(secret ?? '');
    if (value.length >= 4) output = output.split(value).join('[REDACTED]');
  }
  return output;
}

async function fetchOutbox({ base, token, limit, dryRun, fetchFn }) {
  const url = new URL(`${base}/api/erp/outbox`);
  url.searchParams.set('limit', String(limit));
  if (dryRun) url.searchParams.set('dry', '1');
  const response = await fetchFn(url.toString(), {
    method: 'GET',
    headers: { 'X-ERP-Relay-Token': token },
  });
  if (!response.ok) throw new Error(`outbox_http_${response.status}`);
  return response.json();
}

async function postResult({ base, token, id, result, fetchFn }) {
  const response = await fetchFn(`${base}/api/erp/outbox/${encodeURIComponent(id)}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ERP-Relay-Token': token },
    body: JSON.stringify(result),
  });
  if (!response.ok) throw new Error(`result_http_${response.status}`);
  return response.json();
}

export async function runRelay(options, deps = {}) {
  const log = deps.log || console.log;
  const fetchFn = deps.fetchFn || fetch;
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const ledger = deps.ledger || createFileLedger(options.ledger || defaultLedgerPath(options.envFile));
  const env = options.env || {};
  const target = String(env.ECOUNT_TARGET || 'test').trim().toLowerCase();
  const secrets = [env.ECOUNT_COM_CODE, env.ECOUNT_USER_ID, env.ECOUNT_API_CERT_KEY, env.ERP_RELAY_TOKEN];
  const stamp = () => new Date(now()).toISOString();

  log(`target: ${target === 'prod' ? 'PROD' : target === 'test' ? 'TEST' : 'UNKNOWN'}`);
  if (!['test', 'prod'].includes(target)) return { blocked: true, sent: 0, failed: 0, dry: 0, reposted: 0, unknown: 0, deferred: 0 };
  if (target === 'prod' && !options.confirmProd) {
    log('prod target requires --confirm-prod; nothing sent');
    return { blocked: true, sent: 0, failed: 0, dry: 0, reposted: 0, unknown: 0, deferred: 0 };
  }

  const base = String(env.WORKER_BASE || '').replace(/\/+$/, '');
  const token = String(env.ERP_RELAY_TOKEN || '');
  const client = options.dryRun ? null : createErpOapiClient({
    env: { ...env, ERP_MODE: 'live', ERP_LIVE_WRITE: 'YES' },
    fetchFn: withTimeout(fetchFn, options.timeoutMs ?? SEND_TIMEOUT_MS),
    now,
    sleep,
  });
  if (client && !client.configured) {
    log('missing ECOUNT credentials; nothing sent');
    return { blocked: true, sent: 0, failed: 0, dry: 0, reposted: 0, unknown: 0, deferred: 0 };
  }

  const counts = { sent: 0, failed: 0, dry: 0, reposted: 0, unknown: 0, deferred: 0 };
  const report = async (item, result) => {
    try {
      await postResult({ base, token, id: item.id, result, fetchFn });
      return true;
    } catch {
      log(`order ${item.order_id}: RESULT_REPORT_FAILED`);
      return false;
    }
  };
  const clean = (error) => {
    const code = String(error?.code || 'relay_error').slice(0, 80);
    const message = redactSecrets(String(error?.message || error), secrets).slice(0, 300);
    return { code, text: `${code}: ${message}` };
  };
  // 보내지 않은 항목을 claim 에서 풀어 준다(시도 횟수 쓰지 않음).
  const release = async (items, reason) => {
    for (const rest of items) {
      await report(rest, { ok: false, pending: true, error: reason });
      log(`order ${rest.order_id}: DEFERRED ${reason}`);
      counts.deferred += 1;
    }
  };

  for (;;) {
    const ledgerMap = ledgerByDedupe(ledger.read());
    const outbox = await fetchOutbox({ base, token, limit: options.limit || DEFAULT_LIMIT, dryRun: options.dryRun, fetchFn });
    const queue = [...(outbox.items || [])];
    let pause = 0;
    while (queue.length) {
      const item = queue.shift();
      if (options.dryRun) {
        log(`order ${item.order_id}: DRY body=${JSON.stringify(item.body)}`);
        counts.dry += 1;
        continue;
      }
      const ledgerKey = String(item.dedupe_key || `id:${item.id}`);
      const retryGen = Number(item.retry_gen || 0) || 0;
      const prior = ledgerMap.get(ledgerKey);
      if (prior?.state === 'sent') {
        log(`order ${item.order_id}: ALREADY_SENT ledger state=sent; re-reporting result`);
        if (await report(item, { ok: true, slipNo: prior.slipNo || null })) counts.reposted += 1;
        continue;
      }
      if (prior && BLOCKING_STATES.has(prior.state)) {
        if (retryGen > (Number(prior.retry_gen || 0) || 0)) {
          log(`order ${item.order_id}: OPERATOR_RETRY ledger state=${prior.state} retry_gen=${retryGen}; sending once`);
        } else {
          log(`order ${item.order_id}: UNKNOWN 확인 필요 (ledger state=${prior.state})`);
          counts.unknown += 1;
          continue;
        }
      }

      // 로그인은 sending 기록 전에: 여기서 실패하면 아무것도 보내지 않은 것이다.
      if (!client.sessionId) {
        try {
          await client.bootstrap();
        } catch (error) {
          const { text } = clean(error);
          log(`login failed; nothing sent: ${text}`);
          await release([item, ...queue], text);
          queue.length = 0;
          pause = POLL_MS;
          break;
        }
      }

      const record = (state, extra = {}) => {
        const entry = { id: item.id, order_id: item.order_id, dedupe_key: ledgerKey, retry_gen: retryGen, at: stamp(), state, ...extra };
        ledger.append(entry);
        ledgerMap.set(ledgerKey, entry);
        return entry;
      };
      record('sending');

      let response = null;
      let failure = null;
      try {
        response = await client.call('saveSaleOrder', item.body);
      } catch (error) {
        failure = error;
      }
      // 즉시 재전송은 세션 만료만: 재로그인 후 한 번.
      if (failure && classifySendError(failure) === 'deferred' && (failure.code === 'session_invalid' || failure.reauthAvailable === true)) {
        log(`order ${item.order_id}: session_invalid; re-login and resend once`);
        failure = null;
        try {
          await client.bootstrap();
          response = await client.call('saveSaleOrder', item.body);
        } catch (error) {
          failure = error;
        }
      }

      if (!failure) {
        const slipNo = Array.isArray(response?.slipNos) ? (response.slipNos[0] || null) : null;
        if (!slipNo) {
          // 성공처럼 보이지만 전표번호가 없다(예: JSON 이 아닌 200 응답). 들어갔는지 알 수 없다.
          record('unknown');
          await report(item, { ok: false, unknown: true, error: 'no_slip_no: response had no SlipNos' });
          log(`order ${item.order_id}: UNKNOWN no_slip_no`);
          counts.unknown += 1;
          continue;
        }
        record('sent', { slipNo });
        if (await report(item, { ok: true, slipNo })) {
          log(`order ${item.order_id}: OK slip=${slipNo}`);
          counts.sent += 1;
        } else {
          log(`order ${item.order_id}: ledger=state:sent; result will be re-reported`);
        }
        continue;
      }

      const kind = classifySendError(failure);
      const { code, text } = clean(failure);
      if (kind === 'deferred') {
        record('deferred', { code });
        await report(item, { ok: false, pending: true, error: text });
        log(`order ${item.order_id}: DEFERRED ${text}`);
        counts.deferred += 1;
        if (code === 'rate_limited') {
          // 한도 초과: 이번 주기에는 더 보내지 않는다. 남은 항목도 claim 을 풀고 다음 주기로.
          await release(queue, 'rate_limited: not sent this cycle');
          queue.length = 0;
          pause = Number(failure?.retryAfterMs) > 0 ? Number(failure.retryAfterMs) : RATE_LIMIT_WAIT_MS;
        } else if (client.stopped) {
          await release(queue, `stopped: ${code}`);
          queue.length = 0;
          pause = POLL_MS;
        }
        continue;
      }
      if (kind === 'unknown') {
        record('unknown', { code });
        await report(item, { ok: false, unknown: true, error: text });
        log(`order ${item.order_id}: UNKNOWN ${text}`);
        counts.unknown += 1;
        continue;
      }
      record('rejected', { code });
      await report(item, { ok: false, error: text });
      log(`order ${item.order_id}: FAIL ${text}`);
      counts.failed += 1;
    }
    for (const held of outbox.held || []) {
      log(`order ${held.order_id}: HELD ${held.reason} product_ids=${(held.product_ids || []).join(',')}`);
    }
    if (options.once) break;
    if (pause) await sleep(pause);
    else if (!(outbox.items || []).length) await sleep(POLL_MS);
  }
  return { blocked: false, ...counts };
}

/**
 * 운영자가 이카운트 판매조회에서 전표를 확인한 unknown 항목을 수동으로 성공 회신한다.
 * 장부에도 sent 로 남겨, 같은 주문을 다시 보내지 않게 한다.
 */
export async function markSent(options, deps = {}) {
  const log = deps.log || console.log;
  const fetchFn = deps.fetchFn || fetch;
  const now = deps.now || (() => Date.now());
  const ledger = deps.ledger || createFileLedger(options.ledger || defaultLedgerPath(options.envFile));
  const env = options.env || {};
  const base = String(env.WORKER_BASE || '').replace(/\/+$/, '');
  const token = String(env.ERP_RELAY_TOKEN || '');
  const id = options.markSent;
  const slipNo = options.slip || null;
  const last = [...ledger.read()].reverse().find((entry) => Number(entry.id) === id) || null;
  const result = await postResult({ base, token, id, result: { ok: true, slipNo }, fetchFn });
  ledger.append({
    id,
    order_id: last?.order_id ?? null,
    dedupe_key: last?.dedupe_key ?? `id:${id}`,
    retry_gen: last?.retry_gen ?? 0,
    at: new Date(now()).toISOString(),
    state: 'sent',
    slipNo,
    manual: true,
  });
  log(`erp_sync ${id}: MARKED_SENT slip=${slipNo || '-'} status=${result?.status || '-'}`);
  return result;
}

async function main() {
  let env = {};
  try {
    const args = parseArgs(process.argv.slice(2));
    env = readEnvFile(readFileSync(args.envFile, 'utf8'));
    const required = ['ECOUNT_COM_CODE', 'ECOUNT_USER_ID', 'ECOUNT_API_CERT_KEY', 'WORKER_BASE', 'ERP_RELAY_TOKEN'];
    const missing = required.filter((key) => !String(env[key] || '').trim());
    if (missing.length) {
      console.error(`missing env entries: ${missing.join(', ')}`);
      process.exitCode = 2;
      return;
    }
    if (args.markSent !== null) {
      await markSent({ ...args, env }, { log: console.log });
      return;
    }
    const summary = await runRelay({ ...args, env }, { log: console.log });
    if (summary.blocked) process.exitCode = 2;
  } catch (error) {
    const secrets = [env.ECOUNT_COM_CODE, env.ECOUNT_USER_ID, env.ECOUNT_API_CERT_KEY, env.ERP_RELAY_TOKEN];
    console.error(`relay_error: ${redactSecrets(String(error?.message || error), secrets)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
