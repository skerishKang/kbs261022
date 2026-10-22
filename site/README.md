# CGI 상품 카탈로그 (CGI Catalog)

Issue [#11](https://github.com/skerishKang/kbs261022/issues/11) — CGI 자체 상품 카탈로그 HTML 사이트.

> **미개설 안내** — 이 사이트는 주문·결제 사이트가 아닙니다.
> 표시 가격은 **원본 공개 페이지의 참고용 공개가**이며 CGI 판매가가 아닙니다.
> 공급가·재고·판매가는 미확정이며 **추정 금액을 표시하지 않습니다**.
> 네이버 스마트스토어 개설 후 실제 주문·결제 기능을 제공할 예정입니다.

## 무엇을 했는가

삼아스토어(samamusic.co.kr) / 삼아사운드(samasound.co.kr) 웹사이트를 **실제 브라우저로 분석**해 확인한
구조·동작을 재사용한 정적 HTML/CSS/JS 카탈로그 사이트입니다.

- 상단 카테고리 LNB (원본 11종 구조, 모바일 접기)
- 검색 폼 (GET + `q` 파라미터)
- 상품 그리드 (데스크톱 4열 / 모바일 2열, 정사각형 이미지)
- 브랜드 필터, 정렬, 페이지네이션 (첫/이전/숫자/다음/마지막)
- 상세 = 갤러리(썸네일↔메인) + 기본정보 표 + 옵션 + 탭(상세/옵션/출처·검증/스마트스토어 매핑)
- 모바일 반응형 (원본과 동일하게 LNB·사이드 메뉴를 접고 2열로 전환)

## 실행 방법

`file://` 로 열어도 인라인 데이터(`data/catalog.demo.js`) 때문에 바로 동작합니다.

```bash
# 방법 1) 그냥 열기
open site/index.html          # macOS
start site\index.html         # Windows

# 방법 2) 로컬 HTTP 서버 (권장, JSON 로더 경로까지 확인 가능)
python -m http.server 8808 --directory site
# → http://127.0.0.1:8808/index.html
```

배포는 정적 호스팅(Netlify/Vercel/GitHub Pages 등) 또는 사내 웹서버에 `site/` 폴더만 올리면 됩니다.
**실주소 배포는 도메인·호스팅 권한 확인 후 별도 진행** (Issue #11 §5).

## 데이터 교체 (전체 카탈로그 반영 방법)

현재 `site/data/catalog.demo.json` 은 **공개 샘플(PR #6 + PR #12)** 로 만든 시연 데이터입니다.
전체 수집 결과(상품 마스터)로 교체하려면:

1. `site/tools/build_demo_catalog.py` 로 CSV → JSON 변환
   ```bash
   python site/tools/build_demo_catalog.py \
     --sample-csv reports/data/samasound-samamusic-sample.csv \
     --master-csv reports/samples/product_master_sample.csv \
     --out-json site/data/catalog.full.json \
     --out-js   site/data/catalog.full.js
   ```
2. `index.html` / `product.html` 의 `<script src="data/catalog.demo.js">` 를 `catalog.full.js` 로 변경
   (JSON 만 쓰려면 `CGICatalog.load({ jsonUrls: [...] })` 의 순서로 `catalog.full.json` 이 먼저 옵니다)

데이터 계약(필드 정의·값 어휘·매핑 규칙)은 `site/data/catalog.schema.json` 을 참고하세요.
로더는 `site/assets/data-loader.js` 의 `CGICatalog.load()` 한 곳만 고치면 다른 부분은 영향받지 않습니다.

## 파일 구성

| 경로 | 내용 |
|---|---|
| `site/index.html` | 상품 목록 (그리드·검색·필터·정렬·페이지네이션) |
| `site/product.html` | 상품 상세 (갤러리·옵션·제원·탭·출처) |
| `site/assets/style.css` | 스타일 (CGI 고유 색상/아이덴티티) |
| `site/assets/data-loader.js` | 데이터 로더 + 정규화 + 가격 상태 어휘 |
| `site/assets/app.js` | 목록 렌더링·필터·검색·페이지네이션 |
| `site/assets/product.js` | 상세 렌더링·갤러리·옵션·탭 |
| `site/data/catalog.demo.json` | 시연 데이터(공개 샘플 37건) |
| `site/data/catalog.demo.js` | 같은 데이터의 인라인 배포본(file:// 용) |
| `site/data/catalog.schema.json` | 데이터 계약 + 스마트스토어 매핑 규칙 |
| `site/tools/build_demo_catalog.py` | CSV → 카탈로그 JSON 생성기 |
| `site/docs/screenshots/` | 데스크톱/모바일 실제 동작 캡처 |

## 반드시 지켜야 할 표시 규칙

| 항목 | 규칙 |
|---|---|
| 가격 | `published_price_state=public` 일 때만 숫자 표시, 그 외에는 `가격 문의`/`가격 정보 없음` |
| 공급가·재고·판매가 | 미확정이면 **null** 로 두고 추정 금액을 표시하지 않음 |
| 수집 vs 승인 | 카드의 `CGI 승인 전` 배지로 구분. `CGI 승인 상품만` 필터는 `cgi_sale_status=approved` 만 표시 |
| 출처 | 카드·상세 모두 원본 사이트와 원본 상품 페이지 링크를 표기 |
| 주문·결제 | 장바구니/주문 버튼은 비활성 상태로 두고 미개설 안내를 노출 |

## 브랜드 고유성

본 사이트는 **CGI 자체 브랜드**입니다. 삼아스토어·삼아사운드의 상표·로고·화면·색상을 복제하지 않으며,
외부 로고 이미지 파일을 사용하지 않습니다(워드마크는 CSS 로만 구성).
수집한 상품 이미지는 원본 출처 이미지이므로 출처를 함께 표기합니다.

## 검증

`site/docs/screenshots/` 에 실제 브라우저(Tabbit Chromium, BrowserSkill) 실행 캡처가 있다.
검증 항목과 결과는 저장소 `reports/cgi-catalog-work-report.md` 를 참고하세요.
