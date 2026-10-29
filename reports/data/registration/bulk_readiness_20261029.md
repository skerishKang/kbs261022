# 대량등록 준비 상태 보고 (2026-10-29, 지시 §4)

> **이 문서는 준비 상태 보고다 — 이번 작업에서 신규 상품 대량등록은 실행하지 않았다.**
> 모든 수치는 기존 산출물의 실측값이다: `reports/data/registration/readiness_summary.json`,
> `reports/data/registration/dry_run_summary.json`, `reports/data/registration/live/*_20261029.json`.

## 1. 전체 규모와 현재 등록 가능 수

| 항목 | 수치 | 출처 |
|---|---|---|
| 수집상품 총수 | **4,575건** (product_db_compact = 준비파일 = 매핑레코드) | readiness_summary.inputs |
| 현재 등록 가능(레인 기준) | **0건** — 전 건이 blocking 필드 보유 | dry_run_summary.census (blocked 4,575) |
| 공개가 있는 상품 | 2,116건 / 문의가 2,370건 / 품절·판매완료 87건 | readiness_summary.by_price_state |
| 공급처 판매상태 | 판매중 26 · 재고미관리 2,491 · 품절(판매중지) 1,700 · 미확인 271 · 판매완료 87 | readiness_summary.by_supplier_status |
| 중복 후보 쌍 | 1,353쌍(관련 상품 2,018건) — 등록 전 정리 필요 | readiness_summary.duplicates |
| 옵션 보유 품목 | 587품목(4,233행) — 옵션가 미확정 1,054행 | readiness_summary.options |

### 등록 가능 판정을 막는 필드별 차단(전 상품 공통 · 상품별)

| 필드 | 차단 건수 | 해제 주체 | 비고 |
|---|---|---|---|
| `leafCategoryId` | 4,575 | 운영자 카테고리 확정 | 라이브 코퍼스 5,003 leaves는 확보됨(2026-10-29) — pilot 3건과 같은 방식의 경로별 확정 작업 필요 |
| `detailContent` | 4,575 | 콘텐츠 저작 | 준비파일 값은 한 줄 요약이라 본문 불인정(detail_content_summary_only) |
| `stockQuantity` | 4,575 | ERP 재고 실조회 | `GetListInventoryBalanceStatus → BAL_QTY` 읽기 필요(공급처 표시 수량은 근거 아님) |
| `images.representative` | 4,575 | 이미지 업로드 API | 전 건 외부 호스트 링크 — 업로드 API 통과분만 허용. 권장 해상도 충족 3,894 / 미달 680, 추가이미지 9장 초과 2,561 |
| `salePrice` | 2,459 | 공급처·운영자 | 공개가 없는 문의가 상품(2,370) + 불신 숫자 1 |

**즉시 확대 등록 가능한 상품 수: 0건.** 파일럿 3건의 스키마 결함(원산지 코드·택배사 코드·고시·수입사·images·전자배송 유형)은 모두 해결돼 재사용 가능하지만, 나머지 4,572건은 위 5개 필드의 운영 확정이 선행된다.

## 2. 이미 해결돼 재사용 가능한 것(파일럿에서 검증됨)

- 등록 본문 스키마(v2): vendor 원산지 상세코드(0201005/0204000 라이브 조회), 택배사 코드표(KGB 등), 상품정보제공고시(라이브 상품군 API 36종), 수입사, images(representativeImage/optionalImages), 전자배송 DIRECT — 2026-10-29 실등록 3/3 성공으로 검증
- 이미지 업로드: `runPilotImageUpload`(배치 10장, MIME 수정·응답 파서 계약 반영, ledger 부분 채택 금지)
- 중복 차단: `searchBySellerCodeBody` 판매자코드 검색(등록 직전 재조회 계약)
- 재시도: `ncommerce-auth` retry policy(429 GW.RATE_LIMIT/5xx 지수백오프·jitter, maxAttempts 4)
- 장부: `ncom_registration_ledger.json` + `mergeRegistrationLedger`(상품별 등록·전시 기록)

## 3. 대량등록 파이프라인 설계(준비 완료 항목)

1. **자동 분리**: `registration-readiness`/`registration-dry-run` 레인이 상품별 차단 사유를 선언된 어휘로 분류 — "등록 가능"과 "필수정보 부족"의 자동 분리는 이미 구현돼 있고 4,575건 전 건 분류 완료.
2. **중복 생성 차단**: (a) 등록 직전 판매자코드 검색(라이브), (b) 실행 장부의 originProductNo 조인, (c) 중복 후보 1,353쌍 사전 정리(duplicate_action_pending 2,018건은 운영 검토 대기).
3. **가격·재고 변경 감지**: `backend/lib/change-detect.mjs` — SYNC_RELEVANT_FIELDS 해시로 변경분만 재전송 선정(기존 구현).
4. **호출 제한·재시도**: API별 초당 동시 제한 → `ncommerce-auth` 백오프 정책 + GNCP-GW-RateLimit 헤더 관측. 이미지 업로드는 배치 10장 단위.
5. **상품별 장부**: 등록(`cgi-ncom-registration`), 전시(`display_status*` 필드), 이후 수정·실패·재시도도 동일 장부에 확장 기록(이번 전시 활성화에서 확장 패턴 확립).
6. **판매 종료·재고 0·가격 변경 동기화**: 판매종료=origin `statusType` SUSPENSION/CLOSE(change-status), 재고 0=등록 규정상 자동 OUTOFSTOCK + `option-stock` PUT, 가격 변경=`productModifyOrigin`/`productModifyChannel`(전체 리소스 PUT 계약 — 이번 전시 활성화에서 실측).

## 4. 대량등록 실행 전 남은 선행 작업(운영 결정 필요)

1. 카테고리 매핑: 공급처 카테고리 228종 → 네이버 리프(코퍼스 5,003) 대응표 확정
2. 상세본문 저작: 4,575건(템플릿 + 공급처 실측 요약 기반, 운영자 승인)
3. ERP 재고 실조회: BAL_QTY 읽기(등록 가능 재고 확정)
4. 이미지 일괄 업로드: 4,575건(권장 미달 680건 처리 방향 결정)
5. 가격 확정: 문의가 2,370건 — CGI 판매가 결정
6. 중복 쌍 1,353쌍 정리(병합/별게 등록 결정)
7. 검색색인 반영 확인 후 파일럿 3건 소비자 화면 검증(로그인 세션 필요 — 아래 REMAINING)

## 5. 파일럿 3건 상태(참고)

- 등록: 13776583531/13776583540/13776583545 — 전시 **ON** 전환 완료(2026-10-29), 판매 SALE, 가격·재고 불변 확인
- 소비자 화면: 내장 브라우저가 스마트스토어 전반에서 WAF 차단(기존 대형 스토어도 동일) — 로그인 세션 확립 후 재검증 필요
