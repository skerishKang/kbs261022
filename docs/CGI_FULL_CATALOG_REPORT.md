# 작업보고서 — 전체 상품 조사·수집·DB 제작 (이슈 #19)

> 형식: `docs/CGI_WORK_REPORT_STANDARD.md` (PR #10) §A 고객용 / §B AI 공동검토용 규약 준수.

## A. 고객용 보고서

| 항목 | 작성 내용 |
|---|---|
| 작업 제목 | 공급처 전체 상품 조사·수집 및 상품 마스터 DB(엑셀) 제작 |
| 작업 일시·담당 | 2026-10-22 · CGI-1 LOCAL 에이전트(OpenCode) |
| 왜 했는가 | 김범신 대표가 말씀한 "약 20,000개 상품"의 실제 범위를 규명하고, 확보 가능한 상품 데이터를 전부 수집해 CGI 상품 DB·쇼핑몰 등록 자료로 제공하기 위해서. 이카운트 ERP는 상품 데이터 확보 이전 단계이므로 이번 범위에서 제외했다. |
| 무엇을 했는가 | ① 기존 분석(PR #6/#12/#13)의 수집기·카테고리 구조·API 분석을 **재사용**하고 전량 재수집: 삼아사운드 2,281건 + 삼아스토어 2,294건 = **4,575건** 원천 상품(상세 100%, 오류 0) ② 누락 점검: "전체상품" 뷰 밖 52건, 사이트맵 밖 697건, **사이트 검색 인덱스에만 있는 330건(브랜드 37개 표본)** 발견 ③ 추가 공급처 후보 실측(카페24 원본 샵/삼아CDS/브랜드 카탈로그/브랜드 셀렉터) ④ 7시트 엑셀 + 쇼핑몰용 JSON 생성 ⑤ 실제 브라우저로 48건 계층화 표본 교차검증(4필드 48/48 일치) ⑥ 약 20,000개 주장 근거 분석 |
| 확인된 결과 | **실측**: 원천 상품 4,575건(상세 4,575건 100%), 이미지 4,575건, 공개 판매가 2,117건·가격 문의 2,370건·판매완료 87건, 옵션·구성 SKU 4,233행, 중복 후보 62그룹, 통합 후보 키 4,499개. 브라우저 교차검증 48/48 완전 일치(불일치율 0%). 엑셀 7시트·카탈로그 JSON 생성 완료. |
| 안 된 것 / 미확인 | ① **약 20,000개는 공개 경로로 확인되지 않음(UNVERIFIED)** — 목록 크롤 4,575건 + 옵션 전개 4,233건 ≈ 9,100건 수준이며 20,000에 이르지 않는다. 가장 가까운 공개 경로는 브랜드 카탈로그(fliphtml5 98종/1,720페이지)이나 이는 "판매 가능 상품"이 아니라 브랜드별 모델 목록 문서다 ② 삼아스토어 검색은 AJAX 라 검색 총건수 대조가 브랜드 1개에서만 가능했고, 삼아사운드도 37개 브랜드 표본만 대조했다(전량 아님) ③ 검색 전용 상품 330건(표본)은 별도 수집 경로가 필요해 이번 산출물(4,575건)에는 포함되지 않았다 ④ 공급가·재고·CGI 판매가·네이버 카테고리 ID는 공개 근거가 없어 전부 미확정(공란) ⑤ 엑셀 원본 3.2MB·카탈로그 JSON 20MB는 대용량이므로 CGI-1 로컬 보관, 공개 저장소에는 재현 스크립트·경량 CSV·보고서만 제출 ⑥ 실제 네이버 등록·ERP 변경 없음 |
| 다음 순서 | ① 대표 확인: "20,000"의 근거(브랜드 카탈로그 모델 수 기준인지, 도매/미노출 포함인지) ② 검색 인덱스 전용 상품 전량 수집 경로 확정(공개 검색 페이지 순회) ③ 네이버 표준 카테고리 기준표 확보 → 매핑 확장 ④ 이미지 자체 보관 정책 결정 ⑤ 대표 판매가 승인 절차 정의 후 `cgi_sale_status` 전환 |
| 문서/PR | 이슈 [#19](https://github.com/skerishKang/kbs261022/issues/19) · 브랜치 `feature/issue-19-full-catalog` · 상세 [`CGI_FULL_CATALOG_ANALYSIS.md`](./CGI_FULL_CATALOG_ANALYSIS.md) · AI용 기록 [`CGI_FULL_CATALOG_TESTLOG.md`](./CGI_FULL_CATALOG_TESTLOG.md) |

## B. AI 공동검토용 기록

```text
PROJECT=CGI
ISSUE=#19
PR=브랜치 feature/issue-19-full-catalog (PR 링크는 본 문서 하단 참고)
REPOSITORY=skerishKang/kbs261022
WORK_DATE=2026-10-22
AGENT=OpenCode LOCAL 에이전트 (CGI-1, Windows 10.0.22631)
MODEL=minimax-m3.1-flash-free (OpenCode 제공 경유)
DEVICE=CGI-1 / Tailscale 100.96.184.86
OBJECTIVE=공급처 공개 상품 전체를 조사·수집해 상품 마스터 DB(엑셀)와 쇼핑몰용 JSON을 만들고, "약 20,000개" 주장의 근거를 확인한다.
INPUTS=공개 정보만 사용. PR #12 수집 스킬(수집기·파서 재사용), PR #13/PR #12 공개 샘플, 양 사이트 공개 목록·상세·사이트맵·검색, 브랜드 카탈로그(fliphtml5), 브랜드 셀렉터(s1forum)
IMPLEMENTED=tools/full_catalog/run_full_collection.py(전수 수집 드라이버: 카테고리 스위프·목록 크롤·상세 크롤·URL 캐시), collect_cgi_catalog.py(PR #12 파서 원본 vendoring), build_product_db.py(7시트 엑셀·JSON·중복후보·매핑 시트), browser_verify.mjs(계층화 표본 브라우저 교차검증), search_completeness.mjs(검색 총건수 대조), investigate_sources.mjs(공급처 관계 조사)
EXECUTION_EVIDENCE=수집 로그 C:/cgi-work/catalog-data/collect.log(카테고리 361/532, 목록 unique 2281/2294, 상세 2281/2294, 오류 0, 캐시 8,054 URL), product_db.xlsx — **main 커밋본 3,176,083B / sha256 ee61ac545e51b043ad2fd9943b49e1595a14a8f00286b43a388e8c38cf48475f (8시트)**. 이 문서가 실행 당시 적었던 3,232,987B·sha256 0ba13a1d… 는 로컬 매니페스트 값(3,232,988B·fef5d6a2…)과도 달라 **근거 불명**, 2026-10-23 정정. catalog.full.json(20,166,800B, 로컬 보존), browser_verification.json(48/48 일치), search_completeness.json(37브랜드 대조 +330건), docs/screenshots·`reports/samples/` 6종
TESTS=브라우저 교차검증 48건(이름·가격·이미지·옵션 각 48/48 일치, 오류 0) / 검색 총건수 대조 37브랜드 / 카테고리 뷰별 상품 수 3종 재계산 / 사이트맵·검색 대조 / 공급처 후보 8개 도메인 실측
OBSERVED_FACTS=삼아사운드 2,281건(카테고리 361, cate23 2,229 / cate24 2,211 / cate25 2,053), 삼아스토어 2,294건(카테고리 532). samamusic.co.kr ≡ samastore.co.kr ≡ sama2015.cafe24.com(동일 카페24 샵, 동일 sitemap 2,136). samassi.cafe24.com ≡ www.samasound.co.kr. samacds.co.kr 은 상품 URL 0. 삼아사운드 검색 총건수가 카테고리 목록보다 330건 많음(37브랜드 표본, Rean +139·Neutrik +100·Shure +45·EV +41). 삼아스토어 sitemap 1,597 < 목록 2,294(697 누락). 공개 판매가 2,117(46.3%)·가격 문의 2,370(51.8%)·판매완료 87. 옵션·구성 4,233행(삼아스토어만, 삼아사운드 0). 중복 후보 62그룹 138행.
MODEL_CLAIMS_NOT_INDEPENDENTLY_VERIFIED=브랜드 카탈로그(fliphtml5 98종/1,720페이지)의 모델 언급 총수(페이지 수까지만 실측), 삼아스토어 검색 총건수(AJAX), 대표님 "약 20,000"의 원래 근거.
LIMITATIONS=검색 인덱스 전용 상품은 미수집(별도 경로 필요). 검색 대조는 삼아사운드 37브랜드 표본·삼아스토어 1브랜드. 공급가·재고·CGI 판매가·네이버 카테고리 ID 미확정. `catalog.full.json`(20,166,800B)과 원천 상세 JSON은 main 에 없고 로컬에 보존(`git ls-files` 로 확인). **엑셀 DB는 공개 저장소에 커밋된 상태**(`data/full_catalog/product_db.xlsx`, 2026-10-22 병합분). 실제 네이버 등록·ERP 조작 없음.
OUTPUTS=tools/full_catalog/ 6종, docs/CGI_FULL_CATALOG_ANALYSIS.md, docs/CGI_FULL_CATALOG_REPORT.md, docs/CGI_FULL_CATALOG_TESTLOG.md, data/full_catalog/product_db_compact.csv, data/full_catalog/options_compact.csv, data/full_catalog/collection_stats.json, data/full_catalog/search_completeness.json, data/full_catalog/browser_verification.json · **main 정본:** data/full_catalog/product_db.xlsx(8시트)·data/full_catalog/category_catalog.csv·site/data/products.json(4,575건)·reports/samples/ 6종
MERGED=YES (PR #27 2026-10-22 16:31 KST · PR #28 2026-10-22 16:35 KST 병합. 본 문서는 실행 당시 스냅샷이며 위 4행은 2026-10-23 main 실측으로 정정)
DEPLOYED=NO (정적 산출물. 엑셀 원본은 CGI-1 로컬 C:\cgi-work\catalog-data\product_db.xlsx)
LIVE_VERIFIED=YES (수집 대상 4,575건 전량 HTTP 확보, 표본 48건은 실제 브라우저 렌더와 대조 완료)
REMAINING=검색 인덱스 전용 상품 전량 수집, 대표 "20,000" 근거 확인, 네이버 카테고리 매핑, 이미지 보관 정책, 대표 판매가 승인 절차
NEXT=대표 확인 후 (1) 검색 페이지 순회 수집 경로 추가 (2) 카테고리 매핑표 반영 (3) 스마트스토어 개설 후 등록 자료 생성
```

### 사실 수준 표기

- **실측:** 수집 로그·브라우저 렌더·파일 해시로 확인한 내용.
- **보고:** 표본 기반 추정(브랜드 37개 대조 결과의 전량 외삽, 브랜드 카탈로그 모델 언급 수).
- **추정:** 대표님 "약 20,000"이 브랜드 카탈로그 모델 수 기준일 가능성.
- **미실행:** 실제 네이버 등록, ERP 변경, 이미지 재호스팅, 대표 승인 판매가.

### 공개 범위 준수

- 공급처 공개 상품 정보만 수집·게시. 계정·Secret·고객 정보 없음. 로그인·장바구니·주문·ERP 쓰기 없음.
- robots.txt Disallow 경로 미방문, 공개 GET 만 사용, 지연·동시 제한 적용, URL 캐시로 재실행 시 네트워크 0.
- Google Drive 업로드 없음.
