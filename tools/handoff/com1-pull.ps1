<#
    com1-pull.ps1  --  COM1 side receiver for the Taildrop transport.

    One command pulls the handoff package out of the Tailscale file inbox,
    verifies every SHA256, promotes it into the inbox folder and sends the
    receipt back to CGI-1.

    Usage on COM1:
      powershell -NoProfile -ExecutionPolicy Bypass -File com1-pull.ps1
      powershell -NoProfile -ExecutionPolicy Bypass -File com1-pull.ps1 -RepoPath C:\work\kbs261022
#>
[CmdletBinding()]
param(
    [string] $Root = 'C:\cgi-handoff',
    [string] $TailscaleExe = "$env:ProgramFiles\Tailscale\tailscale.exe",
    [string] $RunId = '',
    [string] $RepoPath = '',
    [switch] $NoReceiptBack
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Write-Line([string]$Text) { [Console]::Out.WriteLine($Text) }
function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$incoming  = Join-Path $Root 'incoming'
$inbox     = Join-Path $Root 'inbox'
$verifier  = Join-Path $scriptDir 'verify-package.ps1'

foreach ($d in @($Root, $incoming, $inbox)) { if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null } }

if (-not (Test-Path -LiteralPath $TailscaleExe)) { Write-Line "PULL_ABORT: tailscale_cli_missing path=$TailscaleExe"; exit 2 }
if (-not (Test-Path -LiteralPath $verifier))  { Write-Line "PULL_ABORT: verifier_missing path=$verifier"; exit 2 }

# --- 1. pull whatever arrived in the Taildrop inbox --------------------------
Write-Line "PULL_INFO: tailscale file get -> $incoming"
& $TailscaleExe file get --conflict=rename $incoming 2>&1 | ForEach-Object { Write-Line "PULL_TAILDROP: $_" }
$pullExit = $LASTEXITCODE

# --- 2. process every package zip -------------------------------------------
$zips = @(Get-ChildItem -LiteralPath $incoming -Filter 'cgi-handoff-*.zip' -File -ErrorAction SilentlyContinue |
           Sort-Object LastWriteTime)
if ($RunId) { $zips = @($zips | Where-Object { $_.BaseName -eq "cgi-handoff-$RunId" }) }
if ($zips.Count -eq 0) {
    Write-Line "PULL_RESULT: no_package (pull_exit=$pullExit) incoming=$incoming"
    exit 3
}

$overallFail = $false
foreach ($zip in $zips) {
    $rid = $zip.BaseName -replace '^cgi-handoff-', ''
    $stage = Join-Path $incoming "$rid.part"
    Write-Line "PULL_INFO: extracting run_id=$rid zip=$($zip.Name) sha256=$((Get-Sha256 $zip.FullName))"

    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    Expand-Archive -LiteralPath $zip.FullName -DestinationPath $stage -Force

    $verifyScript = Join-Path $stage '_handoff\verify-package.ps1'
    if (-not (Test-Path -LiteralPath $verifyScript)) {
        Write-Line "PULL_FAIL: run_id=$rid reason=verifier_not_in_package"
        $overallFail = $true
        continue
    }

    & $verifyScript -PackageRoot $stage -ExpectedRunId $rid -MoveTo $inbox
    if ($LASTEXITCODE -ne 0) {
        Write-Line "PULL_FAIL: run_id=$rid reason=verification_failed"
        $overallFail = $true
        continue
    }

    $promoted = Join-Path $inbox $rid
    Write-Line "PULL_PASS: run_id=$rid inbox=$promoted"

    # --- 3. send the receipt back to CGI-1 --------------------------------
    if (-not $NoReceiptBack) {
        $receipt = Join-Path $promoted 'receipt.json'
        $manifest = Get-Content (Join-Path $promoted 'manifest.json') -Raw | ConvertFrom-Json
        $sender = ([string]$manifest.sourceHost).ToLowerInvariant()
        $receiptCopy = Join-Path $incoming "receipt-$rid.json"
        Copy-Item -LiteralPath $receipt -Destination $receiptCopy -Force
        & $TailscaleExe file cp $receiptCopy "${sender}:" 2>&1 | ForEach-Object { Write-Line "PULL_RECEIPT: $_" }
        if ($LASTEXITCODE -eq 0) { Write-Line "PULL_RECEIPT: sent_to=$sender file=receipt-$rid.json" }
        else { Write-Line "PULL_WARN: receipt_back_send_failed exit=$LASTEXITCODE" }
    }

    # --- 4. optional: apply to the working clone and print PR steps ---------
    if ($RepoPath) {
        $applier = Join-Path $stage '_handoff\apply-handoff.ps1'
        if (Test-Path -LiteralPath $applier) {
            & $applier -RunId $rid -InboxRoot $inbox -RepoPath $RepoPath
        }
    } else {
        $branch = "handoff/$rid"
        Write-Line "PULL_NEXT: git -C <repo> checkout -b $branch"
        Write-Line "PULL_NEXT: git -C <repo> add -A ; git -C <repo> commit -m ""handoff: $rid (CGI-1 -> COM1)"""
        Write-Line "PULL_NEXT: git -C <repo> push -u origin $branch"
        Write-Line "PULL_NEXT: gh pr create --base main --head $branch --title ""handoff: $rid"" --body ""CGI-1 -> COM1 handoff. Refs #7"""
    }
}

if ($overallFail) { Write-Line "PULL_RESULT: FAIL (one or more packages failed)"; exit 4 }
Write-Line "PULL_RESULT: OK packages=$($zips.Count) inbox=$inbox"
exit 0
