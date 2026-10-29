# 네이버 커머스API 상품등록 운영 Runbook — 검증된 계약·표준 절차 (2026-10-29)

> **단일 최신 운영 문서.** #130 레인(COM1·LOCAL2)의 실등록 33건 시점(main `a50ddd9` = PR #140 병합)까지
> 라이브 실측으로 확정된 API 계약과 표준 절차를 정리한다. 오류 사례별 상세는
> [오류·교훈·위험 레지스터](CGI_NCOM_ERROR_REGISTER_20261029.md), 배치별 수량·증적은
> [배치 증적 수량표](CGI_NCOM_BATCH_EVIDENCE_20261029.md)를 본다.
> **문서 정리는 실검증이 아니다** — 각 계약의 근거는 링크된 증적 파일과 회귀 테스트다.
> 이전 세션 보고 [CGI_NCOM_LIVE_RUN_20261029.md](CGI_NCOM_LIVE_RUN_20261029.md)는 파일럿 전사 기록으로 보존되며
> 운영 절차는 이 문서를 기준으로 한다.

## 1. 운영 개요

| 항목 | 값 |
| --- | --- |
| 대상 스토어 | `https://smartstore.naver.com/cgiinc`(주식회사 시지아이) — `GET /v1/seller/channels` 실측 |
| 등록 엔진(유일한 권위) | `backend/lib/ncommerce.mjs`(인증·buildRegisterBody·registerOrModify) · `backend/lib/ncom-live-pipeline.mjs`(게이트·이미지·중복조회·장부) · `backend/lib/ncom-batch-contracts.mjs`(배치 판단 계약) |
| 실행 CLI | `tools/naver/ncom-live.mjs` + `tools/naver/ncommerce-auth-local.mjs`(로컬 인증 런타임) |
| 자격증명 | `~/.config/cgi-erp/ncom.env`(저장소 밖) — NCOM_CLIENT_ID/SECRET. 값은 채팅·로그·커밋 어디에도 기록하지 않는다 |
| 전송 게이트 | 읽기=NCOM_MODE=live+자격증명 / 쓰기=+NCOM_LIVE_WRITE=YES+`--execute` / 등록=+`--i-confirm-register` (`evaluateLiveGates`) |
| 실행 장부 | `reports/data/registration/ncom_registration_ledger.json` — cgiId 키, 최신 우선 병합(`mergeRegistrationLedger`), 등록·중복차단 모두 기록 |
| IP 제한 | 앱 등록 API호출 IP 사전등록. 미등록 IP는 `GW.IP_NOT_ALLOWED`로 클라이언트 정지(수동 해제 없음) — 기기 이동 시 운영자가 앱 설정에 IP 추가 |

## 2. 검증된 API 계약 (전부 라이브 실측 근거 있음)

| # | 계약 | 근거 | 회귀 테스트 |
| --- | --- | --- | --- |
| C1 | 인증 서명=base64(bcrypt(client_id+"_"+timestamp)), 시크릿=salt. 토큰 form-encoded·Bearer·만료 3h. `GW.AUTHN` 1회 재인증, `GW.IP_NOT_ALLOWED` 즉시 중단, 429 `GW.RATE_LIMIT` 지수백오프 | PR #134·#135, `ncommerce-auth.mjs` | `e2e/ncom.test.mjs` |
| C2 | 등록 본문은 `buildRegisterBody`가 유일한 권위. images는 v2 스키마(`representativeImage`/`optionalImages`) | PR #135 (v2→v5 시도 경과) | `unit/ncom-live-pipeline.test.mjs` |
| C3 | 이미지 multipart의 Content-Type은 실제 MIME(`image/jpeg`). `image/jpg`는 400 | 2026-10-29 실측 | `e2e/ncom-live-image-mime.test.mjs` |
| C4 | 업로드 응답의 반환 URL만 본문에 사용. `images:[{url}]`(vendor)·`{urls}`(mock) 모두 지원, URL 수 불일치 배치는 부분 채택 금지 | PR #135 | `unit/ncom-live-upload-response.test.mjs` |
| C5 | 필수 고시: `etc.manufacturer` NotNull, `etc.modelName` NotNull — 모델명 미게시 상품은 임의 생성 금지, 제외한다 | PR #138·#139·#140 실측(3678·4057·4058 제외) | payload 계약 검증(§5 절차 D) |
| C6 | KC 비대상 선언은 `certificationTargetExcludeContent.kcCertifiedProductExclusionYn='TRUE'` 단독 — 인증종류 동시 전송은 거부("KC 인증대상 아님으로 선택 시, KC 인증종류를 입력할 수 없습니다") | PR #138 실측 | payload 계약 검증(§5 절차 D) |
| C7 | 원산지: ISO 국가코드 직접 사용 불가(400) → `GET /v1/product-origin-areas` 라이브 조회로 코드 확정. 실측 코드표: 독일 0201005·미국 0204000·이탈리아 0201038·프랑스 0201046·중국 0200037 | PR #135·#139·#140 | payload 계약 검증(§5 절차 D) |
| C8 | 배송: 디지털/가전 카테고리는 배송없음 불가(`NotAllowed.category.for.nonDelivery`) → 물품=DELIVERY+택배사 코드표(로젠택배 KGB 등), 전자배송=DIRECT. `claimDeliveryInfo` 필수 | PR #135 실측 | payload 계약 검증(§5 절차 D) |
| C9 | 상품정보제공고시: `GET /v1/products-for-provided-notice`로 상품군 필드 구조 확인(36종) — ETC·DIGITAL_CONTENTS 등 카테고리별 대응 | PR #135 실측 | payload 계약 검증(§5 절차 D) |
| C10 | 등록 시 `stockQuantity` 최소 1(NumberMin "재고수량 항목은 1개 이상") — 재고 0 등록은 거부 | PR #139 실측 | `unit/ncom-batch-contracts.test.mjs`(assertLegalBatchIntent) |
| C11 | 품절 등록: 재고 1 등록(SUSPENSION) → `productModifyOrigin` 재고 0 → 서버가 OUTOFSTOCK 저장 → 전시 ON(스토어프론트 품절 표시) | PR #139 증적 `bulk/register_zero_stock_batch_20261029.json` | `e2e/ncom-batch-recovery.test.mjs` |
| C12 | 수정 API statusType은 SALE/SUSPENSION만 — OUTOFSTOCK은 입력이 아니라 서버 결과 상태(전송 거부) | PR #139 실측 | `unit/ncom-batch-contracts.test.mjs` |
| C13 | 채널상품 PUT(`PUT /v2/products/channel-products/{no}`)은 전체 리소스 교체 — 전시 ON 후 원상품 SALE·가격·재고·상품명 불변 재조회 검증 | PR #136 실측 | `bulk/live/display_activation_20261029.json` 증적 |
| C14 | 등록 직전 판매자코드 검색(`searchBySellerCodeBody`)으로 중복 확인 — 기존 상품 발견 시 `duplicate_blocked`(수정 없음). 등록 직후엔 검색색인 지연으로 검색 히트 0건 → 직후 검증은 상품 단건조회로 | PR #135·#140 | `e2e/ncom-live-pipeline.test.mjs` |
| C15 | 크래시·타임아웃 후 무조건 재등록 금지 — 판매자코드 재조회로 원격 존재 확인, 발견 시 상품번호 회수해 장부 복구(adopt), 미발견 시에만 등록 재시도 | PR #140 (2146 실측: 등록 직후 크래시 → 재실행 검색으로 13776759782 회수, 중복 생성 0, 중복 차단 17건) | `unit/ncom-batch-contracts.test.mjs` + `e2e/ncom-batch-recovery.test.mjs` |
| C16 | 카테고리: 동명 리프·어휘점수 단독으로 확정 금지 — 리프명 충돌 검사와 점수·마진 임계치(1차 0.5/0.08) 통과분만 확정. 의미 오매핑 사례: 스탠드→차량용 스피커, 기타→앰프, 바늘→낚싯바늘, 스튜디오 모니터→자동차 카오디오 리프 | PR #137·#139, `bulk/category_mapping_bulk_20261029.json` | `unit/ncom-batch-contracts.test.mjs`(auditCategoryMapping) |
| C17 | 재고는 공급처 표시 수량을 14일 신선도 검증 뒤에만 사용(소수 내림·0·음수·use_stock=false 거부). 수집 재고의 낡음 실측: READY 173건 재검증에서 50건 품절 발견 | PR #137·#138 | `unit/ncom-live-pipeline.test.mjs`(mapSupplierStock) |

## 3. 표준 절차

### A. 신규(판매중) 상품 등록
1. 공급처 라이브 재검증 — 판매중·판매가·모델명·원산지 확인. **READY(데이터 완성)≠REGISTRABLE_NOW(지금 등록 가능)**, 등록 직전 공급처 상태가 최종 게이트다.
2. 모델명·제조사 확인 — 공급처에 모델명 미게시면 제외(C5). 임의 생성 금지.
3. 카테고리 리프 확정 — 배치 검증 리프(50001516 소프트웨어·50004311 일렉기타·50007235 스피커액세서리·50002320 스피커단품) 또는 매핑 테이블 candidate. 동명 리프·자동차기기 리프는 C16 가드.
4. 원산지 코드 — §2 C7 코드표에 없는 국가면 `GET /v1/product-origin-areas` 라이브 조회.
5. 이미지 업로드 — `runPilotImageUpload`(execute ack), 반환 URL만 본문 사용.
6. payload 생성 → 등록 전 계약 검증(C2·C5~C10) → 중복조회 0건 확인.
7. `POST /v2/products`(비노출 SUSPENSION 등록) → 상품 단건조회로 판매상태·가격·재고·원산지 일치 검증(색인 지연으로 검색 검증 불가 — C14).
8. 장부 즉시 기록(등록 1건당).
9. 전시 ON — 별도 판매개시 결정으로 실행, PUT 전체 교체 계약(C13) + 불변 재조회 검증 → 장부 갱신.

### B. 품절 상품 등록
C10~C12 상태머신: 재고 1 등록(SUSPENSION, 노출 창구 없음) → `productModifyOrigin` 재고 0(statusType=SALE 유지) → 단건조회로 OUTOFSTOCK 저장 확인 → 전시 ON(품절 표시) → 장부 기록.
중간 실패 시: `planZeroStockResume`(원격 단건조회 상태로 남은 단계만 재개 — 멱등).

### C. 재입고·재고 수정
재입고 감지분은 `productModifyOrigin`으로 재고 갱신 후 판매 재개(수정 경로, C12). **NOT_VERIFIED — 실재입고 E2E는 미수행**(4차 배치에서 2093·4966 재입고 감지 후 수량 미상으로 보류).

### D. 배치 실행 전 계약 검증(13항목)
검증 배치 방식(PR #137) 재사용: 이미지 업로드 → payload 생성 → (1)본문 스키마 (2)필수 고시 (3)KC 선언 (4)원산지 코드 (5)배송·클레임 (6)재고≥1 (7)가격 (8)리프 (9)중복조회 (10)이미지 URL 출처 (11)detailContent (12)판매자코드 (13)전시 기본값 — 전부 통과분만 등록 단계로.

### E. 크래시·타임아웃·배치 중단 복구
1. **재등록 금지** — 예외가 나면 그 상품은 등록 시도 여부를 알 수 없다(C15).
2. 판매자코드 재조회(원격) → 히트 시 상품번호 회수 → 장부에 `cgi-ncom-crash-recovery` 행으로 채움(`planCrashRecovery`).
3. 원격 미발견분만 게이트·사전검증 재통과 후 등록 재시도.
4. 배치 재실행은 장부 조인으로 미등록만 — 4차 배치에서 멱등성 실증(중복 차단 17건).
5. 상태머신: `PENDING → VERIFIED → REGISTERED → DISPLAYED / FAILED(reason)` — 등록 1건당 장부 즉시 기록(크래시 손실 최소화).

### F. 판매 상태와 전시 상태의 구분
- 등록(POST)과 판매개시(전시 ON)는 분리 — 등록만으로는 노출되지 않는다(기본 SUSPENSION).
- 원상품 `statusType`(SALE/OUTOFSTOCK/SUSPENSION)과 채널 `channelProductDisplayStatusType`(ON/OFF/SUSPENSION)은 별개 필드.
- 품절=재고 0의 서버 결과(C11), 전시 ON 상태의 품절 상품은 스토어프론트에 품절 표시.

## 4. 다음 배치(50건) 실행 게이트 — 요약
`reports/data/registration/bulk/batch5_prep_20261029.json` 기준(2026-10-29, 라이브 호출 0건의 준비 산출물):
1. 실행 직전 공급처 라이브 재검증(준비 산출물의 공급처 상태는 2026-10-29T05:16Z 기준 — 재검증이 최종 게이트).
2. 등록 직전 중복조회 — 히트 시 재등록 금지·장부 복구 경로(C15).
3. 모델명·제조사 재확인 — 미수집분 제외(품절 후보는 전량 모델명 미수집으로 제외된 상태).
4. 원산지 — 코드표 외 국가는 라이브 조회(61건 NEED_ORIGIN_LOOKUP).
5. 자동차기기 리프 검토 19건은 운영자 리프 확정 전 등록 금지.

## 5. NOT_VERIFIED 목록 (검증 안 된 가정 — 완료로 주장하지 않는다)
| 항목 | 상태 |
| --- | --- |
| 소비자 화면(스토어프론트) 브라우저 E2E | WAF 차단으로 미검증 — API 전시 ON을 화면 검증 PASS로 쓰지 않는다(PR #136) |
| 재입고(재고 0→N) 실재입고 E2E | 미수행 — 계약만 문서화(C12 절차 C) |
| 네이버쇼핑 검색색인 반영 | 전시 ON 직후 미반영 확인 — 별도 판정 항목 |
| ERP(ecount) 실재고 연동 | `~/.config/cgi-erp/ecount.env` 부재 — 공급처 라이브 조회로 우회 중 |
| 중복 후보 1,353쌍 중 검토 815쌍 | 운영 검토 대기(자동병합 538쌍 포함) |

## 6. 사고 대응
- **등록된 상품의 롤백은 없다** — 잘못 등록한 상품은 PUT 수정 또는 전시 SUSPENSION 전환으로 대응하고, 삭제는 판매자센터 수동 조치다.
- 토큰 만료(3h)·`GW.RATE_LIMIT`는 런타임이 자동 처리한다(C1). `GW.IP_NOT_ALLOWED`·`path_not_registered`는 자동 재시도하지 않고 중단한다.
- 비밀값·고객정보는 장부·증적·로그 어디에도 기록하지 않는다. 오류 전문 공유 시 민감정보를 마스킹한다.

## 7. 관련 문서·증적
- 오류·교훈·위험 레지스터: [CGI_NCOM_ERROR_REGISTER_20261029.md](CGI_NCOM_ERROR_REGISTER_20261029.md)
- 배치별 증적·수량표: [CGI_NCOM_BATCH_EVIDENCE_20261029.md](CGI_NCOM_BATCH_EVIDENCE_20261029.md)
- 증적 원본: `reports/data/registration/live/`(파일럿) · `reports/data/registration/bulk/`(대량 배치)
- 이전 세션 전사 기록: [CGI_NCOM_LIVE_RUN_20261029.md](CGI_NCOM_LIVE_RUN_20261029.md)
