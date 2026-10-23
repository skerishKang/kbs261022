# CGI 상품 DB 품질 개선 보고서 — 이슈 #43

- **작업 제목:** 기존 CGI 상품 4,575건 모델명·제조사·브랜드·중복·출처 정합성 개선
- **작업 일시 / 담당:** 2026-10-23 / CGI-1 (Windows, PowerShell) · Qoder 에이전트
- **이슈:** https://github.com/skerishKang/kbs261022/issues/43
- **저장소:** https://github.com/skerishKang/kbs261022

## A. 고객용 요약

**왜 했는가.** 삼아사운드·삼아스토어에서 수집한 상품 4,575건에 모델명이 비어 있거나
제조사 표기가 한쪽 사이트에 아예 없는 상태였고, 두 사이트에 같은 상품이 중복 등록되어
보였습니다. LOCAL2(쇼핑몰·견적)가 그대로 쓰면 검색·필터·견적서에서 오류가 납니다.

**무엇을 했는가.** 원본 4,575건은 그대로 두고, 이미 수집해 놓은 원본 화면 표기(제조사·모델명·
영문상품명 스펙행)와 이슈 #8 정본 DB의 중복 판정만 재사용해 보완 후보를 만들었습니다.
새로 사이트를 긁지 않았고, 판매가·원가·재고·공급권한 값은 하나도 만들어 넣지 않았습니다.
자동으로 확신할 수 있는 항목과 사람이 화면을 보고 확인해야 할 항목을 파일로 분리했습니다.

**확인된 결과(실측).**

| 항목 | 보완 전 | Stage 1 후 | Stage 2 후 | 자동 확정 | 검토후보 | 근거없음 |
|---|---|---|---|---|---|---|
| 모델명 누락 | 2,835건 | 2,467건 | **2,427건** | 408건 (368+40) | 1,969건 | 458건 |
| 제조사 누락 | 2,294건 | 206건 | 206건 | 2,088건 | 269건 | 5건 |
| 브랜드 자리표시자 | 73건 | 73건(표기 유지) | 73건(표기 유지) | 0건 | 73건(제안 8 포함) | 0건 |

- 자동 보완된 레코드: 2,456건(Stage 1) → **2,495건**(Stage 2). 원본 레코드 수는 4,575건 그대로.
- 검토후보: 2,351건(Stage 1) → **2,311건**(Stage 2). 승격 40건만큼 줄었다.
- 중복 후보: **1,353쌍** (확정 538 / 추정 274 / 대조필요 521 / 같은 사이트 완전일치 20),
  관련 상품 2,018건. **병합은 0건** — 원본 ID 전부 보존.

**자동 보완의 근거(예).**
- 제조사: 삼아스토어에는 `제조사` 행이 없지만 삼아사운드에는 있습니다. 같은 브랜드
  `SHURE` 이 삼아사운드 474건의 제조사 행에서 예외 없이 `Shure` 로 적혀 있어, 그 값을 옮겨 썼습니다.
  이렇게 사용한 브랜드↔제조사 대응은 41종이며 전부 산출물 CSV에 건수와 출처 URL을 함께 적었습니다.
- 모델명: 이슈 #8 정본에서 "자동 병합 가능(confirmed)"으로 판정된 동일 상품 쌍 중 한쪽에만
  `모델명` 행이 있는 368건을 승계했습니다.

**Stage 2 — 검토 후보 교차 실측(2026-10-23 추가).**
검토로 남긴 2,351건 전체를 새로 긁지 않고, 이미 수집된 원본 `모델명` 스펙행 어휘
(1,632개 표현)로 재대조했습니다. 승격 조건은 대표 결정대로
**같은 브랜드의 명시 `모델명` 스펙행에서 독립 원본 ID 2건 이상**입니다.
동일 원본 ID에서 두 번 관찰돼도 독립 증거로 치지 않습니다.

- 승격: **모델명 40건** (예: `samasound.co.kr:3219` "KSM8 (블랙)" → 삼아스토어 원본ID 5018·5019
  두 행의 `모델명` 행이 `KSM8` 으로 실측). 승격 값은 후보 문자열이 아니라 원본 표기를 그대로 씁니다.
- 승격 불가: 제조사 269건(교차 실측 근거 0건), 브랜드 73건 — 전부 검토 유지.
  브랜드 자리표시자 중 8건은 모델명 어휘가 단일 브랜드로 실증해 **제안 + 우선검토(P1) 표시만** 하고
  원본 표기(`자체제작`)는 바꾸지 않았습니다.
- 남은 검토 2,311건(모델 1,969 + 제조사 269 + 브랜드 73)에 우선순위를 붙였습니다.
  순위는 **모델명 후보에 교차 실측 지표가 있을 때만** 붙습니다: 모델 기준
  P1 148건(실측 1건) · P2 620건(영문상품명=파생 일치) · P3 239건(상대 공급처 중복 판정) · P4 962건(링크 없음).
  제조사 269건과 브랜드 65건은 실측 링크가 없어 P4로, 브랜드 제안 8건은 P1로 표시했습니다
  (전 필드 합계: P1 156 · P2 620 · P3 239 · P4 1,296 = 2,311).
- `product_quality_review.xlsx` 에 **Stage2승격** 시트를 추가하고, 검토후보 시트를 우선순위 순으로
  정렬하며 실측 독립 ID 수·실측 관찰 수·영문/파생 일치·중복 판정 등급·우선순위 열을 붙였습니다.
  별도 파일: `product_quality_stage2_verification.csv` (2,351행).

**검토로 돌린 항목과 이유.**
- `영문상품명` 행(891건): 이슈 #8 정책상 영문상품명은 모델명으로 간주하지 않았습니다. 사람이 확정 필요.
- 상품명에서 뽑은 모델 표현 후보(1,118건): 화면 대조 전에는 원본 필드로 바꾸지 않았습니다.
- `자체제작`(68건)·`자체브랜드`(5건): 값은 있으나 실제 제조사·브랜드가 아니므로 자리표시자로 표시.
- 브랜드가 삼아사운드 쪽에 없는 201개 브랜드: 브랜드=제조사는 가정이라 검토 항목으로 남겼습니다.

**안 된 것 / 미확인.** 공급처 원본에 모델명 표기가 없는 458건은 계속 비어 있습니다.
Stage 2 어휘에서 독립 ID 2건 이상으로 실측되지 못한 모델명 후보 1,969건도 그대로 검토입니다.
공개 판매가가 없는 상품 2,458건(원본의 `가격 문의` 표기)은 이번 작업과 무관하게 문의 상태로 남았습니다.

**다음 순서.** LOCAL2가 자동 확정 항목(2,495건)을 카탈로그·견적서에 반영하고, 검토후보 2,311건은
Stage 3 검토 워크북 `product_quality_review_queue.xlsx`(우선순위순·근거·전후값 표시)에서
승인/반려/보류로 확정한 뒤 `build_quality.py --decisions` 로 패치화합니다. 절차는 아래 D장.

## B. AI 공동검토용 기록

```text
PROJECT=CGI
ISSUE=43
PR=46 https://github.com/skerishKang/kbs261022/pull/46 (Stage 1)
STAGE2_PR=51 https://github.com/skerishKang/kbs261022/pull/51 (Stage 2, base main @ 62cdeb9)
REPOSITORY=skerishKang/kbs261022
WORK_DATE=2026-10-23
AGENT=Qoder (CGI-1)
MODEL=Qoder 에이전트 세션 (이전 Beam 1.0 사용량 제한 세션의 복구)
DEVICE=CGI-1 Windows / PowerShell
OBJECTIVE=기존 4,575건 상품 마스터의 모델명·제조사·브랜드·중복·출처 정합성을 출처 기반으로 점검하고 LOCAL2가 쓸 수 있는 보완 산출물(자동/검토 분리)을 만든다
INPUTS=site/data/products.json(원본 4,575건), data/full_catalog/product_db.xlsx(이슈 #8 정본: 통합상품·중복후보 시트), data/full_catalog/collection_stats.json
IMPLEMENTED=tools/product_quality/quality.py(근거 규칙 엔진), tools/product_quality/build_quality.py(산출물 빌더·CLI), tools/product_quality/verify_review.py(Stage 2 교차 실측·승격 규칙), tools/product_quality/tests/test_quality.py(22케이스)+test_verify_review.py(28케이스), data/product_quality/{6개 산출물 + README}
EXECUTION_EVIDENCE=python tools/product_quality/build_quality.py 실행 → patch_rows=5270 duplicate_rows=1353 stage2_rows=2351 promoted=40; summary 실측 출력(schema_version 1.1.0, 모델명 미확정 2,467→2,427); python -m unittest discover -t . -s tools/product_quality/tests → Ran 50 tests OK; 원본 products.json SHA-256 실행 전후 동일(테스트로 검증)
TESTS=50/50 PASS (product_quality 집중+실마스터 회귀) + 회귀: tools/product_master 62, tools/full_catalog 18, tools/erp 12, tools/smartstore 19, tools/procurement 49 (아래 TESTLOG)
OBSERVED_FACTS=모델명 누락 2,835건(samasound 2,281 전체 + samamusic 554), 제조사 누락 2,294건(samamusic 전체 — 이 사이트는 제조사 스펙행 자체가 없음), 브랜드 필드 누락 0건, 브랜드 표기 64종, 중복 판정 confirmed 538쌍/probable 274쌍/candidate 521쌍, 같은 사이트 브랜드+상품명 완전일치 20쌍, 자리표시자 제조사 '자체제작' 68건
MODEL_CLAIMS_NOT_INDEPENDENTLY_VERIFIED=브랜드↔제조사 대응 41종은 원본 스펙행 실측이지만 "동일 브랜드 상품의 제조사가 계약상 제조사와 일치"하는지는 CGI 확인 필요
LIMITATIONS=원본에 표기가 없는 모델명 458건은 공백 유지. 승계된 모델명 368건은 이슈 #8 confirmed 판정에 의존(변형 충돌 검사 통과 건만). 가격·재고·공급권한은 본 작업 범위 밖
OUTPUTS=data/product_quality/product_quality_improved.json, product_quality_patch_candidates.csv, product_quality_stage2_verification.csv, product_duplicate_candidates.csv, product_quality_summary.json, product_quality_review.xlsx
MERGED=YES Stage1(PR #46 · merge commit 5f5c8aa) / Stage2(PR #51 · merge commit 917db99)
STAGE2_AUTO_PROMOTED=40 (모델명 승격) / 제조사 0 / 브랜드 0
STAGE2_INDEPENDENT_EVIDENCE=같은 brand_norm 의 명시 모델명 스펙행에서 site:product_id 기준 2개 이상; 산출물 40건 전건을 원본에서 재대조해 테스트로 고정
STAGE2_SCHEMA=1.1.0 (Stage 1 1.0.0 → Stage 2 1.1.0), improved.json·summary.json 동기
DEPLOYED=NO
LIVE_VERIFIED=NO (데이터 산출물이라 배포 대상 아님)
REMAINING=검토후보 2,311건은 Stage 3 검토 워크북으로 사람 확정 대기(모델 P1 148/P2 620/P3 239/P4 962, 제조사 269·브랜드 65는 P4, 브랜드 제안 8은 P1), 근거없음 모델명 458건은 공급처 원본 재확인 필요
NEXT=LOCAL2가 auto_confirmed 2,495건(승격 40 포함)을 카탈로그/견적 데이터에 반영, LOCAL3은 ERP 품목매핑 시 manufacturer_after 대신 원본값 병기 검토
```

### 사실 수준

- **실측:** 누락 건수, 자동 보완 건수, 중복 쌍 수, 산출물 파일·행 수, 테스트 결과는 모두 실행 로그·파일에서 확인했다.
- **추정:** 브랜드↔제조사 대응의 사업적 정확성(공급계약상 제조사)은 미검증.
- **미실행:** 사이트 재수집, 원본 덮어쓰기, 중복 병합, 배포 — 전부 수행하지 않았다.

## C. LOCAL2 인수인계 (데이터 계약)

```powershell
python .\tools\product_quality\build_quality.py
```

- 조인 키: `id` = `site/data/products.json` 의 `id` (`"samasound.co.kr:3836"` 형식).
- 사용할 필드: `manufacturer_after`, `model_after` — 단 `patches.<field>.classification == "auto_confirmed"` 인 행만.
- `review_required` / `no_evidence` 는 원본 `manufacturer` / `model` 값을 계속 사용한다.
- Stage 2 승격 40건도 위 계약 그대로 따라온다 — 조인 키·필드 이름·분류 값 변경 없음.
  `schema_version` 은 `1.0.0` → `1.1.0` (값 추가만 있고 제거 없음).
- 승격 여부는 `quality_flags` 의 `model_stage2_promoted` 또는
  `verification.model.promoted_by_stage2 == true`, `patches.model.evidence_type == "multi_source_attestation"` 으로 확인한다.
- `verification.<field>` 는 사람 검토 지표다(`priority`/`priority_label`/`attest_independent_ids`).
  우선순위가 붙었다고 해서 자동 적용 대상이 아니며, `classification` 이 `review_required` 면 원본값 유지가 정답이다.
- `price_original`, `price_state_original` 은 원본 전달값(새로 만든 값 아님).
- `quality_flags` 로 검토후보/근거없음/자리표시자를 필터할 수 있다.
- 사이트 표시·UI(`site/**`), 견적 백엔드, ERP·나라장터 파일은 이 PR에서 변경하지 않았다.
- 상세 문서는 [`data/product_quality/README.md`](../data/product_quality/README.md).


## D. Stage 3 — 검토후보 2,311건 검토 체계 (2026-10-23)

**만든 것.** 사람이 화면을 보며 결정할 수 있는 검토 워크북과, 그 결과를 기계가 검증해
패치로 바꾸는 내보내기 기능을 추가했습니다(`tools/product_quality/review_workflow.py`).
**자동으로 확정된 값은 하나도 늘지 않았습니다** — Stage 2까지의 40건 승격이 전부이고,
Stage 3는 승인 0건 상태로 출발합니다.

**검토 워크북** `data/product_quality/product_quality_review_queue.xlsx`

| 시트 | 내용 |
|---|---|
| 검토방법 | 사용 순서·규칙·대기열 지문(sha256) |
| 검토후보 | 2,311행. 우선순위 P1→P4 정렬, 보완전/제안값/근거/근거URL/**원본화면URL**/신뢰도/실측독립ID/판정근거 표시, 입력란은 검토결정·확정값·검토자·검토일·비고 5열(채색·드롭다운) |
| 중복후보판정 | 1,353쌍. 좌우 원본ID·브랜드·모델명·공통표현·유사도·변형충돌·근거 병기, 판정란은 동일상품/별도상품/보류 |

**검증 규칙(어긋난 입력은 패치가 되지 않습니다).**

- 결정 어휘는 승인·반려·보류뿐. 어휘 밖 값은 거부하고 오류 목록에 남깁니다.
- 승인은 ①실측된 제안값(또는 검토자 입력 확정값) ②**검토자 기록** 필수.
  제안값과 다른 확정값은 `비고`에 근거를 적어야 통과합니다.
- 제안값이 없거나 자리표시자(`자체제작`·`기타`·`없음`·`-`)인 행은 승인 불가 — **근거 없는 값을 채우는 경로가 없습니다**.
- 행지문(제안값·우선순위 해시)이 대기열과 다르면 거부. 재생성 후 제안이 바뀌면 검토가 다시 필요합니다.
- 대기열에 없는 ID·중복 ID는 거부하고 종료코드로 알려줍니다.

**내보내기.** `python tools\product_qualityuild_quality.py --decisions <검토 워크북>` →
`product_review_decisions.json`·`.csv`. 승인 행만 `classification=reviewer_confirmed`,
`applies_to="patch layer only"`로 기록되고, 정책 플래그(`duplicates_merged=0`,
`original_master_overwritten=false`, `price_invented=false`, `unapproved_values_applied=false`)와
오류 목록이 함께 나갑니다. 오류가 있으면 종료코드 1.

**중복.** 판정 기록만 남깁니다. `동일상품`으로 적어도 `남길ID`가 쌍의 원본ID 중 하나일 때만 통과하고,
어떤 경우에도 **병합은 수행하지 않습니다**(원본 4,575건 ID 전부 유효).

**실측 예(임시본, 커밋 안 함).** 승인 3(모델명 360FG·MX391-X[근거비고]·제조사 K&M) ·
반려 1 · 보류 1 · 미검토 2,304 · 거부 2(근거 없는 승인, 어휘 밖 결정) · 병합 0.

**테스트.** `tools/product_quality/tests/test_review_workflow.py` 38케이스 PASS,
product_quality 전체 88케이스, 회귀 187케이스 포함 **275케이스 PASS**
(`docs/CGI_PRODUCT_QUALITY_TESTLOG.md` §8).

**LOCAL2 적용 계약(Stage 3 추가분).**
`product_quality_improved.json` 은 Stage 2와 값이 동일합니다(재현 확인). 확정값은
`product_review_decisions.json` 의 `approved[].확정값` 뿐이며, 그 행만 `id`+`필드` 로 원본에 덮어씁니다
(원본 파일이 아니라 로컬 적용 계층에서).
