# tools/full_catalog — CGI 전체 상품 카탈로그 수집 툴킷

> 이슈 #19 데이터 공급분. **공급처 2곳의 공개 상품 전량(4,575건)** 상세 수집 · 품질검증 · XLSX/CSV 생성.
> 읽기 전용. 운영 데이터 생성·수정·삭제 없음. 계정정보 미수록.

## 구성

| 파일 | 역할 |
|---|---|
| `collect_full_catalog.py` | 전체 수집 오케스트레이터 (카테고리 목록 크롤 → 상세 수집 → 병합 → 품질 통계) |
| `verify_browser.py` | Playwright 2층 교차검증 (L1 렌더 대조 / L2 파서 동등성) |
| `dalue_export_full.py` | Tri-B 공개 검색 API(Dalue/DCSE) 스토어 전체 인덱스 덤프 (비노출 포함) |
| `build_xlsx_db.py` | #19 요구 XLSX 7시트 빌더 |

## 재사용 원칙

- **PR #12 의 `skills/cgi-catalog-collector/scripts/collect_cgi_catalog.py` 를 수정 없이 import** 해 재사용한다.
  main 에 아직 없으면 `origin/feature/site-analysis-model-b` 에서 `git show` 로 읽어 로컬 캐시(`.work/full_catalog/_vendor/`)에 복사한다.
- **PR #13 의 Dalue API 계약**, **PR #16 의 정규화·중복·검증 도구** 는 중복 개발하지 않고 참고/재사용한다.
- **main(PR #17) 의 `tools/build_catalog_data.py` 와 `site/` 는 건드리지 않는다.** 40컬럼 마스터 CSV 를 그대로 넣으면 확장된다.

## 수집 단계별 오버라이드 (수집기 원본을 바꾸지 않기 위한 것)

`collect_full_catalog.py` 는 PR #12 수집기의 동작을 **모듈 수준에서** 보정한다.

| 오버라이드 | 이유 |
|---|---|
| `extract_images` → `/web/product/` 경로만 수집 | 원본은 `data-src` 를 전부 수집해 사이트 배너·편집기 이미지·외부 CDN 이미지를 상품 이미지로 섞는다(실측 결함). 또한 `class="BigImage "` 후행 공백 때문에 **대표 이미지(big)를 누락**한다 |
| `source_category_id` 를 상세 페이지 신호로 우선 | 목록 크롤 값은 "최초 발견 카테고리"라 리프가 아닐 수 있다. Tri-B 는 스토어 등록 카테고리(Dalue `categoryNos`)를 사용 |
| `product_status_flags` 에 `main_soldout_icon` / `addon_soldout:<id>` 분리 | 원본은 메인/추가상품 품절을 한 값으로 합친다 |
| `updated_at` / `list_observed_price` / `list_page_url` 채움 | 원본 detail 모드는 미기입 |

> 위 보정은 **PR #12 원본을 고친 것이 아니다.** 상위 반영이 필요하므로 별도 보고 대상이다.

## 실행

```bash
pip install requests openpyxl playwright && python -m playwright install chromium

# 1) 카테고리 목록 크롤 (캐시가 있으면 네트워크 0)
python tools/catalog_collection/collect_full_catalog.py --stage categories --site samasound
python tools/catalog_collection/collect_full_catalog.py --stage categories --site samamusic

# 2) 전체 상세 수집
python tools/catalog_collection/collect_full_catalog.py --stage details --site samasound --workers 4 --delay 0.35
python tools/catalog_collection/collect_full_catalog.py --stage details --site samamusic --workers 4 --delay 0.35

# 3) 병합 + 품질 통계
python tools/catalog_collection/collect_full_catalog.py --stage merge

# 4) Tri-B 스토어 전체 인덱스(비노출 포함) — 공개 검색 API
export DALUE_API_KEY=<스토어 공개 검색키>
python tools/catalog_collection/dalue_export_full.py --out .work/full_catalog/triB_dalue_full.json

# 5) 브라우저 교차검증
python tools/catalog_collection/verify_browser.py \
  --master .work/full_catalog/product_master_full.csv \
  --sample .work/full_catalog/verify_sample.csv \
  --out .work/full_catalog/browser_verification.csv

# 6) XLSX
python tools/catalog_collection/build_xlsx_db.py \
  --master  .work/full_catalog/product_master_full.csv \
  --cats    .work/full_catalog/category_catalog_full.csv \
  --quality .work/full_catalog/product_master_full_quality.csv \
  --out     .work/full_catalog/product_master_full.xlsx
```

## 산출 위치

| 파일 | 공개 저장소 |
|---|---|
| `.work/full_catalog/product_master_full.csv` (9.0MB) | **미제출** (로컬 보존) |
| `.work/full_catalog/product_master_full.json` | **미제출** |
| `.work/full_catalog/product_master_full.xlsx` (2.4MB) | **미제출** (대표 지침) |
| `.work/full_catalog/triB_dalue_full.json` | **미제출** |
| `.work/full_catalog/triB_nonlisted_products.csv` | **미제출** |
| `reports/samples/*` (샘플·통계·검증) | 제출 |
| `.cache/cgi-catalog/` (HTTP 캐시) | **미제출** |

## 주의

- 요청은 **공급처 2곳 전체 상품 기준 유한 순회**다(무제한 아님). 지연 0.05~0.35초, 동일 URL 은 SHA1 캐시 재사용.
- robots.txt Disallow 경로는 방문하지 않는다.
- `dealer_price_unverified` · 실재고 · CGI 판매가 · 취급 승인은 **공개 근거가 없어 항상 NULL** 이다. 채우지 않는다.
- Dalue API 키는 스토어 공개 페이지에 이미 노출된 검색 키이며 개인 자격증명이 아니다. 코드에 하드코딩하지 않는다.
