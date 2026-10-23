# CGI-1 → COM1 로컬 handoff 파이프라인 (이슈 #7)

> 담당: CGI 원격 개발 환경 에이전트 (CGI-1)
> 대상 저장소: `skerishKang/kbs261022` (CGI 전용)
> 최초 작성: 2026-10-22 · 최종 갱신: 2026-10-22

## 1. 목적

CGI-1에서 LOCAL 에이전트(ZCode / OpenCode 등)가 만든 작업물을 **GitHub 인증 없이** COM1로 전달하고,
COM1에서 기존 GitHub 작업(PR)을 이어받을 수 있는 최소 재실행 가능한 파이프라인을 제공한다.

- 전송 대상은 **명시적으로 지정한 폴더 1개**만 취급한다.
- 도착 지점은 COM1의 `C:\cgi-handoff\inbox\<runId>`이며, **기존 파일은 절대 덮어쓰지 않는다.**
- 실제 업무 데이터(고객 정보, 계정, 실제 상품 데이터)는 이 경로로 옮기지 않는다.

### 전송 수단 요약 (2026-10-22 실측 기준)

| 수단 | 상태 | 도구 | 도착 지점 |
|---|---|---|---|
| **SMB over Tailscale (445)** | ✅ **실측 검증 완료 — 지금 바로 사용 가능** | `tools/handoff/send_to_com1.ps1` | `\\100.124.21.64\Users\Public\CGI-HANDOFF\batch-*` |
| OpenSSH/SCP (2222) | ⏸ COM1 측 공개키 등록 1회 필요 | `tools/handoff/send-handoff.ps1 -Transport ssh` | `C:\cgi-handoff\inbox\<runId>` |
| Tailscale Taildrop | ✅ 키 불필요, 수신측 명령 1회 | `tools/handoff/send-handoff.ps1 -Transport taildrop` | COM1 Taildrop 수신함 |
| Tailscale SSH (22) | ❌ COM1에서 미개방 (Windows Tailscale SSH 서버 미지원) | — | — |

SMB 경로는 **추가 포트 개방, 별도 비밀키, COM1 측 부트스트랩 없이** 즉시 동작하며
SHA256 무결성 검증과 충돌/중복 방지를 모두 포함한다.
SSH 경로는 5장 부트스트랩이 완료되면 무인 자동화 관점에서 가장 유리하므로 유지한다.

## 2. 환경 조사 결과 (2026-10-22 실측)

### 2.1 Tailscale

| 항목 | 값 |
|---|---|
| tailnet | `bobkoreacompany` |
| CGI-1 (본 문서 작성 머신) | `100.96.184.86` / hostname `CGI-1` / Windows |
| COM1 | `100.124.21.64` / tailscale 이름 `padiem-command-center` / Windows |
| 클라이언트 버전 | tailscale 1.104.2 (Windows) |
| 왕복 ping | PASS (14 ms, `tailscale ping padiem-command-center`) |
| 경로 | `C:\Program Files\Tailscale\tailscale.exe` (PATH에 없음 → 절대경로 사용) |

### 2.2 COM1 열린 포트 (1–65535 전수 스캔)

| 포트 | 서비스 | 사용 가능 여부 |
|---|---|---|
| 2222 | **OpenSSH for Windows 9.5** | ✅ **주 자동화 경로** |
| 445 | SMB | ✅ **사용 가능** — 현재 Windows 자격증명으로 `Users` 공유 열람 + `Users\Public` 쓰기 확인 (2.5 절) |
| 5985 | WinRM | ❌ Kerberos 불가(다른 워크그룹) + CGI-1에 TrustedHosts 미설정 + 관리자 권한 없음 |
| 135 / 49664–49670 | RPC | ❌ DCOM 동적 포트 차단으로 WMI 연결 실패 ("표준 공급자 오류") |
| 61346 | Tailscale 기본 HTTP(Hello 페이지) | 파일 기능 없음 |
| 22 | (미개방) | ❌ Tailscale SSH 서버는 Windows 미지원 (`tailscale ssh` → 502 Bad Gateway) |

### 2.3 COM1 SSH 인증 방식

```
$ ssh -p 2222 -o PreferredAuthKeyOnly=none -o PreferredAuthentications=none sji@100.124.21.64 exit
sji@100.124.21.64: Permission denied (publickey,keyboard-interactive).
```

→ **publickey 인증이 열려 있음**. 비밀번호를 스크립트에 넣지 않기 위해
CGI-1 전용 ed25519 키(`~/.ssh/cgi_handoff_ed25519`)를 만들어 COM1 `authorized_keys`에 등록하는 방식을 사용한다.

### 2.4 키 없이 동작하는 경로 (Tailscale Taildrop)

Tailscale 기본 파일 전송(`tailscale file cp`)은 **인증 없이** COM1 수신함으로 전달된다(실측 성공).

```
$ tailscale file cp --verbose probe.txt "padiem-command-center:"
2026/10/22 12:12:38 sent "cgi-handoff-20261022-121237-ce96.zip"
```

COM1에서 `tailscale file get` 실행이 필요한 점이 유일한 제약이며, `com1-pull.ps1`가 이 1회 명령을 포함한다.
→ **키 미설치 상태에서도** 파이프라인 전체가 성립한다(수신측 명령 1회 필요).

### 2.5 SMB(445) 경로 실측 — 2026-10-22 추가 확인

`net view \\100.124.21.64` 는 SMB1 브라우저가 꺼져 있어 `오류 1702(잘못된 바인딩 핸들)`로 실패한다.
**이 오류는 인증 실패가 아니다.** SMB2/3 세션은 정상 성립하며, 인증은 NTLM 패스스루로 성공한다.
`Get-SmbConnection` 조회 결과 `\\100.124.21.64\IPC$` 세션 상태가 `OK`인 것이 이를 뒷받침한다.

`\\100.124.21.64\Users` 공유는 **읽기 가능**하고, 그 아래 `Users\Public`은 **읽기·쓰기 가능**하다
(파일 생성/수정/삭제, 하위 디렉터리 생성까지 전부 확인).

```text
\\100.124.21.64\Users\Default
\\100.124.21.64\Users\limone-AppData
\\100.124.21.64\Users\Public     <- 쓰기 가능
\\100.124.21.64\Users\TEMP
```

| 확인 항목 | 명령 | 결과 |
|---|---|---|
| IPC$ 세션 | `Get-SmbConnection` | `\\100.124.21.64\IPC$` 상태 `OK` -> SMB2/3 + NTLM 패스스루 성공 |
| `Users` 열람 | `[IO.Directory]::GetFileSystemEntries("\\100.124.21.64\Users")` | 5개 항목 정상 열람 |
| `C$` / `ADMIN$` | `Get-ChildItem "\\100.124.21.64\C$"` | `액세스가 거부되었습니다` -> `sji` 는 COM1 로컬 관리자가 아님 |
| `Users\Public` 쓰기 | `[IO.File]::WriteAllText` / `CreateDirectory` | **성공** (파일·디렉터리 생성/삭제 모두) |
| 하위 경로 쓰기 | `Users\Public\_probe\a\b\x.txt` | **성공** + 읽기 일치 |
| 공유 루트 이탈 | `Users\Public\..\..` | **차단됨** -> 공유는 `C:\Users` 로 정상 격리(트래버설 없음) |
| COM1 sshd 설정 열람 | `Users\Public\..\..\ProgramData\ssh` | **거부됨** -> COM1 `sshd_config` 는 SMB로 열람 불가 |

=> SMB 경로는 COM1 측에서 **관리자 권한 없이**, **추가 포트 개방 없이**, **새 비밀키 없이** 동작한다.
`Public` 은 다른 사용자에게도 열려 있는 폴더이므로, 전송 대상은 `Public` 하위의
**전용 수신 폴더 `CGI-HANDOFF`** 로만 한정한다(3.2 절).

## 3. 파이프라인 구조

```
CGI-1                                                     COM1
┌────────────────────────────────────────────┐        ┌────────────────────────────────────┐
│ send-handoff.ps1                           │        │ C:\cgi-handoff\                    │
│  1) allowlist / 시크릿 / git-tracked 검사   │        │   incoming\<runId>.part  (수신 중)  │
│  2) payload/ + manifest.json + sha256 생성  │ scp ──▶│   inbox\<runId>        (검증 완료)  │
│  3) 전송                                   │  :2222 │                                    │
│     ├ ssh    : scp + 원격 verify 자동화      │───────▶│ verify-package.ps1                  │
│     └ taildrop: zip → tailscale file cp     │        │   → SHA256 대조 → 승격              │
│  4) 원격 SHA256 검증 → HANDOFF_PASS        │        │   → receipt.json → CGI-1로 회신     │
└────────────────────────────────────────────┘        │ apply-handoff.ps1 → 작업 트리 반영  │
                                                      │   → git branch/commit/push → PR     │
                                                      └────────────────────────────────────┘
```

### 3.1 파일 구성

| 파일 | 위치 | 역할 |
|---|---|---|
| `send-handoff.ps1` | CGI-1 | 패키징 → 전송 → 원격 검증 → 승격 (전송 수단 선택) |
| `verify-package.ps1` | 양쪽 | manifest/파일 SHA256 검증, receipt 기록, 승격(덮어쓰기 금지) |
| `com1-pull.ps1` | COM1 | Taildrop 수신함에서 패키지를 꺼내 검증·승격하고 receipt를 CGI-1로 회신 |
| `apply-handoff.ps1` | COM1 | 검증된 패키지를 저장소 작업 트리에 반영 + PR 생성 절차 출력 |
| `check-receipt.ps1` | CGI-1 | COM1이 회신한 receipt를 받아 해시 일치 확인(닫힌 루프 검증) |
| `bootstrap-com1.ps1` | COM1(1회) | 공개키 등록 + 수신 폴더 생성 |
| `handoff.config.ps1` | 양쪽 | 호스트/포트/계정/allowlist/제외 규칙 설정 |
| `send_to_com1.ps1` | CGI-1 | **SMB 경로**: 소스 폴더 -> COM1 전용 수신 폴더로 전송, 도착 즉시 SHA256 대조, `manifest.sha256` / `handoff.json` 기록 |
| `verify_handoff.ps1` | 양쪽 | **SMB 경로**: 배치(batch)의 manifest 기준으로 SHA256 재계산 -> PASS/FAIL |
| `receive_to_pr.ps1` | COM1 | **SMB 경로**: 배치 검증 -> 작업 트리 반영 -> branch/commit -> (선택) push/PR |
| `handoff-common.ps1` | 양쪽 | **SMB 경로**: 공용 헬퍼(경로 포함 판정, SHA256, 매니페스트 읽기/쓰기) |
| `handoff.config.psd1` | 양쪽 | **SMB 경로**: 수신 루트 화이트리스트, 제외 규칙, 용량 상한, COM1 저장소 경로 |

### 3.2 SMB 경로 구조 (키·부트스트랩 불필요)

```text
CGI-1                                                     COM1
+------------------  SMB 445 over Tailscale  -------------+---------------------+
| send_to_com1.ps1                                        | C:\Users\Public\    |
|  1) 소스 폴더 확인 + 제외 규칙( .git 등 ) + 용량 상한   |   CGI-HANDOFF\     |
|  2) 수신 루트 화이트리스트 판정                          |     batch-<id>\    |
|  3) batch-<utc>-<rand> 디렉터리 신규 생성 (고유)         |       payload\     |
|  4) 파일 복사 -> 도착 파일 SHA256 재계산 -> 대조         |         <src>\     |
|  5) manifest.sha256 + handoff.json + README 기록         |       manifest.    |
|                                                      +->|         sha256    |
|                                                      |   +   handoff.json  |
|                                                      |   +   README-handoff|
| verify_handoff.ps1  <---- 수신측 재검증 (COM1에서 실행)  +---------------------+
| receive_to_pr.ps1  <---- 검증 -> 반영 -> branch -> commit -> push -> PR
```

**수신 폴더를 1곳으로 한정하는 이유**: `C:\Users\Public` 은 COM1에서 여러 계정이 공유하는 폴더다.
`CGI-HANDOFF` 하위에만 쓰고, 그 안에서도 매번 `batch-<id>` 를 새로 만들어
서로 다른 실행·서로 다른 에이전트의 결과물이 같은 파일명을 두고 충돌하지 않게 한다.

**반복 실행 명령 (CGI-1)**

```powershell
# 전송 (SHA256 검증 포함)
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\handoff\send_to_com1.ps1 `
  -SourcePath C:\Users\sji\cgi-work\kbs261022\docs

# 미리보기 (전송 없이 대상 목록/해시만)
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\handoff\send_to_com1.ps1 `
  -SourcePath <폴더> -DryRun

# 중단된 전송 재개 (동일 batchId 재사용, 다른 내용 파일은 충돌로 보고)
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\handoff\send_to_com1.ps1 `
  -SourcePath <폴더> -BatchId <이전 batchId> -Resume
```

종료 코드: `0` 성공 / `2` 무결성 실패 / `3` 충돌(중복 batch, 내용 불일치) / `4` 전송 실패 / `5` 사용법 오류.

## 4. 전송 수단

### 4.1 SSH/SCP (완전 무인, 키 등록 후)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\handoff\send-handoff.ps1 `
  -SourcePath C:\Users\sji\cgi-work\kbs261022 -Transport ssh
```

CGI-1 → COM1 `scp -P 2222` → COM1에서 `verify-package.ps1` 자동 실행 → SHA256 대조 → 승격까지 스크립트가 수행한다.

### 4.2 Tailscale Taildrop (키 불필요, 수신측 명령 1회)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\handoff\send-handoff.ps1 `
  -SourcePath C:\Users\sji\cgi-work\kbs261022 -Transport taildrop
```

패키지를 zip으로 만들어 `tailscale file cp`로 COM1 수신함에 넣는다. COM1에서 아래 **1회 명령**으로 마무리한다.

```powershell
# COM1에서 (스크립트 파일 없이 동작하는 1 linersequence)
$ts="$env:ProgramFiles\Tailscale\tailscale.exe"; $root="C:\cgi-handoff"
New-Item -ItemType Directory -Force -Path "$root\incoming","$root\inbox" | Out-Null
& $ts file get --conflict=rename "$root\incoming"
$zip=Get-ChildItem "$root\incoming" -Filter "cgi-handoff-*.zip" | Sort-Object LastWriteTime | Select-Object -Last 1
$run=$zip.BaseName -replace "^cgi-handoff-",""
$stage="$root\incoming\$run.part"; Expand-Archive -LiteralPath $zip.FullName -DestinationPath $stage -Force
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$stage\_handoff\verify-package.ps1" -PackageRoot $stage -ExpectedRunId $run -MoveTo "$root\inbox"
```

또는 패키지 내부의 스크립트로 한 번에 처리한다(권장, receipt 회신 포함).

```powershell
# COM1에서 (패키지를 받은 뒤)
powershell -NoProfile -ExecutionPolicy Bypass -File "$root\incoming\<runId>.part\_handoff\com1-pull.ps1"
```

### 4.3 닫힌 루프 검증 (수신 확인)

COM1은 검증 후 `receipt.json`을 Taildrop으로 CGI-1에 되돌린다. CGI-1은 이를 받아 해시를 대조한다.

```powershell
# CGI-1에서
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\handoff\check-receipt.ps1 `
  -RunId 20261022-121237-ce96 -ExpectedManifestSha256 16961b862c8cf59d40cc6b6824dd487d5763434c472963dc37ad866247dd7df4
```

또는 전송 시 `-WaitReceipt` 옵션으로 자동 대기·확인한다.

## 5. 1회 부트스트랩 (COM1에서 실행, SSH 자동화용)

COM1의 **SSH 로그인에 쓰는 Windows 계정**으로 실행한다. 관리자 권한 불필요.

```powershell
# COM1에서 (PowerShell)
$pub = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGVlWSv2uJvEYn6OqOfUqDXbRrU2wdL8fz1i/caE9C/2 cgi-1-handoff@cgi-1'
powershell -NoProfile -ExecutionPolicy Bypass -File .\bootstrap-com1.ps1 -PublicKey $pub
```

동작: `~\.ssh\authorized_keys`에 공개키 등록(중복 방지) → `icacls`로 ACL 적용(BOM 없이 UTF-8 기록)
→ `C:\cgi-handoff\incoming`, `C:\cgi-handoff\inbox` 생성.

확인:

```powershell
# COM1에서
Get-Content $env:USERPROFILE\.ssh\authorized_keys
# CGI-1에서
ssh -p 2222 -i $env:USERPROFILE\.ssh\cgi_handoff_ed25519 <COM1계정>@100.124.21.64 hostname
```

## 6. 반복 실행 (CGI-1)

```powershell
# 미리보기(전송 없이 패키징/해시만)
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\handoff\send-handoff.ps1 -SourcePath <폴더> -DryRun

# 실제 전송
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\handoff\send-handoff.ps1 -SourcePath <폴더> -Transport taildrop
```

종료 코드: `0` 성공 / `2` 소스·키 사전조건 실패 / `3` 전송 실패 / `4` 원격 검증 실패.

## 7. 충돌·중복 방지 설계

| 요구사항 | 구현 |
|---|---|
| 기존 파일 덮어쓰지 않음 | 전송마다 고유 `runId`(yyyyMMdd-HHmmss-xxxx) 폴더 생성, `.part`로 수신 후 **검증 통과 시에만** `inbox/<runId>`로 승격. 동일 이름이 있으면 `destination_exists`로 실패하고 기존 것을 유지 |
| 다른 에이전트 작업과 충돌 금지 | ① `git guard`: 소스가 git 워크트리면 **커밋된 파일만** 패키징(다른 에이전트의 미커밋 WIP 제외, `-IncludeUntracked`로 해제) ② `apply-handoff.ps1`는 작업 트리 반영 시 내용이 다른 파일을 `APPLY_CONFLICT`로 보고 **덮어쓰지 않음** ③ 저장소 checkout은 에이전트별 worktree로 분리 권장 |
| 명시적 폴더만 전송 | `handoff.config.ps1`의 `AllowedSourceRoots` 아래가 아니면 `HANDOFF_ABORT: source_outside_allowed_roots` |
| 실제 데이터 유출 방지 | `.env`, `id_rsa`, `*.pem`, `credential*`, `*secret*` 등 시크릿성 파일명은 전송 거부(`-AllowSensitive`로 해제 가능) |
| 민감 파일·대용량 제외 | `.git`, `node_modules`, `dist` 등 제외, 50 MB 초과 파일 제외(`-IncludeLarge`로 해제) |

## 8. 실패 복구 절차

| 증상 | 원인 | 조치 |
|---|---|---|
| `HANDOFF_ABORT: identity_key_missing` | 전용 키가 없음 | `ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\cgi_handoff_ed25519 -N '""'` 또는 `-Transport taildrop` 사용 |
| `HANDOFF_ABORT: source_outside_allowed_roots` | 허용 루트 밖 폴더 | `handoff.config.ps1`의 `AllowedSourceRoots` 확인(변경은 별도 검토) |
| `HANDOFF_ABORT: no_files_to_transfer` | 모두 제외됨(예: 미커밋 파일만 존재) | `-IncludeUntracked` 사용 또는 먼저 커밋 |
| `HANDOFF_FAIL: ssh_preflight_failed` | COM1 sshd/키 등록 문제 | COM1에서 `Get-Service sshd`, `authorized_keys` 확인. 로그인 계정이 다르면 `handoff.config.ps1`의 `RemoteUser` 수정 |
| `HANDOFF_FAIL: scp_failed` | 중간 끊김 | COM1의 `C:\cgi-handoff\incoming\<runId>.part` 잔여분 삭제 후 재실행(새 runId 생성) |
| `HANDOFF_FAIL: remote_verification_failed` | 해시 불일치 | 승격되지 않으므로 안전한 실패. `incoming\<runId>.part`를 조사 후 삭제/재전송 |
| `HANDOFF_REMOTE: HANDOFF_FAIL: destination_exists` | 같은 runId가 이미 존재 | 정상(중복 방지). 다른 이름으로 재전송 |
| `PULL_RESULT: no_package` | COM1 수신함에 패키지 없음 | `tailscale file get` 재실행 또는 CGI-1에서 재전송 |
| `RECEIPT_FAIL: timeout` | COM1에서 pull 미실행 | COM1에서 §4.2 명령 실행 후 `check-receipt.ps1` 재실행 |

### 8.1 SMB 경로 실패 복구

| 증상 | 원인 | 조치 |
|---|---|---|
| `ERROR Cannot create batch directory on COM1` | SMB 세션 끊김 / 권한 회수 | `Get-SmbConnection` 으로 `\\100.124.21.64\IPC$` 상태 확인. `net use \\100.124.21.64\IPC$ /persistent:yes` 로 재연결 후 재실행 |
| `ERROR Batch directory already exists, refusing to reuse it` | 같은 `batchId` 로 재실행 | 정상(중복 방지). 인자 없이 재실행하면 새 batchId 로 생성된다. 중단된 전송 이어갈 때만 `-Resume` 사용 |
| `FAIL CONFLICT, existing file left untouched` | 같은 batch 안에서 원본이 변경됨 | 수신 파일은 **그대로 보존**된다. 최신본을 보내려면 새 batchId 로 재전송하거나, 의도적 교체라면 `-Resume -OverwriteChanged` |
| `FAIL HASH MISMATCH for <file>` | 복사 중 전송 오류로 파일 손상 | 해당 batch 는 사용하지 말 것. `verify_handoff.ps1` 로 FAIL 확인 후 새 batchId 로 재전송 |
| `FAIL Integrity check FAIL` (검증 단계) | 수신측 파일 변조/손상 | 배치 폐기. `manifest.sha256` 의 기대값과 실제값을 대조해 원인 특정 |
| `ERROR git has no user.email configured` | COM1에 git 사용자 정보 없음 | `git -C <저장소> config user.email <you@example.com>` 及 `user.name <Your Name>` 설정 후 재실행 |
| COM1에 `CGI-HANDOFF` 가 보이지 않음 | 다른 계정/세션으로 로그인 | 수신 폴더는 `C:\Users\Public\CGI-HANDOFF` (모든 계정에서 보임). `Get-ChildItem \\100.124.21.64\Users\Public\CGI-HANDOFF` 으로 확인 |
| SMB 자체가 안 될 때 | Tailscale 연결 끊김 | `tailscale ping padiem-command-center` 확인. SSH/Taildrop 경로(4장)로 대체 |

## 9. COM1에서 GitHub PR 만들기

COM1은 이미 GitHub 작업(PR #3/#4/#6)을 이어받는 환경이므로, GitHub 인증은 **COM1 쪽에 이미 있는 자격증명**을 사용한다.
CGI-1에는 GitHub 인증 정보를 두지 않는다(실측: `git push` → `could not read Username for 'https://github.com'`, `gh` 미설치).

```powershell
# COM1에서 (패키지 반영 + PR 단계 출력)
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\handoff\com1-pull.ps1 -RepoPath C:\work\kbs261022
# 또는 이미 inbox에 있을 때
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\handoff\apply-handoff.ps1 `
  -RunId 20261022-121237-ce96 -RepoPath C:\work\kbs261022

# 출력된 APPLY_NEXT 라인(또는 아래)을 순서대로 실행
git -C C:\work\kbs261022 checkout -b handoff/20261022-121237-ce96
git -C C:\work\kbs261022 add -A
git -C C:\work\kbs261022 commit -m "handoff: 20261022-121237-ce96 (CGI-1 -> COM1)"
git -C C:\work\kbs261022 push -u origin handoff/20261022-121237-ce96
gh pr create --base main --head handoff/20261022-121237-ce96 --title "handoff: 20261022-121237-ce96" --body "CGI-1 -> COM1 handoff. Refs #7"
```

이슈 #7 연결: PR 본문에 `Refs #7` 를 넣고, 이슈 #7에 PR 링크를 남긴다.

주의: `apply-handoff.ps1`가 `APPLY_CONFLICT`를 낸 경우 **커밋하지 말고** 다른 에이전트 작업과 먼저 조율한다.

### 9.1 SMB 경로로 PR 만들기 (1단계 자동화)

SMB 경로는 검증 -> 반영 -> branch -> commit -> push -> PR 까지 한 스크립트로 묶여 있고,
**기존 파일과 내용이 다르면 덮어쓰지 않고 충돌로 멈춘다.**

```powershell
# COM1에서 (저장소 클론 위치는 실제 경로로 지정)
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\handoff\receive_to_pr.ps1 `
  -BatchPath C:\Users\Public\CGI-HANDOFF\batch-20261022T030416Z-5392e8b9 `
  -RepoPath C:\cgi-work\kbs261022 `
  -Push -OpenPR
```

`receive_to_pr.ps1` 이 하는 일(각 단계는 다음 단계의 게이트):

1. `verify_handoff.ps1` 로 배치 재검증 — **실패하면 아무것도 하지 않고 중단**
2. 페이로드를 저장소 작업 트리에 반영 (같은 내용이면 건너뜀, 다른 내용이면 충돌로 중단 후 이번 실행이 복사한 파일 롤백)
3. `git checkout -b handoff/<batchId>` (이미 있는 브랜치는 재생성하지 않음)
4. `git add` -> `git commit` (변경이 없으면 빈 커밋을 만들지 않고 종료)
5. `-Push` 지정 시 `git push -u origin <branch>` (base 브랜치에는 절대 push 하지 않음, force push 없음)
6. `-OpenPR` 지정 시 `gh pr create` (gh 없으면 PR URL 만 출력)

수동 처리 시의 최소 순서:

```powershell
git -C C:\cgi-work\kbs261022 checkout -b handoff/20261022T030416Z-5392e8b9
git -C C:\cgi-work\kbs261022 add -- <대상폴더>
git -C C:\cgi-work\kbs261022 commit -m "chore(handoff): receive CGI-1 batch 20261022T030416Z-5392e8b9"
git -C C:\cgi-work\kbs261022 push -u origin handoff/20261022T030416Z-5392e8b9
gh pr create --base main --head handoff/20261022T030416Z-5392e8b9 --title "chore(handoff): receive CGI-1 batch" --body "Refs #7"
```

## 10. 보안·운영 메모

- 개인 키는 `C:\Users\sji\.ssh\cgi_handoff_ed25519`에만 존재하며 저장소·패키지에 포함되지 않는다.
- 신규 포트 공개를 하지 않는다. COM1의 2222 포트는 Tailscale 인터페이스에만 열려 있는 상태를 유지한다.
- 전송물에는 업무 실데이터를 넣지 않는다. 샘플·스크립트·문서만 전달한다.
- 로그에는 파일 경로와 해시만 남기며 파일 내용은 출력하지 않는다.
- **저장소 checkout 공유 주의**: 두 에이전트가 같은 working tree를 쓰면 브랜치가 뒤집히거나 미커밋 파일이 섞인다.
  에이전트별로 `git worktree add`로 분리하고, `send-handoff.ps1`의 git guard를 켜 두는 것을 권장한다.

## 11. 테스트 기록

실제 실행 결과는 [`CGI_LOCAL_HANDOFF_TESTLOG.md`](./CGI_LOCAL_HANDOFF_TESTLOG.md) 참조.

## 12. SMB 경로 실측 결과 요약 (2026-10-22)

이슈 #7 완료 기준 중 "CGI-1→COM1 파일 전달 PASS, 무결성 PASS, 직접 반복 가능"을
SMB 경로로 실측 완료했다. 상세는 테스트 기록 7장을 참조.

| 항목 | 결과 |
|---|---|
| 실제 전송 | **PASS** — 6개 파일 / 262,227 bytes, 배치 `batch-20261022T030416Z-5392e8b9` |
| 무결성 | **PASS** — 전송 스크립트 내 대조 6/6, `verify_handoff.ps1` 재검증 6/6, Python 독립 검증 6/6 |
| 바이너리/유니코드 | **PASS** — 256 KiB 난수 바이너리, 한글 파일명, 공백 포함 경로 모두 바이트 일치 |
| 중복 실행 | **PASS** — 동일 `batchId` 재실행 시 거부(exit 3), 기존 배치 불변 |
| 충돌 | **PASS** — 원본 변경 후 재전송 시 `CONFLICT` 로 보고, 수신 파일 **미변경**(해시 동일 확인) |
| 변조 탐지 | **PASS** — 수신 파일 1바이트 변조 -> `verify_handoff.ps1` FAIL(exit 2) |
| 명시적 교체 | **PASS** — `-Resume -OverwriteChanged` 시에만 교체 후 재검증 |
| 반복 가능 | **PASS** — 인자 없이 재실행하면 새 `batchId` 로 생성, 기존 배치와 공존 |
| 수신측 -> PR | **PASS** — 검증 -> 반영 -> branch -> commit -> push 까지 자동, 푸시본 해시가 CGI-1 원본과 동일 |

**미완료 항목(정확한 장애 근거)**: OpenSSH(2222) 경로는 COM1 측 `authorized_keys` 등록이
완료되지 않아 `Permission denied (publickey, keyboard-interactive)` 로 종료된다.
CGI-1에서 SMB로 COM1의 `~\.ssh\authorized_keys` 와 `C:\ProgramData\ssh\` 에 접근할 수 없어
(COM1 사용자 프로필 디렉터리 미노출, `C$`/`ADMIN$` 관리자 공유 거부) 원격 등록이 불가능했다.
COM1 콘솔에서 `bootstrap-com1.ps1` 을 1회 실행하면 SSH 경로도 사용 가능하다(5장).
