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
     |  claim(잠금 15분) + 주문번호/줄별 PROD_CD·수량·단가/비고/본문
     v
[사무실 PC] backend/tools/ecount-relay.mjs
     |  Zone -> OAPILogin (세션 재사용, 만료 시 재로그인)
     |  POST /OAPI/V2/SaleOrder/SaveSaleOrder  (10초 간격)
     |  결과 = 전표번호 또는 오류 문구
     v
POST /api/erp/outbox/:id/result  <-- X-ERP-Relay-Token
     |  성공: sent / 실패: pending(재시도) -> 3회 후 failed
     v
[이카운트]  OAPI IP 허용 목록에 사무실 PC 고정 IP 등록 필요
```

- 잠금 후 15분이 지나면 결과 없이 다시 대기로 돌아간다.
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

## 실행 예

```bash
# 1건 미리보기 (이카운트로 전송하지 않음, 잠금도 걸지 않음)
node backend/tools/ecount-relay.mjs --env /경로/relay.env --once --dry-run --limit 1

# 테스트 서버로 1건 전송
node backend/tools/ecount-relay.mjs --env /경로/relay.env --once --limit 1

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
