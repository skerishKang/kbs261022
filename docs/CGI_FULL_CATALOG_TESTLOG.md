# 개발·검증 기록 (AI용) — 전체 상품 조사·수집 (이슈 #19)

> 환경: CGI-1 / Windows 10.0.22631 / Python 3.13 / Node v24.20.0 / Playwright-core(Chromium 1248)
> 수행: 2026-10-22 · 브랜치 `feature/issue-19-full-catalog` · 이슈 #19

## 1. 기존 산출물 재사용 원칙

| 기존 자산 | 출처 | 이번 작업에서의 사용 |
|---|---|---|
| 수집 파서·분석 로직 | PR #12 `skills/cgi-catalog-collector/scripts/collect_cgi_catalog.py` (커밋 5814f24) | `tools/full_catalog/collect_cgi_catalog.py` 에 **원본 그대로 vendoring**(출처 표기) 후 import 재사용. 수정 없음 |
| 카테고리 발견 경로 | PR #12 SKILL.md §2.3 | 삼아사운드 `cate_no` 1..520 스위프(유효 361), 삼아스토어 sitemap 카테고리 532 + 스위프 보강 |
| 상품 마스터 스키마 | PR #8 `schemas/product-master-record.schema.json` (브랜치 `feature/issue-8-product-master`) | 필드 정렬 기준(참조만, **수정 없음**) — `source_key`, `verification_status` enum, `price_type` 의미를 따름 |
| 쇼핑몰 데이터 계약 | PR (브랜치 `feature/issue-11-cgi-catalog-site`) `site/data/catalog.schema.json` | `catalog.full.json` 을 **동일 스키마**로 생성(해당 파일은 수정하지 않음) |
| 엑셀 생성기 | 전 브랜치 검색 결과 **없음** | 이번에 직접 구현(`build_product_db.py`) |

충돌 회피: 별도 worktree(`wt-issue19`) + 별도 브랜치. 다른 에이전트 파일 미수정.

## 2. 수집 실행 기록

```
[12:54:22] === stage: discover categories ===
[12:55:06] samamusic categories from sitemap: 532
[12:55:59] samamusic categories discovered: 532
[12:58:01] samasound list crawl done: categories=361 unique_products=2281
[13:00:59] samamusic list crawl done: categories=532 unique_products=2294
[13:22:12] samasound detail crawl done: 2281/2281
[13:29:26] samamusic detail crawl done: 2294/2294
[13:29:26] done. cache hit=2024 miss=2551 errors=0
```

| 지표 | 값 |
|---|---|
| 카테고리 | 삼아사운드 361 / 삼아스토어 532 |
| 목록 unique | 2,281 / 2,294 |
| 상세 | 2,281 / 2,294 (100%, 오류 0) |
| 캐시 | 8,054 URL (재실행 시 네트워크 0) |
| 동시성/지연 | 6 workers / 0.2s, robots Disallow 경로 미방문 |

## 3. 검증 결과

### 3.1 브라우저 교차검증 (`browser_verify.mjs`)

- 표본: 계층화 48건 — 층 구성 `samasound|inquiry_price|noopt 2,281`, `samamusic|numeric_price|noopt 1,548`, `numeric_price|opt 569`, `inquiry_price|noopt 71`, `inquiry_price|opt 18`, `sold_out_sale_completed|noopt 87`, `other|noopt 1` + 브랜드별 편입.
- 결과: **상품명 48/48, 공개가 48/48, 이미지 48/48, 옵션 48/48 일치, 브라우저 오류 0건** (불일치율 0%).

### 3.2 카테고리 뷰별 상품 수 재계산 (캐시 재분석)

| 뷰 | unique | 페이지 | 비고 |
|---|---|---|---|
| 삼아사운드 cate 23(전체상품) | 2,229 | 113 | cate23 밖 52건 추가 |
| 삼아사운드 cate 24(브랜드별) | 2,211 | 112 | |
| 삼아사운드 cate 25(제품분류별) | 2,053 | 104 | |
| 삼아스토어 cate 42 / 1152 / 97 | 216 / 583 / 57 | 12 / 31 / 4 | |

### 3.3 검색 총건수 대조 (`search_completeness.mjs`)

삼아사운드 37개 브랜드: 목록 2,220 vs 검색 2,550 (**+330**). 브랜드별 최대 차이: Rean +139, Neutrik +100, Shure +45, EV +41.
삼아스토어는 검색이 Dalue AJAX 라 총건수 텍스트 추출이 불안정해 1개 브랜드(Positive Grid 21 vs 16)만 비교.

### 3.4 공급처 관계 실측 (`investigate_sources.mjs` + probe)

samamusic ≡ samastore ≡ sama2015.cafe24(동일 샵) / samassi.cafe24 ≡ samasound(동일 샵) /
samacds(상품 0) / fliphtml5(브랜드 카탈로그 98종 1,720p) / s1forum(브랜드 셀렉터).

## 4. 개발 중 문제와 해결

| # | 증상 | 원인 | 해결 |
|---|---|---|---|
| 1 | `SyntaxError: invalid syntax` (walrus in kwargs) | `max_workers=fetcher_workers := 6` 문법 오류 | 일반 변수로 분리 |
| 2 | 백그라운드 수집 프로세스가 셸 타임아웃과 함께 종료 | 실행 명령이 프로세스 그룹을 kill | `cmd /c start /b` 로 분리 실행 + URL 캐시로 재개(네트워크 0) |
| 3 | `PermissionError` 로 JSON 읽기 실패 | 출력 경로에 디렉터리가 만들어져 파일이 그 안에 생성됨 | 출력 경로를 파일명으로 지정 |
| 4 | `ModuleNotFoundError: collect_cgi_catalog` | 스크립트 내 경로가 잘못됨(경로 오기) / 파일 복사 중 실행한 경쟁 | 경로 수정 후 재실행 |
| 5 | PowerShell `>` 리다이렉트로 JSON 이 UTF-16 으로 기록 → 파싱 실패 | PS 5.1 의 `>` 는 UTF-16(BOM) 기록 | `cmd /c "git show … > file"` 로 바이트 보존 추출 |
| 6 | 목록 파서의 `brand` 가 전부 null | 목록 페이지에는 브랜드가 없고 상세 표(제조사)에만 존재 | 브랜드 집계를 **상세 수집 결과** 기준으로 재계산 |
| 7 | 목록 JSON 이 "최초 발견 카테고리"만 보유해 카테고리 귀속이 왜곡 | `setdefault` 중복 제거 방식 | 카테고리 뷰별 집합은 캐시에서 재분석, DB 는 최초 발견값 + 뷰 통계를 병기 |
| 8 | 브라우저 표본이 1건만 선택됨 | `source_key` 필드가 원본 레코드에 없어 Set 중복 판정이 항상 true | `site:product_id` 조합으로 판정 키 변경 → 48건 |
| 9 | 브라우저 상품명이 48/48 `unknown` | `map['상품명']` 이 없는 페이지 + og:title 미사용 | `var product_name` · og:title · document.title 순으로 폴백 추가 → 48/48 일치 |
| 10 | 검색 총건수 106건 전부 `null` | 한글 정규식 코드포인트 오기(총=0xCD5C→최, 품=0xBB38→문) | Python 으로 코드포인트 확인(총=0xCD1D, 품=0xD488) 후 수정 → 38건 비교 성공 |
| 11 | `sales_status` 가 전건 "미확인" | 상태 판정이 문자열 매칭만 사용 | `availability_unverified` JSON(`use_stock`/`use_soldout`/`stock_number_displayed`) 기반 판정으로 교체 |
| 12 | `image_urls` 가 JSON 이 아니라 `|` 구분 문자열 | 원본 형식 차이 | `parse_images()` 로 두 형식 모두 처리(상대 경로 → 공급처 절대 URL) |

## 5. 산출물 위치

| 산출물 | 위치 | 공개 여부 |
|---|---|---|
| XLSX 7시트(3,232,987B, sha256 `0ba13a1d8875c2ee14d9e69c16164cc64609b9a27d973eff56e56a7e8f925e6b`) | `C:\cgi-work\catalog-data\product_db.xlsx` | 로컬 보관(대용량) |
| `catalog.full.json`(20,166,800B) | `C:\cgi-work\catalog-data\db\catalog.full.json` | 로컬 보관(대용량) |
| 원시 수집 결과(목록/상세 JSON·CSV, 캐시 8,054 URL) | `C:\cgi-work\catalog-data`, `C:\cgi-cache` | 로컬 보관 |
| 경량 CSV·통계·검증 JSON | `data/full_catalog/` (저장소) | 공개 |
| 보고서·기록 | `docs/CGI_FULL_CATALOG_*.md` | 공개 |

## 6. 미실행

- 실제 네이버 등록·ERP 변경, 이미지 재호스팅, 대표 승인 판매가
- 검색 인덱스 전용 상품(+330건 표본)의 전량 수집 경로
- 삼아스토어 검색 총건수 전 브랜드 대조(AJAX)
- 브랜드 카탈로그(fliphtml5) 페이지를 통한 모델 언급 총수 계측
