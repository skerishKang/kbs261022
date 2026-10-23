<#
    bootstrap-com1.ps1  --  one time setup on COM1 (padiem-command-center).

    1. installs the CGI-1 public key into the SSH authorized_keys file
    2. creates the handoff directory layout (incoming / inbox)
    3. prints a short verification hint

    Run it in the SAME Windows account that is used for the SSH login.

    Example (on COM1):
      powershell -NoProfile -ExecutionPolicy Bypass -File bootstrap-com1.ps1 `
        -PublicKey "ssh-ed25519 AAAA... cgi-1-handoff@cgi-1"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $PublicKey,
    [string] $Root = 'C:\cgi-handoff'
)

$ErrorActionPreference = 'Stop'

function Write-Line([string]$Text) { [Console]::Out.WriteLine($Text) }

$PublicKey = $PublicKey.Trim()
if (-not $PublicKey.StartsWith('ssh-') -and -not $PublicKey.StartsWith('ecdsa-') -and -not $PublicKey.StartsWith('sk-')) {
    Write-Line "BOOTSTRAP_ERROR: not_an_ssh_public_key"
    exit 1
}

# --- 1. authorized_keys -----------------------------------------------------
$sshDir = Join-Path $env:USERPROFILE '.ssh'
$authKeys = Join-Path $sshDir 'authorized_keys'

if (-not (Test-Path -LiteralPath $sshDir)) {
    New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
    Write-Line "BOOTSTRAP: created $sshDir"
}

$existing = @()
if (Test-Path -LiteralPath $authKeys) {
    $existing = @(Get-Content -LiteralPath $authKeys | Where-Object { $_.Trim() -ne '' })
}
$already = $false
foreach ($line in $existing) {
    $f = ($line -split '\s+')
    if ($f.Count -ge 2 -and $f[1] -eq ($PublicKey -split '\s+')[1]) { $already = $true; break }
}
if ($already) {
    Write-Line "BOOTSTRAP: public_key_already_installed"
} else {
    # UTF-8 without BOM: OpenSSH on Windows rejects a BOM in authorized_keys
    [IO.File]::AppendAllText($authKeys, $PublicKey + "`r`n", (New-Object Text.UTF8Encoding($false)))
    Write-Line "BOOTSTRAP: public_key_installed path=$authKeys"
}

# Windows OpenSSH requires the key file to be owned by the user and not writable by others.
& icacls.exe $sshDir /inheritance:r /grant "$env:USERNAME:(OI)(CI)F" | Out-Null
& icacls.exe $authKeys /inheritance:r /grant "$env:USERNAME:R" | Out-Null
Write-Line "BOOTSTRAP: acl_applied path=$authKeys"

# --- 2. handoff directories --------------------------------------------------
$incoming = Join-Path $Root 'incoming'
$inbox    = Join-Path $Root 'inbox'
foreach ($d in @($Root, $incoming, $inbox)) {
    if (-not (Test-Path -LiteralPath $d)) {
        New-Item -ItemType Directory -Force -Path $d | Out-Null
        Write-Line "BOOTSTRAP: created $d"
    } else {
        Write-Line "BOOTSTRAP: exists $d"
    }
}

Write-Line "BOOTSTRAP_DONE: user=$env:USERNAME host=$env:COMPUTERNAME inbox=$inbox"
Write-Line "BOOTSTRAP_NEXT: from CGI-1 run  ssh -p 2222 -i ~\.ssh\cgi_handoff_ed25519 $env:USERNAME@100.124.21.64 hostname"
exit 0
