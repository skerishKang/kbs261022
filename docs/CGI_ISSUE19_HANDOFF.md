# CGI 이슈 #19 인계 — 전체 상품 데이터 확보 완료

> 대상: #19 담당자 · 작성: LOCAL (2026-10-22)
> 본 문서는 **#19 산출물(XLSX)을 직접 만들기 위한 것이 아니라**, #19가 그대로 소비할 수 있는
> 데이터·코드·규격을 인계하는 문서다. XLSX 빌더까지 제공했으므로 **중복 구현하지 말 것.**

---

## 1. 인계물 요약

| 구분 | 항목 | 경로 |
|---|---|---|
| 정본 데이터 | 40컬럼 상품 마스터 4,575행 (CSV/JSON) | 로컬 `.work/full_catalog/product_master_full.csv` / `.json` |
| XLSX | 7시트 (4,575행) | 로컬 `.work/full_catalog/product_master_full.xlsx` |
| 빌더 코드 | XLSX 생성기 | `tools/catalog_collection/build_xlsx_db.py` |
| 수집 코드 | 전체 수집 오케스트레이터 | `tools/catalog_collection/collect_full_catalog.py` |
| 검증 코드 | Playwright 2층 교차검증 | `tools/catalog_collection/verify_browser.py` |
| 공개 API 덤프 | Tri-B 스토어 전체 인덱스 3,694건 | `tools/catalog_collection/dalue_export_full.py` |
| 카테고리 카탈로그 | 893행 (2사이트) | `reports/samples/category_catalog_full.csv` (공개) / 로컬 전문본 |
| 품질 통계 | 필드별 확보율 · 공개가 상태 | `reports/samples/full-catalog-quality.csv` (공개) |
| 규모 분해 | 20,000 주장 대조 근거 | `reports/samples/full-catalog-scale.json` (공개) |
| 중복 후보 | 544건 (자동 병합 0) | `reports/samples/full-catalog-duplicate-candidates.csv` (공개) |
| 브라우저 검증 | 48건 100% 일치 | `reports/samples/browser-verification-48.csv` (공개) |
| 마스터 샘플 | 30행 | `reports/samples/product_master_full_sample.csv` (공개) |
| 상세 보고서 | 분석 전문 | `reports/full-catalog-collection-report.md` |
| 고객 요약 | 비전문용 | `reports/customer-summary-full-catalog.md` |

**대용량 원본은 공개 저장소에 올리지 않았다**(대표 지침). 로컬 보존 + 재현 코드 제출 방식이다.

---

## 2. 스키마

정본 스키마는 **PR #12 의 `skills/cgi-catalog-collector/schema/product-master.schema.json` (40컬럼)** 을 그대로 사용했다. 이 PR 은 스키마를 새로 만들지 않았다.

| 컬럼 | Tri-A | Tri-B | 비고 |
|---|---:|---:|---|
| `source_site` / `source_site_label` | 100% | 100% | `samasound` / `samamusic` |
| `source_category_id` / `_name` / `_path` | 100% | 100% | Tri-B 는 스토어 등록 카테고리 기준(Dalue `categoryNos`) |
| `source_brand` | 100% | 100% | Tri-A 는 `제조사` 행 |
| `source_product_id` | 100% | 100% | 원천키 |
| `source_item_code` / `product_code` | 100% | 85.1% | 카페24 P+7 코드 |
| `product_name` | 100% | 100% | |
| `model` | **0%** | 75.9% | Tri-A 필드 부재 |
| `canonical_url` / `source_list_url` / `source_evidence` | 100% | 100% | canonical 은 `samasound.co.kr` / `samastore.co.kr` 호스트 |
| `summary` / `short_description` | 96.6% / 37.9% | 80.3% / 55.7% | |
| `manufacturer` / `country_of_origin` | 100% / 100% | 0% / 100% | Tri-B 는 제조사 없음 |
| `specs` | 100% | 100% | 기본정보 표 전체 JSON (라벨 free-form) |
| `image_urls` | 100% | 100% | `/web/product/` 경로만 (검증으로 정정) |
| `option_summary` / `option_count` | 100% / 0건 | 100% / 587건 | 옵션 그룹 수 기준 |
| `published_price` / `_text` / `_state` / `_unavailable` | 0 / 100% / 100% / 100% | 92.4% / 100% / 100% / 100% | Tri-A 전건 `inquiry_price` |
| `retail_list_price` / `consumer_price` / `min_selling_price` | 0% | 24.8% 등 | 정가 |
| `tax_excluded_component` | 100% | 100% | `_iPrdtPriceOrg` (부가세 차감 구성액, **공급가 아님**) |
| **`dealer_price_unverified`** | **0% (의도)** | **0% (의도)** | 공개 근거 없음 → NULL |
| `availability_unverified` / `stock_display` / `soldout_display` | 100% / 100% / 1.1% | 100% / 85.1% / 29.9% | 공개 표기만 |
| `product_status_flags` | 100% | 100% | `main_soldout_icon` / `addon_soldout:<id>` 분리 기록 |
| `updated_at` / `extraction_method` / `verification_status` / `source_evidence` | 100% | 100% | 수집 시각·방법·검증상태 |
| `list_observed_price` / `list_page_url` | 0% / 100% | 92.4% / 100% | 목록 관측값(대조용) |

---

## 3. XLSX 시트 정의 (7개)

| 시트 | 행 | 키 | 내용 |
|---|---:|---|---|
| `통합상품` | 4,575 | (source_site, source_product_id) | 핵심 21 + 확장 9 (원본 JSON). 셀 32,767자 초과 시 잘림 표기 |
| `공급처원본` | 4,575 | 동일 | 원문 상품명·요약, 원본/목록 URL, 원천 분류경로, 공개가 원문·상태, 품절·재고 표기, 옵션수, 이미지수, 수집시각·방법·검증상태 |
| `브랜드·카테고리` | 브랜드별 | (source_site, source_brand) | 상품수·공개가수·옵션보유·평균공개가·출현카테고리수 |
| `카테고리목록` | 893 | (source_site, category_id) | 카테고리명·경로·레벨·부모명·등록수(카페24)·수집수·목록URL |
| `중복후보` | 544 | — | 유형(동일공급처/사이트간)·양쪽 ID·상품명·브랜드·근거·**자동병합 N** |
| `누락·검증현황` | 집계 | — | 필드별 확보율, 공개가 상태 분포, **미확정 항목 3종**(공급가/재고/CGI승인 NULL 사유) |
| `향후네이버·이카운트` | 4,575 | (source_site, source_product_id) | 이카운트 필드 슬롯(품목코드/브랜드/모델/규격/단위/입고단가/출고단가) + 네이버 카테고리ID·상품ID 슬롯 + 매핑준비도 + 비고 |

> 셀 상한 때문에 `specs`·`option_summary` 는 32,767자로 잘린다. **정본은 CSV/JSON** 이다.

---

## 4. #19 담당자가 해야 할 것 / 하지 말 것

**하지 말 것**
- XLSX 빌더를 다시 만들지 말 것 → `tools/catalog_collection/build_xlsx_db.py` 로 생성 가능
- 수집기를 다시 만들지 말 것 → PR #12 수집기를 재사용
- `site/data/products.json` 을 직접 고치지 말 것 → PR #15 와의 충돌 위험. `build_catalog_data.py --master-csv <전체마스터.csv>` 로 재생성 후 조율

**해야 할 것**
1. XLSX 7시트 검수 (특히 `누락·검증현황` 의 NULL 항목이 의도대로인지)
2. **CGI 공급가 · 실재고 · CGI 판매가 · 취급 승인** 을 채우는 경로 확정 (공개값 아님)
3. **네이버 카테고리 ID 매핑** (`향후네이버·이카운트` 시트의 빈 슬롯)
4. **Tri-A 모델명 추출 파이프라인** (상품명 → 모델). 규칙 확정 전까지 `model` 은 빈 값 유지
5. `#11` 담당자와 `site/data/products.json` 재생성·커밋 조율

---

## 5. 알려진 제약

| 제약 | 내용 |
|---|---|
| 대용량 원본 미공개 | 대표 지침. 로컬 보존 + 재현 코드 제출 |
| 공급가/재고/승인 NULL | 공개 근거 없음. **의도된 공란** |
| Tri-A 모델 0% | 사이트에 필드가 없음 |
| Tri-B 제조사 0% | 사이트에 행이 없음 |
| Tri-B item_code 공란 341건 | 상품코드 미부여 상품 |
| 옵션 개수 정의 | `option_count` 는 **그룹 수**. 값 수는 `option_summary` JSON 참조 |
| Tri-B 숨김 1,400건 | 상세 미수집(의도). 공개검색 API 필드만 확보 |
| 등급/권한 | PR #16 `tools/product_master/` 와 **컬럼명이 달라**(#12 40컬럼 vs #16 34컬럼). 통합 어댑터 필요 |

---

## 6. 재현

```bash
git clone https://github.com/skerishKang/kbs261022.git && cd kbs261022
git checkout feature/issue-19-full-product-details
pip install requests openpyxl playwright && python -m playwright install chromium

python tools/catalog_collection/collect_full_catalog.py --stage categories --site samasound
python tools/catalog_collection/collect_full_catalog.py --stage categories --site samamusic
python tools/catalog_collection/collect_full_catalog.py --stage details --site samasound --workers 4
python tools/catalog_collection/collect_full_catalog.py --stage details --site samamusic --workers 4
python tools/catalog_collection/collect_full_catalog.py --stage merge
export DALUE_API_KEY=<스토어 공개 검색키>
python tools/catalog_collection/dalue_export_full.py --out .work/full_catalog/triB_dalue_full.json
python tools/catalog_collection/verify_browser.py --master .work/full_catalog/product_master_full.csv \
  --sample .work/full_catalog/verify_sample.csv --out .work/full_catalog/browser_verification.csv
python tools/catalog_collection/build_xlsx_db.py --master .work/full_catalog/product_master_full.csv \
  --cats .work/full_catalog/category_catalog_full.csv \
  --quality .work/full_catalog/product_master_full_quality.csv \
  --out .work/full_catalog/product_master_full.xlsx
```

PR #12 수집기가 main 에 아직 없으면 `collect_full_catalog.py` 가 `origin/feature/site-analysis-model-b` 에서 자동으로 읽어 로컬 캐시에 복사한다(원본 미수정).
