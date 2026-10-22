# CGI 상품 카탈로그 사이트

공급처 공개 수집 데이터로 동작하는 **정적** 상품 카탈로그입니다. 빌드 스텝·프레임워크 의존성이 없습니다.

> 자세한 설계·운영·매핑 문서: [`docs/CGI_CATALOG_SITE.md`](../docs/CGI_CATALOG_SITE.md)
> 검증 기록: [`docs/CGI_CATALOG_SITE_TESTLOG.md`](../docs/CGI_CATALOG_SITE_TESTLOG.md)

## 실행

```bash
# 정적 서버 (권장)
python -m http.server 8848 --directory site
# → http://127.0.0.1:8848/index.html

# 또는 site/index.html 을 브라우저로 직접 열기
# (데이터가 data/products.js 에 내장되어 있어 file:// 에서도 동작)
```

## 화면

| 경로 | 내용 |
|---|---|
| `index.html` | 메인(검색·요약·브랜드/카테고리 칩·최근 상품) |
| `index.html#/products?q=&brand=&cat=&site=&sort=&page=` | 상품 목록(필터·정렬·페이지네이션) |
| `index.html#/product/<id>` | 상품 상세(갤러리·스펙·옵션·원본 출처) |
| `index.html#/about` | 안내(수량 원칙·데이터 교체·스토어 연계 상태) |
| `product.html?id=<id>` | 외부 링크용 상세 진입 래퍼 |

## 데이터 교체

```bash
# 전체 카탈로그(수집 결과 JSON/CSV)가 준비되면 재생성
python tools/build_catalog_data.py --master-csv <상품마스터.csv> --out-dir site/data

# 리빌드 없이 다른 JSON 파일을 바로 사용
index.html?data=data/products.json
```

데이터 스키마와 규칙은 `docs/CGI_CATALOG_SITE.md` §3 참고.

## 브라우저 검증

```bash
cd tools && npm i && cd ..
node tools/verify_catalog_site.mjs      # 17개 항목 검증 + 스크린샷
```

## 주의

- 표시되는 상품은 **공개 수집 샘플**이며 CGI 판매 가능 수량이 아닙니다.
- 공급처에 공개된 판매가만 표시하고, 미공개는 추정 없이 `가격 문의`로 표기합니다.
- 이미지는 공급처 공개 URL을 참조합니다(자체 보관 정책 미정).
- 삼아스토어·삼아사운드의 상표·화면을 복제하지 않았으며 공식 사이트가 아닙니다.
