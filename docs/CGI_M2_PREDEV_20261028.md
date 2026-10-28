# CGI M2 사전개발 보고 — 카테고리 매핑·이미지 업로드·ERP 재고 (2026-10-28)

> 기준: PR #125 (HEAD bd644b1) / 브랜치 `local2/naver-m2-prep-20261028`
> 범위: 실제 네이버 API 호출 0건, 상품 등록 0건, 가격·재고 임의 설정 없음. 모든 수치는 커밋된 입력에서 실측.
> 산출물: `reports/data/registration/m2_predev_report.json` (도구 `backend/tools/m2-predev-report.mjs`, 결정론적 재현)

## 1. 기존 구현 조사 요약

| 영역 | 기존 구현 | 상태 |
| --- | --- | --- |
| 카테고리 매핑 | `backend/lib/naver-categories.mjs` — 경로 구조 판정(brand_index/promotion/navigation/product_classification), 코퍼스 로더(JSON·CSV, 감싼 응답 해제), 자카드+이름 유사 점수(`rankCandidates`, minScore 0.5·margin 0.08), invented-id 가드가 있는 `mapSupplierCategories` | 구현 완료. 코퍼스 부재 상태에서는 "unresolved, 0 invented" 가 정상 출력 |
| 이미지 업로드 | `backend/lib/naver-images.mjs` — 바이트 헤더 실측, 형식 하드 규칙(JPG/GIF/PNG/BMP), 1000x1000 권장(바닥 아님), `planImageUpload`(대표 1+추가 9, 호출당 10장) / 클라이언트 엔드포인트 `imageUpload: POST /v1/product-images/upload (multipart)` | 구현 완료. 단, 아래 §2 결함 1건 수정 |
| ERP 재고 연동 | `lib/ncommerce.mjs` `stockFromErpBalance` — BAL_QTY(decimal 문자열)→`Math.floor`, 음수→OUTOFSTOCK, 상한 `NCOM_LIMITS.stockQuantityMax`, 옵션 관리형은 option-stock 엔드포인트, 거부 사유 5종 | 구현 완료. e2e 기존 커버 존재 |

## 2. mock 계약 테스트 (실 API 호출 없음)

신규 테스트 3종(총 23 test):

- `test/unit/m2-category-contract.test.mjs` (12) — mock 코퍼스(공식 `GET /v1/categories` 응답 형태)로 고정: 감싼 응답 해제, 비숫자 id 보존+표시, 중복 id 건너뜀, **브랜드·프로모션·내비게이션 경로는 코퍼스가 있어도 매핑 불가**, 후보 id 는 코퍼스에서 복사(invented=0), 근소 2위→`ambiguous`(사람 결정), 바닥 점수 미달→`best_below_min_score`, minScore·margin 옵션 계약, 문서-클라이언트 엔드포인트 일치.
- `test/unit/m2-image-upload-contract.test.mjs` (6) — 루프백 mock 게이트웨이로 고정: **multipart/form-data + Bearer 로 전송**, 호출당 파일 수 실측, 대표 1+추가 9·초과분 `dropped_over_limit` 보고, 형식 거부 이미지는 계획 제외, **공급처 외부 URL 은 `not_from_image_upload_api` 로 거부되고 업로드 API 반환 URL 만 등록 본문에 허용**.
- `test/e2e/m2-predev-report.test.mjs` (4) — 커밋 산출물 = 도구 재생성(JSON 내용 비교, CRLF 오탐 회피), 안전 게이트 자기 증명.

### 발견·수정한 클라이언트 결함 1건

`NCOM_ENDPOINTS.imageUpload` 가 `multipart: true` 로 선언돼 있어도 `call()` 이 그 플래그를 `send()` 에 전달하지 않아 FormData 가 JSON 직렬화됐다(`{}` 전송). 수정: `send(..., { multipart: endpoint.multipart === true })`. 기존 테스트 전체(472 unit + 259 e2e) 회귀 없음.

## 3. ERP BAL_QTY ↔ 상품별 판매가능 재고 대응 관계

변환 권위는 `stockFromErpBalance`(이 문서는 재구현하지 않고 규칙을 서술, 테스트가 서술-구현 일치를 고정):

| 규칙 | 내용 |
| --- | --- |
| 출처 | Ecount OAPI `GetListInventoryBalanceStatus`(10분 제한) BAL_QTY 만이 확정 수량. 공급처 표시 수량은 참고용 |
| 조인 키 | `품목코드(PROD_CD)` ↔ `data/erp_prep/erp_extended_mapping.csv 품목코드` ↔ `공급처원본ID` |
| 해석 | decimal 문자열(`"3.0000000000"`) → `Number` → **`Math.floor`(올림 금지, 7.9→7)** |
| 음수 | 음수 잔량은 실재 상태 → Naver 음수 재고 대신 `OUTOFSTOCK/usable=false` |
| 상한 | `stockQuantityMax = 99,999,999`(문서 수치) |
| 엔드포인트 | 옵션 관리형 → `PUT /v1/products/origin-products/{no}/option-stock`, 단일형 → `PUT /v2/products/origin-products/{no}` |
| 거부 사유 | `unreadable_BAL_QTY`·`unmapped_prod_cd`·`no_naver_channel_product`·`negative_balance`·`out_of_bounds` |

커밋된 준비파일 실측(4,575건):

- 품목코드 조인: 매핑↔업로드 양방향 **4,575/4,575 완전 대응**(끊긴 키 0건)
- `재고수량관리` 플래그: 미관리(0) 2,281건 / 관리(1) 2,294건
- 카페24품목코드(옵션 SKU 단서): 일부 행만 존재 → 옵션 조합 재고 매핑은 미확정 항목
- 미확인(라이브 조회 후): 창고별 BAL_QTY 분배, 소수점 잔량 의미, 옵션 SKU↔`optionCombinations` 규칙

## 4. 원산지·배송·반품·AS·KC·재고 누락 원인 — 데이터 출처별 분류

분류 대상은 M1 준비도 사유 중 4필드(origin/delivery_returns/as_kc/stock)이며, 준비파일 열의 존재·공란을 실측해 근거로 삼는다. 잔여(선언 안 된 범위 내 사유) 0건.

| 필드 | 차단 건수(4,575 기준) | 출처별 분류 | 실측 근거 |
| --- | --- | --- | --- |
| 원산지 | 4,575 | `prep_column_blank` 4,575 | `원산지코드` 열 존재·전량 공란 |
| 배송·반품 | 9,150 | `prep_column_blank` 9,150 (배송비 4,575 + 반품교환정책 4,575) | 두 열 모두 존재·전량 공란 |
| AS | 4,575 | `prep_column_blank` (ASTemplateCode 전량 공란) | 열 존재·공란 실측 |
| KC·인증 | 4,575 | `category_dependent` | 리프 `certificationInfos` 가 유일한 판정원 — 코퍼스 수집 선행 |
| 재고 | 13,725 | `prep_column_blank` 4,575 + `erp_read_pending` 8,809 + `pipeline_defect` 341 (`availability_fields_absent`) | 열 공란 + ERP 조회 대기 + 수집 파이프라인 결함 341건 별도 표시 |

요지: **운영 정책 확정 하나로 풀리는 전면 블록**(원산지·배송·반품·AS = 상품별 작업 아님)과 **코퍼스/ERP 라이브 조회가 선행되는 블록**(KC, 재고)이 데이터 출처상 명확히 갈린다.

## 5. 파일럿 3건 등록 준비도 dry-run

선정은 M1 준비도 리포트의 `candidates.pilot.cgi_ids`(게이트 통과 상위 후보)를 그대로 사용 — 임의 선정 아님:

| cgi_id | 판정 | 차단 필드 |
| --- | --- | --- |
| samamusic.co.kr:1769 | blocked | leafCategoryId, detailContent, stockQuantity, images.representative, sellerManagementCode(중복검색 미실행) |
| samamusic.co.kr:3417 | blocked | 동일 5필드 |
| samamusic.co.kr:3418 | blocked | 동일 5필드 |

- 패키지 위반 0건(`findPackageViolations`), `would_transmit=false`, 본문에 leafCategoryId·detailContent·숫자 재고 없음
- 판매가는 3건 모두 게이트 미차단(공개 신뢰 가격 존재) — 가격 이외 게이트가 먼저 막는다
- 차단 해제 순서(데이터 출처 기준): 카테고리 코퍼스 수집 → 이미지 업로드 API 전환 → ERP 잔량조회 → 운영 정책 원산지·배송·반품·AS 확정 → 상세본문 승인 → 등록 전 중복검색

## 6. 남은 것 (M2 본개발 착수 조건)

1. 판매자 토큰 확보 후 `GET /v1/categories` 코퍼스 수집 → `mapSupplierCategories` 실행 → 153개 경로 후보표에 confirmed 채우기(운영자 확인)
2. 이미지 업로드 계약 구현: 업로드 러너(파일 수집 → 10장 배치 → URL 회신 → `naver_uploaded_image` 기록) — 계약 테스트는 §2 가 고정
3. ERP BAL_QTY 라이브 조회(운영자 인증) → `stockFromErpBalance` 변환 → `availability_fields_absent` 341건 파이프라인 보수
4. 운영 정책 4종(원산지·배송비·반품·AS) 확정 후 준비파일 열 채우기
5. 등록 전 판매자관리코드 중복검색 실행 체계

## 안전 게이트 준수

실제 네이버 API 호출 0건 / 실제 토큰 발급 0건 / 상품 등록·게시 0건 / 가격·재고 임의 설정 없음(재고는 미확정 상태로 본문에서 비움) / NICEPAY 상용 활성화 없음 / CGI 운영 사이트 변경 없음.
