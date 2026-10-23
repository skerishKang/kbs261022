# Yamaha Pro Audio 상품 DB 검증 보고서

## 1. 수집 개요

- 수집일: 2026-10-23
- 출처:
  - Global: https://usa.yamaha.com/products/proaudio/
  - Korea: https://kr.yamaha.com/ko/business/audio/products/
- 수집 방식: HTTP 요청 + BeautifulSoup HTML 파싱 (robots.txt 준수, UA 명시)
- 브랜드: Yamaha (Yamaha Corporation)

## 2. 수집 건수

| 구분 | 건수 |
|---|---:|
| Global 레코드 | 303 |
| Korea 레코드 | 370 |
| 합계 | 673 |
| 고유 모델 (Global) | 303 |
| 고유 모델 (Korea) | 370 |
| 교차 모델 수 | 247 |

## 3. 카테고리별 집계

Global:

| 카테고리 | 건수 |
|---|---:|
| Speakers | 151 |
| Mixers | 51 |
| Audio and Network Interfaces and YGDAI Cards | 28 |
| Power Amplifiers | 28 |
| Processors | 21 |
| Network Switches | 17 |
| Accessories | 10 |
| Professional Audio Software | 10 |
| DAW Systems | 9 |
| PA Systems | 8 |
| Headphones | 5 |
| Live Streaming | 5 |
| CD Players | 1 |

Korea:

| 카테고리 | 건수 |
|---|---:|
| Speakers | 225 |
| Audio and Network Interfaces and YGDAI Cards | 48 |
| Processors | 51 |
| Mixers | 60 |
| Power Amplifiers | 28 |
| Network Switches | 12 |
| PA Systems | 20 |
| Microphones | 34 |
| Custom Installation | 25 |
| Professional Audio Software | 9 |
| Headphones | 2 |
| Video Collaboration Systems | 10 |

## 4. 검증 결과

- 모델 번호 중복 검사: 동일 source_site 내 중복 0건
- 대표 제품 공식 상세페이지 교차검증: 50개 URL 샘플 100% 200 OK
- 이미지 링크: 전체 673건 이미지 URL 보유 (0건 누락)
- 출처 확인: 모든 레코드에 canonical_url, source_evidence, extraction_time 포함
- 엑셀 파일 직접 재열기: openpyxl 로드 성공 (시트 3개)

## 5. 가격/재고 정책

- Yamaha 공식 사이트에는 공개 판매가격이 표시되지 않으므로 `public_price = null`, `price_type = unknown`
- CGI 실제 공급가, 대리점 계약가격, 재고/판매 권한은 공개 정보만으로 확정하지 않음
- `dealer_price`, `availability`, `naver_product_id`, `erp_item_code`, `smartstore_category_no` = null (매핑 미완료)

## 6. 산출물

- `data/yamaha/yamaha_product_db.xlsx`
- `data/yamaha/yamaha_products.csv`
- `data/yamaha/yamaha_products.json`
- `data/yamaha/yamaha_category_summary.csv`
- `data/yamaha/yamaha_to_cgi_product_master_mapping.csv`
- `data/yamaha/shop_demo_products.json`

## 7. 남은 작업

- CGI 상품 DB와의 모델 매핑 자동화 (공급가/재고는 별도 계약 정보 필요)
- 한국/글로벌 모델명 통합 뷰 (247개 교차 모델)
- NEXO 브랜드 제품은 이번 범위에서 제외 (Yamaha 본사 라인업 우선)
PY