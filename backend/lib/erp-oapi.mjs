// ecountOS Open API V2 transport — request/response contract as published by
// the vendor, not as invented locally.
//
// Contract facts this module encodes, each one verified against the official
// pages (transcribed in tmp/ecount-docs/) and cross-checked with credential-free
// live probes on the test host:
//   1. Bootstrap is two calls: POST /OAPI/V2/Zone {COM_CODE} then
//      POST /OAPI/V2/OAPILogin {COM_CODE,USER_ID,API_CERT_KEY,LAN_TYPE,ZONE}.
//      There is no password field — API_CERT_KEY is issued inside the ERP
//      (Self-Customizing > 정보관리 > API인증키발급).
//   2. SESSION_ID travels as a URL QUERY PARAMETER on every subsequent call.
//      There is no Authorization header anywhere in this API.
//   3. HTTP 200 and envelope Status "200" both fail to mean success. Failures
//      arrive as Status 200 + Error{Code,Message}, and as Status 200 +
//      SuccessCnt 0 / FailCnt N with per-row detail in Data.ResultDetails,
//      which is a JSON-ENCODED STRING, not an array.
//   4. Every endpoint carries its own minimum interval (1s / 10s / 10min), and
//      the envelope reports account-wide quotas in Data.QUANTITY_INFO
//      (consecutive errors per hour, calls per hour, calls per day).
//      Exceeding the server limit surfaces as HTTP 412 or a 302 redirect.
//   5. An unknown controller path returns HTTP 404 with
//      "No HTTP resource was found"; a known path without a session returns
//      HTTP 500 + EXP00001 "Please login.". That asymmetry is what proves a
//      path is real, so it is preserved verbatim instead of being flattened
//      into one error.
//
// Nothing in this module runs unless ERP_LIVE_WRITE=YES and ERP_MODE=live.
// ERP_MODE=mock may only point at a loopback host, so a test can never reach
// the vendor by accident.

export const ERP_OAPI_SYSTEM = 'ecount';
export const ERP_OAPI_CONTRACT = 'V2';
export const ERP_OAPI_ADAPTER_VERSION = '2.0.0';

/** Separator the vendor uses for multi-value PROD_CD / PROD_TYPE inputs. */
export const MULTI_VALUE_SEPARATOR = '∬';

/** Login codes that mean "stop, a human must act". Never retried. */
export const ERP_OAPI_STOP_CODES = new Set([21, 22, 23, 24, 25, 26, 27, 81, 82, 83, 84, 85, 89, 98, 99, 201, 204]);

export const ERP_OAPI_ENDPOINTS = {
  zone: { path: '/OAPI/V2/Zone', minIntervalMs: 10000, authed: false },
  login: { path: '/OAPI/V2/OAPILogin', minIntervalMs: 10000, authed: false },
  saveBasicCust: { path: '/OAPI/V2/AccountBasic/SaveBasicCust', minIntervalMs: 10000, authed: true, listKey: 'CustList' },
  saveBasicProduct: { path: '/OAPI/V2/InventoryBasic/SaveBasicProduct', minIntervalMs: 10000, authed: true, listKey: 'ProductList' },
  viewBasicProduct: { path: '/OAPI/V2/InventoryBasic/ViewBasicProduct', minIntervalMs: 1000, authed: true },
  getBasicProductsList: { path: '/OAPI/V2/InventoryBasic/GetBasicProductsList', minIntervalMs: 600000, authed: true },
  viewInventoryBalance: { path: '/OAPI/V2/InventoryBalance/ViewInventoryBalanceStatus', minIntervalMs: 1000, authed: true },
  listInventoryBalance: { path: '/OAPI/V2/InventoryBalance/GetListInventoryBalanceStatus', minIntervalMs: 600000, authed: true },
  viewInventoryBalanceByLocation: { path: '/OAPI/V2/InventoryBalance/ViewInventoryBalanceStatusByLocation', minIntervalMs: 1000, authed: true },
  listInventoryBalanceByLocation: { path: '/OAPI/V2/InventoryBalance/GetListInventoryBalanceStatusByLocation', minIntervalMs: 600000, authed: true },
  saveQuotation: { path: '/OAPI/V2/Quotation/SaveQuotation', minIntervalMs: 10000, authed: true, listKey: 'QuotationList' },
  saveSaleOrder: { path: '/OAPI/V2/SaleOrder/SaveSaleOrder', minIntervalMs: 10000, authed: true, listKey: 'SaleOrderList' },
  saveSale: { path: '/OAPI/V2/Sale/SaveSale', minIntervalMs: 10000, authed: true, listKey: 'SaleList' },
};

export class ErpOapiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ErpOapiError';
    this.code = code;
    Object.assign(this, details);
  }
}

/**
 * live   : talks to the vendor. Requires both guards plus a full credential set.
 * mock   : talks to ERP_MOCK_BASE_URL, which must be loopback. Test-only.
 * disabled: everything else, and the default when env is silent.
 */
export function oapiModeFromEnv(env = {}) {
  const requested = String(env.ERP_MODE || 'disabled').toLowerCase();
  const liveWrite = String(env.ERP_LIVE_WRITE || 'NO').toUpperCase() === 'YES';
  if (requested === 'mock') return 'mock';
  return liveWrite && requested === 'live' ? 'live' : 'disabled';
}

export function oapiCredentials(env = {}) {
  return {
    comCode: String(env.ECOUNT_COM_CODE || env.ERP_COM_CODE || '').trim(),
    userId: String(env.ECOUNT_USER_ID || env.ERP_USER_ID || '').trim(),
    apiCertKey: String(env.ECOUNT_API_CERT_KEY || env.ERP_API_CERT_KEY || '').trim(),
    lanType: String(env.ECOUNT_LAN_TYPE || env.ERP_LAN_TYPE || 'ko-KR').trim(),
    target: String(env.ECOUNT_TARGET || env.ERP_TARGET || 'test').toLowerCase() === 'prod' ? 'prod' : 'test',
    mockBaseUrl: String(env.ERP_MOCK_BASE_URL || '').trim(),
  };
}

const LOOPBACK = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;

export function assertMockBaseUrlAllowed(url) {
  if (!LOOPBACK.test(String(url || ''))) {
    throw new ErpOapiError('mock_base_url_not_loopback',
      `ERP_MODE=mock refuses a non-loopback ERP_MOCK_BASE_URL (got ${JSON.stringify(String(url || ''))}) — a mock run must not reach the vendor.`);
  }
  return String(url).replace(/\/+$/, '');
}

/**
 * "시간당 연속 오류 제한 건수: 1/30, 1시간 허용량: 3/6000, 1일 허용량: 13/10000"
 * -> {consecutiveErrors:{used,limit}, hourly:{used,limit}, daily:{used,limit}}
 * Unparseable text is returned as {raw} so a changed wording shows up as a gap
 * instead of silently reading as "no quota".
 */
export function parseQuotaInfo(text) {
  const raw = String(text || '');
  const pairs = raw.match(/\d+\/\d+/g);
  if (!pairs || pairs.length < 3) return { raw, known: false };
  const num = (p) => { const [used, limit] = p.split('/').map(Number); return { used, limit }; };
  return {
    raw,
    known: true,
    consecutiveErrors: num(pairs[0]),
    hourly: num(pairs[1]),
    daily: num(pairs[2]),
  };
}

/** Data.ResultDetails / Data.SlipNos are JSON strings; a bare value is also seen. */
export function decodeJsonField(value, field) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      throw new ErpOapiError('envelope_unparseable', `${field} is not JSON-decodable: ${value.slice(0, 200)}`, { field });
    }
  }
  return [value];
}

/**
 * Turns one HTTP response into a verdict. Returns
 * {ok, envelopeError, rows, slipNos, successCnt, failCnt, totalCnt, result, quota, traceId}.
 * `ok` is true only when the envelope has no Error AND every row succeeded —
 * a batch where 1 of 2 rows failed is not ok.
 */
export function interpretResponse({ httpStatus, body, endpoint }) {
  const record = {
    httpStatus,
    endpoint,
    ok: false,
    envelopeError: null,
    rows: [],
    slipNos: [],
    result: [],
    totalCnt: null,
    successCnt: null,
    failCnt: null,
    traceId: null,
    quota: null,
  };

  if (httpStatus === 404) {
    record.envelopeError = { code: 'http_404_path_absent', message: `path ${endpoint && endpoint.path} does not exist on this host`, httpStatus };
    return record;
  }
  if (httpStatus === 412 || httpStatus === 302) {
    record.envelopeError = { code: 'rate_limited', message: 'server request limit exceeded (HTTP ' + httpStatus + ')', httpStatus, retryAfterMs: 600000 };
    return record;
  }
  if (body == null || typeof body !== 'object') {
    record.envelopeError = { code: 'body_unparseable', message: 'response body is not JSON', httpStatus };
    return record;
  }
  if (httpStatus >= 500) {
    const err = body.Error || {};
    record.envelopeError = {
      code: err.Code === 'EXP00001' || /please login/i.test(String(err.Message || '')) ? 'session_invalid' : 'server_error',
      message: `${err.Code ?? httpStatus} ${err.Message ?? 'server error'}`.trim(),
      codeId: err.Code ?? null,
      detail: err.MessageDetail || null,
      errors: Array.isArray(body.Errors) ? body.Errors : (Array.isArray(err.Errors) ? err.Errors : []),
      httpStatus,
    };
    return record;
  }

  const status = String(body.Status ?? '');
  const data = body.Data || null;
  record.traceId = data && data.TRACE_ID ? String(data.TRACE_ID) : null;
  record.quota = parseQuotaInfo(data && data.QUANTITY_INFO);

  if (status !== '' && status !== '200') {
    const err = body.Error || {};
    record.envelopeError = {
      code: 'status_' + status,
      message: `${err.Code ?? ''} ${err.Message ?? 'Status ' + status}`.trim(),
      codeId: err.Code ?? null,
      detail: err.MessageDetail || null,
      httpStatus,
    };
    return record;
  }
  if (body.Error) {
    // The vendor's own login-failure example is Status 200 with Error.Code 201.
    record.envelopeError = {
      code: 'api_error',
      message: `${body.Error.Code ?? ''} ${body.Error.Message ?? 'error'}`.trim(),
      codeId: body.Error.Code ?? null,
      detail: body.Error.MessageDetail || null,
      httpStatus,
    };
    return record;
  }
  if (!data) {
    record.ok = true;
    return record;
  }

  if (Array.isArray(data.Result)) record.result = data.Result;
  if (data.TotalCnt != null) record.totalCnt = Number(data.TotalCnt);

  if (data.ResultDetails != null || data.SuccessCnt != null) {
    record.successCnt = data.SuccessCnt != null ? Number(data.SuccessCnt) : null;
    record.failCnt = data.FailCnt != null ? Number(data.FailCnt) : null;
    record.rows = decodeJsonField(data.ResultDetails, 'ResultDetails');
    record.slipNos = decodeJsonField(data.SlipNos, 'SlipNos');
    const failed = record.rows.filter((r) => r && r.IsSuccess !== true);
    record.envelopeError = failed.length
      ? { code: 'row_failures', message: failed.map((r) => `${r.TotalError ?? 'row failed'}`).join(' | ').slice(0, 500), rows: failed, httpStatus }
      : null;
    record.ok = failed.length === 0 && (record.failCnt == null || record.failCnt === 0);
    return record;
  }

  record.ok = true;
  return record;
}

export function createErpOapiClient({ env = {}, fetchFn = fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), claimDedupe = null } = {}) {
  const mode = oapiModeFromEnv(env);
  const creds = oapiCredentials(env);
  const lastCallAt = new Map();
  const client = {
    system: ERP_OAPI_SYSTEM,
    contract: ERP_OAPI_CONTRACT,
    adapterVersion: ERP_OAPI_ADAPTER_VERSION,
    mode,
    creds,
    zone: null,
    domain: null,
    expireDate: null,
    notice: null,
    sessionId: null,
    sessionStartedAt: null,
    stopped: false,
    stopReason: null,
    lastQuota: null,
    lastTraceId: null,
    configured: Boolean(creds.comCode && creds.userId && (mode === 'mock' ? creds.mockBaseUrl : creds.apiCertKey)),
    baseUrl: null,
    bootstrap,
    call,
    reset,
  };
  if (mode === 'mock') client.baseUrl = assertMockBaseUrlAllowed(creds.mockBaseUrl);

  function endpointOf(key) {
    const endpoint = ERP_OAPI_ENDPOINTS[key];
    if (!endpoint) throw new ErpOapiError('unknown_endpoint', `unknown OAPI endpoint key ${key}`);
    return { key, ...endpoint };
  }

  async function throttle(endpoint) {
    const wait = Math.max(0, endpoint.minIntervalMs - (now() - (lastCallAt.get(endpoint.key) ?? -Infinity)));
    lastCallAt.set(endpoint.key, now() + wait);
    if (wait > 0) await sleep(wait);
  }

  function guard(operation) {
    if (client.stopped) throw new ErpOapiError('stopped', `ERP calls halted: ${client.stopReason}`, { operation });
    if (mode === 'disabled') {
      throw new ErpOapiError('disabled',
        `ecount OAPI is disabled (ERP_MODE=${JSON.stringify(String(env.ERP_MODE || 'unset'))}, ERP_LIVE_WRITE=${JSON.stringify(String(env.ERP_LIVE_WRITE || 'unset'))}); nothing was transmitted`, { operation });
    }
    if (!client.configured) {
      throw new ErpOapiError('not_configured',
        mode === 'mock'
          ? 'ERP_MODE=mock needs ECOUNT_COM_CODE, ECOUNT_USER_ID and a loopback ERP_MOCK_BASE_URL'
          : 'ecount OAPI needs ECOUNT_COM_CODE, ECOUNT_USER_ID and ECOUNT_API_CERT_KEY', { operation });
    }
  }

  /**
   * Zone has no zone interpolation (it is how the zone is found). Login and
   * everything after it use the zone-qualified host from the Zone response.
   */
  function hostFor(stage) {
    if (mode === 'mock') return client.baseUrl;
    const prefix = creds.target === 'prod' ? 'oapi' : 'sboapi';
    if (stage === 'bootstrap') return `https://${prefix}.ecount.com`;
    return `https://${prefix}${client.zone || ''}${client.domain || '.ecount.com'}`;
  }

  async function post(pathname, body, { session = null, host = hostFor('api') } = {}) {
    const url = new URL(host + pathname);
    if (session) url.searchParams.set('SESSION_ID', session);
    const response = await fetchFn(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    let parsed = null;
    const text = await response.text();
    try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = { text: text.slice(0, 400) }; }
    return { status: response.status, body: parsed };
  }

  /** Zone -> OAPILogin. Populates client.zone / client.sessionId. */
  async function bootstrap() {
    guard('bootstrap');
    const zoneEndpoint = endpointOf('zone');
    await throttle(zoneEndpoint);
    const zoneRes = await post(zoneEndpoint.path, { COM_CODE: creds.comCode }, { host: hostFor('bootstrap') });
    const zone = interpretResponse({ httpStatus: zoneRes.status, body: zoneRes.body, endpoint: zoneEndpoint });
    if (!zone.ok || !zoneRes.body?.Data?.ZONE) {
      throw new ErpOapiError('zone_failed', `Zone API failed: ${zone.envelopeError?.message ?? zoneRes.status}`, { httpStatus: zoneRes.status, response: zoneRes.body });
    }
    client.zone = String(zoneRes.body.Data.ZONE);
    client.domain = String(zoneRes.body.Data.DOMAIN || '.ecount.com');
    client.expireDate = zoneRes.body.Data.EXPIRE_DATE || null;

    const loginEndpoint = endpointOf('login');
    await throttle(loginEndpoint);
    const loginRes = await post(loginEndpoint.path, {
      COM_CODE: creds.comCode,
      USER_ID: creds.userId,
      API_CERT_KEY: creds.apiCertKey,
      LAN_TYPE: creds.lanType,
      ZONE: client.zone,
    }, { host: hostFor('login') });
    const loginBody = loginRes.body;
    const login = interpretResponse({ httpStatus: loginRes.status, body: loginBody, endpoint: loginEndpoint });
    const codeId = login.envelopeError?.codeId;
    if (!login.ok) {
      if (typeof codeId === 'number' && ERP_OAPI_STOP_CODES.has(codeId)) {
        client.stopped = true;
        client.stopReason = `login refused with code ${codeId}: ${login.envelopeError.message}`;
      }
      throw new ErpOapiError('login_failed', `OAPILogin failed: ${login.envelopeError?.message ?? loginRes.status}`, { codeId, httpStatus: loginRes.status });
    }
    const datas = loginBody.Data?.Datas || loginBody.Data || {};
    const sessionId = datas.SESSION_ID || loginBody.Data?.SESSION_ID;
    if (!sessionId) throw new ErpOapiError('login_no_session', 'OAPILogin returned no SESSION_ID');
    client.sessionId = String(sessionId);
    client.sessionStartedAt = now();
    client.notice = loginBody.Data?.NOTICE || null;
    client.baseUrl = hostFor('api');
    return { zone: client.zone, sessionId: client.sessionId, expireDate: client.expireDate, notice: client.notice };
  }

  /**
   * One authenticated OAPI call. `body` is the vendor-shaped object; for list
   * endpoints pass the rows and they are wrapped as {<ListKey>:[{BulkDatas}]}.
   */
  async function call(key, payload = {}, { dedupeKey = null, rows = null, requireSession = true } = {}) {
    const endpoint = endpointOf(key);
    if (dedupeKey && claimDedupe) {
      const claimed = await claimDedupe(dedupeKey);
      if (!claimed) throw new ErpOapiError('dedupe_claimed', `${dedupeKey} was already transmitted; refusing to send twice`, { dedupeKey });
    }
    if (endpoint.authed && requireSession && !client.sessionId) await bootstrap();
    guard(endpoint.key);
    await throttle(endpoint);

    let body = payload;
    if (rows != null) {
      const listKey = endpoint.listKey || `${endpoint.key}List`;
      body = { [listKey]: rows.map((row) => ({ BulkDatas: row })) };
    }
    const response = await post(endpoint.path, body, { session: endpoint.authed ? client.sessionId : null });
    const record = interpretResponse({ httpStatus: response.status, body: response.body, endpoint });
    client.lastQuota = record.quota ?? client.lastQuota;
    client.lastTraceId = record.traceId ?? client.lastTraceId;

    if (record.envelopeError?.code === 'session_invalid' || record.envelopeError?.codeId === 20) {
      client.sessionId = null;
      record.reauthAvailable = true;
    }
    const quota = record.quota;
    if (quota?.known && quota.consecutiveErrors.used >= quota.consecutiveErrors.limit) {
      client.stopped = true;
      client.stopReason = `consecutive-error quota reached (${quota.consecutiveErrors.used}/${quota.consecutiveErrors.limit})`;
    }
    if (!record.ok) {
      const error = new ErpOapiError(record.envelopeError?.code || 'failed',
        `ecount ${endpoint.key}: ${record.envelopeError?.message ?? 'unknown failure'}`,
        { endpoint: endpoint.key, traceId: record.traceId, quota: record.quota, rows: record.rows, httpStatus: record.httpStatus, retryAfterMs: record.envelopeError?.retryAfterMs ?? null });
      error.retryable = record.envelopeError?.code === 'rate_limited' || record.envelopeError?.code === 'session_invalid';
      // Release the dedupe claim only when the vendor provably did not process
      // the batch (throttled or dead session). A row failure or an api_error can
      // mean a partially created document, so the claim stays held and a blind
      // resend — which would duplicate the slip — is refused instead.
      if (dedupeKey && claimDedupe && error.retryable) await claimDedupe(dedupeKey, { release: true });
      throw error;
    }
    return record;
  }

  function reset() {
    client.sessionId = null;
    client.sessionStartedAt = null;
  }

  return client;
}
