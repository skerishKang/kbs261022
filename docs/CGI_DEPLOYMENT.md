# CGI 주문·결제·상품 카탈로그

(주)시지아이(CGI) 쇼핑몰(`site/`)·회사 홈페이지(`website/`)와 Cloudflare 백엔드의 현재 운영 구조입니다.

## 구성

| 구성 | 이름 | 비고 |
|---|---|---|
| 쇼핑몰 | Cloudflare Pages `cgishop` → https://cgishop.pages.dev/site/ | Git 연동 없는 **수동 업로드** |
| 홈페이지 | 같은 `cgishop` 배포의 `/website/` | https://cgishop.pages.dev/website/ |
| 입찰정보 | 같은 `cgishop` 배포의 `/bid/` | https://cgishop.pages.dev/bid/ |
| Worker(운영) | `cgi-quote-api` + D1 `cgi_quotes` | 견적·주문·결제·회원 API |
| Worker(샌드박스) | `cgi-nicepay-sandbox` + D1 `cgi_quotes_sandbox` | `-c wrangler.sandbox.toml` |
| 리다이렉트 전용 | Pages `cgihomepage` | `cgishop`으로 302만 한다. 콘텐츠를 올리지 않는다. |

결제는 NICEPAY TEST(샌드박스 계약)로 동작하며 화면에 `TEST 결제` 배지가 유지된다.
운영 키로 전환하기 전에는 이 배지를 제거하지 않는다. 가격은 대리점 계약 값이며
코드·데이터 빌드에서 임의로 바꾸지 않는다.

## 사전 준비

```powershell
# Cloudflare 로그인 (OAuth, 계정 …6932)
wrangler whoami
```

- `ADMIN_TOKEN`은 **운영·샌드박스 각각 다른 값**으로 Worker secret에 저장한다.
  저장소·문서·PR에 값을 쓰지 않는다.
- D1 변경 전에는 항상 time-travel 북마크를 기록한다.
- Worker 배포 전에는 현재 버전 ID를 기록한다(롤백 대상).

```powershell
wrangler d1 time-travel info cgi_quotes
wrangler versions list --name cgi-quote-api
wrangler versions list --name cgi-nicepay-sandbox
```

## 배포 순서

1. **D1 (운영·샌드박스 둘 다)** — 새 migration이 있으면 양쪽에 적용한다.
2. **Worker (운영·샌드박스)** — `--keep-vars`로 배포한다.
3. **Pages `cgishop`** — 배포 루트를 조립한 뒤 정식 명령으로 업로드한다.

샌드박스 D1에 migration을 빼먹으면 새 코드가 참조하는 컬럼이 없어 회원가입 등이
실패한다(예: 0011 이전에는 signup이 `email already used`로 보였다). 운영과 샌드박스는
항상 같은 migration 집합을 유지한다.

### 1) D1

```powershell
cd backend

# 운영
wrangler d1 time-travel info cgi_quotes
wrangler d1 execute cgi_quotes --remote --file=migrations/0011_member_consent.sql

# 샌드박스
wrangler d1 time-travel info cgi_quotes_sandbox
wrangler d1 execute cgi_quotes_sandbox --remote --file=migrations/0011_member_consent.sql
```

- migration 파일은 `backend/migrations/`에 0001~0011로 누적되어 있다.
- `wrangler d1 execute`는 파일 단위로 실행된다. 이미 적용된 migration을 다시 실행하면
  `duplicate column`으로 실패하므로, 새 파일만 적용한다.
- 결과 확인 시 이메일·전화번호 등 개인정보를 출력하지 않는다(건수만 확인).

#### 샌드박스 D1 재구성 (손으로 칸을 더한 DB를 버릴 때)

샌드박스는 시험 데이터를 버려도 되므로, migration 이력과 실제 스키마가 어긋났을 때
새 DB를 만들어 0001부터 차례로 적용하는 편이 안전하다. **운영 DB에는 하지 않는다.**

```powershell
cd backend
wrangler d1 time-travel info cgi_quotes_sandbox          # 1) 북마크 기록
wrangler d1 delete cgi_quotes_sandbox -y                 # 2) 기존 샌드박스 삭제
wrangler d1 create cgi_quotes_sandbox                    # 3) 새 DB 생성 → database_id 기록
# 4) backend/wrangler.sandbox.toml 의 database_id 갱신
foreach ($f in (Get-ChildItem migrations/*.sql | Sort-Object Name)) {
  wrangler d1 execute cgi_quotes_sandbox --remote --file "$($f.FullName)"
}
# 5) 샌드박스 Worker 재배포 후 회원가입 201 · 주문 생성 201 확인
wrangler deploy -c wrangler.sandbox.toml --keep-vars
```

2026-11-05에 이 절차로 재구성했다(이전 `e8705a5a…` → 새 `4d670527…`, migrations 0001~0011).
샌드박스 D1을 재구성하면 기존 세션·회원·주문은 모두 사라진다.

### 2) Worker

```powershell
cd backend

# 운영
wrangler deploy --keep-vars

# 샌드박스 (자기 D1·자기 사이트 설정을 그대로 유지)
wrangler deploy -c wrangler.sandbox.toml --keep-vars
```

- `--keep-vars`가 없으면 대시보드에서 추가한 변수가 지워질 수 있다.
- 배포 전 `wrangler versions list`로 이전 버전 ID를, 배포 후 출력의
  `Current Version ID`를 기록한다.
- 헬스 체크(토큰은 환경변수로만):

```powershell
$t = $env:CGI_ADMIN_TOKEN   # 로컬 비밀 저장소에서 읽어 환경변수로만 사용
Invoke-RestMethod -Headers @{ Authorization = "Bearer $t" } `
  https://cgi-quote-api.charliekant.workers.dev/api/admin/health
```

정상 기준: HTTP 200, `pg.provider=nicepay`, `pg.mode=sandbox`, `warnings=[]`,
`site_base_url=https://cgishop.pages.dev/site`, `cors_allowed_origins`에 cgishop만.

### 3) Pages `cgishop`

배포 루트는 저장소에서 조립한다. `site/data/products.json`·`products.js`는 빌드
입력이므로 **배포에서 제외**된다(`tools/build_pages_root.mjs`).

```powershell
node tools/build_pages_root.mjs --out C:\temp\cgishop-deploy
wrangler pages deploy C:\temp\cgishop-deploy --project-name cgishop --branch main
```

배포 루트 구성:

```
<deploy-root>/
├── site/        (data/products.json·products.js·_source_* 제외)
├── website/
├── bid/         (test/ 제외 — 화면 자산만)
├── _redirects   / → /site/ 302
├── _headers     X-Robots-Tag: noindex 등 보안 헤더
└── 404.html
```

- 업로드 전·후 배포 ID를 `wrangler pages deployment list --project-name cgishop`으로 기록한다.
- `cgihomepage` 프로젝트는 `cgishop`으로의 302만 담당한다. 콘텐츠를 배포하지 않는다.

## robots / 도메인

`pages.dev`에는 아직 정식 도메인이 없으므로 모든 페이지를 검색엔진에서 제외한다.
`noindex`는 루트 `_headers`의 `X-Robots-Tag: noindex` **한 곳**에서 관리한다.
정식 도메인이 연결되고 색인을 허용할 때 그 한 줄만 제거한다(페이지별 meta 태그를
추가하지 않는다).

## 상품 데이터 빌드

```powershell
# 1) 전체 마스터 정규화 (원본 CSV/JSON → products.json, products.js)
python tools/build_catalog_data.py --master-csv <전체마스터.csv> --out-dir site/data

# 2) 기존 products.json에서 배포용 분할 산출물만 재생성
python tools/build_catalog_data.py --split-only
```

산출물:

| 파일 | 용도 |
|---|---|
| `site/data/products.json` | 전체 원본(빌드 입력, 배포 제외) |
| `site/data/catalog.json` | 목록·필터·검색·장바구니용 경량 목록 |
| `site/data/brands.json` | 홈페이지 브랜드 이름·건수 |
| `site/data/details/part-*.json` | 상세 사양·옵션·전체 이미지(100건 단위) |

쇼핑몰은 `catalog.json`만 먼저 읽고, 상세 진입 때 해당 `part-*.json`만 추가로 읽는다.
홈페이지는 `brands.json`만 읽는다.

## 롤백

- D1: `wrangler d1 time-travel restore <db> --bookmark=<배포 전 북마크>`
- Worker: `wrangler rollback --name <worker>` 또는 대시보드에서 이전 버전 선택
- Pages: 이전 배포 ID의 프리뷰 URL을 확인한 뒤 해당 배포로 되돌린다.

## 확인 체크리스트 (배포 후)

- `/` → `/site/` 302, `/site/`·`/website/` 로드
- `/bid/`(index·bids·bid·results·agency) 로드, 1440 첫 화면 표 행 8건 이상, 390 가로 넘침 0
- 쇼핑몰 첫 화면 네트워크: `data/catalog.json`만 로드(11MB `products.js` 없음)
- 목록·검색·상세·장바구니·견적 정상
- 홈페이지 브랜드 건수 표시
- 없는 주소 → `404.html`
- 응답 헤더에 `X-Robots-Tag: noindex`, `X-Frame-Options: DENY`
- 콘솔 오류 0(익명 `/api/me` 401 제외)
- 결제 화면: 가상계좌 없음, `TEST 결제` 배지 유지
