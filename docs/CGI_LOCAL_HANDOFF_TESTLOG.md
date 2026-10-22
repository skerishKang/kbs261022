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
| 1.8 | Taildrop 기능 | `tailscale file cp --targets` | `100.124.21.64  padiem-command-center` |

## 2. 사용 불가 경로와 근거 (실측)

| 경로 | 시도 | 결과 / 근거 |
|---|---|---|
| SSH 22번 | `Test-NetConnection 100.124.21.64 -Port 22` | `TcpTestSucceeded: False` (닫힘) |
| Tailscale SSH | `tailscale ssh sji@padiem-command-center hostname` | `502 Bad Gateway … dial tcp 100.124.21.64:22: connection failed` (Windows는 Tailscale SSH 서버 미지원) |
| SMB 445 | `net view \\100.124.21.64` | `표준 오류 5(액세스 거부)` / `\\100.124.21.64\IPC$` 접근 불가 → 자격증명 필요 |
| WinRM 5985 | `Invoke-Command -ComputerName 100.124.21.64` | `Kerberos 인증을 … 사용할 수 없습니다 … TrustedHosts를 구성하고 다시 시도` (다른 워크그룹 + CGI-1에 TrustedHosts 미설정 + 관리자 권한 없음) |
| DCOM/WMI | `Get-CimInstance -SessionOption (New-CimSessionOption -Protocol Dcom)` | `표준 공급자 오류` (RPC 동적 포트 49152+ 차단, 열린 49664–49670은 타 서비스) |
| COM1 HTTP 서비스 | 61346 / 47001 GET | 61346 = Tailscale 기본 Hello 페이지(파일 기능 없음), 47001 = 404 |
| GitHub push (CGI-1) | `git push --dry-run` | `could not read Username for 'https://github.com': terminal prompts disabled` / `gh` CLI 미설치 → **CGI-1은 push 불가, COM1로 전달 후 PR 생성** |

## 3. 파이프라인 기능 테스트 (로컬 실증, 2026-10-22)

대상 소스: `C:\Users\sji\cgi-work\kbs261022\tools\handoff` (4개 파일, 비민감)

| # | 테스트 | 명령 | 기대 | 결과 |
|---|---|---|---|---|
| 3.1 | 패키징(전송 전 미리보기) | `send-handoff.ps1 -SourcePath …\tools\handoff -DryRun` | 파일 수집 + manifest 생성 | **PASS** — `files=4 skipped=0`, `manifest_sha256=85a81bdc…` |
| 3.2 | 원격 검증 + 승격 (COM1 동작 모사) | `verify-package.ps1 -PackageRoot <staged> -ExpectedRunId <id> -MoveTo <inbox>` | SHA256 전건 일치 후 승격 | **PASS** — `HANDOFF_VERIFY: PASS runId=… files=4 promoted=True`, receipt.json 기록 |
| 3.3 | 위조 파일 탐지 | payload 내 1개 파일에 `TAMPERED` 추가 후 재검증 | 불일치 → FAIL, 승격 금지 | **PASS** — `HANDOFF_FAIL: sha256_mismatch:bootstrap-com1.ps1 expected=ea5cab27… actual=58f06e23…`, `inbox` 미반영 확인, `receipt.result=FAIL` |
| 3.4 | runId 불일치 | 잘못된 `-ExpectedRunId` 지정 | FAIL | **PASS** — `HANDOFF_FAIL: run_id_mismatch expected=… actual=…` |
| 3.5 | 충돌(중복 runId) | 동일 runId 폴더를 inbox에 선행 생성 | `destination_exists`, 기존 파일 보존 | **PASS** — `HANDOFF_FAIL: destination_exists:…`, 선행 파일 `keep.txt` 내용 그대로 유지 |
| 3.6 | Taildrop 전송(키 없이) | `tailscale file cp --verbose probe.txt "padiem-command-center:"` | COM1 수신함으로 전송 | **PASS** — `sent "taildrop-test2.txt"`, exit=0 |

## 4. 실제 CGI-1 → COM1 전송 (공개키 등록 후)

| # | 항목 | 결과 |
|---|---|---|
| 4.1 | COM1 공개키 등록 | (사용자 부트스트랩 실행) |
| 4.2 | SSH 연결 확인 | |
| 4.3 | 실제 폴더 전송 | |
| 4.4 | COM1 원격 SHA256 검증 | |
| 4.5 | 충돌/중복 재전송 동작 | |
| 4.6 | COM1 → GitHub PR | COM1의 GitHub 자격증명으로 진행(CGI-1은 인증 없음) |

> 위 표는 COM1 부트스트랩 완료 후 갱신한다.
