# data/product_quality — 이슈 #43 상품 DB 품질 개선 산출물 (Stage 1 + Stage 2)

**원본 마스터는 이 디렉터리에 없습니다.** `site/data/products.json` 4,575건은 그대로이며,
여기 있는 파일은 모두 **패치 레이어(제안)** 입니다. 원본을 덮어쓰거나 병합하지 않았습니다.

- Stage 1: 원본 스펙행(제조사/모델명)과 이슈 #8 `confirmed` 중복 승계만 자동 보완.
- Stage 2: 검토로 남긴 모델명 후보를 이미 수집된 모델명 어휘로 교차 실측해,
  **같은 브랜드의 명시 `모델명` 스펙행에서 독립 원본 ID 2건 이상**으로 실측된
  **40건만** `auto_confirmed` 로 승격. (동일 원본 ID의 중복 행은 독립 증거가 아니다.)
- `schema_version` 1.0.0 → **1.1.0**. 승격 전후 수치는 `product_quality_summary.json`
  의 `stage1_before_stage2` / `stage2` 에 그대로 남았다.

## 파일 목록

| 파일 | 내용 | 용도 |
|---|---|---|
| `product_quality_improved.json` | 4,575건 전체의 보완 전/후 값 + 근거 참조 + Stage 2 실측 지표 | **LOCAL2가 조인해서 쓰는 정본 패치 레이어** |
| `product_quality_patch_candidates.csv` | 조치 대상 5,270행 (자동 2,496 / 검토 2,311 / 근거없음 463) + Stage 2 지표 열 | 사람이 검토·확정하는 작업대 |
| `product_quality_stage2_verification.csv` | Stage 2가 실측한 2,351행 (승격 40 + 남은 검토 2,311), 우선순위 정렬 | 승격 근거·검토 순서 확인 |
| `product_duplicate_candidates.csv` | 중복 후보 1,353쌍 | 중복 판정·정리 근거 |
| `product_quality_review.xlsx` | 요약/**Stage2승격**/자동보완/검토후보/근거없음/중복후보/필드현황/LOCAL2계약 8시트 | 대표 보고·검토용 |
| `product_quality_summary.json` | 보완 전후 통계·Stage 2 변경 이력·승격 근거 40건·정책 플래그 | 기계 판독 요약 |

## 사용 규칙 (LOCAL2·LOCAL3 공통)

1. `improved.json` 의 `manufacturer_after` / `model_after` 는
   `patches.<field>.classification == "auto_confirmed"` 인 행만 사용한다.
   `review_required` / `no_evidence` 는 원본값을 그대로 쓴다.
   Stage 2 승격 40건도 이 규칙으로 그대로 노출된다 — 조인 방식·필드 이름 변경 없음.
2. Stage 2 지표는 `improved.json` 의 `verification.<field>` 에 있다
   (`attest_independent_ids`, `priority`, `priority_label`, `promoted_by_stage2`).
   승격된 행은 `quality_flags` 에 `model_stage2_promoted` 플래그가 있다.
3. `검토우선순위` 는 사람 확정 순서일 뿐 적용 권한이 아니다.
   P1 = 독립 원본 ID 1건 실측 또는 브랜드 제안, P2 = 영문상품명=파생 일치,
   P3 = 상대 공급처 `probable/candidate` 중복 판정 보유, P4 = 교차 실측·일치·링크 없음.
4. 브랜드 자리표시자 73건(제안 8 + 현행 65)과 제조사 검토 269건은 **자동 변경 0건**이다.
   원본 표기를 유지하고 검토후보 시트에서 확정해야 한다.
5. 가격·재고·공급권한 값은 이 산출물에 생성되지 않았다. `price_*_original` 은 원본 전달값이다.
6. 중복은 1,353쌍을 **표시만** 했다. 병합은 0건이므로 원본 4,575건 ID가 전부 유효하다.
7. Yamaha 673건(`site/data/yamaha_catalog.json`)은 이 작업에서 읽지도 다시 수집하지도 않았다.

## 재현

```powershell
# 저장소 루트(CGI-1, PowerShell)
python .\tools\product_quality\build_quality.py            # Stage 1 + Stage 2 재생성
python .\tools\product_quality\build_quality.py --no-stage2 # Stage 1 수치만 (비교용)
python -m unittest discover -t . -s tools\product_quality\tests -v
```

입력: `site/data/products.json`, `data/full_catalog/product_db.xlsx`(이슈 #8 정본).
네트워크 접근 없음 — Stage 2 승격 근거도 이미 수집된 원본 `모델명` 스펙행에서 나왔다.
