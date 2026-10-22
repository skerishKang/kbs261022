# CGI 작업보고 표준 — 고객용 및 AI 검토용

## 목적

김범신 대표가 CGI 개발의 진척·실제 결과·다음 단계를 이해할 수 있도록, 작업별로 같은 방식으로 기록합니다. 중앙 CTO 및 LOCAL/ZCode/OpenCode 등 수행 환경에 모두 적용합니다.

## A. 고객용 보고서 (간결하게)

| 항목 | 작성 내용 |
|---|---|
| 작업 제목 | 실제 고객 업무명 |
| 작업 일시·담당 | 날짜, 에이전트/담당 |
| 왜 했는가 | 해결하려는 실제 문제 한두 문장 |
| 무엇을 했는가 | 수행한 작업과 대상 웹사이트·파일 |
| 확인된 결과 | 실증 건수·실제 화면·산출물 링크 |
| 안 된 것 / 미확인 | 기술적·사업적 남은 조건 |
| 다음 순서 | 구체적 후속 작업 및 담당 |
| 문서/PR | GitHub 이슈, PR, 재현 보고서 |

## B. AI 공동검토용 기록

```text
PROJECT=CGI
ISSUE=
PR=
REPOSITORY=skerishKang/kbs261022
WORK_DATE=
AGENT=
MODEL=
DEVICE=
OBJECTIVE=
INPUTS=공개 가능한 입력 목록 또는 비식별 출처
IMPLEMENTED=
EXECUTION_EVIDENCE=
TESTS=
OBSERVED_FACTS=
MODEL_CLAIMS_NOT_INDEPENDENTLY_VERIFIED=
LIMITATIONS=
OUTPUTS=
MERGED=YES/NO
DEPLOYED=YES/NO
LIVE_VERIFIED=YES/NO
REMAINING=
NEXT=
```

### 사실 수준 표기

- **실측:** 실제 실행 로그·파일·화면·접속으로 확인한 결과.
- **보고:** LOCAL 모델이 보고했으나 CENTRAL이 독립 검증하지 않은 결과.
- **추정:** 향후 가능성·예상 소요시간·제안.
- **미실행:** 아직 수행하지 않은 항목.

### GitHub 보고 절차

1. 기존 이슈 중 업무 해당 여부 확인. 없으면 새 이슈 작성.
2. 동일 이슈 아래에 작업 일시, 수행 주체, 실증 증거 및 결과를 기록.
3. 새 코드·문서는 별도 브랜치/PR에 제출하고 이슈 참조.
4. PR 파일·HEAD·테스트·병합·운영 배포 상태를 따로 기록.
5. [작업 현황 목차](CGI_WORK_LOG_INDEX.md)를 결과에 맞춰 갱신.
6. CGI-1의 GitHub 접근이 불가하면 해당 컴퓨터에서 결과물을 보관하고 COM1으로 안전하게 전달해 PR 처리.

### 주의 사항

CGI 전용 저장소 외 다른 고객의 자료를 혼합하지 않습니다. 공개 저장소에는 비공개 ERP·고객 데이터·계정 정보·Secret을 포함하지 않습니다. Google Drive 업로드는 필수 보고 절차가 아닙니다.
