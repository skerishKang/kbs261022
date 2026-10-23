# CGI 이카운트 ERP 품목 등록 준비 (LOCAL 3, 우선순위 1)

> 기준: `reports/ecount-item-bulk-registration.md`, `reports/erp-item-master-mapping.csv`, `reports/ecount-naver-smartstore-integration.md`
> 브랜치: `feature/issue-20-ecount-erp-prep` (main f5132c2 기반)

## 1. ERP 계정 접근 상태

- **ERP_ACCOUNT_ACCESS_VERIFIED = false** (실제 계정 로그인/서식 확인 미수행)
- 운영 전표·재고 임의 변경 없음. 조회·서식 확인 중심 원칙 준수.
- Ecount 분석 문서 기준: ERP는 주문·재고·계정 백오피스이며, ERP→스마트스토어 상품 마스터 배포 기능은 없음(X). 따라서 상품 마스터 배포는 카페24/네이버 API 별도.

## 2. CGI 4,575건 → ERP 품목코드 매핑 검증

- 품목코드 생성 규칙: `{SS|SM}-{원본ID}` (<=20자). 중복 0건, 길이 초과 0건.
- 품목명: 4,575건 (100%)
- 브랜드(cont2): 4,575건 (100%)
- 제조사(cont4): 2,281건 (삼아음악)
- 모델(cont3/규격): 1,740건
- 출고단가(out_price): 2,117건 (공개가)
- 이미지: 4,575건

누락(고객/ERP 확정 필요):
- 품목그룹(class_cd): 4,575 (ERP 그룹 체계 확정 후)
- 입고단가(in_price): 4,575 (도매가 미수집)
- 안전재고(safe_qty): 4,575
- 원산지(cont5): 4,575
- 부가세율(tax): 미확정

## 3. ERP 제공 기능 우선 활용

- `자료올리기` (Excel 2007+, 17컬럼) 템플릿 기반 일괄 등록.
- `Template.xlsx` (품목) 업로드 → `자료올리기` → `자료확인` → 저장.
- 쇼핑몰 품목 key 매핑(`쇼핑몰품목코딩연동`)은 스마트스토어 개설 후.

## 4. 산출물

- `data/erp_prep/ecount_item_bulk_prep.csv` (UTF-8 BOM, 4,575행)
- `data/erp_prep/ecount_item_bulk_prep.xlsx`
- `reports/data/erp/missing_erp_fields_report.json`
- `reports/data/erp/duplicate_item_codes_report.json`
- `reports/data/erp/summary.json`
- `tools/erp/build_erp_prep.py`, `validate_erp_prep.py`, `tests/test_erp_prep.py`

## 5. 스마트스토어 파이프라인 연계

- 스마트스토어 미승인 상태에서도 상품 등록 파일 변환(완료), 중복 방지(완료), 결과 이력/재시도 도구(후속: 승인 후) 개발.
- CGI 쇼핑몰↔스마트스토어 상품ID 연결: `쇼핑몰품목key` 컬럼 예약.
- Ecount ERP 품목번호 연결: `품목코드` 컬럼 예약.

## 6. 검증

- `python tools/erp/build_erp_prep.py` → 4,575건
- `python tools/erp/validate_erp_prep.py` → PASS
- `python -m unittest tools.erp.tests.test_erp_prep` → 12 OK
- 라이브 ERP 쓰기: 미수행
