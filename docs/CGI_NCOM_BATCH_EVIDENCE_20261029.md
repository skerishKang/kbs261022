# #130 배치 증적 수량표 — 파일럿 ~ 4차 배치 + 배치5 준비 (2026-10-29)

> #130 레인의 배치별 실행 기록이다. 계약·절차는 [운영 Runbook](CGI_NCOM_RUNBOOK_20261029.md),
> 오류별 상세는 [오류·교훈·위험 레지스터](CGI_NCOM_ERROR_REGISTER_20261029.md)에 있다.
> 모든 수치는 커밋된 증적 JSON의 실측값이다. **누적 실등록 33건, 전 건 전시 ON, 라이브 쓰기 이슈 없음.**

## 배치별 수량표

| 배치 | main SHA | PR | 후보 | 신규 등록 성공 | 실패·제외 | 품절 등록 | 중복 차단 | 주요 오류(코드) | 조치 | 회귀 테스트 | 증적 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 파일럿 3건(비노출 등록+전시 ON) | `fcd18a4` 스택 | [#135](https://github.com/skerishKang/kbs261022/pull/135)·[#136](https://github.com/skerishKang/kbs261022/pull/136) | 3 | **3** | 0 | 0 | —(사전 0히트) | E1~E7(원산지 400·MIME 400·고시 누락·배송없음 금지 등, v2→v5 4차 시도) | §2 C1~C9 계약 확립 | ncom.test·mime·upload-response·pipeline e2e | `live/register_latest_20261029.json`(naver 6회)·`live/display_activation_20261029.json`(9회)·`live/pilot_*` |
| 검증 배치(payload만, 등록 0건) | #137 스택 | [#137](https://github.com/skerishKang/kbs261022/pull/137) | 2(+K&M 3 제외) | **0**(productRegister 미호출) | K&M 3(공급처 품절) | 0 | 0 | E13(수집 재고 낡음)·E17(잔금 결제창) | 라이브 재검증 게이트·NEED_REVIEW 가드 신설 | taxonomy 규칙 | `bulk/validation_batch_20261029.json`(naver 4회, 계약 13항목 통과) |
| 배치2 | #138 스택 | [#138](https://github.com/skerishKang/kbs261022/pull/138) | 2 | **2**(2098→13776685097·3965→13776685126) | 0 | 0 | 0 | E9(manufacturer NotNull)·E10(KC 동시 전송 거부) | C5·C6 계약 확립 | payload 계약 검증 | `bulk/register_2nd_batch_20261029.json`(naver 14회) |
| 배치3(판매중 5 + 품절 4) | #139 스택 | [#139](https://github.com/skerishKang/kbs261022/pull/139) | 10(제외 1) | **9** | 1(3678 모델명 미게시) | **4**(OUTOFSTOCK) | 중복조회 10건 0히트 | E11(NumberMin)·E12(OUTOFSTOCK 거부)·E14(오매핑 회귀) | C10~C12 계약 확립·리프 교정 5건 | batch-contracts unit(신설) | `bulk/register_3rd_batch_20261029.json`(naver 54회)·`bulk/register_zero_stock_batch_20261029.json`(32회) |
| 배치4(20건 계획) | `a50ddd9` | [#140](https://github.com/skerishKang/kbs261022/pull/140) | 20 | **19** | 2(4057·4058 — `etc.modelName` NotNull "데이터를 입력해 주세요.") | 11(OUTOFSTOCK) | **17**(멱등 실증) | E16(2146 등록 직후 크래시) | 크래시 복구 계약 실증(13776759782 회수) | batch-recovery e2e(신설) | `bulk/register_4th_batch_20261029.json`(등록 309ms×1건·재시도 0·타임아웃 0) |

배치4의 19건 구성: 1차 실행 18건 등록(장부 기록 포함) → 2146 등록 직후 크래시(장부 미기록) → 재실행에서 17건 DUPLICATE_BLOCKED(원격 존재 확인) + 2146 회수 + 신규 1건(3103) 등록 = 19. 증적 JSON의 `state` 분포: DISPLAYED 1 · DUPLICATE_BLOCKED 17 · FAILED_REGISTER 2.

## 누적 장부 상태 (2026-10-29, `ncom_registration_ledger.json` 33건)

| 구간 | 건수 | 비고 |
| --- | --- | --- |
| 파일럿 3건 | 3 | 13776583531/540/545 — 비노출 등록 후 전시 ON 최초 전환 |
| 배치2 | 2 | 13776685097·13776685126 |
| 배치3 | 9 | 판매중 5(소프트웨어) + 품절 4(K&M 스탠드 3·HK AUDIO 1) |
| 배치4 | 19 | 원상품번호 13776759782~13776764518 대역 — SALE 8·OUTOFSTOCK 11 |
| **합계** | **33** | displayStatus ON 33/33 · mode=live · cgiId 키 유일 |

장부 33건 전 건을 taxonomy v2와 조인해 확인했다(키 정규화 후 미매칭 0): DUPLICATE 14 · READY_OUTOFSTOCK 10 · READY_SALE 9. 33건 불변 검증은 PR마다 단건조회로 이행(#138·#139·#140 각 "기존 등록 불변" 확인).

## 분류 체계 v2 스냅샷 (`bulk/taxonomy_v2_20261029.json`, 4,575건)

READY_SALE 116 · READY_OUTOFSTOCK 66 · STOCK_UNKNOWN 197 · NEED_PRICE 843 · NEED_CATEGORY 1,316 · NEED_REVIEW 5 · DUPLICATE 2,032 — 등록 가능 풀 182(단, 실등록 가능은 라이브 재검증 후 확정: READY 173 검증에서 REGISTRABLE_NOW 123 · SOLD_OUT_NOW 50).

## 배치5 준비 (2026-10-29 — 실등록 0건·라이브 호출 0건)

산출물: `reports/data/registration/bulk/batch5_prep_20261029.json` (생성 스크립트는 작업공간 scratch — 커밋 대상 아님)

| 항목 | 값 |
| --- | --- |
| 기준 | main `a50ddd9` · 장부 33건 대조 완료(`.co.kr` 키 정규화 조인, 미매칭 0) |
| READY 풀 | 182(READY_SALE 116 + READY_OUTOFSTOCK 66) |
| 기등록 제외 | 19건(배치4분 — taxonomy 생성이 배치4 이전이라 상태 잔존, 장부 조인으로 제외) |
| 모델명 미수집 제외 | 74건(E15 계약 — 임의 생성 금지; **품절 후보는 전량 여기서 제외**) |
| 카테고리 의미 검토 분리 | 19건(자동차기기 상위 경로 리프 — E14 가드, 운영자 리프 확정 전 등록 금지) |
| **최종 후보** | **70건 전원 READY_SALE** — 선정 50건 + 예비 20건 |
| 원산지 코드 | 검증 코드표 사용 가능 9건 · NEED_ORIGIN_LOOKUP 61건(실행 시 `GET /v1/product-origin-areas` 라이브 조회) |
| 리프 출처 | auto_candidate 70건(매핑 테이블 candidate) — 배치 검증 리프 풀은 기등록/모델명 미수집으로 소진 |
| 실행 게이트 | ① 등록 직전 공급처 라이브 재검증(준비물의 공급처 상태는 2026-10-29T05:16Z 기준) ② 등록 직전 중복조회 ③ 모델명·제조사 재확인 ④ 원산지 라이브 조회 ⑤ 품절분 상태머신 ⑥ 장부 즉시 기록·크래시 복구 계약 |

정직 제한: 후보 70건의 공급처 상태는 2026-10-29 오전 라이브 재검증(173건) 근거의 재사용이다 — 실행 시점 재검증 전에는 REGISTRABLE_NOW로 주장하지 않는다. 배치5 실행은 본 세션 범위 밖이다.

## 롤백·재실행 표준(배치 공통)
1. 크래시·타임아웃·중단: 재등록 금지 → 판매자코드 재조회 → 발견분 장부 복구(adopt) → 미발견분만 재시도(C15·절차 E).
2. 등록 완료분의 롤백은 없다 — PUT 수정 또는 전시 SUSPENSION 전환으로 대응(Runbook §6).
3. 배치 재실행은 장부 조인으로 미등록만(배치4 멱등성 실증: 중복 차단 17건).
