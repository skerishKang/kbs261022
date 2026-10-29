# 읽기 전용 정기 재고 점검 래퍼 — Task Scheduler 진입점(9단계 지시 §6).
# 기존 인프라: 이 호스트 Task Scheduler의 PADIEM-* 운영 작업 관례를 따른다.
# - 저장소 밖 기록: 기본 %LOCALAPPDATA%\CGI-Ncom-StockCheck (CGI_NCOM_OUT_DIR로 재정의 가능).
#   드라이브 문자(E:)를 가정하지 않는다 — COM1·CGI-1 어느 호스트에서도 동작해야 한다.
# - CLI(ncom-stock-sync.mjs) 자체가 단일 실행 잠금 + 읽기 전용(compare) 보장 — 이 래퍼는 게이트를 우회하지 않는다.
# - 쓰기(apply·revert)는 정기 점검에서 실행하지 않는다 — 수량 출처가 확인된 변경만 수동 게이트로 실행(런북 C21·C22).
# - 실행 결과(성공·실패·자격증명 차단)를 run.log에 시각과 함께 남긴다. 조용한 실패를 만들지 않는다.
#
# Task Scheduler 등록(운영자·관리자 권한):
#   schtasks /Create /TN "PADIEM-CGI1-LOCAL2-Ncom-StockCheck" /SC DAILY /ST 07:30 /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"<repo>\tools\naver\run-stock-check.ps1\""
# 시험 실행: schtasks /Run /TN "PADIEM-CGI1-LOCAL2-Ncom-StockCheck"

$ErrorActionPreference = 'Stop'
# Node가 UTF-8로 쓰는 한국어 메시지를 콘솔 코드페이지(cp949)로 오독하지 않도록 고정한다.
$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$repo = (Resolve-Path (Join-Path (Join-Path $PSScriptRoot '..') '..')).Path
$outDir = if ($env:CGI_NCOM_OUT_DIR) { $env:CGI_NCOM_OUT_DIR } else { Join-Path $env:LOCALAPPDATA 'CGI-Ncom-StockCheck' }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$log = Join-Path $outDir 'run.log'
$stamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')
$cli = Join-Path $repo 'tools\naver\ncom-stock-sync.mjs'

function Write-RunLog([string]$message) {
  Add-Content -Path $log -Value ("{0} {1}" -f $stamp, $message) -Encoding UTF8
}

if (-not (Test-Path $cli)) { Write-RunLog ("wrapper=FAIL cli_missing={0}" -f $cli); exit 2 }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $node)) { Write-RunLog 'wrapper=FAIL node_missing'; exit 2 }

Write-RunLog ("wrapper=START repo={0} out={1}" -f $repo, $outDir)
$code = 1
try {
  & $node $cli compare --out-dir $outDir 2>&1 | ForEach-Object { Write-RunLog ("compare| " + $_) }
  $code = $LASTEXITCODE
  if ($null -eq $code) { $code = 0 }
} catch {
  Write-RunLog ("wrapper=ERROR " + $_.Exception.Message)
  $code = 1
}
Write-RunLog ("wrapper=END exit={0}" -f $code)
exit $code
