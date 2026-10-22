# CGI-1 → COM1 handoff 실행 테스트 기록 (이슈 #7)

> 실행 환경: CGI-1 / Windows 10 (10.0.22631) / PowerShell 5.1.22621.5909 / git 2.x
> tailscale 1.104.2 / OpenSSH client 9.5 (Windows System32)
> 기록 시각: 2026-10-22 (KST)

## 1. 환경 조사

| # | 항목 | 명령 | 결과 |
|---|---|---|---|
| 1.1 | 로컬 정체 확인 | `hostname` / `whoami` | `CGI-1` / `cgi-1\sji` |
| 1.2 | Tailscale 피어 | `tailscale status` | `100.96.184.86 cgi-1`, `100.124.21.64 padiem-command-center bobkoreacompany@ windows` |
| 1.3 | 왕복 연결 | `tailscale ping padiem-command-center` | `pong … via 121.148.41.4:41642 in 14ms` → **PASS** |
| 1.4 | Tailscale CLI 위치 | `Get-Command tailscale` | PATH에 없음 → `C:\Program Files\Tailscale\tailscale.exe` 사용 |
| 1.5 | COM1 포트 전수 스캔 | 1–65535 비동기 TCP 스캔 | OPEN: 135, 445, **2222**, 5040, 5357, 5491, 5985, 9222, 14176, 14430, 14440, 21300, 21400, 47001, 49664–49670, 55920, 61346 |
| 1.6 | COM1 SSH 배너 | TCP 2222 banner read | `SSH-2.0-OpenSSH_for_Windows_9.5` → **사용 가능 경로** |
| 1.7 | COM1 SSH 인증 방식 | `ssh -p 2222 -o PreferredAuthentications=none sji@100.124.21.64 exit` | `Permission denied (publickey,keyboard-interactive).` |
| 1.8 | Taildrop 대상 확인 | `tailscale file cp --targets` | `100.124.21.64  padiem-command-center` |

## 2. 사용 불가 경로와 근거 (실측)

| 경로 | 시도 | 결과 / 근거 |
|---|---|---|
| SSH 22번 | `Test-NetConnection 100.124.21.64 -Port 22` | `TcpTestSucceeded: False` (닫힘) |
| Tailscale SSH | `tailscale ssh sji@padiem-command-center hostname` | `502 Bad Gateway … dial tcp 100.124.21.64:22: connection failed` (Windows는 Tailscale SSH 서버 미지원) |
| SMB 445 | `net view \\100.124.21.64` | `표준 오류 5(액세스 거부)` / `\\100.124.21.64\IPC$` 접근 불가 → 자격증명 필요 |
| WinRM 5985 | `Invoke-Command -ComputerName 100.124.21.64` | `Kerberos 인증을 … 사용할 수 없습니다 … TrustedHosts를 구성하고 다시 시도` (다른 워크그룹 + TrustedHosts 미설정 + 관리자 권한 없음) |
| DCOM/WMI | `Get-CimInstance -SessionOption (New-CimSessionOption -Protocol Dcom)` | `표준 공급자 오류` (RPC 동적 포트 49152+ 차단) |
| COM1 HTTP 서비스 | 61346 / 47001 GET | 61346 = Tailscale 기본 Hello 페이지(파일 기능 없음), 47001 = 404 |
| GitHub push (CGI-1) | `git push --dry-run` | `could not read Username for 'https://github.com': terminal prompts disabled` / `gh` 미설치 → **CGI-1은 push 불가, COM1로 전달 후 PR 생성** |

## 3. 파이프라인 기능 테스트 (로컬 실증)

대상 소스: `tools/handoff` 폴더 등 비민감 파일

| # | 테스트 | 명령 | 기대 | 결과 |
|---|---|---|---|---|
| 3.1 | 패키징(전송 전 미리보기) | `send-handoff.ps1 -SourcePath …\tools\handoff -DryRun` | 파일 수집 + manifest 생성 | **PASS** — `files=4 skipped=0`, `manifest_sha256=85a81bdc…` |
| 3.2 | 원격 검증 + 승격 (COM1 동작 모사) | `verify-package.ps1 -PackageRoot <staged> -ExpectedRunId <id> -MoveTo <inbox>` | SHA256 전건 일치 후 승격 | **PASS** — `HANDOFF_VERIFY: PASS runId=… files=4 promoted=True`, receipt.json 기록 |
| 3.3 | 위조 파일 탐지 | payload 내 1개 파일에 `TAMPERED` 추가 후 재검증 | 불일치 → FAIL, 승격 금지 | **PASS** — `HANDOFF_FAIL: sha256_mismatch:bootstrap-com1.ps1 expected=ea5cab27… actual=58f06e23…`, `inbox` 미반영, `receipt.result=FAIL` |
| 3.4 | runId 불일치 | 잘못된 `-ExpectedRunId` 지정 | FAIL | **PASS** — `HANDOFF_FAIL: run_id_mismatch expected=… actual=…` |
| 3.5 | 충돌(중복 runId) | 동일 runId 폴더를 inbox에 선행 생성 | `destination_exists`, 기존 파일 보존 | **PASS** — `HANDOFF_FAIL: destination_exists:…`, 선행 파일 `keep.txt` 내용 유지 |
| 3.6 | Taildrop 전송(키 없이) | `tailscale file cp --verbose probe.txt "padiem-command-center:"` | COM1 수신함으로 전송 | **PASS** — `sent "taildrop-test2.txt"`, exit=0 |

## 4. 실제 CGI-1 → COM1 전송

### 4.1 전송 기록

| run_id | 시각 | 수단 | 파일 수 | manifest sha256 | zip sha256 | 결과 |
|---|---|---|---|---|---|---|
| 20261022-120925-92db | 12:09:25 | taildrop | 22 | f7a3d14e… | b4a48db0… | **중단**(스크립트 버그, §5.1) → 12:09:58 재시도 |
| 20261022-120958-17f1 | 12:09:58 | taildrop | 22 | 1dafb137… | 29155d33… | 전송 성공. 단, 다른 에이전트 미커밋 WIP 12개가 섞임 → §5.2로 대체 전송 |
| 20261022-121237-ce96 | 12:12:38 | taildrop | 11 | 16961b86… | 64653da3… | git-tracked only 정상 전송. 이후 `com1-pull.ps1` 기본 newest-only 보강 → 최종본 재전송 |
| **20261022-121435-ccb3** | **12:14:36** | **taildrop** | **11** | **f9fafdd3…** | **fb04aafa…** | **최종 전달본 (COM1에서 이 runId를 사용할 것)** |

최종 전송 콘솔 로그(발췌):

```
HANDOFF_INFO: source=…\wt-issue7-cgi1 files=11 skipped=1 transport=taildrop
HANDOFF_INFO: git_guard tracked_only=true repo=C:\Users\sji\cgi-work\wt-issue7-cgi1 rel= kept=11
HANDOFF_TAILDROP: 2026/10/22 12:14:36 sent "cgi-handoff-20261022-121435-ccb3.zip"
HANDOFF_SENT: transport=taildrop run_id=20261022-121435-ccb3 zip_sha256=fb04aafa… manifest_sha256=f9fafdd3…
```

> COM1 수신함에는 위 3개 패키지가 쌓여 있다. `com1-pull.ps1`는 **최신 1건만** 처리하도록 기본값이 잡혀 있고
> (`PULL_INFO: newest_only=true skipped_packages=…`), 1 linersequence도 최신 zip을 선택한다. 이전 2건은 폐기해도 된다.

### 4.2 수신측 절차 리허설(CGI-1에서 COM1 명령을 그대로 재현)

```
$ Expand-Archive … ; verify-package.ps1 -PackageRoot <staged> -ExpectedRunId <run> -MoveTo <inbox>
HANDOFF_VERIFY: PASS runId=20261022-120958-17f1 files=22 promoted=True
```

→ COM1에서 실행할 §4.2(문서) 1 linersequence가 **동일한 결과**를 낼 것이 확인됨(압축 해제 → SHA256 대조 → 승격 → receipt 기록).

### 4.3 git-tracked guard 테스트

| 대상 | 결과 |
|---|---|
| 내 격리 worktree (`wt-issue7-cgi1`) | `kept=11` (커밋된 파일만) — **PASS** |
| 공유 작업 트리 (상대 에이전트 작업 중) | `kept=9`, 미커밋 12개 제외 (`reports/*`, `tools/product_master/*`, `tools/handoff/{handoff-common.ps1, handoff.config.psd1, receive_to_pr.ps1, send_to_com1.ps1, verify_handoff.ps1}`) — **PASS** |

## 5. 문제·해결 기록

### 5.1 `tailscale` stderr를 PowerShell이 오류로 처리 → 스크립트 중단

- 증상: `HANDOFF_TAILDROP: … sending …` 출력 직후 스크립트 종료(exit=1), 전송 자체는 진행됨.
- 원인: `$ErrorActionPreference='Stop'` 상태에서 네이티브 명령의 stderr가 terminating error로 승격됨.
- 해결: `Invoke-NativeCmd` 헬퍼 도입(호출 동안 `ErrorActionPreference='Continue'`, stderr를 로그로 수집, 종료코드 반환).
- 재발 여부: 수정 후 동일 명령 재실행 → exit=0, `sent …` 확인.

### 5.2 다른 에이전트 WIP가 전송 패키지에 섞임

- 증상: 첫 실제 전송(12:09:58)의 22개 파일에 상대 에이전트의 미커밋 파일(`reports/data/_browser_dump_*.json`, `tools/product_master/*.py`, `tools/handoff/send_to_com1.ps1` 등 12개)이 포함됨.
- 원인: 두 에이전트가 **같은 working tree**(`C:\Users\sji\cgi-work\kbs261022`)를 사용 중. 상대 에이전트가 브랜치를 `feat/issue-7-cgi1-to-com1-handoff`로 생성·전환하면서 내 커밋 위에 WIP를 얹었고, 소스 폴더 단위 전송은 미커밋 파일을 구분하지 못함.
- 해결 ①(격리): `git worktree add -b feature/issue-7-handoff-cgi1 C:\Users\sji\cgi-work\wt-issue7-cgi1` 로 전용 작업 디렉터리를 만들고, 공유 트리에서 내 변경분(3 tracked + 2 untracked)을 **해시 동일성 확인 후** 복원 → 상대 에이전트 작업 트리는 원 상태 유지.
- 해결 ②(코드): `send-handoff.ps1`에 **git guard** 도입 — 소스가 git 워크트리면 `git ls-files` 기준으로 **커밋된 파일만** 패키징(`-IncludeUntracked`로 해제 가능). 재전송(12:12:38) 결과 11개 파일, 상대 WIP 0개.
- 잔여: 공유 트리에서 COMMIT된 상대 산출물은 다음 전송에 포함된다(정상 동작).

### 5.3 git guard 초기 구현 오류 2건 (자체 해결)

| 오류 | 증상 | 해결 |
|---|---|---|
| 경로 구분자 불일치 | worktree에서 `kept=0` (전부 제외) | git이 `/`를, PowerShell이 `\`를 반환 → `\`로 정규화 후 비교 |
| `ls-files -z` 파싱 | NUL 구분 출력이 한 덩어리로 들어와 집합 구성 실패 | `-z` 제거 후 줄 단위 파싱, 인용 경로 unquote 처리 |

두 오류 모두 "실패 시 안전하게 전송하지 않음"(kept=0 → `HANDOFF_ABORT: no_files_to_transfer`)으로 차단되어 잘못된 전송은 발생하지 않았다.

### 5.4 COM1측 공개키 미등록

- 상태: 사용자가 COM1 접근 불가로 판단 → 2026-10-22 기준 SSH(무인) 경로는 **미검증**.
- 대체: Taildrop 경로(키 불필요)로 실제 전송·리허설까지 완료(§4).
- 잔여: COM1에서 §5(문서) 부트스트랩 1회 실행 후 `-Transport ssh` 무인 경로 사용 가능.

## 6. 남은 항목 (COM1 실행 필요)

| # | 항목 | 상태 |
|---|---|---|
| 6.1 | COM1에서 Taildrop 패키지 pull·검증 (`com1-pull.ps1` 또는 1 linersequence) | 대기 — COM1 명령 1회 |
| 6.2 | receipt 회신 수신 및 대조 (`check-receipt.ps1`) | 6.1 후 자동 가능 |
| 6.3 | COM1에서 작업 트리 반영 및 PR 생성 (`apply-handoff.ps1` → git push → `gh pr create`) | 대기 — COM1의 GitHub 자격증명 필요 |
| 6.4 | COM1 공개키 등록 후 SSH 무인 경로 실검증 | 대기 — COM1 1회 부트스트랩 |
| 6.5 | 이슈 #7에 PR 링크 연결 | PR 생성 후 |
