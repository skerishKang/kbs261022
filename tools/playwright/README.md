# tools/playwright — 삼아스토어 Playwright 탐색 도구

`samastore.co.kr` / `samamusic.co.kr` (CAFE24 Indi `_wg` G2G 스킨) 쇼핑몰을 **실제 브라우저로**
탐색·추출·검증하기 위한 재실행 가능한 스크립트 모음이다.

이 디렉터리는 **기존 수집 프로그램을 수정하지 않는다.** 기존 HTTP 수집기는 건드리지 않고,
브라우저 관점의 교차검증과 추가 필드 확보만 담당한다.

---

## 1. 준비

```bash
cd tools/playwright
npm install                      # playwright + sharp
npx playwright install chromium  # 브라우저 바이너리 (최초 1회)
```

- 기본은 **헤드리스**(`SAMASTORE_HEADLESS=1`)로 CI/재현성 확보.
- 실제 창을 보며 확인하려면 `SAMASTORE_HEADLESS` 를 unset 하고 실행하면 headed 모드로 뜬다.
- 작업 폴더: `tools/playwright/` (node_modules 는 gitignore 대상).

---

## 2. 실행 순서 (전체 파이프라인)

```bash
cd tools/playwright

# 0) 파서 단위 테스트 (네트워크 없이 실행, 항상 먼저 돌린다)
node test-extractors.js

# 1) 도메인 대조 + 카테고리 메뉴 + 검색 + 상세 20건 + 옵션 + CSV
node explore.js --products 20 --search "shure" \
                --edge "1710,3687,1139,5162,4103,1502,3184"

# 2) 공개 JSON API / sitemap ↔ 브라우저 교차검증
node compare-api-browser.js --sample 40

# 3) 이미지 응답, 두 도메인 동일성, SSR HTML vs 렌더 DOM 최종 검증
node verify-final.js

# 3b) 삼아사운드(B2B) 교차 대조 — 가격 공개 여부를 직접 재확인
node crosscheck-samasound.js

# 3c) 옵션 스코프(본인 옵션 vs 크로스셀 옵션) 증명
node verify-option-scope.js

# 3d) 검색 네트워크 캡처 (공개 JSON 엔드포인트 확인) + 검색 결과 속성 결함 증명
node capture-search-network.js
node verify-search-price.js

# 4) 증거 정리 (스크린샷 선별 + 압축, JSON 통합, 보고서 표 재생성)
node collect-screenshots.js
node consolidate.js
node regen-sample-table.js
```

### CLI 옵션

| 스크립트 | 옵션 | 기본값 | 설명 |
|---|---|---|---|
| `explore.js` | `--products N` | 20 | 상세페이지 수집 건수 |
| | `--search TERM` | (없음) | 상점 검색 실행 keyword |
| | `--edge id,id,…` | (없음) | API 플래그 기반 edge case 상품 id |
| | `--out PATH` | `reports/data/samastore-playwright-sample.csv` | CSV 출력 경로 |
| | `--domain-only` | off | 도메인 대조만 수행 |
| `compare-api-browser.js` | `--sample N` | 20 | API↔브라우저 행 단위 대조 건수 |
| | `--out PATH` | `reports/data/api-browser-parity.csv` | CSV 출력 경로 |

환경변수

| 이름 | 의미 |
|---|---|
| `SAMASTORE_HEADLESS=1` | headed 대신 헤드리스 실행 |

---

## 3. 파일 구성

| 파일 | 역할 |
|---|---|
| `lib/browser.js` | 브라우저 부팅, 재시도(`withRetry`), 증거 로그(`logEvidence`), 스크린샷 경로 |
| `lib/extractors.js` | **페이지 컨텍스트에서 실행되는** DOM 추출 함수 + 순수 파싱 헬퍼 |
| `explore.js` | 메인 파이프라인 (도메인→카테고리→검색→상세→옵션→CSV) |
| `compare-api-browser.js` | 공개 Dalue JSON API ↔ sitemap ↔ 브라우저 3자 교차검증 |
| `verify-final.js` | 이미지 HTTP 응답, 두 도메인 상품 동일성, SSR HTML vs 렌더 DOM |
| `verify-search.js` | 검색 3건(정상 2 + 무결과 1) 실측, "검색결과 없음" 메시지 토글 확인 |
| `verify-search-price.js` | 검색 결과 카드의 정적 속성 오염(`data-price` 전부 `^1,050,000`) 증명 |
| `verify-option-scope.js` | 옵션 스코프 증명 — `product_option_id*`(본인) vs `addproduct_option_id_*`(크로스셀) |
| `capture-search-network.js` | 상점이 실제로 호출하는 공개 JSON 엔드포인트(`/dcse/query`) 네트워크 캡처 |
| `crosscheck-samasound.js` | 삼아사운드(B2B) 가격 공개 여부 교차 대조 |
| `collect-screenshots.js` | 스크린샷 선별 + JPEG 압축 → `reports/screenshots/` |
| `consolidate.js` | 모든 증거를 `reports/evidence/consolidated.json` 으로 통합 |
| `regen-sample-table.js` | 보고서의 20건 표본 표를 원본 JSON 에서 자동 재생성 (드리프트 방지) |
| `test-extractors.js` | 파서 단위 테스트 (36 assertion) |
| `create-pr.js` / `update-pr.js` | git credential manager 가 보유한 자격증명으로 GitHub API 호출 (새 자격증명 없음) |
| `verify-pr.js` | PR 메타데이터·변경 파일·병합 가능 상태 확인 |
| `check-branch-conflicts.js` | 저장소의 다른 모든 브랜치에 이 브랜치를 병합해 충돌 여부 실측 |

---

## 4. 수집 파이프라인 단계

```
1. connect   실제 Chromium 실행, ko-KR / Asia-Seoul / 1440x1000
2. domain    samamusic.co.kr vs samastore.co.kr vs samasound.co.kr 5개 URL 실측
3. category  #category-lnb 11개 링크 추출 → 카테고리별 목록 페이지 전수 순회
4. search    상점 검색창에 keyword 입력 후 Enter → 결과 카드/URL 기록
5. detail    상품 상세페이지 20건 (엣지케이스 → SSR 결함 → 카테고리 라운드로빈 순)
6. options   본인 옵션 그룹의 모든 옵션을 선택해 옵션별 실제가격/품절 확인
7. extract   기본정보 표 · JSON-LD · 이미지 · 품절 · 옵션 → 평탄화
8. csv       reports/data/samastore-playwright-sample.csv (UTF-8 BOM, Excel 호환)
9. evidence  screenshots + reports/evidence/*.json + *.jsonl (오류/재시도 기록)
```

---

## 5. 안전장치

- **구매·주문·결제 없음.** 코드는 `select` 값 변경과 링크 이동만 수행한다.
  `explore.js` 종료 시 `assertNoPurchaseClicked()` 가 위반 0건을 확인하고,
  위반이 있으면 비정상 종료한다.
- **로그인 없음.** 계정·세션·쿠키 주입 없음. API 키는 쇼핑몰이 자기 페이지에 공개한 값이다.
- **요청 예절.** 요청 사이 0.4~0.8초 대기, 병렬화 없음, 재시도 3회(지수 백오프).
- **증거 보존.** 실패 시 스택 트레이스 + 시도 횟수가 `reports/evidence/*.jsonl` 에 남는다.

---

## 6. 알려진 사이트 결함 (도구가 우회하는 지점)

| 결함 | 증상 | 도구의 대응 |
|---|---|---|
| 목록 카드 SSR 결함 | 카드 텍스트에 `{$productName}` `{$pcDiscountPrice}` 가 그대로 렌더 | `placeholder_in_rendered_card` 로 검출하고 `sample_reason=list_placeholder_defect` 로 표본 편입 |
| 품절 배지 템플릿 잔재 | `class="icon_img soldout_{$productNo}"` — 실제 id 와 매칭 불가 | `alt="품절"` + **computed visibility** 로 판정 |
| 옵션 가격 미반영 | 옵션 선택 시 화면 가격(`#span_product_price_text`)은 변하지 않음 | 숨김 input `input.option_box_price` 를 실제 주문가로 사용 |
| 크로스셀 옵션 혼입 | `addproduct_option_id_<pid>_*` 는 **다른 상품**의 옵션 | `scope=own` / `scope=cross_sell` 로 분리 |
| 판매가 비수치 | `가격 문의` / `가격문의` / `판매완료` / `판매 완료` | `classifyPrice()` → `kind=inquiry|sale_closed`, 숫자 미기재 |
