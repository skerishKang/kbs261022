# 작업보고 — CGI 상품 카탈로그 HTML 사이트 (#11)

- **이슈**: [#11](https://github.com/skerishKang/kbs261022/issues/11) `[P0][DEMO][WEB] CGI 상품 카탈로그 HTML 사이트 및 기존 홈페이지 연결·스마트스토어 등록 준비`
- **일시·담당**: 2026-10-22 · CGI-1(김범신) / OpenCode (MiniMax M3.1 Flash) · 실브라우저 Tabbit Chromium 위 BrowserSkill
- **브랜치/산출물**: `site/` (카탈로그 사이트), `reports/cgi-catalog-work-report.md` (본 보고서), `site/docs/screenshots/` (실제 캡처 4종)

---

## A. 고객용 보고서

| 항목 | 작성 내용 |
|---|---|
| **작업 제목** | CGI 상품 카탈로그 웹사이트 1차 개발 (스마트스토어 개설 전 대체 시연) |
| **왜 했는가** | 네이버 스마트스토어 개설 전에는 "취급할 수 있는 상품"을 고객에게 보여줄 창구가 없었습니다. 공급처 공개 페이지에서 수집한 상품 정보를 **CGI 자체 이름과 출처를 표기한** 카탈로그로 먼저 제공하는 것이 목적입니다. |
| **무엇을 했는가** | ① 기존 삼아스토어 웹사이트를 **실제 브라우저로 분석**해 카테고리·검색·목록·카드·상세·옵션·가격·모바일 구성을 확인하고, ② 그 구조를 재사용한 **동작하는 정적 HTML/CSS/JS 카탈로그 사이트**를 만들었습니다(`site/`). ③ 시연 초기 데이터는 이미 공개된 수집 샘플(37건)을 사용했고, ④ 전체 수집 결과로 교체할 수 있는 데이터 로더를 함께 넣었습니다. |
| **확인된 결과** | 브라우저에서 실제 동작 확인: 검색 6건 필터링, 브랜드 필터 9건, 정렬(가격순), 페이지네이션 4페이지, 옵션 선택(길이 3그룹·품절 표기 포함), 원본 출처 링크, 모바일 2열 전환. **캡처 4종** (`site/docs/screenshots/`) — 데스크톱 목록/상세, 모바일 목록/상세. 깨진 이미지 0건. |
| **안 된 것 / 미확인** | ① 실제 주문·결제·장바구니 기능은 **구현하지 않았고 동작하지 않습니다**(스마트스토어 개설 전). ② **CGI가 실제로 취급·판매를 승인한 상품 목록은 아직 0건**입니다 — 화면의 모든 상품은 "수집 참고" 상태이며 승인 배지로 구분됩니다. ③ **공급가·재고·판매가는 미확정**이라 추정 금액을 넣지 않았습니다. ④ 실주소 배포는 도메인·호스팅 권한 확인 후 별도 진행입니다. ⑤ 기존 CGI 홈페이지에는 아직 링크를 연결하지 않았습니다(관리자 권한·개편업체 범위 확인 필요). |
| **다음 순서** | ① CGI 대표가 실제 취급 브랜드·상품 범위 확정 → `cgi_sale_status=approved` 로 승인 목록 반영 ② 공급가 정본 수령 후 `cgi_dealer_price` 확정 ③ 네이버 스마트스토어 개설 → `naver_smartstore_mapping` 확정 후 등록 데이터 생성 ④ 그때 결제·주문 기능 활성화 ⑤ 도메인 권한 확인 후 실주소 배포 및 기존 홈페이지 연결 |
| **문서/PR** | 이슈 #11 · PR(별도) · `site/README.md`(실행·교체 방법) · `reports/cgi-catalog-work-report.md` |

---

## B. 1차 개발 기준 — 기존 삼아스토어 사이트 실측 분석

BrowserSkill(Tabbit Chromium)로 **실제 브라우저에서** 확인한 값이다. 추정 아님.

### B1. 공통 구조

| 요소 | 실측 결과 |
|---|---|
| 플랫폼 | CAFE24 G2G(`_wg` 스킨), mall id `sama2015` (canonical `samastore.co.kr`) |
| body 클래스 | `pc` / `mobile` (user-agent 기준 서버 판별) |
| 상단 카테고리 LNB | `#category-lnb` > `ul.d1-wrap.d_ratio` > `li.d1` 11개 → `/product/list.html?cate_no={N}` |
| 11개 카테고리 | 프로모션 보기(1152) · 브랜드(24) · 마이크(84) · 스피커(42) · 이어폰/헤드폰(25) · 레코딩/음향(28) · 악기/앰프(379) · Hi-Fi(1038) · 케이블/커넥터(366) · 소프트웨어(758) · 특가상품(97) |
| 검색 | `<form action="/shopSearch/search.html" method="get">` + `input#queryTop[name=query]` + hidden `keyword` |
| 상품 목록 | `ul.xans-element.xans-product.xans-product-listnormal.ec-base-product.normal` > `li[id^=anchorBoxId_][data-price="^NNNNN"].item.DB_rate.xans-record-` |
| 카드 구성 | `.thumbnail`(좋아요/장바구니/새창/옵션/관심상품) + `a > .add_thumb > img#eListPrdImage{no}_1` + `.description`(상품명 · 상품요약설명 · 상품간략설명 · **판매가 : NNN,000원** · 리뷰수) |
| 정렬 | `select#selArray` — 신상품(5) · 상품명(1) · 낮은가격(3) · 높은가격(4) · 제조사(2) · 사용후기(7) · 조회수(8) |
| 페이지네이션 | `?cate_no=42&page=N`, `ol > li > a.this/.other`, `a.last` = 11페이지 |

### B2. 데스크톱 / 모바일 레이아웃

| 항목 | 데스크톱 | 모바일 (iPhone 14 에뮬레이션, 390×844@3x) |
|---|---|---|
| 그리드 | **4열** | **2열** |
| 카드 폭 | 281px (이미지 281×281 정사각형, `object-fit: fill`) | 175px (이미지 175×175) |
| 컨테이너 폭 | 1221px | - |
| 카테고리 LNB | 표시 | **숨김** (대신 전체메뉴 버튼) |
| 사이드 카테고리 메뉴 | 표시 | 숨김 |
| 헤더 높이 | - | 100px (축약) |

### B3. 상품 상세

| 요소 | 실측 결과 |
|---|---|
| 상품명 | `h2.item_name` |
| 가격 | `<strong id="span_product_price_text">219,000원</strong>` + hidden `#product_price` |
| 기본정보 표 | `caption "기본 정보"` + `th[scope=row]/td` (상품명·판매가·브랜드·**모델명**·안전확인신고번호·적합인증번호·원산지·배송비·구매방법·배송주기) |
| 옵션 | `table caption="상품 옵션"` → `tr > th(길이선택) + td > select#addproduct_option_id_{id}_1` — 옵션값에 `(+3,000원)` 추가가, `5m [품절]` 품절 표기. 이어서 `tr > th(수량) + td > input#quantity[name="quantity[]"]` |
| 갤러리 | `.ThumbImage` 썸네일 ↔ `#big_img_box` 메인 이미지 JS 교환 |
| 탭 | 상세정보 · 구매안내 · 상품후기(N) · 상품문의(N) — 대응 블록 `#prdDetail` / `#prdReview` / `#prdQnA` |
| 결제 위젯 | 네이버페이 구매하기 · 찜하기 (별도 위젯) |

### B4. 1차 개발에 재사용한 것과 바꾸 않은 것

| 원본 동작 | CGI 사이트 | 비고 |
|---|---|---|
| 카테고리 LNB 11종 | **재사용** (구조·URL 파라미터·모바일 접기 동일) | |
| 검색 GET + query | **재사용** (파라미터를 `q` 로) | 서버는 `index.html?q=` |
| 4열/2열 그리드, 정사각형 이미지 | **재사용** | |
| 카드 정보 순서(상품명→요약→가격→리뷰) | **재사용** + 출처·승인배지 추가 | |
| 정렬 7종 | **재사용** (최근순/상품명/낮은가격/높은가격/브랜드 5종으로 축약) | 원본 '사용후기·조회수'는 데이터 미수집이라 제외 |
| 페이지네이션 첫/이전/숫자/다음/마지막 | **재사용** | |
| 상세 갤러리·제원표·옵션 선택 | **재사용** | |
| 상세 탭 4종 | **정보성 탭으로 재구성**: 상세정보 / 옵션 정보 / 출처·검증 / 스마트스토어 매핑(예정) | 주문성 탭(구매안내·후기)은 제외 |
| 네이버페이 구매하기 | **제외** → `CGI 문의하기`(비활성) + 미개설 안내 | 주문·결제 미구현 |
| 로고·상표·색상 | **복제하지 않음** — CGI 워드마크(CSS 전용) + 네이비/앰버 고유 색상 | |

---

## C. CGI 사이트 구현 내용

### C1. 파일 구성

| 경로 | 내용 |
|---|---|
| `site/index.html` | 목록 — 카테고리 LNB, 검색, 브랜드 필터, 정렬, "CGI 승인 상품만" 토글, 그리드, 페이지네이션 |
| `site/product.html` | 상세 — 갤러리, 가격 박스, 옵션, 기본정보, 4개 탭, 출처 링크, 미개설 안내 |
| `site/assets/style.css` | 스타일 (CGI 고유 색상, 반응형 1080/860/560) |
| `site/assets/data-loader.js` | 데이터 로더 · 정규화 · 가격 상태 어휘 |
| `site/assets/app.js` | 목록 렌더링 · 필터 · 검색 · 정렬 · 페이지네이션 |
| `site/assets/product.js` | 상세 렌더링 · 갤러리 · 옵션 · 탭 |
| `site/data/catalog.demo.json` / `.js` | 시연 데이터 37건 (JSON / 인라인) |
| `site/data/catalog.schema.json` | 데이터 계약 + 스마트스토어 매핑 규칙 |
| `site/tools/build_demo_catalog.py` | CSV → 카탈로그 JSON 생성기 |
| `site/docs/screenshots/` | 데스크톱/모바일 실제 캡처 4종 |

### C2. 데이터

- **시연 초기 데이터 = 기존 공개 샘플** : PR #6 `reports/data/samasound-samamusic-sample.csv`(20건) + PR #12 `reports/samples/product_master_sample.csv`(20건) → 중복 3건 제거 → **37건**(samamusic 20 / samasound 17), 브랜드 15종.
  - 원본 CSV 는 **읽기만** 했고 수정하지 않았다.
- **교체 구조** : `site/tools/build_demo_catalog.py` → `catalog.full.json` → `CGICatalog.load({ jsonUrls:['data/catalog.full.json', ...] })`. 계약은 `catalog.schema.json`.
- **가격 상태 4종** : `public`(숫자) / `inquiry_price`(공급처 문의) / `missing` / `sold_out_sale_completed`. 숫자가 아닌 경우 **추정하지 않고 상태로만** 표시한다.
- **수집 vs 승인 구분** : 카드의 `CGI 승인 전` 배지, `CGI 승인 상품만` 필터, `cgi_sale_status=approved` 집합(현재 0건).
- **옵션** : PR #12 의 구조화된 `option_summary` 를 우선 사용(값·추인가·품절·품번). 원본 HTML 이 이어붙여져 경계를 확정할 수 없는 경우(예: 색상 선택 '블랙화이트월넛')는 쪼개지 않고 **원본 표기 그대로 + 경계 미확정 안내**로 표시한다.

---

## D. 검증 결과 (실브라우저)

Tabbit Chromium 위 BrowserSkill 세션으로 실제 실행해 확인했다.

### D1. 목록 페이지

| 항목 | 기대 | 실측 |
|---|---|---|
| 최초 렌더 | 상품 그리드 | 카드 12개 / 그리드 4열 / 페이지 4 |
| 총 상품 수 | 37 | `상품 37건 · 수집 37건 중 · CGI 승인 0건` |
| 깨진 이미지 | 0 | **0건** (12/12 로드) |
| 가격 표기 | 상태별 분기 | known 10 · inquiry 2 (1페이지 기준) |
| 카테고리 LNB | 11종 | 11종 + 수집 건수 배지(스피커 7, 악기/앰프 1, 케이블/커넥터 1) |
| 브랜드 필터 | 15종 | 15종 + 건수 |

### D2. 기능 동작

| 기능 | URL | 실측 |
|---|---|---|
| 검색 | `?q=presonus` | **6건**으로 필터링 (기존 37건 → 6건) |
| 브랜드 필터 | `?brand=Shure` | **9건**, 체크박스 checked 동기화 |
| 페이지네이션 | `?page=2` | 12건 표시, 현재 페이지 `2` 하이라이트 |
| 정렬 | `?sort=price_asc` | 최저가(NEUTRIK 커넥터) 먼저 |
| 승인 필터 | `?approved=1` | **0건 + 빈 상태 안내** (승인 상품 0건이므로 정상) |
| 미존재 상품 | `product.html?id=NOT_EXIST` | 안내 + 전체상품으로 돌아가기 버튼 |
| 모바일 | iPhone 14 에뮬레이션 | **2열 / 카드 175px / LNB 숨김 / 전체메뉴 버튼 표시** |
| 모바일 브랜드 필터 | 전체메뉴 옆 필터 토글 | 토글 버튼 표시 → 클릭 시 15개 체크박스 노출 |

### D3. 상세 페이지

| 상품 | 확인 내용 | 실측 |
|---|---|---|
| `samamusic.co.kr:974` (PreSonus Eris 3.5 GEN2) | 가격 219,000원 / 옵션 3그룹 | 값 4+3+5개, 추가가 `(+3,000원)` 등, `5m (+14,000원) [품절]`, 썸네일 7개, 4탭, 구성상품 3종 |
| `samasound.co.kr:3826` (Lunar 110 XA 10") | 가격 미공개 처리 | `가격 문의 (공급처 문의 필요)` + `pricebox inquiry` 클래스 |
| `samamusic:4558` (Q Acoustics Q M20) | ProductGroup / 색상옵션 | 가격 1,290,000원, 색상 선택은 경계 미확정으로 원본 표기 안내, `[품절]` 처리 없음 |
| 공통 | 출처·검증 탭 | 원본 사이트·상품ID·카테고리·원본 페이지 링크·수집방법·검증상태·출처근거 표시 |
| 공통 | 스마트스토어 매핑 탭 | 등록 상품명·카테고리·옵션구분·이미지 7건 + 등록가격/재고 `미확정` |
| 공통 | 주문·결제 | 장바구니/주문내역 비활성, `CGI 문의하기` 비활성, 주문·결제 미구현 안내 노출 |

### D4. 발견해 수정한 결함 (개발 중 실측)

| 결함 | 원인 | 조치 |
|---|---|---|
| 옵션 그룹에 케이블 상품명이 옵션명으로 표시됨 | PR#12 `addproducts`/`addproduct_options` 를 구분하지 않음 | `option_area` 유무로 옵션 그룹과 구성상품을 분리 |
| 옵션값이 "1m2m (+3,000원)3m …" 로 뭉침 | 원본 HTML 에서 선택지가 이어붙음 | PR#12 구조화 `option_summary` 를 우선 사용, 확정 불가 항목만 원본 표기 유지 |
| 모든 옵션에 [품절] 표시 | `use_soldout`(템플릿 플래그)을 품절로 오인 | 실제 근거는 `soldout_rendered` — 근거 코드로 수정 |
| 상세 첫 탭 본문이 비어 보임 | 첫 탭 패널의 `hidden` 해제 누락 | 첫 탭 패널 표시 처리 |
| 푸터 문장 좌측 잘림 | `.footer .wrap` 가 가로 패딩을 덮어씀 | 가로 패딩 복원 |
| 카드 "출처" 문자가 카드 밖으로 넘침 | 긴 도메인 문자열 비내보짐 | 짧은 출처명 + `overflow-wrap` |
| 모바일에서 브랜드 필터 접근 불가 | 사이드 박스 숨김 상태 | 모바일 전용 필터 토글 버튼 추가 |

---

## E. AI 공동검토용 기록

```text
PROJECT=CGI
ISSUE=11
PR=(이 PR)
REPOSITORY=skerishKang/kbs261022
WORK_DATE=2026-10-22
AGENT=OpenCode
MODEL=MiniMax M3.1 Flash (free tier)
DEVICE=CGI-1 (Windows 11, Tabbit Chromium 153 + BrowserSkill 0.3.3, bsk daemon 0.3.3)
OBJECTIVE=기존 삼아스토어 웹사이트를 실브라우저로 분석하고 그 구조를 재사용한 CGI 상품 카탈로그 HTML 사이트 1차 개발
INPUTS=
  - https://www.samamusic.co.kr/ (홈 · 목록 · 상세 · 모바일)
  - https://www.samasound.co.kr/ (가격 미공개 확인용)
  - PR #6 reports/data/samasound-samamusic-sample.csv (공개 샘플 20건, 읽기 전용)
  - PR #12 reports/samples/product_master_sample.csv (상품 마스터 20건, 읽기 전용)
  - PR #12 reports/samples/category_catalog_sample.csv (카테고리 카탈로그, 읽기 전용)
IMPLEMENTED=
  - site/index.html, site/product.html (정적 HTML)
  - site/assets/{style.css,data-loader.js,app.js,product.js}
  - site/data/{catalog.demo.json,catalog.demo.js,catalog.schema.json}
  - site/tools/build_demo_catalog.py (CSV → 카탈로그 JSON)
  - site/docs/screenshots/*.png (4종 실제 캡처)
  - reports/cgi-catalog-work-report.md (본 문서)
EXECUTION_EVIDENCE=
  - bsk doctor 8/8 ok, daemon pid 27816 ws://127.0.0.1:52800, extension 008fca49 connected
  - bsk session(llpg)로 http://127.0.0.1:8808 실제 로드 후 evaluate 로 DOM/레이아웃 실측
  - 목록 6케이스(기본/검색/브랜드/2쪽/승인필터/정렬) + 상세 4케이스(974/3826/4558/존재하지않음) 실측
  - iPhone 14 에뮬레이션으로 2열·175px·LNB 숨김·필터토글 확인
  - 캡처: site/docs/screenshots/{desktop-list,desktop-detail,mobile-list,mobile-detail}.png
  - 로컬 서버: python -m http.server 8808 --directory site
TESTS=
  - 목록 렌더/검색/브랜드필터/정렬/페이지네이션/승인필터/빈상태 — 7/7 통과
  - 상세 4케이스(가격 공개/가격 문의/ProductGroup/존재하지않음) — 4/4 통과
  - 모바일 2열 전환·LNB 접기·필터 토글 — 3/3 통과
  - 깨진 이미지 0건 (목록 12/12 로드)
  - 옵션 값/추가가/품절/품번 원본 대조 — 974·2454 일치 확인
OBSERVED_FACTS=
  - 원본 11개 LNB 카테고리, 목록 21건/페이지, 데스크톱 4열(카드 281px), 모바일 2열(175px)
  - 원본 정렬 select#selArray 7종, 페이지 ?cate_no=N&page=P
  - 원본 상세 옵션 select#addproduct_option_id_{id}_1, 추가가 "(+N원)", 품절 "[품절]"
  - samasound 는 공개 가격 없음(가격 문의) → 본 사이트에서도 숫자 미표시
MODEL_CLAIMS_NOT_INDEPENDENTLY_VERIFIED=
  - "PR #12 의 option_summary 가 전체 상품에 대해 구조화되어 있다" → 샘플 37건 범위에서만 확인
  - "향후 전체 수집 결과가 나오면 그대로 로더에 넣으면 된다" → 교체 경로는 시연 데이터로 1회 시연만 함
LIMITATIONS=
  - 실주소 배포 없음(도메인/호스팅 권한 미확인) / 기존 CGI 홈페이지 미연결(관리자 권한 확인 필요)
  - 실주문·결제·장바구니 미구현(스마트스토어 개설 전이므로 의도적 제외)
  - 승인 상품 0건 — CGI 대표의 실제 취급 범위 확정 필요
  - 원본 이미지 호스팅은 외부 CDN(samamusic.co.kr) 참조 — 원본 삭제 시 깨짐
OUTPUTS=site/, reports/cgi-catalog-work-report.md, site/docs/screenshots/
MERGED=NO
DEPLOYED=NO
LIVE_VERIFIED=YES (로컬 http://127.0.0.1:8808 실브라우저 검증)
REMAINING=
  - CGI 실제 취급/판매 승인 목록 확정 → cgi_sale_status=approved 반영
  - 공급가 정본 수령 → cgi_dealer_price 확정
  - 네이버 스마트스토어 개설 → naver_smartstore_mapping 확정 후 등록 데이터 생성
  - 주문·결제 기능 구현(스토어 개설 후)
  - 실주소 배포 + 기존 CGI 홈페이지 링크 연결
NEXT=
  - 대표 확정(취급 범위·공급가) → 승인 목록 반영 → 전체 수집 결과 연결 → 스토어 등록 데이터 생성 → 결제 → 배포
```

---

## F. 미확정 · 남은 조건

| 항목 | 상태 |
|---|---|
| CGI 실제 취급·판매 승인 상품 목록 | **미확정** — 대표 확정 필요. 현재 전 상품 `CGI 승인 전` |
| 공급가(대리점가) | **미확정** — 원본에 없음. 추정 금액 미표시 |
| CGI 재고 | **미확정** — 원본몰 재고와 무관 |
| 전체 상품 수 | 시연 37건(공개 샘플 기준). 전체 1,969+2,229건 수집은 Issue #5/#8 진행 중이며 미수행 |
| 실주소 도메인 | **미확인** — 인프라·권한 확인 후 진행 |
| 기존 CGI 홈페이지 연결 | **미연결** — 관리자 권한·개편업체 범위 확인 필요 (Issue #11 §1) |
| 사이트 UI 2차 독창 디자인 | **의도적 미착수** — 지시대로 1차는 기존 구조 재사용에 집중 |
