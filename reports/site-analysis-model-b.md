# CGI 공급처 사이트 독립 분석 — 모델 B

> **원칙 선언**
> - 본 문서는 **모델 A 결과(`reports/site-analysis-model-a.md`)를 읽지 않고** 작성했다. 모델 B가 `https://www.samasound.co.kr/` 과 `https://www.samamusic.co.kr/` 을 직접 탐색·실측한 결과만 담는다.
> - **가격·공급가·재고의 미확인 값을 추정하지 않았다.** 공개 표기되지 않은 값은 빈 값 또는 상태 토큰으로만 기록한다.
> - **네이버 스마트스토어 / ERP 를 조작하지 않았다.** 공개 GET 페이지만 읽었다(로그인·장바구니·주문·쿠폰·게시 API 호출 0건).
> - **Google Drive 업로드 없음.** 산출물은 이 저장소 PR 로만 제출한다.
> - 제3자 계정 접근 없음. 계정 없이 확인 불가한 정보는 "미확인"으로 표기한다.

- 이슈: [#5 [P0][RESEARCH] 삼아사운드 상품 사이트 2모델 독립 분석 및 수집 설계](https://github.com/skerishKang/kbs261022/issues/5)
- 작성 모델: **B (독립 탐색 · 교차 확인 · 상품 마스터/운영 설계 담당)**
- 작성일: 2026-10-22
- 담당: 김범신(CGI) 전용 저장소 `skerishKang/kbs261022`

---

## 0. 한 줄 요약

두 사이트는 **같은 회사의 서로 다른 서비스이며 서로 다른 플랫폼 역할을 한다.**
**Tri-A(삼아사운드)= 가격 미공개 B2B 제품 카탈로그**(실측 2,281 unique 상품, 판매가 공개 0%),
**Tri-B(삼아스토어)= 가격 공개 온라인 판매 스토어**(실측 2,294 unique 상품, 판매가 공개 92.4%).
둘은 **동일 상품군을 다룬다**(정규화 상품명 완전일치 28그룹, 모델 토큰 공유 202개, 교차 후보 513쌍).
따라서 통합 상품 마스터는 "한 개 테이블 + `source_site` 구분" 이 아니라 "**한 개 스키마 + 원천별 필드 채움률 차이를 명시**"하는 설계가 되어야 한다.

---

## 1. 사이트 식별 결과

| 항목 | Tri-A 삼아사운드 | Tri-B 삼아스토어 |
|---|---|---|
| 접속 URL | `https://www.samasound.co.kr/` | `https://www.samamusic.co.kr/` |
| canonical 호스트 | `https://samasound.co.kr` (www 아님) | `https://samastore.co.kr` (www 아님) |
| 플랫폼 | Cafe24 | Cafe24 |
| 스킨/패키지 | `skin/base` 기반 + `_wg` 일부 | `_wg` + Cafe24 **Dalue 검색 모듈** |
| 응답 헤더 | `X-HURL: /samassi1view_pcKRagent_pc` | `X-HURL: /sama20151view_pcKRagent_pc` |
| 내부 Cafe24 store id | `samassi.cafe24.com` | `sama2015.cafe24.com` |
| `sitemap.xml` | **404** (없음) | **200** — 2,136 URL (product 1,597 / category 532) |
| 사이트맵 정합성 | 해당 없음 | **불일치**: 사이트맵 product 1,597 < 실측 unique 2,294 |
| `robots.txt` | 있음 (admin/api/member/myshop/skin-* 등 Disallow) | 동일 구조 |
| 한국어 사업자 정보 | 삼아사운드(유), 사업자 897-87-00609, 서울 종로구 삼일대로 457 11층 | 푸터에서 동일 상호/주소 확인 |

> **결론 A**: 두 사이트는 동일 회사의 **카탈로그(Tri-A)** 와 **스토어(Tri-B)** 이다. 통합 마스터는 동일 스키마를 쓰되 **원천별로 필드 채움률이 다르다**는 전제를 깔아야 한다.

---

## 2. 공개 데이터 수집 경로 (실측)

### 2.1 공통 (Cafe24 기반)

두 사이트 모두 Cafe24 프런트엔드이므로, 상품 상세 HTML 안에 **정규화된 전역 변수가 그대로 노출**된다. 이 점이 수집 난이도를 크게 낮췄다.

```js
var product_name       = 'SHURE PGA48 슈어 보컬용 유선 마이크';
var product_price      = '78000';        // 판매가(정수 문자열)
var _iPrdtPriceOrg     = 70909;           // 판매가에서 VAT 10% 차감한 구성액
var _iPrdtPriceTax     = 7091;            // 부가세
var product_code       = 'P0000DQK';      // 상품코드 (ERP 상품코드 후보)
var item_code          = 'P0000DQK000A';  // 옵션(item) 단위 코드
var item_listing_type  = 'C';             // 'S' = inquiry/미판매 계열
var option_type        = 'T';
var stock_number       = '177';
var single_option_stock_data = '{"use_stock":true,"use_soldout":"T","stock_number":177,"is_reserve_stat":"N"}';
var add_option_data    = '{...}';         // 추가구성상품 옵션별 추가금액/품절 JSON
var aSoldoutDisplay    = {"1431":"품절"};
var link_product_detail= '/product/...';
```

- **가격**: `var product_price` + 기본정보 표 `판매가` 행. `0` 이면 미공개(문의/미판매).
- **할인가**: `class="infoArea" data-price="정가^판매가"` (예 `1840000.00^1290000`). `^` 앞이 정가, 뒤가 판매가. 정가 미설정이면 `0.00^판매가`.
- **옵션**: `<select option_title="...">` 3종 + `add_option_data` JSON.
- **이미지**: `/web/product/{tiny|small|medium|big|extra}/{YYYYMM}/{hash}.{ext}`.

### 2.2 Tri-A 전용

| 목적 | 경로 | 실측 근거 |
|---|---|---|
| 전체 상품 | `GET /product/list.html?cate_no=23&page=N` | 20건/페이지, **112 페이지**, `등록 제품 : 2229` |
| 브랜드별 | `GET /product/list.html?cate_no=24` | `등록 제품 : 2211` |
| 제품분류별 | `GET /product/list.html?cate_no=25` | `등록 제품 : 2053` |
| 카테고리 계층 | 동일 URL 의 `xans-product-headcategory path` (`/category/{name}/{id}/`) | 4단계 노출, 5단계부터는 잘림 |
| 상품 상세 | `GET /product/detail.html?product_no={id}` (cate_no 없이) | **cate_no 를 넣으면 브레드크럼이 조회 카테고리로 덮어써진다** |
| 카테고리 ID 발견 | `cate_no=1..519` 1회씩 GET → 브레드크럼 존재 여부 | **361개** 유효 카테고리 |

> **결론 B**: Tri-A 는 사이트맵이 없어 **카테고리 ID 스위프 + 목록 크롤**이 유일한 완전 수집 경로다.

### 2.3 Tri-B 전용

| 목적 | 경로 | 실측 근거 |
|---|---|---|
| 사이트맵 | `GET https://samastore.co.kr/sitemap.xml` | 2,136 URL. **최신 전체가 아님** |
| 카테고리 목록 | `GET /product/list.html?cate_no={id}&page=N` | 20건/페이지. 목록 페이지에 하위 카테고리 링크 포함 |
| 상품 상세 | `GET /product/detail.html?product_no={id}&cate_no={cid}&display_group=1` | `cate_no` 가 실제 카테고리여야 `setCategoryCookie` 가 정확 |
| 검색 | `/shopSearch/search.html?keyword=` | Dalue 검색 모듈 (브라우저 AJAX) |

> **결론 C**: Tri-B 는 사이트맵이 **부분만** 담고 있으므로, 완전 수집의 기준은 **카테고리 목록 크롤**이다. 사이트맵은 보정용 체크리스트로만 쓸 것.

### 2.4 수집량 실측 (요청 건수)

| 대상 | 요청 수 | 비고 |
|---|---|---|
| Tri-A 전체 목록 (cate 23) | 113 | 112 페이지 + 1 |
| Tri-A 카테고리 ID 스위프 (1..519) | 519 | 브레드크럼 존재 여부로 유효 판정 |
| Tri-A 카테고리 전체 크롤 (361) | 361 + 페이지네이션 | unique 2,281 |
| Tri-B 카테고리 전체 크롤 (532) | 532 + 페이지네이션 | unique 2,294 |
| Tri-B 사이트맵 | 1 | |
| 상세 페이지 (검증 20 + 랜덤 160) | 212 | |
| **합계 (URL 중복 포함)** | **2,369** | 로컬 캐시 2,369개 / 651 MB, 재실행 시 네트워크 0 |

지연 0.25~0.35초, 동시 요청 없음, robots Disallow 경로(`/admin`, `/api`, `/exec/front/`, `/member/`, `/myshop/`, `/protected/`, `/skin-*/`, `/*board*page=`, `/*article*category_no=`) 는 **미방문**했다. 수집 대상 경로는 모두 허용 영역이며 `?cate_no=N&page=M` 형태는 Disallow 패턴(`/*page_4=`)에 걸리지 않는다.

---

## 3. 카테고리 구조

### 3.1 Tri-A — 이중 축(브랜드 축 + 제품유형 축)

```
전체보기(23)  2,229
├─ 브랜드별 보기(24)  2,211
│   ├─ A-C  (27개 브랜드 카테고리)
│   ├─ D-G  (20)
│   ├─ H-K  (41)
│   ├─ L-O  (40)
│   ├─ P-R  (49)
│   └─ S-Z  (18)
└─ 제품분류별 보기(25)  2,053
    ├─ 마이크(394)                      425
    ├─ 스피커&퍼스널리스닝(396)          488
    ├─ 프로 오디오(395)                 364
    ├─ 레코딩&악기(398)                 571
    ├─ 룸어쿠스틱&스탠드(390)            63
    ├─ 회의 시스템 & 통합제어(397)        78
    ├─ 케이블/커넥터(403)                 6
    └─ 통합제어(447)                       0
```
> 상위 카테고리 `등록 제품` 수는 **하위 카테고리 상품을 포함**하므로 합산이 되지 않는다(브랜드 합 3,266 > 2,211). 리프 기준 값만 비교해야 한다.

**브랜드 카테고리 59개** (상위): Shure 948 · Neutrik 278 · HK Audio 226 · KLOTZ 161 · PRESONUS 160 · Allen&Heath 143 · Martin Audio 142 · K&M 138 · GENELEC 132 · REAN 130 · RADIAL 92 · APOGEE 75 · ARTURIA 66 · NATIVE INSTRUMENTS 63 · Q-SYS 54 · MESA/BOOGIE 53 · JICO 46 · Waves 44 · IK MULTIMEDIA 40 · PRIMACOUSTIC 40 · Electro-Voice 35 …

### 3.2 Tri-B — 브랜드(24) + 11개 유형 루트

| 유형 루트 | cate_no | 리스트 수집 상품수 | 대표 브랜드 카테고리 |
|---|---|---|---|
| 프로모션 보기 | 1152 | 583 | — |
| 레코딩/음향 | 26 | 448 | — |
| 액세서리 | 88 | 301 | — |
| 악기/앰프 | 379 | 287 | — |
| 15% 할인상품 | 1204 | 224 | — |
| 일렉트릭 기타 | 957 | 222 | — |
| 스피커 | 42 | 216 | — |
| 10% 할인상품 | 1209 | 194 | — |
| Hi-Fi | 1038 | 167 | — |
| 소프트웨어 | 758 | 158 | — |
| 특가상품 | 97 | (대량) | — |

브랜드 축: `브랜드(24)` 하위에 **144개** 브랜드 카테고리 — SHURE(671, 580) · KLOTZ(654, 161) · PRESONUS(662, 135) · MICHAEL TUTTLE GUITARS(658, 120) · NEUTRIK(660, 117) · GENELEC(646, 100) · NASH GUITARS(659, 91) · MESA/BOOGIE(657, 66) · ARTURIA(807, 65) · REAN(666, 60) · K&M(652, 54) · APOGEE(642, 50) · JICO(1016, 49) · RADIAL(665, 48) · Waves(784, 43) · IK MULTIMEDIA(805, 42) · PRIMACOUSTIC(663, 39) · NATIVE INSTRUMENTS(940, 33) · QED(1053, 32) · COMPLY(822, 27) · OVERLOUD(661, 23) · iZotope(780, 22) · Q Acoustics(1052, 22) · POSITIVE GRID(942, 21) …

> **비교 요약**: Tri-A 는 브랜드 59 / 유형 8 루트, Tri-B 는 브랜드 144 / 유형 11 루트 + 프로모션·할인 카테고리 다수. **동일 브랜드가 양쪽에 존재하지만 카테고리 ID·이름·깊이가 전부 다르다.**

### 3.3 Tri-B 의 계층 복원 한계 (중요)

Tri-B(samamusic)는 Tri-A 와 달리 **상세 페이지에 브레드크럼이 없고**, 목록 페이지에 노출되는 하위 카테고리 링크 블록은 **페이지 공통 스니펫**이다. 실측 결과, `액세서리(363)` 페이지에서도 `NEUTRIK 커넥터액세서리(361)` 가 자식으로 표시되는 등 **동일한 12개 링크가 모든 페이지에 반복**되어, 목록 HTML 로는 부모-자식 관계를 신뢰성 있게 복원할 수 없다.

따라서 Tri-B 에서 **공개 HTML 로 확정 가능한 것**은 다음 3가지로 한정된다.

1. **최상위 메뉴 11개** (홈메뉴 depth 기준 확정): 프로모션 보기(1152) · 브랜드(24) · 마이크(84) · 스피커(42) · 이어폰/헤드폰(25) · 레코딩/음향(28) · 악기/앰프(379) · Hi-Fi(1038) · 케이블/커넥터(366) · 소프트웨어(758) · 특가상품(97)
2. **브랜드(24) 하위 144개 브랜드 카테고리 ID·이름** (사이트맵 + 목록 크롤)
3. **리프 카테고리 532개의 ID·이름** (사이트맵 `lastmod` 포함)

`source_category_path` 는 Tri-B 에서 **리프 이름만** 채운다(계층 미확정). 삼아스토어 관리자 계정 없이 전체 계층 트리를 확정할 수는 없다 — 본 보고서는 이 공백을 추정으로 메우지 않는다.

---

## 4. 상품 분석

### 4.1 실측 상품 수 (추정 아님)

| 지표 | Tri-A | Tri-B |
|---|---|---|
| `전체보기` 등록 상품 수 (Cafe24 자체 카운터) | **2,229** | 해당 루트 없음(404) |
| 카테고리 목록 크롤로 얻은 unique product_no | **2,281** | **2,294** |
| sitemap.xml 수록 상품 | 없음(404) | 1,597 (**실제 대비 697 부족**) |
| 카테고리 수 | 361 | 532 |

> Tri-A 2,229 vs 2,281 차이 52건: `전체보기` 목록에 노출되지 않지만 하위 카테고리에는 속하는 상품이 있다(카테고리 숨김 처리). Tri-B 2,294 는 532개 카테고리 목록을 전수 순회해 얻은 값이다.
> **두 사이트 모두 상품 수는 실측값이며, sitemap 만으로는 판단할 수 없다.**

### 4.2 브랜드 출처

| | Tri-A | Tri-B |
|---|---|---|
| 브랜드 필드 | 기본정보 표 `제조사` 행 | 기본정보 표 `브랜드` 행 |
| 표기 정규화 | 없음 (`Genelec`, `NASH GUITARS`, `ARTURIA`, `SHURE`, `QED` 혼재) | 없음 (`Genelec`, `NASH GUITARS`, `ARTURIA`, `SHURE`, `Q Acoustics` 혼재) |
| 브랜드 카테고리 | 59개 (브랜드별 보기) | 144개 (브랜드 24 하위) |
| 브랜드 필드 채움률(상세 26건) | 100% | 100% |

> **브랜드는 자유 입력 대소문자 혼재**다. 통합 마스터에는 `source_brand`(원문)와 `brand_normalized`(마스터 브랜드코드)를 **둘 다** 두어야 한다.

### 4.3 모델번호 — 가장 큰 사이트 간 격차

| | Tri-A | Tri-B |
|---|---|---|
| 전용 `모델명` 필드 | **없음** (기본정보에 `모델명` 행 자체가 없음) | **있음** |
| 채움률 (상세 80건 랜덤) | 0/80 (0%) | **58/80 (72.5%)** |
| 대안 | 상품명이 곧 모델번호 | 모델명 + 상품명 |
| 상품명이 모델코드형(≤4 토큰 영숫자)인 비율 | **1,381/2,281 (60.5%)** | 2/2,294 (0.1%) |

Tri-A 예: `NC3MXX-50`, `SCDX-9`, `WL185MB/C-TQG`, `SM35-TQG`, `PGA31-TQG`, `CD32`, `XXCR`, `JACK-JACK CABLE 1.5m`, `VicOffice Desk`
Tri-B 예: `PGA48-LC`, `Eris 3.5 GEN2`, `OW15Y02.100`, `NC3FXX-EMC`, `8000-403 (26000-329-55)`, `SAM-90 PB-52`, `RC3FDL`

> **결론 D**: 모델번호 정규화는 **Tri-B 는 필드 직접 채움**, **Tri-A 는 상품명 파싱(규칙 기반)** 이다. Tri-A 에서 모델을 임의로 "추정"하면 안 되므로, 규칙으로 추출되지 않으면 `model` 을 빈 값으로 두고 `model_derivation=from_name|explicit|none` 로 추적해야 한다.

### 4.4 옵션 구조 — Café24 공통 3종 + 사이트별 차이

| 구분 | 마커 | Tri-A | Tri-B |
|---|---|---|---|
| A. 메인상품 옵션 | `product_option_area="product_option_*"` | **0/80** (0%) | 11/80 (13.8%) |
| B. 추가구성상품(옵션 보유) | `product_option_area="addproduct_option_*"` | 0/80 | 9/80 (11.3%) |
| C. 추가구성상품(옵션 없음, "상품선택" 드롭다운) | `id/name="addproduct_option_(id\|name)_<no>"` | 0/80 | 9/80 (11.3%) |
| 옵션 추가금액 | `add_option_data` JSON `option_price`/`origin_option_added_price` | 없음 | 있음 |
| 옵션 품절 | `add_option_data` `stock_number` + `use_soldout` | 없음 | 있음 |

**Tri-B 옵션 값 예 (브라우저 렌더 = 요청기 파싱 동일, 실측)** — 상품 `P0000DQK`(SHURE PGA48):

| 추가구성상품 | 옵션 | 렌더 값 | 파싱 근거 |
|---|---|---|---|
| 1431 (KLOTZ M1 PRIME) | 길이선택 | `1m [품절]` / `3m (+6,000원) [품절]` / `5m (+10,000원)` / `10m (+28,000원)` | `add_option_data.option_price`(39000/45000/49000/67000) − 기준가 39000 = 추가금액, `stock_number==0` → 품절 |
| 1441 (KLOTZ M5 HIGH-END) | 길이선택 | `3m [품절]` / `6m (+19,000원) [품절]` / `10m (+44,000원)` / `20m (+107,000원)` | 동일 |
| 1138 (K&M 21020) | — | `K&M 21020 (블랙) 케이앤엠 마이크 스탠드` | `item_code=P0000BRU000A` |
| 1143 (K&M 21090) | — | `K&M 21090 (블랙) … [품절]` | `aSoldoutDisplay` |

> **결론 E**: 옵션 추가금액·품절 표기는 브라우저에서만 "보이는" 것처럼 보이지만, **원본 HTML 의 `add_option_data` JSON 에 동일 정보가 그대로 있다.** 따라서 **브라우저 렌더링 없이 요청기 파싱만으로 브라우저와 동일한 결과**를 얻는다(§7 에 실측 대조).

### 4.5 이미지

| | Tri-A | Tri-B |
|---|---|---|
| 경로 규칙 | `https://www.samasound.co.kr/web/product/{medium\|small\|big}/{YYYYMM}/{hash}.{ext}` | `https://www.samamusic.co.kr/web/product/{medium\|small\|big\|extra\|tiny}/{YYYYMM}/{hash}.{ext}` |
| 목록 대표이미지 | `medium` (2,281/2,281) | `medium` (2,207) + 기타 87 |
| 상세 대표이미지 | `img.BigImage` → `/web/product/big/...` | `#big_img_box` + `ul.d_thumb li img[data-src]` (extra/big) |
| 추가이미지 | `ul.listImg img.ThumbImage` (`small`) | `extra/big` (listPage `d_thumb`) |
| 원본(원해상도) 경로 | `big` 를 원본으로 사용 | `extra/big` 를 원본으로 사용 |

> 이미지는 **Cafe24 고정 호스트 경로 규칙**을 따르므로 `medium`→`big`→`extra` 치환으로 원본 후보를 만들 수 있다. 단, **존재 여부를 확인하지 않은 URL을 만들어 넣으면 안 되므로** 검증된 URL만 기록한다.

### 4.6 가격 구조 — 5가지 공개 상태

Tri-B 기본정보 표의 가격 관련 라벨과 상태:

| 상태 | `published_price_state` | 판매가 | 정가(소비자가) | 예 |
|---|---|---|---|---|
| 정상 판매 | `numeric_price` | 숫자 | 있거나 없음 | 78,000원 / 1,290,000원 |
| 할인 | `numeric_price` | 숫자 | 숫자 | Q M20: 정가 1,840,000 → 판매가 1,290,000 (30%) |
| 가격 문의 | `inquiry_price` | **빈 값** | 빈 값 | "가격 문의" / "가격문의" / "전화 문의" |
| 판매 완료 | `sold_out_sale_completed` | **빈 값** | `소비자가` 숫자 | Nash PB-52: `data-price="3990000.00^판매 완료"`, `product_price='0'`, 소비자가 3,990,000원 |
| 판매 불료 | `not_for_sale` | **빈 값** | 빈 값 | "판매 불료" |

- **정가 파싱 규칙**: `data-price="정가^판매가"`. `0.00^` 이면 정가 미설정 → `retail_list_price` 는 빈 값(0 을 그대로 넣으면 "0원 정가" 로 오독된다).
- **`_iPrdtPriceOrg`(70,909)는 공급가가 아니다.** 판매가 78,000원에서 VAT 10%(7,091)를 차감한 **구성액**이다. `dealer_price` 로 해석하면 안 된다.
- **공급가/대리점 가격은 두 사이트 모두 공개되지 않는다.** → `dealer_price_unverified` 는 항상 빈 값.

**공개율 실측**

| | Tri-A | Tri-B |
|---|---|---|
| 목록에서 판매가 공개 | **0/2,281 (0.0%)** | **2,120/2,294 (92.4%)** |
| 목록에서 정가 공개 | 0 | 568/2,294 (24.8%) |
| 상세 표에서 소비자가 공개 | 0 | 174건은 판매가 미공개, 그중 상당수가 딜러 셀렉트 계열 |
| 가격 미공개 상품의 분포 | — | Michael Tuttle 딜러셀렉트 39 · Nash Guitars 딜러셀렉트 37 · Nash Basses 13 · Roscoe Basses 커스텀 6 (커스텀/딜러 오더 라인) |

> **결론 F**: **Tri-A 는 공급가·판매가를 공개하지 않는다.** 따라서 Tri-A 로 스마트스토어 판매가를 채우는 것은 **불가능**하다. Tri-B 판매가를 쓰거나, 공급자 계정/ERP 를 통해 가격을 받아와야 한다. 추정은 금지이므로 이 공백을 그대로 남긴다.

### 4.7 중복(duplicate) 3종

**(1) 사이트 내 동일 상품 다중 product_no** — 색상/구성 변형이 별도 상품으로 등록됨.

- Tri-A 8그룹: `SQ5+`(3836/219) · `SQ6+`(3835/218) · `SQ7+`(3833/217) · `SLXD4D+`(3738/1063) · `SLXD4+`(3737/1062) · `SLXD2+` · `SLXD1+` · `J44D IMP NUDE`(2149/2142)
- Tri-B 8그룹: `[Michael Tuttle Guitars] Custom Classic S` 15개 · `[Gray London Guitars] 커스텀 계약금 결제창` 3개 · `Nashguitars S-63` 2개 · `Nashguitars T-63` 2개 · `[MESA BOOGIE] Mark V 35 Head` 2개 · `Nashguitars S-57` 2개 · `Nashguitars JB-5` 2개

**(2) 카테고리 중복 배치(멀티 카테고리 등록)** — 한 상품이 여러 카테고리에 동시에 속함.

| 소속 카테고리 수 | Tri-A | Tri-B |
|---|---|---|
| 1 | 2 (0.1%) | 37 (1.6%) |
| 2~3 | 0 | 443 (19.3%) |
| 4~8 | 1,215 (53.3%) | 1,376 (60.0%) |
| 9 이상 | 1,064 (46.6%) | 438 (19.1%) |

> Tri-A 는 사실상 **브랜드 카테고리 + 제품유형 카테고리 2축 동시 소속** 구조(9~10개가 최다값)이며, Tri-B 는 브랜드 1개 + 유형 1~2개 구조다. **통합 마스터는 1:N 카테고리를 별도 테이블로 분리**해야 한다.

**(3) 사이트 간 동일 상품** — 두 사이트가 같은 공급 브랜드를 취급.

| 지표 | 값 |
|---|---|
| 정규화 상품명 완전일치 그룹 | **28** (samasound 고유명 2,273 중 1.2%) |
| 공유 모델 토큰 | **202** |
| 토큰 기준 교차 후보 상품쌍 | **513** |

완전일치 28그룹 예: `Antares Aspire`(SS 1697 / SM 3238) · `Antares Auto-key` · `Antares Choir` · `Antares Duo` · `Antares Harmony Engine` · `Antares Mic Mod EFX` · `Antares Mutator` · `Antares Punch` · `Antares Sybil` · `Antares Throat` · `Antares Warm` · `COMPLY NEW! SmartCore 버라이어티팩 (3 pair)`(SS 1975 / SM 3651) · `GENELEC 8010A (블랙)`(SS 3110 / SM 4688) · `GENELEC 8020D (블랙)`(SS 3111 / SM 4687) · `GENELEC 8030C (블랙)`(SS 3112 / SM 4686) …

> **결론 G**: 두 사이트 상품은 **동일 공급 라인 기준 중복이 확인된다.** 통합 마스터에는 `master_product_key`(브랜드+모델코드 정규화) 를 두고 `source_product_id` 를 속성으로 낮춰야 **중복 상품이 이중 등록되지 않는다.** 단, **매칭은 근거가 확인된 것만** 연결한다(위 28+513건은 전수 확인).

### 4.8 단종 / 판매중지 판정 가능성

| 근거 | Tri-A | Tri-B |
|---|---|---|
| `is_soldout_icon` | 2/26 (7.7%) — `XXCR`, `NDM` | 25/80 (31.3%) |
| 기본정보 `판매가` = "판매 완료" | 없음 | 4/80 (5%) (`Michael Tuttle Custom Classic S`, `Nashguitars JB-63`, `Nashguitars JB-5`, `Nashguitars S-63`) |
| 기본정보 `판매가` = "판매 불료" | 없음 | 4/80 (5%) (`PreSonus AIR12`, `PreSonus CDL 18s`, …) |
| `single_option_stock_data.use_soldout` | 전건 `F` (재고 미관리) | 17/26 `T` |
| `aSoldoutDisplay` | 없음 | 있음 (연결 추가상품 품절) |
| 페이지 내 문자열 "단종" | 0/80 | **1/80** (`html_has_discontinued_word`) |

> **결론 H**: 두 사이트 모두 **"단종"이라는 명시적 단종 플래그는 노출하지 않는다.** 판정 가능한 건 **판매 중지 상태**(판매 완료 / 판매 불료 / 품절 아이콘 / 품절 옵션) 뿐이다.
> 따라서 마스터에는 `sales_status` ∈ {`on_sale`, `sold_out`, `not_for_sale`, `price_inquiry`, `unknown`} 와 **`discontinued` 는 항상 `unknown`** 으로 두고, 공급자 확인으로만 확정한다. 추정 금지 원칙에 어긋난다.

### 4.9 기본정보 라벨 세트 (템플릿 드리프트)

Tri-B 상세 214건 캐시에서 관측된 라벨 빈도:

```
상품명 214 · 판매가 214 · 원산지 214 · 구매방법 214 · 배송주기 214
상품요약정보 188 · 브랜드 107 · 배송비 107 · 수량 107 · 상품선택 107
상품간략설명 103 · 모델명 78 · 상품구성품 34 · 영수증/현금영수증번호 32
부가세/비과세 24 · 전자현금영수증번호 18 · 길이선택 17(+'길이 선택' 5)
소비자가 · 최저판매가 · 해외배송 · 주파수별 · 종류 … (드묾)
```

> **결론 I**: 라벨 집합이 상품마다 다르므로, `specs` 는 **고정 컬럼이 아니라 free-form key/value map** 로 보존해야 하고, 자주 쓰는 소수 키만 승격 컬럼으로 둔다.

---

## 5. 검증 표 — 원본 URL 20건

원본 페이지 HTML 파서 결과와 **브라우저 렌더 결과를 대조**한 20건이다. 전체 행은 `reports/samples/product_master_sample.csv`.

### 5.1 Tri-A 삼아사운드 (10건)

| # | ID | 상품명 | 브랜드 | 카테고리 경로 | 가격 공개 | 옵션 | 품절 | 원본 URL |
|---|---|---|---|---|---|---|---|---|
| 1 | 3887 | V Collection 11 PRO EDU(학생/교직원용) | ARTURIA | 제품분류별보기 > 레코딩&악기 > 소프트웨어/플러그인 | 가격 문의 | 0 | – | https://samasound.co.kr/product/v-collection-11-pro-edu학생교직원용/3887/ |
| 2 | 3875 | WL185MB/C-TQG | Shure | 제품분류별보기 > 마이크 > 무선마이크 | 가격 문의 | 0 | – | https://samasound.co.kr/product/wl185mbc-tqg/3875/ |
| 3 | 3569 | XXCR | Neutrik | 제품분류별보기 > 프로오디오 > 커넥터&케이블 | 가격 문의 | 0 | **soldout_icon** | https://samasound.co.kr/product/xxcr/3569/ |
| 4 | 3737 | SLXD4+ | Shure | 제품분류별보기 > 마이크 > 무선마이크 | 가격 문의 | 0 | – | https://samasound.co.kr/product/slxd4/3737/ |
| 5 | 3112 | GENELEC 8030C 제네릭 스튜디오 모니터 스피커 (블랙) | Genelec | 제품분류별보기 > 스피커&퍼스널리스닝 > 스튜디오 모니터 스피커 | 가격 문의 | 0 | – | https://samasound.co.kr/product/genelec-8030c-제네릭-스튜디오-모니터-스피커-블랙/3112/ |
| 6 | 1697 | Antares Aspire 안타레스 아스파이어 숨소리 컨트롤 플러그인 | Antares | 제품분류별보기 > 레코딩&악기 > 소프트웨어/플러그인 | 가격 문의 | 0 | – | https://samasound.co.kr/product/antares-aspire-안타레스-아스파이어-숨소리-컨트롤-플러그인/1697/ |
| 7 | 2486 | PB-55 베이스 기타 (커스텀 오더) | NASH GUITARS | 제품분류별보기 > 레코딩&악기 > 악기/앰프 | 가격 문의 | 0 | – | https://samasound.co.kr/product/pb-55-베이스-기타-커스텀-오더/2486/ |
| 8 | 2745 | JACK-JACK CABLE 1.5m | QED | 제품분류별보기 > 스피커&퍼스널리스닝 > Hi-Fi | 가격 문의 | 0 | – | https://samasound.co.kr/product/jack-jack-cable-15m/2745/ |
| 9 | 3863 | MVX2U G2 | Shure | 제품분류별보기 > 레코딩&악기 > 인터페이스 | 가격 문의 | 0 | – | https://samasound.co.kr/product/mvx2u-g2/3863/ |
| 10 | 215 | CDM32 | 자체제작 | 제품분류별보기 > 프로오디오 > 믹서 | 가격 문의 | 0 | – | https://samasound.co.kr/product/cdm32/215/ |

> Tri-A 의 `source_category_name` 은 리프 카테고리명(예: 3875 → `무선 바디팩용 마이크`, 3737 → `SLX-D 시리즈`, 3569 → `액세서리`, 3112 → `액티브 스피커`, 2745 → `Hi-Fi 케이블`, 3863 → `USB 인터페이스`, 215 → `디지털 믹서`)이며, `source_category_path` 는 브레드크럼 원문이다.

### 5.2 Tri-B 삼아스토어 (10건)

| # | ID | 상품명 | 브랜드 | 모델명 | 판매가 | 정가 | 옵션 | 원본 URL |
|---|---|---|---|---|---|---|---|---|
| 11 | 2454 | SHURE PGA48 슈어 보컬용 유선 마이크 | SHURE | PGA48-LC | 78,000원 | – | 추가구성 4 | https://samastore.co.kr/product/shure-pga48-슈어-보컬용-유선-마이크/2454/ |
| 12 | 974 | PreSonus Eris 3.5 GEN2 프리소너스 에리스 2세대 모니터 스피커 (1조2통) | PRESONUS | Eris 3.5 GEN2 | 219,000원 | – | 추가구성 3 | https://samastore.co.kr/product/presonus-eris-35-gen2-프리소너스-에리스-2세대-모니터-스피커-1조2통/974/ |
| 13 | 5275 | [KLOTZ] OW15Y OmniWIRE 스튜디오 멀티코어 AES/EBU 케이블 2채널 100m | Klotz | OW15Y02.100 | 852,000원 | – | 0 | https://samastore.co.kr/product/klotz-ow15y-omniwire-스튜디오-멀티코어-aesebu-케이블-2채널-100m/5275/ |
| 14 | 2228 | NEUTRIK NC3FXX-EMC / 뉴트릭 XLR (암) 커넥터 EMC | NEUTRIK | NC3FXX-EMC | 22,000원 | 27,500원 | 0 | https://samastore.co.kr/product/neutrik-nc3fxx-emc-뉴트릭-xlr-암-커넥터-emc/2228/ |
| 15 | 3874 | Michael Tuttle Guitars Custom Classic S (딜러 셀렉트 모델) | Michael Tuttle Guitars | – | **판매 완료** | – | 0 | https://samastore.co.kr/product/michael-tuttle-guitars-custom-classic-s-893-마이클-터틀-일렉-기타-딜러-셀렉트-모델/3874/ |
| 16 | 2090 | GENELEC 8000-403 제네릭 플로어 스탠드(컴팩트) + 플레이트 | Genelec | 8000-403 (26000-329-55) | 148,000원 | – | 1 | https://samastore.co.kr/product/genelec-8000-403-제네릭-플로어-스탠드컴팩트-플레이트/2090/ |
| 17 | 4558 | Q Acoustics Q M20 큐어쿠스틱스 Hi-Res 블루투스 무선 스피커 (Pair) | Q Acoustics | M20 | 1,290,000원 | **1,840,000원 (30% 할인)** | 1 | https://samastore.co.kr/product/q-acoustics-q-m20-큐어쿠스틱-hi-res-블루투스-무선-스피커-pair/4558/ |
| 18 | 4686 | GENELEC 8030C 제네릭 스튜디오 모니터 스피커 (블랙) | Genelec | 8030CM | 1,190,000원 | – | 1 | https://samastore.co.kr/product/genelec-8030c-제네릭-스튜디오-모니터-스피커-블랙/4686/ |
| 19 | 3238 | Antares Aspire 안타레스 아스파이어 숨소리 컨트롤 플러그인 | Antares | Aspire | 85,000원 | 95,000원 | 0 | https://samastore.co.kr/product/antares-aspire-안타레스-아스파이어-숨소리-컨트롤-플러그인/3238/ |
| 20 | 664 | RADIAL J48 레디알 액티브 다이렉트 박스 | RADIAL | – | 471,000원 | 523,000원 | 2 | https://samastore.co.kr/product/radial-j48-레디알-액티브-다이렉트-박스/664/ |

> Tri-B 의 `source_category_name/path` 는 §3.3 의 한계대로 **리프 이름만**(예: 2454 → `레코딩`, 5275 → `케이블커넥터`, 2228 → `neutrik-커넥터액세서리`, 3874 → `악기앰프`, 2090/4558 → `스피커`, 664 → `다이렉트-박스`)이 채워진다.

### 5.3 브라우저 교차 확인한 3건 (실측 로그)

| 대상 | 브라우저 확인 항목 | 결과 |
|---|---|---|
| Tri-B 2454 | 기본정보 표 7행, `#span_product_price_text` = `78,000원`, `<link rel=canonical>` = `https://samastore.co.kr/product/shure-pga48-…/2454/`, 옵션 `<select>` 4개 | 파서 출력과 **전 항목 일치** (옵션 추가금액·[품절] 포함) |
| Tri-A 3887 | 기본정보 표 5행(제조사 ARTURIA / 원산지 유럽 프랑스 / 판매가 "가격 문의"), 브레드크럼 4단계, `img.BigImage` | 파서 출력과 **전 항목 일치** |
| Tri-B 4558 | 기본정보(판매가 1,290,000원 / 소비자가 1,840,000원), `data-price="1840000.00^1290000"`, 할인율 30%, canonical | 파서 출력과 **전 항목 일치** |

> **결론 J**: 파서 출력은 브라우저 렌더와 **일치**한다. 단, canonical URL 은 `<link rel="canonical">` 을 우선해야 한다 (`link_product_detail` 은 `/display/1/` 이 붙고 호스트도 www 다).

---

## 6. 요청기 vs 브라우저 비교

| 항목 | 요청기(requests + HTML 파싱) | 브라우저(Playwright/Chrome DevTools) | 판정 |
|---|---|---|---|
| 기본정보 표 (상품명/판매가/브랜드/모델명/원산지/배송비/소비자가) | **가능** | 가능 | 요청기 우선 (10~100배 빠름) |
| canonical URL | **가능** (`<link rel=canonical>`) | 가능 | 요청기 |
| 대표이미지/추가이미지 | **가능** (`img.BigImage`, `data-src`) | 가능 | 요청기 |
| **옵션 추가금액 / [품절] 표기** | **가능** (`add_option_data` JSON) | 가능(JS 렌더) | **요청기로 동일 결과** |
| 옵션 추가구성상품 목록 | **가능** (`<li class="product">` + `add_option_data`) | 가능 | 요청기 |
| 판매가/정가 | **가능** (`data-price`, `var product_price`) | 가능 | 요청기 |
| 재고 숫자 | **가능** (`stock_number`) | 가능 | 요청기, 단 `use_stock=false` 면 미관리 |
| **Tri-B 카테고리 계층(상품→카테고리)** | 목록 크롤로 가능, 상세 페이지엔 **브레드크럼이 없음** | 동일 | 목록 크롤 필요 |
| **Tri-B 검색/필터 AJAX** | 서버 렌더 안 됨 → Playwright 필요 | 가능 | 브라우저 필요 |
| Dalue 검색 위젯 결과 | AJAX 의존 | 가능 | 브라우저 필요 |
| 로그인/장바구니/주문 | — | — | **둘 다 수행하지 않음** |

> **결론 K**: **검증 대상 20건 전부는 요청기 파싱만으로 브라우저와 동일 결과를 얻었다.** 브라우저는 (a) AJAX 렌더 위젯, (b) 최종 육안 확인 용도로만 필요하다. 수집 파이프라인은 requests 기반으로 충분하며, 브라우저를 기본 경로로 쓰면 비용만 늘어난다.

---

## 7. 통합 상품 마스터 CSV 스키마

정규 정의 파일: `skills/cgi-catalog-collector/schema/product-master.schema.json`
샘플: `reports/samples/product_master_sample.csv` (20행, UTF-8 BOM)

### 7.1 컬럼 정의 (40 컬럼)

| 컬럼 | 정의 | Tri-A 채움 | Tri-B 채움 | 네이버 스마트스토어 | 이카운트 ERP |
|---|---|---|---|---|---|
| `source_site` | 원천 키 (`samasound`/`samamusic`) | 100% | 100% | – | 원천키 |
| `source_site_label` | 서비스 표시명 | 100% | 100% | – | – |
| `source_category_id` | 원천 카테고리 ID | 100% | 100% | – | 분류코드 |
| `source_category_name` | 원천 카테고리명 | 100% | 100% | 카테고리 매핑 원본 | 분류코드 |
| `source_category_path` | ` > ` 경로 | 100% | 목록 조인 | 카테고리 매핑 원본 | 분류코드 |
| `source_brand` | 브랜드 원문 | 100% | 100% | 제조사/브랜드 | 품목분류 |
| `source_product_id` | 원천 product_no | 100% | 100% | – | **원천키** |
| `source_item_code` | Café24 item_code | 100% | 84.6% | 옵션코드 후보 | **옵션코드 후보** |
| `product_name` | 상품명 원문 | 100% | 100% | **상품명** | 품목명 |
| `model` | 모델번호 | 0%(필드없음) | 72.5% | **자재/모델** | **자재코드 후보** |
| `canonical_url` | 정규 URL | 100% | 100% | 상품URL | – |
| `source_list_url` | 목록 근거 URL | 100% | 100% | – | – |
| `summary` | 상품요약정보 | 96.2% | 69.2% | **상세설명** | – |
| `short_description` | 상품간략설명 | 65.4% | 46.2% | 상세설명 보조 | – |
| `manufacturer` | 제조사 | 100% | 0% | 제조사 | – |
| `country_of_origin` | 원산지 | 100% | 100% | 원산지 | – |
| `specs` | 기본정보 전체 JSON | 100% | 100% | **상세스펙** | 속성 |
| `image_urls` | `\|` 구분 원본 이미지 | 100% | 100% | **대표/추가이미지** | – |
| `option_summary` | 옵션 JSON (main/addproduct_options/addproducts/add_option_data) | 100% | 100% | **옵션명/값/추가금액** | 옵션 속성 |
| `option_count` | 옵션 개수 | 0 | 10/26 | – | – |
| `published_price` | 공개 판매가(원) | **0%** | 84.6% | **판매가** | 판매단가 |
| `published_price_text` | 판매가 원문 | 100% | 100% | – | – |
| `published_price_state` | `numeric_price`/`inquiry_price`/`sold_out_sale_completed`/`not_for_sale`/`empty`/`other` | 100% | 100% | – | – |
| `published_price_unavailable` | 1=미공개 | 100% | 100% | – | – |
| `retail_list_price` | 정가(소비자가) | 0% | 24.8% | **할인가** | – |
| `consumer_price` | 기본정보 `소비자가` | 0% | 일부 | – | – |
| `min_selling_price` | `최저판매가` | – | 드묾 | 최저가 | – |
| `tax_excluded_component` | VAT 차감 구성액(≠공급가) | 100% | 100% | – | 참고(오해금지) |
| `dealer_price_unverified` | **공급가/대리점가** | **항상 빈 값** | **항상 빈 값** | (원가/할인가) | **매입가** |
| `availability_unverified` | `{stock_number_displayed, use_stock, use_soldout, is_reserve_stat}` JSON | 100% | 100% | 옵션 재고 | 재고 |
| `stock_display` | 공개된 재고 문자열 | 100% | 84.6% | – | – |
| `soldout_display` | 품절 표기 | 7.7% | 11.5% | 판매상태 | – |
| `product_code` | Café24 product_code | 100% | 84.6% | – | **상품코드 후보키** |
| `product_status_flags` | `use_stock=false` 등 상태 플래그 | 100% | 100% | – | – |
| `updated_at` | 수집 기준시각(원천 갱신시각 아님) | 100% | 100% | – | – |
| `extraction_method` | `http_get_public_html` / `…+list_crawl_join` | 100% | 100% | – | – |
| `verification_status` | `verified_against_source_page` / `browser_cross_checked` / `list_only_unverified_detail` | 100% | 100% | – | – |
| `source_evidence` | 검증 근거 URL | 100% | 100% | – | – |
| `list_observed_price` | 목록에서 관측한 판매가 | – | 92.4% | – | – |
| `list_page_url` | 목록 근거 URL | 100% | 100% | – | – |

### 7.2 부속 테이블 (1:N 분리 권장)

| 테이블 | 키 | 내용 | 근거 |
|---|---|---|---|
| `product_master` | `(source_site, source_product_id)` | 위 37 컬럼 | 1행=1상품 |
| `product_category_map` | `(source_site, source_product_id, category_id)` | 상품↔카테고리 다중 매핑 | Tri-A 평균 8~10개, Tri-B 1~3개 |
| `product_option` | `(source_site, product_id, option_seq)` | 옵션명/값/추가금액/품절/재고 | `add_option_data` |
| `product_image` | `(source_site, product_id, seq, role)` | 이미지 URL + 역할(main/extra/thumb) | `/web/product/{size}/…` |
| `product_site_link` | `master_product_key, source_site, source_product_id` | **사이트 간 동일상품 후보 연결** | 28 완전일치 + 513 토큰 후보 |
| `brand_master` | `brand_normalized` | 원문 표기 → 정규 브랜드코드 | 대소문자/공백 혼재 |

### 7.3 추정 금지 규칙 (스키마에 강제)

1. `published_price` 이 비어 있는데 `published_price_state` 가 `numeric_price` 면 **오류**. `published_price_state != numeric_price` 이면 `published_price` 는 반드시 빈 값.
2. `dealer_price_unverified` 는 **모든 행에서 빈 값**. Tri-A·Tri-B 어디에도 공개 공급가가 없다. 채워 넣으면 "공급가 공개" 라는 잘못된 사실이 된다.
3. `availability_unverified.use_stock == false` 이면 `stock_display` 의 `0` 은 "재고 0" 이 아니라 **"재고 미관리"** 다. `stock_display` 는 원문 문자열을 그대로 두고 해석은 `availability_unverified` 에서 한다.
4. `model` 은 `explicit`(Tri-B 모델명 행) 과 `from_name`(Tri-A 상품명 규칙 추출) 을 구분해 기록. 규칙으로 확정되지 않으면 **빈 값**.
5. `discontinued` 는 두 사이트 모두 **공개 근거 없음** → `unknown` 고정. `판매 완료`/`판매 불료`/`품절` 은 각각 `sales_status` 값으로만 기록하고 "단종" 으로 승격하지 않는다.
6. `updated_at` 은 **수집시각**이며 원천 갱신시각이 아니다. `source_lastmod`(sitemap lastmod) 처럼 별도 컬럼이 필요하면 추가하되, sitemap 이 없거나 불완전한 Tri-B 는 비워 둔다.
7. `verification_status` 가 `list_only_unverified_detail` 인 행은 상세 미검증임을 명시하고, 상세 반영 후 `verified_against_source_page` 로 승격한다.

### 7.4 원천에서 곧바로 못 채우는 값 (계정 필요)

| 필드 | 상태 | 필요 조건 |
|---|---|---|
| `dealer_price_unverified` (공급가/매입가) | **미확인** | 공급 계약서 / ERP 전표 / 계정 |
| 실재고 (옵션별) | **미확인** | ERP 재고 모듈 / ERP 계정 |
| 최소주문수량 · 구매제한수량 | **미확인** | 계정/계약 |
| KC인증·전기용품인증 | **미확인** | 계정/문서 |
| 출고지·출고일·AS | **미확인** | ERP |
| 삼아사운드(Tri-A) **판매가** | **공개 불가** | Tri-B 가격 또는 공급자 계정 |

---

## 8. 재사용 가능한 수집 스킬 경로

### 8.1 제안 경로

```
skills/cgi-catalog-collector/
├── SKILL.md                                   # 스킬 정의 (트리거·경로·규칙·검증 절차)
├── schema/
│   └── product-master.schema.json             # 컬럼 정의 + 미확인 규칙 + 매핑 가이드
└── scripts/
    └── collect_cgi_catalog.py                 # 수집기 (list/detail/sitemap/category/categories)
```

**경로 선정 근거**
- 저장소가 비어 있어 기존 관례가 없다. `skills/` 라는 **에이전트 비종속 경로**를 쓰고, Claude Code 를 쓸 경우 `.claude/skills/cgi-catalog-collector/` 로 **복사/심볼릭 링크**만 하면 동일 스킬로 로드된다(설정 파일 수정 불필요).
- `scripts/` 는 `skills/` 하위에 두어 스킬과 1:1로 이동 가능하게 했다.
- 네트워크 산출물(캐시·대규모 CSV)은 `.gitignore` 대상(`.cache/`, `out/`)으로 두고, 저장소에는 **보고서 + 샘플 + 스키마 + 스크립트**만 커밋한다.

### 8.2 스킬이 이미 검증한 것 / 아직 하지 않은 것

**검증 완료**
- 두 사이트의 정규 URL 규칙, 카테고리 ID 발견 절차, 옵션/가격/재고 파서, 20건 브라우저 교차 대조
- 요청기만으로 브라우저 동일 결과 도출(옵션 추가금액·품절 포함)

**미수행(증거 부족이라 하지 않은 것)**
- 전체 4,575건 상세 페이지 수집 (목록/카테고리 전수는 완료, 상세는 샘플만)
- Tri-B 검색 AJAX 수집
- 두 사이트 상품 간 **전수** 중복 매칭 (28 완전일치 + 513 토큰 후보까지는 산출)

### 8.3 실행 순서 (권장)

```bash
# 0) Tri-A 카테고리 ID 스위프 (1회, 캐시 가능)
python skills/cgi-catalog-collector/scripts/collect_cgi_catalog.py \
  --site samasound --mode categories --ids 23,24,25,42,43,...,432 --out out/ss_cats.csv

# 1) Tri-A 전체 상품 목록
python skills/cgi-catalog-collector/scripts/collect_cgi_catalog.py \
  --site samasound --mode list --cate-no 23 --out out/ss_products.csv

# 2) Tri-B 사이트맵(보정용) + 카테고리 크롤(기준)
python skills/cgi-catalog-collector/scripts/collect_cgi_catalog.py \
  --site samamusic --mode sitemap --out out/sm_sitemap.csv

# 3) 상세 (샘플 → 필요시 전량, 캐시로 재실행 시 네트워크 0)
python skills/cgi-catalog-collector/scripts/collect_cgi_catalog.py \
  --site samamusic --mode detail --ids-file ids.txt --out out/sm_details.csv
```

### 8.4 확장 계획 (각주, 미착수)

1. `brand_master` 생성: 원문 브랜드 표기 100여 종 → 정규 코드. 원천 카테고리명(59/144)과의 대응표가 시작점.
2. `master_product_key` 정의: `brand_normalized + 정규화된 모델코드` 기준. **근거 있는 매칭만 연결**하고, 애매하면 `candidate` 로 두고 사람이 확정.
3. 카테고리 매핑 계층: Tri-A 8 유형 루트 + Tri-B 11 유형 루트 → 스마트스토어 10단계 카테고리 후보 매핑표. **1:1 대응이 아니므로 계층 보존형 매핑**이 필요하다.
4. 재실행 안정화: `updated_at` 비교 대신 `product_code`/`item_code` + 대표이미지 해시로 변경 감지.

---

## 9. 한계 · 미확정 항목

| 항목 | 상태 |
|---|---|
| Tri-A 전체 상품의 상세 필드(모델·옵션·가격) | 2,281건 전수 미수행. **목록·카테고리 구조는 실측 완료** |
| Tri-B 전체 상품의 상세 필드 | 2,294건 전수 미수행. **목록·카테고리 구조는 실측 완료** |
| Tri-B 상품→카테고리 리프 매핑 | 532 카테고리 크롤로 **완료** |
| **Tri-B 전체 카테고리 계층(부모-자식 트리)** | **미확정.** 목록 페이지 하위 링크가 전 페이지 공통 스니펫이어서 부모 관계를 신뢰성 있게 복원할 수 없다(§3.3). 공개 확인은 최상위 11 루트 + 브랜드 144 + 리프 이름 532까지 |
| Tri-A 5단계 이상 카테고리 경로 | 브레드크럼이 4단계에서 잘림. **미확정** |
| 공급가 / 대리점가 | **공개 없음. 미확인. 추정하지 않음** |
| 실재고 | **공개 없음(표시값만). 미확인** |
| 단종 여부 | **공개 근거 없음. 미확인** |
| Tri-B sitemap 이 1,597건뿐인 이유 | **미확인**(사이트맵 생성 정책/주기). 단, "최신 전체 아님"은 실측 확인 |
| Tri-A 2,229 vs 2,281 차이 52건 | 카테고리 숨김/전체보기 제외 추정. **Cafe24 관리 설정 접근 없이 확정 불가** |
| 양사 상품의 상품코드(`P0000DQK` 등) 규칙 | `P` + 7자리 로 관찰. **기반 규칙은 미확인**(시퀀스/파생 규칙) |
| Tri-A 의 `model` 필드 | **필드 자체가 없음.** 상품명 규칙 추출은 별도 파이프라인 필요(60.5% 대상). 미확정분은 빈 값 유지 |
| CGI 취급 제품 범위 | **김범신 대표 확인 필요** (이슈 명시 사항) |
| 두 사이트의 상호 간 관계(에이전시/직영/자사몰 여부) | **공개 정보로 확정 불가** |

---

## 10. 재현 방법

```bash
git clone https://github.com/skerishKang/kbs261022.git
cd kbs261022
python skills/cgi-catalog-collector/scripts/collect_cgi_catalog.py --help

# 샘플 재생성 (보고서에 실린 20건)
#   → skills/cgi-catalog-collector/scripts/collect_cgi_catalog.py --mode detail --ids-file ...
```

산출물:
- `reports/site-analysis-model-b.md` (본 문서)
- `reports/samples/product_master_sample.csv` (검증 20건)
- `reports/samples/category_catalog_sample.csv` (카테고리 계층 샘플 57건)
- `skills/cgi-catalog-collector/SKILL.md`
- `skills/cgi-catalog-collector/schema/product-master.schema.json`
- `skills/cgi-catalog-collector/scripts/collect_cgi_catalog.py`

**금지 항목 준수 확인**: 가격·공급가·재고 추정 0건 · 네이버/ERP 조작 0건 · Google Drive 업로드 0건 · 제3자 계정 접근 0건 · 전체 사이트 무제한 요청 0건(카테고리/상품 단위 유한 순회).
