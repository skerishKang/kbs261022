# CGI 기능 현황 (2026-11-05)

> 2026-10-25의 미완료 기능 점검표(`docs/CGI_미완료기능_점검표_20261025.md`)와 이 문서를 하나로 합친 현재 상태표입니다.
> 기준 main: `62a147b` (PR #196 병합). 배포: Pages `cgishop` 91010db7, Worker `cgi-quote-api` eb3c3438,
> 샌드박스 `cgi-nicepay-sandbox` 8fab20cc. 배포 절차는 [CGI_DEPLOYMENT.md](../CGI_DEPLOYMENT.md).

Legend: IMPLEMENTED = 코드 존재 · TESTED = CI/로컬 시험 통과 · DEPLOYED = 라이브 배포 확인 · LIVE_VERIFIED = 실제 환경 확인.

## 서비스 구성

| 구성 | 상태 | 비고 |
|---|---|---|
| 쇼핑몰 `site/` | 운영 | https://cgishop.pages.dev/site/ · 상품 4,575건 · 목록/검색/상세/견적/주문/회원 |
| 회사 홈페이지 `website/` | 운영 | https://cgishop.pages.dev/website/ · 브랜드 목록은 `site/data/brands.json`만 읽음 |
| Worker `cgi-quote-api` + D1 `cgi_quotes` | 운영 | 견적·주문·결제·회원·관리 API. `ADMIN_TOKEN`은 운영 도구/health 전용 |
| 샌드박스 Worker + D1 `cgi_quotes_sandbox` | 운영(테스트) | NICEPAY TEST 결제 검증용. 2026-11-05 migrations 0001~0011로 재구성 |
| Pages `cgishop` | 수동 배포 | Git 연동 없음. `tools/build_pages_root.mjs`로 조립 후 업로드 |
| Pages `cgihomepage` | 리다이렉트 전용 | `cgishop`으로 302만 담당 |

## 기능 매트릭스

| 기능 | 구현 | 시험 | 배포 | 실제 확인 | 비고 |
|---|---|---|---|---|---|
| 상품 카탈로그(4,575) | yes | yes (site) | yes | yes | 목록 `catalog.json`, 상세 분할 `details/part-*` |
| 회사 홈페이지 | yes | yes (website) | yes | yes | canonical·OG·LocalBusiness, `noindex`(도메인 전) |
| 회원 인증(이메일·Google) | yes | yes (e2e) | yes | partial | Google 최초 로그인은 동의 화면 후 가입(PR-3) |
| Google 가입 동의 | yes | yes (e2e/site) | yes | UI 확인 | 실제 Google 왕복은 운영 OAuth 설정 필요 |
| 견적·주문·결제·환불 | yes | yes (e2e) | yes | partial | **NICEPAY TEST**만. 운영 키 미연결, `TEST 결제` 배지 유지 |
| 관리자 콘솔(orders·staff·sync) | yes | yes (e2e/site) | yes | page render | 회원 세션(관리자 role)만 사용. 레거시 Bearer UI 제거(PR-4) |
| 이메일 발송(Resend) | yes | yes (e2e) | yes | partial | 운영 `MAIL_MODE=resend`·발신 도메인 설정, 실수신 확인 필요 |
| ECOUNT ERP | yes | yes (unit/e2e) | yes | no | `ECOUNT_ORDER_SYNC_ENABLED=NO`. OAPI 키·계정 승인 대기 |
| 네이버 스마트스토어 등록 | yes | yes (unit) | yes | partial | 1,000건 등록(계정 한도). 추가 등록은 한도 상향·원천 확보 필요 |
| Toss Payments | adapter only | yes (unit) | no | no | 사이트에서 제거. live 키 없이는 승인 불가 |
| 상품 동기화 엔진(change-detect·sync-state) | yes | yes (unit) | yes | no | 실동기화 미실행(0 rows) |
| 견적 PII 1년 보관 | yes | yes (unit) | yes | yes | 주문 미연결 견적의 이름·연락처·이메일·주소만 비움(PR-3) |
| 보안(CSRF·레이트리밋·시크릿 스캔) | yes | yes (CI) | yes | yes | 스캐너 강화(PR-4), PBKDF2 100,000회 |
| 반품·환불 정책 페이지 | yes | yes (site) | yes | yes | |
| 회사 프로필 2025 정보 | yes | yes | yes | yes | `website/assets/company.js` 단일 출처 |
| 입찰정보(#188) | yes | yes (unit/e2e) | yes | partial | 5차까지 병합, 실데이터 수집 범위 확대 필요 |
| Shopify 연동 | no | - | - | - | 독립 쇼핑몰로 구현, 연동 계획 없음 |

## 대표·김범신 대표 확인·결정 대기

아래 항목은 모두 이슈 **#187**(CGI 출시 남은 일)에서 추적한다. 이 문서에 별도 목록을 두지 않는다.

- 운영 NICEPAY 키 전환과 `TEST 결제` 배지 제거
- 가격(대리점 계약) 값 확정 및 공개 범위
- 정식 도메인 연결과 `noindex` 해제 시점
- ECOUNT OAPI 키 발급·계정 잠금 해제·실연동 승인
- 네이버 스마트스토어 계정 한도 및 추가 등록 승인
- Resend 발신 도메인·실수신 확인

## 남은 기술 작업

- 라이브 NICEPAY 운영 결제·취소 검증(운영 키 필요)
- ECOUNT 주문/재고 실동기화(스위치 ON 전 dry-run 증적)
- 네이버 추가 등록(한도·원천 확보 후)
- 상품 동기화 상태 채우기 및 정기 재시도
- 정식 도메인 연결 후 `_headers`의 `X-Robots-Tag` 해제
