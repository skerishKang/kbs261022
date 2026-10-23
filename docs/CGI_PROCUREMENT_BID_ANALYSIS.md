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

## 6. 수집 중단 복구 및 Playwright 수집기 (2026-10-23)

### 6.1 중단 원인 (근본)
- 이전 세션의 `tools/debug7.js`는 `http://127.0.0.1:8899/staff.html`에서 `window.CGI_PRODUCTS`만 기다렸다.
- `window.CGI_PRODUCTS`는 `site/data/products.js`에 정의된 **CGI 쇼핑몰 상품 카탈로그**(samasound/samamusic)로, 나라장터 조달 데이터가 아니다.
- `staff.html`에서 해당 전역이 채워지지 않아 `waitForFunction: Timeout`, `PLEN 0`, `IDS []`가 발생했고, 이후 무료 모델 사용량 제한(`Too Many Requests`)로 멈췄다.
- 결론: 디버그 스크립트는 조달 사이트가 아니라 **LOCAL 2 쇼핑몰 직원/견적 페이지**를 겨냥한 것으로 본 작업과 무관. 쇼핑몰·견적 코드는 수정하지 않았다(충돌 방지).

### 6.2 정상 수집 경로
- `tools/procurement/g2b_notice_collector.js` (Playwright). 고정 전역 대신 실제 공고행(공식 공고번호 `R..K..-..` 또는 g2b 공고 상세 링크)을 유한 대기·추출한다.
- 단계별 상태 기록, 메인 응답 HTTP 상태, 최종 도착 URL, JavaScript 오류, 네트워크 postback(JSON/XML) + DOM 그리드 양방향 추출, 무한 대기 방지, 실패 시 최소 진단 저장.
- 이미 열린 브라우저 재사용: `--cdp <endpoint>` / `--ws <endpoint>`, 또는 영구 프로파일 `--profile <dir>`.
- 추출 결과는 본 파일의 `normalize()` 스키마(`bid_no,title,agency,region,category,notice_date,close_date,detail_url,…`)로 출력 → 기존 중복제거·정합성·CSV/XLSX 내보내기를 그대로 재사용.

### 6.3 실행 및 검증
- 자체 검증: `node tools/procurement/g2b_notice_collector.js --selftest` → 실제 공고행 형태 픽스처 3건 추출 PASS(헤더·달력 노이즈 제외).
- 라이브 정찰: `https://www.g2b.go.kr/`는 `sso.g2b.go.kr` OIDC 리다이렉트 + WebSquare 브라우저 게이팅(`processMsg.html`)으로 **무인증 헤드리스에서는 실제 공고 격자가 렌더링되지 않는다** → genuine 0건. 달력 위젯 숫자는 공고번호로 오인식하지 않도록 패턴을 좁혀 제외. 근거: `reports/data/procurement/collector_diagnostics.json`.
- **위조 금지**: 인증 세션이 없으면 실제 공고수를 0으로 정직하게 기록하며 샘플을 실제 수집분으로 위장하지 않는다.
- 실데이터 확보 방법: (a) 로그인된 브라우저를 `--cdp`로 연결하거나 (b) `--profile`에 나라장터 세션을 보관해 재사용하거나 (c) `G2B_API_KEY`로 data.go.kr OpenAPI 경로 사용.
- 회귀: `python -m unittest discover -s tools/procurement/tests` → 15 OK. 수집기 출력(0건)을 `--input`으로 넣어 파이프라인 정상 종료 확인.
