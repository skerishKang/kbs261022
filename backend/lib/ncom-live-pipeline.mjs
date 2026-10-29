// L1 — 네이버 커머스API 라이브 실행 경로 (CGI-1 LOCAL2 운영 레인, 2026-10-28).
//
// 이 모듈은 M1·M2에서 계약 테스트로 고정된 구성품을 전부 재사용하고, 스스로는
// 두 가지만 추가한다:
//
//   1. 운영자 게이트(evaluateLiveGates) — 라이브 '읽기'는 NCOM_MODE=live 와
//      자격증명을, '쓰기'(이미지 업로드·상품 등록)는 거기에 NCOM_LIVE_WRITE=YES 와
//      단계별 ack(--execute, 등록은 --i-confirm-register)까지 요구한다. 하나라도
//      부족하면 전송 전에 멈춘다 — '보내고 보자'는 없다.
//   2. 실행 장부(registration ledger) — 등록 결과를 cgiId·상품번호와 함께 기록해,
//      멱등키가 없는 이 API 에서 중복 등록의 유일한 방어선을 만든다.
//
// 본문 조립은 buildRegisterBody(등록 계약), 이미지 계획은 planImageUpload,
// 중복조회 결정은 registerOrModify(execute=false), 상한은 NCOM_LIMITS 가 유일한
// 권위다. 이 파일은 어떤 필드값도 발명하지 않는다 — 없는 값은 pending 으로
// 주체와 함께 보고한다. mock 테스트 결과와 라이브 실행 결과는 mode 필드로 구분해
// 기록한다.
//
// 파일럿 규칙(지시서 §5):
//   - 등록과 판매개시를 분리한다. channelProductDisplayStatusType 기본값은
//     SUSPENSION(비노출 등록)이고, ON 은 고객 판매개시 결정 ack(--sell-ack)가
//     있을 때만 허용된다.
//   - 재고는 공급처 표시 수량(availability.stock_number_displayed)을 측정 시점
//     유효성 검증 뒤에만 사용하고, 0·음수·미관리는 거부한다. ERP BAL_QTY 연동은
//     후속 과제다(docs/CGI_M2B_ERP_DEFERRED_20261028.md).
//   - 중복조회는 등록 직전 sellerManagementCode 검색(registerOrModify execute=false)
//     로 하고, 기존 상품이 잡히면 수정하지 않고 duplicate_blocked 로 남긴다.
//     파일럿 레인은 PUT(전체 덮어쓰기)을 절대 실행하지 않는다.

import { NcomError, NCOM_LIMITS, buildRegisterBody, registerOrModify, searchBySellerCodeBody } from './ncommerce.mjs';
import { planImageUpload } from './naver-images.mjs';

export const LIVE_LANE_DOC = {
  purpose: 'M1·M2의 검증된 인증·본문·이미지·중복조회 계약을 재사용하는 라이브 실행 경로',
  reuse: ['createNcomAuthRuntime', 'buildRegisterBody', 'planImageUpload', 'registerOrModify', 'searchBySellerCodeBody', 'NCOM_LIMITS'],
  gate: {
    read: 'NCOM_MODE=live + NCOM_CLIENT_ID/NCOM_CLIENT_SECRET (환경 변수만 — 파일·로그·응답에 값 금지)',
    write: 'read 요건 + NCOM_LIVE_WRITE=YES + --execute',
    register: 'write 요건 + --i-confirm-register',
  },
  ledger: '등록 성공 건은 실행 장부에 cgiId·상품번호와 함께 기록한다 — 재실행 시 동일 코드 검색이 먼저 막는다',
  noInvention: '확보되지 않은 값(리프카테고리·상세본문·재고·배송정책)은 pending 으로 보고한다',
};

export const LIVE_ACTIONS = Object.freeze({ read: 'read', upload: 'upload', register: 'register' });

/**
 * 라이브 레인의 전송 허용 판정. `env` 는 호출자가 읽어 넘긴다(모듈이 process.env 를
 * 직접 읽지 않는다 — 테스트가 env 를 주입할 수 있어야 한다). 실패 사유는 전송 전
 * 운영자에게 보이는 그대로 문자열로 돌려준다.
 */
export function evaluateLiveGates({ env = {}, action = 'read', acks = {} } = {}) {
  if (!Object.values(LIVE_ACTIONS).includes(action)) {
    return { allowed: false, action, mode: null, reasons: [`unknown live action: ${JSON.stringify(action)}`] };
  }
  const mode = String(env.NCOM_MODE || '').trim().toLowerCase();
  const liveWrite = String(env.NCOM_LIVE_WRITE || '').trim().toUpperCase() === 'YES';
  const creds = Boolean(String(env.NCOM_CLIENT_ID || '').trim() && String(env.NCOM_CLIENT_SECRET || '').trim());
  const reasons = [];
  if (mode !== 'live') reasons.push(`NCOM_MODE=live 필요 (현재 ${JSON.stringify(String(env.NCOM_MODE || 'unset'))})`);
  if (!creds) reasons.push('NCOM_CLIENT_ID·NCOM_CLIENT_SECRET 필요 (환경 변수 — 이 러너는 값을 출력하지 않는다)');
  if (action === LIVE_ACTIONS.upload || action === LIVE_ACTIONS.register) {
    if (!liveWrite) reasons.push('쓰기 작업에는 NCOM_LIVE_WRITE=YES 필요');
    if (!acks.execute) reasons.push('쓰기 작업에는 --execute ack 필요');
  }
  if (action === LIVE_ACTIONS.register && !acks.confirmRegister) {
    reasons.push('상품 등록 실행에는 --i-confirm-register ack 필요');
  }
  return { allowed: reasons.length === 0, action, mode, reasons };
}

/**
 * 공급처 표시 재고(product_db availability JSON) → 등록 본문의 stockQuantity.
 * 파생 규칙은 stockFromErpBalance 와 같은 원칙을 따른다: 소수는 내림(올림 금지),
 * 상한 초과 거부. 0·음수·use_stock=false 는 실재 상태이므로 파일럿 등록에 쓰지 않는다.
 * 측정 시점(collectedAt)이 maxAgeHours 를 넘으면 신선도 사유로 거부 — allowStale 로
 * 운영자가 명시적으로 받아들일 수 있다(그래도 사유는 결과에 남는다).
 */
export function mapSupplierStock({ availability = null, collectedAt = null, nowMs = Date.now(), maxAgeHours = 336, allowStale = false } = {}) {
  const reject = (reason, extra = {}) => ({
    ok: false, stockQuantity: null, source: 'supplier_displayed',
    measuredAt: collectedAt ?? null, ageHours: null, stale: false, reason, ...extra,
  });
  let parsed = null;
  try {
    parsed = typeof availability === 'string' ? JSON.parse(availability) : availability;
  } catch {
    return reject('availability_json_unreadable');
  }
  if (!parsed || typeof parsed !== 'object') return reject('availability_json_unreadable');
  if (parsed.use_stock !== true) return reject('use_stock_false', { note: '공급처가 재고를 관리하지 않는 표시 — 수량으로 쓰지 않는다' });
  const displayed = parsed.stock_number_displayed;
  const rawText = String(displayed ?? '').trim();
  if (rawText === '') return reject('stock_number_unreadable', { displayed: displayed ?? null });
  const num = Number(rawText.replace(/[,\s]/g, ''));
  if (!Number.isFinite(num)) return reject('stock_number_unreadable', { displayed: displayed ?? null });
  if (num < 0) return reject('negative_displayed_stock', { displayed });
  if (num === 0) return reject('zero_displayed_stock', { displayed, note: '0 은 품절 표시 — 파일럿 등록에 사용하지 않는다' });
  const stockQuantity = Math.floor(num);
  if (stockQuantity > NCOM_LIMITS.stockQuantityMax) return reject('out_of_bounds', { displayed, max: NCOM_LIMITS.stockQuantityMax });
  let ageHours = null;
  let stale = false;
  if (collectedAt) {
    const measured = Date.parse(collectedAt);
    if (Number.isFinite(measured)) {
      ageHours = Math.round(((nowMs - measured) / 3600000) * 10) / 10;
      stale = ageHours > maxAgeHours;
    }
  }
  if (stale && !allowStale) {
    return {
      ok: false, stockQuantity, source: 'supplier_displayed', measuredAt: collectedAt, ageHours, stale: true,
      reason: 'stale_measurement', note: `측정 후 ${ageHours}시간 경과 — 공급처 재측정 또는 운영자 승인(--stock-ack) 필요`,
    };
  }
  return { ok: true, stockQuantity, source: 'supplier_displayed', measuredAt: collectedAt ?? null, ageHours, stale, reason: null };
}

/**
 * 파일럿 패키지(m2b_pilot_packages.json) → 등록 가능 판정과 본문. 값의 유일한 출처:
 *   - leafCategoryId  : 라이브 코퍼스 매핑에서 운영자가 확정한 표(--category-file)
 *   - detailContent   : 운영자 승인 상세본문 파일(--detail-file) — 초안 자동 반영 없음
 *   - stockQuantity   : mapSupplierStock 통과분
 *   - images          : 이미지 업로드 러너 ledger 의 반환 URL 만
 *   - deliveryInfo    : 고객 확정 정책 파일(--policy-file)에 있을 때만
 * 없는 값은 pending 으로 남고, pending 이 남은 상품은 등록 가능 판정이 false 다.
 */
export function planPilotRegister({
  packages = [], imagesByCgiId = new Map(), leafByCgiId = new Map(), detailByCgiId = new Map(),
  stockByCgiId = new Map(), deliveryByCgiId = new Map(), displayStatus = 'SUSPENSION', sellAck = false,
} = {}) {
  if (displayStatus !== 'ON' && displayStatus !== 'SUSPENSION') {
    throw new NcomError('display_status_invalid', `channelProductDisplayStatusType 은 ON|SUSPENSION 만 허용된다 (받은 값 ${JSON.stringify(displayStatus)})`);
  }
  if (displayStatus === 'ON' && !sellAck) {
    throw new NcomError('sell_ack_missing', '판매노출 ON 은 고객 판매개시 결정 ack(--sell-ack)가 있을 때만 설정한다 — 기본값은 비노출 등록(SUSPENSION)이다');
  }
  const rows = packages.map((pkg) => {
    const cgiId = String(pkg.cgiId ?? '');
    const sellerManagementCode = String(pkg.sellerManagementCode ?? pkg.body?.originProduct?.detailAttribute?.sellerCodeInfo?.sellerManagementCode ?? '');
    const record = {
      prodDes: pkg.productName ?? pkg.body?.originProduct?.name ?? '',
      price: { value: pkg.body?.originProduct?.salePrice ?? null },
      sellerManagementCode,
      stockQuantity: null,
    };
    const leafCategoryId = leafByCgiId.get(cgiId) ?? leafByCgiId.get(sellerManagementCode) ?? null;
    const detailContent = detailByCgiId.get(cgiId) ?? detailByCgiId.get(sellerManagementCode) ?? null;
    const stock = stockByCgiId.get(cgiId) ?? stockByCgiId.get(sellerManagementCode) ?? null;
    if (stock?.ok === true) record.stockQuantity = stock.stockQuantity;
    const images = imagesByCgiId.get(cgiId) ?? imagesByCgiId.get(sellerManagementCode) ?? null;
    const deliveryInfo = deliveryByCgiId.get(cgiId) ?? deliveryByCgiId.get(sellerManagementCode) ?? null;
    const channel = {
      naverShoppingRegistration: pkg.body?.smartstoreChannelProduct?.naverShoppingRegistration === true,
      channelProductDisplayStatusType: displayStatus,
      ...(deliveryInfo ? { deliveryInfo } : {}),
    };
    const built = buildRegisterBody(record, {
      leafCategoryId,
      detailContent,
      images: images ? { representative: images.representative, additional: images.additional, uploadedViaImageApi: images.uploadedViaImageApi === true } : {},
      channel,
    });
    const pending = [];
    if (!leafCategoryId) pending.push({ field: 'leafCategoryId', owner: 'tooling_after_auth', note: '라이브 코퍼스 수집→매핑→운영자 리프 확정(--category-file)' });
    if (!detailContent) pending.push({ field: 'detailContent', owner: 'operator_approval', note: '운영자 승인 상세본문 파일(--detail-dir) 필요 — 초안 자동 반영 없음' });
    if (!stock) pending.push({ field: 'stockQuantity', owner: 'operator_ack', note: '공급처 표시 재고 승인(--stock-ack) 또는 신선한 측정값 필요' });
    else if (!stock.ok) pending.push({ field: 'stockQuantity', owner: stock.reason, note: stock.note ?? '' });
    if (!images?.representative) pending.push({ field: 'images.representative', owner: 'tooling_after_auth', note: '라이브 이미지 업로드 러너 실행 → ledger 반환 URL 필요' });
    if (!deliveryInfo) pending.push({ field: 'deliveryInfo', owner: 'customer_input', note: '고객 확정 배송·클레임 정책(--policy-file)이 있을 때만 본문에 들어간다 — 값은 만들지 않는다' });
    return {
      cgiId,
      sellerManagementCode,
      productName: record.prodDes,
      displayStatus,
      record,
      body: built.body,
      problems: built.problems,
      pending,
      stock: stock ?? null,
      images: images ?? null,
      registerable: built.problems.length === 0 && pending.length === 0,
    };
  });
  return {
    displayStatus,
    rows,
    counts: {
      products: rows.length,
      registerable: rows.filter((row) => row.registerable).length,
      blocked: rows.filter((row) => !row.registerable).length,
    },
  };
}

/**
 * 실행 장부 병합(순수 함수). 같은 cgiId 키는 최근 registered_at 을 남긴다 —
 * 장부는 사실 기록이고, 재등록 방지는 항상 등록 직전 검색이 1차 방어선이다.
 */
export function mergeRegistrationLedger({ existing = [], entries = [] } = {}) {
  const byKey = new Map();
  for (const row of [...existing, ...entries]) {
    const key = String(row?.cgiId ?? row?.sellerManagementCode ?? '');
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev || String(row.registered_at ?? '') >= String(prev.registered_at ?? '')) byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => String(a.cgiId ?? '').localeCompare(String(b.cgiId ?? '')));
}

const sniffImageFormat = (bytes) => {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'PNG';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'JPG';
  if (b.length >= 6 && (String.fromCharCode(...b.slice(0, 6)) === 'GIF87a' || String.fromCharCode(...b.slice(0, 6)) === 'GIF89a')) return 'GIF';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'BMP';
  return '';
};

/**
 * 멀티파트 파트의 Content-Type 은 이미지의 실제 MIME 이어야 한다 — vendor 규정
 * (commerce-api-naver/commerce-api discussion #1663: "JPEG: image/jpeg").
 * 스니프 형식명(JPG)을 그대로 내려보내면 image/jpg 가 되어 서버가
 * "이미지 업로드중 오류가 발생하였습니다"(400)로 거부한다 — 2026-10-29 라이브 실측.
 */
/**
 * 상품 이미지 다건 등록의 응답에서 업로드 URL 배열을 뽑는다(순수 함수).
 * vendor 실측(2026-10-29): 최상위 {images:[{url}]} — mock 계약({urls})과 다르다.
 * 두 형태를 모두 받되, URL 수가 보낸 파일 수와 다르면 호출자의 부분 채택 금지
 * 규칙이 그대로 적용되도록 배열(또는 null)만 돌려준다.
 */
export function uploadedUrlsFromResponse(response) {
  const body = response?.raw ?? response?.data ?? response;
  const pickImages = (list) => {
    if (!Array.isArray(list) || list.length === 0) return null;
    const urls = [];
    for (const item of list) {
      const url = item && typeof item === 'object' ? item.url : item;
      if (typeof url !== 'string' || url.length === 0) return null;
      urls.push(url);
    }
    return urls;
  };
  if (Array.isArray(body?.images)) return pickImages(body.images);
  if (Array.isArray(body?.urls)) return pickImages(body.urls);
  if (Array.isArray(response?.data?.urls)) return pickImages(response.data.urls);
  if (Array.isArray(response?.data?.images)) return pickImages(response.data.images);
  return null;
}

const MIME_BY_FORMAT = { JPG: 'image/jpeg', PNG: 'image/png', GIF: 'image/gif', BMP: 'image/bmp' };

/**
 * 파일럿 이미지 라이브 업로드. M2 이미지 러너의 계약(대표 1+추가 9, 배치 10장,
 * 응답 URL 수 불일치 배치는 부분 채택 금지, ledger 반환 URL 만 본문 허용)을 그대로
 * 따르되, 이 레인은 라이브만 허용한다(게이트). 파일 바이트는 실행 시 공급처 URL 에서
 * 받고, 형식은 문서 허용 4종(JPG/GIF/PNG/BMP) 매직바이트로 판정한다.
 * fetchBytes 는 테스트 주입점 — 운영 실행에서는 생략한다.
 */
export async function runPilotImageUpload({ runtime, packages = [], env = {}, gates = evaluateLiveGates, execute = false, fetchBytes = null } = {}) {
  const gate = gates({ env, action: LIVE_ACTIONS.upload, acks: { execute } });
  if (!gate.allowed) {
    return { mode: runtime.mode, transmitted: false, refused: true, reasons: gate.reasons, ledger: [], batches: [], failed_batches: [], naver_requests: 0 };
  }
  const load = fetchBytes ?? (async (url) => {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
    return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
  });

  const ledger = [];
  const failed_batches = [];
  const batches = [];
  for (const pkg of packages) {
    const uploadPlan = pkg?.images?.upload_plan ?? null;
    const urls = uploadPlan ? [uploadPlan.representative, ...(uploadPlan.additional ?? [])].filter(Boolean) : [];
    if (urls.length === 0) {
      failed_batches.push({ cgiId: pkg.cgiId, note: '업로드 계획이 비어 있다 — m2b 패키지의 upload_plan 필요' });
      continue;
    }
    const items = [];
    for (const url of urls) {
      const fetched = await load(url);
      const format = sniffImageFormat(fetched.bytes);
      items.push({
        url,
        bytes: fetched.bytes,
        status: fetched.status ?? null,
        format,
        formatAllowed: format !== '',
        filename: url.split('/').pop()?.split('?')[0] || 'image',
      });
    }
    const refused = items.filter((item) => !item.formatAllowed);
    if (refused.length) {
      failed_batches.push({ cgiId: pkg.cgiId, note: '형식 거부 — 문서 허용 4종(JPG/GIF/PNG/BMP)만 업로드한다', items: refused.map((item) => ({ url: item.url, format: item.format, http_status: item.status })) });
      continue;
    }
    const plan = planImageUpload(items);
    const selected = [plan.representative, ...plan.additional].filter(Boolean)
      .map((url) => items.find((item) => item.url === url))
      .filter(Boolean);
    for (let offset = 0; offset < selected.length; offset += NCOM_LIMITS.imagesPerUploadCall) {
      const batch = selected.slice(offset, offset + NCOM_LIMITS.imagesPerUploadCall);
      batches.push({ cgiId: pkg.cgiId, batch: batches.length + 1, files: batch.length });
      const form = new FormData();
      for (const item of batch) {
        form.append('imageFiles', new File([item.bytes], item.filename, { type: MIME_BY_FORMAT[item.format] ?? 'application/octet-stream' }));
      }
      const response = await runtime.call('imageUpload', { body: form });
      const urlsOut = uploadedUrlsFromResponse(response);
      if (!Array.isArray(urlsOut) || urlsOut.length !== batch.length) {
        failed_batches.push({
          cgiId: pkg.cgiId,
          sent: batch.length,
          received: Array.isArray(urlsOut) ? urlsOut.length : null,
          rawKeys: response?.data && typeof response.data === 'object' ? Object.keys(response.data) : null,
          note: '응답 URL 수가 보낸 파일 수와 다르다 — 부분 채택 없이 배치 전체가 대기 상태로 남는다',
        });
        continue;
      }
      batch.forEach((item, index) => ledger.push({ cgiId: pkg.cgiId, source: item.url, uploaded: urlsOut[index], mode: runtime.mode }));
    }
  }
  return {
    mode: runtime.mode,
    transmitted: failed_batches.length === 0 && ledger.length > 0,
    refused: false,
    ledger,
    batches,
    failed_batches,
    naver_requests: runtime.stats.attempts,
  };
}

/**
 * 파일럿 등록 실행. 각 상품은 등록 직전 sellerManagementCode 검색으로 중복을 확인
 * 하고(registerOrModify execute=false — 기존 계약 재사용), 기존 상품이 잡히면
 * duplicate_blocked 로 남긴다(파일럿 레인은 PUT 수정을 절대 실행하지 않는다).
 * execute=false 면 결정만 보고하고 전송 0건이다.
 */
export async function runPilotRegister({ runtime, plan, env = {}, gates = evaluateLiveGates, execute = false } = {}) {
  const gate = gates({ env, action: LIVE_ACTIONS.register, acks: { execute, confirmRegister: execute } });
  if (!gate.allowed) {
    return { mode: runtime.mode, transmitted: false, refused: true, reasons: gate.reasons, results: [], naver_requests: 0 };
  }
  const results = [];
  for (const row of plan.rows) {
    if (!row.registerable) {
      results.push({
        cgiId: row.cgiId, sellerManagementCode: row.sellerManagementCode, action: 'blocked_preconditions',
        transmitted: false, problems: row.problems, pending: row.pending,
        note: 'pending 해소 전에는 등록 요청을 만들지도 보내지도 않는다',
      });
      continue;
    }
    // 중복조회 + 본문 재조립(registerOrModify execute=false) — M1 계약의 단일 경로.
    const decision = await registerOrModify(runtime, {
      record: row.record, leafCategoryId: row.body.originProduct.leafCategoryId,
      images: row.images ?? {}, channel: {
        naverShoppingRegistration: row.body.smartstoreChannelProduct.naverShoppingRegistration === true,
        channelProductDisplayStatusType: row.displayStatus,
        ...(row.body.originProduct.deliveryInfo ? { deliveryInfo: row.body.originProduct.deliveryInfo } : {}),
      },
      detailContent: row.body.originProduct.detailContent ?? undefined,
      execute: false,
    });
    if (decision.action === 'rejected') {
      results.push({ cgiId: row.cgiId, sellerManagementCode: row.sellerManagementCode, action: 'rejected', transmitted: false, problems: decision.problems });
      continue;
    }
    if (decision.action === 'modify') {
      results.push({
        cgiId: row.cgiId, sellerManagementCode: row.sellerManagementCode, action: 'duplicate_blocked',
        transmitted: false, existingOriginProductNo: decision.existingOriginProductNo,
        note: '같은 판매자관리코드의 기존 상품이 있다 — 파일럿 레인은 수정(PUT)을 실행하지 않는다. 실행 장부에 기록된다.',
      });
      continue;
    }
    if (!execute) {
      results.push({ cgiId: row.cgiId, sellerManagementCode: row.sellerManagementCode, action: 'register_ready', transmitted: false, note: '중복 없음 — 게이트 통과 시 등록 요청 1건이 전송된다' });
      continue;
    }
    const sent = await runtime.call('productRegister', { body: decision.body });
    const data = sent?.data ?? {};
    const originProductNo = data.originProductNo ?? data.originProduct?.originProductNo ?? null;
    const channelProductNo = data.smartstoreChannelProductNo ?? data.smartstoreChannelProduct?.smartstoreChannelProductNo ?? null;
    results.push({
      cgiId: row.cgiId, sellerManagementCode: row.sellerManagementCode, action: 'registered',
      transmitted: true, originProductNo, smartstoreChannelProductNo: channelProductNo,
      displayStatus: row.displayStatus, traceId: sent?.traceId ?? null,
      responseKeys: data && typeof data === 'object' ? Object.keys(data) : null,
    });
  }
  return { mode: runtime.mode, transmitted: results.some((r) => r.action === 'registered'), refused: false, results, naver_requests: runtime.stats.attempts };
}

/**
 * 등록·중복 결과 → 실행 장부 행. registered 와 duplicate_blocked 모두 기록한다 —
 * duplicate_blocked 는 '이 코드로 이미 상품이 있다'는 사실 기록이다.
 */
export function ledgerEntriesFromRegisterRun({ run, displayStatus = 'SUSPENSION', mode = 'live', now = () => new Date().toISOString() } = {}) {
  const entries = [];
  for (const result of run?.results ?? []) {
    if (result.action === 'registered') {
      entries.push({
        kind: 'cgi-ncom-registration',
        cgiId: result.cgiId,
        sellerManagementCode: result.sellerManagementCode,
        originProductNo: result.originProductNo ?? null,
        smartstoreChannelProductNo: result.smartstoreChannelProductNo ?? null,
        displayStatus,
        mode,
        traceId: result.traceId ?? null,
        registered_at: now(),
      });
    }
    if (result.action === 'duplicate_blocked') {
      entries.push({
        kind: 'cgi-ncom-duplicate-blocked',
        cgiId: result.cgiId,
        sellerManagementCode: result.sellerManagementCode,
        existingOriginProductNo: result.existingOriginProductNo ?? null,
        mode,
        recorded_at: now(),
      });
    }
  }
  return entries;
}

/**
 * m2b 등록 준비 패키지(reports/data/registration/m2b_pilot_packages.json)는 최상위
 * 키가 snake_case(cgi_id·product_name·seller_management_code)이고 본문은 .package
 * 에 들어 있다. 반면 이 레인의 계약(planPilotRegister·업로드·중복조회 러너와 e2e
 * 픽스처)은 평평한 camelCase(cgiId·productName·sellerManagementCode·body)다 — 그대로
 * 읽으면 코드가 전부 undefined 가 되어 라이브 검색·조립이 빈 값으로 실행된다
 * (2026-10-29 실측 결함, "undefined: no existing product" 3건). 로드 시점에 한 번
 * 평탄화하고, 이미 평평한 패키지는 있는 값을 그대로 통과시킨다.
 */
export function normalizeM2bPackages(packages = []) {
  return packages.map((pkg) => {
    if (!pkg || typeof pkg !== 'object') return pkg;
    const inner = pkg.package && typeof pkg.package === 'object' ? pkg.package : {};
    const body = pkg.body ?? inner.body ?? null;
    return {
      ...pkg,
      cgiId: pkg.cgiId ?? pkg.cgi_id ?? inner.cgiId ?? '',
      productName: pkg.productName ?? pkg.product_name ?? inner.productName ?? '',
      sellerManagementCode: pkg.sellerManagementCode ?? pkg.seller_management_code ?? inner.sellerManagementCode ?? '',
      ...(body ? { body } : {}),
    };
  });
}

/** 중복조회 단계(dupcheck) — 등록 결정 없이 검색만. read 게이트. */
export async function runPilotDuplicateCheck({ runtime, sellerCodes = [], env = {}, gates = evaluateLiveGates } = {}) {
  const gate = gates({ env, action: LIVE_ACTIONS.read, acks: {} });
  if (!gate.allowed) return { refused: true, reasons: gate.reasons, checks: [], naver_requests: 0 };
  const checks = [];
  for (const sellerManagementCode of sellerCodes) {
    const search = await runtime.call('productSearch', { body: searchBySellerCodeBody(sellerManagementCode) });
    const contents = search?.data && Array.isArray(search.data.contents) ? search.data.contents : [];
    checks.push({
      sellerManagementCode,
      existing: contents.length > 0,
      totalElements: search?.data?.totalElements ?? contents.length,
      originProductNo: contents[0]?.originProductNo ?? null,
    });
  }
  return { refused: false, checks, naver_requests: runtime.stats.attempts };
}
