<#
.SYNOPSIS
    COM1 side: verifies a received handoff batch, stages it into the local clone
    of the CGI project repository, and optionally pushes a branch and opens a
    pull request.

.DESCRIPTION
    This is the second half of the handoff pipeline described in issue #7.

    Order of operations (each step is a gate for the next one):
      1. verify the batch with the same SHA256 manifest (integrity gate)
      2. copy the payload into the repository work tree
      3. create a new branch and commit
      4. optionally push the branch and open a PR

    Safety rules:
      * A file that already exists in the work tree with different content is
        never overwritten; the run stops with a conflict.
      * The base branch is never modified and never force-pushed.
      * The work tree must be clean unless -AllowDirty is given.

.EXAMPLE
    .\receive_to_pr.ps1 -BatchPath C:\Users\Public\CGI-HANDOFF\batch-20261022T120000Z-ab12cd34 `
        -RepoPath C:\cgi-work\kbs261022 -Push -OpenPR
#>
[CmdletBinding()]
param(
    [string]$BatchPath,
    [string]$ReceiveRoot,
    [string]$RepoPath,
    [string]$ConfigPath,
    [string]$TargetSubdir,
    [string]$BranchName,
    [string]$CommitMessage,
    [switch]$Push,
    [switch]$OpenPR,
    [switch]$AllowDirty,
    [switch]$DryRun
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'handoff-common.ps1')

function Exit-Handoff {
    param([int]$Code)
    exit $Code
}

$config = Get-HandoffConfig -ConfigPath $ConfigPath

# --- locate batch ---------------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($BatchPath)) {
    if ([string]::IsNullOrWhiteSpace($ReceiveRoot)) { $ReceiveRoot = $config.ReceiveRoot }
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

# --- locate repository -----------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($RepoPath)) { $RepoPath = $config.Com1RepoPath }
if (-not (Test-Path -LiteralPath $RepoPath -PathType Container)) {
    Write-HandoffLog -Level ERROR -Message ("Repository folder not found: {0}" -f $RepoPath)
    Write-HandoffLog -Level ERROR -Message 'Pass -RepoPath with the real path of the kbs261022 clone on COM1.'
    Exit-Handoff $script:HandoffExit.Usage
}
if (-not (Test-Path -LiteralPath (Join-Path $RepoPath '.git'))) {
    Write-HandoffLog -Level ERROR -Message ("Not a git work tree: {0}" -f $RepoPath)
    Exit-Handoff $script:HandoffExit.Usage
}

Write-HandoffLog -Message ("batch : {0}" -f $BatchPath)
Write-HandoffLog -Message ("repo  : {0}" -f $RepoPath)

# --- 1. integrity gate -----------------------------------------------------------

Write-Host ''
Write-Host '--- step 1/4: verify batch integrity ---'
& (Join-Path $PSScriptRoot 'verify_handoff.ps1') -BatchPath $BatchPath
if ($LASTEXITCODE -ne 0) {
    Write-HandoffLog -Level ERROR -Message ("Batch verification failed (exit {0}). Nothing was staged." -f $LASTEXITCODE)
    Exit-Handoff $LASTEXITCODE
}

# --- determine the payload root and the destination -------------------------------

$metaPath = Join-Path $BatchPath 'handoff.json'
$meta = $null
if (Test-Path -LiteralPath $metaPath) {
    $meta = Get-Content -LiteralPath $metaPath -Raw -Encoding UTF8 | ConvertFrom-Json
}
$sourceFolder = 'payload'
if ($meta -and $meta.PSObject.Properties.Name -contains 'source_folder' -and $meta.source_folder) {
    $sourceFolder = $meta.source_folder
}

$payloadRoot = Join-Path (Join-Path $BatchPath 'payload') $sourceFolder
if (-not (Test-Path -LiteralPath $payloadRoot -PathType Container)) {
    $cands = @(Get-ChildItem -LiteralPath (Join-Path $BatchPath 'payload') -Directory -ErrorAction SilentlyContinue)
    if ($cands.Count -ne 1) {
        Write-HandoffLog -Level ERROR -Message 'Cannot determine the payload root inside the batch.'
        Exit-Handoff $script:HandoffExit.Usage
    }
    $payloadRoot = $cands[0].FullName
}

if ([string]::IsNullOrWhiteSpace($TargetSubdir)) { $TargetSubdir = $sourceFolder }
$destRoot = Join-Path $RepoPath $TargetSubdir

# --- 2. stage the payload ----------------------------------------------------------

Write-Host ''
Write-Host '--- step 2/4: stage payload into the work tree ---'

$status = & git -C $RepoPath status --porcelain
if ($LASTEXITCODE -ne 0) {
    Write-HandoffLog -Level ERROR -Message 'git status failed inside the repository.'
    Exit-Handoff $script:HandoffExit.Usage
}
if ($status -and -not $AllowDirty) {
    Write-HandoffLog -Level ERROR -Message 'The work tree has uncommitted changes. Commit or stash them first, or pass -AllowDirty.'
    $status | ForEach-Object { Write-Host ("  " + $_) }
    Exit-Handoff $script:HandoffExit.Usage
}

$staged = 0
$conflicts = 0
$unchanged = 0
$createdHere = New-Object System.Collections.Generic.List[string]

$payloadFiles = Get-ChildItem -LiteralPath $payloadRoot -Recurse -File -Force
foreach ($f in $payloadFiles) {
    $rel = Get-HandoffRelativePath -File $f.FullName -Root $payloadRoot
    $dest = Join-Path $destRoot $rel
    $srcHash = Get-HandoffSha256 -Path $f.FullName

    if (Test-Path -LiteralPath $dest -PathType Leaf) {
        $destHash = Get-HandoffSha256 -Path $dest
        if ($destHash -eq $srcHash) {
            Write-HandoffLog -Level PASS -Message ("already present, identical: {0}" -f $rel)
            $unchanged++
            continue
        }
        Write-HandoffLog -Level FAIL -Message ("CONFLICT, existing file left untouched: {0}" -f (Join-Path $TargetSubdir $rel))
        $conflicts++
        continue
    }

    $parent = Split-Path $dest -Parent
    if (-not (Test-Path -LiteralPath $parent)) {
        [System.IO.Directory]::CreateDirectory($parent) | Out-Null
    }
    if ($DryRun) {
        Write-HandoffLog -Message ("would copy: {0}" -f (Join-Path $TargetSubdir $rel))
        $staged++
        continue
    }
    [System.IO.File]::Copy($f.FullName, $dest, $false)
    $createdHere.Add($dest)
    Write-HandoffLog -Level PASS -Message ("staged: {0}" -f (Join-Path $TargetSubdir $rel))
    $staged++
}

Write-Host ("  staged={0} identical={1} conflicts={2}" -f $staged, $unchanged, $conflicts)

if ($conflicts -gt 0) {
    # roll back the files this run created so the work tree is left as it was found
    foreach ($c in $createdHere) {
        try { [System.IO.File]::Delete($c) } catch { }
    }
    Write-HandoffLog -Level ERROR -Message ("Rolled back {0} file(s) copied by this run." -f $createdHere.Count)
    Write-HandoffLog -Level ERROR -Message 'Conflicts detected. Resolve them by hand - nothing was overwritten and no commit was made.'
    Exit-Handoff $script:HandoffExit.Conflict
}

if ($staged -eq 0 -and $unchanged -eq 0) {
    Write-HandoffLog -Level ERROR -Message 'Nothing to stage from this batch.'
    Exit-Handoff $script:HandoffExit.Usage
}

if ($DryRun) {
    Write-HandoffLog -Level PASS -Message 'DRY RUN - stopping before the git steps.'
    Exit-Handoff $script:HandoffExit.Ok
}

# --- 3. branch + commit --------------------------------------------------------------

Write-Host ''
Write-Host '--- step 3/4: branch and commit ---'

$batchId = Split-Path $BatchPath -Leaf
if ([string]::IsNullOrWhiteSpace($BranchName)) {
    $BranchName = 'handoff/' + ($batchId -replace '^batch-', '' -replace '[^A-Za-z0-9._/-]', '-')
}
if ([string]::IsNullOrWhiteSpace($CommitMessage)) {
    $CommitMessage = "chore(handoff): receive CGI-1 batch {0}" -f $batchId
}

$currentBranch = (& git -C $RepoPath rev-parse --abbrev-ref HEAD).Trim()
$baseBranch = $config.BaseBranch
if ($currentBranch -eq $BranchName) {
    Write-HandoffLog -Level ERROR -Message ("Branch {0} is already checked out. Switch away from it first." -f $BranchName)
    Exit-Handoff $script:HandoffExit.Conflict
}
$branchExists = (& git -C $RepoPath rev-parse --verify --quiet $BranchName) 2>$null
if ($branchExists) {
    Write-HandoffLog -Level ERROR -Message ("Branch {0} already exists. Choose another -BranchName; existing branches are never rewritten." -f $BranchName)
    Exit-Handoff $script:HandoffExit.Conflict
}
if ($currentBranch -eq $baseBranch) {
    Write-HandoffLog -Message ("creating branch {0} from {1}" -f $BranchName, $currentBranch)
} else {
    Write-HandoffLog -Level ERROR -Message ("The work tree is on '{0}', not the base branch '{1}'. Switch to the base branch first." -f $currentBranch, $baseBranch)
    Exit-Handoff $script:HandoffExit.Usage
}

& git -C $RepoPath checkout -b $BranchName
if ($LASTEXITCODE -ne 0) {
    Write-HandoffLog -Level ERROR -Message 'git checkout -b failed.'
    Exit-Handoff $script:HandoffExit.Usage
}

& git -C $RepoPath add -- $TargetSubdir
if ($LASTEXITCODE -ne 0) {
    Write-HandoffLog -Level ERROR -Message 'git add failed.'
    Exit-Handoff $script:HandoffExit.Usage
}

# git needs an author identity; fail early with an actionable message
$gitEmail = (& git -C $RepoPath config user.email 2>$null)
if ([string]::IsNullOrWhiteSpace($gitEmail)) {
    Write-HandoffLog -Level ERROR -Message 'git has no user.email configured, so the commit cannot be created.'
    Write-HandoffLog -Level ERROR -Message ("Set it once with: git -C `"$RepoPath`" config user.email <you@example.com>  (and user.name <Your Name>)")
    Exit-Handoff $script:HandoffExit.Usage
}

# nothing staged -> the payload was already present and identical
& git -C $RepoPath diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
    Write-HandoffLog -Level WARN -Message 'Nothing new to commit - every payload file is already present with identical content.'
    Write-HandoffLog -Level WARN -Message ("Branch {0} was created but left empty. Delete it with: git -C `"$RepoPath`" branch -D {0}" -f $BranchName)
    Exit-Handoff $script:HandoffExit.Ok
}

& git -C $RepoPath commit -m $CommitMessage
if ($LASTEXITCODE -ne 0) {
    Write-HandoffLog -Level ERROR -Message 'git commit failed (nothing may be left staged that git rejected).'
    Exit-Handoff $script:HandoffExit.Usage
}

$commit = (& git -C $RepoPath rev-parse HEAD).Trim()
Write-HandoffLog -Level PASS -Message ("commit {0} on {1}" -f $commit.Substring(0, 10), $BranchName)

# --- 4. push + PR --------------------------------------------------------------------

Write-Host ''
Write-Host '--- step 4/4: push and pull request ---'

$remote = $config.RemoteName
$githubRepo = $config.GitHubRepo
$prUrl = "https://github.com/{0}/compare/{1}...{2}?expand=1" -f $githubRepo, $baseBranch, $BranchName

if (-not $Push) {
    Write-HandoffLog -Message ("Not pushing (use -Push). When you are ready: git -C `"$RepoPath`" push -u $remote $BranchName")
    Write-HandoffLog -Message ("Then open the PR: {0}" -f $prUrl)
    Exit-Handoff $script:HandoffExit.Ok
}

& git -C $RepoPath push -u $remote $BranchName
if ($LASTEXITCODE -ne 0) {
    Write-HandoffLog -Level ERROR -Message 'git push failed. The commit is safe in the local branch; re-run the push after fixing the remote.'
    Exit-Handoff $script:HandoffExit.TransportFail
}
Write-HandoffLog -Level PASS -Message ("pushed {0} to {1}" -f $BranchName, $remote)

if (-not $OpenPR) {
    Write-HandoffLog -Message ("Open the PR here: {0}" -f $prUrl)
    Exit-Handoff $script:HandoffExit.Ok
}

$gh = Get-Command 'gh' -ErrorAction SilentlyContinue
if (-not $gh) {
    Write-HandoffLog -Level WARN -Message 'gh (GitHub CLI) is not installed on this machine. Open the PR manually:'
    Write-HandoffLog -Message $prUrl
    Exit-Handoff $script:HandoffExit.Ok
}

$body = @"
## CGI-1 -> COM1 handoff

- batch: ``$batchId``
- source (CGI-1): ``$($meta.source_path)``
- transferred: ``$($meta.file_count)`` file(s)
- integrity: ``$($meta.integrity)`` (SHA256 manifest re-verified on COM1)

Transfer path: SMB over Tailscale (``100.124.21.64``), receive root ``C:\Users\Public\CGI-HANDOFF``.
"@

$prTitle = $CommitMessage
& $gh.Source pr create --repo $githubRepo --base $baseBranch --head $BranchName --title $prTitle --body $body
if ($LASTEXITCODE -ne 0) {
    Write-HandoffLog -Level ERROR -Message 'gh pr create failed. Open the PR manually:'
    Write-HandoffLog -Message $prUrl
    Exit-Handoff $script:HandoffExit.TransportFail
}
Write-HandoffLog -Level PASS -Message 'Pull request created.'
