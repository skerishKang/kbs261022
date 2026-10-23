# 평문 자격증명 노출 사고 기록 (이슈 #1)

> **이 문서에는 어떤 자격증명 값도 기재하지 않는다.** 파일·커밋·유형만 기록한다.
> 조사일: 2026-10-23 · 대상 저장소: `skerishKang/kbs261022`

---

## 1. 요약

- 문제 커밋: **`fd0ad2e`** ("feat(erp): read-only Ecount comparison (964 items) and Naver probe tools")
- 노출 유형: ERP 로그인 비밀번호·사용자 ID, 네이버 로그인 비밀번호·ID가 자동화 스크립트의 **문자열 기본값(fallback)** 으로 커밋됨
- 대표 결정: **현재 비밀번호를 변경할 수 없음** → 비밀번호 교체를 기다리지 않고 저장소의 노출 문제부터 수정
- 현재 상태: 최신 `main`(`c88a3ba`)의 추적 파일에는 **알려진 값이 남아 있지 않음**(스캐너 PASS). 단 **git 이력에는 남아 있음**
- 비밀번호 변경: **미수행(CREDENTIAL_ROTATED=NO)** — 대표 결정에 따름
- Git 이력 재작성·force-push: **미수행** — 작업 경계에 따름

---

## 2. 노출 파일

| 파일 | 노출 유형 | 현재 상태 |
|---|---|---|
| `tools/smartstore/naver_login_probe.js` | 네이버 ID·비밀번호 문자열 기본값 | **이번 브랜치에서 제거** (env 전용) |
| `tools/erp/ecount_excel_download.js` | ERP 사용자 ID·비밀번호 문자열 기본값 | #20 브랜치(`e6626ca`)에서 제거 |
| `tools/erp/ecount_item_list_scrape.js` | ERP 사용자 ID·비밀번호 문자열 기본값 | #20 브랜치(`e6626ca`)에서 제거 |
| `tools/erp/ecount_playwright_probe.js` | ERP 사용자 ID·비밀번호 문자열 기본값 | #20 브랜치(`e6626ca`)에서 제거 |

추가 확인(자격증명 아님):
- `ECOUNT_USER_ID` 값은 공개 회사 도메인 문자열과 동일한 짧은 문자열이라 문서 8곳의 도메인 표기와 우연히 일치한다. 계정 비밀정보 유출로 보지 않는다.
- 삭제된 `tools/progress_report/make_cgi_progress_report.py`(커밋 `b562ab5` 계열)의 동일 문자열도 도메인 텍스트였다.

---

## 3. 이력 노출 범위

| 커밋 | 역할 | 관련 파일 |
|---|---|---|
| `fd0ad2e` | **최초 유입** | 위 4개 JS 파일 |
| `e6626ca` | ERP 3종 정리(값 제거) | `tools/erp/ecount_*.js` |
| `b562ab5` 계열 | 삭제된 진행보고 스크립트에 도메인 문자열 | 자격증명 아님 |

네이버 값은 `fd0ad2e` 이후 **현재 `main`까지** `tools/smartstore/naver_login_probe.js` 에 남아 있었다. 이번 브랜치 병합 후 최신 트리에서는 제거된다.

---

## 4. 현재 코드 조치

1. **하드코딩 제거**: 네이버 프로브를 env 전용으로 재작성.
   - `NAVER_ID`, `NAVER_PW` 필수 env. 미설정 시 즉시 종료.
   - `PLAYWRIGHT_MODULE` 로 playwright 경로 주입(하드코딩 경로 제거).
   - 증적 경로는 `NAVER_EVIDENCE_DIR`(기본값은 gitignore 된 `reports/data/smartstore/live/`).
   - URL 전체·페이지 텍스트를 출력하지 않고 `NAVER_LOGIN`, `URL_PATH` 만 출력.
   - `--check-env` 로 값 노출 없이 바인딩만 확인 가능.
2. **로컬 설정 분리**: 실제 값은 저장소 밖 `~/.config/cgi-erp/{ecount,naver}.env` 에만 존재. 저장소에는 `.env.example` 빈 자리표시자만 추가.
3. **`.gitignore` 보강**: `*.local`, `.env.local`, `secrets.local.*`, `reports/data/smartstore/live/` 추가. 기존 `.env`, `.env.*`, ERP live evidence 규칙 유지.
4. **재발 방지 검사**:
   - `tools/security/scan_secrets.py` — `git ls-files` 추적 파일만 검사, 매치 값은 출력하지 않고 `rule\tpath:line` 만 보고.
   - `tools/security/tests/test_scan_secrets.py` — 검출·오탐 방지·값 비노출 18개 테스트.
   - `.github/workflows/secret-scan.yml` — 모든 push/PR 에서 스캔 + 테스트 실행. `permissions: contents: read`.

---

## 5. 검증 결과

| 항목 | 결과 | 비고 |
|---|---|---|
| 추적 파일 스캔 | **PASS** | 0 findings |
| 추적 파일 exact-match 확인 | **PASS** | 비밀번호·네이버 값 0건. 사용자 ID는 도메인 문자열과 동일(자격증명 아님) |
| 스캐너 테스트 | **18 OK** | `python -m unittest tools.security.tests.test_scan_secrets` |
| ERP 로그인 | **PASS** | env 주입으로 ERP 셸 진입 확인 |
| 네이버 로그인 | **BLOCKED_CAPTCHA** | 네이버가 추가 보안확인(캡차)을 요구. 코드 회귀 아님, 자동 해결 금지 |
| ERP 운영 데이터 변경 | **없음** | 읽기 전용 로그인만 수행 |
| 비밀번호 변경 | **없음** | 대표 결정 |
| 이력 재작성 | **없음** | 작업 경계 |

---

## 6. 남은 위험과 이력 정리 방안 (실행 전 승인 필요)

**남은 위험**: `fd0ad2e` 이후의 모든 클론·포크·GitHub 캐시에 값이 남아 있다. 저장소를 public 으로 유지하는 한 이력 정리만으로 완전 삭제를 보장할 수 없다.

| 방안 | 효과 | 위험·비용 |
|---|---|---|
| ① 비밀번호 교체(가능 시점) | **근본 차단** | 현재 불가(대표 결정) |
| ② `git filter-repo`/BFG 로 이력 재작성 + 조율된 force-push | 기존 ref 에서 값 제거 | 모든 협업자 재클론·rebase 필요, 포크/캐시는 남음. **미실행** |
| ③ GitHub Support 에 캐시 제거 요청 | 웹 캐시 완화 | 포크에는 미적용 |
| ④ 저장소 일시 비공개 | 노출면 축소 | 협업·CI 영향 |
| ⑤ 노출 값 사용 중단·세션 무효화 | 재사용 차단 | 계정 정책 필요 |

**권장 순서**: ④(필요 시) → ①(가능해지면 즉시) → ②(동결 창구 합의 후 1회) → ③. ②는 force-push 이므로 대표 승인 없이 실행하지 않는다.

---

## 7. 작업 소유권

- 수정 파일: `tools/smartstore/naver_login_probe.js`, `.gitignore`, `.env.example`, `tools/security/**`, `.github/workflows/secret-scan.yml`, 본 문서, 기존 ERP 문서 2곳의 보안 절.
- 다른 LOCAL 작업물(데이터 정비·수집기·ERP 변환기)은 수정하지 않았다.
- 수정 전 워크트리들을 확인해 해당 파일들에 미커밋 변경이 없음을 확인했다.
