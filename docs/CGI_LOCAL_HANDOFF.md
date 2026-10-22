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
| 445 | SMB | ❌ 인증 필요 (현재 자격증명으로 접근 거부, 오류 5) |
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

## 10. 보안·운영 메모

- 개인 키는 `C:\Users\sji\.ssh\cgi_handoff_ed25519`에만 존재하며 저장소·패키지에 포함되지 않는다.
- 신규 포트 공개를 하지 않는다. COM1의 2222 포트는 Tailscale 인터페이스에만 열려 있는 상태를 유지한다.
- 전송물에는 업무 실데이터를 넣지 않는다. 샘플·스크립트·문서만 전달한다.
- 로그에는 파일 경로와 해시만 남기며 파일 내용은 출력하지 않는다.
- **저장소 checkout 공유 주의**: 두 에이전트가 같은 working tree를 쓰면 브랜치가 뒤집히거나 미커밋 파일이 섞인다.
  에이전트별로 `git worktree add`로 분리하고, `send-handoff.ps1`의 git guard를 켜 두는 것을 권장한다.

## 11. 테스트 기록

실제 실행 결과는 [`CGI_LOCAL_HANDOFF_TESTLOG.md`](./CGI_LOCAL_HANDOFF_TESTLOG.md) 참조.
