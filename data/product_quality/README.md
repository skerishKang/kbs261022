# data/product_quality — 이슈 #43 상품 DB 품질 개선 산출물

**원본 마스터는 이 디렉터리에 없습니다.** `site/data/products.json` 4,575건은 그대로이며,
여기 있는 파일은 모두 **패치 레이어(제안)** 입니다. 원본을 덮어쓰거나 병합하지 않았습니다.

## 파일 목록

| 파일 | 내용 | 용도 |
|---|---|---|
| `product_quality_improved.json` | 4,575건 전체의 보완 전/후 값 + 근거 참조 | **LOCAL2가 조인해서 쓰는 정본 패치 레이어** |
| `product_quality_patch_candidates.csv` | 조치 대상 5,270행 (자동/검토/근거없음) | 사람이 검토·확정하는 작업대 |
| `product_duplicate_candidates.csv` | 중복 후보 1,353쌍 | 중복 판정·정리 근거 |
| `product_quality_review.xlsx` | 요약/자동보완/검토후보/근거없음/중복후보/필드현황/LOCAL2계약 7시트 | 대표 보고·검토용 |
| `product_quality_summary.json` | 보완 전후 통계·정책 플래그 | 기계 판독 요약 |

## 사용 규칙 (LOCAL2·LOCAL3 공통)

1. `improved.json` 의 `manufacturer_after` / `model_after` 는
   `patches.<field>.classification == "auto_confirmed"` 인 행만 사용한다.
   `review_required` / `no_evidence` 는 원본값을 그대로 쓴다.
2. 가격·재고·공급권한 값은 이 산출물에 생성되지 않았다. `price_*_original` 은 원본 전달값이다.
3. 중복은 1,353쌍을 **표시만** 했다. 병합은 0건이므로 원본 4,575건 ID가 전부 유효하다.
4. Yamaha 673건(`site/data/yamaha_catalog.json`)은 이 작업에서 읽지도 다시 수집하지도 않았다.

## 재현

```powershell
# 저장소 루트(CGI-1, PowerShell)
python .\tools\product_quality\build_quality.py
python -m unittest discover -t . -s tools\product_quality\tests -v
```

입력: `site/data/products.json`, `data/full_catalog/product_db.xlsx`(이슈 #8 정본).
네트워크 접근 없음 — 모든 보완 값은 이미 수집된 원본 표기에서 나왔다.
