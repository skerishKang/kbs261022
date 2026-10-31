# CGI 이카운트 ERP 964품목 × 통합 상품 마스터 4,575건 중복 대조·매핑 구축 (2026-10-31)

- 이슈: #1(스마트스토어·이카운트 통합 실증) / #101(상품·재고 원본 단일화) 연계
- 도구: `tools/erp/erp_master_mapping.py` (기존 `compare_erp_cgi.py` 로더·정규화 재사용 — 신규 마스터 DB 없음)
- 원칙: 전 입력 읽기 전용. **ERP 쓰기 0 · 네이버 쓰기 0 · 상품 마스터 원본(product_db.xlsx) 변경 0** (입력 SHA-256 실행 전후 동일 확인). 품목 단위 매핑표는 비공개 위치(`work-erp/erp_master_mapping.csv`, 저장소 밖)에만 존재하며 본 문서와 `reports/data/erp/erp_master_mapping_summary.json`은 비식별 집계만 담는다.

## 1. 입력 출처·시점

| 입력 | 출처 | 시점 | 건수 |
|---|---|---|---|
| ERP 품목 | 이카운트 실계정 엑셀 export(`ecount_item_export.xlsx`, 12컬럼, footer 타임스탬프 2026-10-23 13:01) | 2026-10-23 | **964** (965행 − footer 1, 품목코드 중복 0) |
| CGI 통합 마스터 | `data/full_catalog/product_db.xlsx` 통합상품 시트 | main 기준 | **4,575** |
| 네이버 원장(참조) | `reports/data/erp/linkage_plan_20261030.json` records | 2026-10-30 | 1,000 |

**최신성 고지**: 964는 2026-10-23 export 기준이다. 10-23~10-31 라이브 품목 수 재조회는 불가 — OAPI 발급 키 없음(10-23 조사 확인), 브라우저 재조회는 세션 자격 재요구로 이번 경계 밖. 10-31 라이브 실계정 재수출 시 본 러너 재실행으로 델타만 확정하면 된다(도구 재실행 비용 0).

## 2. 매칭 규칙(3단계)과 가드

1. **1차 식별자**: 제안 품목코드(`SS-`/`SM-<공급처원본ID>`) == ERP 품목코드 → `erp_code_exact`; 모델명 정규화 정확 일치 + 브랜드 일치(영문/검색창내용 토큰) → `model_brand_exact`/`model_search_brand`. ERP export에 **바코드 컬럼이 없어 바코드 단계는 이번 라운드 불가** (컬럼 확보 시 자동 활성화).
2. **2차 정규화**: 모델 정확 일치·브랜드 불일치/결측 → `model_exact_brand_diff`(표기 차이 동일 품목 후보); 품목명 정규화 정확 일치 → `name_exact`.
3. **3차 유사도(후보 발견 전용)**: 부분 문자열/토 포함 → `token_containment`. 상한 65점으로 **유사도만으로는 절대 확정하지 않는다**(수동 확인 행).

가드(자동 병합 금지 → SUSPECTED 강등 + review_required=Y): ERP 세트/번들 vs 마스터 단품, 마스터 세트 vs ERP 단품, 리퍼·박스손상·개봉·교환·전시 등 상태 토큰 불일치, 다옵션 마스터 vs 규격 없는 ERP 단품.

1:1 배정은 결정적 정렬(점수↓, 마스터키↑, ERP코드↑). 동일 ERP를 복수 마스터가 확정 수준으로 요구하면 승자는 등급 유지 + `review_required=Y(multi_master_same_erp)`, 패자는 `CONFLICT(lost_1to1_assignment)`로 수동 이관.

## 3. 결과 (요약 JSON과 동일 실측)

| 분류 | 건수 |
|---|---|
| EXACT_MATCH | **8** |
| NORMALIZED_MATCH | **18** |
| SUSPECTED_DUPLICATE | **135** |
| NEW_CANDIDATE | **4,410** |
| INSUFFICIENT_DATA | **4** |
| CONFLICT | **0** |
| 합계 | 4,575 (무결성 검사 issues=0) |

- ERP 확정 매핑(1:1 배정) **26개 품목코드** / 미매칭 ERP **938** (렌탈·용역·무형·CGI 미수집 품목 등)
- SUSPECTED가 참조한 ERP 코드 41개(확정 아님)
- 복수 마스터→동일 ERP 확정 충돌 쌍 0, 마스터 다중 확정 배정 0
- confidence: 0.75~1.0(1·2차), ≤0.65(3차 상한)
- 10-23 잠정 조사(정확 일치 0·상품명 1쌍·모델명 25쌍·후보 62) 대비: 확정 26쌍은 동일 실체 재확인, 후보군은 135로 세분(가드·1:1 정책 반영)

## 4. 신규 등록 후보 검증 (등록 미수행)

- **향후 ERP 신규 등록 후보 = 4,410건(NEW_CANDIDATE)**. 이 중 **978건은 네이버 스마트스토어에 이미 등록된 상품** — ERP에는 대응 품목이 없어, 장래 등록 시 **중복이 아닌 최초 생성** 대상이다(대표 우려인 "기존 964개와 중복 등록" 위험군은 확정 26 + 의심 135이며, 4,410건은 그 밖의 품목).
- 등록 전 필수 관문(차후 단계): ① SUSPECTED 135건 수동 판정 완료, ② 10-31 라이브 재수출로 964+Δ 기준 갱신, ③ INSUFFICIENT 4건 식별 정보 보완(브랜드 NNNN·모델 결측), ④ 바코드 컬럼 확보 시 바코드 재대조 1회.
- 등록 계약은 기존 확정본 재사용: 17컬럼 `data/erp_prep/ecount_item_upload.csv` 규칙(SS-/SM- 코드, 입고단가 공란). 본 작업에서 업로드·저장(F8)은 수행하지 않았다.

## 5. 재현·검증

- 실행: `python tools/erp/erp_master_mapping.py --erp-xlsx <비공개>/ecount_item_export.xlsx --mapping-out <비공개>/erp_master_mapping.csv --summary-out reports/data/erp/erp_master_mapping_summary.json`
- 결정성: 2회 실행 매핑 CSV 바이트 동일(SHA-256 일치 실측)
- 테스트: `tools/erp/tests/test_erp_master_mapping.py` 17건(합성 샘플) — 정규화·3단계·세트/옵션/상태 가드·1:1 충돌·결정성·입력 무변경·무결성·BOM 서식. CI(`erp-tests.yml`) 통합. 기존 `test_erp_prep` 22건과 함께 로컬 OK.
- 보존 확인: product_db.xlsx·ERP export 실행 전후 SHA-256 동일, 저장소 diff에 품목 실데이터 0건.
