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

| 항목 | 보완 전 | 보완 후 | 자동 보완 | 검토후보 | 근거없음 |
|---|---|---|---|---|---|
| 모델명 누락 | 2,835건 | 2,467건 | 368건 | 2,009건 | 458건 |
| 제조사 누락 | 2,294건 | 206건 | 2,088건 | 269건 | 5건 |
| 브랜드 자리표시자 | 73건 | 73건(표기 유지) | 0건 | 73건 | 0건 |

- 자동 보완된 레코드: **2,456건** (모델명 368 + 제조사 2,088). 원본 레코드 수는 4,575건 그대로.
- 중복 후보: **1,353쌍** (확정 538 / 추정 274 / 대조필요 521 / 같은 사이트 완전일치 20),
  관련 상품 2,018건. **병합은 0건** — 원본 ID 전부 보존.

**자동 보완의 근거(예).**
- 제조사: 삼아스토어에는 `제조사` 행이 없지만 삼아사운드에는 있습니다. 같은 브랜드
  `SHURE` 이 삼아사운드 474건의 제조사 행에서 예외 없이 `Shure` 로 적혀 있어, 그 값을 옮겨 썼습니다.
  이렇게 사용한 브랜드↔제조사 대응은 41종이며 전부 산출물 CSV에 건수와 출처 URL을 함께 적었습니다.
- 모델명: 이슈 #8 정본에서 "자동 병합 가능(confirmed)"으로 판정된 동일 상품 쌍 중 한쪽에만
  `모델명` 행이 있는 368건을 승계했습니다.

**검토로 돌린 항목과 이유.**
- `영문상품명` 행(891건): 이슈 #8 정책상 영문상품명은 모델명으로 간주하지 않았습니다. 사람이 확정 필요.
- 상품명에서 뽑은 모델 표현 후보(1,118건): 화면 대조 전에는 원본 필드로 바꾸지 않았습니다.
- `자체제작`(68건)·`자체브랜드`(5건): 값은 있으나 실제 제조사·브랜드가 아니므로 자리표시자로 표시.
- 브랜드가 삼아사운드 쪽에 없는 201개 브랜드: 브랜드=제조사는 가정이라 검토 항목으로 남겼습니다.

**안 된 것 / 미확인.** 공급처 원본에 모델명 표기가 없는 458건은 계속 비어 있습니다.
공개 판매가가 없는 상품 2,458건(원본의 `가격 문의` 표기)은 이번 작업과 무관하게 문의 상태로 남았습니다.

**다음 순서.** LOCAL2가 자동 보완 항목을 카탈로그·견적서에 반영하고, 검토후보 2,351건은
`product_quality_review.xlsx` 의 검토후보 시트를 화면 확인하며 확정합니다.

## B. AI 공동검토용 기록

```text
PROJECT=CGI
ISSUE=43
PR=(PR 번호)
REPOSITORY=skerishKang/kbs261022
WORK_DATE=2026-10-23
AGENT=Qoder (CGI-1)
MODEL=(세션 모델)
DEVICE=CGI-1 Windows / PowerShell
OBJECTIVE=기존 4,575건 상품 마스터의 모델명·제조사·브랜드·중복·출처 정합성을 출처 기반으로 점검하고 LOCAL2가 쓸 수 있는 보완 산출물(자동/검토 분리)을 만든다
INPUTS=site/data/products.json(원본 4,575건), data/full_catalog/product_db.xlsx(이슈 #8 정본: 통합상품·중복후보 시트), data/full_catalog/collection_stats.json
IMPLEMENTED=tools/product_quality/quality.py(근거 규칙 엔진), tools/product_quality/build_quality.py(산출물 빌더·CLI), tools/product_quality/tests/test_quality.py(22케이스), data/product_quality/{5개 산출물 + README}
EXECUTION_EVIDENCE=python tools/product_quality/build_quality.py 실행 → patch_rows=5270 duplicate_rows=1353, summary 실측 출력; python -m unittest discover -t . -s tools/product_quality/tests → Ran 22 tests OK; 원본 products.json SHA-256 실행 전후 동일(테스트로 검증)
TESTS=22/22 PASS (집중) + 회귀: tools/product_master 80케이스, tools/full_catalog, tools/erp (아래 TESTLOG)
OBSERVED_FACTS=모델명 누락 2,835건(samasound 2,281 전체 + samamusic 554), 제조사 누락 2,294건(samamusic 전체 — 이 사이트는 제조사 스펙행 자체가 없음), 브랜드 필드 누락 0건, 브랜드 표기 64종, 중복 판정 confirmed 538쌍/probable 274쌍/candidate 521쌍, 같은 사이트 브랜드+상품명 완전일치 20쌍, 자리표시자 제조사 '자체제작' 68건
MODEL_CLAIMS_NOT_INDEPENDENTLY_VERIFIED=브랜드↔제조사 대응 41종은 원본 스펙행 실측이지만 "동일 브랜드商品的 제조사가 계약상 제조사와 일치"하는지는 CGI 확인 필요
LIMITATIONS=원본에 표기가 없는 모델명 458건은 공백 유지. 승계된 모델명 368건은 이슈 #8 confirmed 판정에 의존(변형 충돌 검사 통과 건만). 가격·재고·공급권한은 본 작업 범위 밖
OUTPUTS=data/product_quality/product_quality_improved.json, product_quality_patch_candidates.csv, product_duplicate_candidates.csv, product_quality_summary.json, product_quality_review.xlsx
MERGED=(병합 확인 후 기재)
DEPLOYED=NO
LIVE_VERIFIED=NO (데이터 산출물이라 배포 대상 아님)
REMAINING=검토후보 2,351건 확정, 근거없음 모델명 458건은 공급처 원본 재확인 필요
NEXT=LOCAL2가 auto_confirmed 항목을 카탈로그/견적 데이터에 반영, LOCAL3은 ERP 품목매핑 시 manufacturer_after 대신 원본값 병기 검토
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
- `price_original`, `price_state_original` 은 원본 전달값(새로 만든 값 아님).
- `quality_flags` 로 검토후보/근거없음/자리표시자를 필터할 수 있다.
- 사이트 표시·UI(`site/**`), 견적 백엔드, ERP·나라장터 파일은 이 PR에서 변경하지 않았다.
- 상세 문서는 [`data/product_quality/README.md`](../data/product_quality/README.md).
