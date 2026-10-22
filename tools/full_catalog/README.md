# tools/full_catalog — CGI 전체 상품 DB (이슈 #19)

공급처 공개 수집 원본(4,575건)을 **이슈 #8 통합 상품 마스터 스키마**로
정규화하고, 실제 XLSX 데이터베이스와 카탈로그 사이트용 JSON 을 만드는 도구 모음.

## 구성

| 파일 | 역할 | 출처 |
|---|---|---|
| `collect_cgi_catalog.py` | Cafe24 상점 파서 (Tri-A/Tri-B) | PR #12 Model B 원본 포함 |
| `run_full_collection.py` | 전수 수집 드라이버 (동시성 + 디스크 캐시) | 이슈 #19 |
| `build_full_catalog.py` | 수집 원본 → PR #16 마스터 → XLSX 7시트 → 검증 | 이슈 #19 |
| `build_site_data.py` | PR #17 빌더 재사용 → `site/data/products.json` / `.js` | 이슈 #19 |
| `verify_full_catalog.py` | 8개 항목 통합 검증 | 이슈 #19 |
| `tests/` | 단위 테스트 18개 | 이슈 #19 |

## 재현 절차

대용량 산출물(수집 원본·XLSX·마스터 JSON)은 **CGI-1 로컬**에 보존한다.

```bash
# 1) 전수 수집 (공개 GET 만, robots.txt 준수, 호스트별 지연)
python tools/full_catalog/run_full_collection.py \
  --stage all --cache C:/cgi-cache --out C:/cgi-work/catalog-data

# 2) 통합 마스터 + XLSX 7시트 + 검증
python tools/full_catalog/build_full_catalog.py \
  --data-dir C:/cgi-work/catalog-data \
  --out-dir  C:/cgi-work/catalog-data/full

# 3) 카탈로그 사이트 데이터 (PR #17 빌더를 그대로 재사용)
python tools/full_catalog/build_site_data.py \
  --master-csv   C:/cgi-work/catalog-data/full/catalog_source.csv \
  --categories   C:/cgi-work/catalog-data/full/category_catalog.csv \
  --master-json  C:/cgi-work/catalog-data/full/product_master.full.json \
  --out-dir      site/data

# 4) 통합 검증 (8개 항목)
python tools/full_catalog/verify_full_catalog.py \
  --xlsx        C:/cgi-work/catalog-data/full/product_db.xlsx \
  --master-json C:/cgi-work/catalog-data/full/product_master.full.json \
  --site-json   site/data/products.json \
  --data-dir    C:/cgi-work/catalog-data \
  --out         C:/cgi-work/catalog-data/full/full_verification.json

# 5) 테스트
python -m unittest discover -t . -s tools/full_catalog/tests -v
python -m unittest discover -t . -s tools/product_master/tests -v
```

## 출력 산출물

| 파일 | 내용 | 위치 |
|---|---|---|
| `product_master.full.json` / `.csv` | 통합 상품 마스터 4,575건 (PR #16 스키마) | 로컬 |
| `product_db.xlsx` | 필수 7시트 + 옵션SKU (8시트) | 로컬 + 저장소 `data/full_catalog/` |
| `catalog_source.csv` | PR #17 빌더 입력용 | 로컬 |
| `category_catalog.csv` | 사이트별 카테고리 카탈로그 | 로컬 |
| `verification.json` | 빌더 검증 결과 | 로컬 |
| `full_verification.json` | 8항목 통합 검증 | 로컬 + 저장소 `reports/data/` |
| `site/data/products.json` / `.js` | 카탈로그 사이트 데이터 4,575건 | 저장소 |

## 원칙

* 원천에 없는 값은 만들지 않는다. 채워지지 않은 필드는 **공란**으로 둔다.
* 가격은 공개 표기만. "가격 문의"/"판매 완료" 에서 숫자를 만들지 않는다.
* 도매가·재고는 공개 근거가 없어 항상 공란.
* `cate_no` 는 사이트 namespace 로 분리된 상태로만 비교한다.
* 확신 부족한 중복은 자동 병합하지 않는다.
* 네이버 상품 ID · ERP 품목 코드 · 스마트스토어 카테고리 번호는 스토어 개설 전이라
  전건 공란이다.
