# 이슈 #43 상품 DB 품질 개선 — 테스트 로그

- **일시:** 2026-10-23 (Stage 1 + Stage 2)
- **환경:** CGI-1 · Windows 11 · PowerShell / Git Bash · Python 3.13 (`python -X utf8`)
- **저장소 상태:** Stage 1 `origin/main` = `9394b20` · 브랜치 `feature/issue-43-product-quality`
  / Stage 2 base `origin/main` = `62cdeb9` · 브랜치 `feature/issue-43-stage2-review-verify`

## 1. 산출물 생성 실행

```powershell
python .\tools\product_quality\build_quality.py
```

실제stdout 요약:

```text
patch_rows=5270 duplicate_rows=1353 out_dir=data/product_quality
original_products=4575 improved_products=4575
missing_before: model 2835 / manufacturer 2294 / brand 0
missing_after : model 2467 / manufacturer 206  / brand 0
auto_corrected_records=2456 (model 368, manufacturer 2088)
review_required_total=2351  근거없음 463
duplicate_candidates total_pairs=1353 confirmed=538 probable=274 candidate=521 same_site_exact=20 affected_products=2018
policy: original_master_overwritten=false price_invented=false stock_invented=false
        wholesale_invented=false new_scraping_performed=false yamaha_673_recollected=false duplicates_merged=0
```

## 2. 집중 테스트 (신규)

```powershell
python -m unittest discover -t . -s tools\product_quality\tests -v
```

```text
Ran 22 tests in 2.100s
OK
```

다루는 항목: 근거 없는 값 생성 금지(자리표시자 브랜드·제조사 자동 사용 불가),
`영문상품명`은 검토로만, confirmed 중복 승계만 자동, 승계 모델명 충돌 시 자동 금지,
가격·재고 전달값 불변, 레코드 수 보존, 중복 병합 0건, 요약 분할 닫힘(자동+검토+근거없음 = 조치 대상),
실데이터 4,575건 원본 SHA-256 실행 전후 동일, improved.json 키 순서·개수 원본과 일치.

## 3. 회귀 테스트 (기존 영역 무변경 확인)

```powershell
python -m unittest discover -t . -s tools\product_master\tests   # Ran 62 tests OK
python -m unittest discover -t . -s tools\full_catalog\tests     # Ran 18 tests OK
python .\tools\erp\tests\test_erp_prep.py                        # Ran 12 tests OK
python .\tools\procurement\tests\test_procurement.py             # Ran 15 tests OK
python .\tools\procurement\tests\test_g2b_classifier.py          # Ran 34 tests OK
python .\tools\smartstore\tests\test_smartstore_prep.py          # Ran 19 tests OK
```

`148 케이스 PASS` 는 product_quality 22 + 위 5개 suites(product_master 62 · full_catalog 18 ·
erp 12 · procurement 15 · smartstore 19) 기준이다. `tools/erp·procurement·smartstore` 는
`tests/__init__.py` 가 없어 `discover` 대신 파일 경지로 직접 실행했다(기존 상태, 본 작업에서 변경하지 않음).

Stage 2에서도 동일 회귀를 재실행했다(§7.2). `tools/procurement/tests/test_g2b_classifier.py` 34케이스를
추가로 돌려 합계 **210 케이스 PASS** (product_quality 50 + product_master 62 + full_catalog 18 +
erp 12 + smartstore 19 + procurement 15 + g2b 34).

> **주의(기존 결함 발견):** `tools.procurement.tests.test_procurement` 를 실행하면
> `reports/data/procurement/bid_analysis.*` 3개 파일에 **실행 컴퓨터의 절대경로**
> (`file:D:\1022\<worktree>\data\procurement\sample_bids.json`) 가 기록되어 커밋 상태가 더러워진다.
> 본 작업에서는 `git checkout -- reports/data/procurement/` 로 되돌렸고 해당 파일들은 PR에 포함하지 않았다.
> LOCAL3(조달) 측에서 테스트를 상대경로·임시디렉터리로 수정할 권고 사항으로 남긴다.

## 4. 산출물 내용 검증

| 확인 항목 | 방법 | 결과 |
|---|---|---|
| 원본 마스터 보존 | 실행 전후 `site/data/products.json` SHA-256 비교 (테스트) | 동일 |
| improved.json 정합성 | `products[].id` 목록 = 원본 id 목록, 개수 4,575 | 일치 |
| 패치 CSV | Stage 1 실행 시점 5,270행 · 열 15개, 자동 2,456/검토 2,351/근거없음 463. **Stage 2 재생산 후에는 같은 5,270행 · 열 23개, 자동 2,496/검토 2,311/근거없음 463** (§7.3 참조) | 일치 |
| 중복 CSV | 1,353행, 자동병합 538행도 `조치=검토 대기` | 확인 |
| 리뷰 XLSX | Stage 1 실행 시점 시트 7개(요약·자동보완·검토후보·근거없음·중복후보·필드현황·LOCAL2계약). Stage 2 이후 8개 (§7.3) | 일치 |
| 자동 보완 근거 표본 | `SHURE → Shure` (삼아사운드 제조사 행 474건 실측), 41종 대응 | 확인 |
| 가격·재고 | `price_original` 분포 = 원본 분포 (테스트) | 동일 |
| Yamaha 재수집 | 코드에서 `yamaha_catalog.json` 참조 없음, 네트워크 호출 없음 | 확인 |

## 5. PR·CI·병합 실행 근거

| 항목 | 실측 |
|---|---|
| 브랜치 | `feature/issue-43-product-quality` @ `4c1dcf4` |
| PR | [#46](https://github.com/skerishKang/kbs261022/pull/46) (base `main` @ `9394b20`) |
| GitHub Actions | 저장소에 `.github/workflows` 없음 → 필수 체크 0건, `required_status_checks = null` |
| commit status | `statuses` 0건 |
| 완료된 체크 | GitGuardian Security Checks = `success` (1건) |
| 대기 중 체크 | deploy 커넥터 suite 14건 `queued` (vercel·netlify·render·cloudflare 등 실행 설정 없음, PR #41·#44 와 동일) |
| 병합 가능 | `mergeable = true`, `mergeable_state = clean` |
| 병합 | `merged = true` · merge commit `5f5c8aa` |

## 6. 미실행 항목

- 브라우저 실화면 재대조(검토후보) — 사람 확정 전이므로 미수행. Stage 2 이후 2,311건.
- 원본 덮어쓰기·중복 병합·사이트 배포 — 의도적으로 수행하지 않음.
- 공급처 재수집 — Stage 1·2 모두 네트워크 호출 0건 (코드에 요청 경로 없음).

## 7. Stage 2 — 검토 후보 교차 실측 실행 근거

### 7.1 생성 실행

```powershell
python .\tools\product_quality\build_quality.py
```

stdout 요약 (실제 실행값):

```text
patch_rows=5270 duplicate_rows=1353 stage2_rows=2351 promoted=40 out_dir=data/product_quality
schema_version=1.1.0
missing_after : model 2427 / manufacturer 206 / brand 0        (Stage 1: model 2467)
auto_corrected_records=2495 (model 408 = 368+40, manufacturer 2088, brand 0)
review_required_total=2311  (Stage 1 2351 − 승격 40)  근거없음 463
stage2: auto_promoted_model=40 / manufacturer=0 / brand=0
        review_priority_remaining = P1 148, P2 620, P3 239, P4 962
        brand_placeholder_proposed_only=8, remaining=65, manufacturer_review_remaining=269
policy: original_master_modified=false new_scraping_performed=false duplicates_merged=0
```

Stage 1 수치만 뽑는 비교 실행도 가능하다: `--no-stage2` (승격 전 값 그대로 재현).

### 7.2 승격 규칙 검증 (집중 테스트)

```powershell
python -m unittest discover -t . -s tools\product_quality\tests
```

```text
Ran 50 tests in 5.371s
OK
```

- `test_quality.py` 22케이스 (Stage 1 규칙·실마스터 회귀) — Stage 2 배선 후에도 그대로 PASS.
- `test_verify_review.py` 28케이스 — 승격 기준/비승격 경계:
  독립 ID 2건 → 승격, 1건 → 미승격(P1), **동일 원본 ID 2행 → 관찰 2건·독립 1건 → 미승격**,
  타 브랜드 실측 → 미승격, 승격 표기는 원본 스펙행 표기 사용, 어휘는 brand_norm×원본ID 기준,
  브랜드는 제안+P1만(`brand` 원본 유지), 제조사 검토 P4·승격 0, 가격·원본 dicts 불변,
  `change_history`·`Verification` 열 계약·우선순위 라벨 닫힘,
  실마스터: 승격 40건 전건을 원본에서 재대조(같은 brand_norm·같은 compact 모델명·`site:product_id` 2건↑),
  모델 외 승격 0건, improved.json/summary.json/CSV/XLSX 산출물 상호 수치 일치.

### 7.3 산출물 내용 검증 (Stage 2)

| 확인 항목 | 방법 | 결과 |
|---|---|---|
| 원본 마스터 보존 | 실행 전후 `site/data/products.json` 바이트 비교 + SHA (테스트) | 동일 |
| LOCAL2 계약 유지 | 승격 행도 `classification=auto_confirmed` + `id` 조인, 필드 추가만 있음 | 확인 |
| improved.json | `schema_version=1.1.0`, 4,575건, `model_stage2_promoted` 플래그 40건, `verification` 2,139레코드 | 확인 |
| stage2 CSV | 2,351행(승격 40 + 남은 검토 2,311), 열 24개(실측독립ID·실측관찰·영문파생일치·중복판정등급·검토우선순위 포함) | 확인 |
| patch CSV | 5,270행, 자동 2,496 / 검토 2,311 / 근거없음 463 | 확인 |
| 리뷰 XLSX | 시트 8개(Stage2승격 40행 추가), 검토후보 2,311행 우선순위 정렬(테스트로 정렬 검증) | 확인 |
| 승격 표본 | `samasound.co.kr:3219` `KSM8 (블랙)` ← `samamusic.co.kr:5018`·`5019` 의 `모델명` 행 `KSM8` | 확인 |
| 가격·재고 | `price_original`/`price_state_original` 분포 = 원본 (테스트) | 동일 |
| 작업 영역 | `git status` 변경 = `data/product_quality/`, `tools/product_quality/`, `docs/CGI_PRODUCT_QUALITY_*` 뿐 | 확인 |

### 7.4 Stage 2 PR·CI·병합

| 항목 | 실측 |
|---|---|
| 브랜치 | `feature/issue-43-stage2-review-verify` (커밋 5개, head `7884fa4`) |
| PR | [#51](https://github.com/skerishKang/kbs261022/pull/51) (base `main` @ `62cdeb9`, changed_files 13) |
| GitHub Actions | `.github/workflows` 없음 → 필수 체크 0건, `required_status_checks = null` (Stage 1과 동일) |
| commit status | `statuses` 0건 |
| 완료된 체크 | GitGuardian Security Checks = `success` (1건) |
| 대기 중 체크 | deploy 커넥터 suite 14건 `queued` (vercel·netlify·render·cloudflare 등 실행 설정 없음, PR #46·#48·#49 와 동일) |
| 병합 가능 | `mergeable = true`, `mergeable_state = clean` |
| 병합 | `merged = true` · merge commit `917db99` (base `62cdeb9` → `main`) |

## 8. Stage 3 — 사람 검토 체계 실행 (2026-10-23)

### 8.1 실행

```powershell
python .\tools\product_quality\build_quality.py            # 대기열·결정 산출물까지 재생성
python .\tools\product_quality\build_quality.py --decisions <채운 검토 워크북>
```

실측 stdout(빈 대기열 기준): 검토후보 2,311행, 중복 1,353쌍, 결정 0건.

### 8.2 집중 테스트

```powershell
python -m unittest tools.product_quality.tests.test_review_workflow -v
```

```text
Ran 38 tests in 14.4s
OK
```

다루는 항목: 검토후보만 대기열에 들어가는지(auto·no_evidence 제외), 우선순위 정렬, 근거·전후값·원본화면URL 필수 표시,
검토ID·행지문의 재현 안정성, 승인 시 제안값 채택, 검토자 없는 승인 거부, 빈 제안값·자리표시자(`자체제작`/`기타`/`없음`/`-`)
승인 거부, 제안값과 다른 확정값의 비고(근거) 강제, 허용어휘 외 결정 거부, 대기열에 없는 ID·중복 ID·행지문 변조 거부,
결정 없이 입력만 있는 행 오류, 반려·보류 계상, 미처리 행 = pending, **결정 입력이 패치 레이어를 바꾸지 않음**,
워크북 3시트·드롭다운 검증·기록 왕복(read-back), 결정 CSV utf-8-sig 헤더, 내보내기 정책 플래그, Stage 3 통계의 필드 분할.

### 8.3 회귀 (Stage 1·2 포함)

```powershell
python -m unittest discover -t . -s tools\product_quality\tests   # Ran 88 tests OK (Stage1 22 + Stage2 28 + Stage3 38)
python -m unittest discover -t . -s tools\product_master\tests     # Ran 62 tests OK
python -m unittest discover -t . -s tools\full_catalog\tests       # Ran 18 tests OK
python -m unittest tools.erp.tests.test_erp_prep                   # Ran 12 tests OK
python -m unittest tools.smartstore.tests.test_smartstore_prep     # Ran 19 tests OK
python -m unittest tools.procurement.tests.test_procurement        # Ran 15 tests OK
python -X utf8 tools\procurement\tests\test_g2b_classifier.py      # Ran 34 tests OK
python -X utf8 tools\procurement\tests\test_g2b_p1_verification.py # Ran 27 tests OK
```

합계 **275 케이스 PASS**. `tools/{erp,procurement,smartstore}/tests` 에 `__init__.py` 가 없어
`discover` 대신 모듈 경로·파일 경로로 실행했다(기존 상태, 본 작업에서 변경하지 않음).
`test_procurement` 실행으로 더러워진 `reports/data/procurement/*` 3개는
`git checkout -- reports/data/procurement/` 로 되돌렸고 PR에 포함하지 않았다(§3 주의 사항과 같은 결함).

### 8.4 산출물 실측 (Stage 3)

| 항목 | 실측 |
|---|---|
| 검토 대기열 | 2,311행 = 모델 1,969 + 제조사 269 + 브랜드 73 (근거없음 463건은 대기열 밖) |
| 우선순위(전 필드) | P1 156 · P2 620 · P3 239 · P4 1,296 (합 2,311) |
| 우선순위(필드별) | 모델 P1 148·P2 620·P3 239·P4 962 / 제조사 P4 269 / 브랜드 P1 8·P4 65 |
| 검토 워크북 | `product_quality_review_queue.xlsx` 시트 3개(검토방법·검토후보 2,311행·중복후보판정 1,353행), 결정 열 드롭다운(승인/반려/보류), 입력 5열(검토결정·확정값·검토자·검토일·비고) 채색, 자동필터·윈도우 freeze |
| 대기열 지문 | `queue_fingerprint` sha256 = `139e2753a89468a8…` (재실행 동일, 테스트로 확인) |
| 중복 후보 | 판정 어휘 동일상품/별도상품/보류, **자동병합 0건 고정**, 좌우 원본ID 병기, `남길ID` 는 쌍의 ID 중 하나여야 통과 |
| 결정 내보내기 | `product_review_decisions.json`(counts·policy) + `product_review_decisions.csv` — 빈 대기열에서 승인 0·보류 0·반려 0·미검토 2,311·오류 0 |
| 원본 마스터 | 실행 전후 SHA-256 동일 (테스트). `improved.json` products 배열은 Stage 2 와 바이트 동일(값 변경 0건) |
| LOCAL2 계약 | `auto_confirmed` 계약·`id` 조인 불변. Stage 3 는 `reviewer_confirmed` 행만 추가 적용 대상으로 정의 |

### 8.5 검토 입력 시나리오 실측 (원본 마스터 대상)

실제 대기열 워크북에 검토값을 넣어 `--decisions` 로 되읽은 결과(`.work` 임시본, 커밋 안 함):

```text
승인 3 · 반려 1 · 보류 1 · 미검토 2,304 · 거부 2 · 오류 2 · 중복 판정 기록 2 · 병합 0 · exit code 1
- 승인: 모델명 360FG(제안값 채택) · 모델명 MX391-X(제안값+비고 근거) · 제조사 K&M
- 거부: 브랜드 검토 행 승인(제안값 없음 → 근거 없는 값) · 검토결정 '어쩌고'(어휘 밖)
```

즉 **검토자 이름·근거 없이 근거 없는 값이 확정되는 경로는 막혀 있고**, 오류가 있으면 종료코드 1 로
내보내기 파일을 남기지 않도록 실패한다(재검토 유도).
