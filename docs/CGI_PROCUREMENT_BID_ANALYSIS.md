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

## 7. 실데이터 384건 분석 결과 (2026-10-23, LOCAL 3 복구)

### 7.1 분석 범위와 원본 보존

- 입력 원본: `data/procurement/g2b_real_bids.json` — 공고번호 기준 384건(중복 공고번호 0). 게시일 2026-09-27 ~ 2026-10-23.
- 기존 `classify_cgi` 필터 결과 356건은 `legacy_356_analysis.json`에 별도 보존했다. 원본 384건은 삭제·덮어쓰기하지 않았다.
- 상세 확인: G2B 상세 API로 337건 확인, 47건은 `해당되는 데이터가 없습니다`(HTTP 422)로 **품목·자격·금액을 확인할 수 없음** → `detail_status=unavailable`, 원문 확인 대상으로만 표시.
- 금액: 추정가격 331건 확인(그중 3건은 API가 1원으로 반환한 placeholder), 6건 미제공, 47건 상세 미제공.
- 공고 원문 URL: 수집된 `detail_url`은 G2B 검색 URL 형식이며 상세 화면을 직접 열지 못해 `detail_url_verified=false`로 기록했다. 원문 확인은 공고번호(`bid_no`)로 G2B 통합검색에서 수행한다.

### 7.2 분류 기준

- **A (직접 연관)**: 제목에 음향·AV·방송 장비 구매/설치 신호가 있고, 확인된 품목분류가 음향/AV와 일치하며, 임차·운영·유지보수·공사(관급자재·직접구매자재 제외)·특수방송 조건이 없는 건.
- **B (검토 필요)**: 음향·AV·방송 분야이나 임차/운영/유지보수/공사 포함/특수방송(재난·비상·경보·확성기)/무대조명/품목 불일치 등 세부 조건 확인이 필요한 건.
- **C (관련성 낮음)**: 의료영상·음향측정, 콘텐츠 제작·송출, CCTV·영상감시, 위성·항공영상, 교복, 정보시스템, 무대기계·세트·막, 공사·용역 등.
- 판정 근거는 **제목 + G2B 상세 API의 품목분류**로 한정했다. 브랜드·모델명은 제목에서 확인되지 않아 추정하지 않았다. 상세 미제공 건은 자격·금액을 추정하지 않고 `unavailable`로 남겼다.

### 7.3 분류 결과

| 구분 | 건수 | 비율 | open | closed | cancelled | unknown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A 직접 연관 | 27 | 7.03% | 6 | 11 | 2 | 8 |
| B 검토 필요 | 52 | 13.54% | 18 | 29 | 2 | 3 |
| C 관련성 낮음 | 305 | 79.43% | 161 | 101 | 14 | 29 |
| **합계** | **384** | **100%** | **185** | **141** | **18** | **40** |

- `cancelled` 18건은 입찰 종료로 보아 최종 `CLOSED_BIDS=159`(141 마감 + 18 취소)로 집계한다.
- 제목 중복: 20개 그룹 / 21건 초과. 삭제하지 않고 `duplicate_group_size`로 표시했다.
- 투찰률: 원본에 낙찰금액·투찰금액 필드가 없어 **0건 산출 / 384건 미산출**. 금액을 임의로 만들지 않았다.
- 기존 필터 356건의 구성: A 27 / B 49 / C 280. 기존 필터는 B 3건(긴급구조 연출지원, 소방방송 진단·보수 2건)을 제외하고 C 25건을 포함해, 새 독립 분류와 차이가 있다.

### 7.4 A등급 중 즉시 검토 가능한 공개 입찰 (6건)

| 공고번호 | 마감 | 추정가격(원) | 품목 근거 | 발주기관 | 공고명 |
| --- | --- | ---: | --- | --- | --- |
| R26BK01781066 | 2026-10-23 16:00 | 626,267,273 | 구내방송장치 | 조달청 / 충청북도 청주시 | 청주 다목적 실내체육관 건립사업 관급자재(경기장 음향설비) |
| R26BK01785428 | 2026-10-28 10:00 | 19,406,364 | 구내방송장치 | 울산광역시교육청 | 울산양정초 공간재구조화 리모델링 통신공사 관급자재 방송장비 구매 및 설치(계속비) |
| R26BK01787191 | 2026-11-02 18:00 | 129,000,000 | 오디오믹서,증폭기결합 | 재단법인세종문화회관 | 세종문화회관 대극장 노후 음향콘솔 교체 입찰 공고 (긴급) |
| R26BK01762398 | 2026-11-06 10:00 | 1,544,768,182 | 스피커 | 조달청 대구지방조달청 | 봉산문화회관 가온홀 음향·영상시스템 기능 보강 |
| R26BK01783174 | 2026-11-06 10:00 | 220,400,000 | 비디오프로젝터 | 조달청 광주지방조달청 | 한국 수중발굴 50주년 기념 특별전 및 상설전시실 영상장비 구축 |
| G012605603 | 2026-11-18 | 미확인 | 상세 미제공 | ICT운영처 | 아트센터 양지홀 영상·방송시스템 교체 자재 1식 |

- 마감일은 날짜 기준이다. R26BK01781066은 2026-10-23 16:00 마감으로 당일이므로 실제 시각을 원문에서 확인해야 한다.
- A등급 8건은 마감일이 `-` 또는 이상값이라 `unknown`이다: R26BK01761950, R26BK01763002, R26BK01781661, R26BK01762379, R26BK01764645, R26BK01764544, R26BK01747535, R26BK01748815. `manual_review_bids.csv` P1에 포함했다.
- A등급 13건은 마감·취소로 종료됐다(closed 11, cancelled 2). 차기 공고 모니터링 대상으로만 남긴다.

### 7.5 자격요건 요약

- A 27건: 지역제한 7건, 업종(면허)제한 9건, 실적제한 0건, 상세 미제공 5건.
- B 52건: 지역제한 17건, 업종(면허)제한 19건, 실적제한 1건, 상세 미제공 10건.
- 제한 문구는 상세 API 원문을 정리해 `bid_qualification_summary.csv`의 `region_text`, `license_text`, `performance_text`, `qualification_note`에 기록했다. 상세 미제공 건은 제한 여부를 `N`으로 단정하지 않고 공란·`unavailable`로 표시했다.

### 7.6 B등급 구성 (52건)

- 임차·운영·유지보수·용역성: 16건
- 특수 방송설비(재난·비상·경보·확성기·재방송): 15건
- 무대조명: 7건
- 품목 불일치(전자칠판·디스플레이·수신기 등): 5건
- 음향·AV·방송 인접(시설·방송실·스튜디오 등): 5건
- 공사 포함: 3건
- 방송 전용회선·전송망: 1건

### 7.7 산출물

| 파일 | 내용 |
| --- | --- |
| `reports/data/procurement/bid_analysis_report.json` | 384건 분류·상세·자격 병합 + 요약 |
| `reports/data/procurement/classification_stats.json` | A/B/C, 상태, 중복, 상세 가용성 통계 |
| `reports/data/procurement/legacy_356_analysis.json` | 기존 필터 356건 보존 뷰 |
| `reports/data/procurement/cgi_direct_bids.csv` | A 27건 |
| `reports/data/procurement/cgi_review_bids.csv` | B 52건 |
| `reports/data/procurement/cgi_related_bids.csv` | A+B 79건 |
| `reports/data/procurement/manual_review_bids.csv` | A+B 79건, priority/flags/next_action |
| `reports/data/procurement/bid_qualification_summary.csv` | 384건 자격·지역·면허·품목 요약 |
| `reports/data/procurement/bid_classification.csv` | 384건 분류 근거 |
| `reports/data/procurement/bid_analysis.csv` / `.xlsx` | 기존 분석 스키마 + 분류 필드 |
| `reports/data/procurement/g2b_detail_enrichment.json` | 상세 확인 원본(337 ok / 47 unavailable) |
| `reports/data/procurement/g2b_detail_unavailable.txt` | 상세 미제공 47건 목록 |

### 7.8 재현 및 검증

```bash
python tools/procurement/g2b_bid_analysis.py   --input data/procurement/g2b_real_bids.json   --enrichment reports/data/procurement/g2b_detail_enrichment.json   --as-of 2026-10-23
python -m unittest discover -s tools/procurement/tests -v
```

- 테스트: 49 OK (기존 분석 15 + 신규 분류/실데이터 34).
- 신규 테스트는 A/B/C 대표 케이스, 관급자재 예외, 품목 불일치, 특수방송, 공사 포함, CCTV, 의료, 무대막, 콘텐츠, 지명 오탐, lifecycle, 중복, 상세 미제공 시 무단정, 실제 384/337/47/356/20/21 카운트를 검증한다.

### 7.9 한계

- 상세 API 미제공 47건은 품목·자격·금액을 확인할 수 없다. 원문 확인 전까지 A/B 판정은 제목 근거의 후보로만 사용해야 한다.
- `detail_url`은 수집 당시 생성된 링크로 상세 직접 열림이 검증되지 않았다. 공고번호로 G2B 통합검색에서 확인한다.
- 마감일은 날짜 단위로 비교했다. 당일 마감 건은 실제 시각 확인이 필요하다.
- 분류는 결정적 키워드 규칙이며 LLM 추정이 아니다. A/B 목록은 영업 후보이고, 규격서·자격요건 확인 전에는 수주 가능성을 확정하지 않는다.
- 낙찰률·경쟁강도·브랜드/모델 일치 여부는 이번 데이터에 없어 산출하지 않았다.
