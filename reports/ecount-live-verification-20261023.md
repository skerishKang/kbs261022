# 이카운트 ERP 실계정 검증 보고서 (2026-10-23)

> 이슈: [#20](https://github.com/skerishKang/kbs261022/issues/20) · 브랜치: `feature/issue-20-ecount-live-verification`
> 범위: 읽기 전용 조회 + 빈 서식 다운로드. **운영 데이터 생성·수정·삭제 0건.**
> 보안: 계정정보·세션·행 단위 실데이터는 본 문서와 저장소에 기록하지 않는다. 증적 파일은 `.gitignore`(`reports/data/erp/live/`)로 제외.

---

## 1. 결과 요약

| 항목 | 결과 | 증적(로컬 전용) |
|---|---|---|
| ERP 로그인 | **PASS** — ERP 셸·메뉴 트리 진입 | `probe_summary.json` |
| 품목 마스터 | **VERIFIED** — 목록 14컬럼, 신규 폼 7탭, **Excel export 964건** | `item_list.json`, `item_new.json`, `ecount_item_export.xlsx` |
| 재고 | **VERIFIED** — 재고현황 export 351행(수량>0 308), 입고단가 177건 | `inventory.json`, `inventory_export_excel_click.xlsx` |
| 주문 | **VERIFIED** — 주문서조회 기존 4행 표시 | `probe_주문서조회.json` |
| 매출 전표 | **VERIFIED (입력 폼)** — 매출전표 I 필드·버튼 확인, 전표 생성 미수행 | `sales_slip_new.json`, `sales_slip_list.png` |
| 엑셀 가져오기 | **VERIFIED** — 품목등록 `웹자료올리기` + **빈 템플릿 다운로드** + 셀 주석 파싱 | `ecount_item_template.xlsx`, `excel_uploader.json` |
| 쇼핑몰 연동 | **VERIFIED (현황)** — 채널 0, 매핑 0, API 키 0. SmartStore2.0 기능 매트릭스 확보 | `mall_list2.json`, `mall_item_link.json`, `api_key.json` |
| ERP↔CGI 대조 | **DONE (집계)** — 코드 일치 0, 이름 1쌍, 모델 25쌍, 후보 62쌍 | `reports/data/erp/erp_readonly_report.md` |
| 변환기 | **DONE** — 공식 17컬럼 4,575행, 검증 PASS | `data/erp_prep/ecount_item_upload.*` |
| 테스트 | **PASS** — 22 tests | `tools/erp/tests/test_erp_prep.py` |

---

## 2. 수행 방법

- Playwright(Chromium, headless) 별도 컨텍스트. 운영자 개인 브라우저 프로필 미사용.
- 자격증명은 로컬 env(`ECOUNT_COM_CODE`, `ECOUNT_USER_ID`, `ECOUNT_PASSWORD`)로만 주입. 스크립트 기본값·저장소 기록 없음.
- `ec_req_sid` 는 수집 JSON/URL에서 `REDACTED` 처리.
- 이동: 로그인 → 좌상단 메뉴검색(`#inputFavMSearch`) → 프로그램 진입(SPA).
- 다운로드: 각 화면 `Excel` / `웹자료올리기 > 엑셀서식내려받기` 만 사용.

---

## 3. 확인된 화면·기능

### 3.1 품목 (E040103)

- 목록 컬럼: `계층그룹명 · 품목코드 · 품목명 · 품목구분 · 규격명 · 그룹명 · 검색창내용 · 사용구분 · 파일관리 · 입고단가Vat포함여부 · 출고단가Vat포함여부 · 재고수량관리 · 이미지 · 시리얼/로트No.`
- 신규 폼: 7탭(`기본/품목정보/수량/단가/원가/부가정보/관리대상`), `변경항목선택` 153필드.
- Excel export: **964건**. 코드는 `000001`·`A…` 등 기존 자체 채번.
- 품목구분 분포: 상품 689 / 제품 88 / 부재료 74 / 원재료 65 / 무형상품 45 / 반제품 3.

### 3.2 재고 (E040701)

- export 351행. 재고수량>0 308행, 입고단가 존재 177행.
- 품목 export와 코드 교집합 347건 → 재고는 품목 마스터의 부분집합.
- **안전재고와 실재고는 별개**이며, 재고현황의 `balQty` 는 안전재고가 아니다.

### 3.3 주문·전표

- 주문서조회 리스트에 기존 주문 4행 표시(내용 미기록).
- 매출전표 I 입력 폼에서 거래처·공급가액·부가세·적요·차/대변 필드 확인.
- `저장(F8)`·`저장/전표(F7)` 은 실행하지 않았다.

### 3.4 엑셀 가져오기 (E000129)

- 두 방식(엑셀자료올리기 / 웹자료올리기) 안내 확인, **웹자료올리기 채택**.
- `품목등록 > 웹자료올리기` 팝업 탭: `품목 등록자료 · 변경하기 · 다공정품목등록 · 창고별안전재고올리기`.
- 빈 템플릿 `Template.xlsx` 다운로드 → 17컬럼 + 셀 주석의 허용값·최대길이 파싱 완료(`ecount_template_spec.json`).
- 실제 `자료올리기` 는 실행하지 않았다.

### 3.5 쇼핑몰·스마트스토어

- `쇼핑몰등록` 0행, `쇼핑몰품목코드연결` 0행.
- `쇼핑몰추가요청` 은 **미지원 업체 추가 요청용** — 스마트스토어2.0 은 지원 채널이므로 불필요.
- `수집처` 는 typeahead. 동일 `data-cid` 요소 2개(1개 숨김) → 자동화 시 `:visible` 필요.
- 공통 등록 폼에서 네이버 OAuth 전용 필드는 관찰되지 않음. **채널 등록은 쓰기이므로 미수행** → 전용 필드는 후속 승인 단계에서 확정.
- `API인증키발급` 키 0건, IP등록 필요.

---

## 4. 데이터 품질 교정 (이번 단계에서 확정)

| 항목 | 기존 가정 | 실측 후 확정 |
|---|---|---|
| ERP 품목코드 | 카페24 `product_code` 그대로 | **사용 불가** — 4,234건 중 856건 중복. `SS-`/`SM-` + 통합키 seq |
| 바코드 | 카페24 `item_code` 매핑 | **전체 유일할 때만** 기입(2,568/4,575) |
| 재고수량관리 | 전 품목 관리 | 삼아사운드 `0`(2,281) / 삼아뮤직 `1`(2,294) |
| 출고단가 | 웹 판매가 | 2,117건만 존재. 미공개 2,458건은 **공란 유지** |
| 입고단가 | — | **항상 공란**. 웹에 공급가 없음 |
| 업로드 컬럼 | 커스텀 19컬럼 | **공식 17컬럼**(헤더 공백 포함) |

---

## 5. 산출물·검증

```bash
python tools/erp/build_erp_prep.py
python tools/erp/validate_erp_prep.py          # VALIDATION PASSED
python tools/erp/extract_template_spec.py
python tools/erp/compare_erp_cgi.py            # 집계 전용
python -m unittest tools.erp.tests.test_erp_prep  # 22 OK
```

- 4,575행 / 고유 코드 4,575 / 중복 0 / 가격 2,117 / 수량관리 2,294 / 바코드 2,568.
- CSV·XLSX 파리티 검증 포함. XLSX는 시트 `품목등록`.
- 비교 보고서: `reports/data/erp/erp_readonly_report.md` (행 데이터 없음).

---

## 6. 보안 발견·조치

1. **과거 커밋에 ERP·네이버 평문 자격증명 존재** → ERP 도구 3종·프로브에서 제거, env 주입 전환. **이력에는 남아 있으므로 비밀번호 교체 필요.**
2. 네이버 수집기(`tools/smartstore/naver_login_probe.js`)는 LOCAL 2 수정 금지 경계로 미변경 → **별도 후속 조치 필요**.
3. live evidence·ERP export CSV `.gitignore` 처리. 보고서는 집계만 기록.
4. `ec_req_sid` 등 세션 값은 수집 JSON에서 REDACTED.

---

## 7. 미확정·후속

| 항목 | 상태 |
|---|---|
| 스마트스토어2.0 전용 인증 필드 | 채널 등록(쓰기) 없이는 확정 불가 |
| OAPI 엔드포인트·인증 방식 | 매뉴얼 외부 문서. 키 발급 후 확인 |
| `데이터내보내기`(C001403) 화면 | 메뉴 검색 미출현, 프로그램 ID만 확인 |
| WMS 입고처리(E090181) | 렌더 미완, 필드 미확인 |
| 실제 일괄 등록 | **미수행** — 승인 후 샘플 5~20건 → 전량 |
| 기존 964건과 신규 4,575건 중복 | 이름 1·모델 25·후보 62쌍. 담당자 판정 필요 |

**다음 단계**: ① 자격증명 교체 ② 샘플 업로드 검증 ③ 전량 등록 + 2차 확장필드 ④ 창고별 안전재고 ⑤ 스마트스토어 채널·OAPI·품목코드연결.
