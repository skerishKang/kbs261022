# data/full_catalog — 파일 목록

이슈 #19 전체 상품 DB 산출물. 어떤 파일이 정본인지 명확히 하기 위한 안내.

## 정본 (이슈 #8 통합 상품 마스터 스키마 기준)

| 파일 | 내용 |
|---|---|
| **`product_db.xlsx`** | **정본 Excel DB** — 8시트, 통합상품 4,575행. 이슈 #8 스키마(PR #16) + 이슈 #8 중복 판정 알고리즘 적용 |
| `category_catalog.csv` | 사이트별 카테고리 카탈로그. `cate_no` namespace 분리 |
| `../reports/data/issue19/full_verification.json` | **정본 검증 결과** (8항목 PASS) |
| `../reports/data/issue19/site_data_verification.json` | Excel ↔ 쇼핑몰 JSON 대조 결과 |

## 수집 측 산출물 (Model B 스키마 기준, 참고용)

| 파일 | 내용 |
|---|---|
| `collection_stats.json` | 수집측 통계 (Model B 스키마 기준 중복 판정 결과) |
| `product_db_compact.csv` | 수집측 마스터 경량 CSV |
| `options_compact.csv` | 수집측 옵션 SKU 경량 CSV |
| `browser_verification.json` | 계층화 표본 브라우저 교차검증 결과 |
| `search_completeness.json` | 사이트 검색 총건수 대조 결과 |
| `category_view_counts.json` | 카테고리 뷰별 상품 수 재계산 |
| `source_domains_probe.json` | 공급처 관계(도메인) 실측 |
| `brand_catalog_probe.json` | 브랜드 카탈로그 실측 |
| `local_artifacts_manifest.json` | CGI-1 로컬 대용량 산출물 경로·해시 |

> **두 개의 XLSX 빌더가 존재한다.**
>
> | 빌더 | 스키마 | 산출물 |
> |---|---|---|
> | `tools/full_catalog/build_full_catalog.py` | 이슈 #8 통합 스키마 | **정본** `product_db.xlsx` (8시트) |
> | `tools/full_catalog/build_product_db.py` | Model B 스키마 | 로컬 `C:\cgi-work\catalog-data\product_db.xlsx` (7시트) |
>
> 중복 판정 결과가 다른 이유: 수집측 빌더는 문자열 유사도, 정본 빌더는
> 이슈 #8 의 "모델 표현 + 변형 서명" 규칙(확신 부족한 중복은 자동 병합 금지)을
> 사용한다. **저장소의 정본은 `product_db.xlsx`** 이다.

## 로컬 보관 (대용량, 저장소 미포함)

| 파일 | 경로 | 크기 |
|---|---|---|
| 수집 원본 상세 | `C:\cgi-work\catalog-data\samasound_detail.json` | 6.9 MB |
| 수집 원본 상세 | `C:\cgi-work\catalog-data\samamusic_detail.json` | 8.9 MB |
| 수집 원본 전체 | `C:\cgi-work\catalog-data\all_detail.json` | 15.2 MB |
| 통합 마스터 전체 | `C:\cgi-work\catalog-data\full\product_master.full.json` | 대용량 |
| 수집 캐시 | `C:\cgi-cache` | 8,054 URL |
