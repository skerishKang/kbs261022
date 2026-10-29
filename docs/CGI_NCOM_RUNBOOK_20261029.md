# 네이버 커머스API 상품등록 운영 Runbook — 검증된 계약·표준 절차 (2026-10-29)

> **단일 최신 운영 문서.** #130 레인(COM1·LOCAL2)의 실등록 33건 시점(main `a50ddd9` = PR #140 병합)까지
> 라이브 실측으로 확정된 API 계약과 표준 절차를 정리한다. 오류 사례별 상세는
> [오류·교훈·위험 레지스터](CGI_NCOM_ERROR_REGISTER_20261029.md), 배치별 수량·증적은
> [배치 증적 수량표](CGI_NCOM_BATCH_EVIDENCE_20261029.md)를 본다.
> **2026-10-29 CGI-1 운영 PC 전환 기록은 [CGI_NCOM_CGI1_CUTOVER_20261029.md](CGI_NCOM_CGI1_CUTOVER_20261029.md)** —
> 이관 후 이 문서의 실행 경로·스케줄러·차단 상태는 그 문서의 실측을 우선한다.
> **문서 정리는 실검증이 아니다** — 각 계약의 근거는 링크된 증적 파일과 회귀 테스트다.
> 이전 세션 보고 [CGI_NCOM_LIVE_RUN_20261029.md](CGI_NCOM_LIVE_RUN_20261029.md)는 파일럿 전사 기록으로 보존되며
> 운영 절차는 이 문서를 기준으로 한다.

## 1. 운영 개요

| 항목 | 값 |
| --- | --- |
| 대상 스토어 | `https://smartstore.naver.com/cgiinc`(주식회사 시지아이) — `GET /v1/seller/channels` 실측 |
| 주 운영 PC | **Padiem-Command-Center**(Tailscale `padiem-command-center` — 이전 기록의 COM1과 동일 기기) · 작업 폴더 `E:\claw-apps-1027-2\kbs261022`(2026-10-30 배치11, main `23cb777` 기준). 이전 기록의 `CGI-1 D:\클로드\261029\cgi-1`·`COM1 E:\cgi-1029-1`은 과거 경로 |
| 등록 엔진(유일한 권위) | `backend/lib/ncommerce.mjs`(인증·buildRegisterBody·registerOrModify) · `backend/lib/ncom-live-pipeline.mjs`(게이트·이미지·중복조회·장부) · `backend/lib/ncom-batch-contracts.mjs`(배치 판단 계약) |
| 실행 CLI | `tools/naver/ncom-live.mjs` + `tools/naver/ncommerce-auth-local.mjs`(로컬 인증 런타임) · `tools/naver/ncom-stock-sync.mjs`(재고 동기화 운영 CLI — compare 기본·잠금·게이트·원복, 배치9) · `tools/naver/run-stock-check.ps1`(정기 점검 래퍼) |
| 자격증명 | `~/.config/cgi-erp/ncom.env`(저장소 밖) — NCOM_CLIENT_ID/SECRET. 값은 채팅·로그·커밋 어디에도 기록하지 않는다. **Padiem-Command-Center에 존재 — 2026-10-30 배치11에서 토큰 발급·허용 IP 라이브 검증 완료(E28 해소). CGI-1에는 여전히 없음** |
| 전송 게이트 | 읽기=NCOM_MODE=live+자격증명 / 쓰기=+NCOM_LIVE_WRITE=YES+`--execute` / 등록=+`--i-confirm-register` (`evaluateLiveGates`) — **런타임 모드 진입에는 읽기도 `NCOM_LIVE_WRITE=YES`가 필요**(ncomModeFromEnv: live는 live+LIVE_WRITE 조합) |
| 실행 장부 | `reports/data/registration/ncom_registration_ledger.json` — cgiId 키, 최신 우선 병합(`mergeRegistrationLedger`), 등록·중복차단 모두 기록. **누적 700행 = 등록 362 + 재고동기화 338** |
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
| C7 | 원산지: ISO 국가코드 직접 사용 불가(400) → `GET /v1/product-origin-areas` 라이브 조회로 코드 확정. 실측 코드표: 독일 0201005·미국 0204000·이탈리아 0201038·프랑스 0201046·중국 0200037·국산 00(2026-10-30 실측 — '국내' 표기는 E30 정규화로 국산에 위임) | PR #135·#139·#140 | payload 계약 검증(§5 절차 D) |
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
| C18 | 원산지 표기: 단일 국가=라이브 코드표 유일 매칭 코드(표기 꼬리 마침표·쉼표 제거 후) / '아시아 중국 또는 멕시코'·'멕시코 , 중국'처럼 복수 후보 표기=**04(기타-직접 입력)+공급처 표기 원문(content)** — 하나를 임의로 고르지 않는다. **'해외'(국가 미표기)는 02 단독 선언이 거부됨(실측) → 근거 없는 선언 불가, 제외**. `plural` 의 문서 의미는 '원산지가 다른 상품을 같이 등록하는지 여부'이므로 단일 상품 불확정 원산지에 쓰지 않는다 | 배치5 실측(19건) + 배치7 실측(마침표·쉼표·'해외' — E24) + 벤더 문서 products.POST | `unit/ncom-batch-contracts.test.mjs`(resolveOriginArea) |
| C19 | SW(전자배송) 판별: 공급처 페이지 '전자배송' 표기(보조: 상품명 전자배송·실시간·구독권·다운로드·라이선스 마커) → 배치 검증 리프 50001516·DIGITAL_CONTENTS 고시·DIRECT 배송 계약. 하드웨어는 각 리프+ETC 고시(제조사·모델명)+KC 비대상 선언 | 배치5 실측(SW 22건·하드웨어 28건 전원 성공) | payload 계약 검증(§5 절차 D) |
| C20 | 원격 중복조히트는 접두어 매칭을 포함한다(실측: 'samamusic:27' 검색에 'samamusic:2792' 등 6히트, 응답에 판매자코드 없음) — 채택·차단은 원상품 GET으로 판매자코드 정확 일치를 검증한 뒤에만 하고, 접두어만 일치하면 등록을 진행한다 | 배치6 실측(E23 오채택 정정) | `unit/ncom-batch-contracts.test.mjs`(classifySellerCodeHits) |
| C21 | 기존 상품 재고 동기화: ① 읽기 비교(공급처 관측 + 원상품 GET) → 계획 산정 → 명확히 확인된 변경만 수정 ② 동일 수량·동일 상태는 쓰기 생략 ③ 수량 미공개 공급처의 순수 수량 동기화는 차단(알려진 수량을 하한 1로 덮어쓰지 않음 — E25) ④ 상태 전환(재입고·품절)만 하한 1 허용(출처 기록) ⑤ 수정은 전체 리소스 PUT(C13) + 재조회 검증 + 전후 장부 기록 ⑥ 판매자코드 정확 일치 조인(C20) ⑦ 품절 전환은 C11~C12(OUTOFSTOCK 입력 금지) | 배치8 실측(비교 326 → 적용 170 → E25 정정 168 복원 → 유효 변경 재입고 2건 라이브 성공) | `unit/ncom-stock-sync.test.mjs` + `e2e/ncom-stock-sync.test.mjs` |
| C22 | 운영 쓰기 가드(전환 신설): `apply`는 `stock_source`가 `supplier_label`·`supplier_sold_out`인 계획만 전송한다. `fallback_*`(수량 미공개 하한)·출처 미기록 계획은 `blocked_by_source`로 기록만 하고 PUT하지 않는다. C21 ④의 계약상 예외는 보존하되 운영 CLI가 그 위에서 차단한다 | 2026-10-29 지시(수량 출처 불명확 쓰기 차단) · 배치9 장부의 fallback 재입고 2건은 과거 예외로 기록 | `unit/ncom-stock-sync-runner.test.mjs`(selectWritablePlans) |

## 3. 표준 절차

### A. 신규(판매중) 상품 등록
1. 공급처 라이브 재검증 — 판매중·판매가·모델명·원산지 확인. **READY(데이터 완성)≠REGISTRABLE_NOW(지금 등록 가능)**, 등록 직전 공급처 상태가 최종 게이트다.
2. 모델명·제조사 확인 — 공급처에 모델명 미게시면 제외(C5). 임의 생성 금지. 제조사는 공급처 페이지 '브랜드' 라벨 또는 준비 CSV 브랜드/제조사에서 근거 확보.
3. SW/하드웨어 판별 — C19 계약 적용(SW는 리프 50001516·DIGITAL_CONTENTS·DIRECT).
4. 카테고리 리프 확정 — 배치 검증 리프(50001516 소프트웨어·50004311 일렉기타·50007235 스피커액세서리·50002320 스피커단품) 또는 매핑 테이블 candidate. 동명 리프·자동차기기 리프는 C16 가드.
5. 원산지 코드 결정 — C18 계약(단일 국가=코드표 매칭, 복수 후보=04+공급처 원문). 코드표에 없는 국가는 `GET /v1/product-origin-areas` 라이브 조회.
6. 이미지 업로드 — `runPilotImageUpload`(execute ack), 반환 URL만 본문 사용.
7. payload 생성 → 등록 전 계약 검증(C2·C5~C10) → 중복조회 0건 확인.
8. `POST /v2/products`(비노출 SUSPENSION 등록) → 상품 단건조회로 판매상태·가격·재고·원산지 일치 검증(색인 지연으로 검색 검증 불가 — C14).
9. 장부 즉시 기록(등록 1건당).
10. 전시 ON — 별도 판매개시 결정으로 실행, PUT 전체 교체 계약(C13) + 불변 재조회 검증 → 장부 갱신.

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

### G. 정기 재고 점검·재고 동기화 실행(배치9 신설 — 운영화, 배치11 호스트 정리)
1. **읽기 점검(기본·쓰기 0)**: `node tools/naver/ncom-stock-sync.mjs compare` — 등록분 전수를 공급처 관측+원상품 GET으로 비교해 계획만 산출한다. 스케줄러 실행은 `--out-dir`로 저장소 밖 기록(작업트리 무변경). 기본 기록 위치는 `%LOCALAPPDATA%\CGI-Ncom-StockCheck`(래퍼), `CGI_NCOM_OUT_DIR`로 재정의 가능하다.
2. **정기 실행**: Task Scheduler `PADIEM-CGI1-LOCAL2-Ncom-StockCheck`(매일 07:30, 읽기 전용). **2026-10-30 실측: 이 작업의 실체는 Padiem-Command-Center(=COM1)에 있다**(2026-10-29 22:35 `limone` 등록, Interactive 로그온). 배치11에서 실행 경로를 본 클론 `E:\claw-apps-1027-2\kbs261022\tools\naver\run-stock-check.ps1`로 갱신하고 전수 시험 실행(349건 비교·쓰기 0)했다. 동명 작업이 CGI-1에도 있으나 자격증명 부재로 exit 1(호출 0회) — 양쪽 모두 읽기 전용이라 중복 실행의 원격 쓰기 위험은 없다. 단일 실행 잠금(`.ncom-stock-sync.lock`, 2시간 경과분 자동 해제)이 같은 호스트 중복을 방지한다.
3. **쓰기(수동 게이트만)**: `apply --plan <계획파일> --execute` — blocked·noop은 전송하지 않고, 수정은 전체 리소스 PUT(C13) → 재조회 검증 → 불일치 시 원본 값 자동 복원 → 전후 장부 기록. `revert --plan <계획파일> --codes ... --execute`는 장부 before 값 기반 원복이다. **C22 가드: `fallback_*`·출처 미기록 계획은 `blocked_by_source`로 기록만 하고 전송하지 않는다.**
4. 수량 출처 없는 변경은 계약 모듈이 차단한다(C21·E25) — CLI는 blocked 계획을 절대 전송하지 않는다. 배치9 실측: 326건 비교에서 blocked 273(수량 미공개)·noop 53·쓰기 0, E25 복원 168건 대조 168/168 일치. 배치11 실측: 349건 비교에서 blocked 296·noop 53·쓰기 0 — 등록 362건 기준 수치.
5. **동시 실행 금지**: 동일 스토어에 대해 두 호스트가 동시에 `apply`하지 않는다. 라이브 쓰기(apply)는 어느 호스트에서도 스케줄러로 실행하지 않는다 — 수동 게이트 전용이며, 배치11 실측 기준 양쪽 호스트의 예약 작업은 읽기 전용 1건씩뿐이다(E27 정정).

## 4. 다음 배치 공급·실행 게이트 — 요약(배치13·전수 분류 완료 기준, 2026-10-30)
배치11(2026-10-30, API 인증 복원·등록 재개 — 등록 13건, 누적 362) 기준 남은 공급:
- **API 인증·허용 IP — 해소**: Padiem-Command-Center에서 토큰 발급·허용 IP 라이브 검증 완료(E28 해소). 349건 가격 불변 재조회 349/349·재고 읽기 비교 쓰기 0도 동일 세션에서 수행.
- **배치12 완료(CTO 2026-10-30 지시)**: 교체용 바늘 8건(리프 50003154 오디오액세서리 — 라이브 categoryGet 확인) + '국내' 원산지 5건(E30 정규화 — **코드 '00 국산' 첫 실등록 수용 확인**, 원상품 GET으로 originAreaCode 00 저장 검증) 13건 전원 등록·전시 ON. 페이지의 국가 선택 목록(템플릿 공통 마커)과 제품 고유 원산지 근거를 구분해 판정한 근거는 `bulk/batch12_prep_20261030.json`의 `origin_evidence_markers`.
- **등록 후보 고갈**: 배치7 READY 재검증 미등록 74건은 배치11(13건)과 배치12(13건)로 전수 소화. **READY 계열 추가 등록 가능분 0** — 남은 공급은 아래 데이터 원천 해소 후에만 발생한다.
- **배치13(전수 분류 — 경로 계약 체인 확장분)**: 배치9~13 등록으로 성장한 '경로→리프' 계약이 배치7 미확정 카테고리 143건을 자동 해소 → 134건 실등록·전시 ON(누적 509). E31(원산지 한정사·미열거 복수)·특수문자 상품명 정규화 계약 추가. E32(분류기 리프 귀속 오류)는 인증 거부 가드로 발견·정정 — 스토어 영향 0.
- **전수 분류 완료(CTO 2026-10-30 지시)**: 4,575건 배타 분류 — 등록 509 + 중복 검토 2,018 + 가격 문의 1,440 + 카테고리 462 + 모델명 111 + 검토가드 26 + 해외 원산지 9 = 누락 0(`bulk/full_coverage_classification_20261030.csv`). 차단 풀 2,013건 라이브 재수집 — 자동 복원 0·삭제 0 확인.
- **모델명 미복구가 최대 병목(잔여 유일)**: 48건 — 공급처 원본에 모델 코드가 아예 없는 상품군(배치11 prep 제외 기록) — 임의 생성 금지 유지(C5). 재수집 원천 확보 필요
- **문의가 1,348 — 원천 차단(E26·E29) 유지**: 공급처 가격 비공개 + ERP API 자격증명 불신(로그인 1회 실패 후 재시도 금지). 원천 확보 시 배치9 대조 스크립트·증적 양식 재실행. 허위 가격 생성 금지 유지
- **'국내' 원산지 5건 — 배치12 등록 완료**: E30 정규화로 코드 '00 국산' 첫 수용 확인(5383) 후 전원 등록. 페이지 템플릿 국가 목록과 제품 고유 근거의 구분 판정은 배치12 증적 참조. 공급처 라벨의 실제 제조국 정확성에 대한 최종 책임은 사업자 항목으로 유지
- **카테고리 미확정 8 — 배치12 등록 완료**: 리프 50003154(오디오액세서리)로 등록(CTO 2026-10-30 지시, 라이브 categoryGet 확인)
- **검토가드 9**(잔금·결제창·예약금 상품명) + STOCK_UNKNOWN 잔여

실행 게이트는 §3 절차와 동일하며, 등록 직전 공급처 라이브 재검증·중복조회·원산지 결정(C18)이 상시 적용된다. 배치11처럼 이전 recheck 후보도 실행 시점에 전수 라이브 재판정한다(READY≠REGISTRABLE_NOW).

## 5. NOT_VERIFIED 목록 (검증 안 된 가정 — 완료로 주장하지 않는다)
| 항목 | 상태 |
| --- | --- |
| API 인증·IP 허용 | **해소(2026-10-30)** — Padiem-Command-Center에서 토큰 발급·API 호출 검증. CGI-1은 여전히 자격증명 부재 |
| 349건 라이브 불변 재검증 | **해소(2026-10-30)** — 가격 불변 349/349(원상품 GET vs 준비 CSV) + 재고 읽기 비교 349건 쓰기 0 + 상태 분포 일치(`bulk/price_invariance_349_20261030.json`·`bulk/stock_sync_plan_batch11_20261030.json`) |
| 정기 점검 실제 원격 비교 | **해소(2026-10-30)** — Padiem-Command-Center 예약 작업 경로 갱신 후 전수 시험 실행(349건·쓰기 0). CGI-1 쪽은 자격증명 부재로 여전히 미실행 |
| COM1 예약 작업 존재·중지 | **정정(E27)** — COM1=이 호스트 직접 확인. 쓰기 예약작업은 존재하지 않음(중지할 대상 없음), 읽기 전용 재고점검 1건만 존재 → 실행 경로 본 클론으로 갱신 |
| 소비자 화면(스토어프론트) 브라우저 E2E | WAF 차단으로 미검증 — API 전시 ON을 화면 검증 PASS로 쓰지 않는다(PR #136) |
| 재입고(재고 0→N) 실재입고 E2E | 미수행 — 계약만 문서화(C12 절차 C) |
| 네이버쇼핑 검색색인 반영 | 전시 ON 직후 미반영 확인 — 별도 판정 항목 |
| ERP(ecount) 실재고 연동 | `ecount.env`는 2026-10-29 로그인 1회 실패(비밀번호 1회 오류 안내) — 자격증명 불신, 재시도 금지(E29). 문의가 1,348건 가격 복구도 같은 원천 차단(대조 0건) |
| 스케줄러 라이브 쓰기 | 읽기 전용만 구성·검증(배치9) — 쓰기는 수동 게이트 유지가 의도된 설계(§3 절차 G) |
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
