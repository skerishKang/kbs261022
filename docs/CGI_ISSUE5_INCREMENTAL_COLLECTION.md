# 이슈 #5 — 삼아사운드·삼아스토어 증분 수집·갱신 절차

## 1. 목적
2026-10-22 기준 커밋된 상품 마스터 4,575건(samasound 2,281 / samamusic 2,294)을 baseline으로,
현재 공개 사이트를 (재)수집해 **신규·변경·삭제/단종 후보**를 판별하고, 네이버 스마트스토어
등록용 **필수·누락 필드 준비도**를 재실행 가능한 절차로 완성한다. 실등록·ERP·계정 접근은 범위 밖.

## 2. 재사용한 기존 기술
- 수집 파서·Fetcher: `tools/full_catalog/collect_cgi_catalog.py`(Cafe24 공통 + 사이트별 어댑터)를 그대로 import.
- 안정 키: `(source_site, source_product_id)` — `tools/product_master/schema.py` 규약과 동일.
- baseline: `data/full_catalog/product_db_compact.csv`(21필드, 4,575행).
- 준비도: `tools/smartstore/build_smartstore_prep.py`는 xlsx 시트에 의존 → 본 절차는
  CSV 전용 `tools/full_catalog/naver_field_readiness.py`로 어딜서나 재실행.

## 3. 신규 도구
- `tools/full_catalog/incremental_update.py`
  - `snapshot --site --enum full|sitemap` : 현재 수집(목록 전체보기 / sitemap).
  - `diff --site --snapshot --enum full|partial --out-dir` : baseline 대비
    `new / changed / removed_candidate / partial_unobserved` 판별, 누적 병합 기록.
- `tools/full_catalog/naver_field_readiness.py` : 필수·누락 필드 집계 + 행 단위 준비도.

## 4. 열거 신뢰도 정책(추정·조작 금지)
- `full`(전체보기 목록 전 페이지): baseline−snapshot 을 **삭제/단종 후보**로 계상.
- `partial`(sitemap 등 부분 소스): 관측분에서만 new/changed. 미관측 baseline 은
  **삭제로 단정하지 않고 `partial_unobserved`로 보류.**
  (실측: samamusic sitemap 1,597 < baseline 2,294 → 697건은 미관측이지 삭제 아님.)
- URL 은 정규 canonical(마스터)과 display URL(목록) 형태가 달라 **비교 대상에서 제외**(전원 오탐 방지).
- 상품명 비교는 내부 연속공백 정규화 후 수행(이중 space 표기차 = 변경 아님).

## 5. 금번 실측 결과(2026-10-23, baseline 대비)
| site | baseline | snapshot | new | changed | removed_candidate | partial_unobserved |
|---|---|---|---|---|---|---|
| samasound (full) | 2,281 | 2,229 | 0 | 0 | 52 | 0 |
| samamusic (partial/sitemap) | 2,294 | 1,597 | 0 | 0 | 0 | 697 |

- samasound '전체보기' 헤더 등록제품=2,229(목록 페이지 메타)와 수집 건수 일치 → 신뢰.
- 삭제/단종 후보 52건은 원문 URL 보존 상태로 별도 CSV에 기록(실삭제·원본 덮어쓰기 없음).
- 상세 필드(가격·옵션·이미지·재고) 변경 탐지는 목록 스냅샷으로 불가능 → `--enum full` 카테고리
  크롤 + `--ids` 바운디드 상세 재조회로 확장(네트워크 부하·무제한 요청 금지에 따라 운영 단계 실행).

## 6. 가격·출처 구분(혼동 금지)
- `public_price` = 공급처 **공개 판매가**만. 문의(2,370)/품절(87)/미확인 상품은 판매가 누락 계상.
- `cgi_dealer_price`·`cgi_sale_status(=unapproved)`·공급가는 DB 어디에도 확정값 없음 → 추정하지 않는다.
- 두 사이트는 `source_site` 로 끝까지 분리(삼아사운드 B2B/브랜드행 없음, 삼아스토어 B2C/브랜드·모델행 있음).

## 7. 네이버 필드 준비도(요약)
`reports/data/smartstore/field_readiness_report.json`
- 4,575건 전부 구조적 누락 = `상세설명·카테고리번호·원산지코드·ASTemplateCode·배송비`(공개 소스 불가) +
  `재고수량`(공개 표기만, 확정값 아님). 판매가 확보 2,117 / 누락 2,458.
- 상품명·대표이미지 결손 0 → 준비도 전건 `partial`(구조물完备, 정책·표준카테고리·확정재고 미비).
- **카테고리번호·배송비·KC·AS 정책은 고객/운영 확정 전까지 등록 금지**(별도 단계).

## 8. 검증
- 단위 테스트 `tools/full_catalog/tests/test_incremental.py` 13건 + 기존 카탈로그 스위트 = 총 31건 PASS.
- 네트워크: samasound cate23 112p / samamusic sitemap 1p 순차+지연+캐시(무제한 요청 없음).

## 9. 산출물
- `data/full_catalog/incremental/증분_변경후보.csv`, `incremental_stats.json`
- `reports/data/smartstore/field_readiness_report.json`, `field_readiness_rows.csv`
