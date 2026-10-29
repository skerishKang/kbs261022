# CGI-1 운영 PC 전환·재고 정기점검 기록 (2026-10-29)

> **목적:** PADIEM CENTRAL CTO 지시에 따라 네이버 스마트스토어 자동등록·재고관리의 주 운영 PC를
> COM1에서 CGI-1으로 전환한다. 기존 349건·장부·계약은 보존하고, 새로 개발하지 않고 main
> `99fa446`(PR #146 병합)을 이어받는다.
>
> **결론:** 오프라인 보존 검증·테스트·읽기 전용 스케줄러 등록은 완료했다.
> **그러나 API 자격증명(`ncom.env`)이 CGI-1에 없어 라이브 API 검증·재고 비교·신규 등록은 0건이며,
> COM1 예약 작업은 접근 실패로 확인·중지하지 못했다.** 중지 완료로 보고하지 않는다(§5).

## 1. 호스트·저장소 기준

| 항목 | 값 |
| --- | --- |
| 호스트 | CGI-1 (`cgi-1`, Tailscale `100.96.184.86`) |
| 작업 디렉터리 | `D:\클로드\261029\cgi-1` |
| 기준 main | `99fa446` — Merge PR #146 (`cgi-local2/ncom-batch9-20261029`) |
| 런타임 | Node v24.20.0 · npm 11.19.0 · Python 3.13.7 · git 2.52.0 · PowerShell 5.1 |
| 브라우저 | Chrome·Edge 설치 확인(라이브 로그인 자동화에는 사용하지 않음) |
| GitHub CLI | `gh` 미설치 — PR·이슈는 REST API/자격증명 헬퍼로 처리 |

## 2. 보존 검증(오프라인, 읽기 전용)

장부 `reports/data/registration/ncom_registration_ledger.json`:

| 항목 | 실측 |
| --- | --- |
| 총 행 | **687** = 등록 349 + 재고동기화 338 |
| 등록 seller code 고유 | 349/349 (중복 0) |
| originProductNo 고유 | 349/349 |
| smartstoreChannelProductNo 고유 | 349/349 |
| 전시 상태 | ON 349/349 |
| 등록 mode | live 349/349 |
| 전시 활성 결과 | `display_activated` 345 + `display_activated_outofstock` 4 |
| 등록 시각 | 2026-10-29T04:02:38Z ~ 2026-10-29T13:33:39Z |
| 준비 CSV 조인 | `smartstore_registration_prep.csv` 349/349 성공, 공급처원본ID 불일치 0 |
| 판매가 근거 | 조인 349건 전원 판매가 숫자>0, `가격확인필요=Y` 0 |
| DB 등록가능 | `등록가능여부_DB=예` 349/349 |

재고동기화 338행:

| action | 건수 | 상태 |
| --- | --- | --- |
| `sync_quantity` | 168 | 전량 `REVERTED`(E25 복원, 168/168) |
| `revert_fallback_quantity` | 168 | 복원 실행 행 |
| `restock` | 2 | 1856·2093, `fallback_1_수량미공개` — **과거 예외(§4)** |

- `fallback_1_수량미공개` 출처 170행 중 168행은 복원됐고, 남은 2행은 재입고(0→1)다.
  이 2행은 수량 출처가 불명확한 과거 쓰기로, **재수정·재동기화하지 않는다.** 현재 원격 상태는
  자격증명 부재로 재조회하지 못했다.
- 이번 전환에서 장부·준비 CSV·운영 상품 정보를 수정하지 않았다(파일 diff 0).

## 3. 가격자료 복구 대조(문의가 1,348건)

`reports/data/registration/bulk/batch9_price_recovery_20261029.json`의 1,348건을
`erp_extended_mapping.csv`·`ecount_item_upload.csv`와 **판매자코드 정확 일치**로 재대조했다.

| 원천 | 대조 결과 |
| --- | --- |
| 공급처 라이브 가격(S1) | 값 있음 0/1,348 |
| CGI 카탈로그(S2) | 값 있음 0/1,348 |
| 수집 DB(S3) | `가격 문의` 1,348 |
| ERP 출고단가(S4) | 값 있음 0/1,348 (`SM-`/`SS-` 품목코드 정확 조인) |
| 공개판매가 매핑(S5) | 값 있음 0/1,348 |

- **복구 0건.** 숫자로 확인되지 않은 가격을 만들지 않는다(허위 가격 금지).
- 참고: 준비 CSV의 `판매가`에는 등록 완료 349건만 값이 있고, 문의가 1,348건은 공란이다.
- Ecount ERP 읽기 로그인은 **1회만 시도**했고 실패했다(§5). 5회 실패 잠금 위험 때문에 재시도하지 않았다.

## 4. 이번 변경(최소 수정)

| 파일 | 변경 | 이유 |
| --- | --- | --- |
| `tools/naver/ncom-stock-sync.mjs` | `selectWritablePlans` 추가 — `stock_source`가 `fallback_*`이거나 미기록인 계획은 apply에서 `blocked_by_source`로 분리, 전송 금지 | 수량 출처 불명확 상품의 쓰기 차단(지시). C21 계약 자체는 변경하지 않음 |
| `tools/naver/run-stock-check.ps1` | 저장소 밖 기록 위치를 `%LOCALAPPDATA%\CGI-Ncom-StockCheck`로 이전(E: 가정 제거), Node 경로 탐색, `run.log`에 시작·결과·종료코드 기록 | COM1·CGI-1 공통 동작, 조용한 실패 방지 |
| `backend/test/unit/ncom-stock-sync-runner.test.mjs` | 쓰기 가드 단위 테스트 추가 | 회귀 고정 |

- C21(재고 동기화 계약)과 등록 계약은 **변경하지 않았다.** CLI가 계약 위에 더 엄격한 운영 가드를 건다.
- 정기 점검은 여전히 `compare`(읽기 전용)만 실행한다.

## 5. 차단·미검증 (완료로 보고하지 않음)

| 항목 | 상태 | 근거 |
| --- | --- | --- |
| API 인증·IP 허용 | **BLOCKED** | `~/.config/cgi-erp/ncom.env` 부재. 환경변수 `NCOM_*` 없음. 라이브 호출 0회 |
| 349건 라이브 불변 재검증 | **BLOCKED** | 위와 동일 — 오프라인 장부·CSV 조인만 수행 |
| 읽기 전용 재고 비교 | **BLOCKED** | 스케줄러 시험 실행이 `NCOM_CLIENT_ID·NCOM_CLIENT_SECRET 필요`로 종료(exit 1) |
| 신규 등록(최대 50건) | **BLOCKED** | 등록 API 호출 불가. 잔여 후보 28건(배치7 재검증 `registrable_now` 123 − 기등록 95)은 실행 시 라이브 재판정 필요 |
| COM1 예약 작업 확인·중지 | **BLOCKED** | Tailscale `padiem-command-center` active(직결), 2222/445/139 포트 열림. 그러나 SMB 공유 열람 오류 5, 직접 공유 경로 없음, SSH `limone` 키 인증 거부. 작업 존재·중지 여부 미확인 |
| Ecount ERP 가격 조회 | **BLOCKED** | 2026-10-29 23:10:16 로그인 1회 실패(비밀번호 1회 오류 안내). 자격증명 불신, 재시도 금지 |
| 소비자 화면 E2E | NOT_VERIFIED | WAF 차단(기존 기록과 동일) |

## 6. 읽기 전용 스케줄러

| 항목 | 값 |
| --- | --- |
| 작업명 | `PADIEM-CGI1-LOCAL2-Ncom-StockCheck` |
| 주기 | 매일 07:30 KST |
| 실행 | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\클로드\261029\cgi-1\tools\naver\run-stock-check.ps1` |
| 실행 계정 | `sji`, LogonType `Interactive`(로그온 중일 때 실행) |
| 기록 | `C:\Users\sji\AppData\Local\CGI-Ncom-StockCheck\run.log` + `stock_sync_plan_YYYY-MM-DD.json` |
| 등록 확인 | `State=Ready`, `NextRunTime=2026-10-30 07:30:30 KST` |
| 시험 실행 | 2026-10-29 23:15:18 KST, `LastTaskResult=1` — 자격증명 부재로 읽기 게이트 차단(로그 기록) |
| 단일 잠금 | CLI `.ncom-stock-sync.lock`(신선한 잠금 거부, 2시간 경과 stale 자동 해제) — 단위 테스트 고정 |

- LogonType이 `Interactive`라 사용자 로그오프 상태에서는 실행되지 않는다. 무인 실행이 필요하면
  운영자 계정 비밀번호를 저장하는 `S4U`/`Password` 등록이 필요하다(관리자 권한·비밀값 비기록 원칙).
- **COM1 작업과의 상호 배제는 보장되지 않는다** — COM1 작업 존재를 확인하지 못했기 때문이다(§5).
  두 호스트가 같은 스토어에 동시에 `apply`하지 않도록, 라이브 쓰기 전 운영자가 COM1 작업을
  비활성화했음을 확인하는 것이 선행 조건이다.

## 7. 테스트 기준선(2026-10-29, CGI-1)

| 구분 | 결과 |
| --- | --- |
| unit | **549/549 PASS** |
| e2e | **286/286 PASS** |
| integration | **19/19 PASS** |
| smoke | **10/10 PASS** |
| `tools/security/scan_secrets.py` | **SECRET SCAN PASS** |

## 8. 다음 조치(차단 해소 순서)

1. 운영자가 CGI-1에 `~/.config/cgi-erp/ncom.env`(NCOM_CLIENT_ID/SECRET)를 안전하게 배치한다. 값은 채팅·커밋·로그에 남기지 않는다.
2. 네이버 커머스API 앱 설정에 CGI-1 공인 IP를 등록한다(미등록 시 `GW.IP_NOT_ALLOWED`).
3. `compare`를 소수 상품으로 먼저 실행해 인증·IP·단건조회를 확인한 뒤, 349건 전수 읽기 비교로 확장한다.
4. 349건 라이브 불변(가격·전시·재고) 재조회 결과를 장부와 대조한다.
5. 잔여 후보 28건을 실행 시점 라이브 재검증 후, 가격·원산지·모델명 근거가 있는 건만 최대 50건 상한 내에서 등록한다(품절 상품은 C10~C12로 등록 가능 유지).
6. COM1 예약 작업을 운영자가 확인·비활성화한 뒤에만 CGI-1에서 라이브 쓰기(apply)를 허용한다.
7. Ecount ERP 자격증명이 확보되면 문의가 1,348건 가격 대조를 재실행한다(현재 0건).
