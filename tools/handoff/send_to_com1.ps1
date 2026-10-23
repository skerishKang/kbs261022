<#
.SYNOPSIS
    Sends a work folder from CGI-1 to the designated receive folder on COM1 and
    verifies every transferred byte with SHA256.

.DESCRIPTION
    Transport: SMB over the Tailscale interface of the existing `bobkoreacompany`
    tailnet. The operator's normal Windows credentials are used, so no GitHub
    credential and no additional secret is involved.

    Safety rules enforced by this script:
      * Only the whitelisted receive root may be written to.
      * Every transfer gets its own batch directory, so two transfers can never
        overwrite each other.
      * An existing file with different content is reported as a conflict and
        is left untouched.
      * The source folder is never modified.

.PARAMETER SourcePath
    The folder to send. Its contents are mirrored under <batch>\payload\<name>.

.PARAMETER BatchId
    Optional explicit batch id. Must be new; an existing batch directory is
    never reused or overwritten.

.EXAMPLE
    .\send_to_com1.ps1 -SourcePath C:\cgi-work\kbs261022\docs
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [string]$BatchId,
    [string]$ConfigPath,
    [string]$ReceiveRoot,
    [switch]$DryRun,
    # Allow re-using an existing batch directory (recovery after a failed run).
    # Files that are already there with identical content are skipped; files
    # with different content are reported as a conflict and never overwritten
    # unless -OverwriteChanged is given.
    [switch]$Resume,
    [switch]$OverwriteChanged
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'handoff-common.ps1')

function Exit-Handoff {
    param([int]$Code)
    exit $Code
}

# --- 1. configuration -------------------------------------------------------

try {
    $config = Get-HandoffConfig -ConfigPath $ConfigPath
} catch {
    Write-HandoffLog -Level ERROR -Message $_.Exception.Message
    Exit-Handoff $script:HandoffExit.Usage
}

try {
    $root = Resolve-HandoffReceiveRoot -Config $config -Requested $ReceiveRoot
} catch {
    Write-HandoffLog -Level ERROR -Message $_.Exception.Message
    Exit-Handoff $script:HandoffExit.Usage
}

# --- 2. source validation ----------------------------------------------------

if (-not (Test-Path -LiteralPath $SourcePath -PathType Container)) {
    Write-HandoffLog -Level ERROR -Message "Source folder not found: $SourcePath"
    Exit-Handoff $script:HandoffExit.Usage
}

$sourceFull = (Resolve-Path -LiteralPath $SourcePath).ProviderPath
$sourceName = Split-Path $sourceFull -Leaf
if ([string]::IsNullOrWhiteSpace($sourceName)) {
    $sourceName = 'payload'
}

$enumeration = Get-HandoffFileList -Root $sourceFull `
    -ExcludeNames @($config.ExcludeNames) `
    -MaxFileBytes ([long]$config.MaxFileBytes) `
    -MaxTotalBytes ([long]$config.MaxTotalBytes)

foreach ($s in $enumeration.Skipped) {
    Write-HandoffLog -Level WARN -Message ("skipped {0} ({1})" -f $s.Path, $s.Reason)
}

Write-HandoffLog -Message ("source : {0}" -f $sourceFull)
Write-HandoffLog -Message ("target : {0}" -f $root)
Write-HandoffLog -Message ("files  : {0} ({1:N0} bytes)" -f $enumeration.Files.Count, $enumeration.TotalBytes)

if ($enumeration.Files.Count -eq 0) {
    Write-HandoffLog -Level ERROR -Message 'Nothing to send (source folder has no eligible files).'
    Exit-Handoff $script:HandoffExit.Usage
}

# --- 3. batch directory ------------------------------------------------------

$batchId = New-HandoffBatchId -Explicit $BatchId
$batchPath = Join-Path $root ("batch-{0}" -f $batchId)

if (Test-Path -LiteralPath $batchPath) {
    if (-not $Resume) {
        Write-HandoffLog -Level ERROR -Message ("Batch directory already exists, refusing to reuse it: {0}" -f $batchPath)
        Write-HandoffLog -Level ERROR -Message 'Use a new -BatchId, or drop the argument to get a fresh one. To continue an interrupted run, add -Resume.'
        Exit-Handoff $script:HandoffExit.Conflict
    }
    Write-HandoffLog -Level WARN -Message ("Resuming into the existing batch directory: {0}" -f $batchPath)
}

if ($DryRun) {
    Write-HandoffLog -Level PASS -Message ("DRY RUN - would create {0} with {1} file(s)" -f $batchPath, $enumeration.Files.Count)
    foreach ($f in $enumeration.Files) {
        Write-HandoffLog -Message ("  {0}  ({1:N0} bytes)" -f $f.Rel, $f.Bytes)
    }
    Exit-Handoff $script:HandoffExit.Ok
}

try {
    [System.IO.Directory]::CreateDirectory($batchPath) | Out-Null
} catch {
    Write-HandoffLog -Level ERROR -Message ("Cannot create batch directory on COM1: {0}" -f $_.Exception.Message)
    Exit-Handoff $script:HandoffExit.TransportFail
}

$payloadRoot = Join-Path (Join-Path $batchPath 'payload') $sourceName
try {
    [System.IO.Directory]::CreateDirectory($payloadRoot) | Out-Null
} catch {
    Write-HandoffLog -Level ERROR -Message ("Cannot create payload directory on COM1: {0}" -f $_.Exception.Message)
    Exit-Handoff $script:HandoffExit.TransportFail
}

# --- 4. copy + verify -------------------------------------------------------

$entries = New-Object System.Collections.Generic.List[object]
$failed = 0
$conflicts = 0
$copied = 0
$skippedIdentical = 0

foreach ($f in $enumeration.Files) {
    $rel = $f.Rel
    $destPath = Join-Path $payloadRoot ($rel.Replace('/', '\'))

    try {
        $parent = Split-Path $destPath -Parent
        if (-not (Test-Path -LiteralPath $parent)) {
            [System.IO.Directory]::CreateDirectory($parent) | Out-Null
        }
    } catch {
        Write-HandoffLog -Level ERROR -Message ("Cannot create directory {0}: {1}" -f $parent, $_.Exception.Message)
        $failed++
        continue
    }

    $srcHash = Get-HandoffSha256 -Path $f.Path

    if (Test-Path -LiteralPath $destPath) {
        $destHash = Get-HandoffSha256 -Path $destPath
        if ($destHash -eq $srcHash) {
            Write-HandoffLog -Level PASS -Message ("identical, left in place: {0}" -f $rel)
            $skippedIdentical++
            $entries.Add([pscustomobject]@{ Rel = $rel; Sha256 = $srcHash; Bytes = $f.Bytes; Status = 'identical' })
            continue
        }
        if ($OverwriteChanged) {
            Write-HandoffLog -Level WARN -Message ("overwriting changed file (-OverwriteChanged): {0}" -f $rel)
            try {
                [System.IO.File]::Delete($destPath)
                [System.IO.File]::Copy($f.Path, $destPath, $false)
                $newHash = Get-HandoffSha256 -Path $destPath
                if ($newHash -eq $srcHash) {
                    Write-HandoffLog -Level PASS -Message ("overwritten+verified  {0}" -f $rel)
                    $copied++
                    $entries.Add([pscustomobject]@{ Rel = $rel; Sha256 = $srcHash; Bytes = $f.Bytes; Status = 'overwritten-verified' })
                } else {
                    Write-HandoffLog -Level FAIL -Message ("HASH MISMATCH after overwrite for {0}: src={1} dst={2}" -f $rel, $srcHash, $newHash)
                    $failed++
                    $entries.Add([pscustomobject]@{ Rel = $rel; Sha256 = $srcHash; Bytes = $f.Bytes; Status = 'hash-mismatch' })
                }
            } catch {
                Write-HandoffLog -Level ERROR -Message ("Overwrite failed for {0}: {1}" -f $rel, $_.Exception.Message)
                $failed++
            }
            continue
        }
        Write-HandoffLog -Level FAIL -Message ("CONFLICT, existing file left untouched: {0}" -f $rel)
        $conflicts++
        $entries.Add([pscustomobject]@{ Rel = $rel; Sha256 = $srcHash; Bytes = $f.Bytes; Status = 'conflict' })
        continue
    }

    try {
        [System.IO.File]::Copy($f.Path, $destPath, $false)
    } catch {
        Write-HandoffLog -Level ERROR -Message ("Copy failed for {0}: {1}" -f $rel, $_.Exception.Message)
        $failed++
        continue
    }

    $destHash = Get-HandoffSha256 -Path $destPath
    if ($destHash -eq $srcHash) {
        Write-HandoffLog -Level PASS -Message ("copied+verified  {0}  {1}" -f $rel, $srcHash.Substring(0, 12))
        $copied++
        $entries.Add([pscustomobject]@{ Rel = $rel; Sha256 = $srcHash; Bytes = $f.Bytes; Status = 'copied-verified' })
    } else {
        Write-HandoffLog -Level FAIL -Message ("HASH MISMATCH for {0}: src={1} dst={2}" -f $rel, $srcHash, $destHash)
        $failed++
        $entries.Add([pscustomobject]@{ Rel = $rel; Sha256 = $srcHash; Bytes = $f.Bytes; Status = 'hash-mismatch' })
    }
}

# --- 5. manifest ------------------------------------------------------------

$integrity = if ($failed -eq 0) { 'PASS' } else { 'FAIL' }
$status = if ($failed -eq 0 -and $conflicts -eq 0) { 'PASS' } elseif ($failed -gt 0) { 'FAIL' } else { 'CONFLICT' }

$meta = [ordered]@{
    schema        = 'cgi-handoff/v1'
    batch_id      = $batchId
    created_utc   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    source_host   = $env:COMPUTERNAME
    source_path   = $sourceFull
    source_folder = $sourceName
    target_root   = $root
    target_batch  = $batchPath
    payload_root  = ("payload\{0}" -f $sourceName)
    transport     = 'smb-over-tailscale'
    file_count    = $entries.Count
    total_bytes   = ($entries | Measure-Object -Property Bytes -Sum).Sum
    copied        = $copied
    identical     = $skippedIdentical
    conflicts     = $conflicts
    failed        = $failed
    integrity     = $integrity
    status        = $status
    files         = $entries
}

try {
    Write-HandoffManifest -BatchPath $batchPath -Entries $entries -Meta $meta | Out-Null

    $readme = @"
CGI-1 -> COM1 handoff batch
=========================
batch_id    : $batchId
created_utc : $($meta.created_utc)
source      : $sourceFull
transferred : $($entries.Count) file(s)

Contents
  payload\$sourceName\...   the transferred files
  manifest.sha256          sha256sum-compatible manifest of payload files
  handoff.json             machine readable metadata (status, hashes, counters)

How to consume on COM1
  powershell -ExecutionPolicy Bypass -File verify_handoff.ps1 -BatchPath "<this folder>"
  powershell -ExecutionPolicy Bypass -File receive_to_pr.ps1 -BatchPath "<this folder>" -RepoPath "<repo>"

Integrity rule: nothing here is trusted until verify_handoff.ps1 reports PASS.
"@
    [System.IO.File]::WriteAllText((Join-Path $batchPath 'README-handoff.txt'), $readme, (New-Object System.Text.UTF8Encoding($false)))
} catch {
    Write-HandoffLog -Level ERROR -Message ("Cannot write manifest: {0}" -f $_.Exception.Message)
    Exit-Handoff $script:HandoffExit.TransportFail
}

# --- 6. summary -------------------------------------------------------------

Write-Host ''
Write-Host '=== handoff summary ==='
Write-Host ("  batch      : {0}" -f $batchPath)
Write-Host ("  copied     : {0}" -f $copied)
Write-Host ("  identical  : {0}" -f $skippedIdentical)
Write-Host ("  conflicts  : {0}" -f $conflicts)
Write-Host ("  failed     : {0}" -f $failed)
Write-Host ("  integrity  : {0}" -f $integrity)
Write-Host ''

if ($failed -gt 0) {
    Write-HandoffLog -Level FAIL -Message 'Transfer finished with integrity failures. See manifest.sha256.'
    Exit-Handoff $script:HandoffExit.IntegrityFail
}
if ($conflicts -gt 0) {
    Write-HandoffLog -Level FAIL -Message 'Transfer finished with conflicts. Existing files were left untouched.'
    Exit-Handoff $script:HandoffExit.Conflict
}

Write-HandoffLog -Level PASS -Message ('Transfer complete and verified: {0}' -f $batchPath)
Exit-Handoff $script:HandoffExit.Ok
