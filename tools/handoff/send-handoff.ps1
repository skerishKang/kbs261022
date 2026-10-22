<#
    send-handoff.ps1  --  CGI-1 side of the CGI-1 -> COM1 handoff pipeline.

    Packages one explicitly named source folder, transfers it to COM1 over
    Tailscale SSH (OpenSSH on COM1, TCP 2222) and verifies SHA256 on the
    receiver before the package is promoted into the COM1 inbox.

    Safety rules
      * only folders under an allowed source root may be transferred
      * secret-looking files are refused (override with -AllowSensitive)
      * every run uses a fresh run id, so nothing is ever overwritten
      * a package is promoted only after remote SHA256 verification passes

    Examples
      powershell -NoProfile -File .\send-handoff.ps1 -SourcePath C:\Users\sji\cgi-work\kbs261022\reports
      powershell -NoProfile -File .\send-handoff.ps1 -SourcePath <folder> -DryRun
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $SourcePath,

    # Optional overrides (defaults come from handoff.config.ps1)
    [string] $RemoteUser,
    [string] $RemoteHostName,
    [int]    $RemotePort = 0,
    [string] $IdentityFile,
    [string] $RemoteIncoming,
    [string] $RemoteInbox,
    [string] $ConfigPath,

    # Behaviour
    [switch] $DryRun,
    [switch] $AllowSensitive,
    [switch] $IncludeLarge,
    [switch] $IncludeGit,
    [switch] $SkipRemoteVerify,
    [switch] $CleanStaging
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Line([string]$Text) { [Console]::Out.WriteLine($Text) }
function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ConfigPath) { $ConfigPath = Join-Path $scriptDir 'handoff.config.ps1' }
$cfg = & $ConfigPath

if (-not $RemoteUser)        { $RemoteUser     = $cfg.RemoteUser }
if (-not $RemoteHostName)   { $RemoteHostName = $cfg.RemoteHost }
if ($RemotePort -le 0)      { $RemotePort     = $cfg.RemotePort }
if (-not $IdentityFile)     { $IdentityFile   = $cfg.IdentityFile }
if (-not $RemoteIncoming)   { $RemoteIncoming = $cfg.RemoteIncoming }
if (-not $RemoteInbox)      { $RemoteInbox    = $cfg.RemoteInbox }

# --------------------------------------------------------------------------
# 1. validate the source folder
# --------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $SourcePath)) {
    Write-Line "HANDOFF_ABORT: source_not_found path=$SourcePath"
    exit 2
}
$src = (Resolve-Path -LiteralPath $SourcePath).Path
if (-not (Test-Path -LiteralPath $src -PathType Container)) {
    Write-Line "HANDOFF_ABORT: source_is_not_a_folder path=$src"
    exit 2
}

$allowedRoots = @($cfg.AllowedSourceRoots | ForEach-Object { (Resolve-Path -LiteralPath $_ -ErrorAction SilentlyContinue).Path })
$allowed = $false
foreach ($r in $allowedRoots) {
    if ($src -eq $r -or $src.StartsWith($r.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { $allowed = $true; break }
}
if (-not $allowed) {
    Write-Line "HANDOFF_ABORT: source_outside_allowed_roots path=$src"
    Write-Line "HANDOFF_ABORT: allowed_roots=$($allowedRoots -join ';')"
    exit 2
}

if (-not (Test-Path -LiteralPath $IdentityFile)) {
    Write-Line "HANDOFF_ABORT: identity_key_missing path=$IdentityFile"
    exit 2
}

# --------------------------------------------------------------------------
# 2. collect files
# --------------------------------------------------------------------------
$excludeDirs  = @($cfg.ExcludeDirNames)
$excludeFiles = @($cfg.ExcludeFileNames)
$excludeExts  = @($cfg.ExcludeExts)
$sensitivePat = @($cfg.SensitiveNamePatterns)
$maxBytes     = [int64]$cfg.MaxFileSizeMB * 1MB

$files = New-Object System.Collections.Generic.List[object]
$skipped = New-Object System.Collections.Generic.List[string]

Get-ChildItem -LiteralPath $src -Recurse -File -Force | ForEach-Object {
    $rel = $_.FullName.Substring($src.Length).TrimStart('\', '/') -replace '\\', '/'

    $parts = $rel -split '/'
    $inExcludedDir = $false
    foreach ($p in $parts[0..([Math]::Max(0, $parts.Count - 2))]) {
        if ($excludeDirs -contains $p) { $inExcludedDir = $true; break }
    }
    if ($inExcludedDir) { $skipped.Add("excluded_dir:$rel"); return }
    if (-not $IncludeGit -and ($parts -contains '.git')) { $skipped.Add("excluded_dir:$rel"); return }
    if ($excludeFiles -contains $_.Name) { $skipped.Add("excluded_name:$rel"); return }
    if ($excludeExts -contains $_.Extension.ToLowerInvariant()) { $skipped.Add("excluded_ext:$rel"); return }

    if (-not $AllowSensitive) {
        $isSensitive = $false
        foreach ($pat in $sensitivePat) { if ($rel -match $pat) { $isSensitive = $true; break } }
        if ($isSensitive) { $skipped.Add("sensitive_refused:$rel"); return }
    }

    if (-not $IncludeLarge -and $_.Length -gt $maxBytes) { $skipped.Add("too_large:$rel"); return }

    $files.Add([pscustomobject]@{
        path      = $rel
        fullPath  = $_.FullName
        size      = $_.Length
        mtimeUtc  = $_.LastWriteTimeUtc.ToString('o')
        sha256    = (Get-Sha256 $_.FullName)
    })
}

Write-Line "HANDOFF_INFO: source=$src files=$($files.Count) skipped=$($skipped.Count)"
foreach ($s in $skipped) { Write-Line "HANDOFF_SKIP: $s" }
if ($files.Count -eq 0) {
    Write-Line "HANDOFF_ABORT: no_files_to_transfer"
    exit 2
}

# --------------------------------------------------------------------------
# 3. stage the package
# --------------------------------------------------------------------------
$runId = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), ([guid]::NewGuid().ToString('N').Substring(0,4))
$stageBase = Join-Path $env:TEMP 'cgi-handoff-staging'
$stage = Join-Path $stageBase "$runId.part"
$payload = Join-Path $stage 'payload'
$handoffDir = Join-Path $stage '_handoff'

New-Item -ItemType Directory -Force -Path $payload  | Out-Null
New-Item -ItemType Directory -Force -Path $handoffDir | Out-Null

foreach ($f in $files) {
    $dest = Join-Path $payload ($f.path -replace '/', '\')
    $destDir = Split-Path -Parent $dest
    if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
    Copy-Item -LiteralPath $f.fullPath -Destination $dest -Force
}

$manifest = [ordered]@{
    schemaVersion = 1
    runId         = $runId
    createdAtUtc  = (Get-Date).ToUniversalTime().ToString('o')
    sourceHost    = $env:COMPUTERNAME
    sourceUser    = $env:USERNAME
    sourcePath    = $src
    payloadRoot   = 'payload'
    targetHost    = $RemoteHostName
    fileCount     = $files.Count
    files         = @($files | ForEach-Object { [ordered]@{ path = $_.path; sha256 = $_.sha256; size = $_.size; mtimeUtc = $_.mtimeUtc } })
}
$manifestPath = Join-Path $stage 'manifest.json'
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
$manifestHash = Get-Sha256 $manifestPath
$manifestHash | Set-Content -LiteralPath (Join-Path $stage 'manifest.sha256') -Encoding ASCII
Copy-Item -LiteralPath (Join-Path $scriptDir 'verify-package.ps1') -Destination (Join-Path $handoffDir 'verify-package.ps1') -Force

Write-Line "HANDOFF_INFO: run_id=$runId manifest_sha256=$manifestHash"

if ($DryRun) {
    Write-Line "HANDOFF_DRYRUN: package_staged_at=$stage files=$($files.Count)"
    exit 0
}

# --------------------------------------------------------------------------
# 4. transfer over Tailscale SSH
# --------------------------------------------------------------------------
$sshOpts = @(
    '-p', "$RemotePort",
    '-i', $IdentityFile,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15'
)
$target = "$RemoteUser@$RemoteHostName"

Write-Line "HANDOFF_INFO: preflight ssh $target (port $RemotePort)"
& ssh @sshOpts $target 'echo HANDOFF_SSH_OK' 2>&1 | ForEach-Object { Write-Line "HANDOFF_SSH: $_" }
if ($LASTEXITCODE -ne 0) {
    Write-Line "HANDOFF_FAIL: ssh_preflight_failed exit=$LASTEXITCODE"
    exit 3
}

$remoteStage = "$RemoteIncoming/$runId.part"
Write-Line "HANDOFF_INFO: scp -> ${target}:$remoteStage"
& scp -r -P $RemotePort -i $IdentityFile -o 'StrictHostKeyChecking=accept-new' -o 'BatchMode=yes' -o 'ConnectTimeout=15' `
    -- $stage "${target}:$RemoteIncoming/" 2>&1 | ForEach-Object { Write-Line "HANDOFF_SCP: $_" }
if ($LASTEXITCODE -ne 0) {
    Write-Line "HANDOFF_FAIL: scp_failed exit=$LASTEXITCODE"
    exit 3
}
Write-Line "HANDOFF_INFO: transfer_complete run_id=$runId"

# --------------------------------------------------------------------------
# 5. remote SHA256 verification + promotion
# --------------------------------------------------------------------------
if ($SkipRemoteVerify) {
    Write-Line "HANDOFF_WARN: remote_verification_skipped run_id=$runId"
    exit 0
}

$remoteScript = "$remoteStage/_handoff/verify-package.ps1"
$remoteCmd = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $remoteScript + '" -PackageRoot "' + $remoteStage + '" -ExpectedRunId "' + $runId + '" -MoveTo "' + $RemoteInbox + '"'
Write-Line "HANDOFF_INFO: remote verify (sha256) on $target"
$verifyOut = & ssh @sshOpts $target $remoteCmd 2>&1
$verifyOut | ForEach-Object { Write-Line "HANDOFF_REMOTE: $_" }
$verifyExit = $LASTEXITCODE
if ($verifyExit -ne 0) {
    Write-Line "HANDOFF_FAIL: remote_verification_failed exit=$verifyExit run_id=$runId"
    exit 4
}
if (-not ($verifyOut | Where-Object { "$_" -match 'HANDOFF_VERIFY: PASS' })) {
    Write-Line "HANDOFF_FAIL: remote_verification_no_pass_marker run_id=$runId"
    exit 4
}

Write-Line "HANDOFF_PASS: run_id=$runId files=$($files.Count) manifest_sha256=$manifestHash inbox=$RemoteInbox/$runId"

if ($CleanStaging) {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    Write-Line "HANDOFF_INFO: staging_removed path=$stage"
}
exit 0
