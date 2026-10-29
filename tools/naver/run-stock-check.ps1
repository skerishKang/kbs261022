# 읽기 전용 정기 재고 점검 래퍼 — Task Scheduler 진입점(9단계 지시 §6).
# 기존 인프라: 이 호스트 Task Scheduler의 PADIEM-* 운영 작업 관례를 따른다.
# - 저장소 밖 --out-dir 기록: 작업트리를 더럽히지 않는다(증적·로그·잠금 모두 out-dir).
# - CLI(ncom-stock-sync.mjs) 자체가 단일 실행 잠금 + 읽기 전용(compare) 보장 — 이 래퍼는 게이트를 우회하지 않는다.
# - 쓰기(apply·revert)는 정기 점검에서 실행하지 않는다 — 수량 출처가 확인된 변경만 수동 게이트로 실행(런북 C21).
#
# Task Scheduler 등록(병합 후 운영자 실행):
#   schtasks /Create /TN "PADIEM-CGI1-LOCAL2-Ncom-StockCheck" /SC DAILY /ST 07:30 /TR "pwsh -NoProfile -ExecutionPolicy Bypass -File E:\cgi-1029-1\kbs261022\tools\naver\run-stock-check.ps1"
# 시험 실행: schtasks /Run /TN "PADIEM-CGI1-LOCAL2-Ncom-StockCheck"

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
$outDir = 'E:\cgi-1029-1\scheduler'   # 저장소 밖 기록 위치(작업트리 무변경)
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$cli = Join-Path $repo 'tools\naver\ncom-stock-sync.mjs'
if (-not (Test-Path $cli)) { Write-Error "CLI 없음: $cli"; exit 2 }

node $cli compare --out-dir $outDir
exit $LASTEXITCODE
