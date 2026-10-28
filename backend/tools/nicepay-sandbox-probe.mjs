// Sandbox reachability probe — exactly one read-only 거래조회 call.
//
// Why this exists: the offline contract tests prove the protocol layer, but they
// cannot prove that a freshly issued TEST-store key pair is accepted by
// sandbox-api.nicepay.co.kr. GET /v1/payments/find/{orderId} is a lookup: it
// creates nothing, moves no money, and its response tells us whether our Basic
// credentials authenticate. An unknown orderId is intentional — the answer we
// want is "authenticated, no such transaction", not a real payment.
//
// Nothing printed here can contain a credential: the response body is reduced to
// its result code, and the Authorization header is never echoed.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { basicAuth, niceApiBase, querySignature } from '../lib/pg-nicepay.mjs';
import { NICEPAY_ENV_OPERATING, resolveNicepayEnv } from '../lib/pg-nicepay-env.mjs';

const AUTH_REJECTED = new Set([401, 403]);

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

function isoEdiDate(now) {
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export async function runSandboxProbe({
  envVars = {},
  fetchFn = fetch,
  argv = [],
  now = new Date(),
  orderId = null,
} = {}) {
  const config = resolveNicepayEnv({ ...envVars, ...(arg(argv, '--environment') ? { PG_NICEPAY_ENV: arg(argv, '--environment') } : {}) });
  if (!config || config.ok !== true) {
    return {
      verdict: 'CONFIG_REFUSED',
      reason: config ? config.reason : 'no-config',
      environment: config ? config.environment : null,
      missing: config ? config.missing || [] : [],
      calls: 0,
    };
  }
  // An operating-store probe needs its own explicit flag: this tool must never
  // reach the money-carrying host by inheriting a default.
  if (config.environment === NICEPAY_ENV_OPERATING && !argv.includes('--allow-operating')) {
    return { verdict: 'OPERATING_BLOCKED', environment: config.environment, mode: config.mode, calls: 0 };
  }

  const probeOrderId = orderId || `CGI-SANDBOX-PROBE-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const pad = (n) => String(n).padStart(2, '0');
  const orderDate = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const ediDate = isoEdiDate(now);
  const query = new URLSearchParams({ orderDate, ediDate });
  const signData = querySignature({ tid: probeOrderId, ediDate, secretKey: config.secretKey });
  if (signData) query.set('signData', signData);

  const url = `${niceApiBase(config.mode)}/payments/find/${encodeURIComponent(probeOrderId)}?${query}`;
  const calls = [];
  let response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: basicAuth({ shopId: config.clientId, secretKey: config.secretKey }),
        'Content-Type': 'application/json;charset=utf-8',
        Accept: 'application/json',
      },
      cache: 'no-store',
    });
    calls.push(url);
  } catch (error) {
    return { verdict: 'NETWORK_UNAVAILABLE', errorClass: String(error && error.name ? error.name : 'unknown'), environment: config.environment, mode: config.mode, calls: calls.length };
  }

  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  const resultCode = payload && (payload.resultCode ?? payload.result_code ?? payload.code);
  const status = response.status;
  const verdict = AUTH_REJECTED.has(status)
    ? 'AUTH_REJECTED'
    : status >= 200 && status < 300
      ? 'AUTH_OK_TRANSACTION_RETURNED'
      : 'AUTH_OK_NO_SUCH_TRANSACTION';

  return {
    verdict,
    environment: config.environment,
    mode: config.mode,
    apiHost: new URL(url).host,
    httpStatus: status,
    resultCode: resultCode === undefined ? null : String(resultCode),
    responseHadBody: payload !== null,
    // shape only — a real transaction would be reported as lengths, never values
    fields: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 12).map((k) => `${k}:${payload[k] === null ? 'null' : typeof payload[k]}`) : [],
    calls: calls.length,
    credentialEchoed: false,
  };
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) {
  const result = await runSandboxProbe({ envVars: process.env, argv: process.argv.slice(2) });
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.verdict === 'AUTH_REJECTED' || result.verdict === 'CONFIG_REFUSED' || result.verdict === 'NETWORK_UNAVAILABLE' || result.verdict === 'OPERATING_BLOCKED' ? 1 : 0;
}
