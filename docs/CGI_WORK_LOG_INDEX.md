# CGI 사업 — 작업 현황 및 결과 기록

> **대상:** CGI 고객A 대표 · PADIEM · 참여 AI 에이전트  
> **갱신 기준:** 2026-10-29 (확인한 main `99fa446` = PR #146 병합 + CGI-1 전환 PR). 이 표는 연결된 GitHub 이슈/PR 및 보고서를 확인하는 **목차**입니다. 실시간 완료 여부는 해당 이슈/PR이 우선합니다.
> **저장소:** https://github.com/skerishKang/kbs261022  
> **누적 실적:** PR **35건 병합**(10-22 10건 · 10-23 25건) + 진행 중 PR #62(이 문서). 이슈는 #2·#7·#11·#18·#20·#33·#37·#39·#50·#52 **10건 닫힘**, #1·#5·#43 열림(#8·#9·#19는 완료 조건 검증 후 종료 처리 — 근거는 각 이슈 댓글과 아래 표). 아래 표의 실행 시간·비용 근거는 "[10-22 · 10-23 실행 기록](#10-22--10-23-실행-기록--시간과-비용-증거-기준)" 절에 커밋·PR 원장 기준으로 정리했습니다.

## 전체 업무 흐름

**공급처 사이트 분석 → 통합 상품 정보표 → 스마트스토어 개설 이후 상품 등록 → 이카운트 ERP 품목·주문 연결 → 후속 자동화**

현재 스마트스토어는 개설·연결 준비 단계이므로, **상품 게시/ERP 실제 연동이 완료되었다는 의미가 아닙니다.**

## 작업별 진행 기록

| 업무 | 내용 | 실행·산출물 (main 실측) | 상태 (2026-10-23 기준) |
|---|---|---|---|
| [#1 CGI 통합 실증](https://github.com/skerishKang/kbs261022/issues/1) | 홈페이지·스마트스토어·ERP 연계 사업 범위 정리 | 총괄 이슈. 하위 #2·#5·#8·#11·#18·#19·#20·#33·#37·#39·#43·#50·#52 · [평문 자격증명 제거와 시크릿 스캔 CI](../reports/security/plaintext-credential-exposure.md)(PR #59): `tools/security/scan_secrets.py`, `.github/workflows/secret-scan.yml` | 총괄 진행 중 — 스마트스토어 개설·ERP 실제 연동은 **미완료** |
| [#2 업무확인서·개발계획서](https://github.com/skerishKang/kbs261022/issues/2) | 대표 전달용 2종(AI 공동검토형 / 일반 고객형) | `docs/CGI_업무확인서_개발계획서_AI검토형.md`(62,595B · 725행)+PDF 19쪽 · `docs/CGI_업무확인서_개발계획서_고객용.md`(8,539B · 135행)+PDF 4쪽. 초안은 [PR #3](https://github.com/skerishKang/kbs261022/pull/3)·[PR #4](https://github.com/skerishKang/kbs261022/pull/4), main 반영은 PR #60(내용 무변경 옮겨담기). 두 문서 공통: 문서번호 CGI-REQ-2026-001 · v0.2 · 2026-10-22 · 1단계 2일 최소실증/2단계 추가연동/3단계 상용 구분 · 금액 미확정 | **이슈 종료(저장소 열람 가능).** 대표 내용 확인·v1.0 확정은 별도 단계 — A는 `검토용 초안` 배너, B는 `대표 확인용` 표시로 아직 서명본이 아님 |
| [#5 공급처 사이트 2모델 분석](https://github.com/skerishKang/kbs261022/issues/5) | 삼아사운드·삼아스토어 구조·수집 경로 독립 분석과 증분 갱신 | 증분 갱신기 `tools/full_catalog/incremental_update.py` + 네이버 필드 준비도 `tools/full_catalog/naver_field_readiness.py` + [증분 수집 문서](CGI_ISSUE5_INCREMENTAL_COLLECTION.md) + `data/full_catalog/incremental/` (PR #56 병합) | 증분·필드 준비도는 main 반영. 모델 A/B 원시 분석 PR([#6](https://github.com/skerishKang/kbs261022/pull/6)·[#12](https://github.com/skerishKang/kbs261022/pull/12)·[#13](https://github.com/skerishKang/kbs261022/pull/13))은 **미병합** |
| [#7 CGI-1 ↔ COM1 작업물 전달](https://github.com/skerishKang/kbs261022/issues/7) | 원격 CGI 컴퓨터 산출물을 COM1로 보내 GitHub에 기록 | Tailscale 연결 확인. COM1 실행용 하네스 `tools/e2e_admin_ops.js`(PR #53) | 이슈 닫힘(전달 경로 확보). **전체 자동화 검증은 대기** |
| [#8 상품 마스터 스키마·정규화](https://github.com/skerishKang/kbs261022/issues/8) | 통합 표 구조·식별자·중복·가격 출처·매핑 경계 설계 | `schemas/product-master-record.schema.json`(**필수 16컬럼 전부 required**) · `tools/product_master/`(schema·normalize·dedupe·validate·build_records·collect_http·crosscheck·cli) · [설계서](CGI_PRODUCT_MASTER_SCHEMA.md) 8장 · 테스트 62개 PASS · 공개 샘플 29건 검증 `RESULT=PASS`(PR #16 병합) | **설계·구현·테스트 main 반영 완료(이슈 종료).** `dealer_price`·`availability` 는 근거 없어 NULL 유지, 확신 부족 중복 자동 병합 0건 |
| [#9 작업 기록 체계](https://github.com/skerishKang/kbs261022/issues/9) | 고객 열람용 작업 이력·검증 근거·산출물 목차 | 이 문서 + [보고 기준](CGI_WORK_REPORT_STANDARD.md) (PR #10 병합). PR·이슈 원장 대조로 2026-10-23 갱신, 실행 시간·비용 절 추가(PR #62) | **대표 열람 가능 상태 충족(이슈 종료).** 이후 병합·완료 시 갱신 유지 |
| [#11 CGI 상품 카탈로그 사이트](https://github.com/skerishKang/kbs261022/issues/11) | 삼아스토어 구조를 재사용한 CGI 자체 카탈로그(검색·필터·그리드·상세·모바일) | `site/`(PR #17) · [보고서](CGI_CATALOG_SITE_REPORT.md) · 캡처 14종 · 손상된 한글 UI 문자열 5건 복구(PR #55) | 이슈 닫힘(로컬 검증 완료). **실주소 배포·주문/결제 미완료** — 스마트스토어 개설 후 |
| [#18 CGI 회사 홈페이지](https://github.com/skerishKang/kbs261022/issues/18) | 기존 홈페이지 자료를 근거한 회사 홈페이지 시연본 + 쇼핑몰 통합 | `website/` · [시연안내](CGI_DEMO_GUIDE.md) · [배포안내](CGI_DEPLOYMENT.md) · [작업보고](../reports/cgi-company-website-work-report.md) · 캡처 11종 (PR #22·#25) | 이슈 닫힘(로컬 검증). **실주소 배포 미완료.** 기존 `cgiinc.kr` 은 접속 불가(Cloudflare 521)라 무개입 |
| [#19 전체 상품 Excel DB](https://github.com/skerishKang/kbs261022/issues/19) | 공급처 전체 상품 수집·정규화·엑셀 DB·쇼핑몰 연계 포맷 | `data/full_catalog/product_db.xlsx` **8시트**(통합상품 4,575×34 · 공급처원본 4,575×20 · 브랜드_카테고리 374 · 중복후보 1,333×19 · 누락_검증현황 4,575×20 · 네이버스토어준비 4,575×16 · 이카운트품목매핑 4,575×14 · 옵션SKU 3,541×8) + `site/data/products.json` 4,575건 + `product_db_compact.csv` 4,575건. 출처URL·목록URL·수집시각·검증상태·출처증거 **전 행 4,575/4,575** (PR #26·#27·#28) | **산출물 main 반영 완료(이슈 종료).** 남은 일: 공급처원본 시트 `수집시각` 공란(빌더 폴백은 PR #61, 커밋본 3.17MB 엑셀은 재생성하지 않아 **아직 빈 값**), 공급가·실재고·CGI판매가·취급승인 NULL(공개 근거 없음), 네이버 카테고리 ID 매핑 |
| [#20 이카운트 ERP 분석·매핑](https://github.com/skerishKang/kbs261022/issues/20) | 실계정 업무 분석 + 상품 마스터↔ERP 필드 매핑 | [ERP 준비 문서](CGI_ECOUNT_ERP_PREP.md) · [실계정 읽기 검증](../reports/ecount-live-verification-20261023.md) · `data/erp_prep/` 3종 · `tools/erp/` · `reports/erp-item-master-mapping.csv` (PR #21·#29·#34·#58) | 이슈 닫힘(읽기 전용 검증·17컬럼 변환기 확정). **ERP 품목 등록·주문 반영은 미수행** |
| [#33·#50 나라장터 입찰 분석](https://github.com/skerishKang/kbs261022/issues/33) | 384건 CGI 입찰 분류·P1 14건 원문/규격서 검증 | [분류·분석 보고서](CGI_PROCUREMENT_BID_ANALYSIS.md) · `tools/procurement/`(분류기·수집기·P1 검증) · `reports/data/procurement/` 8종 · 원문 근거 `p1_evidence/` 10건 (PR #35·#45·#48·#54) | 이슈 닫힘(분석·근거 보존). **입찰 참여 판단은 영업 결정** |
| [#37·#39·#52 견적 접수·운영](https://github.com/skerishKang/kbs261022/issues/39) | 견적 요청 접수·서버 저장·담당자 관리·COM1 운영 | `backend/worker.js`+`schema.sql`+`wrangler.toml` · `site/staff.html` · E2E 하네스 `tools/e2e_verify_issue39.js`·`e2e_admin_ops.js`·`e2e_cors_regression.js` (PR #38·#40·#42·#44·#49·#53·#55) | 이슈 닫힘(로컬·COM1 하네스 검증). **실서비스 배포·실접수 이력은 미확인** |
| [#43 상품 DB 품질 개선](https://github.com/skerishKang/kbs261022/issues/43) | 4,575건의 모델명·제조사·브랜드·중복·출처 정합성 점검, 자동보완과 수동검토 분리 (Stage 1 자동 / Stage 2 교차 실측 / Stage 3 사람 검토) | `data/product_quality/` 9종 + [품질 보고서 D장](CGI_PRODUCT_QUALITY_REPORT.md) + [테스트 로그 §8](CGI_PRODUCT_QUALITY_TESTLOG.md), 테스트 88개 PASS(회귀 포함 275) (PR #46·#47·#51·#57) | 제조사 2,088건·모델명 408건 자동 확정(원본 보존·병합 0건). **검토후보 2,311건은 사람이 `product_quality_review_queue.xlsx` 로 승인/반려/보류 결정 대기**(모델 P1 148·P2 620·P3 239·P4 962 + 제조사 269·브랜드 65 P4·브랜드 제안 8 P1). 승인 0건 / 근거없음 463건은 공급처 원본 재확인 필요 |
| [#130 네이버 실등록 레인](https://github.com/skerishKang/kbs261022/issues/130) | 판매자 인증→카테고리→파일럿 3건→대량 배치 확대·자동 보완(375건 실등록·전시 ON) + 재고 동기화 운영화 및 운영 자산 정리 | 운영 Runbook [CGI_NCOM_RUNBOOK_20261029.md](CGI_NCOM_RUNBOOK_20261029.md) · [오류·교훈·위험 레지스터](CGI_NCOM_ERROR_REGISTER_20261029.md) · [배치 증적 수량표](CGI_NCOM_BATCH_EVIDENCE_20261029.md) · [CGI-1 전환 기록](CGI_NCOM_CGI1_CUTOVER_20261029.md) · 장부 `reports/data/registration/ncom_registration_ledger.json` · 배치5~9 증적 `bulk/register_{5th,6th,7th,9th}_batch_20261029.json` · 배치11 증적 `bulk/register_11th_batch_20261030.json` · 배치12 증적 `bulk/register_12th_batch_20261030.json` · 계약 모듈 `backend/lib/ncom-batch-contracts.mjs`·`backend/lib/ncom-stock-sync.mjs` · 재고 운영 CLI `tools/naver/ncom-stock-sync.mjs` (PR #135~#147, 배치11 PR) | **(2026-10-30 배치12 기준)** 실등록 **375건**·전시 ON(배치11 13+배치12: 바늘 8(리프 50003154)+국내 원산지 5 — 코드 '00 국산' 첫 수용 확인, E30). **API 인증·허용 IP 복원**(Padiem-Command-Center=구 COM1, 토큰 발급·호출 실측 — E28 해소). 349건 가격 불변 재조회 349/349·재고 읽기 비교 쓰기 0. **E27 정정**: COM1 예약 작업 실체 확인 — 쓰기 작업 없음, 읽기 전용 재고점검 1건을 본 클론 경로로 갱신. 재고: 동기화 계약 C21·CLI 쓰기 가드 C22 유지. **잔여 공급 고갈**: 모델명 부재 48(원천 확보 전 등록 불가)·문의가 1,348(E26 원천 차단 유지) — 카테고리 미확정 8·국내 원산지 5는 배치12로 소화. 소비자 화면 검증·ERP 재고·가격 연동은 미검증(NOT_VERIFIED — Runbook §5) |


## 10-22 · 10-23 실행 기록 — 시간과 비용 (증거 기준)

[보고 기준](CGI_WORK_REPORT_STANDARD.md)이 요구하는 "실행 증거"를 **원장에서 뽑은 값만**으로 적습니다. 실측(원장) / 보고(문서) / 추정 을 구분하며, 근거가 없는 항목은 비워 두는 대신 **없다고 명시**합니다.

### 시간 (git·GitHub 원장 실측)

| 날짜 | 커밋 시각대(KST) | 비병합 커밋 | main 진입 커밋(비병합) | PR 병합 | 병합 시각대 |
|---|---|---:|---:|---:|---|
| 2026-10-22 | 09:21 – 18:33 | 59 | 15 | 10건 | 12:37 – 16:36 |
| 2026-10-23 | 08:57 – 13:56 | 48 | 38 | 25건 | 09:07 – 14:02 |

- 커밋 작성자 분포(비병합, 전 브랜치): 10-22 = Kilo 30 · skerishKang 14 · CGI-1 Agent 10 · ZCode Agent 5 / 10-23 = skerishKang 34 · Kilo 8 · CGI-1 Agent 6
- 근거 명령: `git log --all --no-merges --since/--until`(작업 PCs의 저장소 복제) · `GET /repos/skerishKang/kbs261022/pulls?state=all`(45개 PR, 병합 35개)
- 위 시각대는 **커밋·병합이 일어난 경계**입니다. 사람·에이전트의 실제 노동 시간은 이 원장으로 알 수 없습니다(기록 없음).

### 10-23 병합 순서 (PR 번호 · KST)

`#31 09:07 → #32 09:11 → #34 09:17 → #35 09:17 → #36 09:35 → #38 09:39 → #40 09:47 → #41 10:39 → #42 10:44 → #44 10:48 → #45 11:14 → #46 11:19 → #47 11:20 → #48 11:39 → #49 11:39 → #51 11:52 → #53 12:15 → #54 12:22 → #55 12:39 → #56 13:07 → #57 13:12 → #58 13:19 → #59 13:37 → #60 13:55 → #61 14:02`

10-22 병합: `#10 12:37 → #17 13:45 → #22 14:14 → #25 15:55 → #16 16:01 → #27 16:31 → #26/#28 16:35 → #21/#29 16:36`

### 비용 (확보된 증거와 한계)

| 항목 | 값 | 근거 / 한계 |
|---|---:|---|
| 2026-10-23 로컬 실행 세션 합계 | **169.54 크레딧 / 1,654 요청** | 이 PC의 실행 로그 `~/.qoder/projects/*/*.jsonl` 속 assistant 응답별 `usage.credits` 합. 시각대 10:59 – 13:43 KST, `cwd`가 `D:\1022`·`D:\1022\1022-2`(같은 저장소의 복제 2곳)인 세션만 |
| 2026-10-22 비용 | **측정 불가** | 같은 로그에 10-22 기록이 남아 있지 않습니다(세션 파일 보존 범위 밖). 없는 값을 만들어 적지 않습니다 |
| CGI-1·ZCode·Kilo 실행분 비용 | **근거 없음** | 저 기기·저 도구들의 과금 원장은 이 저장소에도 이 PC에도 없습니다. 각 주체 화면 확인 필요 |
| 원화 환산 총비용 | **미확정** | 위 크레딧은 툴 내부 과금 단위이고, 단가 근거가 저장소에 없어 환산하지 않았습니다 |

- 이 표의 비용 값은 **부분 합계**입니다(10-23 오후 일부 + 10-22 누락 + 타 주체 누락). 총액으로 읽으면 안 됩니다.
- 크레딧 합 산출 방식은 재현 가능합니다: 대상 파일 3개, `type=="assistant"` 이고 `message.usage` 가 있는 레코드만, `cwd` 에 `1022` 포함, UTC→KST 환산 후 일별 합계.

## 대표에게 설명할 때 구분할 항목

- **확인된 성과:** 현장에서 실제 수행하고 기록한 일(사이트 분석, 샘플 CSV 등).
- **준비된 개발물:** PR에 제출된 코드·문서. PR 존재가 운영 배포나 고객 실사용 완료를 의미하지 않습니다.
- **남은 일 (이슈별, 2026-10-23 원장 기준):**
  - [#2](https://github.com/skerishKang/kbs261022/issues/2) — 두 문서의 **내용 확인·v1.0 확정**(대표 단계). 파일 열람 자체는 가능해진 상태.
  - [#43](https://github.com/skerishKang/kbs261022/issues/43) — 검토후보 **2,311건의 사람 결정**(승인/반려/보류)과 승인분 적용. 근거없음 463건은 공급처 원본 재확인.
  - [#19](https://github.com/skerishKang/kbs261022/issues/19) — 공급처원본 시트 `수집시각` 공란, CGI 공급가·실재고·CGI판매가·취급승인(NULL 유지 중), 네이버 카테고리 ID 매핑.
  - [#5](https://github.com/skerishKang/kbs261022/issues/5) — 모델 A/B 원시 분석 PR(#6·#12·#13)의 반영 여부 정리.
  - [#11](https://github.com/skerishKang/kbs261022/issues/11)·[#18](https://github.com/skerishKang/kbs261022/issues/18) — 실주소 배포, 주문·결제 기능.
  - [#20](https://github.com/skerishKang/kbs261022/issues/20) — ERP 품목 실제 등록·주문 반영(현재는 읽기 전용 검증까지).
  - **#1 전체 목표 기준:** 스마트스토어 개설·상품 등록은 외부 조건(대표 인증·계정) 대기.
- **고객 확인 사항:** CGI가 실제 취급하는 브랜드·상품 범위, 공급가격의 정본, 스토어 개설 상태.

## 기록 방법

1. 신규 업무는 해당 이슈로 추적하고, 수행 결과를 댓글로 남깁니다.
2. 코드·문서 파일이 생성되면 동일 이슈를 참조하는 PR과 연결합니다.
3. 각 업무의 고객용 요약과 AI용 재현·검증 정보는 [작업 보고 기준](CGI_WORK_REPORT_STANDARD.md)을 따릅니다.
4. 완료·병합·실증 결과가 확인될 때 이 목차를 갱신합니다.
5. **이슈를 닫을 때** 댓글에 ① 근거 파일 경로 ② 관련 PR 번호 ③ 테스트·검증 실측 결과를 남깁니다. 근거 없는 완료 표시는 하지 않습니다.
6. **시간은 git·PR 원장에서, 비용은 과금 원장에서만** 뽑습니다. 원장이 없는 항목은 `측정 불가` / `근거 없음` 으로 적고 추정치를 넣지 않습니다(위 "실행 기록" 절).

**공개 범위:** 실제 ERP 계정, 계약서, 내부가격, 고객·개인정보, 토큰·접속 비밀정보는 공개 GitHub에 올리지 않습니다.
