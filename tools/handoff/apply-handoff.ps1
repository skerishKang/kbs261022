<#
    apply-handoff.ps1  --  COM1 side: apply a verified inbox package into the
    local working clone and print the GitHub PR steps.

    Rules
      * the package is re-verified (SHA256) before anything is copied
      * files that already exist in the working tree and differ are reported
        as conflicts and are NOT overwritten (other agents stay safe)
      * identical files are skipped silently
      * nothing is committed or pushed automatically

    Example (on COM1):
      powershell -NoProfile -File .\apply-handoff.ps1 -RunId 20261022-120000-ab12 -RepoPath C:\work\kbs261022
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $RunId,
    [string] $InboxRoot = 'C:\cgi-handoff\inbox',
    [string] $RepoPath = (Join-Path (Get-Location).Path 'kbs261022'),
    [switch] $OverwriteConflicts
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Write-Line([string]$Text) { [Console]::Out.WriteLine($Text) }
function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkg = Join-Path $InboxRoot $RunId
$payload = Join-Path $pkg 'payload'
$manifestPath = Join-Path $pkg 'manifest.json'

if (-not (Test-Path -LiteralPath $pkg)) { Write-Line "APPLY_ABORT: package_not_found path=$pkg"; exit 2 }
if (-not (Test-Path -LiteralPath $manifestPath)) { Write-Line "APPLY_ABORT: manifest_missing path=$manifestPath"; exit 2 }
if (-not (Test-Path -LiteralPath $RepoPath)) { Write-Line "APPLY_ABORT: repo_not_found path=$RepoPath"; exit 2 }

# --- 1. re-verify ------------------------------------------------------------
& (Join-Path $scriptDir 'verify-package.ps1') -PackageRoot $pkg -ExpectedRunId $RunId -KeepInPlace
if ($LASTEXITCODE -ne 0) { Write-Line "APPLY_ABORT: verification_failed run_id=$RunId"; exit 3 }

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
Write-Line "APPLY_INFO: run_id=$RunId files=$(@($manifest.files).Count) repo=$RepoPath"

# --- 2. copy with conflict detection ----------------------------------------
$copied = 0; $skipped = 0; $conflicts = New-Object System.Collections.Generic.List[string]
foreach ($f in $manifest.files) {
    $rel = ([string]$f.path) -replace '/', '\'
    $src = Join-Path $payload $rel
    $dst = Join-Path $RepoPath $rel
    if (-not (Test-Path -LiteralPath $src)) { $conflicts.Add("source_missing:$($f.path)"); continue }
    if (Test-Path -LiteralPath $dst -PathType Leaf) {
        $h = Get-Sha256 $dst
        if ($h -eq ([string]$f.sha256).ToLowerInvariant()) { $skipped++; continue }
        if (-not $OverwriteConflicts) { $conflicts.Add("conflict:$($f.path)"); continue }
    }
    $dstDir = Split-Path -Parent $dst
    if (-not (Test-Path -LiteralPath $dstDir)) { New-Item -ItemType Directory -Force -Path $dstDir | Out-Null }
    Copy-Item -LiteralPath $src -Destination $dst -Force
    $copied++
}

Write-Line "APPLY_INFO: copied=$copied identical_skipped=$skipped conflicts=$($conflicts.Count)"
foreach ($c in $conflicts) { Write-Line "APPLY_CONFLICT: $c" }

# --- 3. PR steps -------------------------------------------------------------
$branch = "handoff/$RunId"
Write-Line "APPLY_NEXT: git -C $RepoPath checkout -b $branch"
Write-Line "APPLY_NEXT: git -C $RepoPath add -A"
Write-Line "APPLY_NEXT: git -C $RepoPath commit -m ""handoff: $RunId (CGI-1 -> COM1)"""
Write-Line "APPLY_NEXT: git -C $RepoPath push -u origin $branch"
Write-Line "APPLY_NEXT: gh pr create --base main --head $branch --title ""handoff: $RunId"" --body ""CGI-1 -> COM1 handoff. See receipt.json."""
if ($conflicts.Count -gt 0) {
    Write-Line "APPLY_WARN: resolve_conflicts_before_commit (rerun with -OverwriteConflicts only if intended)"
    exit 4
}
Write-Line "APPLY_DONE: run_id=$RunId"
exit 0
