# CGI 스마트스토어 상품 등록 준비 (LOCAL 3)

> 작성일: 2026-10-23
> 담당: CGI 스마트스토어 연동 LOCAL
> 저장소: skerishKang/kbs261022 (worktree: central/issue20-erp-20261022 기반 브랜치 `feature/issue-20-smartstore-registration-prep`)
> 근거 데이터: `data/full_catalog/product_db.xlsx` (4,575건, 8시트)

## 1. 스마트스토어 승인 상태

- **확인 결과: 미승인 / 개설 전 (STORE_APPROVAL = false)**
- 2026-10-23 오전 통화 기준 승인 미확인. Ecount ERP 분석 문서(`reports/ecount-live-verification-20261023.md`)에서도
  "네이버 스마트스토어는 아직 개설되지 않음"으로 기록됨.
- 실제 관리자(스마트스토어센터) 접근 권한, 채널 개설, OAPI 인증키 발급, 카테고리/원산지/AS 템플릿 조회 **모두 불가**.
- 따라서 **운영 상품 등록 성공을 보고하지 않는다**. 이번 작업은 승인 전 준비(파일/검증 도구)에 한정한다.
- 승인 확인 시도: 브라우저/CLI 자격증명 미보유로 직접 로그인 불가. 문서/기존 분석 근거로 미승인 판단.

## 2. 공식 업로드 방식 (조사 결과)

- 네이버 스마트스토어센터 → 상품관리 → 상품 일괄등록 → 양식 다운로드 → (신)일괄등록 엑셀 작성 → 엑셀 업로드.
- 1회 최대 500건 업로드. 필수값 9개: 카테고리 코드, 상품명, 판매가, 재고수량, 대표이미지, 상세설명, 원산지코드, 수입사(해외 원산지 시), A/S 템플릿 코드.
- 이미지는 외부 URL 또는 이미지 업로드 후 파일명. 상세설명은 HTML(img 태그) 가능.
- 옵션은 별도 조합형/독립형 엑셀. 옵션 25자 제한, 특수문자 제한.
- 업로드 전 1행(유의사항) 및 예시 행 삭제 필요. 검색품질 체크 권장.

## 3. CGI 필드 → 네이버 필드 매핑

상세: `reports/data/smartstore/field_mapping.csv`

| CGI 필드 | 네이버 필드 | 상태 |
|---|---|---|
| 통합키/공급처원본ID | 판매자코드(후보) | 준비 |
| 상품명 | 상품명 | 준비 |
| 브랜드 | 브랜드 | 준비 |
| 제조사 | 제조사 | 준비(삼아음악만) |
| 모델명 | 모델명 | 부분(삼아사운드 1740건) |
| 카테고리경로 | 참고용 | 네이버 카테고리번호로 변환 필요 |
| 공개판매가 | 판매가 | 조건부(2117건) |
| 대표이미지 | 대표이미지 | 준비(4575건) |
| 이미지수 | 상세이미지 | 준비 |
| 출처URL | 상세설명 참고 | 고객 확정 |
| 스마트스토어카테고리번호 | 카테고리번호 | 미확정 |
| 재고수량 | 재고수량 | 미확정(미수집) |
| 원산지코드 | 원산지코드 | 미확정 |
| ASTemplateCode | A/S 템플릿 코드 | 미확정 |
| 배송비 | 배송비 | 미확정(고객 정책) |
| 반품/교환 | 반품/교환 정책 | 미확정(고객 정책) |
| KC/고시정보 | 상품정보제공고시 | 미확정 |
| 옵션SKU | 옵션 | 조건부(580건) |
| 네이버상품ID | 네이버상품ID | 등록 후 채움 |
| 이카운트품목코드 | ERP 연결 | 미확정 |

## 4. 준비 상태 요약

- 전체 상품: 4,575건
- 가격 공개(등록 가능 후보): 2,117건 (삼아음악)
- 가격 미공개(가격 문의): 2,458건 (삼아사운드 2,281 + 삼아음악 177)
- 대표이미지: 4,575건 (100%)
- 상세설명 존재: 4,252건
- 옵션 보유 상품: 580건
- 중복 상품 ID: 0건
- 네이버 카테고리번호 매핑: 0건 (스토어 개설 후)
- 재고/원산지/AS/배송/반품/고시정보: 0건 (고객 확정 필요)

## 5. 고객 확정 필요 항목 (가격·배송 정책 분리)

공개 상품 정보(자동 준비):
- 상품명, 브랜드, 제조사, 모델명, 카테고리 경로, 대표/상세 이미지 URL, 설명, 옵션, 출처 URL, 공개 판매가(2117건)

고객 확정 필요:
- 실제 판매가 (특히 가격 문의 2,458건)
- 설치비/AS 추가요금 (통화 언급 구상은 확정 정책 아님)
- 재고수량
- 원산지코드 및 수입사
- A/S 템플릿 (전화/이메일/기간)
- 배송비/배송정책
- 반품/교환 정책
- KC 인증·상품정보제공고시
- 네이버 카테고리번호 매핑
- 스마트스토어 전시상태

## 6. 산출물

- `data/smartstore_prep/smartstore_registration_prep.csv` (UTF-8 BOM, 4,575행)
- `data/smartstore_prep/smartstore_registration_prep.xlsx`
- `reports/data/smartstore/missing_fields_report.json`
- `reports/data/smartstore/duplicate_ids_report.json`
- `reports/data/smartstore/image_url_mapping.csv`
- `reports/data/smartstore/field_mapping.csv`
- `reports/data/smartstore/summary.json`

도구:
- `tools/smartstore/build_smartstore_prep.py` (생성)
- `tools/smartstore/validate_smartstore_prep.py` (검증)
- `tools/smartstore/tests/test_smartstore_prep.py` (19 tests)

## 7. 확장 고려 (이번 범위 외, 후속)

- 기존 CGI 쇼핑몰 ↔ 스마트스토어 상품ID 연결: `네이버상품ID` 컬럼 예약
- Ecount ERP 품목번호 연결: `이카운트품목코드` 컬럼 예약 (ERP 개설 후)
- 등록 결과/재시도 이력: 후속 (승인 후)
- 중복 등록 방지: `공급처원본ID` + `네이버상품ID` 조합으로 관리
- 주문·배송 연계: 이번 범위 외

## 8. 검증

- `python tools/smartstore/build_smartstore_prep.py` → 4,575건 처리
- `python tools/smartstore/validate_smartstore_prep.py` → PASS
- `python -m unittest tools.smartstore.tests.test_smartstore_prep` → 19 OK
- 라이브 등록: 미수행 (STORE_APPROVAL=false)

## 9. 승인 후 경로 (예정)

1. 스마트스토어센터 로그인 → 카테고리/원산지/AS 템플릿 조회
2. OAPI 인증키 발급 + IP 등록
3. 카테고리번호 매핑 테이블 작성 → prep 파일에 채움
4. 배송·반품·고시정보 고객 확정값 반영
5. 500건 단위 일괄 업로드 + 결과/재시도 이력 기록
6. 네이버상품ID를 DB에 역반영 (통합상품/네이버스토어준비 시트)
