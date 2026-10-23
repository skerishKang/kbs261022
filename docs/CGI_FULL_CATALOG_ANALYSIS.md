# 전체 상품 조사·수집 분석 보고서 (이슈 #19)

> 담당: CGI-1 LOCAL 에이전트(OpenCode) · 2026-10-22
> 브랜치: `feature/issue-19-full-catalog` · 저장소: `skerishKang/kbs261022`
> 원시 데이터: CGI-1 로컬 `C:\cgi-work\catalog-data` (XLSX 포함) · 재현 스크립트: `tools/full_catalog/`

## 1. 결론 요약

| 항목 | 결과 |
|---|---|
| 삼아사운드(samasound.co.kr) 원천 상품 | **2,281건** (카테고리 361개 크롤, 상세 100% 확보) |
| 삼아스토어(samamusic.co.kr ≡ samastore.co.kr) 원천 상품 | **2,294건** (카테고리 532개 크롤, 상세 100% 확보) |
| 합계 원천 상품 | **4,575건** (상세 4,575건 수집 성공, 요청 오류 0) |
| 통합 상품 후보 키 | 4,499개 (중복 후보 62그룹/138행 — 자동 병합하지 않음) |
| 옵션·구성 SKU | 4,233행 |
| 대표님 "약 20,000개" 주장 | **UNVERIFIED** — 공개 경로로 확인 가능한 범위는 아래 §5 참조 |

## 2. 조사한 공급처 관계 (추가 공급처 여부)

기존 분석(PR #6/#12/#13)의 "Tri-A/Tri-B 2곳" 외에 후보 도메인을 모두 실측했다.

| 도메인 | 실측 결과 | 판정 |
|---|---|---|
| `www.samamusic.co.kr` ↔ `samastore.co.kr` | 동일 카페24 shop(sama2015). 목록 HTML 바이트 동일(517,843B), canonical이 `samastore.co.kr/category/…`, product_no 4167/974가 양쪽 동일 ID로 해석 | **동일 스토어(도메인 2개)** |
| `samassi.cafe24.com` ↔ `www.samasound.co.kr` | 동일 shop. 목록 HTML 바이트 동일(118,607B) | **동일 스토어** |
| `sama2015.cafe24.com` | sitemap 2,136 URL(카테고리 532/상품 1,597) = samastore와 동일 | **동일 스토어** |
| `www.samacds.co.kr` | 임웹(imweb.me) 플랫폼의 별도 도메인. sitemap 123 URL 중 **상품 URL 0**, `product/list.html` 404 | **상품 공급처 아님** (별도 서비스) |
| `fliphtml5.com/bookcase/vndwo/` | "SAMASOUND 카탈로그 모음" — **브랜드 카탈로그 98종, 총 1,720페이지** | 판매 불가 브랜드 카탈로그 |
| `s1forum.kr/shure_selector/` | Shure 자체 브랜드 셀렉터(`selector-data.js` 로드, select 4종) | 판매 불가 브랜드 도구 |
| `s1forum.kr` | 포럼(게시판) | 상품 공급처 아님 |

→ **추가 상품 공급처는 확인되지 않았다.** 공개 상품 catálogo는 삼아사운드·삼아스토어 2곳이 전부이며,
브랜드 카탈로그(fliphtml5 98종)과 브랜드 셀렉터는 "판매가 없는 카탈로그"다.

## 3. 카테고리 탐색 완결성 (Q1)

기존 분석의 발견을 재사용하되 전량 재수집으로 재확인했다.

| 사이트 | 카테고리 발견 방법 | 카테고리 수 | 비고 |
|---|---|---|---|
| 삼아사운드 | sitemap 404 → `cate_no` 1..520 스위프에서 유효 카테고리만 채택 | **361** | 브레드크럼 존재 여부로 판정 |
| 삼아스토어 | `sitemap.xml` 의 `/category/<name>/<id>/` **532** + `cate_no` 1..520 스위프 보강 | **532** | 스위프에서 추가 발견 없음(사이트맵이 완전) |

카테고리 뷰별 실측 상품 수(캐시 재분석):

| 뷰 | 상품 수 | 페이지 |
|---|---|---|
| 삼아사운드 cate 23(전체상품) | 2,229 | 112 |
| 삼아사운드 cate 24(브랜드별) | 2,211 | 111 |
| 삼아사운드 cate 25(제품분류별) | 2,053 | 103 |
| 삼아스토어 cate 42(스피커) | 216 | 11 |
| 삼아스토어 cate 1152(프로모션) | 583 | 30 |
| 삼아스토어 cate 97(특가상품) | 57 | 3 |

## 4. 누락 점검 (Q2·Q3·Q5)

### 4.1 "전체상품" 뷰는 전체가 아니다 — 52건 추가 발견

삼아사운드 cate 23(전체상품) 2,229건 대비 **전체 카테고리 크롤은 2,281건**으로,
**52건은 '전체상품' 뷰에 나타나지 않고 개별 카테고리에서만 발견**된다( cate 23 에만 존재하는 상품은 0건).
→ 카테고리 전체를 크롤해야만 보이며, "등록 제품 N건" 표기만 믿으면 52건을 잃는다.

### 4.2 사이트맵은 불완전 — 697건 누락

삼아스토어 `sitemap.xml` 상품 1,597건 vs 목록 크롤 2,294건 → **697건(30%)이 사이트맵에 없다**.
기존 분석 결론("사이트맵 단독 사용 금지")이 전량 재수집에서도 동일하게 확인됨.

### 4.3 페이지네이션·동적 로딩

- 페이지당 20건, `class="last"` 마커와 실제 수집 페이지 수가 일치(cate 23: 마커 112 / 실제 113 요청, cate 42: 마커 11).
- 목록 항목은 **서버 렌더**이며 AJAX 로 뒤에 붙는 추가 항목은 관측되지 않음.
- 별도 누락 근거 없음(카테고리 크롤 기준).

### 4.4 사이트 자체 검색 인덱스에는 목록에 없는 상품이 있다 — 330건(표본)

삼아사운드의 검색 결과는 **서버 렌더**로 총건수를 노출한다(`총 N 개의 상품이 검색되었습니다`).
브랜드 37개를 대조한 결과:

| 브랜드 | 목록 크롤 | 사이트 검색 | 차이 |
|---|---|---|---|
| Rean | 65 | 204 | **+139** |
| Neutrik | 139 | 239 | **+100** |
| Shure | 474 | 519 | **+45** |
| EV | 35 | 76 | **+41** |
| 자체제작 | 66 | 68 | +2 |
| Waves | 44 | 46 | +2 |
| Genelec | 71 | 72 | +1 |
| (37개 브랜드 합계) | 2,220 | 2,550 | **+330** |

→ **카테고리 목록 크롤만으로는 공개 상품 전체를 담을 수 없다.** 목록에 노출되지 않으나
검색으로는 접근 가능한 상품이 최소 330건(표본 기준) 더 존재한다. 삼아스토어는 검색이
Dalue AJAX 라 총건수 텍스트를 안정적으로 읽지 못해 동일 대조는 1개 브랜드(Positive Grid 21 vs 16)만 가능했다.
※ 이 차이는 별도 수집 경로(공개 검색 페이지 순회) 필요 항목이며, 본 작업의 4,575건은 **목록 크롤 기준 확정치**이다.

### 4.5 판매중지·비노출 상품

| 구분 | 수 | 근거 |
|---|---|---|
| 품절(판매중지) | 1,700 | `use_soldout=T & stock=0` 또는 soldout 아이콘 |
| 판매완료 | 87 | `published_price_state=sold_out_sale_completed` |
| 재고 미관리 | 2,491 | `use_stock=false` (삼아사운드 전량이 이 구간) |
| 판매중 | 26 | `use_stock=true` |

### 4.6 옵션·구성품 SKU

| 구분 | 수 |
|---|---|
| 옵션 값(메인/추가옵션/add_option_data) | 3,953 |
| 추가구성(번들) 상품 | 730 |
| 합계 | **4,233** (587개 상품에 옵션 존재, 삼아사운드는 0) |

## 5. "약 20,000개" 주장 근거 분석 (Q7)

| 구성 요소 | 수치 | 근거 수준 |
|---|---|---|
| 목록 크롤 원천 상품 | 4,575 | **실측** |
| 검색 인덱스 전용 추가(삼아사운드 37브랜드 표본) | +330 (표본) | **실측(표본)** |
| 옵션·구성 SKU | +4,233 | **실측** |
| 공개 확인 가능 합계(표본 기준 외삽) | ≈ 9,100 | 실측 기반 |
| 브랜드 카탈로그(fliphtml5 98종 / 1,720페이지) | 모델 언급 수천~수만 | 페이지·책 수 **실측**, 모델 언급 수 **미계측** |

**판정: UNVERIFIED.**
- 공개 수집 경로(목록 카테고리 전량 + 상세 전량)로 확인되는 원천 상품은 **4,575건**이며,
  옵션까지 전개해도 **약 9,100건 수준**이다. 20,000건에 도달하지 않는다.
- 20,000 규모와 가장 가까운 공개 경로는 **브랜드 카탈로그(fliphtml5 98종, 1,720페이지)** 이다.
  브랜드 카탈로그는 "판매 가능한 상품"이 아니라 **브랜드별 모델 목록 문서**라서,
  이를 상품 수로 세면 규모는 맞출 수 있지만 **CGI가 판매할 수 있는 상품 수가 아니다.**
- 따라서 20,000은 **"판매 가능 상품 수"로 확정할 근거가 없다(미확인)**.
  임의 상품 생성이나 옵션 중복 집계로 수를 맞추지 않았다.

## 6. 브라우저 교차검증 결과

계층화 표본(사이트 × 공개가 상태 × 옵션 유무 7개 층 + 브랜드별 편입) **48건**을 실제 브라우저로 열었다.

| 필드 | 일치 | 불일치 | 판정 불가 |
|---|---|---|---|
| 상품명 | 48 | 0 | 0 |
| 공개 판매가격 | 48 | 0 | 0 |
| 상품 이미지 | 48 | 0 | 0 |
| 옵션·추가금 | 48 | 0 | 0 |

→ **48/48 완전 일치, 브라우저 오류 0건.** HTTP 수집값과 실제 화면 표시값의 불일치율은 0%(표본 기준)이다.
표본 구성(층별 전체): 삼아사운드 inquiry/noopt 2,281 · 삼아스토어 numeric/noopt 1,548 ·
numeric/opt 569 · inquiry/noopt 71 · inquiry/opt 18 · sold_out/noopt 87 · other/noopt 1

## 7. 데이터 품질 요약

| 지표 | 값 |
|---|---|
| 상세 수집 성공 | 4,575 / 4,575 (100%), 요청 오류 0 |
| 이미지 확보 | 4,575 (100%) |
| 공개 판매가 보유 | 2,117 (46.3%) |
| 가격 문의 | 2,370 (51.8%) — 추정 금지 원칙 적용 |
| 판매완료 | 87 |
| 가격 정보 없음 | 1 |
| 중복 후보 | 62그룹 / 138행 (동일 master key, 자동 병합 안 함) — **여기 숫자는 master 키 충돌 집계**다. 엑셀 `중복후보` 시트는 1,333행(confirmed 538·probable 274·candidate 521), `reports/samples/full-catalog-duplicate-candidates.csv` 는 544행(10-22 판정본), 이슈 #43 QA 계층은 1,353쌍을 센다. 세 수치는 계산 대상이 다르며, **어느 쪽도 자동 병합하지 않았다** |
| 공급가·재고·CGI 판매가 | 전부 미확정(공급처 공개 근거 없음) |

## 8. 사용 방법(재현)

```bash
# 1) 수집 (공개 GET 만, robots Disallow 경로 미방문, 동시 6, 지연 0.2s, URL 캐시)
python tools/full_catalog/run_full_collection.py --stage all \
  --cache C:/cgi-cache --out C:/cgi-work/catalog-data

# 2-A) 당시 실행: 7시트 엑셀 + 로컬 JSON (산출 위치 C:\cgi-work\catalog-data\db)
python tools/full_catalog/build_product_db.py \
  --data-dir C:/cgi-work/catalog-data --out-dir data/full_catalog \
  --xlsx C:/cgi-work/catalog-data/product_db.xlsx

# 2-B) 정본 재현: main 에 커밋된 8시트 product_db.xlsx 를 만드는 빌더
python tools/full_catalog/build_full_catalog.py \
  --data-dir C:/cgi-work/catalog-data --out-dir data/full_catalog

# 3) 브라우저 교차검증 (출력 경로는 실행 당시 C:\cgi-work…, 저장소 공개본은 reports/samples/)
node tools/full_catalog/browser_verify.mjs C:/cgi-work/catalog-data/all_detail.json reports/samples 48

# 4) 검색 총건수 대조(카테고리 누락 점검)
node tools/full_catalog/search_completeness.mjs C:/cgi-work/catalog-data/list_products.json reports/samples 999 C:/cgi-work/catalog-data/all_detail.json
```

산출물 (2026-10-23 실측 기준으로 정정):

| 파일 | 위치 | 내용 |
|---|---|---|
| `product_db.xlsx` **정본** | `data/full_catalog/` (커밋됨) | **8시트** / 3,176,083B / sha256 `ee61ac545e51b043…` — 통합상품 4,575×34 · 공급처원본 4,575×20 · 브랜드_카테고리 374 · 중복후보 1,333 · 누락_검증현황 4,575 · 네이버스토어준비 4,575 · 이카운트품목매핑 4,575 · 옵션SKU 3,541. 빌더 `tools/full_catalog/build_full_catalog.py` |
| `product_db.xlsx` (당시 로컬분) | 로컬 `C:\cgi-work\catalog-data\` | **7시트** / 3,232,987B / sha256 `2d7cc08771c54e74…`. 위 정본과 다른 실행분이며 저장소에 없다. 식별 정보는 `data/full_catalog/local_artifacts_manifest.json` 에 실측으로 갱신 |
| `catalog.full.json` | 로컬 `C:\cgi-work\catalog-data\db\` | 쇼핑몰(#11) 데이터 계약 v1.0 전체 카탈로그(20,166,800B). 대용량이라 미커밋 |
| `product_db_compact.csv` | `data/full_catalog/` | 핵심 21필드 경량판(2,154,083B, 4,575행) — GitHub 공개용 |
| `options_compact.csv` | `data/full_catalog/` | 옵션 1행 1옵션(696,491B, 4,233행). 엑셀 `옵션SKU` 시트는 3,541행으로 **집계 기준이 다르다** |
| `collection_stats.json` | `data/full_catalog/` | 집계 통계 |
