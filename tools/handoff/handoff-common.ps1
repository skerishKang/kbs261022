<#
    handoff-common.ps1

    Shared helpers for the CGI-1 -> COM1 handoff pipeline (issue #7).
    Dot-source this file; it does nothing on its own.

        . "$PSScriptRoot\handoff-common.ps1"
#>

Set-StrictMode -Version 2.0

$script:HandoffExit = @{
    Ok             = 0
    IntegrityFail  = 2
    Conflict       = 3
    TransportFail  = 4
    Usage          = 5
}

function Get-HandoffConfig {
    <#
        .SYNOPSIS
            Loads handoff.config.psd1, or the config next to this module.
    #>
    [CmdletBinding()]
    param(
        [string]$ConfigPath
    )

    if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
        $ConfigPath = Join-Path $PSScriptRoot 'handoff.config.psd1'
    }
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        throw "Handoff config not found: $ConfigPath"
    }

    $cfg = Import-PowerShellDataFile -LiteralPath $ConfigPath
    if (-not $cfg.ContainsKey('ReceiveRoot')) {
        throw "Handoff config is missing 'ReceiveRoot': $ConfigPath"
    }
    $cfg['_ConfigPath'] = $ConfigPath
    return $cfg
}

function Test-HandoffPathUnderRoot {
    <#
        .SYNOPSIS
            Boundary-safe containment test.

            'C:\a\CGI-HANDOFF-EVIL' must NOT be treated as being under
            'C:\a\CGI-HANDOFF'. Comparison is case-insensitive because Windows
            paths are case-insensitive, and both sides are normalised to a
            single trailing separator form first.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )

    $normalise = {
        param($p)
        $t = $p.Trim().TrimEnd('\', '/')
        if ($t -eq '') { $t = $p.Trim() }
        return $t
    }

    $nPath = & $normalise $Path
    $nRoot = & $normalise $Root

    if ($nPath -eq $nRoot) { return $true }
    return $nPath.StartsWith($nRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Resolve-HandoffReceiveRoot {
    <#
        .SYNOPSIS
            Returns the receive root to use, or throws when it is not whitelisted.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Config,
        [string]$Requested
    )

    $allowed = @($Config.AllowedReceiveRoots)
    if ($allowed.Count -eq 0) {
        throw 'Handoff config has an empty AllowedReceiveRoots list.'
    }

    $candidate = $Requested
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $candidate = $Config.ReceiveRoot
    }

    foreach ($root in $allowed) {
        if (Test-HandoffPathUnderRoot -Path $candidate -Root $root) {
            return $candidate
        }
    }

    throw ("Receive root '{0}' is not in the allowed list. Allowed: {1}" -f `
        $candidate, ($allowed -join ', '))
}

function Get-HandoffSha256 {
    <#
        .SYNOPSIS
            SHA256 of a single file, lower-case hex.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )
    $hash = Get-FileHash -LiteralPath $Path -Algorithm SHA256
    return $hash.Hash.ToLowerInvariant()
}

function New-HandoffBatchId {
    <#
        .SYNOPSIS
            Sortable, collision-resistant batch identifier.
            Format: yyyyMMddTHHmmssZ-<8 hex>
    #>
    [CmdletBinding()]
    param(
        [string]$Explicit
    )
    if (-not [string]::IsNullOrWhiteSpace($Explicit)) {
        $safe = ($Explicit -replace '[^A-Za-z0-9._-]', '-')
        if ($safe -ne $Explicit) {
            throw "Batch id may only contain A-Z a-z 0-9 . _ - : $Explicit"
        }
        return $safe
    }
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
    $salt = [System.Guid]::NewGuid().ToString('N').Substring(0, 8)
    return "$stamp-$salt"
}

function Get-HandoffRelativePath {
    <#
        .SYNOPSIS
            Path of $File relative to $Root, using forward slashes.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$File,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $fileFull = [System.IO.Path]::GetFullPath($File)
    if ($fileFull.StartsWith($rootFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        $rel = $fileFull.Substring($rootFull.Length + 1)
    } else {
        $rel = [System.IO.Path]::GetFileName($fileFull)
    }
    return $rel.Replace('\', '/')
}

function Get-HandoffFileList {
    <#
        .SYNOPSIS
            Enumerates the files that are eligible for transfer.

        .DESCRIPTION
            Returns objects with Path (absolute) and Rel (relative, forward
            slashes). Excluded names, oversized files and the total size cap
            are reported through the returned `Skipped` collection.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [string[]]$ExcludeNames = @(),
        [long]$MaxFileBytes = 52428800,
        [long]$MaxTotalBytes = 209715200
    )

    $files = New-Object System.Collections.Generic.List[object]
    $skipped = New-Object System.Collections.Generic.List[object]
    $total = [long]0

    $all = Get-ChildItem -LiteralPath $Root -Recurse -File -Force -ErrorAction Stop

    foreach ($f in $all) {
        $segments = $f.FullName.Substring($Root.TrimEnd('\').Length).TrimStart('\') -split '\\'
        $excluded = $false
        foreach ($name in $ExcludeNames) {
            if ($segments -contains $name) { $excluded = $true; break }
        }
        if ($excluded) {
            $skipped.Add([pscustomobject]@{ Path = $f.FullName; Reason = 'excluded-name' })
            continue
        }
        if ($f.Length -gt $MaxFileBytes) {
            $skipped.Add([pscustomobject]@{ Path = $f.FullName; Reason = "larger-than-$MaxFileBytes" })
            continue
        }
        if (($total + $f.Length) -gt $MaxTotalBytes) {
            $skipped.Add([pscustomobject]@{ Path = $f.FullName; Reason = "total-budget-$MaxTotalBytes" })
            continue
        }
        $total += $f.Length
        $files.Add([pscustomobject]@{
            Path = $f.FullName
            Rel  = Get-HandoffRelativePath -File $f.FullName -Root $Root
            Bytes = $f.Length
        })
    }

    return [pscustomobject]@{
        Files   = $files
        Skipped = $skipped
        TotalBytes = $total
    }
}

function Write-HandoffManifest {
    <#
        .SYNOPSIS
            Writes manifest.sha256 (sha256sum compatible) and handoff.json
            into a batch directory.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$BatchPath,
        [Parameter(Mandatory = $true)]$Entries,
        [Parameter(Mandatory = $true)]$Meta
    )

    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($e in $Entries) {
        $lines.Add(('{0}  {1}' -f $e.Sha256, $e.Rel))
    }
    $manifestPath = Join-Path $BatchPath 'manifest.sha256'
    [System.IO.File]::WriteAllLines($manifestPath, $lines, (New-Object System.Text.UTF8Encoding($false)))

    $jsonPath = Join-Path $BatchPath 'handoff.json'
    $json = $Meta | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($jsonPath, $json, (New-Object System.Text.UTF8Encoding($false)))

    return [pscustomobject]@{ Manifest = $manifestPath; Json = $jsonPath }
}

function Read-HandoffManifest {
    <#
        .SYNOPSIS
            Reads manifest.sha256 into entries. Missing file -> empty list.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$BatchPath
    )
    $manifestPath = Join-Path $BatchPath 'manifest.sha256'
    $entries = New-Object System.Collections.Generic.List[object]
    if (-not (Test-Path -LiteralPath $manifestPath)) {
        return $entries
    }
    foreach ($line in [System.IO.File]::ReadAllLines($manifestPath)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        # "<64 hex><two spaces><relative path>"
        $idx = $line.IndexOf('  ')
        if ($idx -lt 0) { continue }
        $hash = $line.Substring(0, $idx).Trim()
        $rel = $line.Substring($idx + 2).Trim()
        $entries.Add([pscustomobject]@{ Sha256 = $hash.ToLowerInvariant(); Rel = $rel })
    }
    return $entries
}

function Write-HandoffLog {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [ValidateSet('INFO', 'WARN', 'ERROR', 'PASS', 'FAIL')][string]$Level = 'INFO'
    )
    $prefix = switch ($Level) {
        'WARN'  { 'WARN ' }
        'ERROR' { 'ERROR' }
        'PASS'  { 'PASS ' }
        'FAIL'  { 'FAIL ' }
        default { 'INFO ' }
    }
    Write-Host ("[{0}] {1}" -f $prefix, $Message)
}
