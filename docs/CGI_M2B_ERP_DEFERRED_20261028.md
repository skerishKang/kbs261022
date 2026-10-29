# ERP 연동 — 후속 과제로 분리 (2026-10-28, 범위 정정)

> M2 후속(등록 준비) 레인에서 CTO 지시로 ERP 연동 개발이 범위에서 제외됐다.
> 이 문서는 그동안 조사·측정한 ERP 관련 내용을 보존해, 후속 레인이 같은 조사를 반복하지
> 않게 하는 것이다. 새 코드는 없다 — 아래는 전부 커밋된 코드·데이터의 사실과 설계 메모다.

## 1. availability 341건 — 실측 결과 (복구는 후속 과제)

| 항목 | 측정값 |
| --- | --- |
| 대상 | 4,575건 중 341건 — `availability` JSON 이 파싱되지만 4키(`stock_number_displayed`·`use_stock`·`use_soldout`·`is_reserve_stat`) 전부 null |
| 출처 | 전부 `samamusic` 수집 배치, `cgi_sale_status=unapproved` |
| 원본 보존 여부 | product_db.xlsx `통합상품`(34열)·`공급처원본` 시트·`incremental/` 어디에도 원시값 없음 — **커밋된 데이터만으로 복구 불가** |
| 정합성 | 값 발명은 계약상 금지. 유일한 해소는 공급처 페이지 재수집(availability 4키 재추출) |
| 파일럿 영향 | 없음 — samamusic:1769·3417·3418 은 전부 정상 측정(예: 1769 표시 재고 8, use_stock=true) |
| 준비도 표시 | `availability_fields_absent`(kind=DEFECT, owner=pipeline) — 분류 결과는 `reports/data/registration/m2_predev_report.json` field_gaps_by_source 유지 |

후속 과제(재수집 레인)가 가져갈 설계 메모:

- 감사 도구가 341건의 `source_url` 워크리스트를 산출하고, 재수집 입력 파일은
  `{ master_product_key, availability(4키 전부 non-null 인 JSON), collected_at, source_url }` 행으로 받는다.
- 반영 규칙: 키가 master 에 존재하고 4키가 전부 채워진 행만 반영, 그 외는 refused 사유 표기 —
  부분 복구를 조용히 통계에 섞지 않는다.

## 2. ERP BAL_QTY 연결 — 설계 메모 (후속 레인용, 이번 레인 미구현)

기존 구현(재사용 대상, 전부 커밋돼 있음):

- `lib/erp-plan.mjs` `planInventoryRead({ prodCds, baseDate, chunkSize, whCd, byLocation })` —
  1건은 `viewInventoryBalance`(1초 제한), 2건 이상은 `listInventoryBalance`(10분 제한),
  PROD_CD 다중값은 `∬` 결합, chunkSize 기본 20.
- `lib/erp-oapi.mjs` 클라이언트 — `bootstrap()`(Zone+로그인) 후 `call(endpoint, body)`,
  mock 은 `test/helpers/mock-erp-oapi.mjs`(`inventory: [{ PROD_CD, BAL_QTY }]`, BAL_QTY 는
  decimal 문자열 예: `"3.0000000000"`).
- `lib/ncommerce.mjs` `stockFromErpBalance` — 변환의 유일한 권위:
  `Math.floor`(올림 금지), 음수→OUTOFSTOCK/usable=false, 상한 `NCOM_LIMITS.stockQuantityMax`,
  옵션 관리형은 option-stock 엔드포인트, 거부 사유 5종
  (`unreadable_BAL_QTY`·`unmapped_prod_cd`·`no_naver_channel_product`·`negative_balance`·`out_of_bounds`).
- 키 대응 실측(커밋 리포트 `m2_predev_report.json`): 매핑↔업로드 품목코드 4,575/4,575 완전 대응,
  `재고수량관리` 미관리 2,281/관리 2,294.

후속 레인에서 만들 것:

1. `buildMappingByProdCd(records)` — `buildMappingSet` 레코드의 `erpProdCdProposed`(품목코드) →
   `{ naverItemId: prep 네이버상품ID, optionManaged, cgiId }`. 현재 `naverItemId` 는 전건 비어 있어
   실등록 전까지는 `no_naver_channel_product` 가 정상 출력이다.
2. `createBalanceAdapter({ erpClient })` — `readBalances({ prodCds, execute })`: `execute=false` 는
   계획만(호출 0건), `execute=true` 는 mock 모드 한정(루프백 검증), 라이브는 운영자 인증 레인.
3. 청크 실행 → `{ PROD_CD, BAL_QTY }` 행 수집 → `stockFromErpBalance` 위임.

## 3. 후속 과제 체크리스트 (별도 레인)

- [ ] availability 341건 재수집 실행(공급처 samamusic, 워크리스트 기반) + 반영 검증
- [ ] ERP OAPI 운영자 인증 확보(이카운트 API 키) 후 잔량조회 라이브 검증
- [ ] `buildMappingByProdCd` + `createBalanceAdapter` 구현·테스트(위 설계 메모 기준)
- [ ] 상품 등록 후 `naverItemId` 회신 → 매핑 기록 갱신 → BAL_QTY→재고 갱신 체계 착수
