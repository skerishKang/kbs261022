# 이슈 #43 상품 DB 품질 개선 — 테스트 로그

- **일시:** 2026-10-23
- **환경:** CGI-1 · Windows 11 · PowerShell / Git Bash · Python 3.13 (`python -X utf8`)
- **저장소 상태:** `origin/main` = `9394b20` · 작업 브랜치 `feature/issue-43-product-quality`

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
python -m unittest tools.erp.tests.test_erp_prep                 # Ran 12 tests OK
python -m unittest tools.procurement.tests.test_procurement      # Ran 15 tests OK
python -m unittest tools.smartstore.tests.test_smartstore_prep   # Ran 19 tests OK
```

합계 **148 케이스 PASS**. `tools/erp·procurement·smartstore` 는 `tests/__init__.py` 가 없어
`discover` 대신 모듈 경로로 직접 실행했다(기존 상태, 본 작업에서 변경하지 않음).

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
| 패치 CSV | 5,270행, 열 15개(근거·근거URL·신뢰도 포함), 자동 2,456/검토 2,351/근거없음 463 | 일치 |
| 중복 CSV | 1,353행, 자동병합 538행도 `조치=검토 대기` | 확인 |
| 리뷰 XLSX | 시트 7개(요약·자동보완·검토후보·근거없음·중복후보·필드현황·LOCAL2계약), 행수 = CSV 행수 | 일치 |
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

- 브라우저 실화면 재대조(검토후보 2,351건) — 사람 확정 전이므로 미수행.
- 원본 덮어쓰기·중복 병합·사이트 배포 — 의도적으로 수행하지 않음.
