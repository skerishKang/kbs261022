// Naver Commerce Open API (커머스API) adapter — endpoints, parameters, bounds
// and error families exactly as published at apicenter.commerce.naver.com
// (doc set v2.90.x, cached under tmp/naver-docs/ with page-level sources).
//
// Rules this module follows, because the failure it exists to prevent is a
// client that talks to endpoints nobody verified:
//   - Only paths present in the official reference are exposed. An unknown path
//     would surface as HTTP 404 + code GW.NOT_FOUND, so that pairing is
//     classified as path_not_registered and never retried.
//   - Anything the docs leave open is listed in NCOM_UNCONFIRMED and is NOT
//     encoded as a constant. No invented TTL, no invented max length.
//   - There is no idempotency key anywhere in this API (confirmed absent), so
//     duplicate protection is done client-side: search by 판매자 관리 코드 first,
//     and register only on a miss.
//   - Product modify is a FULL overwrite except leafCategoryId, detailContent
//     and productInfoProvidedNotice. A partial PUT silently deletes the rest, so
//     a modify plan must carry the whole resource.
//
// Nothing transmits unless NCOM_LIVE_WRITE=YES and NCOM_MODE=live, and the
// request signature needs a bcrypt primitive the Workers runtime does not
// provide — see NCOM_AUTH_GAP. That gap is reported, not papered over.

export const NCOM_BASE_URL = 'https://api.commerce.naver.com/external';
export const NCOM_DOC_VERSION = 'v2.90.x';

export const NCOM_ENDPOINTS = {
  token: { method: 'POST', path: '/v1/oauth2/token', authed: false, body: true },
  productRegister: { method: 'POST', path: '/v2/products', body: true },
  productModifyOrigin: { method: 'PUT', path: '/v2/products/origin-products/{originProductNo}', body: true },
  productModifyChannel: { method: 'PUT', path: '/v2/products/channel-products/{channelProductNo}', body: true },
  productGetOrigin: { method: 'GET', path: '/v2/products/origin-products/{originProductNo}' },
  productGetChannel: { method: 'GET', path: '/v2/products/channel-products/{channelProductNo}' },
  productSearch: { method: 'POST', path: '/v1/products/search', body: true },
  optionStock: { method: 'PUT', path: '/v1/products/origin-products/{originProductNo}/option-stock', body: true },
  imageUpload: { method: 'POST', path: '/v1/product-images/upload', multipart: true },
  orderLastChanged: { method: 'GET', path: '/v1/pay-order/seller/product-orders/last-changed-statuses' },
  orderList: { method: 'GET', path: '/v1/pay-order/seller/product-orders' },
  orderQuery: { method: 'POST', path: '/v1/pay-order/seller/product-orders/query', body: true },
};

/** Documented numbers only. Anything the docs never printed stays in UNCONFIRMED. */
export const NCOM_LIMITS = {
  salePriceMax: 999999990,
  stockQuantityMax: 99999999,
  standardOptionStockWhenUnmanaged: 9999,
  imagesPerUploadCall: 10,
  extraImagesMax: 9,
  searchSizeMax: 500,
  orderPageSizeMax: 300,
  timestampValidityMs: 300000,
  tokenRefreshSkewMs: 60000,
};

export const NCOM_UNCONFIRMED = [
  'access token numeric TTL (only expires_in in seconds is documented)',
  'client_secret_sign in body vs query (the two official pages disagree)',
  'sellerManagementCode maximum length',
  'option-level price and stockQuantity bounds',
  'global / per-endpoint numeric rate limits (docs: 유동적; read GNCP-GW-RateLimit-* headers)',
  'domain (non-GW) 4xx body shape — no worked example in the docs',
  'which capabilities exist only on the /partner host (API대행사) and are invisible here',
  'a field carrying our own storefront order id (only seller-supplied codes exist)',
];

export const NCOM_AUTH_GAP = {
  requiredPrimitive: 'bcrypt hash of `${clientId}_${timestampMs}` using client_secret as the salt, then base64',
  runtimeProvides: false,
  reason: 'Cloudflare Workers WebCrypto has no bcrypt, and no npm dependency is installed in backend/. The hash is injected via bcryptHashpw; without it no signature can be produced.',
  doNot: 'A hand-written bcrypt substitute would produce a signature that fails with 400/GW.AUTHN and, worse, could be mistaken for a credential problem rather than a missing primitive.',
};

/** Gateway error codes, verbatim from the docs, with the retry decision each implies. */
export const NCOM_GATEWAY_CODES = {
  'GW.AUTHN': { http: 401, meaning: 'OAuth 인증 실패', retry: 'after re-auth, once' },
  'GW.IP_NOT_ALLOWED': { http: 403, meaning: '호출이 허용되지 않은 IP', retry: 'never — operator must register the IP' },
  'GW.NOT_FOUND': { http: 404, meaning: '게이트웨이에 등록되지 않은 API', retry: 'never — the path is wrong' },
  'GW.RATE_LIMIT': { http: 429, meaning: '요청량 제한 초과', retry: 'with backoff' },
  'GW.QUOTA_LIMIT': { http: 429, meaning: '(단위)시간당 요청량 제한 초과', retry: 'with backoff until the window rolls' },
  'GW.INTERNAL_SERVER_ERROR': { http: 500, meaning: '게이트웨이 내부 예외', retry: 'with backoff' },
  'GW.BLOCK.01': { http: 503, meaning: 'circuit open', retry: 'with backoff' },
  'GW.BLOCK.02': { http: 503, meaning: '시스템 점검', retry: 'with backoff' },
  'GW.TIMEOUT.01': { http: 504, meaning: '처리 대기 시간 초과', retry: 'with backoff' },
  'GW.TIMEOUT.02': { http: 504, meaning: '응답 대기 시간 초과', retry: 'with backoff' },
};

/**
 * Where the storefront boundary sits. 이카운트 already ships its own
 * 스마트스토어2.0 sync (주문 수신 + 품목/재고 연동) inside the ERP, so a direct
 * Naver client must not re-implement the same job or the two writers will race.
 */
export const NCOM_RESPONSIBILITY = {
  ecountNative: [
    '스마트스토어 주문을 ERP 전표로 받아들이는 것(주문 수신·매출전표 자동 생성)',
    'ERP 품목 마스터를 쇼핑몰로 내려보내는 기본 연동',
  ],
  thisAdapter: [
    'CGI 카탈로그를 네이버 상품으로 최초 등록하고, 판매가·재고·옵션 재고를 직접 갱신',
    '판매자 관리 코드로 상품 존재 여부를 미리 조회해 중복 등록을 막는 것(이 API에는 멱등 키가 없음)',
    '상태 변경 시점 기준 주문 변경분 수집(ERP가 소비하기 전에 남는 채널 전용 필드: 옵션 코드, 클레임 상태)',
  ],
  rule: 'ERP가 주문을 이미 수신한 경로가 존재하면 이 어댑터는 read-only 충돌 점검만 하고, 쓰기를 하지 않는다. 쓰기 대상 채널 필드는 위 thisAdapter 목록으로 한정한다.',
};

export class NcomError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'NcomError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function ncomModeFromEnv(env = {}) {
  const requested = String(env.NCOM_MODE || 'disabled').toLowerCase();
  const liveWrite = String(env.NCOM_LIVE_WRITE || 'NO').toUpperCase() === 'YES';
  if (requested === 'mock') return 'mock';
  return liveWrite && requested === 'live' ? 'live' : 'disabled';
}

const LOOPBACK = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;

function base64FromUtf8(text) {
  const bytes = new TextEncoder().encode(String(text));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * client_secret_sign = Base64(bcrypt(`${clientId}_${timestamp}`, salt=clientSecret)).
 * `bcryptHashpw` is injected because the runtime has no bcrypt.
 */
export async function buildClientSecretSign({ clientId, timestampMs, clientSecret, bcryptHashpw }) {
  if (typeof bcryptHashpw !== 'function') {
    throw new NcomError('bcrypt_seam_missing', `no bcrypt primitive injected — ${NCOM_AUTH_GAP.reason}`, { gap: NCOM_AUTH_GAP });
  }
  const hashed = await bcryptHashpw(`${clientId}_${timestampMs}`, clientSecret);
  if (typeof hashed !== 'string' || !hashed.startsWith('$2')) {
    throw new NcomError('bcrypt_output_invalid', 'bcryptHashpw must return a crypt-formatted $2* hash so the base64 step matches the vendor recipe');
  }
  return base64FromUtf8(hashed);
}

/** Maps one HTTP response onto the two documented error families. */
export function classifyNcomResponse({ httpStatus, body, headers = {} }) {
  const code = body && typeof body === 'object' && typeof body.code === 'string' ? body.code : null;
  const gateway = code && code.startsWith('GW.');
  const rateHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    // Header names are case-insensitive on the wire; the copy is keyed lowercase so
    // a caller reading one documented name never has to guess how it arrived.
    if (/^gncp-gw-ratelimit/i.test(key)) rateHeaders[key.toLowerCase()] = value;
  }
  if (httpStatus >= 200 && httpStatus < 300) {
    return { ok: true, family: null, code, message: null, traceId: body?.traceId ?? null, retryable: false, rateHeaders };
  }
  if (gateway) {
    const known = NCOM_GATEWAY_CODES[code];
    return {
      ok: false,
      family: 'gateway',
      code,
      message: body?.message ?? known?.meaning ?? null,
      traceId: body?.traceId ?? null,
      retryable: known ? /backoff|once/.test(known.retry) : httpStatus >= 500,
      rateLimited: code === 'GW.RATE_LIMIT' || code === 'GW.QUOTA_LIMIT',
      reauth: code === 'GW.AUTHN',
      // Only an unregistered IP stops the whole client. GW.NOT_FOUND stops the
      // call, not the account: it means this path was never registered at the
      // gateway, i.e. the caller asked for an endpoint that does not exist.
      stopped: code === 'GW.IP_NOT_ALLOWED',
      pathNotRegistered: code === 'GW.NOT_FOUND',
      rateHeaders,
    };
  }
  // Domain errors: the docs give status->code tables but no body example, so the
  // raw payload is carried through untouched instead of being reshaped to a guess.
  return {
    ok: false,
    family: 'domain',
    code,
    message: body?.message ?? body?.error?.message ?? null,
    traceId: body?.traceId ?? null,
    retryable: httpStatus >= 500 || httpStatus === 429,
    raw: body,
    rateHeaders,
  };
}

export function clampOrderPageSize(pageSize) {
  const requested = Number(pageSize);
  const max = NCOM_LIMITS.orderPageSizeMax;
  if (!Number.isFinite(requested) || requested < 1) return { pageSize: max, clamped: true, reason: 'unset defaults to the documented maximum' };
  return requested > max ? { pageSize: max, clamped: true, reason: `pageSize must be 1..300` } : { pageSize: requested, clamped: false };
}

export function searchBySellerCodeBody(sellerManagementCode, { page = 1, size = 500, productStatusTypes = null } = {}) {
  const body = { searchKeywordType: 'SELLER_CODE', sellerManagementCode, page, size: Math.min(size, NCOM_LIMITS.searchSizeMax) };
  if (productStatusTypes) body.productStatusTypes = productStatusTypes;
  return body;
}

/**
 * CGI mapping record -> product register body, with every documented bound and
 * required column checked locally. A rejected record is returned with reasons;
 * it is never sent "and see what the server says".
 */
export function buildRegisterBody(record, { leafCategoryId, images = {}, channel = {}, detailContent, optionInfo = null, taxType = 'TAX' } = {}) {
  const origin = {
    statusType: 'SALE',
    name: String(record.prodDes || '').trim(),
    salePrice: record.price && record.price.value != null ? Number(record.price.value) : null,
    stockQuantity: record.stockQuantity != null ? Number(record.stockQuantity) : null,
    detailAttribute: {
      taxType,
      sellerCodeInfo: { sellerManagementCode: String(record.sellerManagementCode || record.cgiId) },
    },
    images: {
      representative: images.representative || null,
      additional: Array.isArray(images.additional) ? images.additional.slice(0, NCOM_LIMITS.extraImagesMax) : [],
    },
  };
  if (leafCategoryId) origin.leafCategoryId = String(leafCategoryId);
  if (detailContent) origin.detailContent = String(detailContent);
  if (optionInfo) origin.detailAttribute.optionInfo = optionInfo;
  if (channel.deliveryInfo) origin.deliveryInfo = channel.deliveryInfo;
  if (record.saleType) origin.saleType = record.saleType;

  const smartstore = {
    naverShoppingRegistration: channel.naverShoppingRegistration === true,
    channelProductDisplayStatusType: channel.channelProductDisplayStatusType === 'SUSPENSION' ? 'SUSPENSION' : 'ON',
  };
  if (channel.channelProductName) smartstore.channelProductName = String(channel.channelProductName);

  const problems = [];
  if (!origin.leafCategoryId) problems.push({ field: 'leafCategoryId', reason: 'required_at_register' });
  if (!origin.detailContent) problems.push({ field: 'detailContent', reason: 'required_at_register' });
  if (!origin.name) problems.push({ field: 'name', reason: 'required' });
  if (origin.salePrice == null) problems.push({ field: 'salePrice', reason: 'no_public_price' });
  else if (origin.salePrice < 0 || origin.salePrice > NCOM_LIMITS.salePriceMax) problems.push({ field: 'salePrice', reason: 'out_of_bounds', max: NCOM_LIMITS.salePriceMax });
  if (origin.stockQuantity == null) problems.push({ field: 'stockQuantity', reason: 'required_at_register' });
  else if (origin.stockQuantity < 0) problems.push({ field: 'stockQuantity', reason: 'negative', measured: origin.stockQuantity });
  else if (origin.stockQuantity > NCOM_LIMITS.stockQuantityMax) problems.push({ field: 'stockQuantity', reason: 'out_of_bounds', max: NCOM_LIMITS.stockQuantityMax });
  if (!origin.images.representative) problems.push({ field: 'images.representative', reason: 'required' });
  else if (!images.uploadedViaImageApi) problems.push({ field: 'images.representative', reason: 'not_from_image_upload_api', note: '외부 호스트 직접 링크는 거부됩니다. POST /v1/product-images/upload 응답 URL만 사용 가능합니다.' });
  if (origin.statusType !== 'SALE') problems.push({ field: 'statusType', reason: 'only_SALE_at_register' });

  return { body: { originProduct: origin, smartstoreChannelProduct: smartstore }, problems };
}

/**
 * ERP BAL_QTY -> Naver stockQuantity. The CGI catalogue carries no numeric
 * stock anywhere (measured: 0 of 4,575 rows), so ERP 재고현황 is the only
 * source. A negative ERP balance is a real state (the vendor's own example
 * returns -1) and must not become a negative Naver stock.
 */
export function stockFromErpBalance({ erpRows = [], mappingByProdCd = new Map() }) {
  const updates = [];
  const rejected = [];
  for (const row of erpRows) {
    const prodCd = String(row.PROD_CD || '').trim();
    const measured = Number(row.BAL_QTY);
    const target = mappingByProdCd.get(prodCd);
    if (!prodCd || !Number.isFinite(measured)) { rejected.push({ prodCd, reason: 'unreadable_BAL_QTY', row }); continue; }
    if (!target) { rejected.push({ prodCd, reason: 'unmapped_prod_cd', measured, note: 'no CGI→ERP mapping row for this 품목코드' }); continue; }
    if (!target.naverItemId) { rejected.push({ prodCd, reason: 'no_naver_channel_product', measured, note: 'mapped in ERP but never published to Naver' }); continue; }
    if (measured < 0) { rejected.push({ prodCd, naverItemId: target.naverItemId, reason: 'negative_balance', measured, note: 'send OUTOFSTOCK/usable=false instead of a negative stockQuantity' }); continue; }
    if (measured > NCOM_LIMITS.stockQuantityMax) { rejected.push({ prodCd, reason: 'out_of_bounds', measured, max: NCOM_LIMITS.stockQuantityMax }); continue; }
    updates.push({
      endpointKey: target.optionManaged ? 'optionStock' : 'productModifyOrigin',
      originProductNo: target.naverItemId,
      stockQuantity: Math.floor(measured),
      prodCd,
      dedupeKey: `ncom:stock:${target.naverItemId}:${measured}`,
    });
  }
  return { updates, rejected, counts: { updates: updates.length, rejected: rejected.length } };
}

export function createNcomClient({ env = {}, fetchFn = fetch, bcryptHashpw = null, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const mode = ncomModeFromEnv(env);
  const clientId = String(env.NCOM_CLIENT_ID || '').trim();
  const clientSecret = String(env.NCOM_CLIENT_SECRET || '').trim();
  const type = String(env.NCOM_ACCOUNT_TYPE || 'SELF').toUpperCase() === 'SELLER' ? 'SELLER' : 'SELF';
  const accountId = String(env.NCOM_ACCOUNT_ID || '').trim();
  let base = NCOM_BASE_URL;
  if (mode === 'mock') {
    if (!LOOPBACK.test(env.NCOM_MOCK_BASE_URL || '')) throw new NcomError('mock_base_url_not_loopback', 'NCOM_MODE=mock refuses a non-loopback NCOM_MOCK_BASE_URL — a mock run must not reach Naver');
    base = String(env.NCOM_MOCK_BASE_URL).replace(/\/+$/, '');
  }

  const client = {
    mode,
    base,
    clientId,
    type,
    accessToken: null,
    accessTokenExpiresAt: 0,
    stopped: false,
    stopReason: null,
    lastRateHeaders: null,
    calls: [],
    available: Boolean(clientId && clientSecret && (mode === 'mock' || bcryptHashpw)),
    authorize,
    call,
  };

  function guard(operation) {
    if (client.stopped) throw new NcomError('stopped', `Naver calls halted: ${client.stopReason}`, { operation });
    if (mode === 'disabled') throw new NcomError('disabled', `커머스API is disabled (NCOM_MODE=${JSON.stringify(String(env.NCOM_MODE || 'unset'))}, NCOM_LIVE_WRITE=${JSON.stringify(String(env.NCOM_LIVE_WRITE || 'unset'))}); nothing was transmitted`, { operation });
    if (!clientId || !clientSecret) throw new NcomError('not_configured', 'NCOM_CLIENT_ID and NCOM_CLIENT_SECRET are required', { operation });
  }

  async function send(method, url, { body, headers = {}, multipart = false } = {}) {
    const init = { method, headers: { Accept: 'application/json', ...headers } };
    if (multipart) {
      init.body = body;
    } else if (body !== undefined) {
      init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const response = await fetchFn(url, init);
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = { raw: text.slice(0, 400) }; }
    const headerMap = {};
    if (typeof response.headers?.forEach === 'function') response.headers.forEach((value, key) => { headerMap[key] = value; });
    return { status: response.status, body: parsed, headers: headerMap };
  }

  /** OAuth token. Body-only parameters, timestamp in milliseconds. */
  async function authorize({ force = false } = {}) {
    guard('token');
    if (!force && client.accessToken && now() < client.accessTokenExpiresAt - NCOM_LIMITS.tokenRefreshSkewMs) return client.accessToken;
    if (!bcryptHashpw) throw new NcomError('bcrypt_seam_missing', NCOM_AUTH_GAP.reason, { gap: NCOM_AUTH_GAP });
    const timestamp = now();
    const sign = await buildClientSecretSign({ clientId, timestampMs: timestamp, clientSecret, bcryptHashpw });
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, timestamp: String(timestamp), client_secret_sign: sign, type });
    if (type === 'SELLER') {
      if (!accountId) throw new NcomError('account_id_required', 'type=SELLER needs NCOM_ACCOUNT_ID');
      form.set('account_id', accountId);
    }
    const response = await send('POST', `${base}${NCOM_ENDPOINTS.token.path}`, { body: form.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const verdict = classifyNcomResponse({ httpStatus: response.status, body: response.body, headers: response.headers });
    client.calls.push({ endpoint: 'token', method: 'POST', path: NCOM_ENDPOINTS.token.path, verdict });
    if (!verdict.ok) throw new NcomError(verdict.code || `http_${response.status}`, `token request failed: ${verdict.message ?? response.status}`, { verdict });
    const accessToken = response.body?.access_token;
    if (!accessToken) throw new NcomError('token_missing', 'token response carried no access_token');
    const expiresInSec = Number(response.body?.expires_in);
    client.accessToken = accessToken;
    // TTL is not documented as a number; only expires_in is honoured. A missing
    // expires_in is treated as "cache nothing" rather than assuming 3 hours.
    client.accessTokenExpiresAt = Number.isFinite(expiresInSec) && expiresInSec > 0 ? now() + expiresInSec * 1000 : now();
    return accessToken;
  }

  async function call(key, { body = undefined, query = null, pathParams = {} } = {}, { allowReauth = true } = {}) {
    const endpoint = NCOM_ENDPOINTS[key];
    if (!endpoint) throw new NcomError('unknown_endpoint', `커머스API path for ${key} is not in the verified endpoint table`);
    guard(key);
    const token = await authorize();
    const missing = endpoint.path.match(/\{(\w+)\}/g) || [];
    for (const holder of missing) {
      const name = holder.slice(1, -1);
      if (pathParams[name] === undefined || pathParams[name] === null || String(pathParams[name]).trim() === '') {
        throw new NcomError('path_param_missing', `${key} needs path parameter ${name}`);
      }
    }
    const path = endpoint.path.replace(/\{(\w+)\}/g, (_, name) => encodeURIComponent(String(pathParams[name])));
    const url = new URL(base + path);
    for (const [name, value] of Object.entries(query || {})) if (value !== undefined && value !== null) url.searchParams.set(name, String(value));

    const response = await send(endpoint.method, url.toString(), {
      body: endpoint.multipart ? body : (body === undefined ? undefined : body),
      headers: endpoint.authed === false ? {} : { Authorization: `Bearer ${token}` },
    });
    const verdict = classifyNcomResponse({ httpStatus: response.status, body: response.body, headers: response.headers });
    client.lastRateHeaders = verdict.rateHeaders;
    client.calls.push({ endpoint: key, method: endpoint.method, path: url.pathname, query: Object.fromEntries(url.searchParams.entries()), verdict });

    if (!verdict.ok) {
      if (verdict.stopped) { client.stopped = true; client.stopReason = `${verdict.code}: ${verdict.message}`; }
      if (verdict.reauth && allowReauth) {
        client.accessToken = null;
        client.accessTokenExpiresAt = 0;
        return call(key, { body, query, pathParams }, { allowReauth: false });
      }
      const error = new NcomError(verdict.pathNotRegistered ? 'path_not_registered' : (verdict.code || `http_${response.status}`), `커머스API ${key}: ${verdict.message ?? 'failed'}`, { endpoint: key, family: verdict.family, httpStatus: response.status, traceId: verdict.traceId, retryable: verdict.retryable, pathNotRegistered: verdict.pathNotRegistered === true, rateHeaders: verdict.rateHeaders, raw: verdict.raw ?? null });
      throw error;
    }
    return { data: response.body?.data ?? response.body, raw: response.body, traceId: response.body?.traceId ?? null, verdict };
  }

  return client;
}

/**
 * No idempotency key exists in this API, so re-running the same catalogue push
 * would create a second product. The guard is a read: look the 판매자 관리 코드 up
 * first and register only on a miss. With execute=false this is a dry run that
 * reports the decision without writing anything.
 */
export async function registerOrModify(client, { record, leafCategoryId, images, channel, detailContent, optionInfo, execute = false } = {}) {
  const built = buildRegisterBody(record, { leafCategoryId, images, channel, detailContent, optionInfo });
  const sellerCode = built.body.originProduct.detailAttribute.sellerCodeInfo.sellerManagementCode;
  if (built.problems.length) return { action: 'rejected', sellerManagementCode: sellerCode, problems: built.problems, body: null, transmitted: false };

  const search = await client.call('productSearch', { body: searchBySellerCodeBody(sellerCode) });
  const contents = search.data && Array.isArray(search.data.contents) ? search.data.contents : [];
  if (contents.length) {
    const plan = {
      action: 'modify',
      endpointKey: 'productModifyOrigin',
      sellerManagementCode: sellerCode,
      existingOriginProductNo: contents[0].originProductNo ?? null,
      body: built.body,
      transmitted: false,
      note: 'PUT은 전체 덮어쓰기 — leafCategoryId·detailContent·productInfoProvidedNotice를 제외하고는 본문에 전부 담아야 기존 값이 유지된다',
    };
    if (!execute) return plan;
    if (plan.existingOriginProductNo == null) throw new NcomError('origin_product_no_missing', `the search hit for ${sellerCode} carried no originProductNo; refusing a blind modify`);
    const sent = await client.call('productModifyOrigin', { pathParams: { originProductNo: plan.existingOriginProductNo }, body: built.body });
    return { ...plan, transmitted: true, result: sent };
  }
  const plan = { action: 'register', endpointKey: 'productRegister', sellerManagementCode: sellerCode, body: built.body, transmitted: false };
  if (!execute) return plan;
  const sent = await client.call('productRegister', { body: built.body });
  return { ...plan, transmitted: true, result: sent };
}
