# 페이앱 도입 기술 준비 상태 — 기존 CGI 결제 시스템 최소 수정 전환 검토표

- 작성: 2026-10-27 (KST), CGI LOCAL
- 이슈: #106 (2차) · 관련 #67 #71 · 1차 근거: [payapp-feasibility.md](./payapp-feasibility.md) · 비용: [pg-cost-comparison.md](./pg-cost-comparison.md)
- 기준 커밋: main `0b84dc7`
- 이 문서의 한계 선언: **페이앱 연동을 "완료"라고 주장하지 않습니다.** 아래 5장까지가 실제 상태이고, 6장이 남은 작업입니다.

## 1. 이번 차수에 실제로 추가한 것

- `backend/lib/pg-payapp.mjs` — 페이앱 **프로토콜 계층**(순수 함수, 네트워크 호출·저장·상태 결정 없음)
- `backend/test/unit/pg-payapp.test.mjs` — 그 계층의 **계약 테스트 18건**

기존 파일은 하나도 고치지 않았습니다(`backend/worker.js`, `backend/lib/pg.mjs`, `site/**`, 스키마 모두 무변경). 열려 있는 PR #83이 `backend/worker.js`와 `backend/test/e2e/admin.test.mjs`를 동시에 만지므로, 충돌을 피하려면 **지금 단계에서 worker.js를 건드리면 안 됩니다**.

### 검증 결과(측정)

| 항목 | 결과 |
| --- | --- |
| 신규 계약 테스트 | **18 pass / 0 fail** (`node --test --experimental-sqlite test/unit/pg-payapp.test.mjs`) |
| 백엔드 전체 스위트 | **514 pass / 0 fail** (`npm test`, 기존 496 + 신규 18) — 회귀 0건 |
| 변형(mutation) 검사 | **11개 전부 포착**: 해시 공식 순서 변경 / 부분취소 플래그 고정 / 부분취소 초과환불 차단 제거 / webhook 금액 검사 제거 / webhook 해시 검사 제거 / 중복키에서 상태 무시 / 재전송 허용창 15분→15시간 / 최소결제액 검사 제거 / https 요구 제거 / var1에 주문번호 미탑재 / SUCCESS ack 변경. 복원 후 바이트 동일, 재실행 GREEN |
| Secret 스캔 적합성 | 테스트 상수는 `unit-link-key-0001` 형태(CI의 `sk_live_/sk_test_/gsk_live_/gck_live_/Bearer +20자` 패턴에 걸리지 않음) |

## 2. 기존 토스 어댑터 구조 (실측)

`backend/lib/pg.mjs`(260줄)가 이미 어댑터입니다.

- 팩토리: `createPgAdapter({secretKey, mode, baseUrl, fetchFn})` (:256) → `resolvePgMode`(:30)가 `live_`/`test_` 접두와 mock을 판정
- 인터페이스(두 구현 공통): 필드 `provider, mode, sandbox, live` / 메서드 `confirm({paymentKey, orderId, amount, idempotencyKey})`(:89), `cancel({paymentKey, cancelAmount, cancelReason, idempotencyKey, refundReceiveAccount})`(:101), `fetchByPaymentKey(paymentKey)`(:114), `fetchByOrderId(orderId)`(:119)
- **토스 전용 부분**: `PG_PROVIDER`(:14), `TOSS_PUBLIC_BASE_URL`(:15), Basic 인증 `basicAuth`(:18, 시크릿 뒤에 콜론), JSON 본문 + `Content-Type: application/json`(:65,:71), `Idempotency-Key` 헤더(:70), 경로 4종(`POST /v1/payments/confirm`, `POST /v1/payments/{key}/cancel`, `GET /v1/payments/{key}`, `GET /v1/payments/orders/{orderId}`), `readJson`(:47)
- **PG 무관 부분**: `PgError(status, code, message, detail)`(:37), 인자 검증, `cgi:confirm:` / `cgi:cancel:` 멱등 키 문자열 템플릿

`backend/worker.js`의 결제 경로(줄 번호 실측):

| 지점 | 줄 | 내용 |
| --- | --- | --- |
| 어댑터 생성 | 2120 | `createPgAdapter({secretKey: env.TOSS_WIDGET_SECRET_KEY, mode: env.PG_PROVIDER_MODE})` — **`baseUrl`를 넘기지 않음** |
| 주문 멱등 생성 | 381 | 이미 생성된 주문은 `idempotent: true`로 재사용 |
| confirm 진입 | 543 | kind(:551)·종료상태(:554)·**already_paid/idempotent 재전송(:557–568)** |
| **금액 검증** | 572–584 | `body.amount !== order.total_amount` → 400 `amount mismatch` + `{expected, received}` |
| paymentKey 재사용 차단 | 586–592 | `payment_key_reused` 409 |
| 고객 보고 실패 우선 처리 | 595–603 | PG를 호출하지 않고 실패 기록 |
| PG 승인 호출 | 608–615 | `idempotencyKey: cgi:confirm:${order.id}:${paymentKey}` |
| payments 기록 + 감사 | 667 → 672–706 | `INSERT OR REPLACE INTO payments`(:678에 `provider \|\| 'tosspayments'`), `order_events` `payment_confirmed` actor=`'pg'`(:692) |
| 환불 진입 | 838 | `refundable = payment.balance_amount`(:842), `MIN_PARTIAL_REFUND`=1000(:92,:847–857) |
| **초과 환불 차단** | 859 | `Math.min(requested, refundable)`, 환불가능액 없으면 409(:883) |
| **환불 멱등** | 863–881 | `order_events`의 `json_extract(meta,'$.reason')`로 동일 요청 재처리 방지 |
| **부분환불 누적** | 929–936 | `refunded_amount + cancelAmount` → `refunded`/`partial_refunded` |
| ERP 전송 | 972 | `{...order, pg_provider: 'tosspayments', pg_provider_mode: mode}` — **하드코딩** |

PG 사를 지칭하는 리터럴: `worker.js:678`, `worker.js:972`, `schema.sql`/`0001` migration의 `DEFAULT 'tosspayments'`, `worker.js:2120`의 `TOSS_WIDGET_SECRET_KEY`, `site/config.js:21-22`, `cgi-order.js:14-15,268-298,387-433`. 그리고 `wrangler.toml:61`의 `PG_PUBLIC_BASE_URL`은 **어디서도 읽지 않는 죽은 설정**입니다(주석 `worker.js:46`이 언급하는 `TOSS_API_SECRET_KEY`도 마찬가지 — 코드에서 사용 0건).

클라이언트: 결제창은 추상화가 없습니다. `renderPayment`(:215)과 `renderRepayPayment`(:369)가 `window.TossPayments(...).widgets()`를 인라인으로 쓰고, 성공 시 `?toss=success` 리다이렉트를 `handleTossRedirect`(:455)가 처리합니다. **환불 UI는 이미 추출돼 있습니다** — `site/assets/js/cgi-refund.js`가 `buildRefundRequest`/`MIN_PARTIAL_REFUND`를 export하고 `site/test/cgi-refund.test.mjs`가 단위 테스트합니다.

D1 `payments`(`backend/schema.sql:124–145`): `payment_key UNIQUE NOT NULL`, `provider TEXT NOT NULL DEFAULT 'tosspayments'`, `provider_mode`, `pg_order_id`, `amount/supplied_amount/vat/method/status/requested_at/approved_at/balance_amount/cancel_amount/failure_code/failure_message/raw`. 조회는 전부 `payment_key` 단일 키이고 **(provider, payment_key) 복합 키가 없습니다**. 페이앱의 `mul_no`(PG 결제요청번호)와 `var1`(우리 주문번호)는 전용 열이 없어 현재로선 `raw`에 묻힙니다.

## 3. 페이앱 규약과 우리 코드의 차이 (문서 기준)

| # | 차이 | 영향 | 처리 방향 |
| --- | --- | --- | --- |
| 1 | FORM POST + URL-encoded 응답(JSON 아님) | `readJson`·`JSON.stringify` 재사용 불가 | `encodeForm`/`parseResponse`/`decodeResult` 추가(완료) |
| 2 | 인증 = `sha256(userid+requestdate+requestkey)`, ±15분 | Basic/Idempotency-Key와 무관. **시간 의존** | `payappHash`/`formatRequestDate`(KST)/`isDateFresh` 추가(완료) |
| 3 | **결제 상태 조회 API가 없음** | `fetchByPaymentKey`/`fetchByOrderId` 대응물 없음. 기존 confirm 직후 응답 확정 흐름이 성립하지 않음 | 인터페이스에 `supportsStatusQuery: false`를 명시하고, 상태 진실은 webhook 검증 결과로만 갱신 |
| 4 | 결제창이 호스팅 `payurl` | 위젯 인라인 UI와 다름 | `renderPayment`/`renderRepayPayment` 분기 필요(미착수) |
| 5 | 주문번호는 `var1`로만 왕복 보장 | `pg_order_id`/`payments.id` 매핑 규칙 필요 | `buildPayRequest`가 `var1 = orderId`로 고정(완료) |
| 6 | webhook 재전송·중복("여러번 호출될 수 있음") | 중복 승인·중복 환불 위험 | `feedbackDedupeKey(mul_no, pay_state)` + 기존 `order_events` 멱등 재사용(키 생성 완료, 배선은 미착수) |
| 7 | webhook 서명 = `sha256(userid+responsedate+requestkey)` | 위변조 방어 지점 | `verifyFeedback` 구현·테스트(완료) |
| 8 | 가상계좌 취소 불가, 휴대폰 당월만 | 환불 UI가 잘못된 약속을 함 | `REFUND_UNSUPPORTED_TYPES` 노출(완료) — UI 반영은 미착수 |
| 9 | 최소 결제액 1,000원 / https 강제 | 주문·리다이렉트 실패 사유 | `buildPayRequest`가 로컬에서 차단(완료) |
| 10 | 정산 후 취소는 반환금 선입금 | 자동 환불 파이프라인(ERP 동보 포함)에 인간 단계 필요 | 정책 결정 후 구현(미착수) |

## 4. webhook 유실 복구 설계 (조회 API 부재에 대한 답)

페이앱 문서에는 거래 상태를 서버로 되묻는 명령이 없습니다. 따라서 "유실 = 영구 미확정"이 되지 않게 **우리 대조부 근거만으로 복구**하는 순서를 설계안으로 박습니다.

1. **1차 — 수락 보장**: `feedbackurl` 핸들러는 검증·처리에 실패하면 `SUCCESS`를 반환하지 않습니다. `checkretry=y`이면 페이앱이 재전송하므로, "처리에 실패한 요청은 ack하지 않는다"가 첫 방어입니다(현 구현부는 미착수라 ack 규칙을 테스트로 고정해야 합니다).
2. **2차 — 우리 대조부**: `payments.raw`가 아니라 전용 필드에 `mul_no`를 저장하고, 관리자 화면에 "승인 요청했으나 미확인" 목록을 냅니다(`unreconciledOrders`가 그 집합 계산의 순수 함수로 존재).
3. **3차 — 사람 판정**: 페이앱 관리자 '결제 현황' 화면(문서에 API가 아니라 화면으로 존재)에서 대조 후, 주문 상태를 수동 확정하거나 재조회합니다. 이 단계가 남는다는 것이 **조회 API 부재의 실제 비용**입니다.
4. **금지**: 클라이언트가 "결제 성공"을 보고한 것만으로 주문을 `paid`로 만들지 않습니다. 현재 토스 흐름에도 없는 원칙이고, 페이앱에서는 확인할 수단이 없어 더 위험합니다.
5. 상태 불일치 감지를 위해 `order_events`에 `payment_pending_reconciliation` 이벤트를 추가하고, 일정 시간 경과 미확인 주문은 관리자 알림으로 올립니다(기존 알림 레인과 무관하므로 별도 결정).

## 5. PG를 설정값으로 분리하는 최소 변경안

**권장 순서와 각 단계의 검증 가능 여부**를 명시합니다. "지금 할 수 있는 것"과 "계정 없이는 못 하는 것"을 섞지 않습니다.

| 단계 | 변경 파일 | 내용 | 자격증명 없이 검증 |
| --- | --- | --- | --- |
| 0 | `backend/lib/pg-payapp.mjs` | 프로토콜 계층(완료) | **O** — 18건 |
| 1 | `backend/lib/pg.mjs` | 어댑터 팩토리에 `provider` 인수 추가 + `baseUrl`/시크릿 묶음을 `PgConfig`로. 기존 `createPgAdapter` 시그니처는 유지하고 overload | **O** — 기존 496건 + `pg.test.mjs`가 회귀망 |
| 2 | `backend/lib/pg-payapp.mjs` | `createPayappPgAdapter(cfg, fetchFn)` — `confirm`은 **웹hook 대기 상태를 반환**(승인 확정 없음), `cancel`은 `paycancel` 호출, `fetchBy*`는 명시적 `unsupported` | **O** — `fetchFn` 주입으로 mock 전송 |
| 3 | `backend/worker.js` | 어댑터 선택을 `env.PG_PROVIDER`(:2120)로. `provider` 리터럴 2곳(678, 972)을 어댑터 값에서. **신규 라우트 `POST /api/payments/payapp/feedback`** | 부분 — `makeEnv({PG_PROVIDER:'payapp', ...})`로 in-process e2e 가능. 단 webhook 시그니처는 로컬 생성으로만 검증 |
| 4 | `backend/schema.sql` + migration | `payments.mul_no`, `(provider, payment_key)` 복합 인덱스, 상태 `awaiting_provider_confirmation` | **O** — D1 shim e2e |
| 5 | `site/config.js`, `cgi-order.js` | `PG_PROVIDER`별 결제창 분기(`payurl` 리다이렉트), `?toss=success` 후속 처리 분리 | O — 정적 검사와 `cgi-refund.test.mjs` 방식 재사용 |
| 6 | 실제 연동 | 4종 시크릿 등록, `feedbackurl` https 공개 경로, 업종 심사, 1,000원 실결제 1건 | **X** — 계정 필요 |

단계 6까지 끝나기 전에는 어떤 PR도 "페이앱 연동 완료"라고 쓰지 않아야 합니다. 단계 1~5는 코드와 테스트로 남길 수 있지만, **3·4·5는 worker.js와 site를 건드리므로 PR #83 병합 후**에 착수하는 것이 소유권 원칙에 맞습니다.

## 6. 남은 작업 (완료 기준으로 나열)

1. PR #83 병합 후 worker.js 배선(단계 1~5) — 충돌 회피 위해 순서 대기
2. 페이앱 4종 시크릿 발급(대표님) 후 실환경 1건 결제 → webhook 규약 실측(`SUCCESS` ack, 재전송 간격, 해시 대상 필드 실제 값)
3. `mul_no` 열 추가 migration과 대조 목록 화면
4. 환불 제약 노출: 가상계좌는 환불 버튼 비활성, 휴대폰은 당월 제한
5. NICEPAY를 택할 경우 이 문서의 3~5장을 NICE 규약으로 다시 써야 합니다(토스와 가장 가까운 구조라 재사용 비중이 클 것으로 예상됨, 미측정)

## 7. 이 문서가 검증한 것과 하지 않은 것

검증한 것: 페이앱 문서에 적힌 인코딩·해시·필드·상태 코드·멱등·금액·취소 semantics를 코드 한 파일로 박았고, 그 18건이 11종 변형을 모두 잡으며, 백엔드 514건이 그대로 녹색입니다.

검증하지 않은 것: 페이앱이 **이 요청을 실제로 수락하는지**, 재전송 간격과 ack 실패 시 동작, 필드 추가(문서에 "기능 추가에 따라 필드가 추가될 수 있습니다" 경고), 정산 후 취소의 반환금 절차, 그리고 비용 비교의 모든 요율 조건(→ [pg-cost-comparison.md](./pg-cost-comparison.md) 8장).
