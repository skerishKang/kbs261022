# CGI 상품 카탈로그 사이트 (이슈 #11)

> 담당: CGI 프런트엔드·브라우저 검증 에이전트 (CGI-1 / OpenCode)
> 저장소: `skerishKang/kbs261022` · 브랜치 `feature/issue-11-catalog-site`
> 최종 갱신: 2026-10-22

## 1. 범위와 원칙

| 항목 | 내용 |
|---|---|
| 목적 | 공급처 공개 수집 데이터로 **실제로 동작하는** 상품 카탈로그 웹사이트를 만들어 대표·고객이 브라우저로 볼 수 있게 한다 |
| 1차 설계 원칙 | 기존 삼아스토어(https://www.samamusic.co.kr/)의 메뉴·목록·검색·상세·모바일 구성 참고. CGI 고유 상표·화면은 2차 개발 |
| 데이터 원칙 | **공개 수집 샘플만 사용.** 허위 상품·가격·재고 생성 금지. 미공개 가격은 추정하지 않고 `가격 문의` 표기 |
| 수량 표기 원칙 | 공급처 카탈로그 규모(삼아사운드 2,229건·삼아스토어 1,969건)와 **CGI 판매 가능 수량을 구분**해 표기 |
| 제외 범위 | 실사이트 임의 수정(개편 업체 작업 중), 스마트스토어 실제 개설·상품 게시, 주문·결제, 이카운트 ERP 변경, 대량 수집 |

## 2. 실행 방법

```bash
# 1) 정적 서버 기동 (권장)
python -m http.server 8848 --directory site
# → http://127.0.0.1:8848/index.html

# 2) 파일로 직접 열기 (data/products.js 내장 데이터라 file:// 에서도 동작)
#   site/index.html 을 브라우저로 열면 됨
```

배포는 정적 호스팅이면 된다. 빌드 스텝·프레임워크 의존성이 없다.

| 경로 | 용도 |
|---|---|
| `site/index.html` | SPA 진입점. 해시 라우팅 `#/` `#/products?...` `#/product/<id>` `#/about` |
| `site/product.html?id=<id>` | 외부(기존 홈페이지) 연결용 상세 진입 래퍼 → `index.html#/product/<id>` 로 전환 |
| `site/data/products.js` | 내장 데이터(`window.CGI_PRODUCTS` / `window.CGI_PRODUCT_META`) |
| `site/data/products.json` | 같은 데이터의 JSON 원본(로더가 직접 읽을 수 있음) |
| `site/assets/css/cgi-catalog.css` | 스타일 (1920 / 1440 / 820 / 390 대응) |
| `site/assets/js/cgi-catalog.js` | 데이터 로더·필터·검색·정렬·페이지네이션·갤러리 |
| `tools/build_catalog_data.py` | 원시 수집 데이터 → 사이트 데이터 정규화 빌더 |
| `tools/verify_catalog_site.mjs` | Playwright 기반 브라우저 검증(17개 항목) + 스크린샷 |

## 3. 데이터 계층

### 3.1 사용한 공개 샘플(출처)

| 원본 | 내용 |
|---|---|
| PR #13 `feature/issue-5-site-analysis-model-a` → `reports/sample-products.json` | Model A 수집 샘플 21건 (JSON) |
| PR #12 `feature/site-analysis-model-b` → `reports/samples/product_master_sample.csv` | 상품 마스터 스키마 샘플 20건 (CSV, 37컬럼) |
| PR #12 `feature/site-analysis-model-b` → `reports/samples/category_catalog_sample.csv` | 카테고리 카탈로그 57행(카테고리 ID·명·등록 건수) |

위 파일은 `site/data/_source_*` 로 함께 보관했다(재현 가능). 최신본으로 바꾸려면:

```bash
git show origin/feature/issue-5-site-analysis-model-a:reports/sample-products.json > site/data/_source_sample-products.json
git show origin/feature/site-analysis-model-b:reports/samples/product_master_sample.csv > site/data/_source_product_master_sample.csv
git show origin/feature/site-analysis-model-b:reports/samples/category_catalog_sample.csv > site/data/_source_category_catalog.csv
```

> 수집기·수집 프로그램은 다른 모델 담당 범위이므로 수정하지 않았다. 본 작업은 **소비(표시) 측**만 다룬다.

### 3.2 정규화된 상품 스키마

```jsonc
{
  "id": "samamusic.co.kr:4167",          // 공급처별 유일 ID (site:product_no)
  "name": "…", "brand": "PRESONUS", "brand_norm": "PRESONUS",
  "manufacturer": "PRESONUS", "model": "Eris 3.5 GEN2 White",
  "category_path": ["스피커", "PRESONUS", …],
  "category": { "id": "42", "name": "스피커", "path": "…", "registered_count": 0, "list_url": "…" },
  "price": { "value": 219000, "text": "219,000원", "state": "public" },  // state: public | inquiry | unknown
  "availability": "InStock",
  "images": ["https://…/big/…jpg", "https://…/extra/…jpg"],
  "specs": [{ "label": "브랜드", "value": "PRESONUS" }],
  "options": [{ "name": "1m", "price": 440000, "price_text": "440,000원", "availability": "InStock" }],
  "source": {
    "site": "samamusic.co.kr", "site_label": "삼아스토어", "product_id": "4167",
    "url": "https://www.samamusic.co.kr/product/detail.html?product_no=4167&cate_no=42&display_group=1",
    "list_url": "…", "extraction_method": "http-ssr+json-ld+dalue-api",
    "verification_status": "verified-by-http-fetch", "updated_at": "2026-10-22T02:45:06Z"
  }
}
```

빌드 스크립트가 하는 정규화:

- 공급처 사이트 키 통일(`samasound` ↔ `samasound.co.kr`)
- 사이트 이름이 브랜드 칸에 들어온 행(삼아스토어/삼아사운드) 제외
- 브랜드 표기 통일(대소문자·공백 정규화, `Shure`/`SHURE` → `SHURE`)
- 상대 이미지 경로 → 공급처 절대 URL (로컬 서버에서 404 나던 문제 해결)
- 가격 문자열 → 숫자 + `public|inquiry|unknown` 상태
- 스펙/옵션/카테고리 구조화, 카테고리 ID로 `category_catalog_sample.csv` 와 조인(공급처 등록 건수)

### 3.3 전체 카탈로그로 교체하는 방법

1. 수집 결과가 JSON/CSV 로 준비되면 빌드한다.

   ```bash
   python tools/build_catalog_data.py \
     --master-csv  <전체 상품 마스터 CSV> \
     --sample-json <전체 샘플 JSON(optional)> \
     --categories  <카테고리 카탈로그 CSV> \
     --out-dir     site/data
   ```

   → `site/data/products.json` 과 `site/data/products.js` 가 재생성된다.

2. 데이터 파일만 갈아끼우려면 (리빌드 없이) URL 파라미터로 다른 JSON 을 지정할 수 있다.

   ```
   index.html?data=data/products.json
   index.html?data=https://example.com/catalog/products.json
   ```

3. 페이지 단위(12개)·필터·정렬은 데이터 크기와 무관하게 동작한다. 수만 건이어도 동일 코드.

## 4. 구현 기능

| 화면 | 기능 |
|---|---|
| 메인 | CGI 상품 카탈로그 제목, 상단 검색창, 표시 상품 수·브랜드 수·공개 판매가 건수·공급처 카탈로그 규모 요약 카드, 브랜드 칩, 카테고리 칩, 최근 수집 상품 8개 |
| 상품 목록 | 브랜드/카테고리/공급처 필터(체크박스, 건수 표시), 검색어, 정렬(최신 수집순·가격 낮은순·가격 높은순·상품명순), 페이지네이션(12개/페이지), 적용된 필터 칩(1-click 해제) |
| 상품 상세 | 대표 이미지 + 추가 이미지 썸네일 갤러리, 상품명, 브랜드·제조사·모델·카테고리, 공개 판매가 또는 **가격 문의**, 기술 규격 테이블, 옵션 정보(원본에 있는 경우), 원본 상품 정보 출처(공급처·상품 ID·원본/목록 URL·수집 방법·검증 상태·수집 시각), 목록으로 돌아가기 |
| 반응형 | 데스크톱 1920/1440(4열) → 1200(3열) → 900(2열) → 820 태블릿(2열+필터 접힘) → 390 모바일(1열, 필터 토글, 고정 검색창). 가로 스크롤 없음 확인 |
| 예외 처리 | 빈 검색 결과(안내 + 필터 초기화), 깨진 이미지(대체 문구 표시), 가격 미확인 상품(가격 문의), 콘솔 JS 오류 0건 |

## 5. 참고 사이트 조사 결과(브라우저 실측, 2026-10-22)

탭비트(Chromium 자동화)로 `https://www.samamusic.co.kr/` 직접 조사.

| 참고 항목 | 삼아스토어 실측 | CGI 카탈로그 구현 |
|---|---|---|
| 상위 카테고리 | 프로모션 보기 / 브랜드 / 마이크 / 스피커 / 이어폰·헤드폰 / 레코딩·음향 / 악기·앰프 / Hi-Fi / 케이블·커넥터 / 소프트웨어 / 특가상품 | 동일 구분을 **공급처 실측 카테고리**(마이크·스피커·레코딩/음향·악기/앰프·Hi-Fi·케이블/커넥터·소프트웨어·특가상품…)로 |
| 검색 | `GET /product/search.html?keyword=` (input name=keyword) | 헤더 고정 검색창 → `#/products?q=` (상품명·모델·브랜드·카테고리·스펙 대상) |
| 목록 URL | `/product/list.html?cate_no=<id>&page=<n>&sort_method=<n>` | `#/products?brand=&cat=&site=&sort=&page=` |
| 정렬 | `sort_method` 5 신상품 / 1 상품명 / 3 낮은가격 / 4 높은가격 / 2 제조사 / 7 후기 / 8 조회수 | 최신 수집순 / 가격 낮은순 / 가격 높은순 / 상품명순 (후기·조회수는 원본에 해당 데이터가 없어 제외) |
| 목록 카드 | `li.item` + 썸네일 + 상품명 + 가격 + 위시/새창 버튼 | 카드 그리드(이미지·브랜드·상품명·모델·가격/가격문의·공급처) → 클릭 시 상세 |
| 상세 | `detail.html?product_no=&cate_no=&display_group=1`, 대표+추가 이미지, "판매가 40,000원", 스펙 목록(상품명/판매가/브랜드/모델명/상품요약/원산지/배송비/구매방법/배송주기/옵션선택) | 동일 구성 요소 + 원본 출처 박스(신규) |
| 모바일(390px) | 검색창이 기본 비노출, 카테고리 목록 동일, 배너 슬라이드 | 검색창 항상 노출(탐색 우선), 필터는 토글 버튼으로 열림, 1열 카드 |
| 상단 유틸 | 슈어스토어 / 삼아사운드 / 자료실 / 로그인 / MY / 장바구니 / 관심상품 / 주문조회 / 적립금 / 좋아요 / 쿠폰관리 | 1차 범위 제외(홈/전체상품/안내). 장바구니·주문은 스마트스토어 개설 후 단계 |

## 6. CGI 기존 홈페이지 연결 방법

개편 업체 작업 중인 실사이트를 건드리지 않고 **연결 준비만** 하는 방식.

1. **배포 위치 결정(협의 필요)**: 카탈로그는 정적 파일이므로 기존 도메인 하위 경로(`/catalog/`)에 그대로 올릴 수 있다.

   ```
   https://<cgi-homepage-domain>/catalog/index.html
   https://<cgi-homepage-domain>/catalog/product.html?id=4167
   ```

2. **기존 홈페이지에서 넣을 코드(버튼/메뉴 1개)** — 복사해서 붙이면 된다.

   ```html
   <a class="cgi-catalog-entry" href="/catalog/index.html">
     상품 카탈로그 보기
   </a>
   ```

   ```css
   .cgi-catalog-entry{
     display:inline-block;padding:10px 18px;border-radius:8px;
     background:#1f3a93;color:#fff;font-weight:700;text-decoration:none;
   }
   .cgi-catalog-entry:hover{background:#16296b}
   @media (max-width:639px){ .cgi-catalog-entry{width:100%;text-align:center} }
   ```

   > 메뉴는 기존 홈페이지 개편 담당(업체)에게 전달할 "연결 경로·문구·크기"만 제공하고, 실사이트 수정은 하지 않는다.

3. **상품별 딥링크**: 공급처 원본 URL 대신 CGI 카탈로그 상세를 가리키게 하려면
   `product.html?id=<id>`(id 형식 `samamusic.co.kr:4167`)를 사용한다.

4. **연결 확인 체크리스트**: 링크 클릭 → 카탈로그 진입 → 검색/필터/상세 동작 → 모바일(390px)에서 동일 기능 → 원본 출처 링크가 새 탭으로 열림.

## 7. 네이버 스마트스토어 등록 자료 매핑 구조(준비)

아직 개설 전이므로 **실제 등록·게시·ERP 변경은 하지 않는다.** 아래는 데이터가 이미 갖춰져 있어 그대로 매핑 가능한 구조이다.

| 스마트스토어 항목 | 카탈로그 데이터 | 상태 |
|---|---|---|
| 상품명 | `name` | 준비됨 (공급처 표기 그대로) |
| 제조사/브랜드 | `brand`, `brand_norm`, `manufacturer` | 준비됨 (대소문자 정규화) |
| 모델명 | `model` | 준비됨 (원본에 있을 때만) |
| 카테고리 | `category.name` + `category.id`(공급처 cate_no) | 준비됨. **네이버 표준 카테고리 ID 매핑표는 별도 필요(미작성)** |
| 판매가 | `price.value`(공급처 공개 판매가) | 준비됨. **CGI 판매가 승인·검토 절차는 미완료(본 문서 범위 밖)** |
| 상세 설명 | `specs[]` | 준비됨 |
| 옵션 | `options[]` | 준비됨 (원본에 옵션이 있는 상품만) |
| 이미지 | `images[]` | 준비됨. **공급처 URL 열 링크 → 정식 등록 시 자체 서버에 보관 필요(정책 미확정)** |
| 재고 | `availability`(원본 수집값) | 수집값만 보유. **실시간 재고 아님 → 표기 금지 권장** |
| 공급가/도매가 | 미수집 | **미확인(추정 금지)** |
| 원본 근거 | `source.*` | 준비됨 (검증 시 추적성 확보) |

## 8. 브라우저 검증

```bash
npm i --no-audit --no-fund playwright-core     # 브라우저는 ms-playwright 의 chromium 사용
python -m http.server 8848 --directory site   # 별도 터미널
node tools/verify_catalog_site.mjs            # 17개 항목 검증 + 스크린샷 저장
```

결과: **17개 항목 전부 PASS**(2026-10-22, 상세는 `docs/CGI_CATALOG_SITE_TESTLOG.md`).
스크린샷: `docs/screenshots/issue-11/` (데스크톱 1440 / 모바일 390 / 태블릿 820).

## 9. 미해결·후속

| 항목 | 상태 | 필요한 조치 |
|---|---|---|
| 전체 상품 카탈로그(수천 건) 표시 | 미착수 | 수집 완료본을 `tools/build_catalog_data.py` 에 넣어 재생성 |
| 네이버 표준 카테고리 ID 매핑 | 미착수 | 네이버 카테고리 기준표 확보 후 `category` 확장 |
| 이미지 자체 보관(호스팅) | 미착수 | 정책 결정 필요(현재 공급처 URL 참조) |
| CGI 판매가 승인 절차 | 미착수 | 대표 승인 후 `price` 구분(공급처 공개가 / CGI 판매가) |
| 실사이트 배포 | 미착수 | 도메인·경로 협의 후 정적 호스팅 |
| 스마트스토어 실제 등록 | 수행하지 않음 | 개설 후 별도 이슈 |
