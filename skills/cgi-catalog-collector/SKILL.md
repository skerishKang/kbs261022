---
name: cgi-catalog-collector
description: >-
  김범신(CGI) 공급처 공개 쇼핑몰 사이트의 상품 카탈로그를 읽기 전용으로 수집해
  통합 상품 마스터 CSV로 정규화하는 스킬. Tri-A(삼아사운드 https://www.samasound.co.kr/,
  canonical https://samasound.co.kr) 와 Tri-B(삼아스토어 https://www.samamusic.co.kr/,
  canonical https://samastore.co.kr) 두 카페24(Cafe24) 기반 스토어를 지원한다.
  사용 시점: "공급처 사이트 수집", "상품 마스터 CSV", "삼아사운드/삼아스토어 카탈로그",
  "브랜드·카테고리·옵션·가격 구조 분석", "스마트스토어/iCount 연계용 상품 마스터 스키마".
  공개 GET 페이지만 사용하며 로그인·장바구니·주문·ERP/네이버 쓰기 API는 호출하지 않는다.
  가격·공급가·재고는 공개 표기만 기록하고 절대 추정하지 않는다.
---

# CGI 공급처 카탈로그 수집 스킬

두 공급처 스토어의 **공개 페이지만** 읽어 통합 상품 마스터 CSV를 만든다.
이 스킬은 모델 B가 tria/samamusic 탐색에서 검증한 수집 경로만 사용한다.

## 1. 대상 사이트

| 키 | 서비스 | 접속 호스트 | canonical 호스트 | 플랫폼 |
|---|---|---|---|---|
| `samasound` | Tri-A / 삼아사운드 | `https://www.samasound.co.kr` | `https://samasound.co.kr` | Cafe24 |
| `samamusic` | Tri-B / 삼아스토어 | `https://www.samamusic.co.kr` | `https://samastore.co.kr` | Cafe24 |

두 사이트는 **같은 회사의 서로 다른 서비스**다.

- Tri-A = 제품 정보/카탈로그 사이트. **판매가가 전부 "가격 문의"**로만 공개되고, 옵션·재고·공급가 정보가 없다.
- Tri-B = 온라인 판매 스토어. 판매가·정가(소비자가)·옵션 추가금액·품절 표기가 공개된다.

따라서 **두 사이트를 1개 테이블에 섞어 하나의 상품으로 취급하면 안 된다.**
통합 상품 마스터는 `source_site` 로 원천을 구분하되, 동일 상품 후보는 `cross_site_candidate_of` 로 연결한다.

## 2. 수집 경로 (공개 GET)

### 2.1 Tri-A (samasound)

| 목적 | URL | 근거 |
|---|---|---|
| 카테고리 목록 | `GET /product/list.html?cate_no={id}&page={n}` | 20건/페이지, `class="last"` 에 마지막 페이지 |
| 전체 등록상품 수 | 같은 URL 의 `등록 제품 : <strong>N</strong>` (HTML 주석 안에 렌더) | cate 23 → 2229 |
| 카테고리 계층 | 같은 URL 의 `xans-product-headcategory path` 블록 (`/category/{name}/{id}/`) | 4단계까지 노출 |
| 상품 상세 | `GET /product/detail.html?product_no={id}` | **cate_no 없이** 호출해야 상품의 진짜 카테고리 경로가 나온다 |
| canonical | `<link rel="canonical">` → `https://samasound.co.kr/product/{slug}/{id}/` | 브라우저 검증 완료 |
| 기본 정보 | `xans-product-detaildesign` 표 (상품명/상품요약정보/제조사/원산지/판매가) | 제조사 = 브랜드 |
| 가격 | `var product_price` (0 이면 "가격 문의"), `var _iPrdtPriceOrg`, `var _iPrdtPriceTax` | |
| 재고/품절 | `var single_option_stock_data` (JSON), `var is_soldout_icon` | `use_stock=false` 이면 재고 미관리 |
| 옵션 | `<select product_option_area="product_option_*">`, `var add_option_data` | 샘플 80건 기준 메인 옵션 0건 |
| 이미지 | `img.BigImage`, `ul.listImg img.ThumbImage`, `data-src` | `/web/product/{size}/{YYYYMM}/{hash}.{ext}` |

### 2.2 Tri-B (samamusic)

| 목적 | URL | 근거 |
|---|---|---|
| 사이트맵 | `GET /sitemap.xml` (호스트 `samastore.co.kr`) | 2136 URL (product 1597 / category 532). **和产品实数不一致(1597 < 2294)** 이므로 단독 사용 금지 |
| 카테고리 목록 | `GET /product/list.html?cate_no={id}&page={n}` | 20건/페이지 |
| 상품 상세 | `GET /product/detail.html?product_no={id}&cate_no={cid}&display_group=1` | `cate_no` 는 **해당 상품이 실제로 속한 카테고리**를 넣어야 `setCategoryCookie` 가 정확 |
| canonical | `<link rel="canonical">` → `https://samastore.co.kr/product/{slug}/{id}/` | 브라우저 검증 완료 |
| 기본 정보 | `xans-product-detaildesign` 표 | 라벨 집합이 템플릿마다 달라 **free-form map** 으로 수집 |
| 가격 | 표의 `판매가` / `소비자가` / `최저판매가`, `class="infoArea" data-price="정가^판매가"`, `var product_price` | |
| 재고/품절 | `var single_option_stock_data`, `var is_soldout_icon`, `var aSoldoutDisplay` | |
| 옵션 | `<select option_title=...>` 3종 구분, `var add_option_data` (옵션별 `option_price`/`origin_option_added_price`/`stock_number`) | |
| 이미지 | `img#eListPrdImage*`, `ul.d_thumb img[data-src]` | `/web/product/{medium|big|small|extra}/...` |

### 2.3 카테고리 ID 발견 방법

Tri-A 는 `sitemap.xml` 이 404 다. 다음 순서로 발견한다.

1. 홈/목록 HTML 의 `/product/list.html?cate_no=N` 및 `/category/{name}/{N}/` 링크
2. **ID 스위프**: `cate_no=1..520` 을 1회씩 GET 하여 `xans-product-headcategory path` 가 있으면 유효 카테고리로 채택 (실측 361개)
3. 각 카테고리의 `child_categories` 로 하위 카테고리를 재귀적으로 추가

## 3. 실행 방법

```bash
# 스킬 스크립트
python skills/cgi-catalog-collector/scripts/collect_cgi_catalog.py \
  --site samamusic --mode sitemap  --out out/samamusic_sitemap.csv
python skills/cgi-catalog-collector/scripts/collect_cgi_catalog.py \
  --site samasound --mode list --cate-no 23 --out out/samasound_list.csv
python skills/cgi-catalog-collector/scripts/collect_cgi_catalog.py \
  --site samamusic --mode detail --ids-file ids.txt --out out/samamusic_detail.csv
python skills/cgi-catalog-collector/scripts/collect_cgi_catalog.py \
  --site samasound --mode categories --ids 23,24,25,42,343 --out out/ss_cats.csv
```

기본 지연 0.25~0.35초, 동일 URL 은 `.cache/cgi-catalog/` 에서 재사용(재실행 시 네트워크 0).

## 4. 수집 규칙 (반드시 준수)

1. **읽기 전용.** 공개 GET 만 호출한다. `/member/`, `/myshop/`, `/api/`, `/admin/`, 장바구니/주문/쿠폰 쓰기 API 는 호출하지 않는다.
2. **로봇 정책 준수.** 두 사이트 `robots.txt` 는 `/admin`, `/api`, `/exec/front/`, `/member/`, `/myshop/`, `/protected/`, `/skin-*/`, `/*board*page=`, `/*article*category_no=` 등을 Disallow 한다. 수집 대상 경로는 허용 영역이며 `?cate_no=N&page=M` 은 Disallow 패턴(`/*page_4=`)에 걸리지 않는다.
3. **값 추정 금지.**
   - 가격: 공개된 표기만. "가격 문의"/"판매 완료"/"판매 불료"는 숫자 대신 **상태 토큰**(`published_price_state`)으로 남긴다.
   - 공급가(`dealer_price`): 두 사이트 모두 공개 데이터가 없다. 항상 빈 값.
   - 재고: `stock_number` 는 페이지가 공개한 값을 그대로 옮기고, `use_stock=false` 이면 "미관리"로 기록한다. 추정하지 않는다.
4. **판매/인증 미수행.** 로그인·세션 생성·상품 게시·ERP 쓰기 없음. Google Drive 업로드 없음.
5. **증거 보존.** 모든 행에 `source_evidence`(원본 URL)와 `extraction_method`, `verification_status` 를 남긴다.

## 5. 산출물

- `reports/samples/product_master_sample.csv` — 검증된 20건 샘플 (Tri-A 10 / Tri-B 10), 전체 컬럼
- `reports/samples/category_catalog_sample.csv` — 양 사이트 카테고리 계층 샘플
- `skills/cgi-catalog-collector/schema/product-master.schema.json` — 컬럼 정의 + 미확인 규칙

## 6. 검증 절차 (샘플마다)

1. `requests` 로 HTML GET → 파서 실행
2. 같은 URL 을 브라우저(Playwright/Chrome DevTools)로 열어 DOM 렌더 결과와 대조:
   - 기본 정보 표의 `th`/`td` 값
   - `#span_product_price_text` 판매가
   - `<link rel="canonical">`
   - 옵션 `<select>` 의 `option_title` / 값 (추가금액·[품절] 포함)
3. 불일치가 있으면 파서를 고친 뒤 재실행.

## 7. 알려진 제약

- Tri-B 상세 페이지에 **브레드크럼이 없다.** `source_category_path` 는 목록 크롤 결과와 조인해야 한다.
- Tri-B **목록 페이지의 하위 카테고리 링크는 전 페이지 공통 스니펫**이어서 부모-자식 관계를 신뢰성 있게 복원할 수 없다. 확인 가능한 계층은 최상위 11 루트 + 브랜드 144 + 리프 이름 532까지이며, 그 외는 미확정으로 둔다.
- Tri-B 옵션 값의 추가금액/`[품절]` 표기는 **JS 렌더링 후**에만 보인다. 하지만 `var add_option_data` JSON 에 동일 정보가 있으므로 **요청기 파싱만으로 브라우저와 동일 결과**를 얻는다(실측 확인).
- Tri-B `sitemap.xml` 은 최신 상품 전체를 담지 않는다(1597 vs 실측 2294). **카테고리 목록 크롤이 기준**이다.
- Tri-A 는 `제조사` 만 있고 `모델명` 필드가 없다. 모델번호는 **상품명에서 추출**해야 한다(실측 60.5%가 모델코드형 이름). 규칙으로 확정되지 않으면 `model` 은 빈 값.
- Tri-A `전체보기`(2229)와 카테고리 전수(2281)는 52건 차이가 있다. Café24 관리 설정 접근 없이 원인은 확정 불가.
