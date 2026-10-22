# 작업보고 — CGI 회사 홈페이지 + 상품 쇼핑몰 통합 시연본 (issue #18 · 2차)

- **이슈**: [#18](https://github.com/skerishKang/kbs261022/issues/18) `[P0][WEB] CGI 기존 홈페이지 참고형 회사 홈페이지 시연본`
- **일시·담당**: 2026-10-22 · CGI-1(김범신) / OpenCode (MiniMax M3.1 Flash) · 실브라우저 Tabbit Chromium + BrowserSkill 0.3.3
- **브랜치**: `feature/issue-18-integrated-demo` (worktree `D:\1022\wt18`, origin/main **aeb5d37** 기반)
- **산출물**: `website/` · `site/config.js` + 쇼핑몰 복귀 링크 · `docs/CGI_DEMO_GUIDE.md` · `docs/CGI_DEPLOYMENT.md` · `docs/screenshots/integrated-demo/` 11종
- **이전 보고서**: `reports/cgi-company-website-work-report.md` (1차 개발) — 이번 보고서가 그 후속이며, 1차의 실측값과 이번 재실측값을 구분해 기재합니다.

---

# A. 고객용 보고서

| 항목 | 작성 내용 |
|---|---|
| **무엇을 만들었는가** | **회사 홈페이지와 상품 쇼핑몰이 서로 이동 가능한 하나의 통합 시연본**입니다. 홈페이지는 ㈜시지아이 회사 소개·사업 4가지·연혁·취급 브랜드·시공/렌탈 실적·문의·위치도를, 쇼핑몰은 공급처 공개 수집 샘플 39건의 검색·브랜드 필터·목록·상세·옵션·가격 표시를 제공합니다. |
| **기존 홈페이지에서 무엇을 가져왔는가** | 회사가 이미 갖고 계신 자료에서만 가져왔습니다. ① 메뉴 구조(ABOUT/PRODUCTS/REFERENCE/SUPPORT)와 "대분류 배경 검정" 요구는 **홈페이지 제작 요청서**, ② 회사 소개·사업 4가지·연혁·납품 실적·연락처는 **공식 카다로그 8P**, ③ 회사 개요·주소 111호는 **사업자등록증명**과 **2017 회사소개서**, ④ 대표 이미지·사진·위치도는 **기업홍보용 자료**, ⑤ 취급 브랜드는 **Issue #5 실측**입니다. 확인되지 않은 정보는 새로 만들어 넣지 않았습니다. |
| **어떻게 쇼핑몰과 연결되는가** | **양방향입니다.** 홈페이지 → 쇼핑몰: "제품 보기" 5곳 + 브랜드 칩 36개(딥링크). 쇼핑몰 → 홈페이지: 상단 메뉴 + 푸터 + **상품 상세 브레드크럼** 3곳. 경로는 `website/assets/config.js` / `site/config.js` **2곳에서만** 관리합니다. |
| **실제 화면 캡처** | `docs/screenshots/integrated-demo/` 11종 — 홈페이지 5(1920/1440/820/390/모바일메뉴) + 쇼핑몰 6(1920 목록/브랜드필터/상세/모바일목록/모바일상세/빈결과). |
| **앞으로 Excel 상품 DB와 어떻게 연결되는가** | **연결 경로를 이미 준비했습니다.** 홈페이지가 쇼핑몰 데이터(`site/data/products.js`)를 읽어 브랜드·건수를 자동 표시하므로, 이슈 #19의 전체 4,575건 마스터가 교체되면 **양쪽 코드를 손대지 않고** 자동 반영됩니다. 대체 파일 지정(`?data=`) 방식도 실측 확인했습니다. |

---

# B. 개발용 보고서

## B1. 기존 CGI 홈페이지 조사 (1차와 동일 — 요약)

기존 홈페이지 `https://cgiinc.kr` 는 **현재 접속 불가**입니다 (HTTPS → Cloudflare 521, HTTP → 오리진이 "도메인 셋팅이 잘못 되었습니다" 반환). 실브라우저로 확인했습니다.
저장소 문서·이슈 19개·PR 본문에 주소가 없어 **추정하지 않고**, CGI-1 브라우저 기록에서 `cgiinc.kr` · `cgi@cgiinc.kr` · `blog.naver.com/cgiinc` · `\\cgibusiness` 공유폴더 를 근거로 확보했습니다.
회사 실체는 **㈜시지아이 (CGI Inc)**, 대표이사 **김범신**(사업자등록증명·회사소개서·저장소 소유자 일치).
상세는 1차 보고서 §B1·§B2 를 참고하세요.

## B2. main 확인 & 다른 에이전트 진행 파일

| 대상 | 확인 결과 |
|---|---|
| `origin/main` | **aeb5d37** = PR #17(쇼핑몰) + PR #22(홈페이지) 병합본. 이번 브랜치는 이 위에서 시작 |
| `site/` (PR #17) | **참조만**. 이번에 **복귀 링크 추가만** 했고 기능 삭제는 없음 |
| `tools/build_catalog_data.py` (PR #17) | **참조만**. 수집기·Excel 생성기는 새로 만들지 않음 |
| `docs/CGI_CATALOG_SITE*.md` (PR #17) | **참조만** (배포 경로 §6 근거) |
| 진행 중 PR #12·#13·#15·#16·#21·#23 | `site/` 를 건드리지 않음 (파일 충돌 없음) |
| 이슈 #19 (전체 상품 XLSX) | 진행 중 · 산출물 미도착. **연결 경로만** 준비 |

## B3. 통합 화면 정리 — 구현 내역

| 요구 항목 | 구현 | 검증 |
|---|---|---|
| **회사 홈페이지 → 쇼핑몰** | "제품 보기" 5곳 + 브랜드 칩 36개 | 실제 클릭 이동 확인 |
| **쇼핑몰 → 홈페이지 복귀** (1차 미구현) | **신규**: `site/config.js` + 상단 메뉴 "회사 홈페이지" + 푸터 링크 + **상품 상세 브레드크럼 "← 회사 홈페이지"** | 3곳 모두 실제 클릭 이동 확인 |
| **브랜드 검색·필터** | 쇼핑몰 `?brand=SHURE` 필터 + **홈페이지 브랜드 칩 좁히기 입력**(신규) | SHURE 8건 표시 / K&M 정상 빈 화면 / 홈페이지 "shure" 입력 → 1개만 노출 / 무일치 → 안내 문구 |
| **상품 목록·상세** | 기존 PR #17 구현 (갤러리·가격·제원·옵션·출처) | 정상 |
| **모바일 반응형** | 1920/1440/820/390 | 가로 넘침 0 · 깨진 이미지 0 · 터치영역 24px 미만 0 |
| **회사 소개·연락처·위치도** | 소개 / 사업 4가지 / 연혁 12건 / TEL·FAX / **회사 제공 위치도 이미지** | 111호 4곳 일치, 104호 0건 |

### 새로 추가한 것 (1차 대비)

| 추가 | 위치 | 이유 |
|---|---|---|
| 쇼핑몰 → 홈페이지 복귀 링크 3곳 | `site/index.html`(헤더·푸터), `site/assets/js/cgi-catalog.js`(상세 브레드크럼) | 1차 보고서에서 "미구현"으로 남긴 항목 |
| 쇼핑몰 연결 설정 파일 | `site/config.js` (신규) | 배포 경로를 **한 곳**에서 관리 (홈페이지 `config.js` 와 대칭) |
| 설정 적용 훅 | `site/assets/js/cgi-catalog.js` `applySiteConfig()` | `config.js` 값으로 복귀 링크 일괄 적용. HTML 기본값이라 JS 없이도 동작 |
| 터치영역 보정 | `site/assets/css/cgi-catalog.css` | 모바일 최소 24px (nav 48px / 푸터 33px / 상세 브레드크럼 28px) |
| 홈페이지 브랜드 칩 좁히기 | `website/index.html` + `website/assets/main.js` + `style.css` | 브랜드 36칸을 텍스트로 빠르게 필터 |
| 고객 시연 안내 | `docs/CGI_DEMO_GUIDE.md` (신규) | 대표님 확인용 |
| 배포 설정·도메인 필요정보 | `docs/CGI_DEPLOYMENT.md` (신규) | 실주소 배포 준비 |

## B4. 쇼핑몰 라우팅 규칙 교정 (중요)

PR #17 병합본 쇼핑몰은 **해시 라우터**입니다. 1차 개발 때 사용한 `?brand=Shure` 형태로는 **동작하지 않습니다**.

| 라우팅 | 값 |
|---|---|
| 홈 | `index.html#/` |
| 전체 목록 | `index.html#/products` |
| **브랜드 필터** | `index.html#/products?brand=SHURE` (쉼표로 다중) |
| 상품 상세 | `index.html#/product/<id>` (`id` 는 URL 인코딩: `samamusic.co.kr%3A4167`) |

`brand` 값은 쇼핑몰의 **`brand_norm`(대문자 정규화)** 기준이라 홈페이지 칩도 `toUpperCase()` 로 동일 규칙을 적용했습니다
(Shure→`SHURE`, Q Acoustics→`Q ACOUSTICS`, Allen&Heath→`ALLEN&HEATH`).

## B5. 전체 상품 DB(#19) 연결 구조 — 확인 완료

```
공통 상품 마스터 (이슈 #19 산출물: 전체 4,575건 CSV/XLSX)
        │  python tools/build_catalog_data.py --master-csv <전체마스터.csv> \
        │                                 --sample-json <샘플.json> --categories <카테고리.csv>
        ▼
site/data/products.json  +  site/data/products.js   (window.CGI_PRODUCTS)
        │
        ├─▶ 상품 쇼핑몰   : 목록·브랜드/카테고리/공급처 필터·상세 자동 확장
        ├─▶ 회사 홈페이지 : 브랜드 칩 36개 → 데이터 보유 20종 → 전체로 자동 확장
        └─▶ 추후 네이버 스마트스토어 등록 : 동일 마스터에서 등록 데이터 생성
```

| 항목 | 결과 |
|---|---|
| 홈페이지 연동 | `config.js` 의 `mallDataUrl` → `../site/data/products.js` 로 브랜드·건수 자동 표시 |
| **대체 파일 지정 (실측)** | `site/index.html?data=data/<대체>.json` → 대체 5건 + 자체 meta(`supplier_catalog_totals`·`data_origin`)가 정상 적용됨. **테스트 파일은 검증 후 삭제(저장소 미반영)** |
| 교체의 영향 | `site/data/products.js` 만 교체 → **쇼핑몰·홈페이지 양쪽 자동 반영, `website/` 코드 수정 불필요** |
| 수집기·Excel 생성기 | **새로 만들지 않음** (이슈 #19 담당) |

## B6. 39건 vs 전체 수량 — 명확히 구분

| 표기 | 값 | 근거 | 노출 위치 |
|---|---|---|---|
| **현재 표시 상품** | **39건** | `site/data/products.js` 실측 (브랜드 20종) | 쇼핑몰 통계 카드 "표시 중인 상품 … 공개 수집 샘플 기준" |
| **공급처 카탈로그 규모** | **4,198건** (삼아사운드 2,229 + 삼아스토어 1,969) | PR #12/#13 | 쇼핑몰 "공급처 카탈로그 규모" 카드 + "안내" 뷰, 출처 문구 포함 |
| **이슈 #19 인용 기준** | **4,575건** (2,281+2,294) | **카테고리 탐색 기준의 다른 집계**. #19가 "상세 필드 전량 검증 별도 계측" 이라 명시 | 문서(`CGI_DEMO_GUIDE.md` §4)에 두 기준이 다름을 명시 |
| 가격 미공개 | 추정하지 않고 **"가격 문의"** | — | 카드·상세 |
| CGI 판매 가능 수량 | **0건**(승인 전) | — | 카드 배지 "CGI 승인 전" |

## B7. 실브라우저 검증 (로컬 http://127.0.0.1:8814, 두 경로 동일 서버)

| 뷰포트 | 그리드(사업/사진/브랜드) | 가로 넘침 | 깨진 이미지 | 24px 미만 터치 | 콘솔 오류(사이트) |
|---|---|---|---|---|---|
| **1920px** | 4 / 3 / 6 | **0** | **0** | **0** | **0** |
| **1440px** | 4 / 3 / 6 | **0** | **0** | **0** | **0** |
| **820px** | 2 / 2 / 4 | **0** | **0** | **0** | **0** |
| **390px** | 1 / 1 / 2 | **0** | **0** | **0** | **0** |

캡처 11종 전부 가로 넘침 0 · 깨진 이미지 0 (캡처 시 스크롤 후 lazy 로드 확인).

## B8. 미완료 사항

| 항목 | 상태 | 비고 |
|---|---|---|
| **실주소 배포** | **미수행** | **배포 완료로 보고하지 않습니다.** 신규 시연 주소 + 호스팅 계정 필요. 필요 항목 10개는 `docs/CGI_DEPLOYMENT.md` §2 |
| 기존 CGI 운영 홈페이지 교체 | **미수행** | `cgiinc.kr` 현재 Cloudflare 521 로 접속 불가. **허가 없이 교체하지 않음** |
| 기존 CGI 홈페이지와의 메뉴 연결 | **미수행** | 개편업체 범위 협의 필요 (Issue #11 §1) |
| 주문·결제·장바구니 | **미구현(의도적)** | 스마트스토어 개설 전. 문의 안내로 대체 |
| 전체 4,575건 DB | **이슈 #19 진행 중** | 본 PR 은 **연결 경로만** 준비(재수집·Excel 생성 없음) |
| 호실 104/111호 · 2018년 이후 연혁 · FAQ 문안 | **대표 확인 필요** | §B9 참조 |

## B9. 대표 확인 필요 항목

1. **본사 호실** — 표시 중 **광주드림파크 111호**(사업자등록증명 2014-10-06 · 회사소개서 2017-10-25 · 회사 제공 위치도 3중 일치). 2016년 카다로그만 "104호". 실제 현재 호실이 다르면 알려주세요.
2. **실제 취급 브랜드 범위** — 현재 31종(공급처 실측) + 데이터 보유 20종 표시.
3. **2018년 이후 연혁** — 현재 2011~2017년만 기재.
4. **FAQ 4개 문안** — 저희 작성 초안, 회사 공식 자료로 교체 가능.
5. **사업자등록번호 표시 여부** — 410-86-46283 확인(법인등기). 쇼핑몰 하단 표시 여부를 알려주세요. 법인등록번호는 게시하지 않습니다.

## B10. 재실행 방법 (통합 시연)

```bash
git clone https://github.com/skerishKang/kbs261022.git
cd kbs261022
git checkout feature/issue-18-integrated-demo

# 두 경로가 한 서버에서 함께 열린다
python -m http.server 8811 --directory .
#   회사 홈페이지   : http://127.0.0.1:8811/website/index.html
#   상품 쇼핑몰     : http://127.0.0.1:8811/site/index.html
#   브랜드 딥링크   : http://127.0.0.1:8811/site/index.html#/products?brand=SHURE
#   빈 결과 예시    : http://127.0.0.1:8811/site/index.html#/products?brand=K%26M
#   데이터 교체 예시 : http://127.0.0.1:8811/site/index.html?data=data/products.json

# 브라우저 검증 (BrowserSkill)
bsk session start --no-focus --json
bsk navigate "http://127.0.0.1:8811/website/index.html" --session <id>
bsk emulate --width 390 --height 844 --session <id>
bsk screenshot --full-page --out out.png --session <id>
bsk session stop <id>
```

---

# C. AI 공동검토용 기록

```text
PROJECT=CGI
ISSUE=18
PR=(이 PR)
REPOSITORY=skerishKang/kbs261022
WORK_DATE=2026-10-22
AGENT=OpenCode
MODEL=MiniMax M3.1 Flash (free tier)
DEVICE=CGI-1 (Windows 11, Tabbit Chromium 153 + BrowserSkill 0.3.3, bsk daemon 0.3.3 pid 27816)
WORKTREE=D:\1022\wt18 (feature/issue-18-integrated-demo, origin/main aeb5d37 기반)
OBJECTIVE=회사 홈페이지(PR #22)와 상품 쇼핑몰(PR #17)이 서로 이동 가능한 하나의 통합 고객 시연본으로 완성
INPUTS=
  - main aeb5d37 (PR #17 site/ 쇼핑몰 + PR #22 website/ 홈페이지)
  - Z:\홈페이지\홈페이지제작가이드(참고사항포함).docx / CGI카다로그8P.pdf
  - Z:\1.회사소개서\ (2017 회사소개서, 사업자등록증명, 찾아오시는길, 홍보 사진)
  - Z:\3.카다로그\2.스마트팜\시지아이로고_250711.png
  - Issue #5 실측 (취급 브랜드 31종)
IMPLEMENTED=site/config.js(신규), site/index.html(복귀 링크 2곳), site/assets/js/cgi-catalog.js(applySiteConfig + 상세 브레드크럼 복귀 링크),
  site/assets/css/cgi-catalog.css(복귀 링크 스타일 + 터치영역), website/index.html(브랜드 칩 좁히기),
  website/assets/main.js(initBrandFilter), website/assets/style.css, docs/CGI_DEMO_GUIDE.md, docs/CGI_DEPLOYMENT.md,
  docs/screenshots/integrated-demo/(11종), reports/cgi-integrated-demo-work-report.md
EXECUTION_EVIDENCE=
  - 로컬 http://127.0.0.1:8814 에 website/ + site/ 동시 서빙 후 Tabbit BrowserSkill 실브라우저 검증
  - 쇼핑몰 → 홈페이지 실제 클릭 이동(상단 메뉴) 확인, 상세 브레드크럼 '← 회사 홈페이지' 확인
  - 브랜드 딥링크: SHURE → 8건, K&M → 정상 빈 결과, 홈페이지 칩 'shure' 입력 → 1개, 무일치 → 안내
  - ?data= 대체 파일 스위치 실측(5건 + 자체 meta) 후 테스트 파일 삭제
  - 반응형 4뷰포트 × 2사이트: 가로 넘침 0, 깨진 이미지 0, 터치영역 24px 미만 0, 콘솔 오류 0
  - 캡처 11종 (docs/screenshots/integrated-demo/)
TESTS=
  - 양방향 내비게이션 6경로(홈→몰 2종, 몰→홈 3종 + 상세 1종) — 통과
  - 브랜드 검색/필터 4케이스 — 통과
  - 반응형 4뷰포트 × 2사이트 8케이스 — 통과
  - #19 데이터 교체 경로 2종(기본 파일 / ?data= 대체) — 통과
OBSERVED_FACTS=
  - PR #17 쇼핑몰은 해시 라우터(#/products?brand=SHURE) — 1차의 ?brand=Shure 는 무효
  - brand 필터 값은 brand_norm(대문자) 기준
  - 기존 cgiinc.kr 현재 접속 불가(HTTPS 521 / HTTP 도메인셋팅 오류) — 1차와 동일
  - 쇼핑몰 39건 / brand_norm 20종 / homepage 칩 36개(20+16)
  - 공급처 카탈로그 규모 4,198건(PR#12/#13)과 이슈#19 인용 4,575건은 집계 기준이 다름
MODEL_CLAIMS_NOT_INDEPENDENTLY_VERIFIED=
  - 4,575건(2,281+2,294) — 이슈#19 카테고리 탐색 기준 보고치, 본 작업에서 재계측/검증하지 않음
  - '전국 대리점망 구축'(카다로그 기재) / 2018년 이후 연혁 / FAQ 4개 문안 — 회사 자료 미확보
LIMITATIONS=
  - 실주소 배포 없음 / 기존 운영 홈페이지 교체 없음(접근 불가라 무개입)
  - 주문·결제 미구현(스마트스토어 개설 전, 의도적 제외)
  - 호실 104/111호 1건, 연혁/FAQ/취급범위/사업자번호 표시 여부는 대표 확인 필요
  - 전체 4,575건 DB 미도착(연결 경로만 준비)
OUTPUTS=website/, site/config.js, site/index.html, site/assets/{js,css}, docs/CGI_DEMO_GUIDE.md, docs/CGI_DEPLOYMENT.md,
  docs/screenshots/integrated-demo/(11종), reports/cgi-integrated-demo-work-report.md
MERGED=NO
DEPLOYED=NO
LIVE_VERIFIED=LOCAL (http://127.0.0.1:8814 실브라우저)
REMAINING=
  - 대표 확정(호실/연혁/FAQ/취급범위/사업자번호 표시)
  - 신규 시연 주소 + 정적 호스팅 계정 확보 → 실주소 배포 → 기존 홈페이지 연결
  - 이슈 #19 전체 마스터 반영(홈페이지 코드 변경 불필요)
  - 스마트스토어 개설 후 주문·결제
NEXT=
  - 대표 확정 → 신규 시연 주소 확보 → 배포 → 기존 홈페이지 메뉴 연결 → #19 마스터 반영 → 스마트스토어 개설 → 주문·결제 → ERP(#20/#21)
```
