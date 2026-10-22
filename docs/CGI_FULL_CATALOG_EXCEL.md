# CGI 전체 상품 Excel DB 및 쇼핑몰 데이터 연결 (이슈 #19)

> 수집 측 분석(완결성·누락·"약 2만 개" 주장 근거)은
> [`CGI_FULL_CATALOG_ANALYSIS.md`](CGI_FULL_CATALOG_ANALYSIS.md) 와
> [`CGI_FULL_CATALOG_TESTLOG.md`](CGI_FULL_CATALOG_TESTLOG.md) 를 참고.
> 이 문서는 **통합 상품 마스터(PR #16) 기준 DB 제작과 쇼핑몰 연결**을 다룬다.

---

## 1. 결론

| 항목 | 값 |
|---|---|
| 원천 상품 | 삼아사운드 **2,281** + 삼아스토어 **2,294** = **4,575건** |
| 통합 상품 마스터 | **4,575건** (스키마 검증 오류 0, 복합키 중복 0) |
| Excel | `data/full_catalog/product_db.xlsx` (3,176,083 bytes, 8시트) |
| 쇼핑몰 JSON | `site/data/products.json` (4,575건) — Excel 과 **건수·식별자 100% 일치** |
| 교차 확인 | 브라우저(공개 원본) ↔ 수집 ↔ 마스터 ↔ Excel ↔ 쇼핑몰 JSON 5단 일치 |
| 테스트 | **80개** (이슈 #8 스키마 62 + 이슈 #19 통합 18) |
| 검증 항목 | **8/8 PASS** |

> **"약 20,000개" 구분**: 김범신 대표가 언급한 약 2만 건은 현재 확인된
> **4,575건과 별개**이며, 공개 웹에서 확인 가능한 전체 상품 수로서는
> **미확인(UNVERIFIED)** 이다. 근거는 `CGI_FULL_CATALOG_ANALYSIS.md` §5 참조.
> 이 DB 는 4,575건만 담는다.

---

## 2. 파이프라인

```
공급처 공개 수집 (CGI-1 로컬, 대용량)
  samasound_detail.json  2,281건
  samamusic_detail.json  2,294건
        │
        │  tools/full_catalog/build_full_catalog.py
        │  └─ 이슈 #8 스키마(tools/product_master/)로 정규화
        │  └─ 이슈 #8 중복 판정(dedupe.py)으로 그룹화
        ▼
  product_master.full.json / .csv      4,575건 (PR #16 스키마)
  catalog_source.csv / category_catalog.csv
        │
        │  tools/full_catalog/build_site_data.py
        │  └─ PR #17 tools/build_catalog_data.py 를 그대로 재사용
        ▼
  site/data/products.json  (4,575건, 11,294,137 bytes)
  site/data/products.js    (file:// 용)
        │
        ▼
  tools/full_catalog/verify_full_catalog.py  →  8/8 PASS
```

---

## 3. Excel 시트 구성

`data/full_catalog/product_db.xlsx` — openpyxl 로 실제 파일을 만들고
`openpyxl.load_workbook(read_only=True)` 로 다시 열어 검증한다.

| # | 시트명 | 행수 | 컬럼 | 내용 |
|---|---|---|---|---|
| 1 | `통합상품` | **4,575** | 34 | 통합 상품 마스터. 공급처 원본 ID·카테고리 namespace·중복 그룹·품질 플래그 |
| 2 | `공급처원본` | **4,575** | 20 | 공급처별 원본 상품. 원본 ID/상품코드/품목코드/원문 URL/수집 근거 |
| 3 | `브랜드_카테고리` | 374 | 7 | 브랜드 × 카테고리. ** cate_no namespace 반드시 함께 표기** |
| 4 | `중복후보` | 1,333 | 19 | 중복 확정 및 검토 후보 (판정·근거·자동병합 가능 여부) |
| 5 | `누락_검증현황` | **4,575** | 20 | 가격·이미지·규격·브랜드·제조사·모델·옵션 누락 여부 |
| 6 | `네이버스토어준비` | **4,575** | 16 | 스마트스토어 등록 준비. **네이버 ID/카테고리는 전건 공란** |
| 7 | `이카운트품목매핑` | **4,575** | 14 | ERP 품목 매핑 준비. **ERP/거래처 코드는 전건 공란** |
| 8 | `옵션SKU` | 3,541 | 8 | 옵션 값·품절·추가금·원본 품목코드 (보조 시트) |

### 3.1 확인되지 않은 값은 공란

| 필드 | 상태 | 근거 |
|---|---|---|
| `도매가` | **전건 공란** | 공개 근거 없음 (B2B 도매가는 문의해야 함) |
| `재고` | **전건 공란** | 두 사이트 모두 공개 재고 근거 없음 |
| `네이버상품ID` | **전건 공란** | 스마트스토어 개설 전 |
| `스마트스토어카테고리번호` | **전건 공란** | 개설 전 |
| `이카운트품목코드` / `이카운트거래처코드` | **전건 공란** | ERP 미개설 |
| `매핑준비` | 전건 `아니오` | 위와 동일 |
| `공개판매가` | 2,117건만 숫자 | 나머지 2,458건은 "가격 문의" → **숫자를 만들지 않음** |

### 3.2 공급처 원본 ID 보존

`공급처원본` 시트는 `공급처원본ID`(= 공급처별 product_no), `원본상품코드`,
`원본품목코드`, `원본카테고리ID`, `canonical_url`, `목록URL` 을 원문 그대로
보관한다. 통합 시트도 `공급처원본ID` 를 키로 쓴다.

---

## 4. 사이트별 필드 차이 (이슈 #8 스키마 반영)

전수 수집 4,575건이 **이슈 #8 브라우저 실측과 정확히 일치**했다.

| | 삼아사운드 | 삼아스토어 |
|---|---|---|
| 건수 | 2,281 | 2,294 |
| `브랜드` 스펙행 | **없음** → `brand_source='category'` (브랜드 카테고리 파생) | 있음 → `brand_source='spec'` (2,294/2,294) |
| `제조사` 스펙행 | 있음 2,281/2,281 | **없음** → `manufacturer_source='none'` |
| `모델명` 스펙행 | **없음** → `model` 전건 null | 1,740/2,294 만 존재 |
| 공개 판매가 | **0건** (전량 inquiry) | 2,117건 숫자 / 89 inquiry / 87 판매완료 / 1 기타 |
| 옵션 | 없음 | 580건 보유 |

**브랜드 근거를 명시하기 위해 이슈 #8 스키마를 1.1.0 으로 확장**했다.
`brand_source` / `manufacturer_source` 두 필드로 "값이 어떤 근거에서 왔는지"를
기록하므로, 브랜드와 제조사가 혼동되지 않는다.

* `Fender Studio Pro` → `brand='PreSonus'`(카테고리 파생) / `manufacturer='PreSonus'`(스펙행)
  — 상품명 속 "Fender" 를 브랜드로 승격하지 않는다.
* `SQ5+` → `brand='ALLEN&HEATH'` / `manufacturer='Allen&Heath'`
* `WL185MB/C-TQG` (samamusic) → `brand='SHURE'`(스펙행) / `manufacturer=null`

### 4.1 카테고리 namespace 분리

`cate_no` 는 사이트마다 별도 namespace 로 분리했다.
**양쪽에 동시에 존재하는 번호 10개**가 실제로 다른 카테고리를 가리킨다.

```
88, 228, 333, 346, 367, 368, 369, 370, 415, 424
```

예: `42` = 삼아사운드 **Shure** / 삼아스토어 **스피커**.
→ `브랜드_카테고리` 시트는 `cate_no_namespace` 컬럼을 반드시 함께 표기한다.

---

## 5. 중복 판정 (이슈 #8 알고리즘)

| 항목 | 값 |
|---|---|
| 교차 사이트 후보 | **1,333** |
| confirmed (자동 병합) | **538** |
| candidate (검토 필요, 자동 병합 금지) | 521 |
| probable (검토 필요, 자동 병합 금지) | 274 |
| 자동 병합 그룹 | 538 (모두 2건 구성) |
| 같은 사이트 복합키 중복 | **0** |

실제 confirmed 쌍 (무작위 표본):

| 삼아사운드 | 삼아스토어 |
|---|---|
| KSM9HS | SHURE KSM9 HS 슈어 보컬용 컨덴서 마이크 (1,180,000원) |
| NC3FDX-EMC-SPEC | NEUTRIK NC3FDX-EMC-SPEC (41,000원) |
| Eris Sub 8 BT | PreSonus Eris Sub 8 BT (370,000원) |
| RP2RC | REAN RP2RC (2,380원) |
| StudioLive SE24 | PreSonus StudioLive SE24 |
| SCY2040 클로츠 설치용 스피커 케이블 | KLOTZ SCY2040 (1,095,000원) |
| NA3MP | NEUTRIK NA3MP (24,300원) |

**자동 병합하지 않은 쌍**은 같은 모델의 다른 구성(예: `KSM32C 라이트 세트` ↔
`KSM32C 프리미엄 세트`)처럼 변형이 다른 경우이며, `candidate` 로 남겨
사람이 확인하도록 한다.

---

## 6. 누락률 (4,575건 기준)

| 필드 | 누락 | 비율 | 사유 |
|---|---|---|---|
| 이미지 | 0 | 0.0% | 전량 확보 |
| 규격행 | 0 | 0.0% | 전량 확보 |
| 브랜드 | 0 | 0.0% | 전량 확보 (근거 수준은 다름) |
| 공개 판매가 | 2,458 | 53.7% | 삼아사운드 전량 inquiry + 삼아스토어 177건 |
| 제조사 | 2,294 | 50.1% | 삼아스토어에 제조사 스펙행 없음 |
| 모델명 | 2,835 | 62.0% | 삼아사운드 전량 + 삼아스토어 554건 |
| 옵션 | 3,995 | 87.3% | 대부분의 상품이 단일 옵션 |

누락은 **수집 실패가 아니라 원천에 없는 것**이다. 임의로 채우지 않는다.

---

## 7. 쇼핑몰 데이터 연결

`tools/full_catalog/build_site_data.py` 는 **PR #17 의
`tools/build_catalog_data.py` 를 수정 없이 재사용**한다. 쇼핑몰 UI와 스키마는
건드리지 않았다. (표시 문구 2곳만 "수집 샘플" → "공급처 공개 수집" 으로 사실에 맞게 수정)

### 7.1 Excel ↔ JSON 대조

```
site_products=4575  master_products=4575
count_match=true  id_match=true
missing_in_site=0  extra_in_site=0  duplicate_ids=0
count_match_xlsx=true
```

### 7.2 브라우저 실제 동작 검증 (ZCode 내장 브라우저)

로컬 HTTP 서버로 `site/` 를 서빙해 실제 확인했다.

| 화면 | 확인 결과 |
|---|---|
| 홈 | 표시 중인 상품 **4,575** / 브랜드 **64** / 공개 판매가 **2,117**(미공개 2,458은 가격 문의) / 공급처 카탈로그 규모 삼아스토어 2,294건 · 삼아사운드 2,281건 |
| 브랜드 필터 | 64개 브랜드 칩과 상품 카드 렌더 정상 |
| 상품 상세 (samamusic 5557) | WL185MB/C-TQG / SHURE · 모델 WL185MB/C-TQG / 279,000원 / 출처 삼아스토어 원본 ID 5557 / 원본 페이지 링크 |
| 상품 상세 (samasound 3875) | WL185MB/C-TQG / SHURE · 제조사 Shure / **가격 문의** + "공급처에 공개된 판매가가 없어 문의로 표기합니다." / 출처 삼아사운드 원본 ID 3875 |

두 건 모두 이슈 #8 에서 ZCode 브라우저로 직접 확인한 상품과 **동일 데이터**다.

---

## 8. 검증 (8/8 PASS)

`tools/full_catalog/verify_full_catalog.py` 실행 결과
(`reports/data/issue19/full_verification.json`).

| 검증 항목 | 결과 |
|---|---|
| 원천 ↔ 마스터 건수 일치 | PASS (4,575 = 4,575) |
| 마스터 스키마·정책 검증 | PASS (구조 오류 0, 정책 오류 0) |
| 사이트 카테고리 namespace 분리 | PASS |
| Excel 실제 열기 검증 | PASS (8시트 모두 재오픈 성공) |
| 필수 7개 시트 존재 | PASS |
| Excel ↔ 마스터 건수 일치 | PASS (4,575) |
| HTML JSON ↔ 마스터 건수 일치 | PASS (4,575) |
| HTML JSON ↔ 마스터 식별자 일치 | PASS (불일치 0) |

추가로 별도 확인:

* Excel 8개 시트 행수 = 통합/공급처원본/누락/네이버/이카운트 각 4,575,
  중복후보 1,333, 브랜드_카테고리 374, 옵션SKU 3,541
* `verify_handoff` — COM1 전달본 SHA256 재검증 통과

---

## 9. 테스트

| 스위트 | 개수 | 결과 |
|---|---|---|
| `tools/product_master/tests` (이슈 #8) | 62 | OK |
| `tools/full_catalog/tests` (이슈 #19) | 18 | OK |
| 합계 | **80** | **OK** |

```bash
python -m unittest discover -t . -s tools/product_master/tests -v
python -m unittest discover -t . -s tools/full_catalog/tests -v
```

---

## 10. 산출물 위치

| 파일 | 위치 | 크기 |
|---|---|---|
| Excel DB (8시트) | `data/full_catalog/product_db.xlsx` | 3,176,083 B |
| 카테고리 카탈로그 | `data/full_catalog/category_catalog.csv` | 31,185 B |
| 쇼핑몰 JSON | `site/data/products.json` | 11,294,137 B |
| 쇼핑몰 JS (file://용) | `site/data/products.js` | 11,296,154 B |
| 통합 검증 결과 | `reports/data/issue19/full_verification.json` | — |
| 사이트 대조 결과 | `reports/data/issue19/site_data_verification.json` | — |
| 수집 원본·마스터 전체 | **CGI-1 로컬** `C:\cgi-work\catalog-data\` | 대용량 |

대용량 원본(수집 덤프 15MB+, 마스터 전체 JSON/CSV)은 요구사항대로 CGI-1 로컬에
보존하고, 저장소에는 재현 가능한 코드·스키마·검증 결과·실제 Excel/JSON 만
포함했다.

---

## 11. 남은 작업

* 상품별 판매상태(품절/판매중지) 원시 표기가 3,988건 중 1,700건 "품절(판매중지)" 로
  수집된다. 재고 수량은 공개 근거가 없어 계속 공란이며, 이 값은 **판매 상태 표기**로만
  별도 보존해야 한다(현재는 스펙 원문 안에만 있음).
* 삼아스토어 상세 554건은 `모델명` 스펙행이 없어 `model` 이 null 이다. 동일 모델이
  다른 상품에 등장하는지 사람이 확인할 필요가 있다(521건 candidate).
* "약 2만 개" 주장에 대응하려면 스마트스토어·ERP 등 다른 원천 확인이 선행되어야 한다.
* ERP 매핑(7번 시트)은 실제 이카운트 계정·거래처 구조가 확정되면 그때 채운다.
