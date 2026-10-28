<#
    check-receipt.ps1  --  CGI-1 side: confirm that COM1 verified the package.

    COM1 sends receipt-<runId>.json back through the Tailscale file inbox.
    This script waits for that receipt and compares the manifest hash recorded
    by COM1 with the hash computed on CGI-1.

    Usage:
      powershell -NoProfile -File .\check-receipt.ps1 -RunId 20261022-120000-ab12 `
        -ExpectedManifestSha256 85a81bdc...
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $RunId,
    [Parameter(Mandatory = $true)][string] $ExpectedManifestSha256,
    [int]    $TimeoutSeconds = 600,
    [string] $TailscaleExe = "$env:ProgramFiles\Tailscale\tailscale.exe",
    [string] $FetchDir = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Write-Line([string]$Text) { [Console]::Out.WriteLine($Text) }

if (-not $FetchDir) { $FetchDir = Join-Path $env:TEMP "cgi-handoff-receipt-$RunId" }
if (-not (Test-Path -LiteralPath $FetchDir)) { New-Item -ItemType Directory -Force -Path $FetchDir | Out-Null }
if (-not (Test-Path -LiteralPath $TailscaleExe)) { Write-Line "RECEIPT_ABORT: tailscale_cli_missing path=$TailscaleExe"; exit 2 }

$target = "receipt-$RunId.json"
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$poll = 5

while ((Get-Date) -lt $deadline) {
    & $TailscaleExe file get --conflict=rename $FetchDir 2>&1 | ForEach-Object { Write-Line "RECEIPT_TAILDROP: $_" }
    $found = Join-Path $FetchDir $target
    if (Test-Path -LiteralPath $found) {
        $receipt = Get-Content -LiteralPath $found -Raw | ConvertFrom-Json
        $remoteHash = ([string]$receipt.manifestSha256).ToLowerInvariant()
        $expected = $ExpectedManifestSha256.ToLowerInvariant()
        Write-Line "RECEIPT_INFO: run_id=$RunId verified_on=$($receipt.verifiedOn) result=$($receipt.result) files=$($receipt.verifiedCount)/$($receipt.fileCount)"
        if ($receipt.result -ne 'PASS') {
            Write-Line "RECEIPT_FAIL: remote_result=$($receipt.result) failures=$($receipt.failures -join ';')"
            exit 4
        }
        if ($remoteHash -ne $expected) {
            Write-Line "RECEIPT_FAIL: manifest_hash_mismatch expected=$expected remote=$remoteHash"
            exit 5
        }
        Write-Line "RECEIPT_PASS: run_id=$RunId manifest_sha256=$remoteHash verified_on=$($receipt.verifiedOn)"
        exit 0
    }
    Write-Line "RECEIPT_WAIT: run_id=$RunId elapsed=$([int]((Get-Date) - $deadline.AddSeconds(-$TimeoutSeconds)).TotalSeconds)s"
    Start-Sleep -Seconds $poll
}

Write-Line "RECEIPT_FAIL: timeout run_id=$RunId waited=${TimeoutSeconds}s dir=$FetchDir"
exit 6
