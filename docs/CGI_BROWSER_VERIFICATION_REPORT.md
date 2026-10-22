# ZCode 내장 브라우저 실측 검증 보고서

> 이슈 #8 · 대상: `https://www.samasound.co.kr/` , `https://www.samamusic.co.kr/`
>
> **도구**: ZCode 공식 `browser-use` 플러그인의 `control-browser` 스킬 +
> ZCode In-app Browser(IAB) 백엔드. MCP `mcp__node_repl__js` 로만 구동했다.
>
> **실측 일시**: 2026-10-22 (UTC 기준 `extraction_time` 은 레코드에 기록)
>
> **독립성**: OpenCode 의 BrowserSkill 분석 결과를 복사하지 않았다.
> 아래 모든 값은 이 세션에서 ZCode 브라우저로 직접 열어 확인한 것이다.

---

## 1. 브라우저 가용성 확인

```
agent.browsers.list()
→ [{ "id": "iab:a776290b-…", "type": "iab",
     "name": "ZCode In-app Browser",
     "capabilities": { "browser": [ { "id": "visibility", … } ] } }]
```

| 항목 | 결과 |
|---|---|
| `control-browser` 스킬 | 활성 (`browser-use:control-browser`) |
| Browser Use 도구 | 활성 (`mcp__node_repl__js`) |
| 사용 가능 백엔드 | `iab` (ZCode In-app Browser) 1개 |
| 확장 백엔드(`extension`/`cdp`) | 없음 — 존재하지 않으므로 사용하지 않음 |
| 캡처 | `visibility` (패널 표시/숨김) |
| 탭 | `tabs.new` / `tabs.list` / `tabs.get` / `finalize` 지원 |

**BROWSER_USE = PASS**

---

## 2. samasound.co.kr (삼아사운드) 실측

### 2.1 사이트 구조

| 항목 | 관찰값 | 확인 방법 |
|---|---|---|
| 상점 | Cafe24 `cafe24_samassi_1` 계열, B2B | 상세 스펙행 |
| 홈 카테고리 | `제품 정보` = `cate_no=23` | 홈 내비게이션 링크 |
| 브랜드별 보기 | `cate_no=24` → 알파벳 그룹 6개 | 목록 페이지 좌측 메뉴 |
| 제품분류별 보기 | `cate_no=25` | 목록 페이지 좌측 메뉴 |
| 알파벳 그룹 | A-C `320`, D-G `332`, H-K `338`, L-O `344`, P-R `351`, S-Z `364` | 각 그룹 목록 페이지 |
| 브랜드 개수 | **49개** (그룹 하위 cate_no) | 6개 그룹 페이지 순회 |
| 전체 상품 | `cate_no=23` 기준 112 페이지 (페이지당 20) | 목록 페이지 페이지네이션 |
| 상세 URL | `/product/{slug}/{product_no}/category/{c}/display/{d}/` | 목록 링크 |
| canonical | `https://samasound.co.kr/product/{slug}/{product_no}/` (www 없음) | `link[rel=canonical]` |
| `판매가` | 전량 **"가격 문의"** (숫자 없음) | 상세 스펙행 |
| 옵션 영역 | 표본 15건 전부 **빈 옵션** (`.xans-product-option` 비어 있음) | 상세 DOM |
| 목록 가격 | **표시 없음** — 가격 텍스트 0건 | 목록 전체 스캔 |

### 2.2 브랜드 → `cate_no` 매핑 (브라우저로 확인, 49개)

| 그룹 | 매핑 |
|---|---|
| A-C (320) | AGS 427, Allen&Heath 44, APOGEE 322, AROBAS MUSIC 323, ARTURIA 324, AudioScape 325, Celemony 329, CLOUD 330, COMPLY 331, Clear-Com 432 |
| D-G (332) | DYNAUDIO 333, FabFilter 335, Fidelice 431, GENELEC 43, GENZLER 336 |
| H-K (338) | HEXACHORDS 339, HK Audio 50, IK MULTIMEDIA 340, iMAG 53, iZotope 341, JICO 415, K&M 47, KLOTZ 343 |
| L-O (344) | Martin Audio 49, Matrix Audio 428, MERCURIALL 400, MESA/BOOGIE 346, NASH GUITARS 348, NATIVE INSTRUMENTS 349, Neutrik 45, NNNN 309, OVERLOUD 350 |
| P-R (351) | POSITIVE GRID 317, PRESONUS 352, PRIMACOUSTIC 353, Q Acoustics 354, QED 355, Q-SYS 417, RADIAL 48, REAN 46, RICKENBACKER 356, ROCK AND ROLL RELICS 401, ROSCOE GUITARS 357, ROTOSOUND 358 |
| S-Z (364) | Shure 42, TUTTLE GUITARS 347, Vaddio 360, VICOUSTIC 361, Waves 363 |

> 이 번호는 **samasound 안에서만** 의미가 있다. §4 참조.

### 2.3 상세페이지 스펙행 (실측)

`WL185MB/C-TQG` (product_no 3875) — `<table><caption>기본 정보</caption>` :

| 행 | 값 |
|---|---|
| 상품명 | WL185MB/C-TQG |
| 상품요약정보 | 단일지향성 로우 프로파일 카디오이드 라발리에 컨덴서 마이크 |
| 상품간략설명 | SHURE 무선용 단일 지향성 핀마이크 블랙 |
| **제조사** | **Shure** |
| 원산지 | 아시아 중국 |
| **판매가** | **가격 문의** |
| 구매방법 / 배송주기 | 1회구매 정기배송 할인 / 정기배송 할인 save 결제 시 : 할인 |

`Fender Studio Pro` (product_no 3733) — `제조사 = PreSonus`.
상품명 속 "Fender" 와 제조사가 다르다는 점이 확인된다.

`SLXD4D+` (product_no 3738) — `영문상품명 = SLXD4D+` 행이 추가로 존재.
`모델명` 행은 여전히 없다.

**samasound 에는 `브랜드` 행도 `모델명` 행도 없다.** → 마스터의
`brand` / `model` 은 `null` 로 유지한다.

---

## 3. samamusic.co.kr (삼아스토어) 실측

### 3.1 사이트 구조

| 항목 | 관찰값 | 확인 방법 |
|---|---|---|
| 상점 | Cafe24 `cafe24_sama2015_1` 계열, B2C | 상세 스펙행 |
| 최상위 카테고리 | 프로모션 1152, 브랜드 24, 마이크 84, 스피커 42, 이어폰/헤드폰 25, 레코딩/음향 28, 악기/앰프 379, Hi-Fi 1038, 케이블/커넥터 366, 소프트웨어 758, 특가상품 97 | 홈 내비게이션 |
| 브랜드별 | `cate_no=24` 하위에 브랜드별 cate_no (424, 642, 643, 807, 1037, 768, 644, 822, 645, 769, 1226, 646, 647, 650, 805, 1093, 780, 1016, 652, 654, 655, 1111, 656, 657, 658, 659, 940, 660, 941, 661, 942, 662, 663, 1052, 1053, 665, 666, 667, 668, 669, 670, **671 (SHURE, 580건)**, 943, 674, 675, 784 …) | 브랜드 페이지 |
| 상세 URL | `/product/detail.html?product_no={N}&cate_no={M}&display_group={G}` | 목록 링크 |
| canonical | **`https://samastore.co.kr/product/{slug}/{product_no}/`** (수집 호스트 `www.samamusic.co.kr` 와 다름) | `link[rel=canonical]` |
| `판매가` | 실제 금액 | 상세 스펙행 |
| `브랜드` / `모델명` | 있음 | 상세 스펙행 |
| `적합인증번호` | 있음 (`R-R-SHU-SLXD4DE`, `R-R-SHU-MVX2U`) | 상세 스펙행 |
| 옵션 | 있음 — `길이선택`(1m/3m/5m/10m, 품절·추가금), `주파수대역`(X51/G64) | 상세 스펙행 |
| 목록 `data-price` | `5031000^4528000` (정상가^할인가) 또는 `^대리점 문의` (공개가 없음) | 목록 `<li>` 속성 |

### 3.2 목록 구조

`<li id="anchorBoxId_{product_no}" data-price="…" class="item DB_rate xans-record-">` 안에
`상품명` / `상품 요약설명` / `판매가` / `리뷰` 가 렌더링된다.

브라우저로 Shure(671) 카테고리 **8페이지 = 160건**을 순회해 목록을 확보했다.

### 3.3 상세페이지 스펙행 (실측)

`SHURE SM58 K-LC 슈어 보컬용 유선 마이크 (스위치없음)` (product_no 1299) :

| 행 | 값 |
|---|---|
| 상품명 | SHURE SM58 K-LC 슈어 보컬용 유선 마이크 (스위치없음) |
| **판매가** | **197,000원** |
| **브랜드** | **SHURE** |
| **모델명** | **SM58K-LC** |
| 상품요약정보 | 전설의 보컬용 다이나믹 마이크로폰 |
| 상품간략설명 | (스위치 없음) |
| 원산지 | 아시아 중국 또는 멕시코 |
| 배송비 | 3,000원 (50,000원 이상 구매 시 무료) |
| 길이선택 | 1m [품절] / 3m (+6,000원) [품절] / 5m (+10,000원) / 10m (+28,000원) |

**samamusic 에는 `제조사` 행이 없다.** → 마스터의 `manufacturer` 는 `null`.

---

## 4. `cate_no` namespace 충돌 — 실측 증거

같은 번호가 두 사이트에서 전혀 다른 카테고리를 가리킨다.

| `cate_no` | samasound | samamusic |
|---|---|---|
| **24** | 브랜드별 보기 (상위 모드) | 브랜드 |
| **25** | 제품분류별 보기 | 이어폰/헤드폰 |
| **42** | **Shure** | **스피커** |
| 23 | 전체보기 | — |
| 84 | — | 마이크 |
| 352 | PRESONUS | — |
| 662 | — | PRESONUS |
| 671 | — | SHURE |

→ `cate_no` 는 `namespace`(`samasound.cate_no` / `samamusic.cate_no`)와 **함께**만
사용한다. 마스터 스키마는 `category_namespace`, `category_path_cate_no`,
`category_leaf_cate_no` 세 컬럼으로 이를 강제한다.

---

## 5. 동일 제품 비교 (브라우저 실측 11쌍)

모든 값은 브라우저로 두 사이트 상세페이지를 각각 열어 확인한 것이다.
`→` 는 samasound → samamusic.

| # | 모델 | samasound | samamusic | samasound 가격 | samamusic 가격 | samasound brand/제조사 | samamusic brand/제조사 | samasound model | samamusic model | 판정 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | WL185MB/C-TQG | 3875 | 5557 | 가격 문의 | 279,000원 | – / Shure | SHURE / – | – | WL185MB/C-TQG | confirmed |
| 2 | SM35-XLR | 3874 | 5564 | 가격 문의 | 391,000원 | – / Shure | SHURE / – | – | SM35-XLR | confirmed |
| 3 | SM35-TQG | 3873 | 5563 | 가격 문의 | 234,000원 | – / Shure | SHURE / – | – | SM35-TQG | confirmed |
| 4 | SM31FH-TQG | 3872 | 5562 | 가격 문의 | 234,000원 | – / Shure | SHURE / – | – | SM31FH-TQG | confirmed |
| 5 | KSM32C 라이트 세트 | 3825 | 5490 | 가격 문의 | 1,370,000원 | – / Shure | SHURE / – | – | KSM32C/HM | confirmed |
| 6 | KSM32C 프리미엄 세트 | 3824 | 5491 | 가격 문의 | 1,510,000원 | – / Shure | SHURE / – | – | KSM32C/SM | confirmed |
| 7 | KSM40C | 3823 | 5492 | 가격 문의 | 1,830,000원 | – / Shure | SHURE / – | – | KSM40C | confirmed |
| 8 | KSM44MP | 3822 | 5493 | 가격 문의 | 2,280,000원 | – / Shure | SHURE / – | – | KSM44MP | confirmed |
| 9 | SLXD4D+ | 3738 | 5525 | 가격 문의 | 2,300,000원 | – / Shure | SHURE / – | – | – | confirmed |
| 10 | SLXD1+ | 3735 | 5513 | 가격 문의 | 640,000원 | – / Shure | SHURE / – | – | – | confirmed |
| 11 | MVX2U G2 | 3863 | 5611 | 가격 문의 | 237,000원 | – / Shure | SHURE / – | – | MVX2UG2 (2세대) | confirmed |

**자동 병합하지 않은 쌍 (2건, 모두 브라우저로 확인)**

| samasound | samamusic | 판정 | 브라우저로 확인한 사유 |
|---|---|---|---|
| KSM32C … **라이트 세트** (3825) | KSM32C … **프리미엄 세트** (5491) | candidate | 이름과 `모델명` 앞부분(KSM32C)은 같지만 세트 구성 라벨이 다르다 |
| KSM32C … **프리미엄 세트** (3824) | KSM32C … **라이트 세트** (5490) | candidate | 동일 |

**브라우저로 확인한 negative case**

| 비교 | 판정 | 사유 |
|---|---|---|
| samasound `WL93` (3868) ↔ samamusic `GLXD14R+/93 … WL93 포함` (4344) | no_candidate | samamusic 상품은 WL93 을 *포함*하는 세트. WL93 자체가 아니다 |
| samasound `SLXD4+` (3737) ↔ samamusic `SLXD4D+` (5525) | no_candidate | 접두 관계일 뿐 다른 모델 |

> 참고: samamusic 의 `WL93` 포함 상품은 목록 가격 1,457,000원,
> samasound 의 `WL93` 은 "가격 문의"다. 가격만 봐도 같은 상품이 아님을 알 수 있다.

---

## 6. 브라우저 ↔ HTTP 교차 검증 (요구사항 8)

브라우저가 실제 렌더한 값과, **같은 URL** 을 HTTP 로 다시 가져온 값이
필드 단위로 일치하는지 확인했다.

| 항목 | 결과 |
|---|---|
| 비교 레코드 | 29건 (브라우저 15 + samamusic 15, 1건은 양쪽 모두 존재하지 않음) |
| 비교 필드 | `name`, `brand`, `manufacturer`, `model`, `public_price`, `public_price_text`, `canonical_url`, `category_leaf_cate_no` |
| 완전 일치 | **29/29 (rate 1.0)** → **PASS** |
| 산출물 | `reports/data/crosscheck_report.json` |

브라우저에서만 잡히고 HTTP 에서 빠지는 필드가 없다는 뜻이다. 즉
**반복 수집은 HTTP 로 하고, 브라우저는 검증·예외 복구에 쓴다.**

### 6.1 HTTP 수집에서 확인한 함정 (직접 실측)

| 항목 | 결과 |
|---|---|
| UA `python-requests/2.34.2` | **403** (목록·상세 모두) |
| UA 브라우저/curl | **200** |
| UA 미지정(curl 기본) | 200 |
| `robots.txt` `/product/*` | 허용 (금지: `/api`, `/exec/front/`, `/member/`, `/myshop/`, `/protected/`, `/skin-*/`, 게시판 쓰기 경로) |
| `samamusic` `product_no=5523` | **404** — 브라우저에서도 상품명 없음. 존재하지 않는 id |

---

## 7. 수집량 · 예절

* 브라우저 요청: 홈 2 + 목록/카테고리 약 12 + 상세 30 + 재확인 1 ≈ **45회**
* HTTP 요청: **32회** (29 성공 + 1개 id 404 를 3회 재시도)
* HTTP 요청 간격: 호스트별 최소 **1.2초**, `robots.txt` 의 `Crawl-delay` 가 더 크면 그 값을 따름
* 로그인·계정·장바구니·주문 접근 없음
* `naver.com` / ERP / 스마트스토어 접근 없음
* 수집한 것은 공개 상품 페이지뿐이며, 계정·고객 정보·결제 정보는 수집하지 않았다

---

## 8. 원시 증거 위치

| 파일 | 내용 |
|---|---|
| `reports/data/_browser_dump_samasound.json` | samasound 15건 브라우저 원시 덤프 (스펙행 원문, 옵션, 이미지, canonical) |
| `reports/data/_browser_dump_samamusic.json` | samamusic 15건 브라우저 원시 덤프 |
| `reports/data/_http_dump.json` | 같은 29개 URL 의 HTTP 수집 원시 덤프 |
| `reports/data/product_master_sample.json` / `.csv` | 마스터 샘플 29건 |
| `reports/data/http_collected_sample.json` / `.csv` | HTTP 수집 마스터 29건 |
| `reports/data/crosscheck_report.json` | 교차 검증 상세 |
| `reports/data/dedupe_report.json` | 후보 13건 상세 + 그룹 11건 |

---

## 9. 남은 검증 과제

* samasound 의 Shure(42) 카테고리 2페이지 이후 상품은 미수집.
  브라우저 표본을 15건에서 늘리면 `confirmed` 쌍이 더 나온다.
* samasound 에는 `영문상품명` 이 있는 상품과 없는 상품이 섞여 있다.
  어떤 상품에 어떤 행이 있는지는 `SITE_FIELD_AVAILABILITY` 의
  `english_name` 항목으로만 표시되며, `model` 로 승격시키지 않았다.
* `availability`(재고) 는 두 사이트 모두 공개하지 않아 계속 `null` 이다.
  재고 확보가 필요하면 별도 수집 경로(유통/ERP) 설계가 선행되어야 한다.
* `dealer_price`(도매가) 는 공개 근거가 없다. B2B samasound 라서 문의해야 하며,
  공개 데이터로 채우지 않는다.
