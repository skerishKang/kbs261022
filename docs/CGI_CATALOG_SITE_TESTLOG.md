# 개발·검증 기록 (AI용) — CGI 상품 카탈로그 사이트 (이슈 #11)

> 실행 환경: CGI-1 / Windows 10.0.22631 / Node v24.20.0 / Python 3.13 / Playwright-core(Chromium 1248, `ms-playwright`)
> 기록: 2026-10-22 · 브랜치 `feature/issue-11-catalog-site` · 이슈 #11

## 1. 착수 전 확인(다른 에이전트 작업과의 경계)

| 확인 대상 | 확인 결과 | 본 작업에서의 처리 |
|---|---|---|
| 이슈 #5 / PR #6 (Model A 분석) | open. 브랜치 `research/model-a-site-analysis` 에 샘플 CSV 20행 | **수집기 미수정.** CSV 는 입력 데이터로만 사용 |
| PR #13 (Model A 재분석) | open. 브랜치 `feature/issue-5-site-analysis-model-a` 에 `reports/sample-products.json` 21건 | 입력 데이터로만 사용(수정 없음) |
| PR #12 (Model B + 상품 마스터) | open. 브랜치 `feature/site-analysis-model-b` 에 상품 마스터 CSV 20건 + 스키마 + 수집 스킬 | **수집 스킬·스키마 미수정.** CSV/카테고리 카탈로그만 입력으로 사용 |
| 이슈 #8 (상품 마스터 설계) | open (다른 에이전트 작업 중, `tools/product_master/` 파일이 공유 트리에 미커밋으로 존재) | **미수정·미복사.** 본 작업은 표시 계층만 담당 |
| PR #10 (작업보고 체계) | open. `docs/CGI_WORK_LOG_INDEX.md`·`docs/CGI_WORK_REPORT_STANDARD.md` 가 main 미병합 | 형식만 참조해 따랐고, 해당 파일은 **수정하지 않음**. 요약은 이슈 #11에 남김 |
| 이슈 #7 (CGI-1→COM1 전달) | open (별도 브랜치에서 진행 중) | 본 작업과 무관 |
| 공유 working tree | 다른 에이전트가 `C:\Users\sji\cgi-work\kbs261022` 를 사용 중 | **별도 worktree** `C:\Users\sji\cgi-work\wt-issue11` + 별도 브랜치에서 작업. 공유 트리 파일 미변경 |

> 충돌 방지: `git worktree add -b feature/issue-11-catalog-site C:\Users\sji\cgi-work\wt-issue11 origin/main`
> (`origin/main` = README + .gitignore 만 있는 상태. 다른 브랜치의 `docs/`, `reports/`, `tools/` 경로와 겹치지 않는 파일만 추가)

## 2. 참고 사이트 조사(브라우저 실측)

탭비트(Tabbit, Chromium 자동화)로 `https://www.samamusic.co.kr/` 를 직접 열어 확인했다.

| 조사 항목 | 실측 결과 |
|---|---|
| 상위 카테고리 | 프로모션 보기(1152) / 브랜드(24) / 마이크(84) / 스피커(42) / 이어폰·헤드폰(25) / 레코딩·음향(28) / 악기·앰프(379) / Hi-Fi(1038) / 케이블·커넥터(366) / 소프트웨어(758) / 특가상품(97) |
| 검색 | `GET https://www.samamusic.co.kr/product/search.html`, input `name=keyword` |
| 목록 URL | `/product/list.html?cate_no=<id>&page=<n>&sort_method=<n>` |
| 정렬 값 | 5 신상품 / 1 상품명 / 3 낮은가격 / 4 높은가격 / 2 제조사 / 7 사용후기 / 8 조회수 |
| 목록 카드 구조 | `li.item`(data-price) + `div.thumbnail` + 위시/새창 버튼, 카드당 상세 링크 2개(페이지당 80 anchors) |
| 상세 URL | `/product/detail.html?product_no=<id>&cate_no=<n>&display_group=1` |
| 상세 스펙 구성 | 상품명 / 판매가 / 브랜드 / 모델명 / 상품요약정보 / 원산지 / 배송비 / 구매방법 / 배송주기 / 옵션선택 |
| 모바일 390px | 검색창 기본 비노출, 카테고리 목록 동일, 배너 슬라이드(‹ ›), 하단 고정 내비(전체상품목록 바로가기) |
| 추가 확인 | 상단 유틸(슈어스토어·삼아사운드·자료실·로그인·MY·장바구니·관심상품·주문조회·적립금·좋아요·쿠폰관리), 별도 도메인 `samastore.co.kr` 링크 존재 |

→ 본 카탈로그는 **탐색 방식**(상단 카테고리, 상단 검색, 카드 그리드, 정렬, 페이지네이션, 상세 스펙, 모바일 축약)을 참고하되
삼아스토어 상표·로고·레이아웃을 복제하지 않고 CGI 고유 디자인(인디고/앰버)으로 구현했다.

## 3. 데이터 준비

| 단계 | 내용 |
|---|---|
| 원본 확보 | `git show origin/<branch>:<path>` 로 PR #13/#12 샘플을 바이트 보존 추출(PowerShell `>` 리다이렉트는 UTF-16이 되어 깨지므로 cmd 경유) |
| 정규화 | `tools/build_catalog_data.py` — 사이트 키 통일(`samasound`↔`samasound.co.kr`), 사이트명이 브랜드칸에 들어온 행 제거, 브랜드 대소문자 정규화, 상대 이미지 URL 절대화, 가격 문자열→숫자+상태, 스펙/옵션/카테고리 구조화, 카테고리 ID로 `category_catalog_sample.csv` 조인 |
| 산출 | `site/data/products.json` 39건 / `site/data/products.js`(`window.CGI_PRODUCTS` + `window.CGI_PRODUCT_META`) |
| 표시 수량 원칙 | 메인 화면 "표시 중인 상품 39건(공개 수집 샘플)" / "공급처 카탈로그 규모: 삼아사운드 2,229건 · 삼아스토어 1,969건 — 공급처 전체 규모이며 CGI 판매 가능 수량 아님" 으로 **분리 표기** |

## 4. 구현

| 파일 | 내용 |
|---|---|
| `site/index.html` | SPA 셸(헤더 검색·내비·안내바·푸터 출처), favicon data-URI |
| `site/product.html` | `?id=<id>` → `index.html#/product/<id>` 전환 래퍼(기존 홈페이지 연결용) |
| `site/assets/css/cgi-catalog.css` | 반응형(1920/1440/1200/900/820/640/390), 이미지 placeholder, 스티커 헤더, 모바일 필터 토글 |
| `site/assets/js/cgi-catalog.js` | 데이터 로더(`?data=` 교체 지원), 검색(상품명·모델·브랜드·카테고리·스펙), 브랜드/카테고리/공급처 필터, 정렬 4종, 페이지네이션 12/page, 해시 라우팅, 갤러리, 이미지 오류 대체, 빈 결과 |
| `tools/build_catalog_data.py` | 데이터 재생성(전체 카탈로그 전환 경로) |
| `tools/verify_catalog_site.mjs` | Playwright 17항목 검증 + 스크린샷 + JSON 리포트 |

## 5. 브라우저 검증 결과 (2026-10-22, 17/17 PASS)

실행: `python -m http.server 8848 --directory site` + `node tools/verify_catalog_site.mjs`
리포트: `docs/CGI_CATALOG_SITE_TESTLOG.json` · 스크린샷: `docs/screenshots/issue-11/`

| # | 항목 | 결과 | 근거 요약 |
|---|---|---|---|
| 1 | 메인 페이지 표시 | PASS | h1 "CGI 상품 카탈로그", 요약 카드 4개, 상품 카드 8개, 브랜드/카테고리 칩 42개 |
| 1b | 전체 상품 목록 표시 | PASS | 카드 12개(1페이지), 필터 그룹 3개 |
| 2 | 상품 검색 | PASS | "SHURE" 검색 → 39건 중 8건, 표시된 카드 브랜드 전부 SHURE |
| 3 | 브랜드 필터 | PASS | ALLEN&HEATH 체크 → `?brand=ALLEN%26HEATH`, 1건, 적용 필터 칩 1개 |
| 4 | 카테고리 필터 | PASS | "Hi-Fi 케이블" 체크 → 1건, 적용 필터 칩 1개 |
| 5 | 실제 상품 이미지 표시 | PASS | 홈 카드 이미지 8/8 `naturalWidth>0` (samamusic.co.kr 실제 URL) |
| 6 | 상품 상세페이지 이동 | PASS | 카드 클릭 → 상세, 스펙 14행, 썸네일 3개, 원본 링크 존재 |
| 6b | 상세 → 목록 복귀 | PASS | "← 목록으로 돌아가기" 동작 |
| 10 | 가격 미확인 상품 처리 | PASS | 삼아사운드 상품 상세에서 "가격 문의" + 안내 문구 표시 |
| 10b | 공개 판매가 상품 병존 | PASS | 데이터 내 공개 판매가 18건 |
| 8 | 빈 검색 결과 | PASS | "검색 결과가 없습니다" + 필터 초기제 버튼, 카드 0개 |
| 9 | 잘못된 이미지 URL 처리 | PASS | 깨진 URL 지정 → "이미지 없음" 대체 표시 |
| 7a | 모바일 메인(390px) | PASS | 검색창 노출, 1열 그리드, 가로 스크롤 없음 |
| 7b | 모바일 필터/목록 | PASS | 필터 토글 동작, 브랜드 20개 패싯, 가로 스크롤 없음 |
| 7c | 모바일 검색 | PASS | 8건 결과, 가로 스크롤 없음 |
| 7d | 모바일 상세페이지 | PASS | 제목·스펙 11행, 가로 스크롤 없음 |
| 12 | 태블릿(820px) | PASS | 2열 그리드, 가로 스크롤 없음 |
| 13 | 콘솔 JS 오류 없음 | PASS | pageerror 0건, 콘솔 오류 0건(의도적 깨진 이미지 오류 제외) |

스크린샷 14장: `01-home-desktop-1440`, `02-list-desktop-1440`, `03-search-shure-desktop-1440`, `04-brand-filter-desktop-1440`, `05-category-filter-desktop-1440`, `06-detail-desktop-1440`, `07-empty-result-desktop-1440`, `08-broken-image-desktop-1440`, `09-home-mobile-390`, `10-list-mobile-390`, `11-search-mobile-390`, `12-detail-mobile-390`, `13-list-tablet-820`, `14-inquiry-price-detail-desktop-1440`

## 6. 개발 중 발견·해결한 문제

| # | 증상 | 원인 | 해결 | 위치 |
|---|---|---|---|---|
| 1 | 페이지 로드 시 `loadProducts(...).then is not a function` TypeError, 화면이 "불러오는 중"에 멈춤 | 내장 데이터 경로가 배열을 반환해 Promise가 아님 | 동기 경로도 `Promise.resolve()` 로 감싸기 | `site/assets/js/cgi-catalog.js` |
| 2 | 브랜드/카테고리 체크박스를 눌러도 URL은 바뀌지만 화면이 필터링되지 않음 | 필터 DOM 속성 `data-facet="brand"` 와 상태 필드명 `brands` 불일치로 `next[facet].slice()` 에서 예외 | `facetKey` 매핑 테이블로 필드명 정규화 | `site/assets/js/cgi-catalog.js` |
| 3 | 모바일에서 "필터 열기" 를 눌렀더니 필터가 사라짐 | 필터 패널이 처음부터 펼쳐진 상태라 토글 동작이 반대로 동작 | 900px 미만에서는 렌더 시 패널을 접힌 상태로 시작 | `site/assets/js/cgi-catalog.js` |
| 4 | 콘솔에 `404 /web/upload/NNEditor/.../buy_banner.png` | 수집 데이터에 **공급처 상대 경로** 이미지 URL이 섞여 있었고, 로컬 서버 기준으로 해석됨 | 빌더에서 상대 경로를 공급처 절대 URL로 정규화 | `tools/build_catalog_data.py` |
| 5 | 데이터 CSV 를 PowerShell `>` 로 추출하자 JSON 파싱 실패 | PowerShell 5.1 의 `>` 가 UTF-16(BOM) 로 기록 | `cmd /c "git show … > file"` 로 바이트 보존 추출 후 Python UTF-8 로 읽기 | 작업 절차 |
| 6 | "공급처 카탈로그 규모" 가 하위 카테고리 건수(46)로 표시 | 카테고리 카탈로그의 같은 사이트 행 중 마지막 값을 사용 | 사이트별 최대(최상위) 등록 건수 사용 + 출처 주석 병기 | `tools/build_catalog_data.py` |

## 7. 미실행(이번 작업 범위 밖)

- 전체 카탈로그 수천 건 표시(수집 결과 미수령)
- 실사이트 배포 및 기존 홈페이지 버튼 연결(협의 필요)
- 네이버 스마트스토어 개설·상품 게시·주문·결제, 이카운트 ERP 변경
- CGI 판매가 승인 절차, 이미지 자체 호스팅
