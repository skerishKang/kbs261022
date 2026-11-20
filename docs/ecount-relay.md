# 이카운트 주문서 중계 (relay mode)

Worker는 이카운트를 직접 호출하지 않는다. 결제 완료 주문을 `erp_sync` 대기(outbox)로만 기록하고, 사무실 PC의 중계 스크립트가 대기 건을 가져가 고정 IP로 OAPI를 호출한 뒤 결과를 Worker에 회신한다.

## 구조

```
[쇼핑몰 / PG]
     |  결제 완료
     v
[Worker cgi-quote-api]  ECOUNT_SYNC_MODE=relay
     |  erp_sync(status=pending, mode=relay, payload=주문서 재료)
     |  상품 매핑은 D1 ecount_item_mapping 에서 확인
     v
GET /api/erp/outbox?limit=N   <-- X-ERP-Relay-Token
     |  claim(잠금 15분) + 주문번호/dedupe_key/줄별 PROD_CD·수량·단가/비고/본문
     v
[사무실 PC] backend/tools/ecount-relay.mjs
     |  로컬 장부 확인 -> sent면 재회신만, sending/unknown이면 건너뜀(운영자 재시도 세대가 높으면 1회 전송)
     |  Zone -> OAPILogin(세션 재사용) -> 장부에 sending 기록
     |  POST /OAPI/V2/SaleOrder/SaveSaleOrder  (10초 간격, 요청당 60초 제한)
     |  장부에 sent / unknown / rejected / deferred 기록
     v
POST /api/erp/outbox/:id/result  <-- X-ERP-Relay-Token
     |  성공 {ok:true, slipNo}: sent
     |  미처리 확실 {ok:false, pending:true}: 대기로 되돌림(시도 횟수 안 씀)
     |  명확한 거절 {ok:false}: pending(재시도) -> 3회 후 failed, 매번 운영 알림
     |  응답 불명 {ok:false, unknown:true}: unknown (자동 재시도 없음, 운영 알림, 수동 확인)
     v
[이카운트]  OAPI IP 허용 목록에 사무실 PC 고정 IP 등록 필요
```

- 잠금 후 15분이 지나면 결과 없이 다시 대기로 돌아간다. 단, 중계 PC의 로컬 장부가 `sending` 또는 `unknown`이면 재전송하지 않고 "UNKNOWN 확인 필요"로 로그만 남긴다.
- 즉시 재전송은 `session_invalid`(세션 만료, 이카운트가 처리하지 않았음이 확실)일 때만, 재로그인 후 1회 한다. 그 재전송도 세션 만료면 pending으로 회신한다.
- `rate_limited`는 즉시 다시 보내지 않고 pending으로 회신한다. 같은 묶음의 남은 주문도 보내지 않고 pending으로 풀어 주며, 상시 실행이면 10분 기다린 뒤 다음 주기로 넘어간다.
- 로그인(Zone·OAPILogin) 실패는 아무것도 보내지 않은 것이므로 장부에 sending을 남기지 않고 묶음 전체를 pending으로 회신한다.

### 결과 분류 (중복 전표는 사람이 지워야 하므로 애매하면 unknown)

| 상황 | 장부 | 회신 | 다음 동작 |
|---|---|---|---|
| 전표번호를 받음 | sent | ok:true | 끝. 같은 주문은 결과만 재회신 |
| rate_limited(412), session_invalid 재시도 실패, 404, 로그인 실패 | deferred (로그인 실패는 기록 없음) | pending | 다음 주기에 다시 보냄 |
| Status≠200, Error 응답(api_error), 모든 행 실패 | rejected | ok:false | 다음 주기 재시도, 3회 후 failed. 매번 알림 |
| 네트워크 오류·60초 초과·5xx·JSON 아님·전표번호 없는 성공·일부 행만 성공·모르는 오류 | unknown | unknown:true | 자동 재전송 없음. 알림 후 사람 확인 |
- 매핑되지 않은 상품이 한 줄이라도 있으면 그 주문은 보내지 않고 `product_mapping_missing` + 상품 id 목록으로 보류한다. 매핑을 추가하면 다음 조회에서 자동으로 다시 나온다.
- `ECOUNT_ORDER_SYNC_ENABLED`가 `NO`이면 대기 기록도 만들지 않는다.
- 중계 본문에는 상품 줄만 담는다. 배송비 줄(`ECOUNT_SHIPPING_ITEM_CODE`)은 직접 전송 모드의 기능이며 중계 모드에서는 넣지 않으므로 시험 주문의 `shipping_fee`는 0으로 둔다.
- 이카운트 OAPI로는 수정·삭제가 불가능하다. 테스트 서버 저장도 실제 장부에 들어가므로 신중히 보낸다.

## 환경 파일 항목 (값은 적지 않는다)

Worker 변수/비밀:

- `ECOUNT_SYNC_MODE` — `relay`(기본) 또는 `direct`
- `ECOUNT_ORDER_SYNC_ENABLED` — `YES`일 때만 대기 기록
- `ECOUNT_TARGET` — `test`(기본) 또는 `prod`
- `ECOUNT_DEFAULT_CUST_CODE` — 비어 있으면 `ONLINE01`
- `ECOUNT_DEFAULT_WH_CD` — 비어 있으면 `100`
- `ERP_RELAY_TOKEN` — 비밀. 출고/결과 경로의 공유 토큰

`--env` 파일에 넣을 항목 (이름만):

- `ECOUNT_COM_CODE`
- `ECOUNT_USER_ID`
- `ECOUNT_API_CERT_KEY`
- `ECOUNT_TARGET`
- `WORKER_BASE`
- `ERP_RELAY_TOKEN`

환경 파일 예시(값은 예시용 가짜 문자열):

```
ECOUNT_COM_CODE=EXAMPLE-COM
ECOUNT_USER_ID=EXAMPLE-USER
ECOUNT_API_CERT_KEY=EXAMPLE-CERT
ECOUNT_TARGET=test
WORKER_BASE=https://example-worker.example.com
ERP_RELAY_TOKEN=EXAMPLE-RELAY-TOKEN
```

인증키·토큰·세션은 로그에 출력하지 않는다. 출력은 대상 서버, 주문번호, 성공/실패, 전표번호, 오류 문구뿐이다.

## 로컬 전송 장부

중계 PC가 같은 주문을 두 번 보내지 않도록 JSONL 장부를 로컬에 둔다.

- 위치: 기본은 `--env` 파일과 같은 폴더의 `ecount-relay-ledger.jsonl`. `--ledger <파일>`로 바꿀 수 있다.
- 전송 직전에 한 줄 기록: `{id, order_id, dedupe_key, at, state:"sending"}`
- 성공하면 `{..., state:"sent", slipNo}`, 응답을 못 받으면 `{..., state:"unknown"}`, 이카운트가 명확히 거절하면 `{..., state:"rejected"}`, 처리되지 않은 것이 확실하면 `{..., state:"deferred"}`를 덧붙인다.
- 장부에는 erp_sync id·주문번호·dedupe_key·retry_gen·전표번호·상태·오류 코드·시각만 쓴다. 인증키·토큰·세션·오류 문구는 쓰지 않는다.
- 장부는 중계 PC 한 대에만 있다. **중계 스크립트는 한 PC에서만 실행**하고, 장부 파일을 지우거나 옮기지 않는다(백업은 복사로).
- outbox의 `dedupe_key`가 장부에서 `sent`면 이카운트로 보내지 않고 `result`만 `ok:true`와 그 전표번호로 다시 회신한다.
- `sending` 또는 `unknown`이면 보내지 않고 "UNKNOWN 확인 필요"로 로그를 남기고 넘어간다. `rejected`는 다음 주기에서 다시 시도한다.

## unknown 처리 절차

위 표의 unknown 상황은 Worker가 `erp_sync.status='unknown'`으로 두고 자동 재시도하지 않으며 outbox에서 제외한다. 동시에 운영 알림 `erp_sync_attention`(메일+텔레그램, 주문번호·erp_sync id·사유 포함)이 나간다. 이카운트가 명확히 거절한 경우에도 같은 알림이 나간다.

1. 알림의 주문번호로 이카운트 **판매조회(주문서 조회)**에서 전표가 실제로 등록됐는지 확인한다. 비고·주문번호로 찾는다.
2. 전표가 **있으면** 중계 PC에서 수동 성공 회신을 한다. Worker가 `sent`로 바뀌고 장부에도 `sent`가 남아 다시 보내지 않는다.
   ```bash
   node backend/tools/ecount-relay.mjs --env /경로/relay.env --mark-sent <erp_sync id> --slip <조회한 전표번호>
   ```
3. 전표가 **없으면** 관리자가 주문 화면의 ERP 재시도(`POST /api/orders/:id/erp/retry`)를 누른다. Worker가 `pending`으로 되돌리며 재시도 세대(`retry_gen`)를 1 올린다. 중계 스크립트는 장부의 `unknown`보다 세대가 높은 항목만 **한 번** 보낸다. 장부를 손으로 지울 필요가 없다.
4. 확인 없이 재시도를 누르면 중복 전표가 생길 수 있다. 반드시 1번을 먼저 한다.

장부가 `unknown`·`sending`이고 세대가 같은 항목은 계속 "UNKNOWN 확인 필요"로 건너뛴다.

## 실행 예

```bash
# 1건 미리보기 (이카운트로 전송하지 않음, 잠금도 걸지 않음)
node backend/tools/ecount-relay.mjs --env /경로/relay.env --once --dry-run --limit 1

# 테스트 서버로 1건 전송
node backend/tools/ecount-relay.mjs --env /경로/relay.env --once --limit 1

# 장부 위치를 따로 지정
node backend/tools/ecount-relay.mjs --env /경로/relay.env --ledger /경로/ecount-relay-ledger.jsonl --once --limit 1

# unknown 을 판매조회로 확인했더니 전표가 있을 때 (수동 성공 회신 + 장부 sent)
node backend/tools/ecount-relay.mjs --env /경로/relay.env --mark-sent 42 --slip 20261120-1

# 상시 실행 (대기 건을 계속 폴링)
node backend/tools/ecount-relay.mjs --env /경로/relay.env --limit 20
```

시작 시 `target: TEST` 또는 `target: PROD`를 한 줄로 출력한다. `prod`는 `--confirm-prod`가 있을 때만 실행된다.

## 운영 전환 순서

1. 이카운트 OAPI IP 허용 목록에 사무실 PC의 고정 IP를 등록한다.
2. 실서버용 COM_CODE / USER_ID / API_CERT_KEY를 발급받아 `--env` 파일에 넣는다. 값은 저장소·로그·채팅에 남기지 않는다.
3. 환경 파일과 Worker의 `ECOUNT_TARGET`을 `prod`로 바꾼다.
4. 실서버 전송임을 확인하고 `--confirm-prod`를 붙여 실행한다.
5. 첫 1건을 `--once --limit 1`로 보내 전표번호와 장부 반영을 확인한 뒤 상시 실행으로 넘어간다.

## D1 시험 데이터 준비

`ECOUNT_ORDER_SYNC_ENABLED=YES`, `ECOUNT_SYNC_MODE=relay`인 **시험** Worker에서, 결제 완료 주문과 상품 매핑을 준비한다. 운영 주문·결제·회원은 만들지 않는다.

```sql
-- 시험 주문 1건 (가격은 실제 값이 아니라 예시 숫자)
INSERT INTO orders
  (id, kind, status, payment_status, created_at, updated_at, paid_at,
   customer_company, customer_name, customer_phone,
   item_total, shipping_fee, total_amount, terms_consent, privacy_consent)
VALUES
  ('RELAY-TEST-1', 'purchase', 'paid', 'paid',
   '2026-11-18T00:00:00.000Z', '2026-11-18T00:00:00.000Z', '2026-11-18T00:01:00.000Z',
   'TEST', 'TEST', '000-0000-0000',
   1000, 0, 1000, 1, 1);

INSERT INTO order_items
  (order_id, seq, product_id, product_name, price_state, unit_price, qty, line_total)
VALUES
  ('RELAY-TEST-1', 1, 'TEST-PRODUCT-1', 'TEST ITEM', 'public', 1000, 1, 1000);

-- 상품 매핑 (CGI product id -> 이카운트 PROD_CD)
INSERT INTO ecount_item_mapping
  (cgi_product_id, ecount_prod_cd, approved_by, approved_at, source_sha256, created_at, updated_at)
VALUES
  ('TEST-PRODUCT-1', 'TEST-PROD-1', 'tester',
   '2026-11-18T00:00:00.000Z', 'test-hash',
   '2026-11-18T00:00:00.000Z', '2026-11-18T00:00:00.000Z');
```

주문 결제 확정 경로를 그대로 쓰려면 주문 생성 후 `/api/payments/confirm`으로 결제 완료 상태로 만든다. 위 SQL처럼 직접 넣은 주문은 `paid` 상태이므로 결제 재확인 없이 outbox에 잡힌다. 전송 후에는 `/api/erp/outbox/:id/result`로 전표번호를 회신해야 같은 주문이 다시 나오지 않는다.
