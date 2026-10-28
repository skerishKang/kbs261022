# CGI 이카운트 ERP 품목 등록 준비 (LOCAL 3, #20)

> 브랜치: `feature/issue-20-ecount-live-verification` (main `2f55079` 기반)
> 실계정 확인일: **2026-10-23** · 조회·서식 다운로드만 수행, **운영 데이터 쓰기 0건**

## 1. ERP 계정 접근 상태

- **ERP_ACCOUNT_ACCESS_VERIFIED = true** — 실계정 로그인, 품목·재고·주문·전표·쇼핑몰·API 화면 조회 완료.
- 로그인·세션 값은 저장소에 기록하지 않는다. 자격증명은 로컬 env 파일(`~/.config/cgi-erp/ecount.env`)에서만 주입한다.
- 조회(GET)·화면 탐색·**빈 서식 다운로드**만 수행. `저장(F8)`, `자료올리기`, `키발급`, `선택삭제`, `사용중단` 은 실행하지 않았다.

## 2. 실계정 확인 결과 (집계)

| 항목 | 결과 |
|---|---|
| 품목 마스터 | 964건 / 14컬럼 export (`prod_cd`, `prod_des`, `PROD_TYPE`, `class_cd`, `out_price` 등) |
| 재고현황 | 351행 export / 재고수량>0 308행 / 입고단가 존재 177행 / 품목 export와 코드 교집합 347건 |
| 주문서 | 주문서조회 리스트에 기존 주문 4행 표시 확인 |
| 매출전표 | 매출전표 I 입력 폼 필드 확인 (전표 생성은 미수행) |
| 엑셀 가져오기 | 품목등록 `웹자료올리기` 팝업 + **빈 템플릿 `Template.xlsx` 다운로드** |
| 쇼핑몰 | `쇼핑몰등록` 0행, `쇼핑몰품목코드연결` 0행 |
| OAPI | 발급된 인증키 없음. IP등록 필요 안내 확인 |
| ERP↔CGI 대조 | 품목코드 정확 일치 0, 상품명 일치 1쌍, 모델명 일치 25쌍, 후보 62쌍 (집계 전용) |

> ERP 기존 964건은 CGI 4,575건과 코드 체계가 다르다(기존 `000001`·`A...` 채번). **이번 단계에서는 기존 품목을 수정·매핑하지 않는다.** 신규 CGI 품목은 `SS-`/`SM-` 접두 규칙으로 추가 등록하는 것을 전제로 한다.

## 3. CGI 4,575건 → ERP 품목 변환 계약

공식 17컬럼 템플릿 기준. 컬럼 순서·헤더 문구(특히 `입고단가 VAT포함여부` 의 공백)를 그대로 사용한다.

| 규칙 | 값 |
|---|---|
| 품목코드 | `SS-<통합키 seq>`(삼아사운드 2,281) / `SM-<통합키 seq>`(삼아뮤직 2,294). **카페24 코드는 중복(4,575행 중 856건 중복)이라 사용 불가** |
| 품목명 | 정규화된 `product_name` (≤100자) |
| 바코드 | 카페24 `item_code` 가 **전체에서 유일할 때만** 기입 → 2,568건. 중복 코드는 공란 |
| 규격 | `model` 존재 시 `1`(규격명) + 값 → 1,740건. 없으면 공란(추정 금지) |
| 단위 / 품목구분 / 세트 | `EA` / `3`(상품) / `0`(세트아님) |
| 재고수량관리 | 삼아사운드 `0`(2,281), 삼아뮤직 `1`(2,294) — 웹 `use_stock` 기준 |
| 입고단가 | **항상 공란** — 웹에 공급가 없음, ERP 전표/거래처단가에서만 확정 |
| 출고단가 | `published_price` 존재 시만 기입(VAT 포함 `1`) → 2,117건. 나머지 2,458건 공란 |
| 부가세율 | 매출/매입 `10` |
| 검색창내용 | `브랜드 모델명 품목명` ≤100자 |
| 품목공유여부 | `0` |

확장 필드(브랜드/모델명/제조사/원산지)는 17컬럼에 없으므로 **2차 `변경하기` 업로드**로 반영한다(`cont2`=브랜드, `cont3`=모델명, `cont4`=제조사, `cont5`=원산지). `cont1` 은 조달등록번호 전용이라 사용하지 않는다.

## 4. 산출물

| 파일 | 내용 |
|---|---|
| `data/erp_prep/ecount_item_upload.csv` | 공식 17컬럼, UTF-8 BOM, 4,575행 |
| `data/erp_prep/ecount_item_upload.xlsx` | 동일 내용, 시트 `품목등록` |
| `data/erp_prep/erp_extended_mapping.csv` | 2차 변경용 확장필드 매핑(브랜드/모델/제조사/원산지 등) |
| `reports/data/erp/ecount_template_spec.json` | 빈 템플릿에서 추출한 헤더·최대길이·허용값 (데이터 없음) |
| `reports/data/erp/summary.json` | 생성 집계 + `live_erp_write_performed: false` |
| `reports/data/erp/missing_erp_fields_report.json` | 누락 필드 집계 |
| `reports/data/erp/duplicate_item_codes_report.json` | 중복 0건 증빙 |

## 5. 도구·검증

```bash
python tools/erp/build_erp_prep.py       # 변환 (4,575행)
python tools/erp/validate_erp_prep.py    # 공식 헤더·도메인·길이·CSV/XLSX 일치 검증
python -m unittest tools.erp.tests.test_erp_prep   # 22 tests
python tools/erp/extract_template_spec.py          # 빈 템플릿 스펙 재추출
python tools/erp/compare_erp_cgi.py                # ERP export와 집계 대조 (읽기 전용)
```

- 검증 결과: `VALIDATION PASSED` — 4,575행, 코드 중복 0, 가격 2,117, 수량관리 2,294.
- 테스트는 데이터셋 불변식 + 검증기 합성 케이스(허용값 위반·중복·길이 초과·가격 형식·세트 여부)를 포함한다.
- ERP live evidence(`reports/data/erp/live/`)와 ERP export CSV는 `.gitignore` 로 제외한다. **원본 품목 행은 저장소에 올리지 않는다.**

## 6. 스마트스토어 파이프라인 연계

- 이카운트는 스마트스토어2.0 **주문·클레임 처리는 지원(5/5, 6/7 — 환불 완료 X), 상품등록은 미지원(X)** → 상품 마스터 배포는 카페24/네이버 API 별도 경로.
- 연동 전제: ① 쇼핑몰등록(채널) ② `쇼핑몰품목코드연결`(ERP `prod_cd` ↔ 스마트스토어 상품ID) ③ OAPI 키+IP등록.
- 현재 채널·매핑·키 모두 0건. 채널 등록 화면은 `수집처` typeahead + 공통 인증필드 구조만 확인했고, **스마트스토어 전용 조건부 필드는 채널 등록(쓰기) 없이는 확정 불가** → 후속 단계.

## 7. 보안 조치 (중요)

- 과거 커밋에 ERP·네이버 자동화 스크립트의 평문 자격증명이 포함되어 있었다. ERP 도구 3종은 이전 브랜치에서, 네이버 수집기는 보안 수정 브랜치(`fix/issue-1-plaintext-credentials`)에서 하드코딩을 제거하고 env 주입으로 전환했다.
- **git 이력에는 값이 남아 있으므로 운영자 조치가 필요하다: 비밀번호 교체 가능 시점에 교체 + 필요 시 이력 정리(force-push) 결정.** 저장소에는 값을 재기재하지 않는다. 상세: `reports/security/plaintext-credential-exposure.md`
- 재발 방지: `tools/security/scan_secrets.py` + `.github/workflows/secret-scan.yml` 이 추적 파일의 평문 자격증명을 검사한다. 로컬 자격증명은 저장소 밖(`~/.config/cgi-erp/`)에서 env 로 주입한다. `.env.example` 은 빈 자리표시자만 둔다.

## 8. 후속 단계 (실행 전 승인 필요)

1. 비밀번호 교체 및 이력 정리 여부 결정.
2. 샘플 5~20건 `자료올리기` → `결과` 컬럼 검증 → 전량 4,575건 등록.
3. `변경하기` 2차 업로드로 브랜드/모델/제조사/원산지 반영.
4. 창고 코드 확정 후 `창고별안전재고올리기`.
5. 스마트스토어 채널 등록 + OAPI 키 발급 + `쇼핑몰품목코드연결`.
