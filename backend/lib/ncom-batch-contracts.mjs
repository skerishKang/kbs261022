// 배치 운영 계약(순수 판단 함수) — #130 33건 실등록 증적(PR #135~#140, main a50ddd9)
// 에서 확립된 규칙을 회귀 테스트로 고정하기 위한 모듈.
//
// 이 파일은 등록 엔진이 아니다. 인증·본문 조립·전송의 유일한 권위는
// ncommerce.mjs(buildRegisterBody·registerOrModify)와 ncom-live-pipeline.mjs
// (게이트·이미지·중복조회·장부)이고, 이 모듈은 배치 러너가 상품마다 내려야 하는
// '결정'만 세 계약으로 제한한다:
//
//   1. 카테고리 확정 가드 — 동명 리프 충돌과 어휘점수 단독 확정을 거부한다.
//      (2026-10-29 실측 오매핑: 스탠드→차량용 스피커, 기타→앰프, 바늘→낚싯바늘 —
//       리프명만 같거나 점수·마진이 약하면 등록에 쓰지 않고 NEED_CATEGORY 로 회귀.)
//   2. 크래시 복구 — 등록 재시도 전 원격 존재 확인(판매자코드 검색)을 강제하고,
//      원격 발견분은 상품번호를 회수해 장부에 채운다(재등록 금지).
//      (4차 배치 2146 실측: 등록 직후 러너 크래시 → 재실행 중복조회로
//       상품번호 13776759782 회수, 중복 생성 0.)
//   3. 품절 등록 재개 — 재고 1 등록 → 재고 0 수정 → OUTOFSTOCK 저장 → 전시 ON
//      의 어느 단계에서 실패했든 원격 상태로 판정해 남은 단계만 재개한다(멱등).
//      (등록 시 재고 최소 1 = NumberMin, OUTOFSTOCK 은 수정 API 입력 statusType 이
//       아니라 서버 결과 상태, 수정 statusType 은 SALE/SUSPENSION 만.)
//
// 모든 함수는 전송하지 않는다. 실행 게이트·장부 기록은 ncom-live-pipeline.mjs 의
// evaluateLiveGates·mergeRegistrationLedger 를 그대로 통한다.

import { NcomError } from './ncommerce.mjs';

/** 1차 카테고리 자동확정 임계치(bulk/category_mapping_bulk_20261029.json thresholds). */
export const CATEGORY_THRESHOLDS = Object.freeze({ minScore: 0.5, minMargin: 0.08 });

/** 수정 API(productModifyOrigin)가 받는 statusType — OUTOFSTOCK 은 결과 상태다. */
export const MODIFY_ALLOWED_STATUS_TYPES = Object.freeze(['SALE', 'SUSPENSION']);

/**
 * 카테고리 확정 가드. items 의 각 행에 대해 '등록 본문에 쓸 수 있는 확정 리프인지'
 * 를 판정한다. 리프명이 코퍼스에서 유일하지 않은데 경로 근거(evidencePath)로
 * 특정되지 않으면, 점수가 높아도 refuse 다 — 동명 리프는 의미가 다를 수 있다.
 *
 * @param items   [{ cgiId, leafCategoryId, score, runnerUpScore?, evidencePath? }]
 *                evidencePath 는 라이브 코퍼스의 wholeCategoryName 과 정확히 일치하는
 *                전체 경로다(운영자 확정 또는 매처의 경로 근거).
 * @param leaves  [{ id, name, wholeName? }] — 라이브 코퍼스 리프(5,003건).
 * @returns { rows, counts, collisions }
 */
export function auditCategoryMapping({ items = [], leaves = [], thresholds = CATEGORY_THRESHOLDS } = {}) {
  const byId = new Map(leaves.map((leaf) => [String(leaf?.id ?? ''), leaf]));
  const byName = new Map();
  for (const leaf of leaves) {
    const name = String(leaf?.name ?? '').trim();
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(String(leaf.id));
  }

  const rows = items.map((item) => {
    const id = String(item?.leafCategoryId ?? '');
    const verdict = { cgiId: item.cgiId, leafCategoryId: id || null, verdict: 'confirmed', reason: null, leafName: null, collisionLeafIds: null };
    const leaf = byId.get(id);
    if (!leaf) {
      return { ...verdict, verdict: 'refused', reason: 'unknown_leaf' };
    }
    verdict.leafName = String(leaf.name ?? '').trim();
    const collisionIds = (byName.get(verdict.leafName) ?? []).filter((existing) => existing !== id);
    if (collisionIds.length > 0) {
      const evidencePath = String(item?.evidencePath ?? '').trim();
      const evidenceHits = evidencePath
        ? leaves.filter((candidate) => String(candidate.wholeName ?? '').trim() === evidencePath).map((candidate) => String(candidate.id))
        : [];
      const uniquelyIdentified = evidenceHits.length === 1 && evidenceHits[0] === id;
      if (!uniquelyIdentified) {
        return { ...verdict, verdict: 'refused', reason: 'leaf_name_collision', collisionLeafIds: collisionIds };
      }
    }
    const score = Number(item?.score);
    const runnerUp = item?.runnerUpScore == null ? null : Number(item.runnerUpScore);
    if (!Number.isFinite(score) || score < thresholds.minScore) {
      return { ...verdict, verdict: 'refused', reason: 'below_min_score' };
    }
    if (runnerUp != null && Number.isFinite(runnerUp) && score - runnerUp < thresholds.minMargin) {
      return { ...verdict, verdict: 'refused', reason: 'runner_up_within_margin' };
    }
    return verdict;
  });

  return {
    rows,
    counts: {
      items: rows.length,
      confirmed: rows.filter((row) => row.verdict === 'confirmed').length,
      refused: rows.filter((row) => row.verdict === 'refused').length,
      by_reason: rows.reduce((acc, row) => {
        if (row.verdict === 'refused') acc[row.reason] = (acc[row.reason] ?? 0) + 1;
        return acc;
      }, {}),
    },
    collisions: [...byName.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([name, ids]) => ({ name, leafIds: ids })),
  };
}

/**
 * 크래시·타임아웃 이후 배치 재실행 판정. 계약: 재등록 시도 전에 반드시 판매자코드
 * 원격 검색이 선행되고, 원격에 존재하면 등록하지 않고 상품번호를 장부로 회수한다.
 * 검색 결과가 없는 항목은 '등록 허용'이 아니라 '검색부터 다시' 가 기본값이다.
 *
 * @param batchItems [{ cgiId, sellerManagementCode }]
 * @param ledger     실행 장부 행(mergeRegistrationLedger 출력 형태 — originProductNo 보유분이 확정 등록)
 * @param dupChecks  [{ sellerManagementCode, existing, originProductNo? }] — runPilotDuplicateCheck 결과
 * @param now        recovered_at 타임스탬프 주입점
 */
export function planCrashRecovery({ batchItems = [], ledger = [], dupChecks = [], now = () => new Date().toISOString() } = {}) {
  const ledgeredCodes = new Set(
    ledger
      .filter((row) => row?.originProductNo != null)
      .map((row) => String(row.cgiId ?? row.sellerManagementCode ?? '')),
  );
  const checkByCode = new Map(dupChecks.map((check) => [String(check?.sellerManagementCode ?? ''), check]));

  const decisions = batchItems.map((item) => {
    const keys = [String(item.cgiId ?? ''), String(item.sellerManagementCode ?? '')].filter(Boolean);
    if (keys.some((key) => ledgeredCodes.has(key))) {
      return { ...item, action: 'already_ledgered', originProductNo: null, note: '장부에 상품번호가 있다 — 등록·검색 없이 건너뛴다' };
    }
    const check = checkByCode.get(String(item.sellerManagementCode ?? ''));
    if (!check) {
      return { ...item, action: 'dupcheck_required', originProductNo: null, note: '등록 재시도 전 판매자코드 원격 검색이 필수다 — 검색 없이는 등록하지 않는다' };
    }
    if (check.existing) {
      if (check.originProductNo == null) {
        return { ...item, action: 'adopt_unresolved', originProductNo: null, note: '원격에 존재하지만 상품번호를 파싱하지 못했다 — 수동 확인 전까지 등록 금지' };
      }
      return {
        ...item,
        action: 'adopt_remote',
        originProductNo: check.originProductNo,
        note: '크래시 전 실등록분 — 재등록하지 않고 상품번호를 회수해 장부에 채운다',
      };
    }
    return { ...item, action: 'register_allowed', originProductNo: null, note: '원격에 없음 — 게이트·사전검증 통과 시에만 등록 요청 1건 허용' };
  });

  const ledgerEntries = decisions
    .filter((decision) => decision.action === 'adopt_remote')
    .map((decision) => ({
      kind: 'cgi-ncom-crash-recovery',
      cgiId: decision.cgiId,
      sellerManagementCode: decision.sellerManagementCode,
      originProductNo: decision.originProductNo,
      smartstoreChannelProductNo: null,
      displayStatus: null,
      mode: 'live',
      recovered_at: now(),
      note: '등록 직후 러너 중단으로 장부 미기록됐던 실등록 상품 — 중복조회 원격 확인으로 회수(재등록 없음)',
    }));

  return {
    decisions,
    ledgerEntries,
    counts: decisions.reduce((acc, decision) => {
      acc[decision.action] = (acc[decision.action] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

/**
 * 품절 등록의 중간 단계 재개 판정(멱등). 원격 단건조회 결과 하나로 어느 단계까지
 * 완료됐는지 판정하고 '남은 단계'만 돌려준다. 등록된 적 없는 상품만 register_stock_1
 * 이고, 이때도 재고는 1 이다(등록 시 재고 0 = NumberMin 거부 실측).
 *
 * @param remote null | { exists: false } | { exists: true, statusType, stockQuantity, displayStatusType }
 *               — productGetOrigin(원상품 단건조회)의 관측값만 넣는다. 재고 수량을
 *                 만들어내지 않는다(판독 불가면 unreadable_remote).
 */
export function planZeroStockResume({ remote = null } = {}) {
  if (!remote || remote.exists === false) {
    return {
      action: 'register_stock_1',
      register: { statusType: 'SALE', stockQuantity: 1, channelProductDisplayStatusType: 'SUSPENSION' },
      note: 'NumberMin: 재고 0 등록은 거부된다 — 재고 1로 비노출 등록한 뒤 수정 경로로 재고 0',
    };
  }
  const stock = remote.stockQuantity;
  if (stock == null || !Number.isFinite(Number(stock))) {
    return { action: 'unreadable_remote', note: '원격 재고를 판독하지 못했다 — 수량을 만들지 말고 재조회한다' };
  }
  const quantity = Number(stock);
  const display = String(remote.displayStatusType ?? '');
  if (quantity >= 1) {
    return {
      action: 'modify_stock_0',
      modify: { statusType: 'SALE', stockQuantity: 0 },
      note: '수정 API statusType 은 SALE|SUSPENSION 만 — OUTOFSTOCK 은 재고 0 수정의 서버 결과 상태다',
    };
  }
  if (display !== 'ON') {
    return { action: 'display_on', note: '재고 0 저장(OUTOFSTOCK)까지 완료 — 전시 ON 만 남는다(스토어프론트 품절 표시)' };
  }
  return {
    action: 'done',
    outOfStockSaved: String(remote.statusType ?? '') === 'OUTOFSTOCK',
    note: '품절 등록 완료 상태 — 전송 0건, 재조회 검증만 남는다',
  };
}

/**
 * 공급처 원산지 표기 → 등록 본문 originAreaInfo 결정(순수 함수).
 * 벤더 문서(api/v2/products.POST): originAreaCode 는 상세 지역 코드(02xxxxx) 또는
 * 접두 코드 00~05, '04(기타-직접 입력)'는 content 를 필수로 요구한다. plural 의
 * 문서 의미는 '원산지가 다른 상품을 같이 등록하는지 여부'이므로 단일 상품의
 * 불확정 원산지에 true 를 쓰지 않는다.
 *
 * 계약(2026-10-29 배치5 확립):
 *   - 단일 국가 표기 → 라이브 코드표에서 유일 매칭 코드(verified_code).
 *   - '아시아 중국 또는 멕시코'처럼 복수 후보 표기 → 하나를 고르지 말고
 *     04 + 공급처 표기 원문(direct_input_content). 실측: 등록·전시 ON 성공.
 *   - 판독 불가·매칭 실패는 ok=false 로 보고하고 값을 만들지 않는다.
 */
export function resolveOriginArea({ originText = null, resolveCode = null } = {}) {
  const text = String(originText ?? '').trim();
  if (!text) return { ok: false, reason: 'origin_text_missing', originAreaCode: null, content: null, plural: false, mode: null };
  if (/또는/.test(text)) {
    return { ok: true, originAreaCode: '04', content: text, plural: false, mode: 'direct_input_content' };
  }
  const code = typeof resolveCode === 'function' ? resolveCode(text) : null;
  if (!code) return { ok: false, reason: 'origin_code_unresolved', originAreaCode: null, content: null, plural: false, mode: null };
  return { ok: true, originAreaCode: code, content: null, plural: false, mode: 'verified_code' };
}

/**
 * 원격 중복조회 히트 분류(C20·배치6 실측). 벤더 상품검색은 판매자코드 접두어 매칭을
 * 포함해 돌려준다(실측: 'samamusic:27' 검색에 'samamusic:2792' 등 6히트, 응답에
 * 판매자코드 필드 없음). 원상품 GET으로 검증한 코드 목록(hitCodes)만을 근거로
 * 판정한다 — 접두어만 일치하는 히트는 중복이 아니며 등록을 막지 않는다.
 */
export function classifySellerCodeHits({ hitCodes = [], sellerManagementCode = '' } = {}) {
  const wanted = String(sellerManagementCode ?? '');
  const codes = hitCodes.map((c) => String(c ?? ''));
  const exactCount = codes.filter((c) => c === wanted).length;
  return {
    adoptable: exactCount > 0,
    prefixOnly: exactCount === 0 && codes.length > 0,
    exactCount,
    prefixCount: codes.length - exactCount,
  };
}

/**
 * 배치가 만들려는 의도(intent)의 하드 가드. 배치 러너가 등록·수정 본문을 보내기 전에
 * 검증한다 — 실측으로 거부된 조합(NumberMin 재고 0 등록, OUTOFSTOCK statusType 수정)은
 * 여기서 예외로 막힌다.
 */
export function assertLegalBatchIntent({ kind, statusType, stockQuantity } = {}) {
  if (kind !== 'register' && kind !== 'modify') {
    throw new NcomError('batch_intent_unknown', `알 수 없는 배치 의도: ${JSON.stringify(kind)}`);
  }
  if (kind === 'register') {
    const quantity = Number(stockQuantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new NcomError('stock_number_min', `등록 시 재고수량은 1 이상이어야 한다(NumberMin 실측) — 받은 값 ${JSON.stringify(stockQuantity ?? null)}`);
    }
    return true;
  }
  if (!MODIFY_ALLOWED_STATUS_TYPES.includes(statusType)) {
    throw new NcomError('status_type_not_allowed', `수정 API statusType 은 ${MODIFY_ALLOWED_STATUS_TYPES.join('|')} 만 허용된다(OUTOFSTOCK 은 서버 결과 상태) — 받은 값 ${JSON.stringify(statusType ?? null)}`);
  }
  const quantity = Number(stockQuantity);
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new NcomError('stock_number_invalid', `수정 재고는 0 이상의 수여야 한다 — 받은 값 ${JSON.stringify(stockQuantity ?? null)}`);
  }
  return true;
}
