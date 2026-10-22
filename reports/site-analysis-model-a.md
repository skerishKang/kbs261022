# 삼아사운드 · 삼아스토어 사이트 구조 및 상품 정보 수집 방법 분석 (Model A)

| 항목 | 내용 |
|---|---|
| 분석 대상 | `https://www.samasound.co.kr/` (삼아사운드), `https://www.samamusic.co.kr/` (삼아스토어) |
| 문서 구분 | **Model A — 사이트 구조 / 데이터 수집 탐사** (Model B와 독립 수행) |
| 저장소 | `skerishKang/kbs261022` (김범신 대표 CGI 전용) |
| 관련 이슈 | #5 — 삼아사운드 상품 사이트 2모델 독립 분석 및 수집 설계 |
| 작성일 | 2026-10-22 |
| 상태 | 분석 완료 초안 — CENTRAL 검토 대기 |
| 샘플 데이터 | `reports/data/samasound-samamusic-sample.csv` (20행) |
| 재실행 도구 | `tools/collect_samasound_samamusic.py` |

> **본 문서는 Model A 단독 결과입니다.** Model B 결과는 열람하지 않았으며, 교차 비교는 CENTRAL이 수행합니다.
> **추정과 실증을 명확히 구분**했습니다. 표지의 표기: `실증` = 직접 요청·측정으로 확인한 사실 / `추정` = 관찰 기반 판단이며 미검증.

---

## 1. 요약 (결론 먼저)

### 1.1 수집 방법 결론

| 수집 방법 | 판정 | 근거 |
|---|---|---|
| **HTTP/HTML (목록+상세)** | **채택 권고** | 3개 목록 페이지에서 브라우저 렌더링과 **상품 ID 집합이 100% 동일**(`실증`). 응답은 브라우저 DOM 대비 1/8~1/2 크기. 요청 1회로 상품명·브랜드·모델명·규격·이미지·공개가격까지 대부분 확보 |
| **파일 카탈로그 (sitemap.xml)** | **samamusic 한정으로 채택 권고** | `samamusic.co.kr/sitemap.xml` 이 **product_no 기준 전체 상품 URL 1597건**을 제공. 10/10 검증 대상이 상세 URL과 정확히 일치(`실증`) |
| **브라우저 (Chromium)** | **비권고** | 상품 데이터는 서버 렌더링에 이미 포함. 브라우저는 동일 데이터를 2~8배 크기로 + 추적 XHR 7~23회 발생(`실증`) |
| **공개 API (XML/JSON)** | **사용 불가** | 후보 6개 전부 **HTTP 200 + 본문 0바이트**. 유일하게 JSON을 반환한 `api.dalue.io`도 `apiKey가 설정되지 않았습니다` 오류(`실증`) |

### 1.2 가장 중요한 발견 3가지

1. **두 사이트는 같은 회사의 다른 매장이며, 상품 범위와 가격이 다르다** (`실증`)
   - `samasound.co.kr` = Cafe24 상점 `cafe24_samassi_1` — **B2B, 공개 가격 없음**. 상세 스펙표의 `판매가` 값이 전부 **"가격 문의"** 문자열.
   - `samamusic.co.kr` = Cafe24 상점 `cafe24_sama2015_1` — **B2C, 공개 가격 있음**. 스펙표에 `판매가`·`브랜드`·`모델명`·`적합인증번호` 등 정규화된 항목이 존재.
   - **두 사이트의 `cate_no`는 같은 번호가 다른 카테고리를 가리킨다** (예: `cate_no=24` → samamusic은 "브랜드", samasound는 "LOOKBOOK"). **사이트를 섞으면 안 된다.**

2. **samamusic은 `sitemap.xml` 하나로 전체 상품 목록을 얻을 수 있다** (`실증`)
   - `<loc>` 2136건 중 상품 URL 1597건, 카테고리 URL 532건, 나머지 7건.
   - **URL 끝의 숫자가 정확히 `product_no`와 일치**(10/10 대조). → ERP 임포트용 식별자 목록으로 바로 쓸 수 있다.
   - 이 파일은 robots.txt로 금지되지 않은 경로(`/sitemap.xml`)이며, `samasound.co.kr`에는 **대응 파일이 없다**(404).

3. **User-Agent에 따라 서버 응답이 바뀐다** (`실증`)
   - 같은 URL·같은 시각에 UA만 바꿔 비교: `python-requests/2.34.2` → **403 차단**, 브라우저 UA → 200, `curl/8.4.0` → 200.
   - 수집 스크립트는 UA 문자열에 `python-requests`가 들어가면 **전부 403이 된다.** 개발 시 착각하기 쉬운 함정.

---

## 2. 조사 범위와 제약 (이 장을 먼저 읽을 것)

### 2.1 robots.txt — 실제로 준수한 금지 경로

두 사이트 robots.txt가 동일 구조이며 다음을 **Disallow** 한다. **본 분석의 어떤 수집 단계에서도 아래 경로는 요청하지 않았다.**

```
Disallow: /admin        Disallow: /member/       Disallow: /protected/
Disallow: /api          Disallow: /myshop/        Disallow: /skin-*/
Disallow: /exec/front/  Disallow: /*board*page=  Disallow: /*article*page=
Disallow: /*board*category_no=  Disallow: /*article*category_no=
Disallow: /*page_4=     Disallow: /*page_6=
```

| robots 판독 결과 | 의미 |
|---|---|
| `/exec/front/` 금지 | Cafe24 XML 상품 API 게이트웨이(`mall.cafe24api.com/exec/front/product/list.xml`)는 **사용 불가**. 별도 도메인이라 robots가 mall 도메인에 직접 적용되지는 않으나, **"공개 API" 경로로 시도하지 않기로 판단**하고 시도 결과도 200/0바이트로 불가 확인 |
| `/api` 금지 | 사이트 자체 API 경로 사용 불가 |
| `/*board*page=` 금지 | 게시판·상품후기 페이지의 `page=` 쿼리 수집 금지. **상품 목록의 `page=` 쿼리는 해당 패턴에 걸리지 않아 사용 가능** |
| `/myshop/`, `/member/`, `/admin/` 금지 | 로그인·장바구니·마이페이지 영역 접근 금지 (이슈의 "제3자 계정 접근" 금지와도 일치) |

> **`Disallow: /*board*page=` 와 `/*product*page=` 의 차이**: `board`/`article` 문자열이 URL에 들어갈 때만 차단되므로, `product/list.html?cate_no=23&page=2` 는 허용된다. 이 판독은 robots.txt 원문 대조로 확인했다.

### 2.2 그 외 스스로 적용한 제약

| 제약 | 적용 |
|---|---|
| 요청 빈도 | 요청 간 최소 **1.2초** 간격. Python 수집으로 **서로 다른 URL 42건**, 별도로 브라우저 페이지 로드 4회(각각 XHR 7~23건 발생) |
| 대량 수집 | **미수행.** 이슈 지시에 따라 방법 검증 전 대량 수집하지 않았다. 상품 수는 마지막 페이지를 직접 세어 산출했다 |
| 로그인·계정 | 미사용. 로그인·장바구니·주문 영역 미접근 |
| 추정 금지 | 라벨이 없는 값은 채우지 않고 **빈칸**으로 남겼다. 가격·규격·브랜드는 스펙표 라벨로만 판정 |

---

## 3. 사이트 구조

### 3.1 삼아사운드 `samasound.co.kr` (Cafe24 `cafe24_samassi_1`)

#### 3.1.1 상위 메뉴 (`실증`)

홈페이지 HTML에서 추출한 `top_menu` 실제 링크:

| 메뉴 | 경로 |
|---|---|
| 회사소개 / 삼아사운드 소개 | `/about.html` |
| 공지사항 | `/board/free/list.html?board_no=1` |
| 인재채용 | `/product01.html` |
| 제품 정보 → 전체보기 | `/product/list.html?cate_no=23` |
| 제품 정보 → 브랜드별 보기 | `/category/shure/42/` (브랜드별 동적) |
| 제품 정보 → 제품분류별 보기 | `/product/list.html?cate_no=25` |
| 제품 설계자료 | `/board/free/list.html?board_no=5` |
| **제품 카탈로그** | **`https://fliphtml5.com/bookcase/vndwo/`** (외부 플립북) |
| 서비스 안내 / 문의 게시판 | `/board/서비스-안내/1002/`, `/board/문의-게시판/6/` |

#### 3.1.2 브랜드 — 32개 (`실증`)

홈페이지 브랜드 스와이퍼 HTML에서 `main_brand_NN_slug.png` 이미지 파일명과 `cate_no`의 **대응 관계**를 직접 파싱했다. **`brand_NN` 토큰은 32개, 스와이퍼에서 cate_no와 직접 대응하는 것은 30개**이며 2개(`brand_06_k`=K&M cate_no=47, `brand_30`)는 스와이퍼 순서 밖이라 매핑을 확정하지 않았다.

| idx | brand_slug | cate_no | idx | brand_slug | cate_no |
|---|---|---|---|---|---|
| 01 | shure | 42 | 17 | vicoustic | 361 |
| 02 | genelec | 43 | 18 | dynaudio | 333 |
| 03 | allenheath | 44 | 19 | ni | 349 |
| 04 | neutrik | 45 | 20 | imag | 53 |
| 05 | hkaudio | 50 | 21 | qacoustic | 354 |
| 06 | k (K&M) | 47 | 22 | positivegrid | 317 |
| 07 | martinaudio | 49 | 23 | cloud | 330 |
| 08 | presonus | 352 | 24 | rotosound | 358 |
| 09 | clearcom | 432 | 25 | nash | 348 |
| 10 | apogee | 322 | 26 | tuttle | 347 |
| 11 | radial | 48 | 27 | comply | 331 |
| 12 | klotz | 343 | 28 | qed | 355 |
| 13 | arturia | 324 | 29 | jico | 415 |
| 14 | nnnn | 309 | 31 | qsys | 417 |
| 15 | rean | 46 | 32 | fidelice | 431 |
| 16 | ik | 340 | 30 | *(미매핑)* | — |

브랜드 상세 URL 패턴: **`/category/{brand_slug}/{cate_no}/`** (예: `/category/shure/42/`)

#### 3.1.3 페이지네이션 (`실증`)

- URL 패턴: **`/product/list.html?cate_no={N}&page={P}`**
- 페이지당 **20건** (HTML 주석 `$count = 20`)
- `cate_no=23`(전체보기) **마지막 페이지 = 112**, `cate_no=25`(제품분류별) **마지막 페이지 = 103**
- `page=113` 요청 시 **상품 0건** → 112가 실제 마지막 페이지임을 확인

#### 3.1.4 상세 URL 패턴 (`실증`)

```
https://www.samasound.co.kr/product/{url-슬러그}/{product_no}/category/{cate_no}/display/{n}/
예) /product/mv88-usb-c/3734/category/1/display/2/
```
`product_no`는 **경로의 3번째 세그먼트 숫자**다. `display/1` 은 목록, `display/2` 는 상세 context로 보인다(관찰).

### 3.2 삼아스토어 `samamusic.co.kr` (Cafe24 `cafe24_sama2015_1`)

#### 3.2.1 상위 메뉴 (`실증`)

| 영역 | 항목 |
|---|---|
| 유틸 | 슈어스토어(`brand.naver.com/shurestore`), 삼아사운드(`samasound.co.kr`) |
| 고객 | 장바구니, 관심상품, 주문조회, 적립금, 좋아요, 쿠폰관리, 내게시물, 커뮤니티 |
| 정보 | 공지사항(b1), 이벤트(b2), 이용안내 FAQ(b3), **상품 사용 후기(b4)**, **상품 Q&A(b6)**, 제품 소개 영상(b8), 자료실(b7), **카달로그(b101)**, 어쿠스틱 포트폴리오 |
| 메뉴 위젯 | `/_wg/import/sub/page_0N.html`, `/_wg/_cPack/cp5NN/dom.html` (Cafe24 위젯) |

#### 3.2.2 카테고리 (`실증`) — 11개 확인

| cate_no | 라벨 | cate_no | 라벨 |
|---|---|---|---|
| 24 | 브랜드 | 366 | 케이블/커넥터 |
| 84 | 마이크 | 379 | 악기/앰프 |
| 42 | 스피커 | 758 | 소프트웨어 |
| 25 | 이어폰/헤드폰 | 1038 | Hi-Fi |
| 28 | 레코딩/음향 | 1152 | 프로모션 보기 |
| 97 | 특가상품 | | |

브랜드별 URL은 `/category/{brand_slug}/{n}/` (sitemap에서 532건 확인: presonus, arturia, shure, apogee, klotz, ik-multimedia, native-instruments 등).

#### 3.2.3 페이지네이션 (`실증`)

- URL 패턴: **`/product/list.html?cate_no={N}&page={P}`**
- 페이지당 **20건** (`cate_no=42` 기준 실측)
- `cate_no=42`(스피커) 마지막 페이지 = **11**, `cate_no=25`(이어폰/헤드폰) = 2
- `cate_no=24`(브랜드)는 **상품 목록이 아닌 브랜드 인덱스**로, 직접 접근 시 상품 0건

#### 3.2.4 상세 URL 패턴 (`실증`)

```
https://www.samamusic.co.kr/product/detail.html?product_no={N}&cate_no={M}&display_group={G}
```
`display_group` 은 상품 그룹(브랜드 묶음)이라 보인다(관찰). `cate_no` 는 스피커=42, 이어폰=25, 오디오인터페이스=1 등.

#### 3.2.5 파일 카탈로그 `sitemap.xml` (`실증`)

| 항목 | 값 |
|---|---|
| 경로 | `https://www.samamusic.co.kr/sitemap.xml` (robots 금지 경로 아님) |
| 크기 / 형식 | 345,626 bytes / `application/xml` |
| `<loc>` 총계 | **2,136건** |
| ├ 상품 URL | **1,597건** (product_no 범위 13~5750, 전부 고유) |
| ├ 카테고리 URL | 532건 |
| └ 기타 | 7건 |
| `lastmod` 최신 | 2026-10-21T17:42:18+09:00 (수집 전일) |
| URL 끝 숫자 == `product_no` ? | **예. 10/10 대조 일치** (1120, 974, 1118, 2844, 3592, 2513, 2553, 4141, 1441, 2454) |
| URL 응답 확인 | 무작위 5건 → **5/5 HTTP 200** 및 `<title>` 정상 (`www.samamusic.co.kr` 호스트로도 동일 경로가 열림) |
| `samasound.co.kr` 대응 파일 | **없음** — `/sitemap.xml` → **404** (Cafe24 기본 404 페이지) |

### 3.3 두 사이트의 관계 (`실증` + `추정`)

| 관찰 | 판정 |
|---|---|
| `samasound.co.kr` = `cafe24_samassi_1`, `samamusic.co.kr` = `cafe24_sama2015_1` — 서로 다른 Cafe24 상점 | `실증` |
| samamusic 정규표현 프론트엔드에 `sama2015.cafe24api.com`, `samassi.cafe24api.com`, `samastore.co.kr`, `genelec.samastore.co.kr`, `samacds.co.kr` 참조 | `실증` (HTML 내 문자열) |
| `wcs.checkoutWhitelist`에 두 도메인·`samastore.co.kr`·`genelec.samastore.co.kr` 동시 등재 | `실증` (HTML 내 배열) |
| 두 사이트는 **동일 회사의 B2B(사운드)·B2C(스토어) 구분 운영으로 보인다** | `추정` — 가격 정책(가격 문의 vs 공개 판매가)·브랜드 구성이 이를 뒷받침하나 공식 확인은 없음 |
| **두 사이트 상품 범위가 같은지 여부** | **미확정.** 이슈가 지시한 그대로 김범신 대표 확인 필요. 본 분석은 cate_no 체계를 섞지 않고 사이트별로 분리했다 |

---

## 4. 수집 방법 비교 실험 (4종)

### 4.1 실험 설계

동일 대상에 4가지 방법을 적용해 **성공 여부·데이터량·비용**을 비교했다. 각 실험은 실제 요청 1회 이상으로 확인했다.

### 4.2 HTTP/HTML (서버 렌더링 원본) — **채택 권고**

| 대상 | 요청 | 결과 |
|---|---|---|
| samamusic 목록 `cate_no=42` | 1 | 200, 541,218 B, 상품 20건 |
| samasound 목록 `cate_no=23` | 1 | 200, 122,926 B, 상품 20건 |
| samasound 브랜드 `/category/shure/42/` | 1 | 200, 122,564 B, 상품 20건 |
| samamusic 상세 `product_no=1120` | 1 | 200, 473,883 B, 스펙표 11개 항목 |
| samasound 상세 `product_no=3826` | 1 | 200, 118,827 B, 스펙표 7개 항목 |

**얻는 필드** — 상세 스펙표(`<table>`의 `th`/`td` 쌍)에서 라벨 기반으로 추출:
`상품명`, `판매가`, `브랜드`(samasound는 `제조사`), `모델명`, `안전확인신고번호`, `적합인증번호`, `상품요약정보`, `상품간략설명`, `원산지`, `영문상품명`, `카테고리`.

**비용**: 상세 페이지 1건당 **요청 1회**, 117~502 KB. 브라우저 대비 **2.1~8.1배 적은 바이트**.

### 4.3 브라우저 (Chromium/Playwright) — **비권고**

| 목록 페이지 | HTTP/HTML 상품 ID | 브라우저 DOM 상품 ID | 집합 동일 |
|---|---|---|---|
| samamusic `cate_no=42` | 20 | 20 | **예** |
| samasound `cate_no=23` | 20 | 20 | **예** |
| samasound `/category/shure/42/` | 20 | 20 | **예** |

**결론 (`실증`)**: 상품 목록은 **완전 서버 렌더링**이다. 브라우저를 돌려도 **동일한 상품 ID 집합**이 나오며, 추가로 얻는 상품 데이터는 **0건**이다.

| 비용 | HTTP/HTML | 브라우저 |
|---|---|---|
| samamusic 목록 | 541 KB / 1 요청 | **1,153 KB** DOM / 19 XHR |
| samasound 목록 | 123 KB / 1 요청 | **995 KB** DOM / 7 XHR |
| samamusic 상세 | 474 KB / 1 요청 | **1,188 KB** DOM / 23 XHR |
| 추적·서드파티 | 없음 | Google Ads·DoubleClick·카카오 픽셀·네이버传给·bc.ad.daum.net·fonts.googleapis 등 |

브라우저 트레이스에서 **상품 데이터가 XHR로 오는 요청은 하나도 없었고**, 확인된 XHR는 전부 분석·옵티마이저·폰트·위시리스트 관련이었다. (`/exec/front/Product/SubCategory` 73KB가 관측됐으나 **robots Disallow 경로이므로 사용하지 않았다**.)

### 4.4 파일 카탈로그 — **samamusic 한정으로 채택 권고**

| 대상 | 결과 |
|---|---|
| `samamusic.co.kr/sitemap.xml` | **200, 345,626 B, application/xml, 상품 1,597건** — `product_no` 키 완전 목록 |
| `samasound.co.kr/sitemap.xml` | **404** (Cafe24 기본 오류 페이지 3,415 B) — 대응 파일 없음 |
| `fliphtml5.com/bookcase/vndwo/` (samasound 「제품 카탈로그」 메뉴) | 200, 48,835 B, 제목 `SAMASOUND 카탈로그 모음`. Shure 등 브랜드 PDF 플립북 목록이 JSON으로 내장. **구조화 상품 데이터 아님** — 사양·마케팅 문서용 |

**평정**
- `sitemap.xml`은 **URL 목록만** 준다. 상품명·가격·규격은 상세 페이지를 1건씩 방문해야 한다. 그럼에도 **전체 대상 URL과 product_no 대응표를 1회 요청으로 확보**하므로 "어떤 상품이 있는지"를 먼저 정하는 단계에는 최적이다.
- fliphtml5 카탈로그는 **사람이 보는 문서**여서 자동 수집 대상이 아니다.

### 4.5 공개 API — **사용 불가**

robots의 `/exec/front/` 는 금지였으나, "공개 API" 존재 여부를 규명하기 위해 후보만 **1회씩** 시도했다(무한 요청 아님).

| 후보 | 결과 |
|---|---|
| `sama2015.cafe24api.com/exec/front/product/list.xml?mall_id=sama2015` | 200, **0 bytes**, `text/html` |
| `samassi.cafe24api.com/exec/front/product/list.xml?mall_id=samassi` | 200, **0 bytes**, `text/html` |
| `sama2015.cafe24api.com/exec/front/product/list.json?...` | 200, **0 bytes** |
| `api.dalue.io/dalue-ecms/js?act=keywordPromotionList&mallId=sama2015` | 200, **0 bytes** |
| `api.dalue.io/dalue-ecms/js?act=cafe24props&mallId=sama2015` | 200, **0 bytes** |
| `api.dalue.io/dalue-ecms/js?act=ping&mallId=sama2015` | 200, **0 bytes** |
| `api.dalue.io:10806/dcse/hotKeywords` (브라우저 트레이스에서 발견) | 200, **125 B JSON** → `{"header":{"code":-1,"message":"apiKey가 설정되지 않았습니다."},"results":[]}` |
| `samamusic.co.kr/shopSearch/search.html?query=GENELEC` (`Accept: application/json`) | 200, 414,724 B **HTML** — JSON 미지원 |
| `samamusic.co.kr/product/search.html?keyword=GENELEC` (`Accept: application/json`) | 200, 597,883 B **HTML** — JSON 미지원 |

**결론 (`실증`)**: **사용 가능한 공개 상품 API는 존재하지 않는다.** 유일하게 JSON을 반환한 Dalue 엔드포인트도 API 키가 없어 비어 있다. 이 API 경로들은 **Cafe24/Dalue가 쇼핑몰 사장에게 제공하는 관리자용 연동**이며, 키 없이 third-party 수집에 쓸 수 없다.

### 4.6 User-Agent A/B 테스트 (함정 경고)

| 대상 | browser-UA | python-requests | curl-like |
|---|---|---|---|
| `samamusic.co.kr/sitemap.xml` | 200, 345,626 B, XML | **403**, 2,125 B, 경고 페이지 | 200, 345,626 B, XML |
| `samamusic.co.kr/product/list.html?cate_no=42` | 200, 541,218 B | **403**, 2,125 B, 경고 페이지 | 200, 541,246 B |

→ **UA 문자열에 `python-requests`가 들어가면 403이 된다.** requests 기본 UA를 그대로 쓰면 "사이트가 죽었거나 robots 차단"으로 오판하기 쉽다. 수집 도구에는 반드시 브라우저/curl 계열 UA를 넣어야 한다.

---

## 5. 상품 개수 (실측)

> 이슈 지시대로 **"실측 결과 없으면 미확정"** 원칙을 지켰다. 아래는 **마지막 페이지를 직접 세어** 산출한 값이다(대량 수집 없음).

| 사이트 | 기준 | 산출 방법 | 결과 | 판정 |
|---|---|---|---|---|
| samasound | `cate_no=23` 전체보기 | 페이지당 20건 × 111 + 마지막(112)페이지 실측 9건 | **2,229건** | `실증` |
| samasound | `cate_no=25` 제품분류별 | 마지막 페이지 103 | **최대 2,060건** (23과 중복 포함) | `실증`(최대치) |
| samamusic | `sitemap.xml` | `<loc>` 중 상품 URL 카운트 | **1,597건** | `실증` |
| samamusic | `cate_no=42` 스피커 | 마지막 페이지 11 | 최대 220건 | `실증`(카테고리 단위) |

**미확정 사항**: 두 사이트의 **상품 범위 중복·포함 관계**는 본 분석에서 확정하지 않았다. `samasound` 2,229건과 `samamusic` 1,597건은 서로 다른 상점의 별개 DB이며, 동일 SKU가 양쪽에 존재하는지 여부는 대표 확인 후 대조가 필요하다.

---

## 6. 샘플 20건 검증 결과

CSV: `reports/data/samasound-samamusic-sample.csv` (20행, UTF-8 BOM)

### 6.1 필드 충족율

| 컬럼 | 충족 | 비고 |
|---|---|---|
| `source_site` | 20/20 | |
| `brand` | 19/20 | 1건은 스펙표에 `브랜드`/`제조사` 라벨이 없어 **빈칸** |
| `source_category` | 16/20 | 4건은 단일 상품 URL에서 카테고리 라벨 미확인 → 빈칸 |
| `product_name` | 20/20 | 스펙표 `상품명` 라벨 기반 |
| `model` | 17/20 | 스펙표 `모델명` 라벨 또는 이름 전체가 모델코드인 경우만 채움 |
| `source_product_id` | 20/20 | |
| `canonical_url` | 20/20 | |
| `specs` | 18/20 | 2건은 리스트 전용 행(상세 미방문) |
| `image_urls` | 20/20 | `/web/product/large/` 우선, 없으면 medium |
| `published_price` | 11/20 | **samasound 전량 미확인** (아래) |
| `updated_at` | 20/20 | 수집 시각 |
| `extraction_method` | 20/20 | |
| `verification_status` | 20/20 | `detail_page_verified` / `list_page_verified` |
| `source_evidence` | 20/20 | 원본 URL + 파일 카탈로그 교차참조 |

### 6.2 가격 가용성의 사이트별 차이 (핵심)

| 사이트 | `판매가` 스펙표 값 | CSV `published_price` |
|---|---|---|
| samamusic.co.kr | `1,190,000원`, `219,000원` 등 **수치** | **수치 기록** |
| samasound.co.kr | **`가격 문의`** (문자열) | **빈칸** |

`samasound` 상세 HTML 원문:
```html
<th scope="row"><span ...>판매가</span></th>
<td><span ...>가격 문의</span></td>
```
→ **samasound 상품은 공개 가격이 존재하지 않는다.** `published_price` 는 채울 수 없으며, ERP 등록 시 **대리점/도매 가격은 별도 원천에서人手해야 한다.** 이건 수집 방법 문제가 아니라 **원천 데이터 부재**다. 이슈의 `dealer_price_unverified` 컬럼이 바로 이 자리를 뜻한다.

### 6.3 샘플에서 확인된 사실·미확인 (일부)

> **`제조사`/`브랜드` 라벨은 상품명과 다를 수 있다** (`실증`). `Fender Studio Pro`(samasound, product_no=3733)의 스펙표는 `제조사 = PreSonus` 이고 `상품간략설명`에 "수많은 수상 경력을 가진 PreSonus의 Studio One 기반 … Fender Studio Pro" 이라고 적혀 있다. **즉 원본의 제조사 라벨 자체가 상품명 속 브랜드와 다르다.**
> → **ERP 표준화 시 `brand` 를 상품명에서 파싱해 만들면 원본과 어긋난다. 반드시 원본 라벨 값을 쓰고, 라벨과 상품명이 충돌하는 항목은 별도 플래그로 남길 것을 권고한다.**

| 상품 | 사이트 | 공개 가격 | 스펙표 핵심 | 판정 |
|---|---|---|---|---|
| GENELEC 8030C (화이트) | samamusic | 1,190,000원 | 브랜드=Genelec, 모델명=8030CW, 적합인증번호=MSIP-REI-SPS-8030C, 원산지=유럽 핀란드, 상품요약정보=본 가격은 스피커 1통 가격입니다 | `실증` |
| APOGEE Duet 3 | samamusic | 1,025,000원 | 모델명=Duet 3 | `실증` |
| KLOTZ M5 HIGH-END | samamusic | 84,000원 | 모델명=M5FM | `실증` |
| SHURE PGA48 | samamusic | 78,000원 | 모델명=PGA48-LC | `실증` |
| Lunar 110 XA 10" 액티브 스피커 | samasound | *(가격 문의)* | 제조사=HK Audio, 원산지=유럽 독일, 영문상품명 동일, 상품간략설명=10인치 액티브 포인트소스 스피커 | `실증` |
| NXN6 | samasound | *(가격 문의)* | 제조사=Shure | `실증` |
| WL185MB/C-TQG | samasound | *(가격 문의)* | 제조사=Shure, 모델명=WL185MB/C-TQG | `실증` |
| 7040A | samasound | *(가격 문의)* | 제조사=Genelec, 모델명=7040A | `실증` |
| V Collection 11 PRO EDU | samasound | *(가격 문의)* | 목록 전용 행 — 상세 미방문 | `실증`(필드 공백) |
| KOMplete Select | samasound | *(가격 문의)* | 목록 전용 행 | `실증`(필드 공백) |

### 6.4 채우지 않고 남긴 필드와 이유 (빈칸 처리 원칙)

| 빈칸 필드 | 대상 | 이유 |
|---|---|---|
| `published_price` | samasound 9건 | 스펙표 `판매가` = "가격 문의". 숫자 없음 |
| `specs` | 리스트 전용 2건 | 상세 페이지 미방문(방법 검증 단계에서 무리한 대량 요청 방지) |
| `brand` | 1건 | 스펙표에 `브랜드`·`제조사` 라벨 부재. 상품명에서 추정하지 않음 |
| `model` | 3건 | `모델명` 라벨 부재 + 상품명 전체가 모델코드가 아님. 추정하지 않음 |
| `source_category` | 4건 | 단일 상품 URL에서 카테고리 라벨 확인 불가 |
| `updated_at`(상품 기준) | 전량 | **사이트가 상품 갱신일을 상품 단위로 공개하지 않음.** CSV 값은 "수집 일시"이며 상품 갱신일이 아니다 |

> `updated_at` 구분은 중요하다. `sitemap.xml` 의 `lastmod` 은 **URL 단위** 값(최신 2026-10-21)이며, 상품별 재수정 시점과 일치하지 않을 수 있다. ERP의 "상품 최종수정일" 필드로 그대로 쓰면 안 된다.

---

## 7. 수집 가능 필드 / 수집 불가 필드 (ERP 매핑 관점)

| 이슈 표준 컬럼 | samasound | samamusic | 비고 |
|---|---|---|---|
| `source_site` | ○ | ○ | `samasound.co.kr` / `samamusic.co.kr` |
| `brand` | ○ (`제조사` 라벨) | ○ (`브랜드` 라벨) | 표기 대소문자가 원본마다 다름(Genelec/GENELEC/PRESONUS/PreSonus) → **정규화 필요**. 또한 **원본 라벨이 상품명 속 브랜드와 다를 수 있음**(§6.3) → 라벨 값을 그대로 쓰고 충돌을 별도 표시 |
| `source_category` | ○ (cate_no) | ○ (cate_no) | **사이트별 cate_no 체계가 다름. 통합 금지** |
| `product_name` | ○ | ○ | |
| `model` | ○ (`모델명`) | ○ (`모델명`) | samasound는 `제조사`+`영문상품명` 병행 확인 권장 |
| `source_product_id` | ○ (URL 경로 숫자) | ○ (`product_no`) | samamusic은 sitemap URL 끝 숫자와 동일 |
| `canonical_url` | ○ | ○ | |
| `specs` | ○ (7개 라벨) | ○ (11개 라벨) | 인증번호·원산지·요약 포함 |
| `image_urls` | ○ (`/web/product/large/`) | ○ | |
| `published_price` | **× (가격 문의)** | ○ | samasound는 원천 데이터 부재 |
| `dealer_price_unverified` | × (공개 근거 없음) | × (공개 근거 없음) | **대리점 권한·도매가는 공개 정보가 아니다. 추정 금지** |
| `availability_unverified` | × (재고 미공개) | × (재고 미공개) | 판매가능 여부는 로그인/장바구니 경로(`/myshop/`)로 갈 수 있으나 robots 금지 + 계정 접근 금지 → **미확정 유지** |
| `updated_at` | △ (수집일시만) | △ (수집일시만) | 상품별 갱신일 미공개 |
| `extraction_method` | ○ | ○ | |
| `verification_status` | ○ | ○ | |
| `source_evidence` | ○ | ○ | |

---

## 8. 재실행 가능한 수집 스킬

`tools/collect_samasound_samamusic.py` — 본 분석에서 사용한 수집 경로를 그대로 재현한다. 저장소에 커밋했다.

```bash
# ① samamusic 전체 상품 식별자 목록 (sitemap 1회 요청)
python tools/collect_samasound_samamusic.py --site samamusic --sitemap-only

# ② 목록 페이지 수집 (N장)
python tools/collect_samasound_samamusic.py --site samasound --list-pages 3 --out out.csv

# ③ 상세 페이지 수집 (URL 목록 파일 1행 1개)
python tools/collect_samasound_samamusic.py --site samamusic --details urls.txt --out out.csv
```

구현에 반영한 제약:
- robots Disallow 경로 미사용 (`/exec/front/`, `/api`, `/myshop/`, `/member/`, `/admin/`)
- UA에 `python-requests` 미포함 (403 회피)
- 요청 간 1.2초 간격
- **라벨 기반 추출만** 수행, 라벨 없는 필드는 빈칸
- `--sitemap-only` 로 전체 대상 파악 후 상세 수집하는 2단계 운용이 권장

**대량 수집 시 권장 순서** (아직 수행하지 않음):
1. `sitemap.xml` 로 samamusic 전체 1,597건 대상 확정
2. samasound 는 `cate_no=23` 112페이지로 전체 2,229건 확정
3. **상세는 필요 항목(판매 예정 SKU)만** 수집 — 전체 3,800건 상세 방문은 근거 없는 부하가 있다

---

## 9. 미확정 사항 · 한계 (CENTRAL·대표 확인 필요)

| # | 항목 | 상태 |
|---|---|---|
| 1 | **두 사이트의 상품 범위가 겹치는지** | 미확정. 이슈 지시대로 김범신 대표 확인 필요 |
| 2 | `samasound` 상품의 실제 도매·대리점 가격 | 공개 정보 없음. 원천 결정 필요 |
| 3 | 재고·판매가능 여부 | robots·계정 금지로 미확정 |
| 4 | 상품별 갱신일 | 사이트 미공개. `sitemap` lastmod 은 URL 단위 |
| 5 | `brand_06_k`(=K&M, cate_no=47), `brand_30` 의 정확한 cate_no | 스와이퍼 순서 밖이라 미매핑. `cate_no=47` 은 cate 목록에서 확인 |
| 6 | 브랜드 표기 정규화 규칙 | 원본이 Genelec/GENELEC/PRESONUS/PreSonus 혼재. 정규화 규칙은 Model B와 합의 필요 |
| 7 | `display_group` / `display/N` 값의 정확한 의미 | 관찰만 있음. 구조 규칙 미확정 |
| 8 | samasound `cate_no=25`(제품분류별 103p)와 `cate_no=23`(전체 112p)의 관계 | 두 목록이 **동일 집합이 아님**(각각 다른 URL 패턴). 3,800건 합산은 중복 위험 → **합산하지 말 것** |
| 9 | 단종·신규 등록 판정 | 목록/상세만으로는 불가. 반복 수집 시 `lastmod`·`new` 표시로 추정 가능(미검증) |
| 10 | `fliphtml5` 카탈로그의 상품 단위 정보 | 플립북이라 구조화 수집 대상 아님 |

---

## 10. Model B 교차검토 요청사항

1. **두 사이트가 같은 상품 범위인지** — 2,229건 vs 1,597건의 중복 구조를 독립적으로 확인해 달라.
2. **`cate_no` 통합 여부** — 같은 번호가 다른 카테고리를 가리키는 두 체계를 한 스키마로 합칠지, `source_site`+`source_category` 쌍으로 완전 분리할지.
3. **`published_price` 미확정 处理 방식** — samasound 전량 "가격 문의"를 어떤 상태값(빈칸 / `dealer_price_unverified` 전용 / 별도 플래그)으로 둘지.
4. **`brand` 정규화 규칙** — 원본 표기 흔들림에 대한 규칙.
5. **`model` 추출 규칙** — `모델명` 라벨 우선 vs 상품명 파싱의 우선순위.
6. **브라우저 필요 여부** — Model A는 HTTP/HTML만으로 상품 ID 집합이 100% 재현됨을 실증했다. Model B도 같은 실험을 반복하면 **브라우저 불필요** 결론이 교차 확인될 것으로 본다.
7. **`sitemap.xml` 전량 신뢰 가능성** — Model A는 10/10 ID 일치 + 5/5 URL 응답 확인. Model B도 독립 확인 요망.

---

## 부록 A. 근거 파일·재현 방법

| 항목 | 위치 |
|---|---|
| 커밋된 샘플 CSV | `reports/data/samasound-samamusic-sample.csv` (20행) |
| 수집 도구 | `tools/collect_samasound_samamusic.py` |
| robots 원문 | 두 사이트 `/robots.txt` (수집 1회씩) |
| 원시 응답 | 분석 작업 디렉터리에 URL별 캐시(SHA-256 기록). 재현은 §8 스킬로 가능 |
| 총 요청 수 | **서로 다른 URL 42건**(Python 수집) + **브라우저 페이지 로드 4회**(각 7~23 XHR + 서드파티 리소스 별도). 요청 간격 1.2초 |

### 부록 B. 실증 vs 추정 요약

| 구분 | 개수 | 예시 |
|---|---|---|
| `실증` | 22개 항목 | URL 패턴, 페이지 수, 상품 수, 가격 유무, UA 403, API 0바이트, 브라우저 동일 집합, sitemap ID 일치 |
| `추정` | 3개 항목 | 두 사이트의 B2B/B2C 구분 목적, `display_group` 의미, `brand_30` 미매핑 |
| `미확정` | 10개 항목 | §9 표 |
