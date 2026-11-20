import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createErpOapiClient } from '../lib/erp-oapi.mjs';

export const DEFAULT_LIMIT = 20;
export const DEFAULT_LEDGER_NAME = 'ecount-relay-ledger.jsonl';
const POLL_MS = 30_000;

export function parseArgs(argv = []) {
  const options = { envFile: null, ledger: null, once: false, dryRun: false, confirmProd: false, limit: DEFAULT_LIMIT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg === '--once') options.once = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--confirm-prod') options.confirmProd = true;
    else if (arg === '--env') { options.envFile = argv[++index]; }
    else if (arg === '--ledger') { options.ledger = argv[++index]; }
    else if (arg === '--limit') { options.limit = Number(argv[++index]); }
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.envFile) throw new Error('--env is required');
  if (!Number.isInteger(options.limit) || options.limit <= 0) throw new Error('--limit must be a positive integer');
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

export function isUnknownTransmissionError(error) {
  const code = String(error?.code || '');
  if (!code) return true;
  if (code === 'body_unparseable' || code === 'envelope_unparseable') return true;
  if (/^(fetch|network|timeout|econn|socket|abort)/i.test(code)) return true;
  return false;
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
  if (!['test', 'prod'].includes(target)) return { blocked: true, sent: 0, failed: 0, dry: 0, reposted: 0, unknown: 0 };
  if (target === 'prod' && !options.confirmProd) {
    log('prod target requires --confirm-prod; nothing sent');
    return { blocked: true, sent: 0, failed: 0, dry: 0, reposted: 0, unknown: 0 };
  }

  const base = String(env.WORKER_BASE || '').replace(/\/+$/, '');
  const token = String(env.ERP_RELAY_TOKEN || '');
  const client = options.dryRun ? null : createErpOapiClient({
    env: { ...env, ERP_MODE: 'live', ERP_LIVE_WRITE: 'YES' },
    fetchFn,
    now,
    sleep,
  });
  if (client && !client.configured) {
    log('missing ECOUNT credentials; nothing sent');
    return { blocked: true, sent: 0, failed: 0, dry: 0, reposted: 0, unknown: 0 };
  }

  let sent = 0;
  let failed = 0;
  let dry = 0;
  let reposted = 0;
  let unknown = 0;
  for (;;) {
    const ledgerMap = ledgerByDedupe(ledger.read());
    const outbox = await fetchOutbox({ base, token, limit: options.limit || DEFAULT_LIMIT, dryRun: options.dryRun, fetchFn });
    for (const item of outbox.items || []) {
      if (options.dryRun) {
        log(`order ${item.order_id}: DRY body=${JSON.stringify(item.body)}`);
        dry += 1;
        continue;
      }
      const ledgerKey = String(item.dedupe_key || `id:${item.id}`);
      const prior = ledgerMap.get(ledgerKey);
      if (prior?.state === 'sent') {
        log(`order ${item.order_id}: ALREADY_SENT ledger state=sent; re-reporting result`);
        try {
          await postResult({ base, token, id: item.id, result: { ok: true, slipNo: prior.slipNo || null }, fetchFn });
          reposted += 1;
        } catch {
          log(`order ${item.order_id}: RESULT_REPORT_FAILED`);
        }
        continue;
      }
      if (prior && ['sending', 'unknown'].includes(prior.state)) {
        log(`order ${item.order_id}: UNKNOWN 확인 필요 (ledger state=${prior.state})`);
        unknown += 1;
        continue;
      }
      const started = { id: item.id, order_id: item.order_id, dedupe_key: ledgerKey, at: stamp(), state: 'sending' };
      ledger.append(started);
      ledgerMap.set(ledgerKey, started);
      let outcome;
      let slipNo = null;
      try {
        if (!client.sessionId) await client.bootstrap();
        let response;
        try {
          response = await client.call('saveSaleOrder', item.body);
        } catch (error) {
          if (error?.code === 'session_invalid' || error?.reauthAvailable === true) {
            await client.bootstrap();
            response = await client.call('saveSaleOrder', item.body);
          } else throw error;
        }
        slipNo = Array.isArray(response?.slipNos) ? (response.slipNos[0] || null) : null;
        outcome = { ...started, at: stamp(), state: 'sent', slipNo };
      } catch (error) {
        const code = String(error?.code || 'relay_error').slice(0, 80);
        const message = redactSecrets(String(error?.message || error), secrets).slice(0, 300);
        const uncertain = isUnknownTransmissionError(error);
        outcome = { ...started, at: stamp(), state: uncertain ? 'unknown' : 'rejected' };
        ledger.append(outcome);
        ledgerMap.set(ledgerKey, outcome);
        try {
          await postResult({
            base,
            token,
            id: item.id,
            result: { ok: false, ...(uncertain ? { unknown: true } : {}), error: `${code}: ${message}` },
            fetchFn,
          });
        } catch {
          log(`order ${item.order_id}: RESULT_REPORT_FAILED`);
        }
        log(`order ${item.order_id}: ${uncertain ? 'UNKNOWN' : 'FAIL'} ${code}: ${message}`);
        if (uncertain) unknown += 1;
        else failed += 1;
        continue;
      }
      ledger.append(outcome);
      ledgerMap.set(ledgerKey, outcome);
      try {
        await postResult({ base, token, id: item.id, result: { ok: true, slipNo }, fetchFn });
        log(`order ${item.order_id}: OK slip=${slipNo || '-'}`);
        sent += 1;
      } catch {
        log(`order ${item.order_id}: RESULT_REPORT_FAILED ledger=state:sent; result will be re-reported`);
      }
    }
    for (const held of outbox.held || []) {
      log(`order ${held.order_id}: HELD ${held.reason} product_ids=${(held.product_ids || []).join(',')}`);
    }
    if (options.once) break;
    if (!(outbox.items || []).length) await sleep(POLL_MS);
  }
  return { blocked: false, sent, failed, dry, reposted, unknown };
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
