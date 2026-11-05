# fixtures — 테스트 전용 견본

- `sample_*.json` 파일은 **공공데이터포털 공개 문서의 응답 예시 양식을 본뜬 견본**이다. 실제 수집 결과가 아니다.
- 개찰결과 예비가격상세(`sample_openg_result_prepar_pc_detail_thng.json`)는 **★미검증(키 발급 후 확정)**:
  operation명(`getOpengResultListInfoThngPreparPcDetail`)과 응답 필드명은 공개 문서·스키마 확인분이며,
  실호출 응답과 다를 수 있다. 키 발급 후 실응답으로 확정할 때까지 이 견본은 응답 구조 가정 검증에만 쓴다.
- **이 폴더의 견본은 bid/assets/data 산출물(bid-data.js·rate-stats.js·result-data.js)에 절대 섞이지 않는다.**
  빌드 입력은 `data/procurement/`·`reports/data/procurement/`의 실수집 파일뿐이다(빌드 스크립트가 이 폴더를 읽지 않는다).
- 견본 수정 규칙: 실응답 확정 시 견본을 실구조로 교체하고, 파일명에서 `sample` 표기는 유지한다.
