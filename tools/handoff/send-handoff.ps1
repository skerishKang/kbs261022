<#
    send-handoff.ps1  --  CGI-1 side of the CGI-1 -> COM1 handoff pipeline.

    Packages one explicitly named source folder and delivers it to COM1.

    Transports
      ssh       (default) scp/ssh over Tailscale SSH to COM1 (TCP 2222, publickey).
                Fully unattended once the dedicated key is registered on COM1.
      taildrop  Tailscale built-in file transfer (no credentials at all).
                The package arrives as a zip in the COM1 Taildrop inbox and is
                pulled + verified by com1-pull.ps1 on COM1 (one command).

    Safety rules
      * only folders under an allowed source root may be transferred
      * secret-looking files are refused (override with -AllowSensitive)
      * every run uses a fresh run id, so nothing is ever overwritten
      * a package is promoted only after SHA256 verification on the receiver

    Examples
      powershell -NoProfile -File .\send-handoff.ps1 -SourcePath C:\work\kbs261022\reports
      powershell -NoProfile -File .\send-handoff.ps1 -SourcePath C:\work\kbs261022\reports -Transport taildrop
      powershell -NoProfile -File .\send-handoff.ps1 -SourcePath C:\work\kbs261022\reports -Transport taildrop -WaitReceipt
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
    [ValidateSet('ssh', 'taildrop')][string] $Transport = 'ssh',
    [switch] $DryRun,
    [switch] $AllowSensitive,
    [switch] $IncludeLarge,
    [switch] $IncludeGit,
    [switch] $IncludeUntracked,
    [switch] $SkipRemoteVerify,
    [switch] $CleanStaging,
    [switch] $WaitReceipt,
    [int]    $WaitReceiptSeconds = 600
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Line([string]$Text) { [Console]::Out.WriteLine($Text) }
function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

# Runs a native command, mirrors its output and returns its exit code.
# stderr of native tools (tailscale/ssh/scp) is progress information, not an error,
# so ErrorActionPreference is relaxed for the duration of the call.
function Invoke-NativeCmd([string]$Exe, [string[]]$NativeArgs, [string]$LogPrefix = 'HANDOFF_CMD') {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $all = & $Exe @NativeArgs 2>&1
        $code = $LASTEXITCODE
        $script:LastNativeOutput = @($all | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { [string]$_ } })
        foreach ($line in $script:LastNativeOutput) {
            Write-Line "$LogPrefix`: $line"
        }
        return $code
    } finally {
        $ErrorActionPreference = $prev
    }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ConfigPath) { $ConfigPath = Join-Path $scriptDir 'handoff.config.ps1' }
$cfg = & $ConfigPath

if (-not $RemoteUser)        { $RemoteUser     = $cfg.RemoteUser }
if (-not $RemoteHostName)   { $RemoteHostName = $cfg.RemoteHost }
if ($RemotePort -le 0)      { $RemotePort     = $cfg.RemotePort }
if (-not $IdentityFile)     { $IdentityFile   = $cfg.IdentityFile }
if (-not $RemoteIncoming)   { $RemoteIncoming = $cfg.RemoteIncoming }
if (-not $RemoteInbox)      { $RemoteInbox    = $cfg.RemoteInbox }
$tailscaleExe = $cfg.TailscaleExe

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

if ($Transport -eq 'ssh' -and -not (Test-Path -LiteralPath $IdentityFile)) {
    Write-Line "HANDOFF_ABORT: identity_key_missing path=$IdentityFile"
    Write-Line "HANDOFF_ABORT: use -Transport taildrop until the COM1 public key is registered"
    exit 2
}
if ($Transport -eq 'taildrop' -and -not (Test-Path -LiteralPath $tailscaleExe)) {
    Write-Line "HANDOFF_ABORT: tailscale_cli_missing path=$tailscaleExe"
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

Write-Line "HANDOFF_INFO: source=$src files=$($files.Count) skipped=$($skipped.Count) transport=$Transport"

# --------------------------------------------------------------------------
# 2b. git guard: never ship another agent's uncommitted work
#     When the source folder lives inside a git work tree only files that are
#     already tracked (committed) are packaged. Use -IncludeUntracked to
#     override (e.g. when the WIP is the very thing that must be delivered).
# --------------------------------------------------------------------------
$onlyTracked = [bool]$cfg.OnlyTrackedByDefault
if ($IncludeUntracked) { $onlyTracked = $false }
if ($onlyTracked) {
    $tracked = $null
    $gitRoot = (& git -C $src rev-parse --show-toplevel 2>$null | Select-Object -First 1)
    if ($gitRoot) {
        $rel = $src.Substring($gitRoot.Length).TrimStart('\', '/') -replace '\\', '/'
        $argsList = @('-C', $gitRoot, 'ls-files', '-z')
        if ($rel) { $argsList += @('--', $rel) }
        $raw = (& git @argsList 2>$null) -join "`n"
        $trackedSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($t in ($raw -split "`n")) { if ($t.Trim()) { [void]$trackedSet.Add($t.Trim()) } }
        $kept = New-Object System.Collections.Generic.List[object]
        foreach ($f in $files) {
            $relFile = $f.path
            if ($rel) { $relFile = "$rel/$($f.path)" }
            if ($trackedSet.Contains($relFile)) { $kept.Add($f) } else { $skipped.Add("untracked_not_committed:$($f.path)") }
        }
        $files = $kept
        Write-Line "HANDOFF_INFO: git_guard tracked_only=true repo=$gitRoot kept=$($files.Count)"
    } else {
        Write-Line "HANDOFF_INFO: git_guard skipped reason=not_a_git_work_tree"
    }
}

# group skips by reason so the log stays readable (.git alone would produce hundreds of lines)
$grouped = $skipped | Group-Object { ($_ -split ':')[0] }
foreach ($g in $grouped) { Write-Line "HANDOFF_SKIP: reason=$($g.Name) count=$($g.Count)" }
foreach ($s in ($skipped | Where-Object { $_ -notmatch '^excluded_(dir|name|ext):' })) { Write-Line "HANDOFF_SKIP: $s" }
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
    transport     = $Transport
    fileCount     = $files.Count
    files         = @($files | ForEach-Object { [ordered]@{ path = $_.path; sha256 = $_.sha256; size = $_.size; mtimeUtc = $_.mtimeUtc } })
}
$manifestPath = Join-Path $stage 'manifest.json'
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
$manifestHash = Get-Sha256 $manifestPath
$manifestHash | Set-Content -LiteralPath (Join-Path $stage 'manifest.sha256') -Encoding ASCII
Copy-Item -LiteralPath (Join-Path $scriptDir 'verify-package.ps1') -Destination (Join-Path $handoffDir 'verify-package.ps1') -Force
Copy-Item -LiteralPath (Join-Path $scriptDir 'com1-pull.ps1')       -Destination (Join-Path $handoffDir 'com1-pull.ps1')       -Force
Copy-Item -LiteralPath (Join-Path $scriptDir 'apply-handoff.ps1')   -Destination (Join-Path $handoffDir 'apply-handoff.ps1')   -Force

Write-Line "HANDOFF_INFO: run_id=$runId manifest_sha256=$manifestHash"

if ($DryRun) {
    Write-Line "HANDOFF_DRYRUN: package_staged_at=$stage files=$($files.Count)"
    exit 0
}

# --------------------------------------------------------------------------
# 4. transport
# --------------------------------------------------------------------------
if ($Transport -eq 'taildrop') {
    # 4a. zip the package (Taildrop transfers files, not folders)
    $zipPath = Join-Path $stageBase "cgi-handoff-$runId.zip"
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipPath -CompressionLevel Optimal
    $zipHash = Get-Sha256 $zipPath
    Write-Line "HANDOFF_INFO: taildrop_package=$zipPath sha256=$zipHash"

    # 4b. push to the COM1 Taildrop inbox
    Write-Line "HANDOFF_INFO: tailscale file cp -> ${RemoteHostName}:"
    $code = Invoke-NativeCmd $tailscaleExe @('file', 'cp', '--verbose', $zipPath, "${RemoteHostName}:") 'HANDOFF_TAILDROP'
    if ($code -ne 0) {
        Write-Line "HANDOFF_FAIL: taildrop_send_failed exit=$code run_id=$runId"
        exit 3
    }
    Write-Line "HANDOFF_SENT: transport=taildrop run_id=$runId zip=$([IO.Path]::GetFileName($zipPath)) zip_sha256=$zipHash manifest_sha256=$manifestHash"
    Write-Line "HANDOFF_NEXT: on COM1 run  powershell -NoProfile -File com1-pull.ps1  (or the one-liner in docs/CGI_LOCAL_HANDOFF.md)"

    # 4c. optional: wait for the signed receipt to come back
    if ($WaitReceipt) {
        $receipt = & (Join-Path $scriptDir 'check-receipt.ps1') -RunId $runId -ExpectedManifestSha256 $manifestHash -TimeoutSeconds $WaitReceiptSeconds -TailscaleExe $tailscaleExe
        if ($LASTEXITCODE -ne 0) {
            Write-Line "HANDOFF_FAIL: receipt_not_confirmed run_id=$runId"
            exit 4
        }
        Write-Line "HANDOFF_PASS: transport=taildrop run_id=$runId files=$($files.Count) manifest_sha256=$manifestHash receipt_confirmed=True"
    }
    if ($CleanStaging) {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
        Write-Line "HANDOFF_INFO: staging_removed path=$stage"
    }
    exit 0
}

# ---- SSH transport ---------------------------------------------------------
$sshOpts = @(
    '-p', "$RemotePort",
    '-i', $IdentityFile,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15'
)
$target = "$RemoteUser@$RemoteHostName"

Write-Line "HANDOFF_INFO: preflight ssh $target (port $RemotePort)"
$code = Invoke-NativeCmd 'ssh' ($sshOpts + @($target, 'echo HANDOFF_SSH_OK')) 'HANDOFF_SSH'
if ($code -ne 0) {
    Write-Line "HANDOFF_FAIL: ssh_preflight_failed exit=$code"
    exit 3
}

$remoteStage = "$RemoteIncoming/$runId.part"
Write-Line "HANDOFF_INFO: scp -> ${target}:$remoteStage"
$code = Invoke-NativeCmd 'scp' (@('-r', '-P', "$RemotePort", '-i', $IdentityFile,
    '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
    '--', $stage, "${target}:$RemoteIncoming/")) 'HANDOFF_SCP'
if ($code -ne 0) {
    Write-Line "HANDOFF_FAIL: scp_failed exit=$code"
    exit 3
}
Write-Line "HANDOFF_INFO: transfer_complete run_id=$runId"

if ($SkipRemoteVerify) {
    Write-Line "HANDOFF_WARN: remote_verification_skipped run_id=$runId"
    exit 0
}

$remoteScript = "$remoteStage/_handoff/verify-package.ps1"
$remoteCmd = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $remoteScript + '" -PackageRoot "' + $remoteStage + '" -ExpectedRunId "' + $runId + '" -MoveTo "' + $RemoteInbox + '"'
Write-Line "HANDOFF_INFO: remote verify (sha256) on $target"
$verifyExit = Invoke-NativeCmd 'ssh' ($sshOpts + @($target, $remoteCmd)) 'HANDOFF_REMOTE'
if ($verifyExit -ne 0) {
    Write-Line "HANDOFF_FAIL: remote_verification_failed exit=$verifyExit run_id=$runId"
    exit 4
}
if (-not ($script:LastNativeOutput | Where-Object { "$_" -match 'HANDOFF_VERIFY: PASS' })) {
    Write-Line "HANDOFF_FAIL: remote_verification_no_pass_marker run_id=$runId"
    exit 4
}
if (-not ($verifyOut | Where-Object { "$_" -match 'HANDOFF_VERIFY: PASS' })) {
    Write-Line "HANDOFF_FAIL: remote_verification_no_pass_marker run_id=$runId"
    exit 4
}

Write-Line "HANDOFF_PASS: transport=ssh run_id=$runId files=$($files.Count) manifest_sha256=$manifestHash inbox=$RemoteInbox/$runId"

if ($CleanStaging) {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    Write-Line "HANDOFF_INFO: staging_removed path=$stage"
}
exit 0
