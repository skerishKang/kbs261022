# 작업보고 — CGI 회사 홈페이지 (issue #18) · 통합 시연본

- **이슈**: [#18](https://github.com/skerishKang/kbs261022/issues/18) `[P0][WEB] CGI 기존 홈페이지 참고형 회사 홈페이지 시연본`
- **일시·담당**: 2026-10-22 · CGI-1(김범신) / OpenCode (MiniMax M3.1 Flash) · 실브라우저 Tabbit Chromium + BrowserSkill 0.3.3
- **브랜치**: `feature/issue-18-cgi-company-website` (worktree `D:\1022\wt18`, origin/main 기반)
- **산출물**: `website/` (홈페이지) · `reports/cgi-company-website-work-report.md` (본 문서) · `website/docs/screenshots/` 8종

> **이 문서의 표기 규칙**: ① 「이전 실측」은 1차 개발(8efdeba) 시점의 실측값, ② 「통합 재실측」은 이번 main 병합(#17) 이후 재실행한 값입니다. 충돌하는 항목은 근거를 명시했습니다.

---

# A. 고객용 보고서

| 항목 | 작성 내용 |
|---|---|
| **어떤 홈페이지를 만들었는가** | ㈜시지아이(CGI) 회사 홈페이지입니다. 검정 상단 메뉴(ABOUT · BUSINESS · PRODUCTS · REFERENCE · SUPPORT) 아래에 회사 소개, 주요 사업 분야 4가지, 주요 연혁, 취급 브랜드, 시공·렌탈 실적, 문의 안내를 담았고, "제품 보기"를 누르면 **CGI 상품 쇼핑몰**로 이동합니다. |
| **기존 홈페이지에서 무엇을 가져왔는가** | 회사가 이미 갖고 계신 자료에서만 가져왔습니다. ① 메뉴 구조(ABOUT/PRODUCTS/REFERENCE/SUPPORT)와 "대분류 배경색 검정" 요구는 **홈페이지 제작 요청서**, ② 회사 소개·사업 4가지·연혁·납품 실적·연락처는 **공식 카다로그 8P**, ③ 회사 개요(설립/주소/연락처/업종)는 **사업자등록증명**과 **2017 회사소개서**, ④ 대표 이미지·사진은 **기업홍보용 자료**, ⑤ 취급 브랜드는 **Issue #5 실측**입니다. 확인되지 않은 회사 실적·연락처·사업 내역은 만들지 않았습니다. |
| **어떻게 쇼핑몰과 연결되는가** | "제품 보기" 5곳과 브랜드 칩 36개가 쇼핑몰로 연결됩니다. 브랜드 칩을 누르면 쇼핑몰의 해당 브랜드 필터로 바로 들어갑니다(예: `SHURE` → 8건). 주소는 `website/assets/config.js` 한 곳에서 관리합니다. **쇼핑몰은 PR #17 병합본을 그대로 사용했고, 그 파일은 수정하지 않았습니다.** |
| **실제 화면 캡처** | `website/docs/screenshots/` 8종 — 데스크톱 1920·1440, 태블릿 820, 모바일 390(일반·메뉴), 통합 시연 3종(쇼핑몰 목록·브랜드 필터·빈 결과). |
| **앞으로 Excel 상품 DB와 어떻게 연결되는가** | **이미 연결 경로를 준비해 두었습니다.** 홈페이지가 쇼핑몰의 상품 데이터(`site/data/products.js`)를 읽어 브랜드 목록과 건수를 자동 표시하므로, 이슈 #19에서 전체 4,575건 마스터가 들어오면 **홈페이지 코드는 한 글자도 바꾸지 않고** 목록·건수가 자동으로 늘어납니다. 데이터 흐름은 아래 §E 와 같습니다. |

---

# B. 개발용 보고서

## B1. 조사한 사이트·자료

| 대상 | 결과 | 방법 |
|---|---|---|
| **https://cgiinc.kr/** (기존 CGI 홈페이지) | **접속 불가.** HTTPS → Cloudflare **521 (Web server is down)**, HTTP → 오리진이 `alert('도메인 셋팅이 잘못 되었습니다.')` 반환 | BrowserSkill 실브라우저 + HTTP |
| `Z:\홈페이지\홈페이지제작가이드(참고사항포함).docx` | **기존 홈페이지 메뉴 구조·요구사항의 1차 근거** (docx 본문 추출) | OPC zip 파싱 |
| `Z:\홈페이지\CGI카다로그8P.pdf` (PDF 생성 2016-02-22) | 회사 소개·사업 4가지·연혁·납품 실적·연락처·주소(104호) | pypdf |
| `Z:\1.회사소개서\_171025 …\2 시지아이 회사소개서.pdf` (2017-10-25) | 회사 개요·인사말·연혁·주소(**111호**) | pypdf |
| `Z:\1.회사소개서\회사소개서 자료\CGI 사업자등록증명.jpg` (2014-10-06 발급) | **법인 등록의 최종 근거** — 법인명·대표자·개업일·사업장소지(111호)·업종 | 이미지 판독 |
| `Z:\1.회사소개서\회사소개서 자료\cgi찾아오시는길.jpg` | 회사 제공 위치도 (광주드림파크 **111호** 표기) | 이미지 |
| `Z:\시지아이 로고\`, `Z:\3.카다로그\2.스마트팜\시지아이로고_250711.png` | 공식 로고(녹색 #07913A) | 픽셀 색 추출 |
| `http://blog.naver.com/cgiinc` | 회사 네이버 블로그(소개 문구 확인) | HTTP + 실브라우저 |
| Issue #5 실측 (samasound.co.kr) | 취급 브랜드 31종 | 기존 분석 재사용 |

### 기존 홈페이지 주소는 어떻게 찾았는가
저장소 문서·이슈 19개·PR 본문 전체에 CGI 홈페이지 주소가 **없었**습니다(추정하지 않음).
대신 **CGI-1 컴퓨터의 실제 브라우저 기록**에서 근거를 확보했습니다.
`cgiinc.kr` (Cloudflare DNS) · `cgi@cgiinc.kr` (Gmail "시지아이 메일") · `blog.naver.com/cgiinc` · `\\cgibusiness` 공유폴더(마운트됨) · `cgiinc.synology.me:5000` (Tailscale NAS).
→ 회사 실체는 **㈜시지아이 (CGI Inc)**, 대표이사 **김범신**(카다로그·회사소개서·저장소 소유자 일치).

## B2. 확인한 메뉴·콘텐츠

| 항목 | 실측 |
|---|---|
| 대 메뉴 | **ABOUT / PRODUCTS / REFERENCE / SUPPORT** |
| 소 메뉴 | ABOUT: GREETINGS/HISTORY/location · PRODUCTS: 장비회사별 · REFERENCE: INSTALL(관공서·교회·방송국·호텔/리조트·기타)/RENTAL · SUPPORT: Q&A/FAQ/CONTACT |
| 기타 요구 | **"대분류 바탕색은 검은색으로 해주세요"**, "사진은 모아서 드리겠습니다" |
| 디자인 참고 | 멀티미디어스피커.kr, samasound.co.kr |
| 브랜드 색상 | 공식 로고 녹색 **#07913A** (로고 픽셀에서 추출) |
| 슬로건 | "방송, 음향의 모든것! 고객을 위한 한 걸음!" / "We express the creation of God through industry" |
| 사업 분야 | 01 음향·영상 조명시스템 컨설팅·시공 / 02 방송·음향·조명 렌탈 / 03 음향기기 수입·국내 유통 / 04 기술 개발·제조(DI BOX·CM-201) |
| 연혁 | 2011 법인설립 ~ 2017 특허등록 (12개 항목) |

## B3. 콘텐츠 정합성 재확인 (4단계) — 충돌 항목 처리

**서로 다른 자료가 충돌할 때 "최신 근거"를 문서 내부 메타데이터(PDF CreationDate)로 판정**했습니다. 파일 복사일(mtime)은 판정 근거로 쓰지 않았습니다.

| 항목 | 값 | 근거 | 처리 |
|---|---|---|---|
| **본사 호실** | **광주드림파크 111호** | ① 사업자등록증명 2014-10-06 (등록상 주소) ② 회사소개서 2017-10-25 ③ 회사 제공 찾아오시는길 도해 3개가 일치 / 카다로그 8P(2016-02-22)만 "104호" | **111호 채택**, 104호는 구(舊) 자료로 보고 |
| 법인명 | (주) 시지아이 | 사업자등록증명 | 그대로 |
| 대표자 | 김범신 | 사업자등록증명·회사소개서·카다로그 3중 일치 | 그대로 |
| 설립일 | 2011년 1월 21일 | 사업자등록증명 개업일 = 회사소개서 설립년도 | 그대로 |
| 연락처 | TEL 062) 576-8100 / FAX 062) 576-8181 | 사업자등록증명·카다로그·회사소개서 3중 일치 | 그대로 |
| 업종 | 음향기기·방송기기 제조 / 도·소매업, 조명기구, 전기공사, 소프트웨어 제작 | 사업자등록증명 | 추가 표기 |
| 사업 분야 | 4가지 | 카다로그 8P | 그대로 |
| 연혁 | 2011~2017 | 회사소개서 2017-10-25 | 그대로 (2018년 이후는 자료 미확보) |
| 취급 브랜드 | 31종(공급처 실측) | Issue #5 | 그대로 + 쇼핑몰 데이터 연동 |

> **대표 확인이 필요한 1건**: 카다로그 8P의 "104호" 표기. 사업자등록증명·회사소개서·위치도 3건이 111호이므로 111호를 표시했으나, 실제 현재 호실이 다르면 알려주십시오.

> **이번 단계에서 실제 사이트를 고친 것 2가지**
> ① 주소 104호 → **111호** 정정 (이전 보고서는 파일 mtime 기준으로 카다로그를 최신으로 잘못 판단했습니다. 이번에 PDF 내부 CreationDate 로 재판정해 정정했습니다.)
> ② 「오시는길」의 **OpenStreetMap 임베드(좌표 추정) 제거** → **회사 제공 위치도 이미지**로 교체. 추측 좌표를 고객 화면에 노출하지 않기 위함이며, 외부 iframe 의존도도 사라졌습니다.

## B4. 실제 구현 파일

| 파일 | 내용 |
|---|---|
| `website/index.html` | 단일 페이지 6개 섹션 (hero / about / business / products / reference / support) |
| `website/assets/style.css` | 스타일. 1080 / 900 / 620 브레이크포인트 |
| `website/assets/main.js` | 모바일 메뉴 · 스크롤 스파이 · 브랜드 렌더링(마스터 연동) · REFERENCE 탭 |
| `website/assets/config.js` | 쇼핑몰 주소·라우팅 규칙·취급 브랜드·마스터 데이터 경로 (관리자가 고이는 유일한 설정) |
| `website/assets/img/` | 공식 로고 4종 + 회사 제공 위치도 1종 + 본사/프로젝트 사진 7종 (전부 회사 소유 자료) |
| `website/README.md` | 실행 · 쇼핑몰 연결 · 라우팅 규칙 · 콘텐츠 출처 |
| `website/docs/screenshots/` | 8종 |
| `reports/cgi-company-website-work-report.md` | 본 문서 |
| `docs/CGI_WORK_LOG_INDEX.md` | #11(→PR #17 교정) · #18 행 추가 |

**타 에이전트 파일 미수정**: `site/`(PR #17 병합본) · `tools/`(PR #17) · `docs/CGI_CATALOG_SITE*.md` 는 **참조만** 했고, `site/` 은 `git diff origin/main -- site/` 결과가 비어 있음을 확인했습니다.

## B5. 통합 검증 결과 (실브라우저, 로컬 http://127.0.0.1:8811)

### 반응형 4종 (홈페이지)

| 뷰포트 | 그리드(사업/사진/브랜드) | 메뉴 | 가로 넘침 | 깨진 이미지 | 24px 미만 터치 | 콘솔 오류(사이트) |
|---|---|---|---|---|---|---|
| **1920px** | 4 / 3 / 6 | 인라인 | **0** | **0** | **0** | **0** |
| **1440px** | 4 / 3 / 6 | 인라인 | **0** | **0** | **0** | **0** |
| **820px** | 2 / 2 / 4 | 햄버거 | **0** | **0** | **0** | **0** |
| **390px** | 1 / 1 / 2 | 햄버거 | **0** | **0** | **0** | **0** |

- 이미지 11개 중 9개 로드(2개는 숨겨진 RENTAL 탭 내부) · **깨진 이미지 0** · 전 뷰포트 16:10 유지
- 로고 정상 표시 · 주소 111호 4곳 일치 · 104호 0건 · iframe 0개(외부 의존 제거)
- 브랜드 칩 36개 · 쇼핑몰 링크 5개

### 쇼핑몰 연결

| 대상 | 링크 | 검증 |
|---|---|---|
| 상단 '제품 보기' | `../site/index.html` | 쇼핑몰 홈(#/) 도달 |
| 히어로 '제품 보기 (쇼핑몰)' | 동일 | 동일 |
| PRODUCTS '제품 보기 — CGI 상품 쇼핑몰로 이동' | 동일 | 동일 |
| CTA 밴드 '제품 보기' | 동일 | 동일 |
| 푸터 '제품 보기' | 동일 | 동일 |
| **브랜드 칩 36개** | `../site/index.html#/products?brand=<대문자>` | 아래 참조 |

### 브랜드 딥링크 (핵심)

- PR #17 병합본 쇼핑몰은 **해시 라우터**입니다: `#/` 홈 · `#/products` 목록 · `#/products?brand=SHURE` 브랜드 필터 · `#/product/<id>` 상세
- 브랜드 값은 쇼핑몰의 **`brand_norm`(대문자 정규화)** 기준 → 홈페이지 칩은 `brand.toUpperCase()` 로 동일 규칙을 적용했습니다
  (`Shure`→`SHURE`, `Q Acoustics`→`Q ACOUSTICS`, `Allen&Heath`→`ALLEN&HEATH`)
- 실제 클릭 검증: `SHURE` 칩 → 쇼핑몰 `브랜드: SHURE ×` 필터 적용 + **8건 표시**(brand_norm 의 SHURE=8건과 일치)
- **샘플에 없는 브랜드(예: K&M)**: 쇼핑몰 정상 빈 결과(`검색 결과가 없습니다 … 필터 초기화`) 표시 확인
- 잔여 11종은 데이터 미보유 → 홈페이지 브랜드 목록에 **건수 없이** 함께 표시하고 안내 문구로 명시

### 이전 실측 vs 통합 재실측 차이

| 항목 | 이전 실측(8efdeba) | 통합 재실측 | 사유 |
|---|---|---|---|
| 쇼핑몰 URL 규칙 | `?brand=Shure` (쿼리) | **`#/products?brand=SHURE`** (해시) | PR #17 이 해시 라우터로 구현 |
| 브랜드 표기 | `Shure` (원본) | **`SHURE`** (brand_norm) | 쇼핑몰 필터 규칙에 맞춤 |
| 브랜드 칩 | 31개(고정) | **36개**(마스터 20 + 미보유 16) | 쇼핑몰 데이터 연동 |
| 본사 호실 | 104호 | **111호** | PDF 내부 CreationDate 로 재판정 |
| 오시는길 | OSM 임베드(좌표 추정) | **회사 제공 위치도 이미지** | 추측 정보 제거 |
| 쇼핑몰 데이터 | (PR #15 미병합본) | **PR #17 병합본 39건** | main 병합 반영 |

## B6. 미완료 사항

| 항목 | 상태 | 비고 |
|---|---|---|
| **실주소 배포** | **미수행** | 도메인·호스팅 권한 미확인. **배포 완료로 보고하지 않습니다.** |
| 기존 CGI 운영 홈페이지 교체 | **미수행** | `cgiinc.kr` 이 현재 Cloudflare 521 로 접속 불가라 개입하지 않았습니다. |
| 기존 CGI 홈페이지 연결(Issue #11 §1) | **미수행** | 관리자 권한·개편업체 범위 협의 필요 |
| **쇼핑몰 → 홈페이지 명시적 링크** | **미구현** | PR #17 쇼핑몰에 복귀 링크가 없습니다. `site/` 파일 소유권을 침범하지 않기 위해 **이번 PR 에서 수정하지 않았습니다.** PR #17 문서(`docs/CGI_CATALOG_SITE.md` §6)는 쇼핑몰을 홈페이지 도메인 하위 `/catalog/` 에 배포하라고 안내하므로, 그 구조에서는 상대경로 `../` 한 줄로 해결됩니다. 현재는 (a) "제품 보기" 가 `target=_blank` 라 홈페이지 탭이 그대로 남아 복귀, (b) 브라우저 뒤로가기, (c) 쇼핑몰 자체 브레드크럼 — 세 경로가 모두 동작합니다. |
| 주문·결제 | **미구현(의도적)** | 스마트스토어 개설 전. 문의 안내로 대체 |
| 회사 연혁 2018년 이후 | **미확보** | 회사 자료 없음 |
| FAQ 4개 문안 | **자체 문안** | 회사 공식 Q&A 자료 미확보 |
| 호실 104호/111호 | **확인 필요** | §B3 참조. 3개 근거는 111호 |
| **전체 4,575건 상품 DB** | **이슈 #19 진행 중** | 본 담당자는 재수집하지 않았고, 연결 경로만 준비했습니다(§E). |

## B7. 재실행 방법 (통합 시연)

```bash
git clone https://github.com/skerishKang/kbs261022.git
cd kbs261022
git checkout feature/issue-18-cgi-company-website   # website/ + main 병합본 포함

# 하나의 HTTP 서버에서 두 경로가 함께 열립니다
python -m http.server 8811 --directory .
#   홈페이지        : http://127.0.0.1:8811/website/index.html
#   상품 쇼핑몰      : http://127.0.0.1:8811/site/index.html
#   쇼핑몰 전체 목록 : http://127.0.0.1:8811/site/index.html#/products
#   브랜드 딥링크    : http://127.0.0.1:8811/site/index.html#/products?brand=SHURE
#   빈 결과 예시     : http://127.0.0.1:8811/site/index.html#/products?brand=K%26M
#   쇼핑몰 단독 실행 : http://127.0.0.1:8811/website/index.html (site/ 없이도 동작, 브랜드 목록 자동 fallback)

# 브라우저 검증 (BrowserSkill)
bsk session start --no-focus --json
bsk navigate "http://127.0.0.1:8811/website/index.html" --session <id>
bsk emulate --width 390 --height 844 --session <id>       # 모바일
bsk screenshot --full-page --out out.png --session <id>
bsk session stop <id>
```

---

# C. 전체 상품 DB(#19) 연동 준비 — 5단계

이번 담당자는 **전체 상품을 다시 수집하지 않았습니다.** 아래 구조만 확인하고 연결 경로를 준비했습니다.

## C1. 현재 데이터 흐름 (확인된 실제 구조)

```
공통 상품 마스터 (수집 결과)
  ├─ site/data/_source_product_master_sample.csv   (PR #12, 20행)
  ├─ site/data/_source_sample-products.json        (PR #13, 21건)
  └─ site/data/_source_category_catalog.csv        (PR #12, 57행)
        │
        │  tools/build_catalog_data.py  (--master-csv / --sample-json / --categories)
        ▼
   site/data/products.json   (정규화 39건)  +  site/data/products.js  (window.CGI_PRODUCTS)
        │
        │  site/index.html  (SPA, ?data=<경로>.json 로 다른 JSON 지정 가능)
        ▼
   CGI 상품 쇼핑몰  ──(#18)──▶  CGI 회사 홈페이지  ("제품 보기" + 브랜드 칩 36개)
```

## C2. #19 전체 마스터가 들어오면 하는 일 (홈페이지 코드 변경 없음)

```
이슈 #19 전체 상품 마스터 CSV/XLSX  (4,575건)
        │  tools/build_catalog_data.py --master-csv <전체마스터.csv> --sample-json ... --categories ...
        ▼
   site/data/products.json  /  products.js   (4,575건으로 교체)
        │
        ├─▶ CGI 상품 쇼핑몰   : 브랜드·카테고리 필터·상세가 자동으로 4,575건 기준으로 동작
        ├─▶ CGI 회사 홈페이지 : 브랜드 칩과 건수가 자동으로 갱신 (master 데이터 연동)
        └─▶ 추후 네이버 스마트스토어 등록 : 동일 마스터에서 등록 데이터 생성
```

**홈페이지에서 이미 준비된 것**
- `config.js` 의 `mallDataUrl` 이 쇼핑몰 데이터(`../site/data/products.js`)를 읽어 브랜드·건수를 자동 표시합니다.
- 데이터 파일이 없으면 `config.js` 의 정적 취급 브랜드 목록(31종)으로 graceful fallback 합니다(검증 완료).
- 따라서 **#19 산출물이 도착하면 `site/data/products.js` 만 교체하면 되고, `website/` 코드는 수정할 필요가 없습니다.**

**확인된 제약**
- 쇼핑몰의 `brand_norm` 은 **대문자 정규화**입니다. 홈페이지 칩은 같은 규칙을 적용해 링크 값이 정확히 일치합니다.
- 쇼핑몰의 카테고리 필터 파라미터는 `cat=`, 공급처 필터는 `site=` 입니다(홈페이지에서는 현재 브랜드 필터만 사용).
- 공통 마스터 스키마는 `site/data/_source_product-master.schema.json` 에 있습니다(PR #17).

---

# D. AI 공동검토용 기록

```text
PROJECT=CGI
ISSUE=18
PR=22
REPOSITORY=skerishKang/kbs261022
WORK_DATE=2026-10-22
AGENT=OpenCode
MODEL=MiniMax M3.1 Flash (free tier)
DEVICE=CGI-1 (Windows 11, Tabbit Chromium 153 + BrowserSkill 0.3.3, bsk daemon 0.3.3 pid 27816)
WORKTREE=D:\1022\wt18 (feature/issue-18-cgi-company-website, origin/main ae3e06b 병합)
OBJECTIVE=기존 CGI 홈페이지를 실제 자료로 조사·분석하고 그 구조를 재사용한 회사 홈페이지 시연본 구현,
           main 에 병합된 쇼핑몰(PR #17)과 통합하여 홈페이지 -> 쇼핑몰 연결 시연을 완성
INPUTS=
  - Z:\홈페이지\홈페이지제작가이드(참고사항포함).docx      (기존 홈페이지 메뉴/요구사항)
  - Z:\홈페이지\CGI카다로그8P.pdf                        (2016-02-22, 회사 소개·사업·연혁·실적·연락처)
  - Z:\1.회사소개서\_171025 …\2 시지아이 회사소개서.pdf   (2017-10-25, 회사 개요·인사말·연혁·주소 111호)
  - Z:\1.회사소개서\회사소개서 자료\CGI 사업자등록증명.jpg (2014-10-06, 법인 등기 최종 근거)
  - Z:\1.회사소개서\회사소개서 자료\cgi찾아오시는길.jpg   (회사 제공 위치도, 111호)
  - Z:\3.카다로그\2.스마트팜\시지아이로고_250711.png       (공식 로고)
  - Z:\1.회사소개서\_171025 기업SNS 홍보교육용\           (홍보용 사진)
  - Issue #5 실측 (samasound.co.kr 31개 브랜드)
  - main ae3e06b (PR #17 쇼핑몰 site/ + tools/build_catalog_data.py)
IMPLEMENTED=website/{index.html,assets/{style.css,main.js,config.js},assets/img/*,README.md,docs/screenshots/*}
EXECUTION_EVIDENCE=
  - https://cgiinc.kr 실브라우저 확인: 521 Web server is down / http:// 는 '도메인 셋팅이 잘못 되었습니다'
  - CGI-1 브라우저 기록에서 cgiinc.kr / cgi@cgiinc.kr / blog.naver.com/cgiinc / \\cgibusiness 발견
  - docx 본문 추출로 대메뉴 4종 + '대분류 검정 배경' 요구 확인
  - PDF 내부 CreationDate 로 자료 시점 판정 (파일 mtime 은 판정 근거로 쓰지 않음)
  - 사업자등록증명 이미지 판독으로 법인명/대표자/개업일/사업장소지(111호)/업종 확인
  - 로컬 http://127.0.0.1:8811/website/index.html + /site/index.html 동일 서버 실행
  - 반응형 1920/1440/820/390 실측 + 캡처 8종
  - 브랜드 칩 클릭 -> 쇼핑몰 '#/products?brand=SHURE' 실제 이동, 8건 표시 확인
  - 미보유 브랜드(K&M) -> 쇼핑몰 정상 빈 결과 화면 확인
  - site/ 없이 website/ 단독 실행 -> 브랜드 목록 31종 fallback 확인
TESTS=
  - 반응형 4종: 가로 넘침 0, 깨진 이미지 0, 24px 미만 터치영역 0, 콘솔 오류 0, iframe 0 — 4/4
  - 쇼핑몰 링크 5종 + 브랜드 칩 36개 — 6/6
  - 브랜드 필터(데이터 보유 SHURE) / 빈 결과(미보유 K&M) / 단독 실행 fallback — 3/3
  - 결함 3건 수정 후 재검증 통과 (로고 반전 평탄화 / aspect-ratio 내재비율 밀림 / 터치영역 20px)
  - 신규 정정 2건: 주소 104호->111호, OSM 추정좌표 임베드 -> 회사 제공 위치도 이미지
OBSERVED_FACTS=
  - 기존 CGI 홈페이지(https://cgiinc.kr) 현재 접속 불가(HTTPS 521 / HTTP 도메인셋팅 오류)
  - 저장소 문서·이슈 19개·PR 본문에 홈페이지 주소 없음 -> 브라우저 기록에서만 확인
  - 회사 = (주)시지아이 / CGI Inc, 대표이사 김범신, 개업일 2011-01-21, TEL 062)576-8100
  - 사업장소지 = 광주드림파크 111호 (사업자등록증명 2014-10-06 / 회사소개서 2017-10-25 / 위치도 3중 일치)
  - PR #17 쇼핑몰은 해시 라우터 + brand_norm(대문자) 필터 규칙
  - 쇼핑몰 현재 39건 / 20 브랜드(brand_norm) / 공급처 31 브랜드
MODEL_CLAIMS_NOT_INDEPENDENTLY_VERIFIED=
  - "전국 대리점망 구축" (카다로그 기재) - 실제 대리점 현황 미확인
  - 회사 연혁 2018년 이후분 - 자료 미확보
  - FAQ 4개 문안 - 회사 공식 Q&A 자료 미확보
  - 4,575건(2,281+2,294) 원천 상품 수 - 이슈 #19 진행 중, 본 작업에서 재수집/재계산 하지 않음
  - 일부 2015년 회사소개서 PDF는 텍스트 추출이 없어 주소 미확인(이미지형 문서로 추정)
LIMITATIONS=
  - 실주소 배포 없음 / 기존 운영 홈페이지 교체 없음(접근 불가라 무개입)
  - 주문·결제 미구현(스마트스토어 개설 전, 의도적 제외)
  - 쇼핑몰 -> 홈페이지 명시적 링크 미구현(PR #17 파일 소유권 유지, 대안 3종 동작 확인)
  - 호실 104호/111호 1건 대표 확인 필요
  - 홈페이지에서 가격 미표시(쇼핑몰에 있고, 거기도 참고용 공개가)
OUTPUTS=website/, reports/cgi-company-website-work-report.md, website/docs/screenshots/ (8종)
MERGED=NO
DEPLOYED=NO
LIVE_VERIFIED=LOCAL (http://127.0.0.1:8811 실브라우저)
REMAINING=
  - 대표 확인: 호실(111호/104호) / 2018년 이후 연혁 / FAQ 문안 / 실제 취급 브랜드 범위
  - 도메인·호스팅 권한 확보 후 실주소 배포
  - 기존 CGI 운영 홈페이지 연결(Issue #11 §1) - 개편업체 범위 협의 후
  - 쇼핑몰 -> 홈페이지 복귀 링크 (PR #17 소유 파일이라 미수정, 1줄 권고만 제공)
  - 이슈 #19 전체 4,575건 마스터 반영 (홈페이지 코드 변경 불필요)
NEXT=
  - 대표 확정 -> 홈페이지 반영 -> 도메인 권한 -> 실주소 배포 -> 기존 홈페이지 연결 -> #19 마스터 반영 -> 스마트스토어 개설 -> 주문/결제
```

---

# E. 요약 관계도

```
CGI 회사 홈페이지  (website/)
   │  ABOUT · BUSINESS · PRODUCTS · REFERENCE · SUPPORT
   │  브랜드 칩 36개 → site/index.html#/products?brand=<brand_norm>
   ↓ "제품 보기" (링크 5곳)
CGI 상품 쇼핑몰  (site/ — PR #17 병합본, 이 PR 에서 미수정)
   │  site/data/products.js  ←  tools/build_catalog_data.py  ←  공통 상품 마스터
   ↓
공통 상품 마스터  (이슈 #19 진행 중 · 4,575건)
   ├─ 쇼핑몰 JSON            (site/data/products.json)
   ├─ 전체 상품 Excel XLSX   (이슈 #19 산출물)
   └─ 추후 네이버 스마트스토어 등록
```

**현 상태**: 쇼핑몰 39건(공개 샘플) / 홈페이지 브랜드 36개 표시. 마스터가 교체되면 **양쪽 자동 반영**(홈페이지 코드 변경 없음).
