# CGI 운영 E2E 최종 검증 — 이슈 #128 LOCAL4 실측 보고 (2026-10-31)

기준 main: `b325d43ccad1f6c59cd38505976c8803795e0356` (PR #161 병합 후)
작업 원칙: 기존 구현·배포·증거 재사용, 미검증 항목만 실측, 승인된 경로 외 DB 쓰기 0건.
본 문서는 비밀·토큰·인증 링크 원문·개인 연락처를 포함하지 않는다.

## 1. 배포·인프라 상태 (변경 없음 확인 + 본 세션 배포)

| 항목 | 값 |
|---|---|
| cgihomepage Production | `64552696-7841-4739-a15d-11168324c576` — source commit `b325d43` (본 세션 배포) |
| cgishop Production | `af73316f-8024-4e9c-bbe4-43ad8fbdf10f` — source commit `b325d43` (본 세션 배포) |
| 이전 Production (롤백 대상) | homepage `5b5627f8-…` / shop `a3d5781a-…` (source `493ac6a`, 삭제 안 됨) |
| Worker | v1.5.0 version `e821492f-47b8-47d3-8232-f4b05bf1af10` (재배포 없음) |
| Worker 롤백 대상 | `19646caa-f970-4ba4-9c3e-f8cf5063bb10` |
| health | `{"version":"1.5.0","ok":true, pg test/sandbox, erp ecount-test, products 4,575 / priced 2,117}` |
| CORS 실측 | cgishop Origin preflight → 204 + `Access-Control-Allow-Origin: https://cgishop.pages.dev` 정확 반사, anonymous `/api/quotes` → 401 |
| 공식 도메인 | `cgiinc.co.kr` 및 기존 웹호스팅/DNS 변경 0건 |

두 Pages 모두 동일 HEAD(`b325d43`)에서 연속 배포했고, 라이브 `site/config.js`·`website/assets/config.js`의 SHA-256이 저장소와 바이트 일치함을 확인했다.

## 2. 상호 링크 canonical 배선 (PR #161 — 병합·배포 완료)

변경 3 파일(+11 −3): `website/assets/config.js`(mallUrl·mallListUrl → `https://cgishop.pages.dev/`), `site/config.js`(homepageUrl → `https://cgihomepage.pages.dev/`), `site/assets/js/cgi-catalog.js`(render() 뷰 렌더 후 `applySiteConfig()` 재호출 — 동적 생성 `data-home-link`도 정본 URL 적용).

라이브 실측 (headless Chrome, 2026-10-31):
- 홈페이지 `[data-mall-link]` 5개 → 전부 `https://cgishop.pages.dev/`
- 쇼핑몰 header/footer `[data-home-link]` 2개 + 이용 안내 동적 링크 → 전부 `https://cgihomepage.pages.dev/`
- 브랜드 딥링크 `https://cgishop.pages.dev/#/products?brand=SHURE` → 302(`/site/`) 후 해시 보존 확인, 최종 URL `…/site/#/products?brand=SHURE`, 제목 "전체 상품"
- 루트 302(`/`→`/site/`, `/`→`/website/`)는 `_redirects`(302)로 동일 재현 — 쿼리스트링 전달·플랫폼 헤더(ACAO 등) 동일

로컬 테스트: site 79/79, website 12/12, 전체 JS `node --check` 통과. CI 14/14 PASS 후 병합.

## 3. 이메일 인증 링크 클릭 → 재로그인 E2E — **PASS**

이전 세션의 차단(IMAP 앱 비밀번호·Gmail 중첩 iframe·구버전 확장)을 우회하지 않고 정상 메일 UI로 해결했다: 사용자 기기의 기존 Chrome 프로필(charliekant@gmail.com GAIA 세션, Gmail 웹 세션 유효 — 쿠키 만료 2027-11, 최종 사용 전일)을 일반 GUI로 실행하고 접근성 트리 기반 UI 조작으로 메일을 열었다.

member id=26 (`charliekant+cgi128qa@gmail.com`, 이전 세션이 만든 미인증 QA 계정, 견적 0건) 대상:

1. Gmail 검색(`to:… subject:"CGI 이메일 인증"`) → 수신 확인 (이전 세션 `delivered=true` 재사용, 메일 재발송 없음)
2. 메일 본문의 실제 "확인하기" 링크를 **UI 클릭** → 새 탭에서 `…/site/#/auth/verify?token=…` 로드
3. 화면 문구 실측: **"이메일 인증이 완료됐어요."** / "이메일 인증 완료" (프론트가 `POST /api/auth/verify-email` 호출)
4. 재로그인: `POST /api/auth/login` → **200** (기존 미인증 403 게이트가 해제됨), `GET /api/me` → **200**, `email_verified_at` 설정, role=member
5. D1 교차 확인: `email_verified_at = 2026-10-30T21:52:23Z` (rows_written=0 읽기 전용 질의)

인증 우회·토큰 해시 역산·DB 직접 수정은 일절 사용하지 않았다.

## 4. 일반회원 A↔B 데이터 격리 — **PASS (신규 실측 증거)**

LOCAL3의 원 보고서가 저장소에 없어 재현 불가했던 항목을 실측으로 재생성했다. 일반회원 A(id=27)·B(id=28)를 실제 API로 가입(승인 게이트 포함)하고, 각각의 인증 메일 링크를 동일한 Gmail UI 클릭 방식으로 인증한 뒤, 서로 다른 브라우저 컨텍스트(독립 쿠키 저장소)에서 검증했다.

| 검증 | 결과 |
|---|---|
| A 로그인 → `GET /api/me` | 200 (id=27, role=member, active) |
| B 로그인 → `GET /api/me` | 200 (id=28, role=member, active) |
| A 견적 생성 `POST /api/me/quotes` | 201, `member_id=27` 연결 |
| B 견적 생성 | 201, `member_id=28` 연결 |
| A `GET /api/me/quotes` | 200 — **A 견적 1건만** (`Q-…-ez7py7`) |
| B `GET /api/me/quotes` | 200 — **B 견적 1건만** (`Q-…-eiv1ab`) |
| A→B 견적 상세 `GET /api/me/quotes/:B_id` | **404** `quote not found` (소유권 검사) |
| B→A 견적 상세 | **404** |
| A→직원 목록 `GET /api/quotes` | **401** (일반회원 관리자 목록 접근 차단) |
| A→직원 상세 `GET /api/quotes/:B_id` | **401** |
| B→직원 목록 | **401** |

서버 소스 기준 경계: 회원 스코프는 `/api/me/quotes`(WHERE member_id), `/api/me/quotes/:id`(member_id 불일치 404), 직원/관리자 목록 `/api/quotes`는 `isAdminOrMember`(admin·superadmin만) — 격리는 라우트 분리 + 소유권 검사로 구현돼 있다.

## 5. 테스트 데이터 정리 원장 (D1 읽기 전용 재조회)

| member | 처리 | 결과 |
|---|---|---|
| id=24, 25 | (LOCAL3 셀프 삭제) | `status=deleted` 유지 확인 |
| id=26 | 본 세션: UI 링크 인증 → 재로그인 → `DELETE /api/me` | `status=deleted`, `deleted_at=2026-10-30T21:53:13Z`, 세션 401 |
| id=27 (A) | 동일 승인 경로 | `deleted`, `deleted_at=21:59:51Z`, 세션 401 |
| id=28 (B) | 동일 승인 경로 | `deleted`, `deleted_at=21:59:55Z`, 세션 401 |
| id=23 | **정리 불가 — 근거 확정** | `qa-local3-a-20261029@example.invalid`: 예약 도메인(.invalid)이라 메일 수신 자체가 불가 → 인증 불가 → 로그인 불가. 견적 1건 보유. 견적·타회원 삭제 라우트 부재(`DELETE /api/quotes/:id`, 관리자 회원 삭제 라우트 없음). 임의 DB 쓰기 금지에 따라 **복구 불능 사례로 기록**하고 후속 이슈(관리자 삭제 라우트 또는 만료 토큰 자동 파기 정책)로 분리 |

잔존 견적: 게스트 3건(LOCAL3 원본) + id=23 소유 1건 + 본 세션 A/B 격리검증 2건(`Q-1793397581571-ez7py7`, `Q-1793397584837-eiv1ab` — 소유 회원은 삭제됨). 승인된 견적 삭제 경로가 없어 임의 정리하지 않았다. 스태프 목록에는 6건으로 표시된다.

## 6. skerish@naver.com 최고관리자 — **NOT_VERIFIED (차단 사유 기록)**

- 회원 레코드 없음(D1 확인). `SUPERADMIN_EMAILS` 서버 설정에는 포함돼 있어 **가입+이메일 인증 완료 시 서버가 자동으로 superadmin 부여**(소스 `isAdminOrMember`·`isSuperAdmin` 경로) — 별도 권한 부여 작업 불필요.
- 차단 원인: 가입 인증 메일이 `skerish@naver.com`으로 발송되는데, 이 기기 어디에도 네이버 메일함 세션이 없음. 실측: Chrome Default/Profile1/Profile2 쿠키 DB naver.com 행 0건, Tabbit 브라우저 네이버 미로그인(이전 세션과 동일), bsk 데몬 파이프 타 계정 소유로 접근 불가(IPC 권한 거부), Edge는 실행 중 락으로 열람 불가.
- CTO 경계(비밀번호 재설정 금지, 신규 네이버 계정 생성 금지, 외부 주소 대리 수신 금지) 내에서는 더 이상 진행할 수 없어 **회원 레코드 생성도 의도적으로 보류**했다(인증 불가 계정을 또 남기는 것을 방지).
- 해제 조건: Owner가 네이버 웹메일에 로그인한 세션을 제공하면 — 회원가입 → 메일 UI에서 링크 클릭 → 재로그인 → `GET /api/me` 200 + `/api/quotes` 200(superadmin) + 일반회원 401 대조까지 본 세션과 동일한 방법으로 즉시 완료 가능.

## 7. 3뷰포트 회귀 QA (신규 배포 기준) — **PASS**

1440/768/390 × 홈페이지 1 + 쇼핑몰 8경로, 실브라우저 순회(기존 qa_browser.py 재사용):
- 전 화면 HTTP 200, 빈 페이지 0
- 콘솔 오류: 비로그인 `GET /api/me 401` 리소스 로그만(정상 동작), 그 외 0건
- 홈페이지 이미지 "미표시 13장"은 `loading=lazy` 스크롤 전 오탐 — 문제 파일 3종 라이브 HTTP 200(58–72KB 실바이트) 재확인
- CLIPPED 표시는 `text-overflow: ellipsis` 설계(상품명 SPAN)·접근성 1px LABEL — 실제 잘림 0
- 양방향 canonical 링크(§2) 200 확인

## 8. 후속 이슈 권고 (#128 필수조건 아님)

1. health의 `cors_origin`이 기본값(`https://skerishkang.github.io`)만 표시 — 실제 CORS는 두 pages.dev Origin을 정확히 허용(§1 실측). 진단 표시 최소 수정 대상.
2. 견적 삭제/관리자 회원 정리 라우트 부재 — id=23 및 잔존 테스트 견적의 정리 경로.
3. 미인증 회원의 세션 회수 공백(가입 세션이 쿠키로만 발급되고 로그아웃 시 재진입 불가).
4. 인증 메일 링크의 프론트 기준 URL이 `skerishkang.github.io`(GitHub Pages) — pages.dev canonical 사용 여부 검토(기능 영향 없음, 실측상 양쪽 모두 동작).
