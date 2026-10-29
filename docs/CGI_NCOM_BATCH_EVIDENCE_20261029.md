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
| **배치5(50건)** | `6ddd95e` 스택 | [#142](https://github.com/skerishKang/kbs261022/pull/142) | 70(선정 50+예비 20) | **50** | 결정론적 실패 2(3169·5383 원산지 미해소) + 시범 중 버그 2(재시도 성공) | 0(라이브 재검증에서 품절 전환 0) | 0 | E21(러너 원산지 결합 누락)·E22(복수 원산지) | C18(04+content)·C19(SW 재매핑) 계약 확립·resolveOriginArea 테스트 고정 | batch-contracts unit(+3) | `bulk/register_5th_batch_20261029.json` · `bulk/batch5_existing33_verify_20261029.json` |

배치4의 19건 구성: 1차 실행 18건 등록(장부 기록 포함) → 2146 등록 직후 크래시(장부 미기록) → 재실행에서 17건 DUPLICATE_BLOCKED(원격 존재 확인) + 2146 회수 + 신규 1건(3103) 등록 = 19. 증적 JSON의 `state` 분포: DISPLAYED 1 · DUPLICATE_BLOCKED 17 · FAILED_REGISTER 2.

배치5의 50건 구성: SW(전자배송) 22(리프 50001516 재매핑·DIGITAL_CONTENTS·DIRECT) + 하드웨어 28(유선마이크 19·블루투스스피커 1·레코딩장비 4·앰프 4). 원산지: 검증 코드 31 + 복수 원산지 04+content 19. 리프 계약: categoryGet 5종 확인(전원 kc_capable — 배치 확립 비대상 선언 계약 유지). 등록 평균 244ms/건, 재시도 0·타임아웃 0·중복 차단 0.

## 누적 장부 상태 (2026-10-29 배치5 완료, `ncom_registration_ledger.json` 83건)

| 구간 | 건수 | 비고 |
| --- | --- | --- |
| 파일럿 3건 | 3 | 13776583531/540/545 — 비노출 등록 후 전시 ON 최초 전환 |
| 배치2 | 2 | 13776685097·13776685126 |
| 배치3 | 9 | 판매중 5(소프트웨어) + 품절 4(K&M 스탠드 3·HK AUDIO 1) |
| 배치4 | 19 | 원상품번호 13776759782~13776764518 대역 — SALE 8·OUTOFSTOCK 11 |
| 배치5 | 50 | 원상품번호 13776938053~13776945898 대역 — 전원 SALE |
| **합계** | **83** | displayStatus ON 83/83 · mode=live · cgiId·상품번호 유일 |

기존 33건 불변 검증: 장부 행 원본 대조(HEAD 커밋본과 33행 완전 일치) + 원격 단건조회 33/33 정상(`bulk/batch5_existing33_verify_20261029.json`).

## 분류 체계 v2 스냅샷 (`bulk/taxonomy_v2_20261029.json`, 4,575건)

READY_SALE 116 · READY_OUTOFSTOCK 66 · STOCK_UNKNOWN 197 · NEED_PRICE 843 · NEED_CATEGORY 1,316 · NEED_REVIEW 5 · DUPLICATE 2,032 — 등록 가능 풀 182(단, 실등록 가능은 라이브 재검증 후 확정: READY 173 검증에서 REGISTRABLE_NOW 123 · SOLD_OUT_NOW 50).

## 배치5 준비 → 실행 결과 (2026-10-29)

준비물: `reports/data/registration/bulk/batch5_prep_20261029.json`(수정: 제조사 조인 키 정규화 — 선정 50+예비 20, 후보 70건 전원 READY_SALE)

| 실행 결과 | 값 |
| --- | --- |
| 신규 등록 | **50/50 등록·전시 ON**(SW 22 + 하드웨어 28) |
| 원산지 | 검증 코드 31 + 복수 원산지 04+content 19(C18) |
| 실패·복구 | 결정론적 실패 2(원산지 미해소, 예비로 대체) + 시범 중 러너 결함 2(수정 후 재시도 성공 — E21) |
| 성능 | 등록 평균 244ms/건 · 재시도 0 · 타임아웃 0 · 중복 차단 0 · 이미지 실패 0 |
| 기존 33건 | 장부 행 원본 대조 완전 일치 + 원격 단건조회 33/33 정상(가격·재고·전시 ON) |
| 소비자 화면 | **NOT_VERIFIED** — 스토어·상품 URL 모두 네이버 로그인 장벽(자동 로그인 금지) |

### 후속 100건 확대에 필요한 공급 산출(CTO 요청)

| 공급원 | 건수 | 조건 |
| --- | --- | --- |
| 즉시 실행 가능(배치5 미사용 예비) | **18** | 실행 직전 공급처 재검증 필수 |
| 리프 확정 시 가용(자동차기기 의미 검토분) | 19 | 운영자 리프 확정(C16 가드 해제) |
| 모델명 재수집 필요 | 95(READY_SALE 39·READY_OUTOFSTOCK 56) | 공급처 원본 재수집 |
| STOCK_UNKNOWN | 197 | ERP 연동 또는 공급처 재조회 |
| NEED_PRICE·NEED_CATEGORY | 843·1,316 | 가격 확정·리프 확정 |

실행 안정성: 5차 배치 50건에서 러너 크래시·타임아웃·중복·이미지 실패 0, 등록 성공률 50/52 시도(96%, 실패 2건은 사전검증 결함으로 데이터 원인) — 청크 실행(10건)+장부 즉시 기록+복구 계약(C15)의 반복 가능성 실증. 100건 확대 시 즉시 가용 18건 후 모델명 재수집·리프 확정이 병목이며, 실행기·계약은 추가 개발 없이 재사용 가능.

## 롤백·재실행 표준(배치 공통)
1. 크래시·타임아웃·중단: 재등록 금지 → 판매자코드 재조회 → 발견분 장부 복구(adopt) → 미발견분만 재시도(C15·절차 E).
2. 등록 완료분의 롤백은 없다 — PUT 수정 또는 전시 SUSPENSION 전환으로 대응(Runbook §6).
3. 배치 재실행은 장부 조인으로 미등록만(배치4 멱등성 실증: 중복 차단 17건).
