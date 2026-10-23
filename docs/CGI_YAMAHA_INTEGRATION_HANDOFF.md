# CGI Yamaha 통합 인수인계 문서 (LOCAL 1)

## 1. 생성 파일

- `data/yamaha/yamaha_products.json` — Yamaha 원본 673건
- `data/yamaha/yamaha_products.csv` — 동일 데이터 CSV
- `data/yamaha/yamaha_product_db.xlsx` — Yamaha 전용 DB XLSX
- `data/yamaha/yamaha_category_summary.csv` — 카테고리별 모델 집계
- `data/yamaha/yamaha_global_kr_model_mapping.csv` — Global/Korea 교차 모델 매핑 (248 auto)
- `data/yamaha/yamaha_to_cgi_product_master_mapping.csv` — CGI 4,575건과 Yamaha 673건 매핑
- `data/yamaha/integrated_shop_products.json` — 쇼핑몰용 통합 상품 데이터 (5,248건)
- `data/yamaha/cgi_yamaha_integrated_product_db.xlsx` — CGI 원본 + Yamaha + 매핑 통합 XLSX
- `site/data/yamaha_shop_demo.json` — 쇼핑몰 시연용 데이터
- `reports/yamaha_validation_report.md` — 검증 보고서
- `reports/yamaha_verification.json` — URL 검증 결과

## 2. 데이터 구조

Yamaha 레코드 주요 필드:
- `source_site`: `yamaha_global` 또는 `yamaha_kr`
- `source_key`: `yamaha_global:{series}:{model}` / `yamaha_kr:{series}:{model}`
- `name`, `brand`, `manufacturer`, `model`
- `category_path`: `["Professional Audio", "{category}"]`
- `specs`: 규격 JSON 객체
- `image_urls`: 공식 이미지 URL 배열
- `public_price`: `null` (공식 사이트에 공개 판매가 없음)
- `price_type`: `unknown`
- `canonical_url`: 공식 상세 URL
- `verification_status`: `http_verified`

## 3. 매핑 결과

- Yamaha 원본: 673건
- Global/Korea 교차 모델: 248건 자동 매칭
- Global-only: 55건
- Korea-only: 122건
- CGI 자동 매칭: 0건
- 검토 필요: 2건 (`CL1` vs Cloud `CL-1`, 브랜드 불일치)
- CGI 미매칭: 671건
- 기존 CGI 4,575건 보존: 변경 없음

## 4. 쇼핑몰 연동 인터페이스

- `integrated_shop_products.json`은 CGI 기존 상품과 Yamaha 상품을 동일한 상위 구조로 제공합니다.
- Yamaha 항목은 `source_type`이 `yamaha_global` 또는 `yamaha_kr`이며 `match_status`는 `unmatched`입니다.
- 가격은 `null` / `unknown`으로 보존되며, 실제 CGI 공급가·재고는 별도 확정 전까지 표시하지 않습니다.
- `official_url`로 제조사 상세페이지를 연결할 수 있습니다.

## 5. 주의사항

- 기존 CGI 상품 ID, 가격, 재고, ERP 코드는 변경하지 않았습니다.
- Yamaha 공식 이미지와 규격은 `image_urls`, `specs`에 보존되어 있습니다.
- 불확실한 CL1 매칭은 자동 확정하지 않고 `review_required`로 남겼습니다.

## 6. 쇼핑몰 연동 예시

- CGI 카탈로그 로더 호환 파일: `site/data/yamaha_catalog.js`
- 메타: `window.YAMAHA_CATALOG_META`
- 상품 배열: `window.YAMAHA_PRODUCTS`
- JSON: `site/data/yamaha_catalog.json`
- 사용 예시: `index.html?data=site/data/yamaha_catalog.json`
- 각 Yamaha 항목은 `catalog_type=manufacturer_reference`, `sale_status=current_or_unspecified|discontinued`, `price.state=inquiry`로 표시됩니다.
- 실제 CGI 판매상품과 혼동하지 않도록 `source.site`는 `yamaha_global`/`yamaha_kr`로 구분됩니다.
PY


## 7. 최종 검증 결과

- Yamaha 원본 상품: 673건 (Global 303, Korea 370)
- Global/Korea 중복 모델: 248건 자동 매칭, Global-only 55건, Korea-only 122건
- CGI 상품: 4,575건 (변경 없음)
- CGI-Yamaha 자동 매칭: 0건
- 수동 검토 대상: 2건 (Yamaha CL1 vs CGI Cloud CL-1)
  - Yamaha 공식 페이지에서 CL 시리즈 디지털 믹싱 콘솔(단종) 확인
  - CGI 상품은 Cloud CL-1 마이크 액티베이터로 브랜드/용도가 다름
  - 자동 매칭하지 않고 review_required 상태 유지
- 쇼핑몰 로더 호환 파일: site/data/yamaha_catalog.json, site/data/yamaha_catalog.js
- 가격/재고/공급 권한: Yamaha는 공식 참고 상품으로 price=null, price.state=inquiry 유지
