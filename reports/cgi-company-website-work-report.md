# 작업보고 — CGI 회사 홈페이지 (issue #18)

- **이슈**: [#18](https://github.com/skerishKang/kbs261022/issues/18) `[P0][WEB] CGI 기존 홈페이지 참고형 회사 홈페이지 시연본`
- **일시·담당**: 2026-10-22 · CGI-1(김범신) / OpenCode (MiniMax M3.1 Flash) · 실브라우저 Tabbit Chromium + BrowserSkill 0.3.3
- **브랜치 / 산출물**: `feature/issue-18-cgi-company-website` · `website/` · 본 보고서 · `website/docs/screenshots/` 5종
- **작업 성격**: 1차 개발 — 기존 CGI 홈페이지 참고형. 독창적 새로움 설계는 지시대로 미착수.

---

# A. 고객용 보고서

| 항목 | 작성 내용 |
|---|---|
| **어떤 홈페이지를 만들었는가** | ㈜시지아이(CGI) 회사 홈페이지입니다. 검정 상단 메뉴(ABOUT · BUSINESS · PRODUCTS · REFERENCE · SUPPORT) 아래에 회사 소개, 주요 사업 분야, 취급 브랜드 31종, 시공·렌탈 실적, 문의 안내를 담았고, "제품 보기"를 누르면 CGI 상품 쇼핑몰로 이동합니다. |
| **기존 홈페이지에서 무엇을 가져왔는가** | 회사가 이미 갖고 계신 자료에서 가져왔습니다. ① 메뉴 구성(ABOUT/PRODUCTS/REFERENCE/SUPPORT)과 "대분류 배경색 검정" 요구는 **홈페이지 제작 요청서**에서, ② 회사 소개·사업 분야 4가지·연혁·납품 실적·연락처는 **공식 카다로그(8P)**와 **회사소개서(2017)**에서, ③ 로고는 **2025년 7월 최신 버전**에서, ④ 취급 브랜드 31종은 **Issue #5 실측 결과**에서 가져왔습니다. 없는 회사 실적·연락처·사업 내역은 만들지 않았습니다. |
| **어떻게 쇼핑몰과 연결되는가** | 상단/본문/푸터의 "제품 보기" 링크 5곳과 취급 브랜드 칩 31개가 쇼핑몰로 연결됩니다. 브랜드 칩을 누르면 쇼핑몰의 해당 브랜드 목록(예: Shure 9건)으로 바로 들어갑니다. 주소는 `website/assets/config.js` 의 `mallUrl` 한 줄로 관리합니다. |
| **실제 화면 캡처** | `website/docs/screenshots/` — 데스크톱 1920·1440, 태블릿 820, 모바일 390(일반/메뉴 열림) 총 5종. 아래 B.2 에 요약. |
| **앞으로 Excel 상품 DB와 어떻게 연결되는가** | 이슈 #19(전체 상품 마스터 XLSX)가 같은 `source_product_id`·브랜드·모델·공개가 키를 쓰면, 이 홈페이지의 브랜드 칩·소개 문구는 **작은 설정 파일 교체만으로** 실제 취급 범위와 동기화할 수 있습니다. 지금 카탈로그(PR #15)의 데이터 로더와 같은 방식을 쓰고 있어서, 로더만 갈아끼우면 쇼핑몰과 홈페이지가 같은 데이터를 보게 됩니다. 취급 범위가 확정되면 `cgi_sale_status=approved` 로 "CGI 승인" 배지가 붙는 흐름까지 이미 만들어 두었습니다. |

---

# B. 개발용 보고서

## B1. 조사한 사이트

| 대상 | 결과 | 방법 |
|---|---|---|
| **https://cgiinc.kr/** (기존 CGI 홈페이지) | **현재 접속 불가.** `https://` → Cloudflare **521 Web server is down** (실브라우저에서 확인). `http://` → 오리진이 `alert('도메인 셋팅이 잘못 되었습니다.')` 페이지 반환. | BrowserSkill 실브라우저 + HTTP 요청 |
| **회사 공유폴더 `Z:\`** (`\\cgibusiness` 마운트) | `홈페이지\`, `1.회사소개서\`, `3.카다로그\`, `시지아이 로고\` 등 실제 홈페이지 원본 자료 확인 | 파일 열람(읽기 전용) |
| `Z:\홈페이지\홈페이지제작가이드(참고사항포함).docx` | **기존 홈페이지 메뉴 구조·요구사항의 1차 근거** | docx(OPC) 본문 추출 |
| `Z:\홈페이지\CGI카다로그8P.pdf` | 회사 소개·사업 분야 4가지·연혁·납품 실적·연락처·주소 (8페이지) | pypdf 텍스트 추출 |
| `Z:\1.회사소개서\...회사소개서.pdf` (2017) | 회사 개요(설립/직원수/주소/연락처), 인사말, 연혁 | pypdf 텍스트 추출 |
| `Z:\시지아이 로고\`, `Z:\3.카다로그\2.스마트팜\시지아이로고_250711.png` | 공식 로고(녹색 #07913A) + 2025-07 최신 버전 | 이미지 분석(색 추출) |
| `Z:\1.회사소개서\_171025 기업SNS 홍보교육용\` | 기업 홍보용 사진(본사/프로젝트) | 이미지 |
| `http://blog.naver.com/cgiinc` | 회사 네이버 블로그(소개 문구 확인) | HTTP + 실브라우저 |
| Issue #5 실측 (samasound.co.kr) | 취급 브랜드 31종 + 브랜드별 상품 수 | 기존 분석 결과 재사용 |

### 기존 홈페이지 주소는 어떻게 찾았는가

저장소 문서·이슈 19개·PR 본문 전체에 CGI 홈페이지 주소가 **없었**습니다(추정하지 않았습니다).
대신 **CGI-1 컴퓨터의 실제 브라우저 기록**에서 근거를 찾았습니다.

| 발견 항목 | 값 |
|---|---|
| 도메인 | `cgiinc.kr` (Cloudflare DNS, `cgiinc.kr` / `www.cgiinc.kr` / `mail.cgiinc.kr` 존재) |
| 메일 | `cgi@cgiinc.kr` (Gmail "시지아이 메일") |
| 블로그 | `blog.naver.com/cgiinc` (타이틀 "DI BOX 소개, CGI") |
| 사내 NAS | `cgiinc.synology.me:5000` (Tailscale 전용) |
| 사내 공유 | `\\cgibusiness` (X:/Y:/Z: 마운트) — 사업자등록증명, 회사소개서, 카다로그, 로고 |

→ 회사 실체는 **㈜시지아이(CGI Inc)** 입니다. 대표이사 **김범신**(카다로그·회사소개서·저장소 소유자가 일치).

## B2. 확인한 메뉴·콘텐츠 (홈페이지 제작 요청서 실측)

| 항목 | 실측 내용 |
|---|---|
| 대 메뉴 | **ABOUT / PRODUCTS / REFERENCE / SUPPORT** |
| 소 메뉴 | ABOUT: GREETINGS / HISTORY / location · PRODUCTS: 장비회사별(사이트 참고) · REFERENCE: INSTALL(관공서·교회·방송국·호텔/리조트·기타) / RENTAL · SUPPORT: Q&A / FAQ / CONTACT |
| 기타 요구사항 | **"대분류 바탕색은 검은색으로 해주세요"**, "사진은 모아서 드리겠습니다" |
| 디자인 참고 | 멀티미디어스피커.kr, samasound.co.kr |
| 브랜드 색상 | 공식 로고 녹색 **#07913A** (로고 픽셀에서 추출) |
| 회사 소개 | "㈜CGI는 영상장비 및 음향장비(SR, PA, A/V, CCTV, 화상회의 시스템) 등 전문음향·영상기기 전문 설계·제조·시공업체" |
| 슬로건 | "방송, 음향의 모든것! 고객을 위한 한 걸음!" / "We express the creation of God through industry" |
| 사업 분야 | 01 음향·영상 조명시스템 컨설팅 및 시공 / 02 방송·음향·조명 렌탈 / 03 음향기기 수입 및 국내 유통 / 04 기술 개발 및 제조(DI BOX·CM-201) |
| 회사 개요 | (주)시지아이 · 대표이사 김범신 · 주요사업 음향·영상기기 · 설립 2011-01-21 · 직원수 7명 · TEL 062) 576-8100 · FAX 062) 576-8181 |
| 연혁 | 2011 법인설립 ~ 2017 특허등록 (12개 항목) |
| 납품 실적 | 공연장/테마파크/학교, 교회/상업공간, 렌탈 3개 영역 (대표 사례 각 4~5건) |
| 취급 브랜드 | 31종 (Issue #5 실측) |

## B3. 실제 구현 파일

| 파일 | 내용 | 줄 |
|---|---|---|
| `website/index.html` | 홈페이지는 단일 페이지(6개 섹션: hero·about·business·products·reference·support) | 350 |
| `website/assets/style.css` | 스타일. 1080 / 900 / 620 브레이크포인트 | 434 |
| `website/assets/main.js` | 모바일 메뉴·스크롤 스파이·브랜드 렌더링·REFERENCE 탭 | 121 |
| `website/assets/config.js` | 쇼핑몰 주소 + 취급 브랜드(관리자가 고이는 유일한 설정) | 32 |
| `website/assets/img/` | 공식 로고 4종 + 프로젝트/본사 사진 7종 (총 ~900KB) | — |
| `website/README.md` | 실행·쇼핑몰 연결·콘텐츠 출처 | 85 |
| `website/docs/screenshots/` | 1920 / 1440 / 820 / 390(일반·메뉴) | 5 |
| `reports/cgi-company-website-work-report.md` | 본 보고서 | — |

**다른 에이전트 파일은 건드리지 않았습니다.** PR #15 의 `site/`, PR #6/#12 의 수집·마스터 파일은 **참조만** 했고,
쇼핑몰은 **링크로만** 연결했습니다(복제·수정 없음).

## B4. 브라우저 테스트 결과 (실브라우저, 로컬 http://127.0.0.1:8811)

### 반응형 4종

| 뷰포트 | 그리드(사업/사진/브랜드) | 메뉴 | 가로 넘침 | 깨진 이미지 | 터치영역 |
|---|---|---|---|---|---|
| **1920px** | 4 / 3 / 6 | 인라인 | **없음** | 0 | 이상 없음 |
| **1440px** | 4 / 3 / 6 | 인라인 | **없음** | 0 | 이상 없음 |
| **820px** | 2 / 2 / 4 | 햄버거 | **없음** | 0 | 24px 미만 0건 |
| **390px** | 1 / 1 / 2 | 햄버거 | **없음** | 0 | 24px 미만 0건 |

- 이미지 비율: 전 뷰포트 **16:10 고정** (`aspect-ratio` 대신 figure 에 비율을 주고 img 를 absolute 로 채우는 방식 — 대체요소의 내재 비율이 우선되는 문제 해결)
- 가로 스크롤 폭 = 뷰포트 폭 (초과 요소 0건)
- 이미지 10개 중 8개 로드, 2개는 숨겨진 RENTAL 탭 내부(미로딩이 정상) · **깨진 이미지 0건**

### 인터랙션

| 기능 | 결과 |
|---|---|
| 모바일 메뉴 | 닫힘 → 열림(visibility visible, body 스크롤 잠금) → 링크 클릭 시 닫힘 + 앵커 이동 |
| REFERENCE 탭 | INSTALL ⇄ RENTAL 전환 정상 (패널 hidden 속성) |
| FAQ 아코디언 | 4개 모두 토글 동작 |
| 스크롤 스파이 | 섹션 진입 시 해당 메뉴 `aria-current` 표시 |
| **브랜드 칩 → 쇼핑몰** | `../site/index.html?brand=Shure` 클릭 → 쇼핑몰에서 **Shure 9건** + 체크박스 체크 상태까지 동기화 확인 |
| **제품 보기 → 쇼핑몰** | 5개 링크 모두 `../site/index.html` + `target=_blank`, 실제 이동 확인 |

### 개발 중 실측 결함 3건 수정

| 결함 | 원인 | 조치 |
|---|---|---|
| 검정 바의 로고가 흰 사각형으로 보임 | `filter: brightness(0) invert(1)` 이 형상까지 흰색으로 평탄화 | 흰 배경 로고를 알파 마스크로 변환해 **흰색 마크 PNG** 제작 후 교체 (태그라인 포함 lockup 은 밝은 면에서 녹색으로 표기) |
| 사진 카드가 세로로 늘어나 distortion | `aspect-ratio` 가 대체요소 내재 비율에 밀림 | figure 에 비율 부여 + img absolute + object-fit cover 로 변경 |
| 푸터/문의 링크 터치영역 20~21px | 인라인 링크에 패딩 없음 | `display:inline-block; padding` 로 24px 이상 확보 (WCAG 2.2 최소 타깃 충족) |

## B5. 미완료 사항 (대표 확인 필요)

| 항목 | 상태 | 비고 |
|---|---|---|
| **기존 운영 홈페이지 교체** | **미배포** | `https://cgiinc.kr` 가 현재 Cloudflare 521(origin down)로 접속 불가. 도메인·호스팅 권한·개편업체 범위 확인 후 반영 필요. **기존 운영 사이트는 일절 수정하지 않았습니다.** |
| 실주소 배포 | **미수행** | 도메인/인프라 권한 확인 후 진행 |
| 기존 CGI 홈페이지와의 링크 연결 | **미수행** | Issue #11 §1 — 관리자 권한·개편업체 범위 확인 필요 |
| 주문·결제 | **미구현(의도적)** | 스마트스토어 개설 전. 홈페이지에 장바구니·주문 버튼을 만들지 않았고, 문의 안내로 대체 |
| **본사 호실 번호 상이** | **확인 필요** | 2017 회사소개서는 "광주드림파크 **111호**", 2026 카다로그는 "**104호**". 더 최신인 카다로그 값(104호)을 사용했고, 출처를 이 보고서에 기록 |
| 회사 연혁 최신분 | **2017년 기준** | 2018년 이후 연혁은 회사 자료 미확보. 대표님 제공 시 반영 |
| 브랜드 31종 | Issue #5 실측 기준 | 실제 취급 범위 확정 시 `config.js` 1곳 수정 |
| FAQ 4개 | 자체 문안 | 회사 대표 검토 필요(공식 Q&A 자료 미확보) |

## B6. 재실행 방법

```bash
# 1) 작업 폴더 준비 (PR #15 쇼핑몰과 같은 루트에 두면 링크가 그대로 동작)
git clone https://github.com/skerishKang/kbs261022.git
cd kbs261022
git checkout feature/issue-18-cgi-company-website   # 이번 작업
git fetch origin feature/issue-11-catalog-site:pr15  # PR #15 쇼핑몰
git checkout pr15 -- site/                            # site/ 만 체크아웃(다른 파일은 건드리지 않음)

# 2) 로컬 실행
python -m http.server 8811 --directory .
#   홈페이지  : http://127.0.0.1:8811/website/index.html
#   쇼핑몰    : http://127.0.0.1:8811/site/index.html
#   브랜드 연결: http://127.0.0.1:8811/site/index.html?brand=Shure

# 3) 브라우저 검증 (BrowserSkill)
bsk session start --no-focus --json
bsk navigate "http://127.0.0.1:8811/website/index.html" --session <id>
bsk emulate --width 390 --height 844 --session <id>      # 모바일
bsk screenshot --full-page --out out.png --session <id>
bsk session stop <id>
```

## B7. AI 공동검토용 기록

```text
PROJECT=CGI
ISSUE=18
PR=(이 PR)
REPOSITORY=skerishKang/kbs261022
WORK_DATE=2026-10-22
AGENT=OpenCode
MODEL=MiniMax M3.1 Flash (free tier)
DEVICE=CGI-1 (Windows 11, Tabbit Chromium 153 + BrowserSkill 0.3.3, bsk daemon 0.3.3 pid 27816)
WORKTREE=D:\1022\wt18 (feature/issue-18-cgi-company-website, origin/main 기준)
OBJECTIVE=기존 CGI 홈페이지를 실제 자료로 조사·분석하고, 그 구조를 재사용한 CGI 회사 홈페이지 시연본 구현 + 쇼핑몰 연결
INPUTS=
  - Z:\홈페이지\홈페이지제작가이드(참고사항포함).docx  (기존 홈페이지 메뉴/요구사항)
  - Z:\홈페이지\CGI카다로그8P.pdf  (회사 소개·사업·연혁·실적·연락처)
  - Z:\1.회사소개서\...회사소개서.pdf (2017 회사 개요·인사말·연혁)
  - Z:\시지아이 로고\, Z:\3.카다로그\2.스마트팜\시지아이로고_250711.png (공식 로고)
  - Z:\1.회사소개서\_171025 기업SNS 홍보교육용\ (홍보용 사진)
  - Issue #5 실측 (samasound.co.kr 31개 브랜드)
  - PR #15 site/ (쇼핑몰, 참조만)
IMPLEMENTED=website/{index.html,assets/{style.css,main.js,config.js},assets/img/*,README.md,docs/screenshots/*}
EXECUTION_EVIDENCE=
  - https://cgiinc.kr 실브라우저 확인: 521 Web server is down / http:// 는 '도메인 셋팅이 잘못 되었습니다'
  - CGI-1 브라우저 기록에서 cgiinc.kr · cgi@cgiinc.kr · blog.naver.com/cgiinc · \\cgibusiness 발견
  - docx 본문 추출로 대메뉴 4종 + '대분류 검정 배경' 요구 확인
  - 카다로그 8P / 회사소개서 2017 텍스트 추출로 회사정보 확인 (대표이사 김범신 일치)
  - 로고 픽셀에서 주색 #07913A 추출
  - 로컬 http://127.0.0.1:8811/website/index.html 실브라우저 검증
  - 반응형 1920/1440/820/390 4종 실측 + 캡처 5종
  - 브랜드 칩 → 쇼핑몰 brand 필터 실제 이동 확인(Shure 9건)
TESTS=
  - 반응형 4종: 가로 넘침 0, 깨진 이미지 0, 24px 미만 터치영역 0, 이미지 16:10 유지 — 4/4
  - 인터랙션: 모바일메뉴 3단계, REFERENCE 탭 2, FAQ 4, 스크롤스파이, 쇼핑몰 링크 2종 — 10/10
  - 결함 3건(로고 반전/이미지 비율/터치영역) 수정 후 재검증 통과
OBSERVED_FACTS=
  - 기존 CGI 홈페이지(https://cgiinc.kr) 는 현재 접속 불가(HTTPS 521 / HTTP 도메인셋팅 오류)
  - 저장소 문서·이슈 19개·PR 본문에 홈페이지 주소 없음 → 브라우저 기록에서만 확인
  - 회사 = (주)시지아이 / CGI Inc, 대표이사 김범신, 설립 2011-01-21, 직원 7명, TEL 062)576-8100
  - 대메뉴 4종(ABOUT/PRODUCTS/REFERENCE/SUPPORT), 대분류 배경 검정 요구
  - 홈페이지는 캐러셀·팝업 등 확장 UI 없이 단일 페이지 앵커 구성으로 구현
MODEL_CLAIMS_NOT_INDEPENDENTLY_VERIFIED=
  - "전국 대리점망 구축" (카다로그 기재) — 실제 대리점 현황 미확인
  - 회사 연혁 2018년 이후분 — 자료 미확보
  - FAQ 4개 문안 — 회사 공식 Q&A 자료 미확보
  - 2018~2026 납품 실적 추가분 — 카다로그 8P 기준만 반영
LIMITATIONS=
  - 실주소 배포 없음 / 기존 운영 홈페이지 교체 없음(접속 불가 상태라 무개입)
  - 주문·결제 미구현(스마트스토어 개설 전, 의도적 제외)
  - 본사 호실 111호(2017) vs 104호(2026 카다로그) 상이 — 최신값 채택, 대표 확인 필요
  - 상품 가격을 홈페이지에 표시하지 않음(쇼핑몰에 있고, 거기도 참고용 공개가)
OUTPUTS=website/, reports/cgi-company-website-work-report.md, website/docs/screenshots/
MERGED=NO
DEPLOYED=NO
LIVE_VERIFIED=YES (로컬 http://127.0.0.1:8811 실브라우저 검증)
REMAINING=
  - 대표 확인: 본사 호실번호 / 2018년 이후 연혁 / FAQ 문안 / 실제 취급 브랜드 범위
  - 도메인·호스팅 권한 확보 후 실주소 배포
  - 기존 CGI 운영 홈페이지 연결(Issue #11 §1) — 개편업체 범위 협의 후
  - Issue #19 Excel DB 완성 후 config.js 로 취급 범위 동기화
NEXT=
  - 대표님 확정(호실/연혁/FAQ/브랜드) → 홈페이지 반영 → 도메인 권한 확인 → 실주소 배포 → 기존 홈페이지 연결 → #19 Excel DB 로 동기화
```
