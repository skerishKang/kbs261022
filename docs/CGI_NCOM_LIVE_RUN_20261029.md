# 네이버 커머스API 라이브 실측 보고 — COM1 (2026-10-29)

> **안내(2026-10-29):** 이 문서는 파일럿 전사 기록이다. 운영 절차·계약의 최신 통합본은
> [CGI_NCOM_RUNBOOK_20261029.md](CGI_NCOM_RUNBOOK_20261029.md)이고, 오류 사례는
> [오류 레지스터](CGI_NCOM_ERROR_REGISTER_20261029.md), 배치별 수량은
> [배치 증적 수량표](CGI_NCOM_BATCH_EVIDENCE_20261029.md)에 정리돼 있다.

> 브랜치 `cgi-com1/ncom-live-20261029` (기준 HEAD `fcd18a4` = PR #132 스택 최상단)
> 지시: CENTRAL CTO → COM1(Padiem-Command-Center) 신규 세션, 네이버 Commerce API 실연동 (기준 이슈 #130)
> 범위 준수: 기존 PR #125·#127·#131·#132 재사용(중복 개발 0), COM1 기존 개발 폴더 미변경, 인증 원본 이미지 미변경, 라이브 **쓰기 0건**

## 1. 결과 요약

| 단계 | 결과 |
| --- | --- |
| 토큰 발급 | **성공** — `mode=live`, expires_in 10,799초(3시간), 값 미출력 |
| 카테고리 API | **성공** — `GET /v1/categories?last=true` 5,003 leaves, sha256 `e38792ff77ea43fa…` |
| 코퍼스 검증 | **통과** — `passed=true leaves=5003 invented=0` |
| 153경로 매핑 | 후보 30경로(2,078 상품)·모호 24경로(853)·미해결 99경로(1,644) — **상상 id 0** |
| 중복조회(read) | 파일럿 3건 `samamusic:1769/3417/3418` — **기존 상품 없음 ×3** (실호출 3회) |
| 등록 준비(build) | **registerable 0/3** — display 기본 SUSPENSION(비노출) 유지, 전송 0건 |
| 상품 등록 | **0건** — 필수 판매정보 미충족(§4), 지시서 기준대로 성공 주장하지 않음 |

## 2. 인증 — 스크린샷 → 런타임 연결 (값 비노출)

- 출처: `G:\Ddrive\...\네이버커머스API\CGI_Naver_CommerceAPI_Registration_20261029.jpg` (원본 미변경, 읽기만 수행)
- 전사 경로: Windows 내장 로컬 OCR + 환경 표준 이미지인식(VLM) 크롭 재판독 **교차검증(과결)** — 전체 이미지 1차 판독에서 Client ID 3문자(위치 7·13·14) 오판을 크롭 확대+OCR 합치로 바로잡고 실제 발급으로 최종 검증했다. 시크릿은 bcrypt salt 형식(29자, `$2a$04$` + 22자)으로 온전히 표시되어 있었고 bcryptjs 서명 생성이 이를 수용했다.
- 저장: `~/.config/cgi-erp/ncom.env`(저장소 밖, 사용자 프로필)만 — 채팅·로그·응답·커밋 어디에도 값 없음. `ncom-live.mjs`의 env-file 로더가 "비어 있는 환경 변수만" 채우는 규약 그대로 사용.
- IP: COM1 외부 IP 121.148.41.4 = 앱 등록 API호출 IP와 일치 → `GW.IP_NOT_ALLOWED` 없음.

## 3. 실측에서 발견해 수정한 결함 3건 (기존 레인 미수정)

| # | 결함 | 실측 증상 | 수정 | 테스트 |
| --- | --- | --- | --- | --- |
| 1 | 커밋된 m2b 패키지(최상위 snake_case, 본문은 `.package`) vs 라이브 레인 계약(평탄 camelCase) 불일치 | dupcheck가 `undefined` 판매자코드로 라이브 검색 3회("undefined: no existing product") | `normalizeM2bPackages()` 신설 + `loadPackages()` 적용 | unit 2건 신설(`ncom-live-m2b-normalize.test.mjs`) |
| 2 | 코퍼스 로더가 라이브 레인 래퍼 `{categories:[…]}`를 못 읽고 `{data:[…]}`만 언랩 | `CORPUS_ROWS: 0`로 "corpus ABSENT" 오표기 | `loadOfficialCorpus`에 `categories` 언랩 추가 | e2e 1건 신설(래퍼 코퍼스 파싱) |
| 3 | `findAvailability`가 `samamusic.co.kr`(cgiId) vs CSV `samamusic`(source_site) 불일치 | 재고가 항상 `source_row_missing` | `.co.kr` 접미사 정규화 비교(`erp-product-sync`와 동일 기준) | build 재실행으로 확인(재고 8/9/29 반영) |

- 관찰(미수정): `ncom-live.mjs` 헤더 주석의 읽기 게이트는 "NCOM_MODE=live + 자격증명"이지만, 클라이언트 모드가 live가 되려면 `NCOM_LIVE_WRITE=YES`도 필요하다(`ncomModeFromEnv`). 안전설계(라이브 해제에 쓰기 ack 요구)를 유지하기 위해 코드가 아닌 이 문서로 기록만 남긴다 — 운영자는 두 값을 함께 내보낸다(런북 §3과 결과 동일).

## 4. 파일럿 3건 — 등록 준비 상태 (정직한 판정)

`build`(전송 0건) 기준, 3건 공통 display=**SUSPENSION(비노출)**:

| 필드 | 상태 | 해소 주체 |
| --- | --- | --- |
| 판매가 | 확정(116,000 / 518,000 / 1,818,000원) | — |
| 재고 | **해소** — 공급처 표시 8/9/29, 2026-10-22 측정(14일 이내 신선), 검증 규칙 통과 | — (결함 3 수정으로 반영) |
| 중복 | **해소** — 3건 모두 기존 상품 없음(라이브 검색) | — |
| leafCategoryId | 후보 확보: `레코딩`→50002974 '레코딩장비'(0.72, candidate), `K&M 스탠드`→0.84 동점 3개(ambiguous) | 운영자 리프 확정 → `--category-file` |
| detailContent | M1 초안 존재 — 승인 파일만 반영 | 운영자 `--detail-dir` |
| images.representative | 업로드 계획 확정(대표 1) — 라이브 업로드는 쓰기 게이트 | 운영자 `upload --execute` |
| deliveryInfo | 고객 확정 자료 없음 — 정책 파일이 있을 때만 본문 반영 | 고객 `--policy-file` |

**등록 가능 0/3** — 고객 입력(배송·클레임·원산지·AS·KC)과 운영자 확정(리프·상세본문)이 남아 있다. 등록은 실행하지 않았고, 실행해도 기본 비노출(SUSPENSION)이다.

## 5. 검증 기록

- 백엔드 전체: **779 tests / 779 pass / 0 fail** (신규 3건 포함. 기준 문서의 Windows 3실패는 이 스택(fcd18a4)에서 이미 해소된 상태)
- `tools/security/scan_secrets.py` **PASS**
- 라이브 산출물(커밋됨): `reports/data/naver/category_corpus_live.json`(845KB, sha256 기록), `category_corpus_verification.json`, `category_paths_live.csv`, `category_mapping_summary_live.json`, `reports/data/registration/live/dupcheck_latest.json`, `live/pilot_register_request.json`
- 라이브 네이버 호출: 토큰 1 + 카테고리 1 + 중복조회 3 = **읽기 5회, 쓰기 0회**
- 산출물에 공급처 호스트·자격증명 없음(스캔 확인)

## 6. 다음 단계 (운영자/고객)

1. 운영자: `category_paths_live.csv`에서 파일럿 3건 리프 확정 → `{ "samamusic.co.kr:1769": "<leafId>", … }` 저장
2. 운영자: 상세본문 승안 파일 준비(`--detail-dir`), `upload --execute`로 대표 이미지 업로드
3. 고객: 배송·클레임 정책(`--policy-file`), 원산지·AS·KC 확정 자료
4. 이후 `build` 재실행 → registerable 3/3 확인 → `register --execute --i-confirm-register`(비노출 등록) → 장부 기록
