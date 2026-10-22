# 이슈 #8 전달 기록 (CGI-1 → COM1)

> 이슈 #8 산출물을 COM1 로 전달한 실제 기록.
> GitHub 인증 없이, Tailscale 위 SMB 로 전송했고 도착 바이트를 되읽어
> SHA256 으로 검증했다.

---

## 1. 전달 결과

| 항목 | 값 |
|---|---|
| 배치 ID | `batch-20261022T033550Z-def738aa` (최종) · `batch-20261022T033231Z-166c1a3d` (최초, 28파일) |
| 도착 경로 | `\\100.124.21.64\Users\Public\CGI-HANDOFF\batch-20261022T033550Z-def738aa` |
| 전송 방식 | `smb-over-tailscale` (Tailscale 100.124.21.64:445) |
| 전송 파일 | **29개** (최종) |
| 무결성 | `integrity = PASS` (모든 파일 SHA256 재계산 일치) |
| 충돌 / 실패 | 0 / 0 |
| 매니페스트 | `handoff.json`, `manifest.sha256` (sha256sum 호환) |
| 페이로드 루트 | `payload\wt-issue8\` |

전송 도구: `tools/handoff/send_to_com1.ps1` (이슈 #7 파이프라인).

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/handoff/send_to_com1.ps1 `
  -SourcePath C:\Users\sji\cgi-work\wt-issue8
```

### 1.1 도착 확인 (수신측 재검증)

COM1 의 파일을 다시 읽어 로컬 원본과 해시를 비교했다.

```
COM1 : 58f82edbce233bc7b4260856992aca5a22ebe9e5d669c9c1b2e3be4cf10b44f8
CGI-1: 58f82edbce233bc7b4260856992aca5a22ebe9e5d669c9c1b2e3be4cf10b44f8  ✓ 동일
```

### 1.2 전달된 파일 (28개)

```
.gitignore
README.md
.zcode/skills/cgi-product-browser-verify/SKILL.md
docs/CGI_BROWSER_VERIFICATION_REPORT.md
docs/CGI_PRODUCT_MASTER_SCHEMA.md
reports/data/_browser_dump_samasound.json
reports/data/_browser_dump_samamusic.json
reports/data/_http_dump.json
reports/data/crosscheck_report.json
reports/data/dedupe_report.json
reports/data/http_collected_sample.csv
reports/data/http_collected_sample.json
reports/data/product_master_sample.csv
reports/data/product_master_sample.json
schemas/product-master-record.schema.json
tools/product_master/__init__.py
tools/product_master/build_records.py
tools/product_master/cli.py
tools/product_master/collect_http.py
tools/product_master/crosscheck.py
tools/product_master/dedupe.py
tools/product_master/normalize.py
tools/product_master/schema.py
tools/product_master/validate.py
tools/product_master/tests/__init__.py
tools/product_master/tests/test_dedupe.py
tools/product_master/tests/test_normalize.py
tools/product_master/tests/test_schema_policy.py
```

---

## 2. COM1 수신 후 PR 만들기

COM1 에서는 저장소를 체크아웃한 뒤 배치 안의 파일을 그대로 적용하면 된다.

```powershell
# 1) 수신 배치 검증 (COM1 측)
powershell -ExecutionPolicy Bypass -File tools/handoff/verify_handoff.ps1 `
  -BatchPath "\\100.124.21.64\Users\Public\CGI-HANDOFF\batch-20261022T033550Z-def738aa"

# 2) 작업 복제본에 적용 후 PR (COM1 측)
powershell -ExecutionPolicy Bypass -File tools/handoff/receive_to_pr.ps1 `
  -BatchPath "\\100.124.21.64\Users\Public\CGI-HANDOFF\batch-20261022T033550Z-def738aa" `
  -RepoPath "<COM1 의 kbs261022 작업복제본>"
```

`receive_to_pr.ps1` 은 같은 내용이 이미 있으면 건너뛰고, 내용이 다르면
**덮어쓰지 않고 충돌로 보고**한다. 다른 진행 PR 파일을 건드리지 않는다.

수동으로 처리할 경우:

```powershell
$batch = "\\100.124.21.64\Users\Public\CGI-HANDOFF\batch-20261022T033550Z-def738aa"
$repo  = "C:\work\kbs261022"
Copy-Item "$batch\payload\wt-issue8\*" $repo -Recurse -Force
cd $repo
git checkout -b feature/issue-8-product-master
git add .zcode docs/CGI_PRODUCT_MASTER_SCHEMA.md docs/CGI_BROWSER_VERIFICATION_REPORT.md `
        reports/data schemas tools/product_master
git commit -m "feat(data): CGI 통합 상품 마스터 스키마·중복/브랜드/가격 정규화 (issue #8)"
git push -u origin feature/issue-8-product-master
```

---

## 3. SMB 경로에 대한 정정 (독립 실측)

이슈 #7 문서에 "SMB(445) — 인증 필요, 현재 자격증명으로 접근 거부(오류 5)" 라고
기록되어 있었다. **부분적으로 부정확하다.** 이 세션에서 다시 실측했다.

| 시도 | 결과 |
|---|---|
| `net view \\100.124.21.64` (공유 *열거*) | 오류 1702 / 5 — 실패 |
| `\\100.124.21.64\Users` (공유 경로 *직접* 접근) | **성공** |
| `\\100.124.21.64\Users\Public` 쓰기 | **성공** (파일 생성/삭제 확인) |
| `\\100.124.21.64\Users\limone` 쓰기 | 거부 (자기 프로필) |
| `\\100.124.21.64\Users\Public\CGI-HANDOFF` | 쓰기 성공 — 본 전달 경로 |

즉 **공유 목록 열거는 실패하지만, 공유 이름을 아는 상태에서 직접 접근하면
현재 Windows 자격증명으로读写가 된다.** 공유를 찾지 못하면 SMB 가 안 되는
것으로 오판하기 쉽다. 이 차이는 이슈 #7 파이프라인의 SMB 전송기가 이미
반영하고 있다(`handoff.config.psd1` 의 `ShareRoot = '\\100.124.21.64\Users\Public'`).

### 3.1 다른 전송 경로 상태 (2026-10-22 실측)

| 경로 | 상태 |
|---|---|
| OpenSSH `100.124.21.64:22` | 닫힘 (timeout) |
| OpenSSH `100.124.21.64:2222` | **열림**. publickey 인증 요구. `cgi_handoff_ed25519` 미등록 → `Permission denied (publickey,keyboard-interactive)` |
| Tailscale Taildrop (`tailscale file cp`) | COM1 이 `tailscale.com/file` capability 미 광고 → **사용 불가** |
| WinRM `100.124.21.64:5985` | 포트 열림, TrustedHosts 미설정 + 관리자 권한 없음 → **사용 불가** |
| **SMB `100.124.21.64:445`** | **사용 가능 — 본 전달에 사용** |

SSH 를 쓰려면 COM1 에서 한 번만 `bootstrap-com1.ps1` 를 실행해
`C:\Users\sji\.ssh\cgi_handoff_ed25519.pub` 를 authorized_keys 에 넣어야 한다.
그 전까지는 SMB 가 유일한 무설정 경로다.

---

## 4. 보안 · 예절

* 개인 키는 `C:\Users\sji\.ssh\cgi_handoff_ed25519` 에만 있고 **패키지에
  포함되지 않았다.** 전송 대상은 `wt-issue8` 작업 트리뿐이며
  `.git` 은 제외된다.
* 전송된 것은 공개 상품 정보와 소스 코드뿐이다. 고객 정보·계정·주문·
  ERP 데이터는 포함되지 않았다.
* 스마트스토어·ERP 는 변경하지 않았다.
* COM1 의 기존 배치는 건드리지 않았다 (배치 디렉터리 = 새 디렉터리, 덮어쓰기 없음).

---

## 5. 재현

```bash
# CGI-1 : 검증 재생성
cd C:\Users\sji\cgi-work\wt-issue8
python -m tools.product_master.cli validate --records reports/data/product_master_sample.json
python -m tools.product_master.cli dedupe    --records reports/data/product_master_sample.json
python -m tools.product_master.cli crosscheck \
  --browser reports/data/product_master_sample.json \
  --http    reports/data/http_collected_sample.json
python -m unittest discover -t . -s tools/product_master/tests -v

# CGI-1 : COM1 로 전달
powershell -ExecutionPolicy Bypass -File tools/handoff/send_to_com1.ps1 `
  -SourcePath C:\Users\sji\cgi-work\wt-issue8
```
