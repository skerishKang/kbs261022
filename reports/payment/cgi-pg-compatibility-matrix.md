# CGI 결제 시스템 × PG 호환성 매트릭스 (2026-10-27)

- 작성: 2026-10-27 (KST), CGI LOCAL · 이슈 #106
- 코드 기준: main `0b84dc7`, 실측 파일 `backend/lib/pg.mjs`(260줄)·`backend/worker.js`(2,482줄)·`backend/schema.sql`·`site/assets/js/cgi-order.js`(501줄)·`site/config.js`
- 프로토콜 코드(이번·이전 차수): `backend/lib/pg-payapp.mjs` + 계약 테스트 18개(PR #111), `backend/lib/pg-nicepay.mjs` + 계약 테스트 15개(PR #113)
- 판정 기준(#106 지시): **PASS** = 공식 API 계약과 CGI 구조 호환을 확인하고 테스트 가능한 항목까지 검증. **CONDITIONAL** = 연동 가능하나 계약·키·정산 조건 등 추가 입력 필요. **FAIL** = 공식 API·운영 구조가 요건과 맞지 않음(근거 필수). **서류·키 부재를 기술적 불가능으로 판정하지 않습니다.**

## 1. 기존 코드의 사실 (재사용 기반)

| 계층 | 실측 | 재사용 판정 |
| --- | --- | --- |
| 어댑터 | `createPgAdapter({secretKey, mode, baseUrl, fetchFn})`(`pg.mjs:256`) → `{provider, mode, sandbox, live, confirm, cancel, fetchByPaymentKey, fetchByOrderId}` | **재사용** — PG추가지 엔진신설 아님 |
| 상태 판정 | `resolvePgMode`(`:30`), `PgError(status, code, message, detail)`(`:37`) | **PG 무관** |
| 승인 흐름 | `worker.js:543 confirmPayment` → 금액검증(`:572-584`) → `pg.confirm`(`:608-615`) → `recordPaymentOutcome`(`:667`) | **재사용**(단 승인 시점의 의미가 PG마다 다름 → 3장) |
| 환불 | `worker.js:838 cancelPayment`, `Math.min(requested, refundable)`(`:859`), `order_events` 기반 환불 멱등(`:863-881`), 누적(`:929`) | **재사용** |
| 멱등 키 | `cgi:confirm:${orderId}:${paymentKey}`, `cgi:cancel:${paymentKey}:${reason}` | **재사용**(공급자 헤더와 무관하게 우리 이벤트 키로 성립) |
| 스키마 | `payments(payment_key UNIQUE, provider DEFAULT 'tosspayments', balance_amount, cancel_amount, raw, …)` | **확장 필요**(`mul_no`/`tid`, `(provider,payment_key)`) |
| 프런트 | `cgi-order.js` 위젯 2곳(`:275-298`, `:387-433`), `?toss=success`(`:455`), `site/config.js:21-22` | **분기 필요** |
| 환불 UI | `site/assets/js/cgi-refund.js`(이미 추출됨 + 단위테스트 존재) | **재사용** |
| 테스트 | `backend/test/e2e/payments.test.mjs` 등 **기존 496개**, `test/helpers.mjs`의 `makeEnv()`가 `PG_PROVIDER_MODE:'mock'`으로 in-process 호출 | **재사용** — 새 PG도 같은 방식으로 계약 테스트 가능 |
| 죽은 설정 | `wrangler.toml:61 PG_PUBLIC_BASE_URL`(미사용), `TOSS_API_SECRET_KEY`(주석에만 존재) | **배선 시 정리 대상** |

## 2. 호환성 매트릭스 (10축 × 7후보)

범례: **○** 확인(근거 있음) · **△** 조건부/부분 · **✗** 문서상 없음 · **?** 미확인

| 축 | 토스(현행) | NICEPAY | 페이앱 | KG 이니시스 | NHN KCP | 네이버페이 주문형 | 포트원 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 Pages 프런트 호환 | ○ | ○(JS SDK `AUTHNICE.requestPay`, returnUrl POST) | △(호스팅 `payurl` 리다이렉트) | ? | ? | △(채널 규약 따름) | ○(위젯·원라인) |
| 2 Worker에서 서버 호출 | ○ | ○ JSON REST `Basic/Bearer` | ○ 단 **FORM POST + querystring 응답** | ? | ? | ? | ○ REST API |
| 3 D1 주문·결제 재사용 | ○(현행) | ○(`toCgiOutcome` 매핑 코드 존재) | △(`suppliedAmount/vat` 대응 필드 없음) | ? | ? | △(주문 모델 상이) | ○(하위 PG 투과) |
| 4 PC·모바일 결제창 | ○ | ○ Server/Client 승인 모델 | ○(모든 환경 표기) | ? | ? | △ | ○ |
| 5 승인 + **거래조회** | ○ | ○ `GET /v1/payments/{tid}`, `/find/{orderId}`, `POST /v1/check-amount/{tid}` | **✗ 문서에 조회 명령 없음**(cmd 전집합 확인) | ? | ? | ? | ○(통합 조회) |
| 6 전액취소·부분환불 | ○(#71 실증) | ○ `cancelAmt` 누락=전액, `balanceAmt`, `canPartCancel` (**샌드박스는 부분취소 불가**) | ○ `partcancel` 0/1 + `cancelprice` | ? | ? | ? | ○ |
| 7 중복결제·중복환불 방지 | ○(기존 로직) | ○ "결제된 orderId 재호출 불가" 명문 + 우리 멱등 | △(문서에 공급자 규칙 없음 → **우리 `feedbackDedupeKey`가 필수**) | ? | ? | ? | ○ |
| 8 Webhook 서명·유실 복구 | ○ | ○ `sha256(tid+amount+ediDate+SecretKey)` + **200/"OK"/text/html** + 재전송 기능 | △ `sha256(userid+responsedate+requestkey)` 검증 가능, **유실 시 복구 API 없음** | ? | ? | ? | ○ |
| 9 Sandbox·무청구 테스트 | **○(#71 실증)** | **○ 공식 샌드박스**, sandbox-api 호스트, 웹훅 TEST | **✗ 없음** — 실승인 후 10분 자동취소 | ? | ? | ? | ○ 데모/테스트 모드 |
| 10 기존 로그인·주문·견적 유지 | ○ | ○(라우트 추가 없이 어댑터 확장) | ○(단 webhook 라우트 신설) | ? | ? | △(채널 주문 유입 시 중복 리스크) | ○ |

`?`는 **조사 미완**이지 부적합이 아닙니다. KG·KCP는 이번 수집에서 개발문서(URL 404·경로 미확보)를 확보하지 못해 판정 보류로 남깁니다.

## 3. 판정 (PASS / CONDITIONAL / FAIL)

| 사업자 | 판정 | 근거와 조건 |
| --- | --- | --- |
| **NICEPAY** | **PASS(프로토콜 검증 완료) + CONDITIONAL(운영은 계약 후)** | 공식 매뉴얼의 승인·취소·**조회**·금액검증·웹훅 규약을 코드로 박아 **15개 계약 테스트 통과**, 백엔드 529개 무회귀, 변형 13종 전부 포착. 운영 키·가맹 계약·**샌드박스에서 부분취소 검증 불가**가 남은 조건 |
| **토스페이먼츠** | **PASS(현행, 검증 완료)** | #71에서 Sandbox 결제창·승인·취소·부분환불 E2E 실증. 코드 유지. 고정비 330,000원/연 110,000원이 유일한 결격 |
| **포트원** | **CONDITIONAL** | 중계 API·데모 모드 존재, 월 순거래액 5천만원 미만 SaaS 요금 0원. 단 **하위 PG 계약이 별도로 필요**하고 그 비용·정산이 실제 결정 변수 |
| **페이앱** | **CONDITIONAL(기술) / FAIL(운영 안전성)** | 기술: FORM POST·서명·멱등·부분취소를 **18개 계약 테스트로 검증**(`pg-payapp.mjs`). **FAIL 근거**: ① 결제 상태 조회 API가 매뉴얼 `cmd` 전집합에 없음 → `fetchByPaymentKey`/`fetchByOrderId` 대응 불가, webhook 유실 시 플랫폼 복구 수단 없음 ② **실결제 없는 테스트 환경 없음** ③ **가상계좌 취소 불가** ④ 정산 후 취소는 반환금 선입금 ⑤ 건당 50만원/월 500만원 보험 트리거가 CGI 상품구조상 기본 발동 |
| **네이버페이 주문형** | **CONDITIONAL(채널로)** | PG가 아니라 주문관리·정산이 네이버로 들어오는 채널. **주문관리수수료 0.99% VAT 포함**이 결제수수료에 추가되어 일반등급 실효 ≈4.73%(3사 대비 +1%p). 자사몰 API 규약은 이번 수집에서 확정 못 함 |
| **KG 이니시스** | **CONDITIONAL(미실사)** | 공식 요금표에 등록비·연관리비 **"면제~300,000원(VAT 별도)"** 및 **보증보험대체비용 34,500~344,000원(VAT 포함)** 구간이 명시되어 비용 가능성은 확인. 단 개발문서·API 규약을 확보하지 못해 연동 판정 유보 |
| **NHN KCP** | **CONDITIONAL(미실사)** | 직접 가입 요율·개발문서 미확보. 확보된 수치는 **호스팅사 경로**(godo: 초기 22만 면제 이벤트·연관리비 평생 면제·카드 3.4% / wepas: 가입비 165,000 VAT 포함, 매출구간 1.6~3.2%)로, **CGI는 독립몰이라 직접 가입 조건과 다를 수 있습니다** |

## 4. 전환 시 변경 범위 (개발자 추정)

| 대상 | 파일·함수 | 규모 | 검증 방법 |
| --- | --- | --- | --- |
| **NICEPAY** | `pg.mjs`에 `createNicepayPgAdapter()` 추가(기존 `pg-nicepay.mjs` 함수 재사용) + `worker.js:2120` 어댑터 선택 + `:678`·`:972` provider 리터럴 + webhook 라우트 1개 + migration(`tid`/`mul_no`, `(provider,payment_key)`) | **중** — 인터페이스가 이미 맞고 조회 API가 있어 폴백 로직 불필요 | 기존 e2e 496개 + `makeEnv({PG_PROVIDER:'nicepay'})` 신규 e2e, **샌드박스로 partial-cancel 제외 전 항목 실측 가능** |
| 페이앱 | 위와 동일 + **상태조회 부재로 인한 미확인 주문 대기 상태·재조회 UX** | **대** | 계약 테스트 18개는 완료, 실환경 ack/재전송은 키 필요 |
| 토스 유지 | 무변경 | 0 | 이미 529개 녹색 |
| KG·KCP | API 실사 후 산정 | 미정 | 문서 확보가 선행 |

## 5. 지시 준수

- 기존 토스 코드·테스트·Sandbox·운영 키는 삭제하지 않았습니다(무변경).
- 실제 카드 청구, 고객 주문 발생, 운영 결제 설정 변경이 없습니다. 두 프로토콜 계층 모두 네트워크 호출이 없고, 테스트는 전부 in-process입니다.
- 새PG 코드는 `worker.js`(PR #83 소유)를 건드리지 않은 별도 파일로 격리했습니다.
- CI: `backend-tests.yml`(Node 22·24) + `secret-scan.yml` 통과 확인이 대상입니다(PR #111·#113 측정치는 각 PR 본문).
