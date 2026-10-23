@{
    # ---------------------------------------------------------------------------
    # CGI-1 -> COM1 handoff configuration (issue #7)
    #
    # ReceiveRoot is the ONLY location on COM1 that the sender is allowed to
    # write to. send_to_com1.ps1 refuses any target that is not listed in
    # AllowedReceiveRoots, so adding a new destination is an explicit, reviewable
    # edit to this file rather than a runtime decision.
    # ---------------------------------------------------------------------------

    SchemaVersion = '1.0'

    Com1 = @{
        TailscaleIp    = '100.124.21.64'
        TailscaleName  = 'padiem-command-center'
        # The COM1 SMB share that is reachable from CGI-1 with the operator's
        # existing Windows credentials (no separate secret, no new port).
        ShareRoot      = '\\100.124.21.64\Users\Public'
    }

    # Designated receive root on COM1. A batch sub-directory is created under it
    # for every transfer so that no two transfers can ever collide.
    ReceiveRoot = '\\100.124.21.64\Users\Public\CGI-HANDOFF'

    # Whitelist. A -ReceiveRoot override is accepted only when it matches one of
    # these entries exactly.
    AllowedReceiveRoots = @(
        '\\100.124.21.64\Users\Public\CGI-HANDOFF'
    )

    # Files/directories never transferred.
    ExcludeNames = @(
        '.git'
        '.venv'
        'node_modules'
        '__pycache__'
    )

    # Guard rails so that an accidental large copy cannot flood the COM1 share.
    MaxFileBytes  = 52428800   # 50 MiB
    MaxTotalBytes = 209715200  # 200 MiB

    # ---------------------------------------------------------------------------
    # COM1 side settings. `Com1RepoPath` is the local clone of the CGI project
    # repository on COM1; adjust it to the real path on that machine.
    # ---------------------------------------------------------------------------
    Com1RepoPath    = 'C:\cgi-work\kbs261022'
    GitHubRepo      = 'skerishKang/kbs261022'
    BaseBranch      = 'main'
    RemoteName      = 'origin'
}
