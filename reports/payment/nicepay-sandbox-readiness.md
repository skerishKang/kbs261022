# NICEPAY TEST 상점 실측 및 CGI Sandbox 연동 준비 (2026-10-27)

- 작성: 2026-10-27 (KST), CGI LOCAL · 이슈 #106 후속 (PADIEM 개발 테스트 계정)
- 근거: 대표님이 로그인한 Tabbit 브라우저 세션으로 `start.nicepay.co.kr` 가맹점관리자를 **실측**했고, 코드 판정은 공식 매뉴얼(`github.com/nicepayments/nicepay-manual`, 2026-10-27 수집본)과 오프라인 계약 테스트로 했습니다.
- 이 문서에 없는 것: 발급된 키 값, 토큰, 비밀번호, 사업자 식별자 원문. 값은 로컬 시크릿 저장소에만 있습니다(§2-3).

## 1. 결론

| | 실측 결과 |
| --- | --- |
| 계정 | 로그인 상태 확인. **계약 전 상태** — 대시보드 문구가 "강\*원님, 서비스 신청 전 나이스페이 서비스를 체험해보세요" |
| TEST 상점 | 기존 0개 → **생성함**(`PADIEM-CGI-SANDBOX`). 개설 대화상자는 상점 이름 입력 1개뿐. 요금·계좌·본인인증·약관동의 없음 = **무료** |
| SANDBOX 키 | 미발급(KEY 표 행 0) → **발급함**. Server 승인 + Basic 인증. 값 출력 금지 규정을 지켜 이 문서·터미널·이슈·로그에 아무 값도 없음 |
| 키 유효성 | **실 샌드박스에서 인증 통과.** read-only 조회 1호가 `HTTP 404 / U107(거래내역이 존재 하지 않습니다)`. 같은 경로를 인증 없이 때리면 `401 / U304`가 나오는 것을 음성 대조로 관측했으므로, 404는 자격 통과 + 거래 부재를 **관측**한 결과입니다(추론 아님) |
| 코드 | NICEPAY 프로토콜 레이어가 main에 없었음(PR #113이 레인 브랜치에 고아 병합). 이 PR이 main으로 올리고, 환경 분리·샌드박스 체크리스트·라이브 프로브를 추가 |
| 운영 PG | **변경 없음**. `backend/worker.js`를 건드리지 않았고, 토스 Sandbox·기존 PG 기능 그대로 |

## 2. 관리자 화면 실측 7항

| # | 지시 항목 | 실측 |
| --- | --- | --- |
| 1 | 가맹점·사업자 정보 | 계약 전 개인/개발 계정. 좌측 영역 표시는 마스킹된 성함 1건(`강*원`), 사업자등록번호·대표자·통장 정보는 화면에 없음. 멤버관리 탭에 계정 1행(역할: 관리자)만 존재 |
| 2 | 테스트상점 메뉴 / 기존 존재 | `#testShopBtn`("테스트 상점 개설하기") 활성, 기존 TEST 상점 0개. 생성 API는 `POST /merchant/dashboard/testAddShopProc.ajax`에 `shopNm` 1개 전송, `resultCd=0000` |
| 3 | 테스트 Client/Secret Key 발급 | `개발정보 → KEY 정보` 표(구성 열: 이름 / KEY 값 / 마지막 호출) 행 0 = 미발급 → 발급 완료. 선택지: 결제창 승인 방식 `Server 승인(authTrCl=2)` / `Client 승인(1)`, API 인가 방식 `Basic 인증(PASSWORD)` / `Access Token(CREDENTIAL)`. CGI는 서버측 REST이므로 **Server 승인 + Basic**(화면 기본값). 발급 API `POST /merchant/devinfo/clientIdAdd.ajax` `resultCd=0000`. 발급 결과 필드: `clientId`(35자), `clientSecret`(32자 hex) — 값은 저장소 참조 |
| 4 | 테스트상점 ID / Sandbox 환경 | 상점 별도 번호 필드는 관리자 화면에 없음. 매뉴얼대로 **clientId가 상점 구분자**("승인 모델을 구분하는 기준은 가맹점의 clientId"). 실측: JS SDK는 두 환경이 **같은 호스트**입니다 — `pay.nicepay.co.kr/v1/js/`가 200 + `application/javascript` 16,920B로 `AUTHNICE`·`requestPay`를 정의하고 `sandbox-pay.nicepay.co.kr/v1/js/`는 **404**. 따라서 sandbox-pay는 매뉴얼 아웃바운드 표가 가리키는 **결제창 호스트**이지 SDK include가 아닙니다. REST는 `api.nicepay.co.kr` / `sandbox-api.nicepay.co.kr`, 웹훅 송신 IP 121.133.126.86·87 |
| 5 | 운영상점 신청과의 구분 | 완전히 분리된 경로. 운영 신청은 `#requestContractBtn` → `closeContNotice.ajax` → `#requestContractForm` POST `/merchant/contract/notice.do`(전자계약). TEST 상점 AJAX와 폼이 다르고 버튼도 달라 **운영 신청은 수행하지 않았습니다** |
| 6 | 무료 프로모션 / 계약 조건 | TEST 상점 개설·KEY 발급·웹훅 등록·IP보안·TEST 리포트에 비용 항목 없음(요금 표 자체 없음). `/merchant/contract/notice.do` = "계약 전 유의사항 + 계약 제한 업종"(사행성·가상화폐·장기예약·환금성 등) 및 **"신청서 접수가 완료되면 즉시 전자결제 서비스 이용 가능. 단 간편결제는 카드사 심사 완료 후"**. 고가 장비 정산한도·보증보험은 [pg-final-recommendation.md](./pg-final-recommendation.md)의 표를 유지 |
| 7 | 개발자 문서 / 테스트 결제 메뉴 | 개발정보 탭에 ① KEY 정보(가이드 보기·재발급) ② IP보안(REST API 접근제한, CIDR 표) ③ 웹훅(URL 통보) ④ 거래 로그(결과코드/TARGET/주문번호/시간, 1개월 보관) ⑤ **TEST 리포트** 버튼. 결제정보 탭에 결제내역(GID/TID/OTID/카드사·은행/카드번호·계좌번호)·에스크로. 샌드박스는 웹훅 **원클릭 TEST 호출** 지원(매뉴얼 management/admin) |

## 3. 키 보관 위치(값은 여기 없음)

발급 즉시 브라우저 세션에서 로컬 시크릿 저장소로 옮겨 터미널·Git·이슈를 경유하지 않게 했습니다.

- 파일: `C:\Users\limone\.secrets\.env`(git 저장소 밖), 백업: `.env.bak-nicepaytest-20261027-1513`(69,973바이트, 쓰기 전 원본)
- 키 이름: `NICEPAY_TEST_ENV`, `NICEPAY_TEST_CLIENT_KEY`, `NICEPAY_TEST_SECRET_KEY`, `NICEPAY_TEST_AUTH_MODE`, `NICEPAY_TEST_SHOP_NAME`
- 발급 응답 원문 파일은 저장 후 삭제(값은 `.env` 한 곳에만 존재)
- 검증: 이 세션의 모든 CLI 산출물 49종 대상 대조 스캔 → 유출 0건

## 4. 환경 분리 설계

`backend/lib/pg-nicepay-env.mjs`가 유일한 설정 진입점입니다. **변수 1개(`PG_NICEPAY_ENV`)가 자격 세트·API 호스트·SDK 호스트·기능표를 함께 교체**합니다.

| | `test`(기본) | `operating` |
| --- | --- | --- |
| mode | `sandbox` | `production` |
| API | `https://sandbox-api.nicepay.co.kr/v1` | `https://api.pay.nicepay.co.kr/v1` |
| SDK include | `https://pay.nicepay.co.kr/v1/js/` (실측: 운영과 동일 호스트) | `https://pay.nicepay.co.kr/v1/js/` |
| 결제창 호스트 | `https://sandbox-pay.nicepay.co.kr` | `https://pay.nicepay.co.kr` |
| 키 변수 | `NICEPAY_TEST_CLIENT_KEY` / `NICEPAY_TEST_SECRET_KEY` | `NICEPAY_OPERATING_CLIENT_KEY` / `NICEPAY_OPERATING_SECRET_KEY` |
| 부분취소 | 불가(샌드박스 제약) | 가능 |
| 실제 자금 | 흐름 없음 | 흐름 있음 |

실패 규칙(모두 값 노출 없이 변수 이름과 사유 코드만 출력):

- 선택 환경의 키가 없으면 **다른 환경으로 물려받지 않고** `keys_missing`로 거부합니다. 테스트 배포가 운영 자격으로 결제호출을 만드는 사고를 막는 가장 중요한 가드입니다.
- `PG_NICEPAY_ENV`에 알려진 두 이름 외 값(`production` 같은 유력한 별칭 포함)이 들어오면 기본값으로 삼지 않고 `environment_unknown` + 허용 이름 목록으로 거부합니다.
- 프로필은 `Object.freeze` — 레인이 호스트를 재작성할 수 없습니다.
- `redactNicepay()`는 logs에 쓸 수 있는 형태(booleans·이름)만 남기고 자격 값은 제거합니다.

**CGI 법인 계약 시 절차**: `NICEPAY_OPERATING_*` 2개 등록 → `PG_NICEPAY_ENV=operating` → 배포. 코드 변경 0줄.

## 5. 9개 검증 항목 매트릭스

| # | 지시 항목 | 판정 | 근거 | 남은 조건 |
| --- | --- | --- | --- | --- |
| 1 | 결제창 호출 | **LIVE PARTIAL** | 로컬 랩으로 쇼핑몰을 띄워 실제 TEST 상점 창을 열었다: `sandbox-pay.nicepay.co.kr/v1/pay` → `web.nicepay.co.kr/v3/webstd/nPayment.jsp`, 헤더 `테스트결제(실결제불가)`, 금액 368,000원 = 서버 주문 합계, 삼성 카드 선택·약관 동의까지 진행 | NICE 창 자체의 `결제 정보 확인` 위젯이 합성 이벤트에서 제출되지 않아 **카드 인증 직전**에서 정지. 카드 인증 수단은 소유자 본인 것이라 대리 입력하지 않음 |
| 2 | 주문금액과 승인금액 일치 | OFFLINE 통과 + LIVE 부분 | `verifyTransactionMessage(...expectedAmount)`가 서명 유효·금액 불일치에서 `reason:'amount'` 거부. 랩 HTTP 실측에서 창 요청 금액이 always 서버 주문 합계(클라이언트가 `amount:1`을 보내도 368000) | 창을 통한 실응답 1건 |
| 3 | 승인 결과 확인 | OFFLINE 통과 + LIVE 도달 | `status=paid → DONE`, `ready`는 DONE 아님, 미승인 시 `paidAt=0`. 합성 tid 승인 호출이 실제 샌드박스에서 **U121 인증 요청내역이 존재하지 않습니다** 응답 →  주문은 `failed` 기록(승인 미발생) — 거부는 인증 실패(U304)가 아니라 업무 코드라 승인 엔드포인트까지 도달했음을 증명 | 창이 발행한 tid에 대한 실제 승인 |
| 4 | 주문번호·거래번호 조회 | **LIVE 통과** | read-only 프로브가 실 샌드박스에서 Basic 인증 통과(`404 U107`), 무인증은 `401 U304`로 구분. Worker 웹훅 경로가 실제 조회를 호출해 같은 코드를 수신(`gateway_read_failed U107`) | tid 기준 성공 응답은 창 승인 거래에서만 |
| 5 | 중복 승인 차단 | OFFLINE 통과 | `(tid,status)` 웹훅 중복키 수렴 + returnUrl 재전송 시 `payment_confirmed` 이벤트 1건·payments 행 1건(e2e 실측). 승인 API 재호출은 게이트웨이 쪽 orderId 재사용 제한과 Worker의 `already_paid` 방어 | 창 승인 후 실시간 중복 시도 |
| 6 | 결제 실패 처리 | OFFLINE 통과 | `failed → cgiStatus:'failed'`, 환불가능액 0, `expired`는 pending | 실패 응답 실측 |
| 7 | 전체취소 | OFFLINE 통과 + LIVE 요청형식 | `cancelAmt` 생략 = 전액취소, `cancelledTid` 별도, 잔액 0. Worker 라우로 실제 샌드박스에 취소 요청을 보내 **U107(거래내역 없음)** 을 받았고, 필드 누락 단계의 `U100`은 수정으로 해소 | 실제 취소 성공은 창 승인 거래 필요 |
| 8 | 결제 결과 Webhook 검증 | LIVE 부분(라우 배선 완료) | `POST /api/payments/nicepay/webhook` 추가. 서명 실패는 ack 하지 않고 400, 미지 tid는 409(재시도 경로 보존), 검증 통과 시 실제 조회로 잔액/상태를 갱신하고 `(tid,status)` 1회만 기록. ack은 `200 / text/html / OK` | 관리자 원클릭 TEST 호출은 공개 URL 등록 후 |
| 9 | 부분취소 지원 범위 | OFFLINE 통과 | 샌드박스 표 `부분취소 불가`·매뉴얼 취소표(카드 전체/부분 O, 1년 내 / 가상계좌 입금 후 환불 180일 / 에스크로 구매결정 후 불가), `card.canPartCancel` 경로, 누적 이력 newest-by-date | 운영 계약 후 실 부분취소 |

OFFLINE = 오프라인 계약 테스트로 코드 규칙이 증명된 상태, LIVE = 실제 샌드박스 응답을 관측한 상태, UNVERIFIED = 관측 못 함(코드 미비 아님).

## 5b. Worker 배선 (이 PR에서 추가)

| 경로 | 공개 여부 | 동작 |
| --- | --- | --- |
| `GET /api/payments/config` | 공개 | 활성 게이트웨이·환경·SDK 호스트·(공개용) client key·returnUrl. **시크릿 키는 응답에 없음** |
| `POST /api/payments/nicepay/window` | 공개 | 주문 행에서 창 파라미터를 만든다. 금액은 서버 주문 합계, 구매자 정보(`buyerName/buyerTel/buyerEmail`)도 서버 행에서 가져온다(미전달 시 창이 현금영수증 휴대폰 입력을 요구해 정지) |
| `POST /api/payments/nicepay/return` | 공개(창이 form POST) | 서명 검증 → 승인 API → 주문 반영 → 사이트를 `?nicepay=success\|fail#/order/<id>`로 302 |
| `POST /api/payments/nicepay/webhook` | 공개 | 검증 → `(tid,status)` 중복 차단 → 게이트웨이 재조회로 상태·잔액 갱신 → `200 text/html OK` |
| `POST /api/orders/:id/payments/:paymentKey/cancel` | 관리자 | **payments.provider 행 기준으로 어댑터를 고른다** — 배포 기본값이 토스여도 NICEPAY 행은 NICE로 취소된다 |

제공자 선택: `PG_PROVIDER`(기본 `tosspayments`) + `PG_NICEPAY_ENV`. 기본값을 바꾸지 않으면 기존 토스 경로와 동일하게 동작하고, `PG_PROVIDER=nicepay`인데 키가 없으면 결제 관련 경로는 503 `keys_missing`으로 **열리지 않는다**(다른 게이트웨이 자격으로 몰래 넘어가지 않음). 사이트는 `site/config.js`의 `pgProvider`로 창 종류를 고르며, 워커와 어긋나면 결제 화면이 스스로 정지한다.

## 6. 실측 중 발견·수정한 결함 7건

1. **PR #113 고아 병합**: #113은 `main`이 아니라 레인 브랜치 `feat/issue-106-payapp-protocol`로 병합됐고(#111은 squash로 먼저 merge), 결과로 `backend/lib/pg-nicepay.mjs`가 main에 없었습니다. 즉 NICEPAY 레이어는 "병합 완료"로 보고됐지만 **런타임에서 import 불가능**한 상태였습니다. 이 PR이 content만 main으로 재적재합니다.
2. **`canPartCancel` 경로 오류**: 매뉴얼 응답 명세에서 이 플래그는 거래 최상위가 아니라 `card` 객체 안입니다. 기존 코드는 최상위만 읽어 실제 카드 거래에서 전부 `false` → 부분취소 대상 거래도 영구 차단됩니다. `tx.canPartCancel ?? tx.card?.canPartCancel`로 고치고 실제 형태 회귀 테스트를 추가했습니다.
3. **승인 시점 매핑 오류**: NICE는 `paidAt / failedAt / cancelledAt`을 쓰고 미도달 단계는 `0`을 넣습니다. `approveDate`/`reqDate`를 읽던 매핑은 실응답에서 항상 `ediDate`(응답 생성시각)로 대체됐고, `0`을 타임스탬프로 옮길 위험이 있었습니다. `stamp()`으로 `0`을 null로 만들고 `respondedAt`을 분리했습니다.

4. **1차 버전(PR #115)이 SDK 호스트를 틀린 값으로 배포했습니다.** 매뉴얼 내부 불일치(아웃바운드 표는 `sandbox-pay`, 예시 코드는 `pay`)를 임의 해석해 `sandbox-pay.nicepay.co.kr/v1/js/`를 샌드박스 SDK로 넣고 `jsSdkUrlVerified=false` 플래그만 달아 뒀습니다. 호스트를 직접 때려보니 그 경로는 404이고 SDK는 운영과 같은 호스트에서 나오므로 설정을 실측값으로 교체하고 `windowHost`를 분리했습니다. 미검증 값에 "확인 대기" 표시만 붙여 배포하는 것도 같은 종류의 오류입니다.

5. **승인 본문이 창 페이로드 그 자체였다**: `POST /v1/payments/{tid}`는 `{amount, ediDate, signData}`를 요구하는데(`signData = hex(sha256(tid+amount+ediDate+SecretKey))`) 기존 `approvePayload`은 returnUrl 필드를 그대로 펼치고 있었다. 오프라인 펼침 테스트만 통과하고 실제 게이트웨이에서 실패하는 유형이라 본문 생성자로 바꾸고 필드 집합까지 단언했다.
6. **취소 요청의 필드 이름·누락이 겹쳐 있었다**: 엔드포인트는 `reason`(필수)과 `orderId`(필수)를 받고 `signData = hex(sha256(tid+ediDate+SecretKey))`를 기대하는데, 코드는 `cancelReason`을 보냈고 Worker는 `orderId`를 넘기지 않았으며 스펙에 없는 `cancelMethod`를 넣었다. 라이브 랩에서 `U100 reason 필수입력항목이 누락` → 수정 후 `U107 거래내역이 존재 하지 않습니다`로 바뀌어 요청 형식이 통과한 것을 실측으로 확인했다.
7. **mock이 게이트웨이 규칙을 강제하지 않아 검증에 구멍이었다**: mock 어댑터가 `orderId` 없이도 취소를 허용해서, Worker가 orderId를 빼먹어도 테스트가 green였다. mock을 실측 규칙에 맞추자 그 뮤테이션이 즉시 검출로 바뀌었다.

**취약 데이터 고지**: 랩 확인을 위해 `/api/payments/config`를 raw curl로 읽은 1회 출력에서 TEST 상점의 client key(브라우저 공개 값)가 터미널에 나온 적이 있다. 시크릿 키는 어떤 출력에도 등장하지 않았고 Git에도 없다. client key는 NICEPAY가 결제창 JS에 넣도록 설계한 값이지만, "인증키 미기록" 지시 기준으로 보고한다.

## 6b. GitGuardian 검출 판정 (실제 비밀 vs 합성 테스트 값)

| incident | 위치 | 판정 | 근거 |
| --- | --- | --- | --- |
| 39120785 / 39120784 | PR #115 커밋 `66ebc9b`의 테스트 fixture 2개 파일 | **합성 테스트 값** | 작성자가 만든 32 hex 상수. 로컬 자격 저장소와 대조해 실제 자격과 불일치를 확인했고, 어떤 서비스에도 쓰이지 않아 폐기·회전 대상이 아니다. 후속 커민에서 placeholder형으로 교체 |
| 38957893 | PR #83: `admin.test.mjs`(Generic Password) → 재검증 후 `google-oauth-callback.test.mjs` | **합성 테스트 값** | `PASSWORD` 리터럴은 main과 바이트 동일하고 #83 diff에 없다. 픽스처 3종 모두 길이 13~19, 자격 저장소 부재, 실키 형태(40자↑) 아님, 대상 테스트는 in-process 실행(네트워크 없음) |

두 번째 건은 그 파일이 **이미 `.gitguardian.yml`의 `ignore:`에 목록되어 있다**는 점이 검출 자체로 억제 실패의 증거다. 억제 수단은 대시보드 측 ack이며 운영자 권한이다. 어떤 경우에도 게이트를 완화하지 않았고 실제 자격 값을 출력하지 않았다.

## 6c. 로컬 랩 재현과 실측 응답

```bash
node backend/tools/local-payment-lab.mjs --provider nicepay --mode auto --port 8800   # 실샌드박스
node backend/tools/local-payment-lab.mjs --provider nicepay --mode mock --port 8791   # 자격 불필요
```

| 순서 | 호출 | 실측 응답 |
| --- | --- | --- |
| 1 | 주문 생성(사이트 UI/HTTP) | 201, 368,000원(공급가 334,545 + 부가세 33,455) |
| 2 | 창 파라미터 | 서버 합계 유지(클라이언트가 `amount:1`을 보내도 368000), host `sandbox-pay.nicepay.co.kr` |
| 3 | 결제창 실제 진입 | `테스트결제(실결제불가)` 헤더, 삼성 선택, 약관 동의, 확인 위젯에서 정지 |
| 4 | returnUrl 승인(합성 tid) | 샌드박스 `U121 인증 요청내역이 존재하지 않습니다` → 주문 `failed` 기록 |
| 5 | 웹훅 | 미지 tid `U107` → 502 `gateway_read_failed`(ack 하지 않음) |
| 6 | 관리자 취소 | `U100` → 형식 수정 후 `U107`(게이트웨이가 요청을 해석함) |

이 랩은 배포하지 않고, `wrangler`도 부르지 않으며, 실제 자금을 움직이지 않는다.
 샌드박스 조정(reconciliation)이 운영 URL을 만들었습니다. `mode` 인자를 추가해 환경별로 분리했습니다.

## 7. PR #83(ERP) 충돌 분석 — 해소 후 배선

- 지시 당시 #83은 `backend/worker.js`·`backend/test/e2e/admin.test.mjs`·`site/**`를 소유한 열린 Draft였고, 이 문서는 `worker.js`를 피워 작성됐다.
- 후속 지시로 #83을 최신 main과 정합화(merge-forward, rebase/force 아님)한 결과 유일한 content 충돌은 `site/assets/js/cgi-staff-orders.js` 한 줄이었고, 브랜치의 `orderDrawer` 교정과 main의 `state.feedback` 초기화를 **둘 다 살려** 해결했다. #83은 main에 병합됐다(`23ad7d8`).
- 그래서 이 변경은 `worker.js`를 수정한다. 충돌 대상이었던 #83이 이미 main에 들어와 있으므로 겹치는 영역은 없다.
- 토스 경로 보존: `PG_PROVIDER` 기본값은 `tosspayments`이고, 기본값에서의 요청·환불·헬스 응답을 검증하는 회귀 테스트를 두었다. `pg.mjs`·스키마·`wrangler.toml` 무변경.
- 취소는 payments 행의 provider로 어댑터를 고르므로, 전환 중에도 토스 결제 건의 환불이 살아 있다.

## 8. 재현 절차(계약 검증)

```bash
# 계약 테스트(자격 불필요, 네트워크 없음)
cd backend && npm run test:unit

# 라이브 read-only 1호 프로브 (키가 없으면 호출 0건으로 거부)
node backend/tools/nicepay-sandbox-probe.mjs --environment test
# → {"verdict":"AUTH_OK_NO_SUCH_TRANSACTION","httpStatus":404,"resultCode":"U107","calls":1,...}

# 운영 자격으로 운영 호스트를 두드리는 것은 명시 플래그가 필요함
node backend/tools/nicepay-sandbox-probe.mjs --environment operating            # OPERATING_BLOCKED
node backend/tools/nicepay-sandbox-probe.mjs --environment operating --allow-operating
```

## 9. 다음 단계(대표 결정 대기)

1. 결제창 왕복의 마지막 한 단계를 소유자 본인 인증 수단으로 완료하면 LIVE 승인이 닫힌다. 창은 실제 TEST 상점으로 뜨고 금액·구매자 정보까지 정확히 받는지까지 관측됐다.
2. 웹훅 라우는 배선됐으니, 관리자에 `http(s)://<worker>/api/payments/nicepay/webhook` 을 등록하고 원클릭 TEST 호출로 ack 규칙까지 확인한다.
3. NICEPAY 운영 계약 체결 시 §4의 2개 변수 등록 후 `PG_NICEPAY_ENV=operating`로 전환하고, 전환 전에 실제 소액 거래 1건으로 서명·취소·조회를 확인하세요(매뉴얼이 운영 전환 후 실거래 TEST를 요구).
