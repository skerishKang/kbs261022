# CGI 전체 상품 데이터 확보·검증 보고서 (이슈 #19 데이터 공급분)

> **보안 원칙**
> - 실운영 데이터(거래처 실명, 주문, 재고 실수량, 인증키)는 수집·보존·공개하지 않았다.
> - **CGI 공급가 · 실재고 · CGI 판매가 · 취급 승인 여부** 는 공개 근거가 없어 **빈 값(NULL)** 로 두었다. 추정하지 않았다.
> - 대용량 산출물(전체 마스터 CSV 11.7MB / JSON / XLSX 2.5MB)은 **로컬 보존**하고, GitHub 에는 **재현 코드 · 스키마 · 비식별 통계 · 검증 결과** 만 제출했다(이슈 #19 대표 지침).
> - 계정정보는 이 저장소에 기록하지 않았다.

- 저장소: `skerishKang/kbs261022` · 브랜치: `feature/issue-19-full-product-details`
- 기준: `origin/main` (`ae3e06b`) · 이전 작업: 이카운트 분석 PR #21 / 공급처 분석 PR #6·#12·#13 / 카탈로그 사이트 PR #17
- 조사·수집일: 2026-10-22

---

## 0. 완료 지표

```
STATUS=COMPLETE

# ── 1단계: ERP PR 정리 ──────────────────────────────
ERP_PR=#21
ERP_PR_MERGEABLE=YES (mergeStateStatus=CLEAN)
ERP_PR_HEAD_SHA=92a8da4c334e485a87660eca8c5b188ac7a3bc0a
ERP_PR_CONFLICT_FILES=0
ERP_PR_MERGE_WITH_PR12=clean

# ── 2단계: 전체 상품 데이터 ──────────────────────────
PRODUCT_ISSUE=#19
PRODUCT_PR=(이 PR)
PRODUCT_HEAD_SHA=(본 PR 커밋)

SAMASOUND_LIST_COUNT=2281
SAMASTORE_LIST_COUNT=2294
TOTAL_SOURCE_RECORDS=4575
DETAILS_COLLECTED=4575  (fail=0, 실패 0건)
IMAGES_COLLECTED=4575  (공급처 상품 이미지 1건 이상 보유 100%)
PUBLIC_PRICES_COLLECTED=2120  (Tri-A 0 / Tri-B 2,120 = 92.4%)
OPTIONS_COLLECTED=587  (Tri-B 옵션 보유 상품 / Tri-A 0)

BROWSER_VERIFIED=YES
BROWSER_SAMPLE_COUNT=48
BROWSER_MATCH_RATE=100.0%  (L1 렌더 대조 48/48, L2 파서 동등성 48/48)

ADDITIONAL_SOURCES=Tri-B 공개검색API(Dalue/DCSE) 3,694건 · 이카운트 ERP 실계정(품목 964 / 거래처 1,505)
20000_PRODUCT_CLAIM=UNVERIFIED

EXCEL_DATA_READY=YES (XLSX 7시트 4,575행, 로컬 보존)
CATALOG_JSON_READY=YES (JSON 4,575행, 로컬 보존 + CSV/JSON 제출본)
OTHER_AGENT_COLLISION=NONE (PR#12 수집기·스키마 재사용, 원본 미수정)

MERGED=NO
DEPLOYED=NO
REMAINING=#19 담당자 검수 · 네이버 카테고리 매핑 · CGI 판매가/공급가 승인 · 20,000 근거 제공
NEXT=#19 XLSX 검수 후 #11 site/ 데이터 경로 연결
```

---

## 1. 1단계 — PR #21 (이카운트) 마무리

| 단계 | 결과 |
|---|---|
| 최신 main 가져오기 | `origin/main` = `ae3e06b` (PR #17 카탈로그 사이트 병합본) |
| 기존 독립 worktree 사용 | `E:/kbs1022-2` (feature/erp-ecount-account-analysis) — 신규 worktree 없이 재사용 |
| 실제 충돌 파일 확인 | **충돌 0건.** `git merge-tree` + 실제 merge 모두 clean. main 변경분(`site/ tools/ docs/`)과 본 PR 변경분(`reports/ skills/ .gitignore`)이 완전 분리 |
| 이카운트 조사 결과 보존 | `reports/ecount-*.md` 4건 + `reports/ecount-*.csv` 3건 + `reports/erp-item-master-mapping.csv` + `skills/ecount-erp-browser/` 4건 = **12파일 전량 유지** |
| 다른 에이전트 파일 보호 | `git diff origin/main HEAD -- site tools docs` = **empty** (무변경) |
| 불필요한 변경 없이 충돌 해결 | `.gitignore` 의 동일 4줄이 **PR #12 와 바이트 단위 동일**하도록 주석 정렬 → PR #12↔#21 상호 병합 충돌 0건 |
| 집중 검사 | syntax check 통과(3 scripts), 계정정보 스캔 0건(패턴 7종 × 전체 파일) |
| 브랜치 업데이트 | push 완료 → HEAD `92a8da4c334e485a87660eca8c5b188ac7a3bc0a`, GitHub `mergeable=MERGEABLE / CLEAN` |

---

## 2. 2단계 — 전체 상품 상세 수집

### 2.1 재사용한 기존 자산 (중복 개발 0)

| 자산 | 출처 | 사용 방식 |
|---|---|---|
| `collect_cgi_catalog.py` (HTTP 수집·파싱·캐시) | **PR #12** | **원본 수정 없이** import 하여 재사용. main 미병합 시 `git show` 로 읽어 로컬 캐시에 복사 후 import |
| `product-master.schema.json` (40컬럼 스키마) | **PR #12** | 그대로 사용(본 PR 은 스키마를 새로 만들지 않음) |
| `dalue_export.py` (공개검색 API) | **PR #13** | API 계약·필드 구성을 참고해 `dalue_export_full.py` 로 확장(키는 환경변수로만 주입) |
| `build_catalog_data.py` (HTML 사이트 데이터 경로) | **main (PR #17)** | 본 PR 은 **건드리지 않음**. 40컬럼 마스터 CSV 를 그대로 넣으면 재사용 가능(§6) |
| `tools/product_master/` (정규화·중복·검증) | **PR #16** | **중복 개발하지 않음.** 중복 후보 산출은 마스터 필드로 계산해 CSV 제출(§5.4) |

> **새로 만든 것은 "전량 수집 오케스트레이터 + 검증기 + XLSX 빌더" 뿐**이고, 이들은 `tools/catalog_collection/` 라는 충돌 없는 신규 경로에 두었다.

### 2.2 수집 파이프라인

```
[1] 카테고리 목록 크롤   카테고리ID×(목록+페이지네이션) → 상품ID 로스터 + 카테고리 메타
                          Tri-A 361카테고리/18,125행 → unique 2,281
                          Tri-B 532카테고리/12,703행 → unique 2,294
[2] 상세 수집           상품ID → 상세 HTML → parse_detail → 40컬럼 마스터
                          Tri-A 2,281건 (fail 0) / Tri-B 2,294건 (fail 0)
[3] 병합+품질계산       product_master_full.csv / .json / _quality.csv
[4] 교차검증            Playwright 48건 렌더 대조 (L1) + 파서 동등성 (L2)
[5] 규모조사            Tri-B 공개검색 API 3,694건 + 이카운트 실계정 964/1,505
[6] 산출                XLSX 7시트 / CSV / JSON (로컬) + 공개 제출용 샘플·통계
```

- 지연 0.05~0.35초, 워커 4~6, 동일 URL 은 SHA1 디스크 캐시 재사용(재실행 시 네트워크 0)
- **robots.txt Disallow 경로 미방문**, robots 정책 준수
- 전체 요청: 카테고리 893 + 상세 4,575 = **약 5,500회**, 실패 0건

### 2.3 실측 상품 수

| | Tri-A 삼아사운드 | Tri-B 삼아스토어 | 합계 |
|---|---:|---:|---:|
| 카테고리 목록 크롤 unique 상품ID | **2,281** | **2,294** | **4,575** |
| 고유 canonical URL | 2,281 | 2,294 | 4,575 |
| 고유 item_code(SKU) | 2,281 | 1,953 | 3,401(합집합) |
| 고유 product_code | 2,281 | 1,953 | — |
| Tri-A 카페24 자체 등록 카운터(전체보기) | 2,229 | — | — |
| Tri-B 공개검색 API(판매중) | — | 1,969 | — |
| Tri-B 스토어 전체 인덱스(비노출 포함) | — | **3,694** | — |
| Tri-B 카테고리 목록 미노출(=비노출) | — | 1,400 | — |

> Tri-A 는 **브랜드 축(1,753) + 유형 축(526) + 전체보기(2)** 로 상품이 동시 노출되어, 축별 합이 unique 를 넘어간다. **unique 2,281 이 정확한 상품 수**다.

### 2.4 상세 필드 확보율 (4,575건 기준)

| 필드 | Tri-A (n=2,281) | Tri-B (n=2,294) | 비고 |
|---|---:|---:|---|
| canonical_url | 100.0% | 100.0% | 원본 상세 URL |
| product_name | 100.0% | 100.0% | |
| source_brand | 100.0% | 100.0% | Tri-A 는 `제조사` 행 |
| manufacturer | 100.0% | 0.0% | Tri-B 는 `브랜드` 만 있음 |
| **model** | **0.0%** | **75.9%** | Tri-A 에는 모델 필드가 **존재하지 않음** |
| source_category_path | 100.0% | 100.0% | Tri-B 는 스토어 등록 카테고리 기준 |
| specs (기본정보 표 전체) | 100.0% | 100.0% | 라벨 free-form JSON |
| image_urls | 100.0% | 100.0% | 2장 이상: Tri-A 2,281 / Tri-B 1,310 |
| option_summary | 100.0% | 100.0% | Tri-B 옵션 보유 587건, Tri-A 0건 |
| **published_price** | **0.0%** | **92.4%** | Tri-A 는 전건 "가격 문의" |
| retail_list_price(정가) | 0.0% | 24.8% | |
| source_item_code / product_code | 100.0% | 85.1% | Tri-B 일부 item_code 공란 |
| summary | 96.6% | 80.3% | |
| short_description | 37.9% | 55.7% | |
| country_of_origin | 100.0% | 100.0% | |
| soldout_display(품절 표기) | 1.1%(24) | 29.9%(686) | |
| **dealer_price_unverified** | **0.0%** | **0.0%** | 공개 근거 없음 → 의도적으로 공란 |
| availability_unverified | 100.0% | 100.0% | 공개 표기값만 |

**공개가 상태 분포**

| 상태 | Tri-A | Tri-B |
|---|---:|---:|
| `numeric_price` (공개 숫자) | 0 | 2,117 (92.3%) |
| `inquiry_price` (가격 문의) | **2,281 (100%)** | 89 (3.9%) |
| `sold_out_sale_completed` (판매 완료) | 0 | 87 (3.8%) |
| `not_for_sale` (판매 불료) | 0 | 0 |
| `other` | 0 | 1 |

---

## 3. 브라우저 교차검증 (48건)

### 3.1 설계

표본은 **39건 샘플로 종료하지 않고** 48건을 **층화 추출**했다.

| 축 | 구성 |
|---|---|
| 공급처 | Tri-A 7 · Tri-B 41 (Tri-A 가 1개 버킷뿐이라 소수) |
| 공개가 상태 | `numeric_price` 8 · `inquiry_price` 16 · `sold_out_sale_completed` 8 · `other` 1 |
| 옵션 유무 | 옵션 보유 16 · 옵션 없음 32 |
| 브랜드 | 20개 브랜드 (사이트별 상위 4 + 최하위 2 포함) |

### 3.2 2층 검증

| 층 | 방법 | 결과 |
|---|---|---|
| **L1 렌더 대조** | Playwright 로 실제 페이지를 열어 *보이는* 값(기본정보 표, `#span_product_price_text`, 옵션 select, 상품 이미지, canonical, 품절 표기)을 수집 레코드와 항목별 비교 | **48/48 일치 (100.0%)** |
| **L2 파서 동등성** | 브라우저가 받은 HTML 을 PR #12 수집기의 `parse_detail` 로 재파싱해 HTTP 수집 결과와 비교 | **48/48 일치 (100.0%)** |

**L2 48/48 은 "요청기(HTTP) 수집이 브라우저 렌더와 동일 결과를 낸다"를 항목별로 입증한다.**

### 3.3 검증 과정에서 발견해 **수정한 실제 결함 2건**

| # | 결함 | 증상 | 수정 |
|---|---|---|---|
| **D-1** | `image_urls`에 **비상품 이미지 혼입** | `/web/upload/NNEditor/...`(상세 편집기 이미지), `/_wg/img/category_bnr/...`(사이트 배너), `https://gi.esmplus.com/...`(외부 CDN 본문 이미지)가 상품 이미지로 기록됨. 예: 삼아스토어 358번 상품이 12개 URL(실제 상품 이미지 4개) | 수집 단계에서 `/web/product/` 경로만 채택하도록 정책 오버라이드. → 358번 = 4개로 정정 |
| **D-2** | **대표 이미지(big) 누락** | PR #12 수집기의 정규식 `class="(?:BigImage\|ThumbImage)"` 가 실제 마크업 `class="BigImage "`(후행 공백)를 놓쳐 **대표 이미지가 수집되지 않음**. 삼아사운드 776번: big 누락 → 1장만 기록 | 동일 오버라이드로 `<img>` 태그의 `/web/product/` 경로 전체를 수집 → 776번 = big+small 2장으로 정정 |

> 두 결함 모두 **브라우저 렌더 이미지 수와 수집 이미지 수의 대조에서 드러났다.** 수집기 원본(PR #12)은 수정하지 않았고, 상위 반영이 필요하므로 §8 에 별도 보고한다.

#### 3.3.1 다른 #19 PR 과의 교차 비교 (D-1/D-2 의 외부 확인)

작업 도중 **PR #24**(`feature/issue-19-full-catalog-db`) · **PR #26**(`feature/issue-19-full-catalog`) 이 동일 #19 범위에서 병렬 진행되어, 그 산출 통계와 내 산출을 **수치로 교차 검증**했다.

| 지표 | 내 측정(PR #27) | PR #24 산출 | 판정 |
|---|---:|---:|---|
| samasound / samamusic / 합계 | 2,281 / 2,294 / **4,575** | 2,281 / 2,294 / **4,575** | **일치** |
| 옵션 보유 상품 | 587 | 587 | **일치** |
| 이미지 보유 상품 | 4,575 | 4,575 | **일치** |
| 공개 판매가 | 2,117 | 2,117 | **일치** |
| inquiry_price | 2,370 (=2,281+89) | 2,370 | **일치** |
| sold_out_sale_completed | 87 | 87 | **일치** |
| **평균 이미지 수** | **3.6장** | **10.9장** | **불일치 → D-1/D-2** |
| **최대 이미지 수** | **21장** | **71장** | **불일치 → D-1/D-2** |
| 비상품 이미지 포함 | **0건** | 다수 | **불일치 → D-1** |

> **핵심**: 4,575건의 **건수와 핵심 필드 개수는 두 작업이 완전히 일치**해 4,575 라는 수치가 재현 가능함을 확인해 준다. 그러나 **이미지 필드만 크게 어긋난다.** PR #24 산출은 삼아스토어 358번에 `image_count=14`(실제 상품 이미지 4), 삼아사운드 776번에 `image_count=3`(실제 2, big 누락) 로, **D-1(비상품 이미지 혼입) + D-2(대표 이미지 누락)** 이 그대로 재현된다.
> 즉 **PR #24/#26 의 이미지 필드는 보정 없이 사용하면 안 된다.** §3.3 의 오버라이드(또는 PR #12 수집기 상위 수정)를 적용해야 한다.

| # | 항목 | 내용 |
|---|---|---|
| 경로 충돌 | PR #24 와 **동일 경로 0건**. PR #26 과는 `tools/catalog_collection/README.md` 1건만 동일 → **본 PR 에서 도구 디렉터리를 `tools/catalog_collection/` 로 변경**해 **동일 경로 0건**으로 해소 |
| 본 PR 의 고유 기여 | ① 브라우저 2층 교차검증(48건 100%) ② 이미지 정책 오버라이드(D-1/D-2) ③ Tri-B 공개검색 4중 교차(3,694/1,400) ④ **이카운트 실계정 근거(품목 964/거래처 1,505)** ⑤ Tri-B 4단계 카테고리 트리(893) ⑥ 40컬럼 마스터 + #11 빌더 직접 연결 |



### 3.4 기록한 주의점 (오류 아님)

| 항목 | 내용 |
|---|---|
| 품절 배지 | 삼아스토어 스킨이 일부 상품의 품절 아이콘을 `style="display:none"` 으로 숨긴다(상품 292번 실측). 그래서 **화면 배지(약한 신호)** 와 **스토어 자체 신호(`is_soldout_icon` / "판매 완료" 텍스트, 강한 신호)** 가 어긋난다. 마스터는 강한 신호를 따르고, 어긋남은 `l1_notes` 에 남겼다. **메인/추가상품 품절을 분리 플래그로 기록**(`main_soldout_icon`, `addon_soldout:<id>`) |
| canonical 인코딩 | DOM `link.href` 는 퍼센트 인코딩, 원본 HTML 은 원문 UTF-8. 비교 시 디코드 정규화. 동일 URL |
| 옵션 개수 정의 | 브라우저가 세는 것은 **옵션 값 수**, 마스터 `option_count` 는 **옵션 그룹 수**다. 검증은 그룹 수 기준으로 정렬했다 |
| Tri-A 모델 | Tri-A 는 모델명 필드가 **애초에 없어** 확보율 0%. 상품명 규칙 추출은 별도 파이프라인이며, 미확정분은 빈 값 유지(추정 금지) |

---

## 4. 20,000개 상품 규모 조사

### 4.1 실측값 (모두 이번에 직접 측정한 값)

| # | 측정 대상 | 값 | 측정 방법 |
|---|---|---:|---|
| 1 | Tri-A 공개 진열 상품 | **2,281** | 카테고리 목록 크롤 union |
| 2 | Tri-B 공개 진열 상품 | **2,294** | 카테고리 목록 크롤 union |
| 3 | **공개 진열 합계** | **4,575** | 1+2 |
| 4 | Tri-A 카페24 자체 등록 카운터 | 2,229 | 목록 HTML `등록 제품` |
| 5 | Tri-B 공개검색(판매중) | 1,969 | Dalue `display=1,selling=1` |
| 6 | Tri-B 공개검색(필터 해제 = 스토어 전체 인덱스) | **3,694** | Dalue `equalFields` 제거 |
| 7 | Tri-B 목록 미노출(=비노출) | **1,400** | 6 − 2 |
| 8 | 고유 SKU(item_code) Tri-A / Tri-B / 합집합 | 2,281 / 1,953 / 3,401 | 상세 `source_item_code` |
| 9 | **이카운트 ERP 품목 마스터** | **964** | 품목등록 38페이지(26행/페이지, 마지막 2행) |
| 10 | **이카운트 ERP 거래처** | **1,505** | 거래처리스트 58페이지(마지막 23행) |
| 11 | Tri-B 옵션 조합 수(가설 SKU) | 59,305 | 옵션 그룹 곱, p95=24, max=2,400 — **조합 상한이며 실 SKU 아님** |

### 4.2 Tri-B 공개 검색 4중 교차 검증 (이번 신규 확인)

| 집합 | 정의 | 개수 | 카테고리 목록과의 관계 |
|---|---|---:|---|
| A | Dalue `display=1 & selling=1` (판매중·검색노출) | 1,969 | A∩C = 1,968 (A 중 1건만 목록 미노출) |
| U | Dalue 필터 해제 (스토어 전체 인덱스) | **3,694** | U∩C = 2,294, **C−U = 0** → 목록 크롤 결과는 전부 스토어 인덱스 안 |
| C | 카테고리 목록 크롤 union | 2,294 | U−C = **1,400** (목록에 없지만 스토어엔 있음) |

**U 의 display/selling 분포**

| display | selling | 개수 | 해석 |
|---|---|---:|---|
| 1 | 1 | 1,969 | **판매중·검색 노출** (CGI가 지금 올릴 수 있는 대상) |
| 1 | 0 | 326 | **노출되지만 미판매** → 판매중지/품절/미판매 후보 |
| 0 | 1 | 52 | 숨김인데 판매중 |
| 0 | 0 | 1,347 | **숨김 + 미판매** (완전 비노출) |

**U 의 soldOut 분포**: `soldOut=1` 2,035건 / `soldOut=0` 1,659건 → 스토어 자체가 **반 이상을 품절**로 표시하고 있다.

> 즉 Tri-B 는 **"공개 진열 2,294" 와 "스토어 내부 인덱스 3,694" 사이에 1,400건의 비노출/판매중지 상품**이 존재한다. 326건(display=1, selling=0)은 **"진열되어 있으나 판매중지"** 로, CGI의 단종/판매중지 판단 근거가 된다(§5.5).

### 4.3 "약 20,000개" 주장 판정

> ### 판정: **UNVERIFIED (미확인)** — 확인 가능한 수량과 미확정 수량을 분리한다.

**어떤 실측 조합도 20,000 에 도달하지 않는다.**

| 후보 해석 | 수치 | 20,000 대비 |
|---|---:|---|
| 공개 진열 상품 합계 | 4,575 | 23% |
| 스토어 전체 인덱스 합계 (Tri-A 2,281 + Tri-B 3,694) | 5,975 | 30% |
| SKU(item_code) 합집합 | 3,401 | 17% |
| 이카운트 ERP 품목 마스터 | 964 | 5% |
| Tri-B 옵션 조합 상한(가설) | 59,305 | 296% (과대) |

**해석 가능성 3가지 (모두 근거 미달)**

1. **상품(SKU) 기준의 서로 다른 집계 기준 혼용** — 카페24 `product_no`(상품) 2,294 vs `item_code`(옵션 SKU) 1,953, 옵션 조합(가설) 59,305 사이의 기준 차이로 20,000 이 나왔을 가능성. **현재 공개 데이터로는 확정 불가.**
2. **공급처 2곳 외의 카탈로그** — 현재 확인된 공급처는 삼아사운드·삼아스토어 2곳뿐이며, **다른 공급처 공개 사이트는 확인되지 않았다.** 세 번째 공급처가 존재한다면 20,000 을 설명할 수 있으나 **근거가 없다.**
3. **과거 시점·다른 채널 기준** — 대표 진술 시점의 카탈로그 규모, 또는 B2B 견적용 묶음/패키지 기준 집계.

**확인 필요 (대표)**

- 20,000 은 **상품 ID 기준인가, 옵션 SKU 기준인가, 또는 규격 묶음 기준인가**
- **삼아사운드·삼아스토어 외에 세 번째 공급처가 있는가**
- 20,000 을 산출한 시점·근거 자료

**본 작업의 결론**: **확인되지 않은 상품을 만들어 20,000 을 맞추지 않는다.** 현재 확보된 **4,575건**(공개 진열) + **Tri-B 비노출 1,400건**(판매중지/숨김, 별도 시트) + **Tri-B 스토어 인덱스 3,694건**을 분리해 제공하며, 20,000 은 **미확인**으로 남긴다.

---

## 5. 산출물

### 5.1 로컬 보존 (GitHub 미제출 — 대용량·원본)

| 파일 | 크기 | 내용 |
|---|---:|---|
| `.work/full_catalog/product_master_full.csv` | 11.7MB | **40컬럼 상품 마스터 4,575행** (PR #12 스키마 1:1) |
| `.work/full_catalog/product_master_full.json` | ~30MB | 동일 데이터 JSON 배열 |
| `.work/full_catalog/product_master_full.xlsx` | 2.5MB | #19 요구 XLSX 7시트 |
| `.work/full_catalog/triB_dalue_full.json` | ~9MB | Tri-B 스토어 전체 인덱스 3,694건 (비노출 포함) |
| `.work/full_catalog/triB_nonlisted_products.csv` | 0.4MB | Tri-B 목록 미노출 1,400건 (판매중지/숨김) |
| `.cache/cgi-catalog/` | 651MB+ | HTTP 캐시 (재실행 시 네트워크 0) |

### 5.2 GitHub 제출 (공개·비식별)

| 파일 | 내용 |
|---|---|
| `tools/catalog_collection/collect_full_catalog.py` | 전체 수집 오케스트레이터 (PR #12 수집기 재사용) |
| `tools/catalog_collection/verify_browser.py` | Playwright 2층 교차검증기 |
| `tools/catalog_collection/dalue_export_full.py` | Tri-B 공개검색 API 전체 덤프 |
| `tools/catalog_collection/build_xlsx_db.py` | #19 XLSX 7시트 빌더 |
| `tools/catalog_collection/README.md` | 절차·환경·재현 명령 |
| `reports/full-catalog-collection-report.md` | 본 보고서 |
| `reports/customer-summary-full-catalog.md` | 고객용 요약 |
| `docs/CGI_ISSUE19_HANDOFF.md` | #19 담당자 인계 |
| `reports/samples/product_master_full_sample.csv` | 30행 샘플 마스터 (40컬럼 중 핵심 17) |
| `reports/samples/full-catalog-quality.csv` | 필드별 확보율·공개가 상태 (집계만) |
| `reports/samples/full-catalog-scale.json` | 규모 분해 수치 (JSON) |
| `reports/samples/full-catalog-duplicate-candidates.csv` | 중복 후보 544건 (자동 병합 없음) |
| `reports/samples/category_catalog_full.csv` | 카테고리 카탈로그 893행 |
| `reports/samples/browser-verification-48.csv` | 브라우저 검증 48행 |

### 5.3 XLSX 시트 구성 (#19 요구 반영)

| 시트 | 행수 | 내용 |
|---|---:|---|
| `통합상품` | 4,575 | 핵심 21필드 + 확장 9필드(원본 JSON) |
| `공급처원본` | 4,575 | 공급처별 원천 레코드(원문·원본 URL·수집시각·검증상태) |
| `브랜드·카테고리` | 브랜드별 집계 | 브랜드별 상품수·공개가수·옵션보유·평균공개가·출현카테고리수 |
| `카테고리목록` | 893 | 카테고리 ID·명·경로·등록수·수집수·목록URL |
| `중복후보` | 544 | 동일공급처 동일명 8 + 사이트간 모델토큰 536, **자동병합 없음** |
| `누락·검증현황` | 집계+필드 | 필드별 확보율, 공개가 상태 분포, 미확정 항목(공급가/재고/승인 NULL 사유) |
| `향후네이버·이카운트` | 4,575 | 이카운트 필드 슬롯 매핑 + 네이버 카테고리/상품ID 슬롯 + 매핑준비도 |

### 5.4 중복(duplicate) 처리 — 자동 병합 0건

| 유형 | 건수 | 근거 |
|---|---:|---|
| 동일 공급처 · 정규화 상품명 완전일치 | 8 | Tri-A `SQ5+`,`SQ6+`,`SQ7+`,`SLXD1~4D+`,`J44D IMP NUDE` 등 (색상/구성 변형을 별도 product_no 로 등록) |
| 사이트 간 · 공유 모델토큰 | 536 | Tri-A 2,281 vs Tri-B 2,294 의 모델코드 토큰 교차 |

> **자동 병합을 하지 않았다.** 이슈 #8 의 "낮은 신뢰도 중복 자동 병합 금지" 를 그대로 적용했고, 근거 컬럼을 붙여 후보로만 제출한다. 8건의 동일 공급처 동일명은 실제로 **변형 SKU** 인 경우가 많아 병합 시 재고가 사라질 위험이 있다.

### 5.5 판매중지 · 비노출 상품 (별도 관리)

| 집합 | 건수 | 관리 방법 |
|---|---:|---|
| Tri-B `display=1, selling=0` (진열됨·미판매) | **326** | `triB_nonlisted_products.csv` + XLSX `누락·검증현황` |
| Tri-B `soldOut=1` (스토어 품절 플래그) | **2,035** | 동일 파일 |
| Tri-B `display=0` (완전 비노출) | 1,399 | 동일 파일 (고객 판매 대상 아님) |
| Tri-A 품절 표기 | 24 | 마스터 `soldout_display` / `main_soldout_icon` |

---

## 6. #11 HTML 쇼핑몰 연결 방법

`tools/build_catalog_data.py` (main, PR #17) 는 **40컬럼 마스터 CSV 를 그대로** 읽는다. 별도 변환 코드 불필요.

```bash
# 1) 전체 마스터를 HTML 사이트 데이터 경로에 연결 (기존 빌더 재사용)
python tools/build_catalog_data.py \
  --master-csv .work/full_catalog/product_master_full.csv \
  --categories   .work/full_catalog/category_catalog_full.csv \
  --sample-json  .work/full_catalog/product_master_full.json \
  --out-dir      site/data
# → site/data/products.json (39건 → 4,575건), products.js 재생성
```

- 빌더는 `source_site / canonical_url / source_category_id / source_brand / product_name /
  published_price / published_price_text / availability_unverified / image_urls / option_summary /
  specs / source_evidence / extraction_method / verification_status / updated_at` 를 읽는다.
  **40컬럼 마스터는 이 중 전부를 채운다.**
- `id` 규칙은 `"{site}:{source_product_id}"` → **`samasound.co.kr:3887` / `samamusic.co.kr:2454`** 로 기존 39건과 동일 규칙이므로 **기존 URL·앵커·검색 인덱스가 그대로 동작**한다.
- `price.state` 는 `numeric_price → public`, `inquiry_price → inquiry` 로 정규화된다. **Tri-A 2,281건은 전부 `inquiry` 로 표시**되어 "가격 문의" 가的事实대로 노출된다(추정 금지).
- **주의**: `site/data/products.json` 은 main 의 파일이라 본 PR 에서 직접 수정하지 않았다(PR #15 와의 충돌 회피). 위 명령 실행으로 **4,575건**이 되며, 커밋은 #11 담당자와 조율한다.

**수치 일치 검증 방법**

```bash
python - <<'PY'
import json
m = list(csv.DictReader(open('.work/full_catalog/product_master_full.csv', encoding='utf-8-sig')))
p = json.load(open('site/data/products.json', encoding='utf-8'))
print('마스터', len({(r['source_site'], r['source_product_id']) for r in m}),
      'HTML', len({x['id'] for x in p}),
      '일치', len({(r['source_site'], r['source_product_id']) for r in m}) == len({x['id'] for x in p}))
PY
```

---

## 7. 재사용 가능한 수집 스킬

### 7.1 제공 형태

```
tools/catalog_collection/
├── README.md                      # 절차·환경·재현 명령·주의사항
├── collect_full_catalog.py        # 전체 수집 오케스트레이터
├── verify_browser.py              # Playwright 2층 교차검증
├── dalue_export_full.py           # 공개검색 API 전체 덤프
└── build_xlsx_db.py               # #19 XLSX 빌더
```

### 7.2 핵심 재현 명령

```bash
# 0) 준비
git clone https://github.com/skerishKang/kbs261022.git && cd kbs261022
git checkout feature/issue-19-full-product-details
pip install requests openpyxl playwright && python -m playwright install chromium
# PR #12 수집기가 main 에 없으면 자동 fetch 된다(수정 없음)

# 1) Tri-A / Tri-B 카테고리 + 상세 전체 수집
python tools/catalog_collection/collect_full_catalog.py --stage categories --site samasound
python tools/catalog_collection/collect_full_catalog.py --stage categories --site samamusic
python tools/catalog_collection/collect_full_catalog.py --stage details --site samasound --workers 4
python tools/catalog_collection/collect_full_catalog.py --stage details --site samamusic --workers 4
python tools/catalog_collection/collect_full_catalog.py --stage merge

# 2) Tri-B 스토어 전체 인덱스(비노출 포함) — 공개검색 API
export DALUE_API_KEY=<스토어 공개 검색키>
python tools/catalog_collection/dalue_export_full.py --out .work/full_catalog/triB_dalue_full.json

# 3) 브라우저 교차검증
python tools/catalog_collection/verify_browser.py \
  --master .work/full_catalog/product_master_full.csv \
  --sample .work/full_catalog/verify_sample.csv \
  --out .work/full_catalog/browser_verification.csv

# 4) XLSX
python tools/catalog_collection/build_xlsx_db.py \
  --master .work/full_catalog/product_master_full.csv \
  --cats   .work/full_catalog/category_catalog_full.csv \
  --quality .work/full_catalog/product_master_full_quality.csv \
  --out    .work/full_catalog/product_master_full.xlsx
```

### 7.3 주의사항

- Dalue API 키는 **스토어 공개 페이지에 이미 노출된 검색 키**이며 개인 자격증명이 아니다. 코드에 하드코딩하지 않고 `--api-key`/환경변수로만 받는다.
- 전체 수집은 **공급처 2곳, 전체 상품 기준**이다. 무제한 요청이 아니라 카테고리×상품 유한 순회이며 지연 0.05~0.35초를 유지한다.
- `--stage merge` 가 만든 `.work/full_catalog/product_master_full.csv` 가 정본이다. GitHub 에는 30행 샘플만 제출한다.

---

## 8. 다른 에이전트에게 넘길 항목

| # | 대상 | 내용 |
|---|---|---|
| 1 | **PR #12 (수집기 유지보수)** | `extract_images()` 결함 2건(§3.3 D-1/D-2) → `/web/product/` 경로만 수집하도록 정규식 정정 권장. 본 PR 은 원본을 **수정하지 않고** 수집 단계 오버라이드로 우회했다 |
| 2 | **PR #16 (상품 마스터)** | 34컬럼 스키마(`name`/`public_price`/`availability`)와 PR #12 의 40컬럼(`product_name`/`published_price`/`availability_unverified`)이 **컬럼명이 다르다**. 통합 시 어댑터 필요. `availability` 은 PR #16 이 schema-lock(null)이고 PR #12 는 실제 재고 JSON 을 담는다 — **어느 쪽을 정본으로 할지 합의 필요** |
| 3 | **PR #16** | 중복 후보 산출을 PR #16 의 `dedupe` 모듈로 이관 가능(본 PR 은 근거 컬럼만 제공) |
| 4 | **#11 / PR #15 (HTML 사이트)** | `site/data/products.json` 39건 → 4,575건 재생성 명령은 §6. `site/` 파일은 본 PR 이 건드리지 않았다 |
| 5 | **#19 담당자** | XLSX 7시트 빌더를 제공했으므로 중복 구현하지 말 것. `docs/CGI_ISSUE19_HANDOFF.md` 참조 |
| 6 | **PR #24 / PR #26 (병렬 #19 작업)** | ① **이미지 필드에 D-1/D-2 결함이 동일하게 재현**됨(평균 10.9장 vs 본 PR 3.6장). §3.3 의 오버라이드 적용 필요 ② 본 PR 과 동일 경로 0건(도구 디렉터리 `tools/catalog_collection/` 로 분리). ③ 수치(4,575 / 587 / 2,117 / 2,370 / 87)는 **완전 일치** — 중복 수집이 아니라 **교차 검증**으로 활용 가능 |
| 7 | **대표** | 20,000개 근거(§4.3) · CGI 판매가/공급가 승인 · 네이버 카테고리 매핑 결정 필요 |

---

## 9. 한계 · 미확정

| 항목 | 상태 |
|---|---|
| **CGI 공급가 / 실재고 / CGI 판매가 / 취급 승인** | **공개 근거 없음. 의도적으로 NULL. 추정하지 않음** |
| Tri-A 모델명 | **필드 자체가 없음.** 확보율 0%. 상품명 규칙 추출은 별도 파이프라인(미착수) |
| Tri-B 제조사 | `제조사` 행 없음(브랜드만). 0% |
| Tri-B item_code/product_code 공란 | 341건(14.9%) — 상품코드 미부여 상품 |
| 20,000개 주장 | **UNVERIFIED.** 어떤 실측 조합도 도달하지 않음(§4.3) |
| Tri-B 전체 카테고리 트리 | 스토어 검색 API 의 `categoryNos` 로 **4단계**까지 복원(893카테고리). 5단계 이상은 미확인 |
| Tri-A 카테고리 트리 | 상세 브레드크럼 기준 4단계까지. 5단계 이상은 스킨이 잘라서 미확인 |
| 비노출 1,400건의 상세 필드 | 목록에 없어 상세 미수집(의도). 공개 검색 API 필드만 확보 |
| 실 일괄 등록(ERP 쓰기) | **수행하지 않음**(읽기 전용 원칙) |
| 네이버 카테고리 매핑 | 미착수. `향후네이버·이카운트` 시트에 슬롯만 확보 |
| XLSX 원본 공개 게시 | **하지 않음.** 대표 지침대로 로컬 보존 |

---

## 10. 결론

1. **공급처 2곳의 공개 상품 4,575건 전량에 대해 상세 필드를 확보했다**(수집 실패 0건). 이미지·규격·카테고리·옵션·원본 URL 은 **100% 확보**, 공개 판매가는 Tri-B 2,120건(92.4%), Tri-A 는 0건(전건 "가격 문의" — 공개되지 않으므로 0이 맞다).
2. **브라우저 교차검증 48건 100% 일치**(L1 렌더 대조 48/48, L2 파서 동등성 48/48). 검증 과정에서 **실제 결함 2건**(이미지 비상품 혼입·대표 이미지 누락)을 발견해 **수정**했다.
3. **"약 20,000개"는 확인되지 않았다(UNVERIFIED).** 실측 근거는 4,575(공개 진열) · 5,975(스토어 전체 인덱스) · 3,401(SKU) · 964(ERP 품목)이며, **20,000 을 맞추기 위해 상품을 만들지 않았다.** 추가로 **Tri-B 비노출 1,400건**(판매중지 326건 포함)을 분리 확보했다.
4. **#11 HTML 사이트는 재개발 없이 4,575건으로 확장 가능**하다(기존 `build_catalog_data.py` 에 40컬럼 마스터 CSV 를 그대로 넣으면 된다). **#19 XLSX 도 동일 파이프라인에서 생성**되므로 Excel과 HTML의 원천 상품 수·식별자가 일치한다.
