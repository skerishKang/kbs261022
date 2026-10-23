# CGI 이슈 #19 인계 — 전체 상품 데이터 확보 완료

> 대상: #19 담당자 · 작성: LOCAL (2026-10-22)
> 본 문서는 **#19 산출물(XLSX)을 직접 만들기 위한 것이 아니라**, #19가 그대로 소비할 수 있는
> 데이터·코드·규격을 인계하는 문서다. XLSX 빌더까지 제공했으므로 **중복 구현하지 말 것.**

> ## ⚠ 2026-10-23 반영 현황 (main 실측으로 정정)
>
> 아래 §1~§3은 **인계 당시(10-22) 로컬 작업 기준** 기록이다. #19는 이후 PR #26·#27·#28 로 main 에 병합돼
> 산출물이 저장소 안으로 들어왔고, 시트 구성도 바뀌었다. **정본은 다음 표**다.
>
> | 항목 | 인계 당시 문서의 값 | main 실측(2026-10-23) |
> |---|---|---|
> | 엑셀 정본 위치 | 로컬 `.work/full_catalog/product_master_full.xlsx` | `data/full_catalog/product_db.xlsx` (3,176,083B · sha256 `ee61ac545e51b043…`) |
> | 시트 수 | 7 | **8** (통합상품 4,575×34 · 공급처원본 4,575×20 · 브랜드_카테고리 374 · 중복후보 1,333×19 · 누락_검증현황 4,575×20 · 네이버스토어준비 4,575×16 · 이카운트품목매핑 4,575×14 · 옵션SKU 3,541×8) |
> | 빌더 | `tools/catalog_collection/build_xlsx_db.py` | `tools/full_catalog/build_full_catalog.py`(정본) · `build_product_db.py`(7시트 계열) · 검증 `verify_full_catalog.py` |
> | 중복 후보 | 544건 | **세 가지 수치가 서로 다른 계산**: `reports/samples/full-catalog-duplicate-candidates.csv` 544행(10-22 판정) · 엑셀 `중복후보` 1,333행(confirmed 538 / probable 274 / candidate 521) · 이슈 #43 QA 계층 1,353쌍. 자동 병합은 **어느 판정에서도 0건** |
> | 카테고리 목록 | 893행 | `reports/samples/category_catalog_full.csv` 845행 · `data/full_catalog/category_catalog.csv` 238행(사이트 목록 기준). 893행본은 저장소에 없다 |
> | 스키마 | PR #12 `skills/cgi-catalog-collector/schema/product-master.schema.json`(40컬럼) | 그 경로는 main 에 없음(미병합). 통합 스키마 정본은 `schemas/product-master-record.schema.json`(필수 16컬럼) + `docs/CGI_PRODUCT_MASTER_SCHEMA.md` |
> | Tri-A 모델명 0% | §2 표 기준 | 이슈 #43 Stage 1+2 에서 모델명 408건 자동 확정(원본 보존). 정본 엑셀 `모델명` 채움률은 1,740/4,575 |
>
> §4의 "해야 할 것"은 1번(XLSX 검수)·5번(#11 연계)이 끝났고, 2·3·4번은 남았다. 상세는 아래 §4 갱신분.

---

## 1. 인계물 요약

| 구분 | 항목 | 경로 |
|---|---|---|
| 정본 데이터 | 40컬럼 상품 마스터 4,575행 (CSV/JSON) | (인계 당시 로컬) `.work/full_catalog/product_master_full.csv` / `.json` — main 정본은 `data/full_catalog/product_db_compact.csv` 4,575행 |
| XLSX | 7시트 (4,575행) | (인계 당시 로컬) `.work/full_catalog/product_master_full.xlsx` — main 정본은 `data/full_catalog/product_db.xlsx` **8시트** |
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

**해야 할 것** (2026-10-23 상태 반영)
1. ~~XLSX 7시트 검수~~ → **완료.** 8시트 정본 `data/full_catalog/product_db.xlsx` 로 검수·출처 채움률 실측 완료(출처URL·목록URL·수집시각·검증상태·출처증거 4,575/4,575). 단 `공급처원본` 시트의 `수집시각` 열은 커밋본에서 빈 칸(같은 행의 출처정보와 수집시각이 통합상품 시트에는 있음). 빌더 보완은 PR #61, 커밋본 재생성은 하지 않았다.
2. **CGI 공급가 · 실재고 · CGI 판매가 · 취급 승인** 을 채우는 경로 확정 (공개값 아님) — **미완료.** 정본에서 `도매가`·`재고` 는 0/4,575(의도된 NULL).
3. **네이버 카테고리 ID 매핑** (`향후네이버·이카운트` 시트의 빈 슬롯) — **미완료.** `네이버상품ID`·`ERP품목코드` 0/4,575. 필드 준비도는 이슈 #5 증분 작업(`tools/full_catalog/naver_field_readiness.py`)이 대체.
4. **Tri-A 모델명 추출 파이프라인** (상품명 → 모델) — **부분 완료.** 이슈 #43 Stage 1 자동 368건 + Stage 2 승격 40건 = 408건. 남은 검토후보 2,311건은 사람 결정 대기.
5. ~~`#11` 담당자와 `site/data/products.json` 재생성·커밋 조율~~ → **완료.** `site/data/products.json` 4,575건 커밋, 엑셀과 건수·식별자 일치.

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
| `공급처원본` 시트 `수집시각` 공란 | 2026-10-23 실측 0/4,575. 빌더(`build_full_catalog.py` 의 `build_supplier_sheet`)가 원본 레코드의 `updated_at` 만 읽는데 상세 덤프(`C:\cgi-work\catalog-data\*_detail.json`)에 그 필드가 0건이라 비었다. 통합상품 시트의 `수집시각` 은 **4,575행이 모두 `2026-10-22T05:21:38Z` 하나로, DB 생성(빌드) 시각**이다 — 상품별 갱신 시각이 아니다. 커밋본은 재생성하지 않았고, 다음 재생성부터 같은 값이 공급처원본 시트에도 적힌다(PR #61) |
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
