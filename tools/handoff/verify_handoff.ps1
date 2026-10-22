<#
.SYNOPSIS
    Verifies a received handoff batch on COM1: re-computes SHA256 for every file
    listed in manifest.sha256 and reports PASS / FAIL.

.DESCRIPTION
    Works on a local folder on COM1 (for example
    C:\Users\Public\CGI-HANDOFF\batch-20261022T120000Z-ab12cd34) and also on a
    UNC path, so the sender can double-check the batch over the same transport.

.EXAMPLE
    .\verify_handoff.ps1 -BatchPath C:\Users\Public\CGI-HANDOFF\batch-20261022T120000Z-ab12cd34

.EXAMPLE
    .\verify_handoff.ps1 -ReceiveRoot C:\Users\Public\CGI-HANDOFF   # newest batch
#>
[CmdletBinding()]
param(
    [string]$BatchPath,
    [string]$ReceiveRoot,
    [string]$ConfigPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'handoff-common.ps1')

function Exit-Handoff {
    param([int]$Code)
    exit $Code
}

$config = Get-HandoffConfig -ConfigPath $ConfigPath

# --- locate the batch --------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($BatchPath)) {
    if ([string]::IsNullOrWhiteSpace($ReceiveRoot)) {
        $ReceiveRoot = $config.ReceiveRoot
    }
    if (-not (Test-Path -LiteralPath $ReceiveRoot -PathType Container)) {
        Write-HandoffLog -Level ERROR -Message ("Receive root not found: {0}" -f $ReceiveRoot)
        Exit-Handoff $script:HandoffExit.Usage
    }
    $batches = Get-ChildItem -LiteralPath $ReceiveRoot -Directory -Filter 'batch-*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending
    if ($batches.Count -eq 0) {
        Write-HandoffLog -Level ERROR -Message ("No batch directories under {0}" -f $ReceiveRoot)
        Exit-Handoff $script:HandoffExit.Usage
    }
    $BatchPath = $batches[0].FullName
}

if (-not (Test-Path -LiteralPath $BatchPath -PathType Container)) {
    Write-HandoffLog -Level ERROR -Message ("Batch path not found: {0}" -f $BatchPath)
    Exit-Handoff $script:HandoffExit.Usage
}

Write-HandoffLog -Message ("batch : {0}" -f $BatchPath)

# --- read metadata ------------------------------------------------------------

$metaPath = Join-Path $BatchPath 'handoff.json'
$meta = $null
if (Test-Path -LiteralPath $metaPath) {
    try {
        $meta = Get-Content -LiteralPath $metaPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        Write-HandoffLog -Level WARN -Message ("handoff.json is not parsable: {0}" -f $_.Exception.Message)
    }
} else {
    Write-HandoffLog -Level WARN -Message 'handoff.json missing - verifying against manifest.sha256 only.'
}

# --- determine the payload root -------------------------------------------------

$payloadRoot = $null
if ($meta -and $meta.PSObject.Properties.Name -contains 'payload_root' -and $meta.payload_root) {
    $payloadRoot = Join-Path $BatchPath $meta.payload_root
}
if (-not $payloadRoot -or -not (Test-Path -LiteralPath $payloadRoot -PathType Container)) {
    $candidates = @(Get-ChildItem -LiteralPath (Join-Path $BatchPath 'payload') -Directory -ErrorAction SilentlyContinue)
    if ($candidates.Count -eq 1) {
        $payloadRoot = $candidates[0].FullName
    } else {
        Write-HandoffLog -Level ERROR -Message 'Cannot determine the payload root inside the batch.'
        Exit-Handoff $script:HandoffExit.Usage
    }
}
Write-HandoffLog -Message ("payload: {0}" -f $payloadRoot)

# --- verify --------------------------------------------------------------------

$entries = Read-HandoffManifest -BatchPath $BatchPath
if ($entries.Count -eq 0) {
    Write-HandoffLog -Level ERROR -Message 'manifest.sha256 is empty or missing - nothing to verify.'
    Exit-Handoff $script:HandoffExit.IntegrityFail
}

$ok = 0
$bad = 0
$missing = 0

foreach ($e in $entries) {
    $file = Join-Path $payloadRoot ($e.Rel.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        Write-HandoffLog -Level FAIL -Message ("missing: {0}" -f $e.Rel)
        $missing++
        continue
    }
    $actual = Get-HandoffSha256 -Path $file
    if ($actual -eq $e.Sha256) {
        Write-HandoffLog -Level PASS -Message ("ok: {0}  {1}" -f $e.Rel, $actual.Substring(0, 12))
        $ok++
    } else {
        Write-HandoffLog -Level FAIL -Message ("hash mismatch: {0}  expected={1} actual={2}" -f $e.Rel, $e.Sha256, $actual)
        $bad++
    }
}

# --- extra files that are not in the manifest -----------------------------------

$manifestRel = @{}
foreach ($e in $entries) { $manifestRel[$e.Rel.ToLowerInvariant()] = $true }
$extra = 0
foreach ($f in (Get-ChildItem -LiteralPath $payloadRoot -Recurse -File -Force -ErrorAction SilentlyContinue)) {
    $rel = Get-HandoffRelativePath -File $f.FullName -Root $payloadRoot
    if (-not $manifestRel.ContainsKey($rel.ToLowerInvariant())) {
        Write-HandoffLog -Level WARN -Message ("not in manifest: {0}" -f $rel)
        $extra++
    }
}

# --- cross-check the metadata ---------------------------------------------------

if ($meta -and $meta.PSObject.Properties.Name -contains 'file_count') {
    if ([int]$meta.file_count -ne $entries.Count) {
        Write-HandoffLog -Level FAIL -Message ("handoff.json file_count={0} but manifest has {1} entries" -f $meta.file_count, $entries.Count)
        $bad++
    }
}

Write-Host ''
Write-Host '=== verification summary ==='
Write-Host ("  batch     : {0}" -f $BatchPath)
Write-Host ("  verified  : {0}" -f $ok)
Write-Host ("  mismatched: {0}" -f $bad)
Write-Host ("  missing   : {0}" -f $missing)
Write-Host ("  unlisted  : {0}" -f $extra)
Write-Host ''

if ($bad -eq 0 -and $missing -eq 0) {
    Write-HandoffLog -Level PASS -Message 'Integrity check PASS.'
    Exit-Handoff $script:HandoffExit.Ok
}

Write-HandoffLog -Level FAIL -Message 'Integrity check FAIL - do not use this batch.'
Exit-Handoff $script:HandoffExit.IntegrityFail
