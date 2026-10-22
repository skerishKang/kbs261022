# CGI 통합 시연본 — 배포 설정 및 필요한 도메인 정보

> Issue #18 · 2026-10-22
> 이 문서는 **실주소 배포를 위해 대표님/관리자에게 필요한 항목**을 정리한 것입니다.
> 현재 산출물은 **정적 파일**이며 빌드 단계·서버측 코드·DB가 없습니다.

---

## 1. 배포 대상 물리 구성

```
<배포 루트>/
├── website/          ← CGI 회사 홈페이지 (index.html, assets/)
└── site/             ← CGI 상품 쇼핑몰 (index.html, product.html, assets/, data/, config.js)
```

**두 폴더는 반드시 같은 오리진(도메인)의 같은 루트 아래에 있어야 합니다.**
링크가 상대경로(`../website/index.html`, `../site/index.html#/products`)이기 때문입니다.

### 권장 배치 3가지

| 배치 | URL 형태 | 설정 |
|---|---|---|
| **A. 도메인 루트** (권장) | `https://<도메인>/website/` , `https://<도메인>/site/` | 기본값 그대로 사용. 변경 없음 |
| **B. 서브경로** | `https://<도메인>/catalog/` (쇼핑몰), `https://<도메인>/` (홈페이지) | `site/config.js` 의 `homepageUrl` → `../` , `website/assets/config.js` 의 `mallUrl`·`mallListUrl` → `../catalog/index.html` / `../catalog/index.html#/products` |
| **C. 별도 서브도메인** | `https://cgi.co.kr/` (홈페이지), `https://catalog.cgi.co.kr/` (쇼핑몰) | `website/assets/config.js` 의 `mallUrl` → `https://catalog.cgi.co.kr/index.html`, `mallListUrl` → `.../#/products` ; `site/config.js` 의 `homepageUrl` → `https://cgi.co.kr/` |

설정 파일은 **2곳뿐**이며, 코드 수정이 아니라 값 교체만 하면 됩니다.

| 파일 | 키 | 기본값 |
|---|---|---|
| `website/assets/config.js` | `mallUrl` | `../site/index.html` |
| `website/assets/config.js` | `mallListUrl` | `../site/index.html#/products` |
| `website/assets/config.js` | `mallDataUrl` | `../site/data/products.js` |
| `site/config.js` | `homepageUrl` | `../website/index.html` |
| `site/config.js` | `dataFile` | `data/products.js` |

---

## 2. 필요한 도메인·호스팅 정보 (대표님/관리자 확인 사항)

| # | 필요 항목 | 현재 확인된 사실 | 필요한 것 |
|---|---|---|---|
| 1 | 사용할 도메인 | `cgiinc.kr` DNS가 Cloudflare에 등록되어 있음(검증 완료). **https://cgiinc.kr 현재 521(origin down)**, `http://` 는 오리진이 "도메인 셋팅이 잘못 되었습니다" 를 반환 | **신규 시연 주소** 권장. 예: `https://cgi.co.kr/` 또는 `https://demo.cgiinc.kr/`. 기존 운영 홈페이지와 분리된 신규 주소 |
| 2 | 오리진 서버 상태 | 521 발생 중 = 오리진이 HTTPS 연결을 응답하지 않음. HTTP 는 한국어 오류 페이지를 반환(Host 불일치) | **오리진 웹서버의 도메인 설정 확인** 또는 **Cloudflare → 오리진 경로 점검**. 사내 서버에 도메인을 등록하지 않았을 가능성 |
| 3 | DNS 관리 권한 | `cgiinc.kr` 가 Cloudflare DNS 사용 중(과거 접속 이력으로 확인) | Cloudflare zones / DNS 레코드 **수정 권한** (또는 DNS 담당자 지정) |
| 4 | HTTPS 인증서 | Cloudflare proxied 도메인 → 서버리스 인증서(Origin CA) 방식 | 인증서 방식 확정(Cloudflare 자동 / 사내 인증서) |
| 5 | 정적 호스팅 계정 | 미확인 | Netlify / Vercel / Cloudflare Pages / GitHub Pages / 사내 웹서버 중 **하나** + 계정/키. **GitHub Pages 는 사내 DNS 와 연결 제약이 있으므로 DNS 권한이 있을 때 유리** |
| 6 | 배포 대상 폴더 | `website/` + `site/` | 두 폴더를 함께 배포할 단위(루트 또는 서브경로) |
| 7 | 개편업체 협의 | `Z:\홈페이지\홈페이지제작가이드` 가 존재 → 이전에 홈페이지 개편을 의뢰한 흔적 | **기존 운영 홈페이지 교체 여부/범위**, 개편업체 담당 범위. **허가 없이 교체하지 않습니다** |
| 8 | 사업자 표시 정책 | 사업자등록증명 410-86-46283 확인(법인등기 기준) | 쇼핑몰·홈페이지 하단에 **사업자등록번호 표시 여부**(일반적 표시 권장). 법인등록번호는 게시하지 않겠습니다 |
| 9 | 개인정보·약관 | 현재 수집·주문 기능 없음(쿠키·세션·결제 미사용) | 추후 주문 단계에서 개인정보처리방침·이용약관 필요. **현재는 해당 없음** |
| 10 | 서버측 기능 | **없음** (순수 정적) | PHP/Node/DB 불필요. 정적 호스팅이면 충분 |

---

## 3. 배포 절차 (권장 순서)

1. **신규 시연 주소 확보** — 위 2번 항목(오리진/도메인 설정) 정리 후, 기존 운영 주소와 분리된 주소를 받습니다.
2. **정적 호스팅 계정 준비** — 5번 항목.
3. **폴더 배치** — `website/` 과 `site/` 을 §1 의 배치(권장 A)에 따라 업로드.
4. **연결 주소 확인** — 배치에 따라 §1 표의 설정값을 `website/assets/config.js` / `site/config.js` 에 반영.
5. **HTTPS + Mixed Content 확인** — 상대경로만 쓰므로 https→http 혼용 문제는 없습니다.
6. **브라우저 검증** — 아래 체크리스트를 실제 브라우저(PC/모바일)로 통과시킨 뒤 보고드립니다.
7. **기존 운영 홈페이지 연결** — 개편업체 협의(7번) 완료 후, "제품 보기" 를 기존 홈페이지 메뉴에 연결. **이번 시연본은 기존 홈페이지를 건드리지 않습니다.**

### 배포 후 체크리스트

| # | 항목 | 기준 |
|---|---|---|
| 1 | 홈페이지 진입 | `/website/index.html` 정상 표시 |
| 2 | 쇼핑몰 진입 | `/site/index.html` 정상 표시 |
| 3 | 홈페이지 → 쇼핑몰 | "제품 보기" 5곳 + 브랜드 칩 36개 이동 |
| 4 | 쇼핑몰 → 홈페이지 | 상단 "회사 홈페이지" / 푸터 / 상세 브레드크럼 3곳 |
| 5 | 브랜드 필터 | `?brand=SHURE` → 8건, `?brand=K%26M` → 정상 빈 화면 |
| 6 | 반응형 | 1920 / 1440 / 820 / 390 — 가로 스크롤 0, 깨진 이미지 0 |
| 7 | 콘솔 | 사이트 출처 오류 0 |
| 8 | 데이터 교체(#19) | `site/data/products.js` 교체 → 양쪽 자동 반영 확인 |

---

## 4. 이슈 #19 전체 상품 DB 연결 절차

수집기·Excel 생성기는 **이 PR에서 만들지 않았습니다**(별도 이슈 #19 담당). 연결 경로만 준비되어 있습니다.

```
공통 상품 마스터 (이슈 #19 산출물: 전체 4,575건 CSV/XLSX)
        │  python tools/build_catalog_data.py --master-csv <전체마스터.csv> \
        │                                 --sample-json <샘플.json> --categories <카테고리.csv>
        ▼
site/data/products.json  +  site/data/products.js   (window.CGI_PRODUCTS)
        │
        ├─▶ 상품 쇼핑몰   : 목록·브랜드/카테고리/공급처 필터·상세가 자동 확장
        ├─▶ 회사 홈페이지 : 브랜드 칩 36개 → 데이터 보유 브랜드 20종 → 전체로 자동 확장
        └─▶ 추후 네이버 스마트스토어 등록 : 동일 마스터에서 등록 데이터 생성
```

**홈페이지 코드는 수정할 필요가 없습니다.** `website/assets/config.js` 의 `mallDataUrl` 이
`../site/data/products.js` 를 읽고 브랜드·건수를 자동 표시하기 때문입니다.

### 확인된 교체 방식 2가지

| 방식 | 방법 | 검증 |
|---|---|---|
| A. 기본 파일 교체 | `site/data/products.json` / `products.js` 를 재생성 → 양쪽 자동 반영 | 기본값 경로가 `mallDataUrl`·`dataFile` 에 설정됨 |
| B. 대체 파일 지정 (실험용) | `site/index.html?data=data/<다른파일>.json` | **실측 확인 완료** — 대체 파일 5건 + 자체 meta(`supplier_catalog_totals`·`data_origin`)가 정상 적용됨 |

> 방식 B의 테스트 파일은 검증 후 삭제했습니다(저장소에 남지 않음).

---

## 5. 하지 않은 것 (배포 관점)

- **실주소 배포 없음** — 2번(도메인/오리진)·5번(호스팅) 항목이 정리되면 즉시 진행 가능합니다.
- **기존 `cgiinc.kr` 을 건드리지 않았습니다.** 현재 접속 불가 상태이며, DNS·호스팅·개편업체 협의 없이는 교체하지 않습니다.
- **서버측 코드·DB·빌드 파이프라인 없음** — 순수 정적 파일이라 별도 준비물이 없습니다.
