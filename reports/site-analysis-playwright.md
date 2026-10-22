# 삼아스토어 Playwright 브라우저 분석 (이슈 #5)

- **이슈**: #5 `[P0][RESEARCH] 삼아사운드 상품 사이트 2모델 독립 분석 및 수집 설계`
- **담당**: CGI-2 모델 (Playwright 브라우저 분석)
- **작성일**: 2026-10-22
- **브라우저**: Playwright 1.64.1 / Chrome for Testing 156.0.8078.4 (Chromium 1248)
- **산출물**: 본 문서, `reports/data/samastore-playwright-sample.csv` (20건), `reports/data/api-browser-parity.csv` (40건), `tools/playwright/` (재실행 스크립트), `reports/screenshots/` (검증 스크린샷 51장), `reports/evidence/` (원자료 JSON/JSONL)

> **모든 수치는 실측값이다.** 추정해야 하는 항목은 "미확정"으로 명시했다.
> 가격·재고·취급 권한이 확인되지 않은 항목은 추정하지 않았다.

---

# PART 1. 고객용 작업 요약

## 1. 한 줄 요약

**`samamusic.co.kr` 과 `samastore.co.kr` 는 같은 쇼핑몰의 같은 상품Catalogue 를 보여주는 두 개의 도메인이고, 브라우저로 실제 화면을 조작해 확인한 결과 상품 1,969건 중 372건이 사이트맵에 빠져 있으며, 옵션 가격·품절·가격문의 같은 "화면에만 있는 정보"를 HTTP 수집만으로는 안정적으로 얻을 수 없음을 확인했다.**

## 2. 확인된 사실 (고객이 궁금해할 부분)

| 질문 | 답변 | 근거 |
|---|---|---|
| 삼아스토어와 삼아사운드는 같은 쇼핑몰인가? | **아니다.** 삼아스토어(`samamusic.co.kr`/`samastore.co.kr`)는 공개 판매가격이 있는 B2C, 삼아사운드(`samasound.co.kr`)는 전 품목 `가격 문의` 인 B2B. | `mallId` 실측 `sama2015` vs `samassi`. 페이지 제목·canonical·카테고리 구조 전부 다름. **브라우저로 직접 재확인**(`crosscheck-samasound.js`). |
| 삼아스토어의 두 도메인은 같은 상품인가? | **예, 완전히 동일하다.** (측정 5/5건) | canonical URL, 판매가, 브랜드, 모델명, JSON-LD SKU, 이미지 파일 경로(MD5)까지 전부 동일. 이미지만 호스트 접두어만 바뀜. |
| 실제로 몇 건의 상품이 있는가? | **1,969건** (공개 JSON 카탈로그 실측) | 11개 상단 카테고리 전체를 브라우저로 순회 + 공개 API `totalCount`. |
| 왜 다른 모델은 1,597건이라고 했나? | **사이트맵이 372건을 누락하고 있다.** | sitemap.xml 상품 URL 1,597건 ⊂ API 1,969건. 누락분 372건은 **브라우저로 8건 직접 열어 전부 정상 노출 확인.** |
| 옵션(선택 항목) 가격을 정확히 알 수 있나? | **가능. 단 화면에 보이는 가격만으로는 안 된다.** | 옵션 선택 시 화면 가격은 안 바뀌고, 숨김 주문가 input 에 실제 가격이 들어 있음. +3,000원 ~ +900,000원 추가금 실측. |
| 품절 상품은 어떻게 표시되나? | **3중 표시.** `품절` 배지 / 구매영역 `SOLD OUT` / JSON-LD `OutOfStock`. | API `soldOut=1` 12건 전부 브라우저 배지와 일치(12/12), 오탐 0건. |
| 가격을 못 공개하는 상품이 있나? | **있어. 5가지 표기 / 2가지 유형** — `가격 문의`·`전화 문의`·`전화문의`(가격문의) 와 `판매완료`·`판매 완료`(판매완료) | 전체 1,969건 중 62건(3.1%)이 문의/완료 계열. 이 상품은 숫자를 임의로 채우면 안 됨. |
| 이미지는 그대로 받아 쓸 수 있나? | **예. 49/49개 HTTP 200 응답.** | 표본 20건에서 추출한 이미지 URL 74건 중 HTTP HEAD 검증 49건 전부 200. |
| 로그인·구매가 필요한가? | **아니오. 전 항목 로그인 없이 수집 가능.** | 로그인·쿠키 주입 0건, 구매·주문·결제 클릭 0건(코드에서 강제 검증). |

## 3. Playwright 가 추가로 얻어 준 것 (HTTP 수집 대비)

| 추가 확보 항목 | 설명 |
|---|---|
| **옵션별 실제가격** | 숨김 주문가 input(`input.option_box_price`)을 옵션마다 바꿔가며 실측. HTTP로는 "선택" 동작이 불가능. |
| **옵션별 품절** | 옵션 텍스트의 `[품절]` 마커 + 옵션 선택 거부 여부로 판정. |
| **화면 vs DOM 불일치** | 목록 카드가 `{$productName}` 같은 템플릿 잔재를 그대로 화면에 보여주는 결함을 브라우저로 확인. |
| **검색 결과 페이지의 구조 결함** | 검색 결과 카드의 `id`·`data-price` 속성이 **전부 같은 잘못된 값**(`anchorBoxId_4558`, `^1,050,000`)이고, 실제 값은 JS가 채우는 `#dprice_<productNo>` 에만 존재. HTTP로만 보면 전 상품 가격이 105만원으로 오인된다. |
| **두 도메인의 상품 동일성 증명** | 이미지 경로 MD5까지 비교하여 동일 쇼핑몰임을 확정. |

## 4. 네이버 스마트스토어 등록 준비 관점 (요약)

- **공개 판매가**와 **CGI 공급가**는 반드시 분리해야 한다. 수집 산출물에는 `published_price` (공개가) 와 `cgi_supply_price` (공급가, **항상 공란 + `unverified_no_authority`**) 를 분리해 두었다. **공급가는 추정하지 않았다.**
- 가격을 공개하지 않는 유형(가격 문의/전화 문의/판매완료 등 5가지 표기)은 등록 시 "가격 문의" 로 처리해야 하며, 숫자 추정 금지.
- 옵션이 있는 상품은 옵션 그룹·옵션명·옵션 추가금·옵션별 품절을 그대로 옮겨야 한다.
- 대표이미지는 URL 이 아니라 **실제 파일**을 받아야 한다 (원본 해상도 경로 `/web/product/big/...`).

> 상세 근거·재현 절차·실패 기록은 아래 PART 2 를 참고.

---

# PART 2. AI 검토용 상세 기록

## 0. 조사 대상과 실행 환경

| 항목 | 값 |
|---|---|
| 브라우저 | Playwright 1.64.1, Chromium rev 1248 (Chrome for Testing 156.0.8078.4) |
| 뷰포트 / 로케일 / 타임존 | 1440×1000 / ko-KR / Asia-Seoul |
| 실행 모드 | headless (`SAMASTORE_HEADLESS=1`) — 재현성 확보. headed 로도 동일 코드 경로 사용 가능 |
| 작업 폴더 | `tools/playwright/` |
| 총 HTTP 요청 수 | 브라우저 세션 기준 수백 회(카테고리 11 + 상세 20 + 옵션 4×N + 패리티 40 + 최종검증 15) |
| 요청 간격 | 0.4 ~ 0.8초, 병렬화 없음 |
| 로그인·쿠키 주입 | **0건** |
| 구매·주문·결제 클릭 | **0건** (`assertNoPurchaseClicked()` 가 종료 시 강제 검증) |

---

## 1. 도메인 검증 (Task 1)

### 1.1 5개 URL 실측 결과

`reports/evidence/domains.json` · 스크린샷 `reports/screenshots/domain-*.jpg`

| key | 요청 URL | HTTP | 최종 URL | mallId | canonical | title | LNB 링크 | 첫 상품 | HTML bytes |
|---|---|---|---|---|---|---|---|---|---|
| samamusic_www | `https://www.samamusic.co.kr/` | 200 | 동일 | `sama2015` | `https://samastore.co.kr/` | 삼아스토어 | 11 | 3712 | 1,611,898 |
| samamusic_apex | `https://samamusic.co.kr/` | 200 | 동일 | `sama2015` | `https://samastore.co.kr/` | 삼아스토어 | 11 | 3712 | 1,610,651 |
| samastore_apex | `https://samastore.co.kr/` | 200 | 동일 | `sama2015` | `https://samastore.co.kr/` | 삼아스토어 | 11 | 3712 | 1,612,027 |
| samastore_www | `https://www.samastore.co.kr/` | 200 | 동일 | `sama2015` | `https://samastore.co.kr/` | 삼아스토어 | 11 | 3712 | 1,610,665 |
| **samasound_www** | `https://www.samasound.co.kr/` | 200 | 동일 | `samassi` | `https://samasound.co.kr/` | **삼아사운드** | **0** | 3826 | 1,002,559 |

**해석**

- 4개 삼아스토어 도메인은 **리디렉션이 없다**(요청 URL 유지). 302 로(apex) www 로 강제 이동시키지 않는다.
- 4개 도메인 모두 `canonical = https://samastore.co.kr/` 이다. → **`samastore.co.kr` 가 정규 도메인(canonical)** 이며 나머지는 별칭.
- `mallId` 가 4개 모두 `sama2015` 로 동일. → **동일 카페24 몰(mall)** 이라는 결정적 증거.
- 첫 상품 id(3712), LNB 링크 수(11), 페이지 제목이 4개 도메인 전부 동일.
- HTML sha256 은 4개가 서로 다르다(홈 배너 랜덤 노출 등). → 해시 비교는 부적절, **구조 비교**가 맞다.

### 1.2 두 도메인의 상품 동일성 (브라우저 5건 실측)

`reports/evidence/final-verification.json` → `domain_checks`

| product_no | canonical 동일 | 판매가 동일 | 이미지 동일 | SKU 동일 | 판정 |
|---|---|---|---|---|---|
| 4167 (PreSonus Eris 3.5) | ✅ | ✅ 219,000원 | ✅ | ✅ `cafe24_sama2015_1_4167` | **동일** |
| 4558 (Q Acoustics Q M20) | ✅ | ✅ 1,290,000원 | ✅ | ✅ `cafe24_sama2015_1_4558` | **동일** |
| 5685 (KLOTZ D-Sub) | ✅ | ✅ 440,000원 | ✅ | ✅ `cafe24_sama2015_1_5685` | **동일** |
| 3184 (Michael Tuttle S799) | ✅ | ✅ 판매완료 | ✅ | ✅ `cafe24_sama2015_1_3184` | **동일** |
| 1710 (APOGEE Symphony) | ✅ | ✅ 2,490,000원 | ✅ | ✅ `cafe24_sama2015_1_1710` | **동일** |

**이미지 비교 방식(중요)**: 이미지 DOM **순서**는 두 호스트에서 달라진다(지연 로드 + 크로스셀 블록 순서). 그래서 **집합**으로 비교하되, 호스트 접두어만 정규화했다.

```
//www.samamusic.co.kr/web/product/extra/small/202303/04904dc8….jpg   (samamusic)
//samastore.co.kr/web/product/extra/small/202303/04904dc8….jpg        (samastore)
→ 파일 경로와 MD5 는 완전히 동일, 호스트만 다름
```

→ **결론: 두 URL 은 동일 상품으로 연결된다. 중복 수집·중복 등록 위험 없음.**

### 1.3 삼아사운드와의 관계 (브라우저로 직접 대조)

`reports/evidence/crosscheck-samasound.json` · 스크린샷 `crosscheck-samasound-*.jpg`

다른 모델의 보고를 신뢰하지 않고 **직접 브라우저로 재확인**했다.

| 확인 항목 | samasound.co.kr 실측 | samastore.co.kr 실측 |
|---|---|---|
| `mallId` | `samassi` | `sama2015` |
| LNB 상단 카테고리 | **0개** (classic skin) | 11개 |
| 목록 페이지 `NNN원` 문자열 | **0건** (카드 20개 전건) | 카드마다 가격 표시 |
| 상세 `판매가` | `가격 문의` (3826, 3887) | 숫자 가격 |
| 상세 페이지 전체 `NNN원` | **0건** | 다수 |
| JSON-LD `offers.price` | `"가격 문의"` (문자열) | 숫자 |
| 기본정보 표 `모델명` row | **없음** (`제조사`만 존재) | 있음 |
| 기본정보 표 `제조사` row | 있음 (HK Audio, ARTURIA) | 없음 (`브랜드`만) |

→ **삼아사운드는 가격 공개 B2B, 삼아스토어는 가격 공개 B2C 로 성격이 다르며 카탈로그도 별개다.**
→ **혼합 금지 판단**: 삼아사운드는 가격 소스로 쓸 수 없고, **라인업·제조사·원산지 대조용**으로만 활용한다.

---

## 2. Playwright 실행 (Task 2)

### 2.1 카테고리 메뉴 확인

`reports/evidence/category-menu.json`

`#category-lnb` 에서 **11개** 상단 메뉴를 추출했고, 실제 클릭으로 내비게이션을 확인했다.

| # | 메뉴 | href | 목록 카드 수 | SSR 결함 카드 |
|---|---|---|---|---|
| 1 | 프로모션 보기 | `/product/list.html?cate_no=1152` | 21 | 4558 |
| 2 | 브랜드 | `?cate_no=24` | **1** | 4558 |
| 3 | 마이크 | `?cate_no=84` | 21 | 4558 |
| 4 | 스피커 | `?cate_no=42` | 21 | 4558 |
| 5 | 이어폰/헤드폰 | `?cate_no=25` | 21 | 4558 |
| 6 | 레코딩/음향 | `?cate_no=28` | 21 | 4558 |
| 7 | 악기/앰프 | `?cate_no=379` | 21 | 4558 |
| 8 | Hi-Fi | `?cate_no=1038` | 21 | 4558 |
| 9 | 케이블/커넥터 | `?cate_no=366` | 21 | 4558 |
| 10 | 소프트웨어 | `?cate_no=758` | 21 | 4558 |
| 11 | 특가상품 | `?cate_no=97` | 21 | 4558 |

- 클릭 검증: `마이크` 클릭 → `https://www.samamusic.co.kr/product/list.html?cate_no=84` 로 실제 이동. 스크린샷 `category-after-click.jpg`.
- **`브랜드`(cate 24) 카테고리는 카드 1건뿐**인데 그 카드가 4558 하나 → 카테고리 페이지 자체가 템플릿 결함을 공유한다.
- 하위 카테고리는 화면에 노출되지 않는다. `categoryNos` 는 API 로만 복원 가능.

### 2.2 상품 검색 실행

`reports/evidence/search-verification.json` · 스크린샷 `search-shure.jpg`

상점 검색창에 keyword 를 입력하고 Enter 를 눌러 실제 검색을 수행했다.

| keyword | 최종 URL | DOM 카드 | **보이는 카드** | 페이지네이션 | "검색결과 없음" 메시지 |
|---|---|---|---|---|---|
| `shure` | `shopSearch/search.html?query=shure&begin=1&size=40&…` | 42 | **40** | `1 2 3` | **보이지 않음** |
| `genelec` | `…query=genelec…` | 42 | **40** | `1 2 3` | **보이지 않음** |
| `존재하지않는상품명XYZ` | `…query=존재하지…` | 2 | **0** | (없음) | **보임** |

- 검색은 정상 동작한다. 결과 수는 Dalue `totalCount` 와 일치 (shure → API `totalCount=657`, 화면 1페이지 40 + 페이지 3).
- **"검색결과가 없습니다" 문자열은 항상 DOM 에 남아 있다.** 조회 결과 0건일 때만 `display` 로 나타난다. → HTTP 파싱 시 오탐 위험. 이 도구는 `offsetParent` 로 실제 노출 여부를 판정한다.

### 2.3 검색 결과 페이지의 구조 결함 (신규 발견 — 중요)

`reports/evidence/search-price-defect.json`

| 항목 | 일반 카테고리 목록 페이지 | **Dalue 검색 결과 페이지** |
|---|---|---|
| 카드 `id` | 실제 (`anchorBoxId_4167`, `anchorBoxId_1118` …) | **전부 `anchorBoxId_4558`** (템플릿 1개를 JS 가 복제) |
| `data-price` 속성 | 실제 (`^219000`, `^620000` …) | **전부 `^1,050,000`** |
| 실제 가격 위치 | 카드 본문 텍스트 | `#dprice_<productNo>` 요소 (JS 가 채움) |
| 상품 식별 | 카드 id | **`href` 의 `product_no`** 만 정확 |

실측 (query=genelec, 앞 12건):

```
href_no=1118  dprice_id=dprice_1118  dprice=620,000원     data_price=^1,050,000
href_no=4688  dprice_id=dprice_4688  dprice=620,000원     data_price=^1,050,000
href_no=5396  dprice_id=dprice_5396  dprice=8,592,000원   data_price=^1,050,000
href_no=1127  dprice_id=dprice_1127  dprice=2,670,000원   data_price=^1,050,000
…
```

**이유**: 검색 화면의 SSR HTML 에는 Dalue 템플릿 `<li id="anchorBoxId_4558" data-price="^1,050,000">` 가 **딱 1개** 있고, JS 가 `json.result[i]` 로 텍스트만 교체한다. `id`·`data-price` 는 건드리지 않는다.

**영향**: 검색 페이지를 HTML 파싱으로만 스크래핑하면 **모든 상품이 4558번 상품(105만원)으로 잘못 수집**된다. 이 문제는 HTTP 수집에서는 반드시 발생하는 오류이며, **브라우저 렌더 후 `href`/`#dprice_` 를 읽어야만 해결된다.**

### 2.4 상품 상세페이지 추출

`reports/evidence/products-raw.json` (20건) · CSV `reports/data/samastore-playwright-sample.csv`

상세페이지에서 확보한 필드 (CSV 58개 컬럼):

| 카테고리 | 컬럼 |
|---|---|
| 식별 | `source_product_id`, `canonical_url`, `detail_url`, `jsonld_sku` |
| 상품정보 | `product_name`, `brand`, `manufacturer`, `model_name` |
| 분류 | `category_path`, `category_no_from_canonical`, `sample_source_category` |
| 규격 | `spec_summary`, `spec_description`, `origin_country`, `shipping_fee_text`, `purchase_method`, `delivery_cycle`, `safety_report_no`, `certification_no` |
| 가격 | `published_price`, `published_price_text`, `published_price_kind`, `published_price_is_inquiry`, `retail_price`, `retail_price_text`, **`cgi_supply_price`(공란)**, **`cgi_supply_price_status`= `unverified_no_authority`** |
| 옵션 | `option_group_count`, `option_items`, `option_text`, `option_price_delta_total`, `has_option_price_delta`, `cross_sell_group_count`, `cross_sell_option_groups`, `option_price_changed_on_select` |
| 이미지 | `main_image`, `additional_images`, `image_count` |
| 재고 | `stock_status`, `sold_out_displayed`, `sold_out_evidence`, `availability_jsonld` |
| 구조 | `jsonld_type`, `jsonld_price`, `jsonld_brand`, `variant_count`, `variants`, `placeholder_leak_count`, `visible_placeholder_leak` |

`기본 정보` 표의 실제 row 라벨 (전 건 동일 스키마):

```
상품명 · 판매가 · 소비자가 · 브랜드 · 모델명 · 안전확인신고번호 · 적합인증번호
상품요약정보 · 상품간략설명 · 원산지 · 배송비 · 구매방법 · 배송주기 · 수량
```

### 2.5 옵션 정보 확인 (Task 6)

#### (a) 옵션 스코프 판별 — 가장 위험한 오해 지점

같은 상세페이지에 **두 종류의 옵션 select** 가 함께 나온다.

| select id 패턴 | 실제 소유자 | 판별 근거 |
|---|---|---|
| `product_option_id1` | **이 상품** | `<table><caption>상품 옵션</caption>` 안에 위치 |
| `addproduct_option_id_<pid>_1` | **다른 상품** (`<pid>`) | `<table><caption>옵션 정보</caption>` 안에 위치, 섹션 제목이 "추가구성상품 선택하신 상품은 메인 상품과 함께 결제가 가능합니다." |

실측 근거 (`reports/evidence/option-scope.json`):

```
product 4167 (PreSonus Eris 3.5) 페이지의 select 3개:
  addproduct_option_id_1637_1 → owner 1637 "KLOTZ AY7 클로츠 Lightweight Y 케이블"  (1m/2m(+3,000원)/3m(+6,000원)/6m(+12,000원))
  addproduct_option_id_1638_1 → owner 1638 "KLOTZ AY7A 클로츠 Lightweight Y 케이블" (1m/2m(+2,000원)/3m(+5,000원))
  addproduct_option_id_3319_1 → owner 3319 "[묶음상품용] KLOTZ M1BTT 자체제작 클로츠 레코딩 케이블"
→ 이 중 어느 것도 4167 의 옵션이 아니다
```

**잘못하면**: 스피커 상품(4167)에 케이블 길이 옵션과 추가금이 붙어 버린다. → 본 도구는 `scope='own' | 'cross_sell'` 로 분리해 기록한다. 20건 표본에서 own 옵션 보유 2건, 크로스셀 옵션 동봉 4건.

#### (b) 옵션 가격은 "화면 가격"이 아니라 "숨김 주문가"에 있다

옵션을 바꿔가며 실측 (`reports/evidence/run-summary.json` → `options[].option_price_table`):

| 상품 | 옵션 라벨 | 선언 추가금 | 실측 주문가(`option_box_price`) | 기준 대비 실측 차액 | 화면 표시 가격 |
|---|---|---|---|---|---|
| 5401 (QED Supremus Zr) | `2m` | — | 3,490,000 | 0 (기준) | 3,490,000원 (**변화 없음**) |
| | `2.5m (+300,000원)` | 300,000 | **3,790,000** | **+300,000** | 3,490,000원 (**변화 없음**) |
| | `3m (+900,000원)` | 900,000 | **4,390,000** | **+900,000** | 3,490,000원 (**변화 없음**) |
| 5685 (KLOTZ D-Sub) | `1m` | — | 440,000 | 0 (기준) | 440,000원 |
| | `3m [품절] (+40,000원)` | 40,000 | **null (선택 거부)** | — | 440,000원 |
| | `5m [품절] (+85,000원)` | 85,000 | **null (선택 거부)** | — | 440,000원 |
| 4558 (Q Acoustics Q M20) | `블랙`/`화이트`/`월넛` | — | 1,290,000 (3개 동일) | 0 | 1,290,000원 |

**결론**

1. 옵션 추가금은 **선택 시 화면 가격(#span_product_price_text)이 변하지 않는다.** 실제 반영되는 곳은 숨김 input `input.option_box_price` 의 `value`(=실제 주문가)와 `item_code`(=옵션 코드).
2. `[품절]` 옵션은 선택이 **거부**되어 `option_box_price` 가 `null` 로 남는다. → **옵션별 품절 판정이 가능하다.**
3. 선언 추가금과 실측 차액이 일치하는 것을 5401 에서 확인(300,000 / 900,000 각각 정확히 일치).

→ **CGI 등록 시 옵션 가격은 `option_box_price` 기준으로 산출해야 하며, 화면의 `판매가` 만으로는 옵션 총가를 만들 수 없다.**

### 2.6 품절·판매 중단 표시 확인 (Task 7)

#### (a) 배지 식별의 함정

스킨이 품절 배지를 **2개** 렌더한다.

```html
<img src="//img.echosting.cafe24.com/design/skin/admin/ko_KR/ico_product_soldout.gif"
     class="icon_img" alt="품절">                        <!-- 진짜 배지, JS 가 display 토글 -->
<img src="//img.echosting.cafe24.com/.../ico_product_soldout.gif"
     class="icon_img soldout_{$productNo}" alt="품절" style="display:none;">  <!-- 서버사이드 템플릿 잔재 -->
```

- 두 번째 요소의 class `soldout_{$productNo}` 는 **서버 템플릿 변수가 치환되지 않은 채** 남아 있어 실제 상품 id 와 절대 매칭되지 않는다. `img.soldout` CSS 선택자로 잡으면 **항상 잔재 쪽만 잡는다.**
- 이 도구는 `alt="품절"` 로 후보를 모으고 **computed visibility(`offsetParent`)** 로 진짜 배지를 판정한다.

#### (b) 실측 표 (API `soldOut` 플래그 ↔ 브라우저 화면)

| product_no | API soldOut | 브라우저 품절배지 | JSON-LD availability | 구매영역 | 판정 |
|---|---|---|---|---|---|
| 2910 | 1 | ✅ 보임 | OutOfStock | `SOLD OUT` | 일치 |
| 4889 | 1 | ✅ | OutOfStock | `SOLD OUT` | 일치 |
| 2926 | 1 | ✅ | OutOfStock | `SOLD OUT` | 일치 |
| 5191 | 1 | ✅ | OutOfStock | `SOLD OUT` | 일치 |
| 1622 | 1 | ✅ | (없음) | `SOLD OUT` | 배지만 일치 |
| 4115 | 1 | ✅ | OutOfStock | `SOLD OUT` | 일치 |
| 1119 | 1 | ✅ | OutOfStock | `SOLD OUT` | 일치 |
| 1304 | 1 | ✅ | OutOfStock | `SOLD OUT` | 일치 |
| 4538 | 1 | ✅ | OutOfStock | `SOLD OUT` | 일치 |
| 149 | 1 | ✅ | OutOfStock | `SOLD OUT` | 일치 |
| 3184 | 1 | ✅ | OutOfStock | `SOLD OUT` | 일치 |
| 4056 | 1 | ✅ | OutOfStock | `SOLD OUT` | 일치 |
| **합계** | **12** | **12** | 11/12 | 12/12 | **일치 12/12, 오탐 0건** |

스크린샷: `reports/screenshots/soldout-detail-{1119,1304,3184,4115,4385}.jpg`

#### (c) 목록 페이지에서는 품절 배지가 안 보인다

`soldout-list-cate-*.jpg` 5개 카테고리(24/42/84/366/379) 실측 → **목록 카드에서 품절 배지 0건**.
`data-price` 속성에도 품절 정보가 없다. → **목록에서 재고를 알 수 없고, 상세페이지(또는 API `soldOut`)를 봐야 한다.**

#### (d) 목록 카드의 SSR 결함

`product_no=4558` (Q Acoustics Q M20) 카드가 **11개 카테고리 전부에서** 동일하게 깨진다.

```
렌더된 카드 텍스트:
{$discountPriceRatio}% {$productName} {$summaryDescription} {$simpleDescription}
{$retailPrice}원{$pcDiscountPrice}원{$listIcon} {$icon}
```

→ `placeholder_in_rendered_card=true` 로 검출하고 표본에 `sample_reason=list_placeholder_defect` 로 우선 편입했다.

### 2.7 화면 표시 정보 vs DOM 추출값 대조 — 20건

`reports/data/samastore-playwright-sample.csv`

표본 구성(20건): 엣지케이스 7건(품절 3 · 가격/전화 문의 3 · 판매완료 1) + SSR 결함 1건 + 11개 카테고지 라운드로빈 12건.

| # | id | 브랜드 | 모델명 | 공개 판매가 | 가격 종류 | 재고 | own 옵션 | 크로스셀 옵션 | 이미지 수 | 비고 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1710 | APOGEE | Symphony Desktop | 2,490,000 | numeric | **sold_out** | 0 | **4** | 8 | 엣지(API 플래그), 소비자가 2,770,000 |
| 2 | 3687 | ARTURIA | *(없음)* | 659,000 | numeric | **sold_out** | 0 | 0 | 7 | 엣지(API 플래그) |
| 3 | 1139 | K&M | 21020-300-02 | 181,000 | numeric | **sold_out** | 0 | 0 | 4 | 엣지(API 플래그) |
| 4 | 5162 | Martin Audio | CDD12B | *(공란)* | **inquiry** `전화 문의` | in_stock | 0 | 0 | 5 | 엣지(API 플래그) |
| 5 | 4103 | PRESONUS | CDL SUB18 COVER | *(공란)* | **inquiry** `전화문의` | in_stock | 0 | 0 | 6 | 엣지(API 플래그) |
| 6 | 1502 | SHURE | SM58-BTS | *(공란)* | **inquiry** `219,000 전화문의` | in_stock | 0 | 0 | 7 | 엣지(API 플래그) |
| 7 | 3184 | Michael Tuttle Guitars | *(없음)* | *(공란)* | **sale_closed** `판매완료` | **sold_out** | 0 | 0 | 16 | 엣지(API 플래그), 소비자가 6,350,000 |
| 8 | 4558 | Q Acoustics | M20 | 1,290,000 | numeric | in_stock | **1** | 0 | 13 | SSR 결함, ProductGroup, 소비자가 1,840,000 |
| 9 | 974 | PRESONUS | Eris 3.5 GEN2 | 219,000 | numeric | in_stock | 0 | **3** | 15 | 스피커 |
| 10 | 4175 | SHURE | SV100 | 40,000 | numeric | in_stock | 0 | 0 | 13 | 마이크 |
| 11 | 4167 | PRESONUS | Eris 3.5 GEN2 White | 219,000 | numeric | in_stock | 0 | **3** | 17 | 스피커 |
| 12 | 3563 | SHURE | AONIC 50 GEN2 | 608,000 | numeric | in_stock | 0 | 0 | 18 | 이어폰/헤드폰 |
| 13 | 5612 | Cloud | CL-25 | 281,000 | numeric | in_stock | 0 | 0 | 22 | 레코딩/음향 |
| 14 | 4494 | Rickenbacker | 4005XC | 9,030,000 | numeric | in_stock | 0 | 0 | 21 | 악기/앰프 |
| 15 | 5665 | Genelec | G1BW | 620,000 | numeric | in_stock | 0 | 0 | 18 | Hi-Fi |
| 16 | 5685 | Klotz | YCDAE | 440,000 | numeric | **partial_sold_out** | **1** | 0 | 17 | 케이블/커넥터, ProductGroup |
| 17 | 4537 | Native Instruments | Maschine 3 Bundle Update | 84,000 | numeric | in_stock | 0 | 0 | 19 | 소프트웨어, 소비자가 120,000 |
| 18 | 40 | TC Electronic | *(없음)* | 64,000 | numeric | in_stock | 0 | 0 | 23 | 특가상품, 소비자가 82,000 |
| 19 | 1562 | PRESONUS | Eris 3.5 BT GEN2 | 249,000 | numeric | in_stock | 0 | **3** | 25 | 스피커 |
| 20 | 4176 | SHURE | SV200 | 53,000 | numeric | in_stock | 0 | 0 | 23 | 마이크 |

**대조 결과 요약**

| 지표 | 값 |
|---|---|
| 표본 수 | 20 (11개 카테고리, 12개 브랜드) |
| 가격 종류 | numeric 16 / inquiry 3 / sale_closed 1 |
| 재고 | in_stock 15 / sold_out 4 / partial_sold_out 1 |
| own 옵션 그룹 보유 | 2건 (4558, 5685) |
| 크로스셀 옵션 동봉 | 4건 (1710 owner:3318 / 974·4167·1562 owner:1637·1638·3319) |
| 모델명 미기재 | 3건 (3687, 3184, 40) |
| 추출된 이미지 URL | 74건 (표본 20건 합계, 대표+추가). HTTP HEAD 검증 49건 → **49/49 HTTP 200** |
| `{$...}` 플레이스홀더 잔재 | 20건 전부 24개씩 (Dalue 검색 사이드바 템플릿). **보이는 잔재 0건** |
| 화면(DOM) vs SSR HTML 가격 불일치 | **0건** (4167/4558/3184 3건 대조, §4.4) |

---

## 3. 상품 등록을 위한 데이터 분석 (Task 3)

### 3.1 네이버 스마트스토어 등록 필요 항목 ↔ 확보 가능성

| 필요 항목 | 소스 | 확보율(측정) | 비고 |
|---|---|---|---|
| **상품명** | 기본정보 표 `상품명` / `h2.item_name` / JSON-LD `name` | 20/20 | 3중 확인 |
| **브랜드·제조사** | 기본정보 표 `브랜드` / JSON-LD `brand.name` | 20/20 (API 40/40 일치) | 브랜드 = 제조사 대체. 별도 `제조사` row 는 없음 |
| **모델명** | 기본정보 표 `모델명` / API `modelName` | 17/20 (API 1,969건 중 412건 미기재) | 미기재 시 상품명으로 fallback 필요 |
| **카테고리** | API `categoryNos` + `SubCategory` 트리 / 화면상 LNB 11개 | API 1,969건 전체 | **화면 HTML 에는 최상위 11개만 존재** |
| **상세 규격** | `상품요약정보`·`상품간략설명`·`원산지`·`안전확인신고번호`·`적합인증번호`·`배송비` | 20/20 | |
| **옵션** | `product_option_id*` select + 옵션 표 | own 옵션 2/20 표본 | **크로스셀 옵션과 반드시 분리** |
| **대표이미지** | `/web/product/big/...` 경로 | 49/49 HTTP 200 | 목록 카드는 `small` 이므로 `big` 로 교정 필요 |
| **추가이미지** | `/web/product/extra/big/...` 경로 | 49/49 HTTP 200 | 표본 20건 이미지 URL 합계 74건, HTTP HEAD 검증 49건 전부 200 |
| **공개 판매가격** | 기본정보 표 `판매가` | 16/20 numeric, 3 inquiry, 1 sale_closed | 전체 1,969건 중 62건 inquiry 계열 |
| **재고·품절 표시** | 배지(computed visibility) + JSON-LD `availability` + API `soldOut` | 12/12 일치 | 목록 페이지에서는 감지 불가 |
| **상품 상세 URL** | `canonical` (영문 slug URL) | 20/20 | `https://samastore.co.kr/product/<slug>/<id>/` |
| **CGI 공급가격** | **미확정 — 추정하지 않음** | 0% | CSV 에서 전 건 공란 + `unverified_no_authority` |
| **취급 권한** | **미확정 — 추정하지 않음** | 0% | 별도 컬럼 없음. 본 조사 범위 밖 |

### 3.2 공개 판매가격 ↔ CGI 공급가격 구분 (명시적)

| 구분 | 값 | 근거 |
|---|---|---|
| **공개 판매가격** (`published_price`) | 삼아스토어 쇼핑몰에 **일반 고객에게 공개된 가격**. 기본정보 표 `판매가` = 화면 `span_product_price_text` = JSON-LD `offers.price` | 40건 행 단위 대조에서 **37/37 numeric 완전 일치** |
| **소비자가** (`retail_price`) | 할인 전 표시가. `소비자가` row 에 별도 존재 | 표본 3건 (4558 1,840,000 / 4537 120,000 / 40 82,000) |
| **할인가** (`pcDiscountPrice`) | **공개 판매가와 다르다.** 회원/쿠폰 등 할인 구간가 | §4.3 에서 2건 불일치로 확인 |
| **CGI 공급가격** (`cgi_supply_price`) | **알 수 없음.** 공개 화면에 존재하지 않는다. 별도 권한·계약 필요 | CSV 전 건 공란, `cgi_supply_price_status=unverified_no_authority` |

> **중요**: 옵션 추가금(`(+300,000원)` 등)은 **공개 판매가 기준의 추가금**이며, 공급가 추가금이 아니다.

### 3.3 가격을 공개하지 않는 5가지 표기 (전부 실측)

| 화면 표기 | 코드 point | 분류 | 의미 | 실측 상품 |
|---|---|---|---|---|
| `가격 문의` | `ac00 aca9 20 bb38 c758` | inquiry | 가격 문의 | 2849 |
| `전화 문의` | `c804 d654 20 bb38 c758` | inquiry | **전화 문의** | 5162 |
| `전화문의` | `c804 d654 bb38 c758` | inquiry | 전화 문의 | 4103, 1502 (`219,000 전화문의`) |
| `판매완료` | `d310 b9e4 c644 b8cc` | sale_closed | 판매 완료(가격 없음) | 3184 |
| `판매 완료` | `d310 b9e4 20 c644 b8cc` | sale_closed | 판매 완료 | 4056 |

- API `priceContent` 와 브라우저 렌더링 문자열은 **코드포인트까지 동일**하다(3건 대조 확인).
- API 카탈로그 1,969건 중 `priceContent` 가 문의/완료 계열인 건 **62건 (3.1%)**, `pcDiscountPrice=0` 인 건 10건.

**처리 원칙**: 이 경우 `published_price` 를 **공란**으로 두고 `published_price_kind=inquiry|sale_closed` 로만 기록한다. 숫자를 추정하지 않는다.

> 개발 중 실제로 `문의` 의 코드포인트(`U+BC1C`)를 잘못 사용해 62건 전부가 가격 0원으로 기록되는 문제가 있었다. `tools/playwright/test-extractors.js` 에 회귀 테스트 36건을 추가해 차단했다.

---

## 4. 기존 모델과 비교 / 교차 확인 (Task 4)

### 4.1 삼아스토어 1,597건(사이트맵) vs 1,969건(API) — 차이의 정체

`reports/evidence/api-browser-parity.json` → `set_operations`

| 집합 | 건수 |
|---|---|
| 공개 JSON API 카탈로그 | **1,969** |
| sitemap.xml 상품 URL | **1,597** |
| 교집합 | **1,597** |
| **API 에만 있음 (사이트맵 누락)** | **372** |
| **사이트맵 에만 있음 (API 누락)** | **0** |

- sitemap.xml 전체 `<loc>` 2,136건 = 상품 1,597 + 카테고리 532 + 기타 7(홈/회사정보/약관/게시판 3종).
- **사이트맵은 API 카탈로그의 부분집합이다.** 방향이 반대(사이트맵에 있는데 API에 없음)는 **0건**.
- 누락분 372건 중 **8건을 브라우저로 직접 열어 전부 정상 노출 확인**:

| product_no | 도달 | 화면 판매가 | 브랜드 | 모델명 |
|---|---|---|---|---|
| 5731 | ✅ | 1,820,000원 | IK MULTIMEDIA | (없음) |
| 1710 | ✅ | 2,490,000원 | APOGEE | Symphony Desktop |
| 3887 | ✅ | 449,000원 | Positive Grid | Spark CAB |
| 3687 | ✅ | 659,000원 | ARTURIA | (없음) |
| 4806 | ✅ | 169,000원 | ARTURIA | MiniFuse 1 Champagne |
| 3967 | ✅ | 421,000원 | Genelec | 8000-325W |
| 1139 | ✅ | 181,000원 | K&M | 21020-300-02 |
| 1144 | ✅ | 190,000원 | K&M | 21090-300-02 |

→ **"사이트맵에 없는 상품이 실제 쇼핑몰에서 검색되는가" 에 대한 답: 그렇다.** 누락분은 판매 중이며 상점 검색/카테고리 목록에서 접근 가능하다.

**원인 (확정 아님, 관측 사실)**: sitemap.xml 이 `display=1 & selling=1` 필터 결과의 부분집합만 생성한 것으로 보인다. API `equalFields=display,selling&equalValues=1,1` 필터는 1,969건을 반환하는데 sitemap 은 1,597건만 포함한다. → **정확한 생성 규칙은 사이트 내부 구현에 의존하므로 "미확정"으로 남긴다.** (브라우저 관점 결론에는 영향 없음)

> **교정 사항**: 기존 Model A 보고서의 "삼아스토어 1,969건" 수치는 **그대로 유효**하다. 1,597은 sitemap 이라는 **다른 소스의** 건수이므로 둘 다 사실이지만, **수집 기준은 1,969건으로 잡아야 한다.**

### 4.2 API vs 브라우저 행 단위 대조 — 40건

`reports/data/api-browser-parity.csv` · `reports/evidence/api-browser-parity.json`

| 지표 | 결과 |
|---|---|
| 표본 | 40건 (카탈로그 전체에서 stride 균등 추출) |
| 상품명 일치 | **40/40 (100%)** |
| 브랜드 일치 | **40/40 (100%)** |
| 모델명 일치 | **40/40 (100%)** |
| **가격 일치 (numeric)** | **37/37 (100%)** |
| 가격 일치 (비수치 3건) | **3/3 (100%)** — inquiry/sale_closed 분류 일치 |
| 품절 일치 (API soldOut=1) | **12/12 (100%)**, 오탐(API=0인데 품절) **0건** |
| 브라우저 오류 | **0건** |

**가격 필드 의미 정정 (중요)**

처음에는 API `pcDiscountPrice` 를 공개 가격으로 비교했고 **5건 불일치**가 나왔다. 원인을 추적한 결과:

| product_no | API `price` | API `pcDiscountPrice` | API `retailPrice` | API `priceContent` | 화면 `판매가` | 정답 |
|---|---|---|---|---|---|---|
| 3324 | **6,490,000** | 5,841,000 | 6,490,000 | null | **6,490,000원** | `price` |
| 5575 | **137,000** | 52,000 | 0 | null | **137,000원** | `price` |
| 2849 | 10,100,000 | 10,100,000 | 0 | `가격 문의` | `가격 문의` | **비수치** |
| 3184 | 6,350,000 | 6,350,000 | 6,350,000 | `판매완료` | `판매완료` | **비수치** |
| 4056 | 4,590,000 | 4,590,000 | 0 | `판매 문의` | `판매 문의` | **비수치** |

→ **공개 판매가격은 API `price` 필드다. `pcDiscountPrice` 는 할인 구간가이며 공개 판매가가 아니다.**
→ 또, `price` 필드에 숫자가 들어있어도 `priceContent` 가 문의/완료 문자열이면 **그 문자열이 화면에 표시되는 실제 값**이다.

### 4.3 옵션이 API 와 브라우저에서 일치하는가

| 관측 | 결과 |
|---|---|
| API `options` JSON 은 `has_option` / `option_type` / `options[].option_value[].option_text` 구조 | 확인 |
| 브라우저 `product_option_id*` select 의 옵션 라벨 | API `option_text` 와 **동일 포맷** (`2m (+3,000원)`, `5m [품절] (+14,000원)`) |
| 브라우저 `option_box_price` (실제 주문가) | **API 응답에 없는 정보** → API 는 옵션 추가가까지만 준다 |
| 옵션별 품절 | API `options` JSON 에는 품절 플래그가 **명시적으로 없음**. 브라우저는 `[품절]` 텍스트 + 선택 거부로 판정 |
| 5401 실측 | 화면 `2.5m` 주문가 3,790,000 = 기본 3,490,000 + 300,000 (선언 추가금과 정확히 일치) |

→ **옵션 구성(라벨·추가금)은 API 와 브라우저가 일치. 옵션별 실제가격·옵션별 품절은 브라우저만 추가로 얻는다.** 이 도구가 `option_box_price` 를 읽는 이유.

### 4.4 같은 제품의 두 도메인 URL

§1.2 에서 5/5건 완전 동일 확인. canonical 이 항상 `samastore.co.kr` 이므로 **등록 시 상세 URL 은 canonical 을 쓰면 되고, 두 도메인 모두 쓰면 중복 등록 위험이 있다.**

### 4.5 Playwright 가 HTTP/API 수집에 비해 추가로 확보하는 정보 (요약)

| # | 추가 정보 | HTTP/API 로는 | 브라우저로 | 실측 근거 |
|---|---|---|---|---|
| 1 | 옵션별 실제가격 | ❌ | ✅ | `option_box_price` 를 옵션마다 변경하며 실측 (5401: +300,000 / +900,000 일치) |
| 2 | 옵션별 품절 | △ (라벨 텍스트로 간접) | ✅ | `[품절]` 옵션 선택 시 `option_box_price=null` |
| 3 | 화면 vs DOM 불일치 | ❌ | ✅ | 4558 카드 `{$...}` 잔재, 검색 페이지 `data-price` 전부 `^1,050,000` |
| 4 | 검색 결과 페이지의 정적 속성 오염 | ❌ (오인 위험) | ✅ | href/dprice 만 정확, id·data-price 는 템플릿값 |
| 5 | 품절 배지의 실제 노출 상태 | ❌ (항상 display:none) | ✅ | computed visibility 로 12/12 판정 |
| 6 | 두 도메인의 상품 동일성 증명 | △ | ✅ | 이미지 MD5 집합 비교 5/5 |
| 7 | 카테고리 메뉴 실交互 검증 | ❌ | ✅ | 클릭 후 URL 이동 확인 |
| 8 | 검색 UX 실측(무결과 시 메시지 토글) | ❌ | ✅ | 0건 조회 시에만 노출 확인 |
| 9 | 비수치 판매가 4형태 식별 | △ | ✅ | inquiry/sale_closed 분류 |
| 10 | 이미지 실제 응답 확인 | ✅ (HTTP 가능) | ✅ | 49/49 HTTP 200 |

**역방향 결론(중요)**: 브라우저가 HTTP 수집을 "대체"하지는 않는다. **대량 수집은 여전히 API 1회(1,969건) 가 압도적으로 우위**이고, 브라우저는 **검증·예외 처리·옵션·화면 상태** 에서만 우위다. 본 조사도 그 원칙으로 설계했다.

---

## 5. 재사용 가능한 스킬 (Task 5)

`tools/playwright/` — 상세는 `tools/playwright/README.md`

### 5.1 제공 기능 (요구 8개 항목 매핑)

| 요구 | 구현 | 파일 |
|---|---|---|
| 1. 쇼핑몰 접속 | `launch()` — Chromium, ko-KR/Asia-Seoul/1440×1000, headed/headless | `lib/browser.js` |
| 2. 카테고리 선택 | `#category-lnb` 11개 추출 → 전 카테고리 목록 순회 → 실제 클릭 검증 | `explore.js` `readCategoryMenu` |
| 3. 상품 검색 | 검색창 입력 + Enter → 결과 URL·카드수·무결과 메시지 상태 기록 | `explore.js` `runSearch`, `verify-search.js` |
| 4. 상품 상세 열람 | 20건 상세페이지 + 기본정보 표·JSON-LD·이미지·옵션 | `explore.js` `openDetail` |
| 5. 옵션 정보 확인 | own 옵션만 선별 → 옵션마다 선택 → 실제가격·품절·거부여부 | `explore.js` `inspectOptions` |
| 6. 상품 정보 추출 | 58컬럼 평탄화 레코드 | `lib/extractors.js`, `explore.js` `normalise` |
| 7. CSV 저장 | UTF-8 BOM CSV (Excel 호환) | `explore.js` `toCsv` |
| 8. 오류 시 재시도 및 증거 기록 | `withRetry` (3회, 지수 백오프) + `reports/evidence/*.jsonl` + 스택트레이스 | `lib/browser.js` |

### 5.2 재실행 명령

```bash
cd tools/playwright
npm install && npx playwright install chromium

node test-extractors.js                                                   # 파서 단위 테스트 36건
node explore.js --products 20 --search "shure" \
                --edge "1710,3687,1139,5162,4103,1502,3184"                # → CSV 20건
node compare-api-browser.js --sample 40                                    # → 패리티 CSV 40건
node verify-final.js                                                       # 이미지/도메인/SSR 검증
node verify-search.js && node verify-search-price.js                        # 검색·검색결함 검증
node collect-screenshots.js && node consolidate.js                          # 증거 정리
```

### 5.3 안전장치

- **구매·주문·결제 없음.** `select` 값 변경과 링크 이동만 수행. 종료 시 `assertNoPurchaseClicked()` 로 위반 0건 확인, 위반 시 비정상 종료.
- **로그인 없음.** API 키는 쇼핑몰이 자기 페이지에 공개한 값(`apiKey=Ak25dpcSKLXu`, `mallId=sama2015`).
- **기존 수집 프로그램 미수정.** 기존 산출물·스크립트는 건드리지 않았고, 신규 파일만 추가했다.
- **증거 보존.** 실패 시 스택트레이스 + 시도 횟수 + 타임스탬프가 JSONL 에 남는다.

---

## 6. 실패·오류·미확정 사항 (명시)

| 항목 | 상태 | 근거 |
|---|---|---|
| Dalue API 엔드포인트 | **정정 완료**. 기존 모델이 쓴 `/api/search` 는 `code=-7 "권한이 없습니다"` 로 실패. 실제는 `POST https://api.dalue.io:10806/dcse/query` | 브라우저 네트워크 캡처(`tools/playwright/capture-search-network.js`)로 확보 |
| `query` 파라미터 필수 | **확정**. 누락 시 `code=-1 "query 필드가 지정되지 않았습니다"` | 4개 변형 실측 |
| `aclFlagField` 필수 | **확정**. 누락 시 `code=-1 "aclFlagField[]를 찾을 수 없습니다"` | 4개 변형 실측 |
| **CGI 공급가격** | **미확정** — 공개 화면에 존재하지 않음. 추정하지 않음 | CSV 전 건 공란 + `unverified_no_authority` |
| **취급/판매 권한** | **미확정** — 본 조사 범위 밖, 추정하지 않음 | — |
| **단종(판매중단) 상품 구분** | **미확정** | 화면에 `판매중단`/`입고문의` 같은 전용 마커가 없다. `판매완료` 는 가격 미공개로 구분될 뿐 단종 판정 근거는 없다 |
| **실제 재고 수량** | **미확정** | 사이트가 수량을 노출하지 않는다(품절 여부만). 재고 API 없음 |
| **옵션 추가금 구조화 (전량)** | **부분 구현** | 20건 표본 중 own 옵션 보유 2건만 실측. 전 1,969건 대상 구조화는 미수행 |
| **하위 카테고리 전체 경로** | **부분** | 화면 HTML 에는 최상위 11개만 존재. API `categoryNos` 로 복원 가능(미구현) |
| **sitemap 372건 누락의 정확한 생성 규칙** | **미확정** | 관측 사실(부분집합 관계)만 확정 |
| **상품 갱신 시각** | **미확정** | 사이트가 `updated_at` 미제공 |
| **검색 결과 총 건수 화면 표시** | **미확정** | 화면에는 페이지네이션만 있고 총 건수 표기가 없어, 총 건수는 API `totalCount` 를 신뢰 |

### 6.1 API 카탈로그 1,969건 기준 통계 (실측)

| 지표 | 건수 | 비율 |
|---|---|---|
| 전체 상품 | 1,969 | 100% |
| `soldOut=1` (품절) | **361** | 18.3% |
| 가격 미공개(`priceContent` 문의/완료 계열) | **62** | 3.1% |
| `pcDiscountPrice` = 0 (가격 0) | 10 | 0.5% |
| `modelName` 미기재 | **412** | 20.9% |

### 6.2 실행 중 발견한 자기 오류 (교정 이력)

| 오류 | 영향 | 교정 |
|---|---|---|
| `addproduct_option_id_*` 를 본인 옵션으로 오인 | 스피커 상품에 케이블 옵션/추가금이 귀속 | `scope=own/cross_sell` 분리 + `verify-option-scope.js` 로 확인 |
| `원`/`문의`/`품절` 리터럴 인코딩 손실 | 옵션 추가금 0원, 가격문의 0원, 품절 미탐지 | 유니코드 코드포인트 상수화 + `test-extractors.js` 36건 |
| `parseDataPrice('')` → 0 | 빈 값을 0원으로 오인 | null 반환으로 수정 (회귀 테스트로 고정) |
| 품절 배지를 `img.soldout` 로 선택 | 항상 display:none 인 템플릿 잔재만 잡음 | `alt="품절"` + computed visibility |
| `page.evaluate` 안에서 `require()` 호출 | 도메인 동일성 검증 5건 전부 실패 | 페이지 내부 해시 함수로 교체 |
| 비교 기준을 `pcDiscountPrice` 로 설정 | 가격 불일치 5건(실제 0건) | `price` 필드 + `priceContent` 문자열 우선으로 교정 |

---

## 7. 산출물 목록

| 경로 | 내용 |
|---|---|
| `reports/site-analysis-playwright.md` | 본 문서 (고객용 PART 1 + AI 검토용 PART 2) |
| `reports/data/samastore-playwright-sample.csv` | 브라우저 수집 20건 (58컬럼, UTF-8 BOM) |
| `reports/data/api-browser-parity.csv` | API↔브라우저 행 단위 대조 40건 |
| `reports/screenshots/` | 검증 스크린샷 51장 (JPEG 압축, 3.51 MB) |
| `reports/evidence/consolidated.json` | 모든 수치가 모인 단일 JSON |
| `reports/evidence/crosscheck-samasound.json` | 삼아사운드(B2B) 가격 공개 여부 교차 대조 원자료 |
| `reports/evidence/search-verification.json` | 검색 3건 실측(정상 2 + 무결과 1) |
| `reports/evidence/search-price-defect.json` | 검색 결과 페이지 정적 속성 오염 증명 |
| `reports/evidence/*.json` | 도메인·카테고리·검색·패리티·최종검증 원자료 |
| `reports/evidence/*.jsonl` | 오류/재시도 실행 로그 |
| `reports/evidence/products-raw.json` | 20건 원본 (옵션별 실제가격 포함) |
| `reports/evidence/screenshot-manifest.json` | 스크린샷 선별 근거 |
| `tools/playwright/` | 재실행 스크립트 전체 (README 포함) |
| `tools/playwright/test-extractors.js` | 파서 단위 테스트 36건 |

## 8. 제약 준수 기록

- 네이버 스마트스토어 등록·로그인·상품게시: **수행하지 않음**
- 상품 구매·주문·결제: **수행하지 않음** (코드 레벨 강제 검증)
- ERP 변경: **수행하지 않음**
- Google Drive 업로드: **수행하지 않음**
- 제3자 계정/로그인 접근: **없음**
- 기존 수집 프로그램 수정: **없음** (신규 파일만 추가)
- 전체 사이트 무제한 요청: **위반하지 않음** (요청 간 0.4~0.8초, 병렬화 없음, 총 요청 수백 회)
- 영업/판매가·대리점 권한 추정: **없음** (`cgi_supply_price` 전 건 공란, `cgi_supply_price_status=unverified_no_authority`)
