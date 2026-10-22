# 삼아사운드 / 삼아스토어 사이트 구조·데이터 수집 탐사 (Model A)

- **이슈**: #5 `[P0][RESEARCH] 삼아사운드 상품 사이트 2모델 독립 분석 및 수집 설계 — 스마트스토어 전 단계`
- **담당**: 김범신 CGI (`skerishKang/kbs261022`)
- **작성일**: 2026-10-22
- **역할**: 모델 1 — 사이트 구조/데이터 수집 탐사 (다른 모델 결과 미열람, 독립 탐색)
- **산출물**: 본 문서, `reports/sample-products.csv` (21건), `tools/` 재실행 스크립트

> 본 문서의 모든 수치는 **실측값**이다. 추정이 필요한 항목은 "미확정"으로 명시했다.
> 아래 수치 중 총 상품 수는 페이지네이션 실측과 사이트 자체 표기("등록 제품 : 2229개")가 일치함을 확인했다.

---

## 0. 요약 (TL;DR)

| 항목 | samasound.co.kr (삼아사운드) | samamusic.co.kr (삼아스토어) |
|---|---|---|
| 플랫폼 | **CAFE24 Indi** (mall `samassi`, skin `skin1`) | **CAFE24 Indi G2G/_wg** (mall `sama2015`, canonical `samastore.co.kr`) |
| **전체 상품 수 (실측)** | **2,229건** (112p×20, 마지막 9) | **1,969건** (Dalue `totalCount`) |
| 카테고리 | 342노드 (공개 JSON API) | 542노드 (공개 JSON API) |
| **공개 가격** | **없음** — 전건 `가격 문의` | **있음** — 숫자 가격 공개 |
| **모델명 필드** | **없음** (`제조사`만 존재) | **있음** (`모델명` row + Dalue `modelName`) |
| 단일最优 수집 경로 | SSR HTML + `SubCategory` API | **Dalue JSON API 1회** (1,969건 + 가격/모델/경로) |
| sitemap / rss | 404 / 404 | 200 (2,136 URL) / 200 (50건) |

**핵심 결론 3가지**

1. **두 사이트는 서로 다른 쇼핑몰·서로 다른 카탈로그다.** mall id 가 `samassi` vs `sama2015` 이고, samasound 는 B2B(가격 문의), samamusic 은 B2C(가격 공개) 구조다. 이슈의 "사이트별 상품 범위가 같은지 확인 전 혼합 금지" 조건에 따라 **분리 수집·분리 마스터**가 필요하다.
2. **공개 가격은 samamusic(삼아스토어) 쪽에만 존재한다.** samasound 는 브라우저로 렌더링해도 화면 전체에 `NNN원` 문자열이 0건이다(§4.3). 따라서 samasound 를 가격 소스로 삼는 것은 불가능하며, **삼아스토어 = 가격 소스 / 삼아사운드 = 라인업·사양 소스**로 역할을 나눌 수 있다.
3. **BrowserSkill(Tabbit) 경로는 필요하지만 최적이 아니다.** 동일 목록 21건에서 HTTP 경로와 **20/21 완전 일치**했고, 유일한 불일치 1건은 사이트 자체 SSR 결함(§4.4)이다. 즉 브라우저는 *검증·예외 처리·필터 조작* 용도로 쓰는 것이 효율적이다.

---

## 1. 사전 작업 — BrowserSkill 연결 복구 (CGI-1)

### 1.1 증상

`bsk doctor` 가 4건 `fail`. 핵심 행:

```
FAIL  daemon running   connect to existing daemon: connect IPC named pipe
      \\.\pipe\bsk-daemon-1a47acb3baa0c184: 액세스가 거부되었습니다. (os error 5)
      — hint: check daemon IPC permissions and `bsk logs`; keep existing runtime files
```

`bsk daemon stop` / `bsk status` / `bsk session start` 모두 동일 오류. 그러나 데몬은 **실제로 살아 있었고** 포트 52800 에서 **확장도 이미 연결된 상태**였다.

```
daemon.json : {"pid":39780,"sock_path":"\\\\.\\pipe\\bsk-daemon-1a47acb3baa0c184","ws_port":52800,...}
daemon log  : ws server listening  127.0.0.1:52800
              browser connected     id 008fca49  name chrome  generation 1
```

즉 **CLI↔daemon IPC 만 막혀 있었고** 데몬·확장·브라우저는 정상 동작 중이었다.

### 1.2 원인 (추정 아님, 실측)

설치 스크립트가 **UAC 승격 상태**에서 데몬을 기동한 것이 원인이었다. P/Invoke 로 확인한 사실:

| 항목 | 값 |
|---|---|
| 데몬 프로세스 소유자 | `CGI-1\sji` (동일 계정) |
| 데몬 토큰 | `TokenElevation = 2` (TokenElevationTypeFull — **완전 승격**) |
| 현재 셸 토큰 | `CGI-1\sji`, **비승격**, `S-1-5-32-544`(Administrators) 그룹 없음 |
| `OpenProcess(PROCESS_TERMINATE)` on 39780 | **성공** (handle 정상) |
| `taskkill /PID 39780 /F` | `拒绝访问` (denied) |

Windows named pipe 는 생성자 토큰의 DACL 을 물려받는다. 승격 토큰이 만든 파이프 DACL 을 비승격(필터된) 토큰은 매칭할 수 없어 `os error 5` 가 된다. `taskkill` 이 실패한 것은 더 높은 권한을 요구하기 때문이며, `PROCESS_TERMINATE` 만 요구하는 경로는 성공했다.

> 참고: 동일 사용자·동일 로그온 세션(`SessionId=1` 양쪽)이므로 세션 불일치 가설은 **배제** 했다.

### 1.3 조치 및 검증

1. 승격 데몬(PID 39780)을 `TerminateProcess` 로 종료 → 포트 52800 해제 확인
2. **현재 셸(비승격) 토큰**으로 `bsk daemon start --foreground` 재기동 → PID 27816, 파이프 `\\.\pipe\bsk-daemon-1a47acb3baa0c184`
3. 확장이 **2초 후 자동 재접속** (`browser connected, id 008fca49, name chrome`)
4. `bsk install-skill --harness codex` → `C:\Users\sji\.agents\skills\browser-skill\SKILL.md` 설치 (OpenCode 가 읽는 경로)

```
$ bsk doctor
ok    bsk home writable                C:\Users\sji\.bsk
ok    agent skill matches bundled CLI  bundled bsk v0.3.3; already matches bundled CLI: codex
ok    daemon running                   pid 27816 at ws://127.0.0.1:52800
ok    daemon local process identity    IPC peer PID matches daemon identity
ok    protocol compatible              daemon protocol 1.3 (app 0.3.3)
ok    auto-update                      no update attempt recorded
ok    extension connected              1 browser(s) connected
ok    browser protocol compatible      all 1 online browser(s) are compatible with the daemon
```

### 1.4 Tabbit 호환성 (요청된 확인 항목)

- **확장 실체 위치**: `C:\Users\sji\AppData\Local\Tabbit\User Data\Default\Extensions\hhcmgoofomhgciiibhipgmgkgnoenaoi` → **Tabbit 의 Chromium 프로필에 설치**. Chrome/Edge 프로필에는 이 확장이 없다.
- daemon 이 인식한 브라우저: `browser_name=chrome`, `browser_version=153.0.0.0`, `extension_version=0.3.3`, `extension_protocol_version=1.3`, `version_skew=false`.
- **결론: Tabbit 기반 BrowserSkill 은 정상 호환된다.** Chrome 대체 경로는 불필요했다.
- **Tabbit 단독 제약(실측 오류)** — 확장 내부(chrome.storage) 직접 접근 불가:
  - `page.goto("chrome-extension://<id>/popup.html")` → `page.goto: Protocol error (Page.navigate): Navigation URL is not allowed`
  - `browser.newBrowserCDPSession()` / `context.newCDPSession(page)` → `Command rejected by TabbitDance`
  - → 확장 포트 설정(기본 52800) 변경은 불가. 다행히 기본값이므로 불필요했다.

### 1.5 실제 브라우저 읽기 테스트 (통과)

```
$ bsk session start --no-focus --json     -> {"session_id":"vezt","browser_instance_id":"008fca49",...}
$ bsk navigate https://example.com --session vezt
  tab=1033257815 reached=load  url=https://example.com/
$ bsk observe --session vezt
  RootWebArea "Example Domain"  paragraph "This domain is for use in documentation examples..."
```

대상 사이트 2건도 동일 경로로 렌더·추출 확인(§5.3).

---

## 2. 두 사이트의 관계 (혼합 금지 판단 근거)

| | samasound.co.kr | samamusic.co.kr |
|---|---|---|
| mall id | `samassi` | `sama2015` |
| 정식 이름 | 삼아사운드(유) | 삼아스토어 |
| 사업자/주소 | 서울 종로구 삼일대로 457, 11층 (footer 실측) | 별도 상점 (footer 미확인) |
| 성격 | B2B 취급(가격 문의) | B2C 온라인 스토어(가격 공개, 장바구니/주문/로그인) |
| 상호 참조 | — | samasound(및 samastore.co.kr)를 "삼아사운드 KRW -->" 링크로 참조 |

두 사이트가 **같은 그룹**일 가능성(공통 SNS/블로그/YouTube 채널, 상호 링크)은 높으나, **상품 카탈로그는 별개**다:
- samasound 2,229건 / samamusic 1,969건, 가격 공개 여부 다름, 모델명 필드 유무 다름.
- → 이슈 지시대로 **혼합하지 않는다**. 단, 수집 스킬은 하나의 파이프라인으로 두 대상을 각각 출력하도록 설계했다.

---

## 3. samasound.co.kr — 구조

### 3.1 플랫폼 식별 (실측 근거)

```
CAFE24.getMallID : function() { return 'samassi'; };
mallPrefix : "cafe24_samassi_1"     SKIN_CODE : "skin1"
//samassi.cafe24.com/...  //img.echosting.cafe24.com/skin/base/common/btn_page_first.gif
/app/Eclog/js/cid.generate.js?...&u=samassi.1
CAFE24.SHOP_CURRENCY_INFO : KRW / ₩
```
→ **CAFE24 Indi(classic skin1)**. GodoMall/Makeshop 아님. `https://m.samasound.co.kr/` 는 별도 모바일 스킨.

### 3.2 카테고리 (공개 JSON API — 핵심 발견)

```
GET https://www.samasound.co.kr/exec/front/Product/SubCategory
→ 200, application/json; charset=utf-8, 73,120 bytes, 342 노드
```
레코드 형태:
```json
{"link_product_list":"/category/전체보기/23/","name":"전체보기","param":"?cate_no=23",
 "cate_no":23,"parent_cate_no":1,"design_page_url":"product/list.html","like_count":0}
```
루트 3개: `23 전체보기` / `24 브랜드별 보기` / `25 제품분류별 보기`. 최심층 4단계.

> `robots.txt` 는 `/exec/front/` 를 `Disallow` 하지만 **엔드포인트는 공개 읽기 가능**하다.

### 3.3 목록 · 페이지네이션 · 상세 URL

```
목록   : https://www.samasound.co.kr/product/list.html?cate_no={N}&page={P}   (20건/페이지)
상세   : https://www.samasound.co.kr/product/{slug}/{product_id}/category/{cate_no}/display/1/
대체   : https://www.samasound.co.kr/product/detail.html?product_no={id}
```
- `?cate_no=0` / `?cate_no=1` → **404**. `?S=`, `?no=` 는 무시.
- 정렬: `?cate_no=0&sort_method=1`(상품명) / `5`(신상품) / `6`(인기상품)
- 페이지네이션 마지막 페이지 링크 `?cate_no=23&page=112` → 마지막 페이지 9건

**전체 상품 수 실측**: `111 × 20 + 9 = 2,229` 건 (5개 페이지 중복 ID 검사 결과 중복 0, 최대 product id 3887)

### 3.4 브랜드 (31개) — 홈 캐러셀에서 cate_no 매핑

홈 `Our Brands` 캐러셀의 `<a href="/product/list.html?cate_no=N">` + 로고 파일명으로 실측 매핑(일부 발췌):

| cate_no | 브랜드 | 건수(추정) | cate_no | 브랜드 | 건수(추정) |
|---|---|---|---|---|---|
| 42 | Shure | 480 | 46 | REAN | 80 |
| 43 | Genelec | 80 | 340 | IK MULTIMEDIA | 40 |
| 417 | Q-SYS | 40 | 361 | VICOUSTIC | 20 |
| 44 | Allen&Heath | 80 | 333 | DYNAUDIO | 20 |
| 45 | Neutrik | 140 | 349 | NATIVE INSTRUMENTS | 80 |
| 50 | HK Audio | 120 | 53 | iMAG | 20 |
| 47 | K&M | 80 | 354 | Q Acoustics | 20 |
| 49 | Martin Audio | 80 | 317 | POSITIVE GRID | 20 |
| 352 | PRESONUS | 160 | 330 | CLOUD | 20 |
| 432 | Clear-Com | 20 | 358 | ROTOSOUND | 20 |
| 322 | APOGEE | 80 | 348 | NASH GUITARS | 40 |
| 48 | RADIAL | 60 | 347 | TUTTLE GUITARS | 20 |
| 343 | KLOTZ | 180 | 331 | COMPLY | 40 |
| 324 | ARTURIA | 80 | 355 | QED | 40 |
| 309 | NNNN | 20 | 415 | JICO | 60 |
| | | | 431 | Fidelice | 20 |

(브랜드별 합계 2,260 ≒ 전체 2,229 — 차이는 무브랜드/중복 배정 상품)

### 3.5 상세 페이지에서 얻는 필드

`기본 정보` 표 (`<caption> 기본 정보</caption>`) 실측 row:

| 라벨 | 값 | 비고 |
|---|---|---|
| 상품명 | 예: `Lunar 110 XA 10” 액티브 스피커` | |
| 상품요약정보 / 상품간략설명 | 자유 서술 | |
| **제조사** | `HK Audio` | **모델명 필드 없음** |
| 원산지 | `유럽 독일` | |
| 영문상품명 | | |
| **판매가** | **`가격 문의`** | **숫자 없음** |
| 구매방법 / 배송주기 | 정기배송 할인 문구 | |

- **`모델명` / `스펙` / `규격` 라벨은 0건** → 모델명은 `영문상품명` 또는 상품명에서 추출해야 한다. (샘플에서 `WL185MB/C-TQG`, `SM31FH-TQG` 등 상품명 자체가 모델명 역할을 한다.)
- **브레드크럼**: `xans-product-headcategory` — 단, **`/product/detail.html?product_no=N` 형태에서만** 전체 4단계 경로가 나온다. slug 형태(`/product/{slug}/{id}/category/23/display/1/`)는 `전체보기` 만 노출된다.
  ```
  홈 > 브랜드별 보기 > H-K > HK Audio > LUNAR
  ```
- **JSON-LD** (`@type: Product`):
  ```json
  {"name":"Lunar 110 XA 10” 액티브 스피커",
   "image":["https://www.samasound.co.kr/web/product/big/202607/ec0ed2...jpg", ...],
   "description":"10인치 액티브 포인트소스 스피커",
   "brand":{"@type":"Brand","name":"HK Audio"},
   "sku":"cafe24_samassi_1_3826",
   "offers":{"@type":"Offer","priceCurrency":"KRW","price":"가격 문의",
             "availability":"https://schema.org/InStock"}}
  ```
  → `sku` = `cafe24_samassi_1_{product_id}` → **원본 상품ID 추출에 사용 가능**. `aggregateRating` 없음.
- **이미지 경로 (예측 가능)**:
  ```
  //www.samasound.co.kr/web/product/{big|medium|small|extra/big|extra/small}/{YYYYMM}/{md5}.{jpg|png}
  ```

---

## 4. samamusic.co.kr — 구조

### 4.1 플랫폼 식별

```
CAFE24.getMallID : 'sama2015'      mallPrefix : "cafe24_sama2015_1"
isG2G:true  isNewProMode:true  isSDE:true       //_wg/...  img.echosting.cafe24.com/design/skin/mono/product/...
wcs.naver.net/wcslog.js (네이버 체크아웃 연동)
```
→ **CAFE24 Indi 의 새 G2G/_wg 스킨**. canonical 도메인은 `samastore.co.kr` (sitemap·og:url 기준), `samamusic.co.kr` 은 별칭. `m.samamusic.co.kr` → `samamusic.co.kr` 302.

### 4.2 카테고리 · 목록

```
GET /exec/front/Product/SubCategory  → 542 노드, 루트 20개
목록 : /product/list.html?cate_no={N}&page={P}   (21건/페이지)
상세 : /product/detail.html?product_no={id}&cate_no={N}&display_group={1..14}
```
LNB(상단 메뉴) 11개: `1152 프로모션 보기` / `24 브랜드` / `84 마이크` / `42 스피커` / `25 이어폰/헤드폰` / `28 레코딩/음향` / `379 악기/앰프` / `1038 Hi-Fi` / `366 케이블/커넥터` / `758 소프트웨어` / `97 특가상품`

**전체 상품 수 실측**: Dalue `totalCount = 1,969`. (sitemap.xml 은 2,136 URL — 카테고리 532 + 상품 1,597 등이라 상품 수와 ≠ )

> **SSR HTML 에는 최상위 11개 카테고리 링크만 나온다.** 하위 카테고리 경로는 §4.5 의 Dalue `categoryNos` 로만 얻을 수 있다.

### 4.3 공개 가격 — 있음

| 위치 | 값 예시 |
|---|---|
| 목록 `<li>` 속성 | `data-price="^219000"` (`^` = 할인가 표시 마커) |
| 목록 spec row | `<strong>판매가</strong> <span>40,000원</span>` |
| 상세 | `<strong id="span_product_price_text">219,000원</strong>` |
| JSON-LD | `"offers":{"price":219000,"priceCurrency":"KRW","availability":".../InStock"}` (숫자형) |
| OpenGraph | `product:price:amount=1190000`, `product:sale_price:amount=1190000` |

> 목록 HTML 안에도 `40,000원` 형태의 숫자가 **SSR 로 이미 존재**한다. 즉 이 사이트는 템플릿 플레이스홀더(`{$pcDiscountPrice}`)를 **화면에서만** 채우는 게 아니라, 실제 값이 HTML 에 포함되어 있다(플레이스홀더는 템플릿 정의 블록에 1건만 잔존). → **브라우저 렌더링 없이도 가격이 추출된다.**

### 4.4 상세 페이지 스키마 편차 (실측)

| 케이스 | 사례 | 처리 |
|---|---|---|
| `ProductGroup` | `product_no=4558` (Q Acoustics Q M20 Pair) → `@type:"ProductGroup"`, `hasVariant` 3개(블랙/화이트/월넛), **`offers`·`brand`·`availability` 없음**, `sku`는 `productGroupID` | HTML `기본 정보` 표로 폴백 (판매가 1,290,000원 / 브랜드 Q Acoustics / 모델명 M20 / 소비자가 1,840,000원) |
| 목록 SSR 결함 | 동일 4558 이 목록에서 `{$productName}` 플레이스홀더로 출력 | 상세 페이지 값으로 대체 |
| **목록/상세 가격 불일치** | 4558: 목록 `^1,050,000` vs 상세 `1,290,000원` | 가격은 **상세(또는 Dalue) 기준**을 신뢰 |
| 옵션 추가금 | `길이선택: 1m(+3,000원) 2m 3m(+6,000원) ...` | `published_price` 는 **기본가**이며 옵션 추가금은 별도 |
| `availability` 누락 | `product_no=5685` (KLOTZ) JSON-LD 에 없음 | Dalue `soldOut`/`display`/`selling` 로 판정 |
| `modelName` 누락 | `product_no=40` (TC Electronic) Dalue·상세 모두 없음 | 상품명으로 fallback |

### 4.5 공개 JSON 상품 API (Dalue/DCSE) — 가장 효율적인 경로

검색 화면 인라인 스크립트에서 발견된 공개 설정:
```js
var __mallId='sama2015'; var __dssUrl='https://api.dalue.io:10806';
var __dssKey='Ak25dpcSKLXu'; var __dssPrice='pcDiscountPrice';
DalueSearch.vFields='productNo,productName,price,retailPrice,...categoryNos,brandName,...modelName,...'
```
검증된 요청(`POST`, `application/x-www-form-urlencoded`):
```
apiKey=Ak25dpcSKLXu&collName=products&query=*&begin=1&size=40
&mallId=sama2015&shopNo=1&mallType=cafe24
&categoryIdFields=categoryRoot1No,categoryRoot2No&categoryNameFields=categoryRoot1,categoryRoot2
&brandIdField=brandCode&brandNameField=brandName&brandCode=&categoryId=
&rangeFields=pcDiscountPrice&rangeValues=0,9999999999
&categoryAuthFieldName=categoryNos&categoryAuthDevice=1&categoryAuthMemberType=0
&equalFields=display,selling&equalValues=1,1
&aclFlagField=exposureLimitType&aclFlagValue=M&aclField=exposureGroupList&aclFieldValue=0&aclShow=0
&aclRemoveFields=price,mobilePrice,pcPrice&priceField=pcDiscountPrice&priceClusterNo=3
&sortField=&sortType=&tagStat=1&tagFields=&tagSeperator=|&vFields=<필드목록>
```
응답(실측):
```json
{"header":{"code":0,"message":"SUCCESS","count":1969,"totalCount":1969,"begin":1,"size":1969},
 "result":[{"productNo":"5750","productName":"SHURE MV6 Gen 2 ...","price":"303000","pcDiscountPrice":"303000",
            "brandName":"SHURE","modelName":"MV6 Gen2 (Black)/ (White)","categoryRoot1No":"84",
            "categoryNos":"84;24^671;84^85;84^87","image":"https://samastore.co.kr/web/product/medium/202610/622348a3....png",
            "soldOut":"0"}]}
```
- **`size=2000` 1회 요청으로 1,969건 전체 + 가격 + 모델명 + 브랜드 + 카테고리 경로 + 이미지 + 품절여부 획득.**
- `categoryNos` 해독: `;` 로 경로 구분, `^` 로 parent→child 체인. 체인의 마지막 번호로 `SubCategory` 트리에서 경로를 복원한다.
  - 예: `"84;24^671;84^85;84^87"` → `마이크 | 브랜드 > SHURE | 마이크 > 유선 마이크 | 마이크 > ...`
  - 실측 복원 결과: `레코딩 > 마이크 | 브랜드 > SHURE | 마이크 > 유선 마이크`
- `apiKey` 는 페이지에 공개된 값이며, `mallId` 를 바꿔도 `apiKey` 가 스코프를 결정한다(같은 키로 `mallId=samassi` 를 넣어도 sama2015 데이터가 반환).

### 4.6 그 외 공개 경로

| 경로 | 결과 |
|---|---|
| `GET /sitemap.xml` | 200, 301,370 bytes, **2,136 URL** (카테고리 532 + 상품 1,597 + boards) — host 는 `samastore.co.kr` |
| `GET /rss.xml` | 200, 28,970 bytes, **50 items** (최신 상품) |
| `GET /product/search.html?keyword=` | samasound 전용(classic). samamusic 은 `shopSearch/search.html` UI |
| `GET /shopSearch/search.html?query=..&begin=1&size=40` | 200 HTML(검색 UI) — JSON 아님. `total` 필드 없음 → **Dalue 를 쓰는 게 우위** |
| `robots.txt` | 200 (표준 CAFE24) |

---

## 5. 수집 경로 비교

### 5.1 경로별 비교표

| 경로 | samasound.co.kr | samamusic.co.kr | 비고 |
|---|---|---|---|
| **A. HTML 요청 (SSR)** | ✅ 118KB/페이지, ~0.09s, JSON-LD 포함 | ✅ 518KB/페이지, ~0.10s, JSON-LD 포함 | 가장 범용. 단 상세 URL 형태 선택 필요 |
| **B. 공개 카테고리 JSON** | ✅ `/exec/front/Product/SubCategory` (342) | ✅ 동일 (542) | 양쪽 공통. HTML 에는 안 나오는 계층을 복원해 준다 |
| **C. 공개 상품 JSON** | ❌ 없음 | ✅ **Dalue 1회 = 1,969건 + 가격/모델/경로** | samamusic 의 최우선 경로 |
| **D. sitemap / rss** | ❌ 404 | ✅ 2,136 URL / 50 items | 전체 URL 열거용 |
| **E. BrowserSkill(Tabbit)** | ✅ 동작, 단 목록에서 가격 0건 | ✅ 동작, DOM 렌더 후 가격 확인 | 검증·필터·예외 처리용 |
| **F. 로그인/계정** | 불필요 | 불필요 | **계정 접근 없이 전 항목 수집 가능** |

### 5.2 권장 조합 (효율 기준)

```
samasound.co.kr  = B(카테고리 트리) → A(목록) → A(상세, detail.html 형태) → JSON-LD + 기본정보 표
samamusic.co.kr  = C(Dalue 1회)  → B(카테고리 트리로 경로 복원) → A(상세) 필요한 건만 (모델명/원산지/배송비/옵션)
```
- samamusic 은 **Dalue 1회가 HTML 101회보다 빠르고 정확**하다. 상세 페이지는 "모델명·원산지·배송비·옵션" 이 필요한 상품에 대해서만 왕복한다.
- samasound 는 공개 API 가 없으므로 **상세 페이지가 유일한 스펙 소스**다. 단 samasound 의 `SubCategory` API 로 342개 카테고리를 순회하면 목록 요청 수는 112 → 약 40(카테고리당 1p)으로 줄일 수 있다(브랜드/분류 카테고리는 4·3p).

### 5.3 BrowserSkill(Tabbit) 경로 실측 검증

**동일 목록 페이지(samamusic cate 42)를 HTTP 와 BrowserSkill 로 각각 추출해 행 단위 비교:**

```
HTTP  : 21 rows, 0.10s, 518,153 bytes
BSK   : 21 rows (Agent Window DOM, 렌더 후)
identical rows: 20/21        ← name / url / image / price(숫자 정규화) 4항목 전부 일치
price numeric mismatches: 1  ← 4558 (사이트 자체 목록 SSR 결함)
```

BrowserSkill 상세 추출 예시(samamusic 4167):
```json
{"jsonld_type":"Product","jsonld_price":219000,"rendered_price":"219,000원",
 "jsonld_brand":"PRESONUS","jsonld_sku":"cafe24_sama2015_1_4167",
 "jsonld_availability":"InStock","body_price_strings":17,
 "specs":[{"label":"모델명","value":"Eris 3.5 GEN2 White"}, ...]}
```
BrowserSkill 상세 추출 예시(samasound 3826):
```json
{"jsonld_type":"Product","jsonld_price":"가격 문의","rendered_price":"",
 "jsonld_brand":"HK Audio","jsonld_sku":"cafe24_samassi_1_3826",
 "breadcrumb":["브랜드별 보기","H-K","HK Audio","LUNAR"],
 "body_price_strings":0,
 "specs":[{"label":"제조사","value":"HK Audio"},{"label":"판매가","value":"가격 문의"}, ...]}
```
→ **브라우저로 렌더해도 samasound 에는 가격이 0건**임을 재확인했다.

**BrowserSkill 가 필요한 경우**: (1) 검증/샘플링, (2) 로그인 없이 보이지 않는 DOM 확인, (3) 필터·정렬 UI 조작, (4) HTTP 로 뽑히지 않는 `{$...}` 결함 행의 상세 폴백.
**BrowserSkill 가 불필요한 경우**: 대량 수집. 21행 기준 HTTP 0.10s vs 브라우저는 페이지당 수 초 + 세션 유지(기본 5분 idle) 비용.

---

## 6. 실제 상품 샘플 (21건)

`reports/sample-products.csv` (이슈 #5 표준 컬럼 16개 준수, 개인정보·로그인 정보 없음).
수집 명령: `python tools/collect_samples.py --samasound 12 --samamusic 12`


### samasound.co.kr (12건)

| # | source_product_id | brand | product_name | model | source_category | published_price | availability | specs (확인된 항목) |
|---|---|---|---|---|---|---|---|---|
| 1 | `3887` | ARTURIA | V Collection 11 PRO EDU(학생/교직원용) | V Collection 11 PRO EDU(학생/교직원용) | 제품분류별 보기 > 레코딩&악기 > 소프트웨어/플러그인 | **가격 문의** | InStock | 상품요약정보=아투리아 키보드/신디사이저 올인원 가상악기 사운드컬렉션 - 45 개 키보드/신디사이저, 12,000 개 이상 고품질 프리셋 사운드 포함 가상악기; 제조사=ARTURIA; 원산지=유럽 프랑스; 구매방법=1회구매 정기배송 할인; 배송주기=정기배송 할인 save |
| 2 | `3884` | NATIVE INSTRUMENTS | Komplete 26 Ultimate | Komplete 26 Ultimate | 제품분류별 보기 > 레코딩&악기 > 소프트웨어/플러그인 | **가격 문의** | InStock | 상품요약정보=확장된 사운드, 깊이 있는 표현력; 상품간략설명=장르의 제한 없이 자유로운 음악 제작이 가능한 강력한 사운드 컬렉션; 제조사=NATIVE INSTRUMENTS; 원산지=유럽 독일; 구매방법=1회구매 정기배송 할인; 배송주기=정기배송 할인 save 결제 시  |
| 3 | `3881` | NATIVE INSTRUMENTS | Komplete 26 Ultimate UPG/UPD | Komplete 26 Ultimate UPG/UPD | 제품분류별 보기 > 레코딩&악기 > 소프트웨어/플러그인 | **가격 문의** | InStock | 상품요약정보=확장된 사운드, 깊이 있는 표현력; 상품간략설명=본 제품은 기존 사용 중인 제품을 최신 버전으로 업그레이드/업데이트하는 상품입니다. 대상 제품을 보유하고 있지 않은 경우 사용 및 활성화가 불가능합니다.; 제조사=NATIVE INSTRUMENTS; 원산지=유 |
| 4 | `3878` | NATIVE INSTRUMENTS | Komplete 26 Ultimate S-Series Upgrade (Kontrol S mk3 사용자) | Komplete 26 Ultimate S-Series Upgrade (K | 제품분류별 보기 > 레코딩&악기 > 소프트웨어/플러그인 | **가격 문의** | InStock | 상품요약정보=확장된 사운드, 깊이 있는 표현력; 상품간략설명=본 제품은 Kontrol S 키보드 보유 고객 전용 상품입니다. 해당 제품을 보유하지 않은 경우 활성화가 제한될 수 있습니다.; 제조사=NATIVE INSTRUMENTS; 원산지=유럽 독일; 구매방법=1회구매 |
| 5 | `3875` | Shure | WL185MB/C-TQG | WL185MB/C-TQG | 제품분류별 보기 > 마이크 > 무선마이크 > 무선 바디팩용 마이크 | **가격 문의** | InStock | 상품요약정보=단일지향성 로우 프로파일 카디오이드 라발리에 컨덴서 마이크; 상품간략설명=SHURE 무선용 단일 지향성 핀마이크 블랙; 제조사=Shure; 원산지=아시아 중국; 구매방법=1회구매 정기배송 할인; 배송주기=정기배송 할인 save 결제 시 : 할인 |
| 6 | `3872` | Shure | SM31FH-TQG | SM31FH-TQG | 제품분류별 보기 > 마이크 > 유선마이크 > SM 시리즈 | **가격 문의** | InStock | 상품요약정보=단일지향성 피트니스 헤드셋 컨덴서 마이크; 상품간략설명=SHURE 헤드셋 단일지향성 컨덴서 마이크, TA4F 커넥터 포함; 제조사=Shure; 원산지=아시아 중국; 구매방법=1회구매 정기배송 할인; 배송주기=정기배송 할인 save 결제 시 : 할인 |
| 7 | `3869` | Shure | WL93T | WL93T | 제품분류별 보기 > 마이크 > 무선마이크 > 무선 바디팩용 마이크 | **가격 문의** | InStock | 상품요약정보=무지향성 미니어처 라발리에 마이크; 상품간략설명=SHURE 무선용 전지향성 소형 컨덴서 핀마이크 황갈색; 제조사=Shure; 원산지=아시아 중국; 구매방법=1회구매 정기배송 할인; 배송주기=정기배송 할인 save 결제 시 : 할인 |
| 8 | `3867` | VICOUSTIC | VicOffice Desk | VicOffice Desk | 제품분류별 보기 > 룸어쿠스틱&스탠드 > 룸어쿠스틱 > 어쿠스틱 패널 | **가격 문의** | InStock | 상품요약정보=업무 공간의 프라이버시 확보와 소음 저감을 위한 PET 흡음 데스크 파티션; 상품간략설명=사무실, 오픈 오피스, 개인 업무 공간, 교육시설 등에 적합한 데스크 디바이더; 제조사=VICOUSTIC; 원산지=유럽 포르투갈; 구매방법=1회구매 정기배송 할인; 배 |
| 9 | `3864` | VICOUSTIC | Stand Alone | Stand Alone | 제품분류별 보기 > 룸어쿠스틱&스탠드 > 룸어쿠스틱 > 어쿠스틱 패널 | **가격 문의** | InStock | 상품요약정보=비쿠스틱 어쿠스틱 트리트먼트 패널; 상품간략설명=무타공 이동형 어쿠스틱 패널 솔루션; 제조사=VICOUSTIC; 원산지=유럽 포르투갈; 구매방법=1회구매 정기배송 할인; 배송주기=정기배송 할인 save 결제 시 : 할인 |
| 10 | `3861` | IK MULTIMEDIA | TONEX ONE PLUS | TONEX ONE PLUS | 제품분류별 보기 > 레코딩&악기 > 악기/앰프 > 기타 액세서리 | **가격 문의** | InStock | 상품요약정보=블루투스/MIDI 지원 AI 머신 모델링 앰프/페달 톤 모델 미니 페달; 상품간략설명=AI 머신 모델링 기반 톤 모델링, 블루투스 조작, MIDI 연결, 톤 쉐이핑을 위한 이펙터 내장, 20개 프리셋 저장, 소프트웨어 무료 제공; 제조사=IK MULTIME |
| 11 | `3858` | Genelec | G1 (로우컬러) | G1 (로우컬러) | 제품분류별 보기 > 스피커&퍼스널리스닝 > Hi-Fi > 액티브 스피커 | **가격 문의** | InStock | 상품요약정보=제네렉 홈 오디오 액티브 라우드 스피커; 상품간략설명=제네렉의 순수한 모니터링 사운드를 홈 오디오로; 제조사=Genelec; 원산지=유럽 핀란드; 구매방법=1회구매 정기배송 할인; 배송주기=정기배송 할인 save 결제 시 : 할인 |
| 12 | `3836` | Allen&Heath | SQ5+ | SQ5+ | 제품분류별 보기 > 프로 오디오 > 믹서 > 디지털 믹서 | **가격 문의** | InStock | 상품요약정보=48채널 44버스 17페이더 디지털 믹서; 상품간략설명=컴팩트 디지털 믹싱의 기준이 되어온 SQ의 핵심을 유지하며 업그레이드된 SQ+. 17개의 모터 페이더와 8개의 소프트키, 4개의 온보드 RackUltraFX 엔진을 통해 플래그십급 프로레싱과 직관적인  |

### samamusic.co.kr (9건)

| # | source_product_id | brand | product_name | model | source_category | published_price | availability | specs (확인된 항목) |
|---|---|---|---|---|---|---|---|---|
| 1 | `4175` | SHURE | SHURE SV100 슈어 다이나믹 유선 마이크 노래방 스피치 용 | SV100 | 마이크 \| 레코딩 > 마이크 \| 브랜드 > SHURE \| 마이크 > 유선 마이크 \| 레 | **40000** | InStock | 브랜드=SHURE; 모델명=SV100; 상품요약정보=보컬에 최적화된 다이나믹 마이크로폰; 원산지=아시아 중국 또는 멕시코; 배송비=3,000원 (50,000원 이상 구매 시 무료); 구매방법=1회구매 정기배송 할인; 배송주기=정기배송 할인 save 결제 시 : 할인 |
| 2 | `4167` | PRESONUS | [한정판] PreSonus Eris 3.5 GEN2 White 프리소너스 에리스 2세대 모니터 스피커 1조(2통) 화이트 | Eris 3.5 GEN2 White | 스피커 > 모니터 스피커 \| 레코딩 > 모니터 스피커 \| 브랜드 > PRESONUS \|  | **219000** | InStock | 브랜드=PRESONUS; 모델명=Eris 3.5 GEN2 White; 안전확인신고번호=공급자적합성확인대상제품; 적합인증번호=R-R-YPS-Eris3-5; 상품요약정보=본 가격은 스피커 1조(2통)에 대한 가격입니다; 상품간략설명=국민스피커 ERIS, 2세대 2웨이 8. |
| 3 | `3563` | SHURE | SHURE AONIC 50 GEN2 슈어 무선 노이즈 캔슬링 헤드폰 (블랙) | AONIC 50 GEN2 | 레코딩 > 헤드폰 \| 브랜드 > SHURE \| 15% 할인 \| 이어폰/헤드폰 \| 이어폰 | **608000** | InStock | 브랜드=SHURE; 모델명=AONIC 50 GEN2; 안전확인신고번호=XU101514-18001; 적합인증번호=R-C-SHU-MH36458; 상품요약정보=Wireless Noise Cancelling 헤드폰; 원산지=아시아 중국; 배송비=무료; 구매방법=1회구매 정기배 |
| 4 | `5612` | Cloud | CLOUD MINI CL-25 초소형 인라인 마이크 프리앰프 | CL-25 | 레코딩/음향 > 프리앰프 \| 레코딩/음향 > 액세서리 \| 브랜드 > CLOUD \| 레코딩 | **281000** | InStock | 브랜드=Cloud; 모델명=CL-25; 적합인증번호=R-R-sSI-CL-25; 상품요약정보=최대 +25dB까지 깨끗하게 증폭해 주는 초소형 인라인 마이크 프리앰프; 상품간략설명=다이내믹 및 리본 마이크의 신호를 최대 +25dB까지 깨끗하게 증폭해 주는 초소형 인라인 마 |
| 5 | `4494` | Rickenbacker | Rickenbacker 4005XC 리켄배커 리미티드 에디션 세미-할로우 베이스 기타 | 4005XC | 브랜드 > RICKENBACKER \| 악기/앰프 \| 악기/앰프 > 베이스 기타 \| 악기/ | **9030000** | InStock | 브랜드=Rickenbacker; 모델명=4005XC; 상품요약정보=브리티쉬 사운드의 상징 리켄배커(Rickenbacker) 베이스 기타; 상품간략설명=리켄배커 90주년 기념하는 한정판 4005XC 베이스 기타; 원산지=아메리카 미국; 배송비=3,000원 (50,000원 |
| 6 | `5685` | Klotz | KLOTZ D-Sub (25pin) 수 to 4/4 XLR M/F 클로츠 LOOM 디지털 케이블 (YAMAHA 핀 배열) YC | YCDAE | KLOTZ 케이블 > 레코딩 케이블 \| 케이블/커넥터 > 레코딩 케이블 \| KLOTZ 케이 | **440000** | InStock | 브랜드=Klotz; 모델명=YCDAE; 상품요약정보=1m, 3m, 5m 선택가능; 원산지=유럽 독일; 배송비=3,000원 (50,000원 이상 구매 시 무료); 구매방법=1회구매 정기배송 할인; 배송주기=정기배송 할인 save 결제 시 : 할인; 길이=- [필수] 옵션 |
| 7 | `4537` | Native Instruments | NI Maschine 3 Bundle Update 비트메이킹, 뮤직 프로덕션 머신 3 번들 소프트웨어 업데이트(라이브러리 포함 | Maschine 3 Bundle Update | 레코딩 > 소프트웨어 (Plug-in) \| 소프트웨어 \| 레코딩 > 소프트웨어 (Plug- | **84000** | InStock | 소비자가=120,000원; 브랜드=Native Instruments; 모델명=Maschine 3 Bundle Update; 상품요약정보=Mashcine 3 업데이트 / Maschine 2 버전을 3 버전으로 업데이트 / 신규 Central 라이브러리 포함; 상품간략설명 |
| 8 | `5665` | Genelec | GENELEC G1 제네렉 홈 오디오 액티브 라우드 스피커 (화이트) | G1BW | 브랜드 > GENELEC \| Hi-Fi \| 브랜드 > GENELEC > G Series L | **620000** | InStock | 브랜드=Genelec; 모델명=G1BW; 안전확인신고번호=공급자적합성확인대상제품; 적합인증번호=R-R-sSI-G_One; 상품요약정보=본 가격은 스피커 1통 가격입니다; 원산지=유럽 핀란드; 배송비=3,000원 (50,000원 이상 구매 시 무료); 구매방법=1회구매  |
| 9 | `40` | TC Electronic | TC Electronic PolyTune Clip White 티씨 일렉트로닉 기타 튜너 결제창 | TC Electronic PolyTune Clip White 티씨 일렉트 | 악기/앰프 > 튜너 \| 브랜드 > TC \| 특가상품 | **64000** | InStock | 소비자가=82,000원; 브랜드=TC Electronic; 원산지=아시아 중국; 배송비=3,000원 (50,000원 이상 구매 시 무료); 구매방법=1회구매 정기배송 할인; 배송주기=정기배송 할인 save 결제 시 : 할인 |

---

## 7. 재사용 가능한 수집 절차

### 7.1 파일 구성

| 파일 | 역할 |
|---|---|
| `tools/samasound_collect.py` | 공통 HTTP 클라이언트(URL percent-encoding 포함) + 카드/JSON-LD/제원표 파서 + `--discover` 카테고리 매핑 |
| `tools/dalue_export.py` | samamusic 공개 Dalue JSON API 클라이언트 (전체 1,969건 1회) |
| `tools/collect_samples.py` | 표준 컬럼 CSV 생성 (두 사이트, 카테고리 경로·Dalue 교차검증 포함) |
| `tools/compare_paths.py` | HTTP vs BrowserSkill 행 단위 패리티 검증 |
| `tools/render_table.py` | CSV → 마크다운 표 |
| `tools/probes/*` | 탐사 과정의 재현 가능한 검증 스크립트 (구조·카운트·브랜드·결함 점검) |

### 7.2 실행 순서 (재실행 절차)

```bash
# 1) 카테고리/브랜드 구조 확인
python tools/samasound_collect.py --discover

# 2) samamusic 공개 API 로 전체 카탈로그 1회 수집 (검증용)
python tools/dalue_export.py --size 2000 --out reports/dalue-samamusic.json

# 3) 표준 컬럼 샘플 CSV 생성 (검증 후 대량화)
python tools/collect_samples.py --out reports/sample-products.csv \
                                --json-out reports/sample-products.json \
                                --samasound 12 --samamusic 12

# 4) 표 생성
python tools/render_table.py

# 5) (선택) BrowserSkill 경로 교차검증
bsk session start --no-focus --json      # session_id 확보
bsk navigate https://www.samamusic.co.kr/product/list.html?cate_no=42 --session <id>
bsk evaluate "<목록 추출 JS>" --session <id>
python tools/compare_paths.py
bsk session stop <id>
```

### 7.3 대량화 시 주의사항 (방법 검증 완료 후 적용)

1. **요청 속도**: 목록 20~21건/페이지 → samasound 112p + samamusic 95p. inter-request 0.2~0.3s 유지. `robots.txt` 에 `Crawl-delay: 10` (bingbot) 규칙 존재 → 무리한 병렬화 금지.
2. **중복/업데이트 판정**: `source_product_id`(=카페24 product_no) 가 안정적 키. 스키마에 `updated_at` 은 없으므로 **수집 시각 + 해시 비교**로 갱신을 감지해야 한다(미구현 → §8).
3. **가격 근거**: samamusic 은 `published_price` = 목록/상세/Dalue 3중 확인. 옵션 추가금은 `specs` 의 옵션 행에 문자열로 남는다(정규화 미구현 → §8).
4. **단종/품절**: Dalue `soldOut` + `display` + `selling` 3플래그. `display=0` 은 진열 중지.
5. **옵션 상품**: 옵션이 있는 상품은 `ProductGroup` + `hasVariant` 로 오며 옵션별 추가금이 별도다. 가격은 변형 기준가로 취급해야 한다.

---

## 8. 실패·미확정 사항 (명시)

| 항목 | 상태 |
|---|---|
| samasound **공개 가격** | **미확정(불가능)** — 브라우저 렌더 기준 전건 `가격 문의`, 페이지 내 `NNN원` 0건. 별도 문의/로그인 없이는 불가 |
| samasound **모델명 필드** | **미확정(부재)** — `모델명`/`스펙`/`규격` 라벨 0건. `제조사` + `영문상품명` + 상품명으로 대체 |
| samasound **단종 표시** | `제조사` 없는 일부 category 에 `단종제품`( cate 150) 이 있으나 개별 상품 단종 표시는 상세에서 확인 못 함 → **미확정** |
| 상품 **업데이트 시각** | 사이트가 `updated_at` 을 제공하지 않음 → **미확정**(수집 시각으로 대체) |
| 옵션 **추가금 정규화** | 옵션 행 문자열(`길이선택: 1m(+3,000원) ...`)을 구조화하지 못함 → **미구현** |
| samasound **하위 카테고리 전체 목록** | 342노드 트리는 확보했으나, 개별 상품이 어느 하위 카테고리에 속하는지는 breadcrumb 로만 확인(§3.5) |
| samamusic **표준/的소비자가** | `소비자가` 는 `specs` 에 문자열로 존재하나 `published_price` 와 별도 컬럼으로 승격하지 않음 |
| 4558 **목록↔상세 가격 불일치** | 원인 미확정(사이트의 목록 캐시/옵션 기준 차이로 추정). **상세/Dalue 기준 채택** |
| **대량 수집** | 이슈 지시("방법 검증 전 미수행")에 따라 **2,229 + 1,969 전량 수집은 수행하지 않음** (21건 샘플만) |

---

## 9. 제약 준수 기록

- 네이버 스마트스토어 등록/로그인/상품게시: **수행하지 않음**
- ERP 변경: **수행하지 않음**
- Google Drive 업로드: **수행하지 않음**
- 제3자 계정/로그인 접근: **없음** (Dalue `apiKey` 는 사이트 페이지에 공개된 값이며 로그인 불필요)
- 전체 사이트 무제한 요청: **위반하지 않음** (요청 0.2~0.3s 간격, 총 요청 수 百 단위)
- 타 모델 분석 결과 열람: **없음** (본 문서 수치는 전부 자체 실측. 하위 조사 에이전트가 발견한 4건 핵심 발견은 전부 재검증 후 채택)
- 영업/판매가·대리점 권한 추정: **없음** (`dealer_price_unverified` 는 전부 공란)
