<#
    verify-package.ps1  --  COM1 side package verifier.

    Verifies a handoff package produced by send-handoff.ps1:
      1. manifest.json hash matches manifest.sha256
      2. every file listed in the manifest exists with the recorded SHA256
      3. writes receipt.json (audit trail)
      4. optionally promotes the package from "<runId>.part" to "<runId>"

    Never overwrites an existing file or directory.

    Usage (on COM1):
      powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File verify-package.ps1 `
        -PackageRoot "C:/cgi-handoff/incoming/20261022-120000-ab12" `
        -ExpectedRunId "20261022-120000-ab12" `
        -MoveTo "C:/cgi-handoff/inbox"

    Exit code 0 = PASS, 1 = FAIL.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $PackageRoot,
    [string] $ExpectedRunId,
    [string] $MoveTo,
    [switch] $KeepInPlace
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Line([string]$Text) { [Console]::Out.WriteLine($Text) }

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$failures = New-Object System.Collections.Generic.List[string]

try {
    $root = (Resolve-Path -LiteralPath $PackageRoot).Path
} catch {
    Write-Line "HANDOFF_VERIFY: FAIL reason=package_root_not_found path=$PackageRoot"
    exit 1
}

$manifestPath = Join-Path $root 'manifest.json'
$manifestHashPath = Join-Path $root 'manifest.sha256'
$payloadRoot = Join-Path $root 'payload'

if (-not (Test-Path -LiteralPath $manifestPath)) {
    Write-Line "HANDOFF_VERIFY: FAIL reason=manifest_missing path=$manifestPath"
    exit 1
}
if (-not (Test-Path -LiteralPath $manifestHashPath)) {
    Write-Line "HANDOFF_VERIFY: FAIL reason=manifest_hash_missing path=$manifestHashPath"
    exit 1
}

# --- 1. manifest integrity ---------------------------------------------------
$expectedManifestHash = ((Get-Content -LiteralPath $manifestHashPath -Raw) -split '\s+')[0].Trim().ToLowerInvariant()
$actualManifestHash = Get-Sha256 $manifestPath
if ($expectedManifestHash -ne $actualManifestHash) {
    Write-Line "HANDOFF_VERIFY: FAIL reason=manifest_hash_mismatch expected=$expectedManifestHash actual=$actualManifestHash"
    exit 1
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$runId = [string]$manifest.runId
if ($ExpectedRunId -and $runId -ne $ExpectedRunId) {
    $failures.Add("run_id_mismatch expected=$ExpectedRunId actual=$runId")
}

# --- 2. payload integrity ----------------------------------------------------
$checked = 0
foreach ($f in $manifest.files) {
    $rel = [string]$f.path
    $target = Join-Path $payloadRoot ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
        $failures.Add("missing:$rel")
        continue
    }
    $h = Get-Sha256 $target
    if ($h -ne ([string]$f.sha256).ToLowerInvariant()) {
        $failures.Add("sha256_mismatch:$rel expected=$($f.sha256) actual=$h")
        continue
    }
    $checked++
}

# --- 3. promote (never overwrite) --------------------------------------------
$promoted = $false
$finalRoot = $root
if ($MoveTo -and $failures.Count -eq 0 -and -not $KeepInPlace) {
    if (-not (Test-Path -LiteralPath $MoveTo)) {
        New-Item -ItemType Directory -Force -Path $MoveTo | Out-Null
    }
    $dest = Join-Path $MoveTo $runId
    if (Test-Path -LiteralPath $dest) {
        $failures.Add("destination_exists:$dest")
    } else {
        Move-Item -LiteralPath $root -Destination $dest
        $promoted = $true
        $finalRoot = $dest
    }
}

# --- 4. receipt (written to the final location) -----------------------------
$receipt = [ordered]@{
    runId         = $runId
    verifiedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    verifiedOn    = $env:COMPUTERNAME
    packageRoot   = $root
    manifestSha256 = $actualManifestHash
    fileCount     = @($manifest.files).Count
    verifiedCount = $checked
    failures      = @($failures)
    promoted      = $promoted
    finalRoot     = $finalRoot
    result        = 'PASS'
}
if ($failures.Count -gt 0) { $receipt.result = 'FAIL' }

$receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $finalRoot 'receipt.json') -Encoding UTF8

if ($failures.Count -gt 0) {
    Write-Line "HANDOFF_VERIFY: FAIL runId=$runId failures=$($failures.Count)"
    foreach ($x in $failures) { Write-Line "HANDOFF_FAIL: $x" }
    exit 1
}

Write-Line "HANDOFF_VERIFY: PASS runId=$runId files=$checked promoted=$promoted"
exit 0
