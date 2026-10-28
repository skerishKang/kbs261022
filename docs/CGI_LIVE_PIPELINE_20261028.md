# 네이버 커머스API 라이브 실행 경로 — 구현·운영 런북 (2026-10-28)

> 브랜치 `local2/naver-live-pipeline-20261028` (기준 HEAD `9077314`, PR #131 스택 위 후속)
> 지시: CENTRAL CTO → CGI-1 LOCAL2, 네이버 Commerce API 실연동 및 자동 상품등록 완성 (기준 이슈 #130)
> 범위 준수: ERP 연동 제외(docs/CGI_M2B_ERP_DEFERRED_20261028.md), LOCAL1 UI·LOCAL3 감사 파일 미변경, 기존 mock 전용 도구 미수정

## 1. 오늘의 결정적 사실 — 브라우저 로그인 레인 차단 (외부 의존)

| 점검 | 결과 |
| --- | --- |
| CGI-1 Chrome(bsk 인스턴스 `008fca49`, Chrome 154) | 네이버 본 계정 **미로그인** — www.naver.com 헤더가 "로그인" 상태 |
| 커머스API센터(apicenter.commerce.naver.com/ko) | **미로그인** — 헤더에 "로그인"·"계정생성" 링크 노출 |
| 기존 Chrome 로그인 세션 재사용 | **불가** — 세션이 존재하지 않는다 |

- 차단 위치가 정확히 어디인가: **네이버 계정 세션 자체가 없다.** API 센터 로그인은 네이버 계정 OAuth 뒤에 있으므로, 재로그인 없이는 ①기존 내스토어 애플리케이션 조회 ②SELF 앱 등록 ③Client ID·Secret 발급 ④API 호출 IP 등록 중 어느 것도 진행할 수 없다.
- 지시서 규정("기존 Chrome 세션을 사용할 수 없으면 정확한 차단 위치를 보고하고, 로그인 상태를 임의로 변경하지 않는다")과 이전 보고(`01_스마트스토어_계정_기능_확인_보고_20261028.md` — "비밀번호·2단계 인증은 사람만 수행")에 따라, **LOCAL2는 저장된 자격증명으로 자동 로그인을 시도하지 않았다.**
- 필요한 사람 동작(운영자·고객): CGI-1 Chrome에서 **네이버 계정 재로그인 → 커머스API센터 로그인**. 이후 §3 런북을 그대로 실행하면 된다. API센터 개발자 계정 가입은 통합매니저 권한이 있는 CGI 계정으로 최초 1회 필요할 수 있다(기존 앱이 있으면 불필요).

## 2. 이번에 구현한 것 — 라이브 실행 경로 (기존 레인과 분리)

기존 mock 전용 도구는 한 줄도 수정하지 않았다. 검증된 구성품을 재사용하는 **별도 라이브 레인**을 새로 만들었다.

| 파일 | 역할 | 재사용한 검증 구성품 |
| --- | --- | --- |
| `backend/lib/ncom-live-pipeline.mjs` | 라이브 레인 라이브러리: 운영자 게이트, 공급처 재고 변환, 등록 패키지 조립, 이미지 업로드 실행, 중복조회·등록 실행, 실행 장부 | `createNcomAuthRuntime`(토큰·재시도), `buildRegisterBody`(등록 본문 계약), `registerOrModify`(중복조회 결정), `planImageUpload`, `NCOM_LIMITS` |
| `tools/naver/ncom-live.mjs` | 운영자 CLI: `token · categories · mapping · upload · dupcheck · build · register · status` | `createLocalNcomAuth`(bcryptjs 봉합), `imagesFromLedger` |
| `backend/test/unit/ncom-live-pipeline.test.mjs` | 게이트·재고·조립·장부 계약 11 test | — |
| `backend/test/e2e/ncom-live-pipeline.test.mjs` | 루프백 mock 게이트웨이 전 구간 7 test (업로드 배치·등록 직전 검색·duplicate_blocked·PUT 0건) | `mock-ncom.mjs` |

### 게이트 (전송 전에 전부 걸린다)

| 동작 | 요건 |
| --- | --- |
| 읽기(token·categories·dupcheck) | `NCOM_MODE=live` + `NCOM_CLIENT_ID`/`NCOM_CLIENT_SECRET` (환경 변수만) |
| 쓰기(upload) | 위 + `NCOM_LIVE_WRITE=YES` + `--execute` |
| 등록(register) | 위 + `--i-confirm-register` |
| 판매노출 ON | 기본값은 **SUSPENSION(비노출 등록)** — `--display-status ON --sell-ack` 로 고객 판매개시 결정을 명시 승인한 경우만 |

- 자격증명은 `--env-file`(기본 `~/.config/cgi-erp/ncom.env`)에서 읽어 **비어 있는 환경 변수만** 채운다. 값은 어디에도 출력되지 않고, 토큰 발급 결과는 만료 시각만 보고한다.
- 등록은 **상품마다 등록 직전** `sellerManagementCode` 검색으로 중복을 확인한다(`registerOrModify` execute=false 계약 재사용). 기존 상품이 잡히면 `duplicate_blocked`로 남기고 **PUT(전체 덮어쓰기)은 절대 실행하지 않는다.**
- 등록 성공·중복확인 사실은 실행 장부 `reports/data/registration/ncom_registration_ledger.json`에 기록된다(재실행 시 검색이 1차 방어선, 장부가 2차 기록).

### 재고 — 공급처 표시 수량의 유효성 검증 규칙 (`mapSupplierStock`)

지시서 §6("파일럿 3건은 기존 원본 재고가 있는 것으로 보고됐으므로, 재고 유효성을 검증한 후 필요한 수량만 활용")에 따라:

- 출처: 커밋된 `product_db_compact.csv` `availability`(공급처 페이지 실측, `verified_against_source_page`)
- `use_stock=true` 이고 표시 수량이 1 이상일 때만 사용, 소수는 내림(올림 금지), 상한 99,999,999
- **0(품절)·음수·미관리(use_stock=false)·파싱 불가는 거부** — 사유는 결과에 보존
- 측정 후 336시간(14일) 경과분은 `stale_measurement` 거부 → 재측정 또는 `--stock-ack` 운영자 승인 필요

파일럿 3건 실측(커밋 데이터 기준):

| cgi_id | 표시 재고 | 수집 시각 | 판정 |
| --- | --- | --- | --- |
| samamusic.co.kr:1769 (K&M 19797) | 8 | 2026-10-22T05:16:51Z | 10-28 기준 신선 — 사용 가능 |
| samamusic.co.kr:3417 (iZOTOPE RX 12 Standard) | 9 | 〃 | 〃 |
| samamusic.co.kr:3418 (iZOTOPE RX 12 Advanced) | 29 | 〃 | 〃 |

## 3. 운영 런북 — 로그인 확보 후 그대로 실행

```powershell
# 0) 자격증명 파일 준비(운영자 — 저장소 밖, 커밋 금지)
#    ~/.config/cgi-erp/ncom.env 에:
#    NCOM_CLIENT_ID=<API센터에서 발급>
#    NCOM_CLIENT_SECRET=<API센터에서 발급 — 최초 1회만 표시>

# 1) 토큰 발급 점검(값 미출력, 만료시각만 보고)
node tools/naver/ncom-live.mjs token

# 2) 카테고리 코퍼스 수집(live) → 검증 → 153경로 매핑
node tools/naver/ncom-live.mjs categories
node backend/tools/naver-category-corpus.mjs verify --corpus reports/data/naver/category_corpus_live.json
node backend/tools/naver-category-candidates.mjs --corpus reports/data/naver/category_corpus_live.json
#    → 후보표에서 파일럿 3건의 리프를 운영자가 확정해 JSON 으로 저장:
#      { "samamusic.co.kr:1769": "<leafCategoryId>", ... }

# 3) 등록 전 중복조회(read)
node tools/naver/ncom-live.mjs dupcheck

# 4) 파일럿 이미지 업로드(live, 쓰기 게이트) → ledger 반환 URL
node tools/naver/ncom-live.mjs upload --execute

# 5) 등록 본문 조립·검증(전송 0건) — 미충족 항목이 pending 으로 전부 보고된다
node tools/naver/ncom-live.mjs build --category-file <확정리프.json> --detail-dir <승인상세본문dir> --policy-file <고객배송정책.json>

# 6) 등록 실행(비노출 등록 — 기본 SUSPENSION)
node tools/naver/ncom-live.mjs register --execute --i-confirm-register `
  --category-file <확정리프.json> --detail-dir <승인상세본문dir> --policy-file <고객배송정책.json>

# 7) 상태 확인
node tools/naver/ncom-live.mjs status
```

env 게이트: 쓰기 단계는 `NCOM_MODE=live NCOM_LIVE_WRITE=YES` 를 함께 내보내야 한다(게이트가 사유를 출력한다).

## 4. 파일럿 3건 현재 상태 (정직한 판정)

`build`/`register`가 pending 으로 보고하는 항목과 해소 주체:

| 필드 | 상태 | 해소 주체 |
| --- | --- | --- |
| 판매가 | 3건 모두 확정(116,000 / 518,000 / 1,818,000원 — 공개 신뢰 가격) | — |
| 재고 | 공급처 표시 8/9/29 실측, 검증 규칙 통과 | 운영자 `--stock-ack` (또는 재측정) |
| images.representative | 업로드 계획 확정(대표 1) | 라이브 업로드 실행(토큰 필요) |
| leafCategoryId | 코퍼스 도구 검증 완료(mock) — 실수집·매핑·운영자 확정 대기 | 토큰 → 코퍼스 → 운영자 |
| detailContent | M1 템플릿 초안 존재 — **승인 파일을 주는 경우만 반영**(자동 반영 없음) | 운영자 승인 |
| 배송·클레임(deliveryInfo) | 고객 확정 자료 없음 — **정책 파일이 있을 때만 본문에 들어간다**, 값은 만들지 않음 | 고객 |
| 원산지·AS·KC | 고객 확정 자료 없음 — 리프 certificationInfos 요구는 코퍼스 수집 후 확정 | 고객 |
| 중복검색 | 러너에 구현 완료 — 실행은 토큰 필요 | 토큰 |

**오늘 시점 등록 가능 건수: 0/3** — 이유는 §1 로그인 차단(토큰·앱 발급 불가)과 §4 고객 입력 대기. 지시서 §8 기준("실제 API 인증 또는 고객 데이터가 확보되지 않았다면 성공했다고 보고하지 않습니다")에 따라 등록 성공을 주장하지 않는다.

## 5. 검증 기록

- 신규 테스트 18건 전부 통과(unit 11 + e2e 7). 기존 전체 스위트 회귀 없음(776 tests / 773 pass / 3 fail — 3건은 베이스 `9077314`에서도 동일하게 실패하는 기존 항목: 커밋 산출물 재현 비교 3종, Windows CRLF/플랫폼 사유, CI(Linux)에선 통과).
- `tools/security/scan_secrets.py` **PASS**, 시크릿 grep(backend/site/tools) 클린, 스캐너 단위 테스트 25건 OK, 통합 테스트 19건 OK, Worker smoke PASS.
- 이 레인에서 실제 네이버 API 호출 **0건**, 토큰 발급 **0건**, 상품 등록 **0건** — 라이브 호출은 §3 런북을 운영자가 실행할 때만 일어난다.
