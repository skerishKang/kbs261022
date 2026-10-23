# CGI 나라장터 입찰 분석 프로토타입 (LOCAL 3, 우선순위 2)

> 신규 범위 (기존 구현 검색 결과 중복 개발 없음).

## 1. 기존 구현 검색 결과

- 저장소 내 나라장터/입찰 관련 구현 없음 (G2B/Bid/procurement 검색 0건, G2B 모델명만 우연 일치).
- 따라서 신규 이슈로 관리 권장.

## 2. 데이터 수집 경로

- 공공데이터포털 조달청 나라장터 입찰공고정보서비스 (15129394) — REST, JSON/XML, 무료, 자동승인.
- 조달청 나라장터 낙찰정보서비스 (15129397) — 개찰결과/낙찰/예비가격.
- 엔드포인트: `BidPublicInfoService04` (입찰공고), `ScsbidInfoService` (낙찰/개찰), `CntrctInfoService` (계약).
- 인증: data.go.kr 일반 인증키 (Decoding). 개발계정 1,000건/일.
- 기간 조회는 보통 1개월 이내. 전체 투찰자 명단은 공식 API가 1순위만 제공하므로 나라장터 내부 엔드포인트 재현이 필요(비공식, 깨질 수 있음).

## 3. 프로토타입

- `tools/procurement/g2b_bid_analysis.py`: JSON/CSV 입력 → 기초금액 대비 투찰률(%) 계산 + 카테고리/상태별 기술통계.
- `data/procurement/sample_bids.json`: 4건 샘플 (낙찰 3, 유찰 1).
- 선택적 라이브 조회: `G2B_API_KEY` 환경변수 설정 시 data.go.kr 호출, 미설정 시 샘플 폴백.
- `--input` 으로 사용자 데이터 분석 가능.

## 4. CGI 사업 적용 가능성

- CGI는 음향/조명/영상 장비 공급사. 나라장터에서 음향·영상·무대장치·방송장비 용역/물품 공고에 참여 가능.
- 본 프로토타입은 과거 투찰률 분포를 기술적으로 요약할 뿐, 낙찰 확률을 보장하지 않음.
- 추가 필요 데이터: 업종/지역 필터, 예비가격 상세, 경쟁사 이력, 과거 낙찰률, 원가/간접비, 인증 요건, 지역 제한, 면허.

## 5. 검증

- `python tools/procurement/g2b_bid_analysis.py` → 4건 분석
- `python -m unittest tools.procurement.tests.test_procurement` → 7 OK
- 라이브 조회: API 키 미설정 시 폴백 (테스트 확인)
