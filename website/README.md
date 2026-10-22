# CGI 회사 홈페이지 (issue #18)

> **(주)시지아이 · CGI Inc.** — 방송, 음향의 모든것! 고객을 위한 한 걸음!
> We express the creation of God through industry

정적 HTML/CSS/JS 로 만든 CGI 회사 홈페이지입니다. 기존 CGI 홈페이지(https://cgiinc.kr/)의
정체와 회사의 실제 자료(카다로그·회사소개서·홈페이지 제작 요청서)를 근거로 만들었습니다.

## 실행 방법

`file://` 로 열어도 동작합니다(외부 의존성 없음).

```bash
# 방법 1) 그대로 열기
start website\index.html        # Windows
open  website/index.html        # macOS

# 방법 2) 로컬 HTTP 서버 (권장)
python -m http.server 8811 --directory <루트>
# → http://127.0.0.1:8811/website/index.html
```

## 상품 쇼핑몰(PR #17, main 병합본) 연결

`website/assets/config.js` 의 `mallUrl` / `mallListUrl` **한 줄**만 바꾸면 됩니다.

```js
window.CGI_CONFIG = {
  mallUrl: '../site/index.html',                // 쇼핑몰 홈
  mallListUrl: '../site/index.html#/products',  // 쇼핑몰 전체 목록
  mallDataUrl: '../site/data/products.js',      // 공통 상품 마스터(있으면 자동 반영)
  ...
};
```

- `website/` 와 `site/` 를 같은 배포 루트에 두면 그대로 동작합니다.
- 실제 도메인을 쓰게 되면 `mallUrl` 을 전체 URL 로 바꿉니다.
- URL 파라미터로도 덮어씁니다: `index.html?mall=https://example.com/site/`
- 브랜드 칩을 누르면 쇼핑몰의 해당 브랜드 필터로 이동합니다:
  `../site/index.html#/products?brand=SHURE`

> **쇼핑몰 라우팅 규칙 (PR #17 구현 기준)** — 해시 라우터입니다.
> `#/` 홈 · `#/products` 목록 · `#/products?brand=SHURE` 브랜드 필터 · `#/product/<id>` 상세
> `brand` 값은 쇼핑몰의 `brand_norm`(대문자 정규화) 기준입니다. (Shure → `SHURE`, Q Acoustics → `Q ACOUSTICS`)

## 공통 상품 마스터 연동 (이슈 #19 대비)

홈페이지가 쇼핑몰의 상품 데이터(`site/data/products.js`)를 읽어 **브랜드 목록과 건수를 자동으로** 표시합니다.
따라서 이슈 #19의 전체 4,575건 마스터가 `site/data/products.js` 로 교체되면
**`website/` 코드는 한 글자도 바꾸지 않고** 목록·건수가 자동 갱신됩니다.

- 데이터 파일이 없거나 읽지 못하면 `config.js` 의 정적 취급 브랜드 목록(31종)으로 graceful fallback 합니다.
- `site/` 없이 `website/index.html` 만 실행해도 정상 동작합니다.

## 메뉴 구성 (기존 홈페이지 제작 요청서 기준)

| 대 메뉴 | 소 메뉴 | 이 구현 |
|---|---|---|
| ABOUT | GREETINGS / HISTORY / location | `#about` (인사말 · 주요연혁 · 오시는길) |
| PRODUCTS | 장비회사별 (사이트 참고) | `#products` (취급 브랜드 31종 + 쇼핑몰 연결) |
| REFERENCE | INSTALL / RENTAL | `#reference` (탭 전환) |
| SUPPORT | Q&A / FAQ / CONTACT | `#support` (FAQ 아코디언 + 문의) |

대분류(메뉴) 배경색은 제작 요청서 요구사항대로 **검정**입니다.
브랜드 색상은 회사 공식 로고에서 추출한 녹색 `#07913A` 를 사용합니다.

## 파일 구성

| 경로 | 내용 |
|---|---|
| `website/index.html` | 홈페이지는 단일 페이지(섹션 앵커) |
| `website/assets/style.css` | 스타일 (1080 / 900 / 620 브레이크포인트) |
| `website/assets/main.js` | 모바일 메뉴, 스크롤 스파이, 브랜드 렌더링, REFERENCE 탭 |
| `website/assets/config.js` | 쇼핑몰 주소 · 취급 브랜드 (관리자가 고이는 유일한 설정 파일) |
| `website/assets/img/` | 회사 공식 로고·마크 + 프로젝트/본사 사진 (전부 회사 소유 자료) |
| `website/docs/screenshots/` | 1920 / 1440 / 820 / 390 실제 브라우저 캡처 |

## 콘텐츠 출처 (모두 회사 자체 자료)

| 화면 내용 | 출처 파일 |
|---|---|
| 메뉴 구조·검정 배경 요구 | `Z:\홈페이지\홈페이지제작가이드(참고사항포함).docx` |
| 회사 소개·사업 분야·연혁·납품실적 | `Z:\홈페이지\CGI카다로그8P.pdf` (2016-02-22) |
| 회사 개요·인사말·연혁·주소 111호 | `Z:\1.회사소개서\...회사소개서.pdf` (2017-10-25) |
| 법인명·대표자·개업일·업종·사업장소지 | `Z:\1.회사소개서\회사소개서 자료\CGI 사업자등록증명.jpg` (2014-10-06) |
| 위치도 | `Z:\1.회사소개서\회사소개서 자료\cgi찾아오시는길.jpg` |
| 로고 | `Z:\3.카다로그\2.스마트팜\시지아이로고_250711.png` (2025-07 최신) |
| 사진 | `Z:\1.회사소개서\_171025 기업SNS 홍보교육용\` (기업 홍보용 자료) |
| 취급 브랜드 | Issue #5 실측 (samasound.co.kr) — `reports/site-analysis-model-a.md` |

## 표시 규칙

- **가격을 이 홈페이지에서 표시하지 않습니다.** 가격은 쇼핑몰(PR #17)에 있고, 거기도 원본 공개가(참고용) 구분입니다.
- **주문·결제 기능이 없습니다.** 스마트스토어 개설 전이며, 문의는 연락처로 안내합니다.
- 회사 실적·연락처는 회사 자료에 있는 것만 사용했고, 없는 항목은 만들지 않았습니다.

## 검증

`website/docs/screenshots/` 에 실제 브라우저(Tabbit Chromium, BrowserSkill 0.3.3) 캡처가 있습니다.
검증 항목과 결과는 저장소 `reports/cgi-company-website-work-report.md` 를 참고하세요.
