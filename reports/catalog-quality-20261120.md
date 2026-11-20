# 카탈로그 데이터 품질 정리 (2026-11-20)

배경: AI 명예회원 1회차 — "같은 상품이 두 번 나온다", "스피커 추천순 맨 위가 리퍼·박스손상". 기준 main 2fb1ea4.

## 입력(전체 원본)

- 생성 입력: `site/data/products.json` 4,546건(정규화 전체 상품). 샘플 38건 기본 입력은 쓰지 않았다.
- 전체 원본 대조: CGI-1 로컬 `C:/cgi-work/catalog-data/full/catalog_source.csv`(4,575건, 2026-10-22)를 `build_catalog_data.from_master_csv` 로 다시 정규화해 비교 — 이름·가격·모델·사진·옵션·출처는 전부 같고, 차이는 ① 상품이 아닌 결제창·잔금·계약금 29건(파이프라인에서 제외) ② 브랜드를 손으로 고친 4건(NNNN → 브랜드 미확인, #217 이전 반영)뿐. 원본에서 곧바로 다시 만들면 ②가 되돌아가므로, 이를 반영한 `products.json` 을 전체 입력으로 썼다(products.json 바이트 변화 없음).

## 1. 중복 병합(G2)

| 항목 | 전 | 후 |
|---|---:|---:|
| 전체 상품(catalog.json) | 4,026 | 4,002 |
| 가격 문의 | 1,938 | 1,914 |
| 가격 공개 | 2,088 | 2,088 |
| 병합 쌍(치환표) | 520 | 544 |

- 병합 전 원본 기준: 전체 4,546 → 4,002, 가격 문의 2,458 → 1,914.
- 1단계(모델명, 요청 규칙): 정리된 브랜드 같음 + 가격 공개 model ↔ 가격 문의 name 정규화(영문 대문자·숫자) 일치, 4자 이상, 가격 문의 쪽 후보 1건, 리퍼·전시·박스손상 표시 제외 → **520쌍**(main 과 동일 — 정리 브랜드·이름 속 상태 표시로 바꿔도 결과 같음).
- 2단계(추가, 상품명 완전 일치): 1단계에 안 걸린 것 중 정리된 브랜드 같음 + 화면 상품명이 공백·기호만 빼고 한글까지 완전히 같은 가격 공개 1건 ↔ 가격 문의 1건, 상태 표시 제외 → **24쌍**(예: SHURE KSM40C·KSM44MP, GENELEC 8010A~8050B, Antares 플러그인 11종). 모두 두 공급처(삼아사운드 문의 ↔ 삼아스토어 공개) 사이 같은 상품.
- 남긴 쪽은 가격 공개 상품(id·이름·가격·사진 그대로). 가격 문의 쪽 분류 경로 채택 447건, 상품요약정보 채택 100건. 없어진 id 의 `#/product/<id>` 는 `product_merge.js` 로 남긴 상품에 이동(기존 520쌍 그대로 유지).

## 2. 대분류(G3)

- 케이블 규칙의 `디지털`·`파워` 는 main(#218)에서 이미 정확 일치(exactKeywords)로 바뀌어 디지털 믹서는 믹서·프로세서(시험으로 고정).
- 이번에 고친 것: 넓은 분류 "레코딩" 에 섞인 소프트웨어(Waves·iZotope 번들, 구독권, 가상악기, Melodyne·업데이트, Ozone) → 소프트웨어·플러그인 49건 / "레코딩/음향"·"스피커" 의 믹서·스피커 가방·케이스·보호 커버 → 액세서리·소모품 16건(그 밖에 병합으로 구체 분류를 받은 베이스 스트링 1건 악기·앰프 → 액세서리·소모품). 상품명 보조 규칙에 `labels`(적용할 원본 분류)를 둬서 다른 분류의 하드웨어 "번들"·"[커버 무료증정]" 믹서 본체는 건드리지 않는다.

| 대분류 | 전 | 후 | 차이 |
|---|---:|---:|---:|
| 마이크·무선 | 502 | 498 | -4 |
| 스피커 | 561 | 550 | -11 |
| 이어폰·헤드폰 | 88 | 87 | -1 |
| 케이블·커넥터 | 610 | 609 | -1 |
| 레코딩·인터페이스 | 401 | 343 | -58 |
| 소프트웨어·플러그인 | 318 | 356 | +38 |
| 믹서·프로세서 | 102 | 101 | -1 |
| 네트워크·회의영상 | 79 | 79 | +0 |
| 악기·앰프 | 475 | 473 | -2 |
| 스탠드·거치 | 146 | 146 | +0 |
| 액세서리·소모품 | 588 | 604 | +16 |
| 음향 튜닝·방음 | 97 | 97 | +0 |
| 특가·기획 | 59 | 59 | +0 |
| 합계 | 4,026 | 4,002 | -24 |

(합계 차이 −24 는 병합. 소프트웨어 +38 = 이동 +49 − 병합된 Antares 플러그인 11.)

### 대분류가 바뀐 상품 66건

- 레코딩·인터페이스 → 액세서리·소모품 · PRESONUS 프리소너스 StudioLive AR8 용 숄더 백
- 레코딩·인터페이스 → 액세서리·소모품 · PreSonus 프리소너스 StudioLive AR12 AR16 용 백팩
- 레코딩·인터페이스 → 액세서리·소모품 · PreSonus StudioLive1602 Backpack 스튜디오라이브 1602용 백팩
- 악기·앰프 → 액세서리·소모품 · PSD Bass 99 Series 로토사운드 베이스 기타 스트링
- 레코딩·인터페이스 → 액세서리·소모품 · PreSonus StudioLive1602 Cover 스튜디오라이브 1602용 커버
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Antares Articulator 안타레스 아티큘레이터 토크박스 플로그인
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Melodyne 5 assistant UPD 멜로다인 5 어시스턴트 업데이트 (이전 버전 assistant all)
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Abbey Road Collection Bundle 웨이브즈 컬렉션 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves API Collection Bundle 웨이브즈 API 컬렉션 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Chris Lord-Alge Signature Series Bundle 웨이브즈 크리스 로드 알지 시그니처 시리즈 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves CLA Classic Compressors Bundle 웨이브즈 CLA 클래식 컴프레서 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Diamond Bundle 웨이브즈 다이아몬드 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Horizon Bundle 웨이브즈 호라이즌 번들 (실시간)
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Mercury Bundle 웨이브즈 머큐리 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Platinum Bundle 웨이브즈 플래티넘 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Renaissance Maxx Bundle 웨이브즈 르네상스 맥스 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves SSL 4000 Collection Bundle 웨이브즈 SSL 4000 컬렉션 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Studio Classics Collection Bundle 웨이브즈 스튜디오 클래식 컬렉션 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Tony Maserati Signature Series Bundle 웨이브즈 토니 마세라티 시그니처 시리즈 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Creative Acess Essential 웨이브즈 에센셜 1년권 (구독권) 실시간
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Creative Acess Ultimate 웨이브즈 얼티밋 1년권 (구독권) 실시간
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Broadcast & Production Bundle 웨이브즈 브로드캐스트 & 프로덕션 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Content Creator Audio Toolkit Bundle 웨이브즈 컨텐츠 크리에이터 오디오 툴킷 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Forensics Package Bundle 웨이브즈 포렌식 패키지 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Genesis Bundle 웨이브즈 제네시스 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Gold Bundle 웨이브즈 골드 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Grand Masters Collection Bundle 웨이브즈 그랜드 마스터스 컬렉션 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Greg Wells Signature Series Bundle 웨이브즈 그렉 웰스 시그니처 시리즈 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves H-Series Bundle 웨이브즈 H-시리즈 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Jack Joseph Puig Signature Series Bundle 웨이브즈 잭 조셉 푸이그 시그니처 시리즈 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves JJP Analog Legends Bundle 웨이브즈 JJP 아날로그 레전드 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Manny Marroquin Signature Series Bundle 웨이브즈 매니 매로퀸 시그니처 시리즈 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Masters Bundle 웨이브즈 마스터즈 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Musicians 1 Bundle 웨이브즈 뮤지션 1 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Musicians 2 Bundle 웨이브즈 뮤지션 2 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Nx Virtual Studio Collection Bundle 웨이브즈 Nx 버츄얼 스튜디오 컬렉션 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves OneKnob Series Bundle 웨이브즈 원노브 시리즈 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Pianos & Keys Bundle 웨이브즈 피아노 & 키보드 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Power Pack Bundle 웨이브즈 파워 팩 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Signature Series Bass and Drums Bundle 웨이브즈 시그니처 시리즈 베이스 & 드럼 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Signature Series Vocals Bundle 웨이브즈 시그니처 시리즈 보컬 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Silver Bundle 웨이브즈 실버 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Sound Design Suite Bundle 웨이브즈 사운드 디자인 스위트 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Tape, Tubes & Transistors Bundle 웨이브즈 테이프, 튜브 & 트랜지스터 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Transform Bundle 웨이브즈 트랜스폼 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Video Sound Suite Bundle 웨이브즈 비디오 사운드 스위트 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves Vocal Production Bundle 웨이브즈 보컬 프로덕션 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · Waves V-Series Bundle 웨이브즈 V-시리즈 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · NI KONTAKT 8 Update For Kontakt 1-7 콘탁 8 가상악기 라이브러리 (실시간)
- 레코딩·인터페이스 → 소프트웨어·플러그인 · iZOTOPE RX Post Production Suite 아이조톱 포스트 프로덕션 필수 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · iZOTOPE Elements Suite 아이조톱 모든 Elements 번들
- 믹서·프로세서 → 소프트웨어·플러그인 · iZOTOPE Mix & Master Bundle Advanced 아이조톱 믹싱 및 마스터링 필수 번들
- 레코딩·인터페이스 → 소프트웨어·플러그인 · iZOTOPE Music Production Suite 아이조톱 음악 프로덕션 필수 번들
- 스피커 → 액세서리·소모품 · PreSonus AIR15s Cover 프리소너스 AIR15s 보호용 소프트 커버
- 스피커 → 액세서리·소모품 · PreSonus AIR18s Cover 프리소너스 AIR18s 보호용 소프트 커버
- 레코딩·인터페이스 → 액세서리·소모품 · PreSonus SLMAD16-Cover 프리소너스 StudioLive Series III용 커버 (StudioLive 16/32SC)
- 레코딩·인터페이스 → 액세서리·소모품 · PreSonus SLMAD24-Cover 프리소너스 StudioLive Series III용 커버(StudioLive 24/32SX)
- 레코딩·인터페이스 → 액세서리·소모품 · PreSonus SLMAD32-Cover 프리소너스 StudioLive Series III용 커버(StudioLive 32/32S/64S)
- 스피커 → 액세서리·소모품 · PRESONUS ULT12 Cover 프리소너스 ULT12 보호용 소프트 커버
- 스피커 → 액세서리·소모품 · PRESONUS ULT15 Cover 프리소너스 ULT15 보호용 소프트 커버
- 스피커 → 액세서리·소모품 · PRESONUS ULT18 Cover 프리소너스 ULT18 보호용 소프트 커버
- 스피커 → 액세서리·소모품 · PRESONUS CDL 18S Cover 프리소너스 CDL 18s 보호용 소프트 커버
- 레코딩·인터페이스 → 액세서리·소모품 · A&H CQ12T Case 알렌히스 CQ-12T 용 소프트 케이스 휴대용 가방
- 레코딩·인터페이스 → 액세서리·소모품 · A&H CQ18T Case 알렌히스 CQ-18T 용 소프트 케이스 휴대용 가방
- 레코딩·인터페이스 → 액세서리·소모품 · A&H CQ20B Case 알렌히스 CQ-20B 용 소프트 케이스 휴대용 가방
- 레코딩·인터페이스 → 소프트웨어·플러그인 · iZOTOPE Ozone 12 Advanced (Advanced UPG) 아이조톱 오존 12 어드밴스드 업그레이드

## 3. 검색 잡음(G4)

- `search_text` 에서 구매방법·배송주기("1회구매 정기배송 할인 배송주기…") 문구 0건(시험 고정). 참고: 공급처 기간 할인 문구("할인판매가 … / 할인 기간 남은시간") 85건은 다른 사양 칸이라 이번 범위에서 손대지 않았다.

## 4. 추천순

- 상품명에 리퍼·리퍼비쉬·박스손상·전시·단종·클리어런스가 있으면 추천순에서 같은 조건 상품 뒤로(검색어가 있어 관련도순으로 보일 때 포함). 목록·검색 결과에는 그대로 나온다.
- 관련도가 같을 때 추천순 기준(대분류 순서·브랜드 순번)으로 정렬 — "스피커" 첫 화면이 스피커 스탠드가 아니라 스피커.
- 측정(1440, "스피커"): main 첫 12개 중 리퍼·박스손상 **12개** → 이번 **0개**. 캡처 `docs/screenshots/catalog-quality-261120/`.

## 5. 가격·id 불변 확인

- 남은 4,002건 전부 id·가격·이름·사진이 main 과 같다(가격 변경 **0건**), main 에 없던 id 0건. 이번에 빠진 24건은 모두 가격 문의(가격 공개 0건).
- `backend/data/price_index.mjs`: 재생성, 가격 항목 2,089건 main 과 완전히 같음(바뀐 것은 생성 시각 줄뿐, 줄바꿈 CRLF → LF).
- 숨김 결제 확인 상품(`paytest.js`) 바이트 그대로.

## 6. 대분류별 무작위 20건(시드 261120)

### 마이크·무선 (498건)

- SHURE MV88+ Video Kit 슈어 프리미엄 디지털 스테레오 컨덴서 모바일 마이크  ·  원본 분류: MV 시리즈
- SHURE A89LW-SFT / 슈어 VP89L 용 윈드쉴드  ·  원본 분류: VP
- SLXD1+  ·  원본 분류: SLX-D 시리즈
- SHURE A42OR / 슈어 KSM42 쇼크마운트 용 고무밴드  ·  원본 분류: KSM
- SHURE WA713 (화이트) / 슈어 컬러 핸들 커버  ·  원본 분류: BLX
- SHURE WA712 (블루) / 슈어 컬러 핸들 커버  ·  원본 분류: BLX
- SHURE RK322 / 슈어 PG30TQG 교체용 윈드스크린 + 클립  ·  원본 분류: SHURE 유선마이크용
- SHURE MV7i 슈어 USB-C 스마트 마이크 오디오인터페이스  ·  원본 분류: MV 시리즈
- SHURE SM63 / SM63L / SM63LB 슈어 방송 인터뷰 용 다이내믹 옴니지향성 마이크  ·  원본 분류: 유선 마이크
- SHURE RK203TC / 슈어 SM11 용 타이 클립  ·  원본 분류: SM
- SHURE GLXD14R+/MX53 슈어 GLXD+ 1채널 랙 장착형 바디팩 무선 마이크 세트 MX153 포함  ·  원본 분류: 마이크
- SHURE NXN6 슈어 넥사다인 드럼 탐/스네어용 슈퍼카디오이드 다이나믹 마이크  ·  원본 분류: 유선 마이크
- SHURE SVX288/PG58X 슈어 SVX 2채널 핸드헬드 무선 마이크 세트 PG58 포함  ·  원본 분류: 마이크
- SHURE 565SD 슈어 보컬용 유선 마이크  ·  원본 분류: 유선 마이크
- SHURE A89M-CC / 슈어 CCA 마운트  ·  원본 분류: VP
- SHURE AMV88-WS / 슈어 MV88 전용 윈드스크린(MOTIV)  ·  원본 분류: MOTIV
- SHURE 53A8611 / 슈어 랙 마운트 구형 (Short)  ·  원본 분류: SLX
- SHURE GLXD2+/SM58 슈어 무선 마이크 GLXD+ SM58 핸드헬드 송신기 단품  ·  원본 분류: 마이크
- SHURE BETA58 A 슈어 보컬용 유선 마이크  ·  원본 분류: BETA 시리즈
- SHURE AMVL-WS / 슈어 MVL 전용 윈드스크린(MOTIV)  ·  원본 분류: MOTIV

### 스피커 (550건)

- Primacoustic RX5 DF 프라임어쿠스틱 라우드 스피커 마운트 (하향)  ·  원본 분류: 스피커
- Linear 5 MKII 112 XA  ·  원본 분류: 스테이지 모니터 스피커
- LYD 5 Black  ·  원본 분류: DYNAUDIO
- G4 (화이트)  ·  원본 분류: 액티브 스피커
- GENELEC 8040B 제네렉 스튜디오 모니터 스피커 (블랙)  ·  원본 분류: 액티브 스피커
- L Sub 1800 A  ·  원본 분류: 서브우퍼
- PRESONUS CDL 12 프리소너스 액티브 라우드 스피커  ·  원본 분류: PA 스피커
- ELX200-18SP-AP  ·  원본 분류: 포터블 스피커
- CDD8  ·  원본 분류: 설치용 스피커
- PRESONUS CDL 12P Rigging Sling 프리소너스 CDL 12P 라우드스피커용 Pull-Back Sling  ·  원본 분류: 스피커
- A55  ·  원본 분류: 설치용 스피커
- NLT4FX  ·  원본 분류: 라우드스피커
- CF 118  ·  원본 분류: 서브우퍼
- MLX  ·  원본 분류: 서브우퍼
- GENELEC 8020D 제네렉 스튜디오 모니터 스피커 (화이트)  ·  원본 분류: 스피커
- Primacoustic RX7 UF 프라임어쿠스틱 라우드 스피커 마운트 (상향)  ·  원본 분류: 스피커
- GENELEC 8050B 제네렉 스튜디오 모니터 스피커 (블랙)  ·  원본 분류: 액티브 스피커
- GENELEC 8341A 제네렉 SAM 동축 스튜디오 모니터 스피커 (다크그레이)  ·  원본 분류: 스피커
- PreSonus Eris Pro 6 프리소너스 에리스 프로6 동축 모니터 스피커 (1통)  ·  원본 분류: 스피커
- CONTOUR X Flightcase  ·  원본 분류: 액세서리 - 라우드 스피커

### 이어폰·헤드폰 (87건)

- SHURE P3TRA215CL PSM300 시스템, 프로페셔널 바디팩, SE215-CL 이어폰 포함  ·  원본 분류: 마이크
- SHURE SE535 Clear 슈어 이어폰  ·  원본 분류: 유선 리스닝
- SE215 Special Edition  ·  원본 분류: 유선 리스닝
- 컴플라이 폼팁 - 갤럭시 버즈3 프로 전용 (NEW PACK / 3 pair / 블랙)  ·  원본 분류: 컴플라이 이어팁
- SHURE 30A20070 / 슈어 이어폰 와샤 (Washer)  ·  원본 분류: 액세서리
- 컴플라이 폼팁 IsolationTM - Comply Series T500 (3 pair)  ·  원본 분류: 컴플라이 이어팁
- SHURE SE215SPE Purple 슈어 이어폰  ·  원본 분류: 이어폰
- 컴플라이 폼팁 - 에어팟프로 1,2세대 전용 이어팁 (NEW PACK / 3 pair / 화이트 / 블랙)  ·  원본 분류: 컴플라이 이어팁
- SHURE AONIC215 - UNI (SE215SPE-UNI) (블루) 슈어 이어폰  ·  원본 분류: 이어폰
- COMPLY NEW! SmartCore 버라이어티팩 (3 pair)  ·  원본 분류: 컴플라이 이어팁
- 컴플라이 폼팁 TrueGrip ProTM - TW-170-A (Jabra 자브라 65t, 75t 호환 / 3 pair)  ·  원본 분류: 컴플라이 이어팁
- 컴플라이 폼팁 TW-400-C (3 pair)  ·  원본 분류: 컴플라이 이어팁
- 컴플라이 폼팁 IsolationTM - Comply Series T400 (3 pair)  ·  원본 분류: 컴플라이 이어팁
- COMPLY 코어 시리즈 폼팁 VP-500 3쌍 (S,L)  ·  원본 분류: COMPLY
- SHURE AONIC215 - UNI (SE215SPE-UNI) (화이트) 슈어 이어폰  ·  원본 분류: 유선 리스닝
- SHURE SRH840A 슈어 프로페셔널 모니터링 헤드폰  ·  원본 분류: 헤드폰
- SHURE SE425 Clear 슈어 이어폰  ·  원본 분류: 유선 리스닝
- SRH840A  ·  원본 분류: 유선 리스닝
- SHURE AONIC215 - UNI (SE215-UNI) (블랙) 슈어 이어폰  ·  원본 분류: 이어폰
- Earpad for BOSE QC Ultra1,2(교체형/1 pair)  ·  원본 분류: 컴플라이 이어팁

### 케이블·커넥터 (609건)

- NEUTRIK NA2MPMF / 뉴트릭 XLR (수) - RCA (암) 어댑터  ·  원본 분류: 어댑터
- NEUTRIK NC10FD-LX-B / 뉴트릭 XLR 10핀 (암) 샤시형 커넥터  ·  원본 분류: XLR
- M1 PRIME 마이크 케이블 (XLR to XLR, Neutrik 커넥터) 블랙  ·  원본 분류: KLOTZ
- GENESIS SILVER SPIRAL (Pair)  ·  원본 분류: Hi-Fi 케이블
- REAN RC3M / 리안 XLR (수) 커넥터 실버  ·  원본 분류: XLR
- KLOTZ M1BTT 자체제작 클로츠 레코딩 케이블 (TRS to TRS, Neutrik 커넥터)  ·  원본 분류: 레코딩 케이블
- AL-RP Superior RCA 케이블 (2x RCA to 2x TSᅳ자)  ·  원본 분류: KLOTZ
- NYS230  ·  원본 분류: 1/4", 3.5mm, RCA
- KLOTZ RC5-LB1S RamCAT-Flex 클로츠 S/UTP네트워크 케이블  ·  원본 분류: 벌크 케이블
- OT234H OminiTRANS AES/EBU(DMX) 디지털 설치용 케이블  ·  원본 분류: KLOTZ
- KLOTZ Joe Bonamassa 시그니처 클로츠 기타 케이블(TSᅳ자 to TSᅳ자, Neutrik커넥터)  ·  원본 분류: 기타&악기 케이블
- KLOTZ AL-RP Superior 클로츠 RCA 케이블 (2x RCA to 2x TSᅳ자)  ·  원본 분류: 포터블 오디오 케이블
- REAN RC3FDL / 리안 XLR (암) 샤시형 커넥터 실버  ·  원본 분류: XLR
- KLOTZ KMPP 클로츠 프로 스테레오 키보드 케이블 (2x TS to 2x TS)  ·  원본 분류: 기타&악기 케이블
- KLOTZ SCH2025-D 클로츠 twinaxial 설치용 스피커 케이블  ·  원본 분류: 벌크 케이블
- REAN RCX3M-Z-002-1 / 리안 XLR 3핀 (수) 커넥터 블랙  ·  원본 분류: XLR
- KLOTZ AY5 클로츠 Lightweight Y 케이블 (3.5 TRS ᅳ자 to 2x TS ᅳ자)  ·  원본 분류: 포터블 오디오 케이블
- SHURE G12-CN / 크롬 구즈넥, 12", XLR 커넥터 장착 (30.48cm)  ·  원본 분류: 액세서리
- NEUTRIK NP2X -50 / 뉴트릭 55 TS 커넥터 50주년 한정판  ·  원본 분류: 1/4", 3.5mm, RCA
- C7P06P CAT7 S/FTP 네트워크 패치 케이블  ·  원본 분류: KLOTZ

### 레코딩·인터페이스 (343건)

- APOGEE Duet 3 Dock 아포지 듀엣 3 용 도킹 스테이션  ·  원본 분류: USB 인터페이스
- AIR12  ·  원본 분류: PRESONUS
- 16x16SE Symphony I/O Mk II 섀시용 옵션카드  ·  원본 분류: Thunderbolt 인터페이스
- RADIAL PRO AV2 레디알 멀티미디어 다이렉트 박스  ·  원본 분류: 다이렉트 박스
- AudioScape AS-2A Optical Compressor 오디오스케이프 옵티컬 컴프레서  ·  원본 분류: 레코딩
- Arturia KeyLab 49 MK3 Ultra Edition 아투리아 고급형 마스터 키보드 미디 컨트롤러  ·  원본 분류: 레코딩
- Fender Studio Quantum LT 2 펜더 스튜디오 퀀텀 LT 2 오디오 인터페이스  ·  원본 분류: 레코딩/음향
- PreSonus FaderPort 8 프리소너스 컨트롤러  ·  원본 분류: 컨트롤러
- USB-C to C 케이블 (2m)  ·  원본 분류: APOGEE
- StudioLive 32SC  ·  원본 분류: PRESONUS
- MiniFuse Recording Pack - Black  ·  원본 분류: USB 인터페이스
- CDL Rigging EXT Bar  ·  원본 분류: PRESONUS
- Arturia MiniLab MK3 아투리아 미니랩3 포터블 미니 마스터 키보드 미디 컨트롤러 'Black'  ·  원본 분류: 레코딩
- Arturia KeyStep Pro 아투리아 키스랩 프로 올인원 키보드 시퀀서 미디컨트롤러 Chroma 스페셜 에디션  ·  원본 분류: 레코딩
- StudioLive AR12 / AR12c 랙 날개  ·  원본 분류: PRESONUS
- Ensemble Thunderbolt 오디오 인터페이스  ·  원본 분류: Thunderbolt 인터페이스
- PreSonus Central Station Plus 프리소너스 컨트롤러  ·  원본 분류: 모니터 컨트롤러
- 2x6SE Symphony I/O Mk II 섀시용 옵션카드  ·  원본 분류: Thunderbolt 인터페이스
- USB Pro  ·  원본 분류: 멀티미디어 DI
- SB-1  ·  원본 분류: 액티브 DI

### 소프트웨어·플러그인 (356건)

- Antares Aspire 안타레스 아스파이어 숨소리 컨트롤 플러그인  ·  원본 분류: 소프트웨어/플러그인
- Auto-Tune Access 오토튠 액세스 플러그인  ·  원본 분류: 소프트웨어/플러그인
- Total Bundle토탈 플러그인 번들  ·  원본 분류: 소프트웨어/플러그인
- Waves Eddie Kramer Signature Series Bundle 웨이브즈 에디 크레이머 시그니처 시리즈 번들  ·  원본 분류: 소프트웨어/플러그인
- Simplon 심플론 필터 플러그인  ·  원본 분류: 소프트웨어/플러그인
- Masters Bundle  ·  원본 분류: 소프트웨어/플러그인
- NOTION 6  ·  원본 분류: 소프트웨어/플러그인
- CLA Classic Compressors Bundle  ·  원본 분류: 소프트웨어/플러그인
- KOMPLETE 14 STANDARD Upgrade for Collections  ·  원본 분류: 소프트웨어/플러그인
- iZOTOPE Nectar 4 Advanced 아이조톱 보컬 믹싱 프로 플러그인  ·  원본 분류: 레코딩
- Genesis Bundle  ·  원본 분류: 소프트웨어/플러그인
- Comp 76 오버라우드 플러그인 (전자배송)  ·  원본 분류: 소프트웨어/플러그인
- SSL 4000 Collection Bundle  ·  원본 분류: 소프트웨어/플러그인
- iZotope Ozone 11 Advanced (Advanced UPG) 아이조톱 오존 11 Advanced 업그레이드  ·  원본 분류: 소프트웨어/플러그인
- Waves Abbey Road Collection Bundle 웨이브즈 컬렉션 번들  ·  원본 분류: 레코딩
- LRS EDDIED EL34 (TH-U 확장팩)  ·  원본 분류: 소프트웨어/플러그인
- Arturia Pigments 7 아투리아 피그먼츠 소프트웨어 신디사이저 (가상악기/VST) (실시간)  ·  원본 분류: 레코딩
- NI Komplete 26 Ultimate (신규구매자) (실시간) 컴플리트 26 얼티메이트 가상악기 VSTi Native Instruments  ·  원본 분류: 소프트웨어
- NI Maschine 3 Bundle Update 비트메이킹, 뮤직 프로덕션 머신 3 번들 소프트웨어 업데이트(라이브러리 포함) (실시간)  ·  원본 분류: 소프트웨어/플러그인
- Pro-G 프로 게이트 플러그인  ·  원본 분류: 소프트웨어/플러그인

### 믹서·프로세서 (101건)

- AHM-64  ·  원본 분류: 오디오/비디오 매트릭스 프로세서
- AHM-32  ·  원본 분류: 오디오/비디오 매트릭스 프로세서
- QU-5 (NEW)  ·  원본 분류: 디지털 믹서
- PreSonus StudioLive 64S 프리소너스 디지털 믹서  ·  원본 분류: 레코딩/음향
- A&H ZED-6FX 알렌히스 아날로그 믹서  ·  원본 분류: 레코딩/음향
- ZED-10FX  ·  원본 분류: ZED
- MixWizard4 16:2  ·  원본 분류: 아날로그 믹서
- ME-1  ·  원본 분류: 퍼스널 믹서
- A&H QU-6 / QU-6D 알렌앤히스 컴팩트 디지털 믹서  ·  원본 분류: 레코딩/음향
- MixWizard4 14:4:2  ·  원본 분류: 아날로그 믹서
- PreSonus StudioLive 24R 프리소너스 디지털 랙 믹서  ·  원본 분류: 레코딩/음향
- MP-M Series - Q-SYS Zone Mixer  ·  원본 분류: Zone Mixers
- CDM48  ·  원본 분류: 디지털 믹서
- A&H CQ-20B 알렌히스 컴팩트 디지털 믹서  ·  원본 분류: 레코딩/음향
- PreSonus StudioLive SE16 프리소너스 디지털 믹서  ·  원본 분류: 레코딩/음향
- C1500  ·  원본 분류: 디지털 믹서
- S3000  ·  원본 분류: 디지털 믹서
- Qu-PAC  ·  원본 분류: 디지털 믹서
- AHM-16  ·  원본 분류: 오디오/비디오 매트릭스 프로세서
- SQ5+  ·  원본 분류: 디지털 믹서

### 네트워크·회의영상 (79건)

- MX183  ·  원본 분류: 아날로그 회의용 시스템 (Microflex)
- AB168  ·  원본 분류: I/O and Networking
- EQP-TCVR  ·  원본 분류: 인터컴 시스템
- Vaddio RoboSHOT 12/12E/30/30E 카메라 전용 벽부형 브라켓/Tall  ·  원본 분류: Vaddio
- Vaddio USB 2.0 Active Extension 케이블/20m/검정색  ·  원본 분류: Vaddio
- DX164-W  ·  원본 분류: I/O and Networking
- MX415  ·  원본 분류: 아날로그 회의용 시스템 (Microflex)
- SQ SLink  ·  원본 분류: 오디오 네트워킹
- EQP-WH  ·  원본 분류: 인터컴 시스템
- MX184  ·  원본 분류: 아날로그 회의용 시스템 (Microflex)
- Vaddio RoboSHOT 12/12E/30/30E 카메라 전용 벽부형 브라켓/Long/검정색  ·  원본 분류: Vaddio
- Vaddio ACTIVE OPTICAL USB 3.0 A to C 플레넘 타입 케이블/30m/검정색  ·  원본 분류: Vaddio
- CORE 110F - Q-SYS 네트워크 프로세서  ·  원본 분류: AV & Control Platform
- AR84  ·  원본 분류: I/O and Networking
- Vaddio ACTIVE OPTICAL USB 3.0 A to C 플레넘 타입 케이블/8m/검정색  ·  원본 분류: Vaddio
- Stem Speaker  ·  원본 분류: STEM (STEM Ecosystem)
- Shure 31A8165E 슈어 MW2 용 배터리 커버 (샴페인)  ·  원본 분류: Microflex Wireless
- M-Dante  ·  원본 분류: 오디오 네트워킹
- Dante 64x64  ·  원본 분류: 오디오 네트워킹
- SQ Waves  ·  원본 분류: 오디오 네트워킹

### 악기·앰프 (473건)

- Custom Classic S 마이클 터틀 일렉 기타 (딜러 셀렉트 모델)  ·  원본 분류: 악기/앰프
- Mark V medium head 기타 앰프  ·  원본 분류: 기타&베이스 앰프
- Custom Classic S 마이클 터틀 일렉 기타 (딜러 셀렉트 모델)  ·  원본 분류: 악기/앰프
- Positive Grid Spark Mini 스마트 앰프 기타 앰프  ·  원본 분류: 기타&베이스 앰프
- Michael Tuttle Guitars Custom Classic S 845 마이클 터틀 일렉 기타 (딜러 셀렉트 모델)  ·  원본 분류: 악기/앰프
- Nashguitars PBJ-5 내쉬 PJ 5현 베이스 기타 (딜러 셀렉트, SAM-101)  ·  원본 분류: NASH GUITARS
- Positive Grid Spark Battery 스파크 앰프 전용 배터리  ·  원본 분류: POSITIVE GRID
- 2x12 Recto Horizontal 기타 캐비닛  ·  원본 분류: 기타&베이스 앰프
- Michael Tuttle Guitars Custom Classic S 894 마이클 터틀 일렉 기타 (딜러 셀렉트 모델)  ·  원본 분류: 악기/앰프
- Nashguitars S-63 내쉬 일렉 기타 (딜러 셀렉트 모델, SAM-69) 바로 구매 가능  ·  원본 분류: 악기/앰프
- Positive Grid Spark MINI VAI 아티스트 에디션 스마트 앰프 기타 앰프  ·  원본 분류: 기타&베이스 앰프
- Carve Top Supreme 일렉 기타 (커스텀 오더)  ·  원본 분류: 일렉트릭 기타
- Headless Series 헤드리스 베이스 기타 (커스텀 오더)  ·  원본 분류: 베이스 기타
- Standard Plus Series 로스코 스탠다드 플러스 베이스 기타 (커스텀 오더)  ·  원본 분류: ROSCOE GUITARS
- Nashguitars T-72TL 내쉬 일렉 기타 (커스텀 오더)  ·  원본 분류: 일렉트릭 기타
- Michael Tuttle Guitars Custom Classic S 787 마이클 터틀 일렉 기타 (딜러 셀렉트 모델)  ·  원본 분류: 악기/앰프
- Nashguitars S-63 SSH 내쉬 일렉 기타 (딜러 셀렉트, SAM-121)  ·  원본 분류: 악기/앰프
- 2x12 Recto Vertical 메사부기 기타 캐비닛  ·  원본 분류: 악기/앰프
- Magellan 800 베이스 기타 앰프  ·  원본 분류: 기타&베이스 앰프
- TC-50 Head 기타 앰프  ·  원본 분류: 기타&베이스 앰프

### 스탠드·거치 (146건)

- 25900 마이크 스탠드  ·  원본 분류: 마이크 스탠드
- SHURE 90AZ8100 / 슈어 무선 수신기 랙 마운트 장착용 볼트 세트  ·  원본 분류: 액세서리
- Q Acoustics Q 3000i 큐어쿠스틱 3000i 스피커 스탠드 (Pair)  ·  원본 분류: 스피커
- K&M 30900 케이앤엠 프로페셔널 기타 카포  ·  원본 분류: K&M
- 17581 "Heli 2" 기타 스탠드  ·  원본 분류: 기타 스탠드
- K&M 17513 'Guardian 3' 케이앤엠 트리플 기타 스탠드 (반투명 색상)  ·  원본 분류: K&M 스탠드
- K&M 26773 케이앤엠 모니터 스피커 스탠드 (탁상용) 2개 (1조)  ·  원본 분류: 스피커
- K&M 12248 케이앤엠 오케스트라 LED 악보 보면등  ·  원본 분류: K&M 스탠드
- 18930 키보드 스탠드  ·  원본 분류: 키보드 스탠드
- 16240 기타 월마운트  ·  원본 분류: 기타 스탠드
- K&M 18930 케이앤엠 X자 키보드 스탠드  ·  원본 분류: 키보드 스탠드
- GENELEC 8000-400 제네렉 고급 디자인 플로어 스탠드  ·  원본 분류: 스피커
- 21060 마이크 스탠드  ·  원본 분류: 마이크 스탠드
- 18990 "Rick" 키보드 스탠드  ·  원본 분류: 키보드 스탠드
- 21459 스피커 스탠드  ·  원본 분류: 스피커 스탠드
- PreSonus StudioLive1602 스튜디오라이브 1602용 랙 날개 SL 1602 RACK EAR  ·  원본 분류: 액세서리
- 21070 마이크 스탠드  ·  원본 분류: 마이크 스탠드
- K&M 16240 케이앤엠 기타 월 마운트  ·  원본 분류: K&M 스탠드
- 17515 "Guardian 5" 기타 스탠드 반투명  ·  원본 분류: 기타 스탠드
- K&M 26720 케이앤엠 모니터 스피커 스탠드  ·  원본 분류: 스피커

### 액세서리·소모품 (604건)

- A100C  ·  원본 분류: 유선마이크 액세서리
- AXT913  ·  원본 분류: 무선 마이크 액세서리
- A89U  ·  원본 분류: 유선마이크 액세서리
- A85WS  ·  원본 분류: 유선마이크 액세서리
- 지코 일체형 옴니아 OMNIA J44A 7 IMP SD (SHURE 슈어 N-44-7 복각)  ·  원본 분류: JICO 카트리지/스타일러스
- OMNIA J44A7 AURORA IMP NUDE  ·  원본 분류: JICO
- A44AM  ·  원본 분류: 유선마이크 액세서리
- RK244G  ·  원본 분류: 유선마이크 액세서리
- M44G / 포노 카트리지  ·  원본 분류: 포노카트리지
- WA570A  ·  원본 분류: 유선마이크 액세서리
- UA825 (7.5m)  ·  원본 분류: 무선 마이크 액세서리
- A109ZB  ·  원본 분류: 유선마이크 액세서리
- A26M  ·  원본 분류: 유선마이크 액세서리
- PreSonus AIR18s Cover 프리소너스 AIR18s 보호용 소프트 커버  ·  원본 분류: 스피커
- Jumbo King Series 로토사운드 어쿠스틱 기타 스트링  ·  원본 분류: 기타 액세서리
- SHURE EATFL1-6 / 슈어 트리플 플랜지 슬리브 이어팁  ·  원본 분류: 액세서리
- SHURE RS65 / 슈어 565SD 그릴  ·  원본 분류: 액세서리
- RPW112  ·  원본 분류: 무선 마이크 액세서리
- SHURE A12 / 소형 마운팅 플랜지 (은색)  ·  원본 분류: 액세서리
- SHURE SBH2350-WH-PADS / 슈어 Aonic 50 교체용 이어패드 (화이트) 1쌍  ·  원본 분류: 액세서리

### 음향 튜닝·방음 (97건)

- VICOUSTIC 코너 베이스트랩 올인원 어쿠스틱 음향디퓨저 비쿠스틱 빅토템 VicTotem Ultra VMT  ·  원본 분류: 어쿠스틱 패널
- Primacoustic Strato Tile - BK 프라임어쿠스틱 룸 어쿠스틱 패널  ·  원본 분류: 레코딩
- Thunder Tile T-Bar  ·  원본 분류: 어쿠스틱 패널
- Broadway - Broadband Absorber  ·  원본 분류: 어쿠스틱 패널
- Primacoustic London 16 프라임어쿠스틱 룸 어쿠스틱 패널  ·  원본 분류: 레코딩
- Vicoustic VicStudio Box 비쿠스틱 어쿠스틱 패널 10개입  ·  원본 분류: 어쿠스틱 패널
- Broadway - Control Cubes  ·  원본 분류: 어쿠스틱 패널
- Vox Guard VU  ·  원본 분류: 기타 어쿠스틱 용품
- Vicoustic Super Bass Extreme Ultra VMT 비쿠스틱 베이스 트랩  ·  원본 분류: 레코딩
- London BT Paintable  ·  원본 분류: 어쿠스틱 패널
- Vicoustic Cinema Piano VMT 비쿠스틱 어쿠스틱 흡음 패널  ·  원본 분류: 레코딩
- Broadway - Control Column  ·  원본 분류: 어쿠스틱 패널
- London 12  ·  원본 분류: 어쿠스틱 패널
- Primacoustic London 8 프라임어쿠스틱 룸 어쿠스틱 패널  ·  원본 분류: 레코딩
- MN1 컴팩트 유닛 룸 튜닝재  ·  원본 분류: AGS
- London 10 Paintable  ·  원본 분류: 어쿠스틱 패널
- RX5 DF  ·  원본 분류: 기타 어쿠스틱 용품
- Primacoustic Flexi Fuser 프라임어쿠스틱 컴비네이션 디퓨저  ·  원본 분류: 레코딩
- Strato Tile - BK  ·  원본 분류: 어쿠스틱 패널
- Primacoustic London 12 프라임어쿠스틱 룸 어쿠스틱 패널  ·  원본 분류: 레코딩

### 특가·기획 (59건)

- [리퍼비쉬] Q Acoustics QA8204 스피커  ·  원본 분류: 특가상품
- [리퍼비쉬] DYNAUDIO BM5 MKIII / 스튜디오 모니터 스피커  ·  원본 분류: 특가상품
- [전시상품] APOGEE JAM X 아포지 USB 기타 인터페이스  ·  원본 분류: 특가상품
- [전시상품] APOGEE Duet 3 아포지 듀엣3 오디오 인터페이스  ·  원본 분류: 특가상품
- [리퍼비쉬] Arturia KeyStep Pro 아투리아 키스텝 프로 올인원 키보드 시퀀서 미디컨트롤러 - 한정판 'Black'  ·  원본 분류: 특가상품
- [전시상품] PRESONUS Quantum ES 4 프리소너스 퀀텀 오디오 인터페이스  ·  원본 분류: 특가상품
- [전시상품] PreSonus EarMix 16M 프리소너스 퍼스널 모니터 믹서  ·  원본 분류: 특가상품
- [박스손상] GENELEC 8050B 제네렉 스튜디오 모니터 스피커 (다크그레이)  ·  원본 분류: 특가상품
- [박스손상] KLOTZ AYS-4 클로츠 Short Y 어댑터 케이블 (3.5 TRS ᅳ자 : 2x RCA 암)  ·  원본 분류: 특가상품
- [전시상품] [JICO] 지코 스타일러스 N-44-7 SAS 사파이어 캔틸레버 (SHURE 슈어 M44 호환)  ·  원본 분류: 특가상품
- [전시상품] APOGEE Duet 3 아포지 듀엣3 오디오 인터페이스  ·  원본 분류: 특가상품
- [전시상품] RADIAL SAT-2 레디알 패시브 2채널 모니터 컨트롤러  ·  원본 분류: 특가상품
- [전시상품] SHURE MV7i 슈어 USB-C 스마트 마이크 오디오인터페이스  ·  원본 분류: 특가상품
- [전시상품] DYNAUDIO CORE 47 다인오디오 모니터 스피커 (1조)  ·  원본 분류: 특가상품
- [리퍼비쉬] PreSonus StudioLive 32SC 프리소너스 디지털 믹서  ·  원본 분류: 특가상품
- [전시상품] PreSonus Eris 5 BT GEN2 프리소너스 에리스 2세대 모니터 스피커 1조(2통)  ·  원본 분류: 특가상품
- [리퍼비쉬] ALLEN&HEATH ZED-22FX 알렌히스 FX 기능을 갖춘 다목적 믹서  ·  원본 분류: 특가상품
- [리퍼비쉬] PreSonus StudioLive 64S 프리소너스 디지털 믹서  ·  원본 분류: 특가상품
- [전시상품] APOGEE Duet 3 아포지 듀엣3 오디오 인터페이스  ·  원본 분류: 특가상품
- [전시상품] QED PERFORMANCE Optical Ultra high Speed HDMI 2.1 큐이디 옵티컬 울트라 하이스피드 HDMI 케이블(15m)  ·  원본 분류: 전시상품

