# CGI 통합 상품 마스터 스키마

> 이슈 #8 — `[P1][DATA] CGI 상품 마스터 스키마·양 사이트 중복/브랜드/가격 정규화 설계`
>
> 이 문서의 모든 수치는 **ZCode 내장 브라우저(IAB)로 실제 렌더된 화면**에서
> 확인한 값이며, 브라우저 확인값과 HTTP 수집값의 교차 검증
> (`reports/data/crosscheck_report.json`, 29/29 일치) 으로 뒷받침된다.
> 스키마 버전 `1.0.0`.

---

## 1. 대상 사이트와 실측 차이

두 상점은 서로 다른 Cafe24 상점이며 **같은 필드명을 서로 다른 의미로** 쓴다.

| 항목 | samasound.co.kr (삼아사운드) | samamusic.co.kr (삼아스토어) |
|---|---|---|
| 사업 모델 | B2B | B2C |
| ` cate_no` namespace | `samasound.cate_no` | `samamusic.cate_no` |
| 수집 호스트 | `www.samasound.co.kr` | `www.samamusic.co.kr` |
| canonical 호스트 | `samasound.co.kr` | **`samastore.co.kr`** (수집 호스트와 다름) |
| 상세 URL | `/product/{slug}/{product_no}/category/{c}/display/{d}/` | `/product/detail.html?product_no={N}&cate_no={M}&display_group={G}` |
| 목록 URL | `/product/list.html?cate_no={N}&page={P}` | 동일 |
| 공개 판매가 | **없음** — `판매가` 행에 "가격 문의" 문자열 | **있음** — 실제 금액 |
| `브랜드` 스펙행 | **없음** | 있음 (`SHURE`) |
| `제조사` 스펙행 | 있음 (`Shure`, `PreSonus`, `IK MULTIMEDIA`, `HK Audio`) | **없음** |
| `모델명` 스펙행 | **없음** (`영문상품명` 만 일부 존재) | 있음 (`SM58K-LC`, `KSM32C/HM`) |
| `적합인증번호` 스펙행 | 없음 | 있음 (`R-R-SHU-SLXD4DE`) |
| 옵션 | 표본 15건 전부 **빈 옵션 영역** | 있음 (`길이선택`, `주파수대역`, 품절·추가금 표기) |
| 이미지 호스트 | `www.samasound.co.kr` | `samastore.co.kr` |

### 1.1 `cate_no` 충돌 실증 — 섞으면 안 되는 이유

브라우저로 두 사이트의 카테고리 번호를 직접 열어 확인했다.

| `cate_no` | samasound | samamusic |
|---|---|---|
| 24 | 브랜드별 보기 (상위 보기 모드) | 브랜드 |
| 25 | 제품분류별 보기 | 이어폰/헤드폰 |
| 42 | **Shure** (브랜드) | **스피커** (제품 분류) |
| 23 | 전체보기 | (브랜드 하위) |
| 84 | (제품 분류) | 마이크 |
| 671 | (없음) | SHURE (브랜드) |
| 352 | PRESONUS | (없음) |
| 662 | (없음) | PRESONUS |

즉 `cate_no=42` 는 두 사이트에서 **완전히 다른 카테고리**를 가리킨다.
카테고리 번호는 반드시 `namespace` 와 함께 다룬다.

브라우저로 확인한 samasound 브랜드 → `cate_no` 매핑은 총 **49개**
(알파벳 그룹 6개: A-C `320`, D-G `332`, H-K `338`, L-O `344`, P-R `351`, S-Z `364`).
samamusic 는 브랜드가 30개 이상이며 ` cate_no` 가 3자리(424 이상)로 별도 값공간을 쓴다.

---

## 2. 레코드 스키마

JSON Schema: [`schemas/product-master-record.schema.json`](../schemas/product-master-record.schema.json)

### 2.1 필수 컬럼 (이슈 #8 요구사항 1)

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `source_site` | string enum | `samasound` \| `samamusic` |
| `source_product_id` | string | 사이트 스코프 상품 번호 (`samasound` 의 `product_no`, `samamusic` 의 `product_no`) |
| `canonical_url` | string | 페이지 `link[rel=canonical]`. **호스트가 수집 호스트와 다를 수 있음** (`samastore.co.kr`) |
| `name` | string | 화면의 `상품명` |
| `brand` | string \| null | `브랜드` 스펙행 값. 해당 행이 없으면 `null` |
| `manufacturer` | string \| null | `제조사` 스펙행 값. 해당 행이 없으면 `null` |
| `model` | string \| null | `모델명` 스펙행 값. 해당 행이 없으면 `null` |
| `category_path` | string[] | 확인된 카테고리 경로 이름. 미확인 시 `[]` |
| `specs` | object | 원본 스펙행 전체 (원문 보존) |
| `image_urls` | string[] | 상품 이미지 URL |
| `public_price` | integer \| null | **공개된** 판매가. 공개 금액이 없으면 `null` |
| `dealer_price` | null | 공개 근거 없음 → 항상 `null` |
| `availability` | null | 공개 근거 없음 → 항상 `null` |
| `extraction_time` | string (ISO-8601) | 수집 시각 (UTC). 상품 갱신일이 아니다 — 사이트가 상품별 갱신일을 공개하지 않는다 |
| `source_evidence` | object | 근거 (관찰 URL, 페이지 제목, 관찰된 스펙행 원문) |
| `verification_status` | string enum | `browser_verified` \| `http_verified` \| `browser_http_crossverified` \| `unverified` |

### 2.2 추가 컬럼

| 컬럼 | 설명 |
|---|---|
| `source_key` | 복합키 `(source_site, source_product_id)` 문자열 표현 (`samasound:3875`) |
| `collection_url` | 실제 수집에 사용한 URL (canonical 과 다를 수 있음) |
| `public_price_text` | 화면에 표시된 가격 원문 (`279,000원` / `가격 문의`) |
| `price_type` | `public_selling_price` \| `inquiry` \| `unknown` |
| `category_namespace` | `samasound.cate_no` \| `samamusic.cate_no` |
| `category_path_cate_no` | 경로 각 단계의 `cate_no` (사이트 namespace 기준) |
| `category_leaf_cate_no` | 말단 `cate_no` |
| `options` | 옵션 목록 (`label`, `text`, `values[]` — `price_delta`, `soldout`) |
| `extraction_method` | `browser_zcode_iab` \| `http_urllib` |
| `derived` | **파생** 매칭 키. 원천 필드가 아님 (§4) |
| `naver_product_id` | 네이버 상품 ID. 스토어 개설 전 `null` |
| `erp_item_code` | ERP 품목 코드. 아직 `null` |
| `smartstore_category_no` | 스마트스토어 카테고리 번호. 아직 `null` |
| `mapping_ready` | 스토어/ERP 매핑 준비 여부. 현재 전건 `false` |
| `quality_flags` | 품질/주의 표식 목록 |
| `dedupe_group_id` | 중복 그룹 ID (§4) |
| `dedupe_confidence` | `confirmed` 등 판정 결과 |

### 2.3 제조사 / 브랜드 / 모델 분리 (요구사항 2)

세 필드는 **서로 다른 출처**를 가진다. 같은 값이 나와도 출처 필드는 유지한다.

| | samasound | samamusic |
|---|---|---|
| 브랜드 | `브랜드` 행 없음 → **`brand` = null** | `브랜드` 행 → `brand` |
| 제조사 | `제조사` 행 → `manufacturer` | `제조사` 행 없음 → **`manufacturer` = null** |
| 모델 | `모델명` 행 없음 → **`model` = null** | `모델명` 행 → `model` |

브라우저로 확인한 실측 예:

* `Fender Studio Pro` (samasound 3733) — `제조사 = PreSonus`.
  상품명 속 "Fender" 는 **브랜드/제품라인**이고 `제조사` 는 **PreSonus** 다.
  상품명 파싱으로 `brand` 를 만들면 원본과 어긋난다.
* `SLXD4D+` (samasound 3738) — `영문상품명 = SLXD4D+` 가 있어도 `모델명` 행은
  없으므로 `model` 은 `null` 로 두고, `영문상품명` 은 `specs` 안에 **원본 증거로만**
  보존한다. (`SITE_FIELD_AVAILABILITY['samasound']['model'] = False`)

### 2.4 사이트별 필드 가용성 매트릭스

`tools/product_master/schema.py` 의 `SITE_FIELD_AVAILABILITY` 에 코드화되어 있고,
`validate_policy()` 가 이를 강제한다. 사이트에 없는 행에 값이 들어 있으면 **검증 실패**다.

---

## 3. 가격 정책 (요구사항 4)

| 상황 | `public_price` | `price_type` | 근거 |
|---|---|---|---|
| samamusic 공개 판매가 | 정수(원) | `public_selling_price` | `판매가` 행의 실제 금액 |
| samamusic "대리점 문의" | `null` | `inquiry` | 목록 `<li data-price="^대리점 문의">` |
| samasound 전량 | `null` | `inquiry` | `판매가` 행 = "가격 문의" |
| 도매가 | `null` | — | 공개 근거 없음 |
| 재고/가용성 | `null` | — | 공개 근거 없음 |

* 공개 판매가와 도매가는 **혼합하지 않는다** (`dealer_price` 는 항상 `null`).
* "가격 문의" 문자열에서 숫자를 만들어내지 않는다.
* `price_type='inquiry'` 인데 숫자가 붙거나, 숫자가 있는데 `price_type` 이
  `public_selling_price` 가 아니면 검증 실패다.

---

## 4. 정규화 및 중복 판정 알고리즘 (요구사항 3)

### 4.1 파생 매칭 키 (`derived`)

원천 `model` 필드와 **분리**한다. samasound 에는 `모델명` 행이 없으므로
`model` 은 `null` 로 두고, 매칭 전용 파생값을 `derived` 아래에만 기록한다.

```
derived.model_phrases        후보 모델 표현 목록
derived.model_phrase_compact 비교용 정규화 표현 (영숫자만, 대문자)
derived.variant_signature    변형 구분용 한국어 토큰 집합
```

`model_phrase_compact` 정규화 예:

| 원문 | compact |
|---|---|
| `WL185MB/C-TQG` | `WL185MBCTQG` |
| `MVX2U G2` | `MVX2UG2` |
| `MVX2UG2 (2세대)` | `MVX2UG22` |
| `SLXD1+` | `SLXD1` |
| `SM35-XLR` | `SM35XLR` |

모델 표현 추출 규칙 (`normalize.extract_model_phrase`):

1. `brand` 가 이름 앞에 있으면 제거한다.
2. `brand` 가 없으면 이름 맨 앞의 **숫자를 포함하지 않는 대문자 토큰**을
   브랜드 표기로 보고 제거한다. (samasound 이름에 박힌 `SHURE` 등.
   `MVX2U G2` 의 `MVX2U` 는 숫자가 있어 제거하지 않는다.)
3. 남은 구간에서 **영문자와 숫자를 모두** 포함하는 연속 구간 중 가장 긴 것을
   대표 모델 표현으로 삼는다.
4. 구간 뒤에 한글이 이어붙는 흔한 오염을 제거한다.
   * `MVX2UG2 2세대` → `MVX2UG2`
   * `MV88 USB-C C타입` → `MV88 USB-C`

### 4.2 변형(variant) 서명

상품명에서 한국어 토큰을 뽑고 일반어를 제외한다
(`슈어`, `세트`, `용`, `포함`, `패키지` …).

```
SHURE KSM32C 슈어 스튜디오 콘덴서 마이크 라이트 세트    → {스튜디오, 콘덴서, 마이크, 라이트}
SHURE KSM32C 슈어 스튜디오 콘덴서 마이크 프리미엄 세트  → {스튜디오, 콘덴서, 마이크, 프리미엄}
```

### 4.3 판정 규칙

| 조건 | 판정 | 자동 병합 |
|---|---|---|
| 공통 모델 표현 없음 | `no_candidate` | ✗ |
| 변형 서명 충돌 | `candidate` | ✗ |
| 양쪽 `모델명` 스펙행 값이 서로 다름 | `candidate` | ✗ |
| 공통 표현이 **양 사이트에서 각각 단일 상품** | `confirmed` | ✓ |
| 공통 표현이 모호하나 변형 서명이 일치하고 이름 유사도 ≥ 0.5 | `confirmed` | ✓ |
| 공통 표현이 모호하나 변형 구분 근거 부족 | `probable` | ✗ |
| 이름 유사도 ≥ 0.8 이지만 모델 표현 불일치 | `probable` | ✗ |

**`confirmed` 만** 중복 그룹을 만든다. `probable` / `candidate` 는 사람이
확인하도록 리포트에만 남긴다. (요구사항 3 — "확신 부족한 중복은 자동 병합 금지")

### 4.4 같은 사이트 안의 중복

복합키 `(source_site, source_product_id)` 가 유일해야 한다. 위반은
`same_site_duplicate` 로 표면화하며 데이터 오류로 취급한다.

---

## 5. 양 사이트 동일 제품 비교표 (브라우저 실측)

11쌍이 `confirmed` 로 판정되었다. 표의 모든 값은 브라우저로 실제 확인한 것이며
`reports/data/product_master_sample.csv` 에 원본이 있다.

| # | samasound 상품명 | samamusic 상품명 | samasound id | samamusic id | samasound 가격 | samamusic 가격 | samasound brand/제조사 | samamusic brand/제조사 | samasound model | samamusic model |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | WL185MB/C-TQG | SHURE WL185MB/C-TQG 무선용 단일 지향성 핀마이크 블랙 | 3875 | 5557 | 가격 문의 | 279,000원 | – / Shure | SHURE / – | – | WL185MB/C-TQG |
| 2 | SM35-XLR | SHURE 헤드셋 단일지향성 컨덴서 마이크, 윈드스크린 (XLR 커넥터) SM35-XLR | 3874 | 5564 | 가격 문의 | 391,000원 | – / Shure | SHURE / – | – | SM35-XLR |
| 3 | SM35-TQG | SHURE 헤드셋 단일지향성 컨덴서 마이크, 윈드스크린 및 TA4F 커넥터 포함 SM35-TQG | 3873 | 5563 | 가격 문의 | 234,000원 | – / Shure | SHURE / – | – | SM35-TQG |
| 4 | SM31FH-TQG | SHURE 헤드셋 단일지향성 컨덴서 마이크, TA4F 커넥터 포함 SM31FH-TQG | 3872 | 5562 | 가격 문의 | 234,000원 | – / Shure | SHURE / – | – | SM31FH-TQG |
| 5 | SHURE KSM32C 슈어 스튜디오 콘덴서 마이크 라이트 세트 | 동일 | 3825 | 5490 | 가격 문의 | 1,370,000원 | – / Shure | SHURE / – | – | KSM32C/HM |
| 6 | SHURE KSM32C 슈어 스튜디오 콘덴서 마이크 프리미엄 세트 | 동일 | 3824 | 5491 | 가격 문의 | 1,510,000원 | – / Shure | SHURE / – | – | KSM32C/SM |
| 7 | SHURE KSM40C 슈어 프리미엄 스튜디오 콘덴서 마이크 | 동일 | 3823 | 5492 | 가격 문의 | 1,830,000원 | – / Shure | SHURE / – | – | KSM40C |
| 8 | SHURE KSM44MP 슈어 플래그쉽 스튜디오 콘덴서 마이크 | 동일 | 3822 | 5493 | 가격 문의 | 2,280,000원 | – / Shure | SHURE / – | – | KSM44MP |
| 9 | SLXD4D+ | SHURE SLXD4D+ 듀얼채널 다이버시티 수신기 | 3738 | 5525 | 가격 문의 | 2,300,000원 | – / Shure | SHURE / – | – | – |
| 10 | SLXD1+ | SHURE SLXD1+ 바디팩 송신기 | 3735 | 5513 | 가격 문의 | 640,000원 | – / Shure | SHURE / – | – | – |
| 11 | MVX2U G2 | SHURE MVX2UG2 2세대 슈어 XLR to USB-C 오디오 인터페이스 (모바일 지원) | 3863 | 5611 | 가격 문의 | 237,000원 | – / Shure | SHURE / – | – | MVX2UG2 (2세대) |

### 5.1 자동 병합하지 않은 2쌍 (negative case)

| samasound | samamusic | 판정 | 사유 |
|---|---|---|---|
| KSM32C … 라이트 세트 (3825) | KSM32C … 프리미엄 세트 (5491) | `candidate` | 변형 서명 충돌 — 같은 모델의 다른 세트 구성 |
| KSM32C … 프리미엄 세트 (3824) | KSM32C … 라이트 세트 (5490) | `candidate` | 동일 사유 |

`모델명` 스펙행만 보면 둘 다 `KSM32C` 로 시작하므로 모델 일치만으로는
구분이 안 된다. **변형 서명** 이 이 두 건을 붙잡는다.

### 5.2 함께 수집했지만 매칭되지 않은 공개 샘플 (negative case)

| 상품 | 판정 | 사유 |
|---|---|---|
| samasound `WL93` (3868) ↔ samamusic `GLXD14R+/93 … WL93 포함` (4344) | `no_candidate` | samamusic 상품은 WL93 을 **포함**하는 세트일 뿐 WL93 자체가 아니다. 모델 표현이 정확히 일치하지 않는다 |
| samasound `SLXD4+` (3737) ↔ samamusic `SLXD4D+` (5525) | `no_candidate` | 접두 관계(`SLXD4` ⊂ `SLXD4D`)일 뿐 다른 모델 |
| samasound `Fender Studio Pro` (3733) | — | samamusic 동일 모델은 5313. 이번 표본에는 미포함 |
| samasound `TONEX PEDAL Bass Edition` (3714) | — | 모델 표현 추출 불가(숫자 없는 이름) → 자동 후보 생성 안 됨 |

---

## 6. 구현

```
tools/product_master/
├── __init__.py
├── normalize.py      가격/텍스트/모델/변형 정규화
├── schema.py         필드 정의, JSON Schema, CSV/JSON 입출력
├── build_records.py  원시 덤프 → 마스터 레코드 (null 정책 강제)
├── dedupe.py         교차 사이트 후보 탐지, 자동 병합 그룹
├── validate.py       구조 검증 + 정책 검증
├── collect_http.py   HTTP 수집기 (robots.txt 준수, UA, politeness 지연)
├── crosscheck.py     브라우저 ↔ HTTP 교차 검증
├── cli.py            명령줄 진입점
└── tests/            단위 테스트 59개
```

### 6.1 실행

```bash
# 브라우저 덤프 → 마스터 샘플
python -m tools.product_master.cli build-sample \
  --dump reports/data/_browser_dump_samasound.json \
  --dump reports/data/_browser_dump_samamusic.json \
  --out-json reports/data/product_master_sample.json \
  --out-csv  reports/data/product_master_sample.csv

# 구조 + 정책 검증
python -m tools.product_master.cli validate --records reports/data/product_master_sample.json

# 중복 후보 + 그룹
python -m tools.product_master.cli dedupe --records reports/data/product_master_sample.json \
  --json-out reports/data/dedupe_report.json

# HTTP 로 같은 URL 재수집 (반복 수집 경로)
python -m tools.product_master.cli collect \
  --from-dump reports/data/_browser_dump_samasound.json \
  --from-dump reports/data/_browser_dump_samamusic.json \
  --out reports/data/_http_dump.json --delay 1.2

# 브라우저 ↔ HTTP 교차 검증
python -m tools.product_master.cli crosscheck \
  --browser reports/data/product_master_sample.json \
  --http    reports/data/http_collected_sample.json \
  --json-out reports/data/crosscheck_report.json

# JSON Schema 생성
python -m tools.product_master.cli schema --out schemas/product-master-record.schema.json

# 단위 테스트
python -m unittest discover -t . -s tools/product_master/tests -v
```

### 6.2 재현 결과 (2026-10-22)

| 항목 | 결과 |
|---|---|
| `validate` | `records=29 unique_keys=29 structural_errors=0 policy_errors=0` → **PASS** |
| `dedupe` | `candidates=13` (confirmed 11, candidate 2), 자동 병합 그룹 **11** |
| `crosscheck` | `records=29 matched=29 mismatched=0 rate=1.0` → **PASS** |
| `unittest` | `Ran 59 tests — OK` |

### 6.3 HTTP 수집 시 주의 (브라우저와 HTTP 공통 함정)

* `python-requests/2.34.2` UA 는 **403**, 브라우저/curl UA 는 **200**.
  UA 를 그대로 두면 "사이트가 죽었다" 고 오판한다. (직접 실측 확인)
* `robots.txt` 는 `/product/*` 를 금지하지 않는다. 금지 경로(`/api`,
  `/exec/front/`, `/member/`, `/myshop/`, `/protected/`, `/skin-*/`,
  게시판 쓰기 경로 등)는 방문하지 않는다.
* `samamusic` 상세 `product_no=5523` 은 실제로 **404** 다. 브라우저에서도
  상품명이 없어 제외된다. 존재하지 않는 id 를 넣으면 "수집 실패" 가 아니라
  "그 id 는 존재하지 않음" 으로 처리해야 한다.

---

## 7. 향후 스토어/ERP 매핑 경계 (요구사항 5)

* `naver_product_id`, `erp_item_code`, `smartstore_category_no` 는
  **전건 `null`**, `mapping_ready` 는 전건 `false`.
  스마트스토어 개설 전이므로 네이버 상품 등록·ERP 변경은 하지 않는다.
* 매핑 시에도 `cate_no` 는 사이트 namespace 를 유지한 채 매핑해야 한다.
  두 사이트의 `cate_no` 를 같은 정수 공간으로 합치면 안 된다.
* `source_evidence` 와 `quality_flags` 를 그대로 보존하면, 추후 어느 경로의
  어떤 원문에서 값이 나왔는지 역추적할 수 있다.

---

## 8. 산출물

| 파일 | 내용 |
|---|---|
| `docs/CGI_PRODUCT_MASTER_SCHEMA.md` | 이 문서 |
| `docs/CGI_BROWSER_VERIFICATION_REPORT.md` | 브라우저 실측 증거·비교표 |
| `schemas/product-master-record.schema.json` | JSON Schema (draft 2020-12) |
| `tools/product_master/` | 정규화·검증·수집·중복판정 도구 + 테스트 |
| `reports/data/product_master_sample.json` / `.csv` | 브라우저 검증 공개 샘플 29건 |
| `reports/data/http_collected_sample.json` / `.csv` | HTTP 수집 동일 29건 |
| `reports/data/crosscheck_report.json` | 브라우저 ↔ HTTP 교차 검증 결과 |
| `reports/data/dedupe_report.json` | 중복 후보 13건 + 그룹 11건 |
| `reports/data/_browser_dump_*.json` | 브라우저 원시 덤프 (원문 증거) |
| `.zcode/skills/cgi-product-browser-verify/SKILL.md` | 재사용 가능한 브라우저 절차 스킬 |
