# CGI-1 -> COM1 handoff pipeline configuration.
# Returns a hashtable. Edit values here (no secrets are stored in this file).

$home_ = $env:USERPROFILE

@{
    # ---- COM1 (Tailscale node name: padiem-command-center) -------------------
    RemoteHost      = 'padiem-command-center'
    RemoteIp        = '100.124.21.64'
    RemotePort      = 2222
    RemoteUser      = 'sji'

    # Dedicated key pair for CGI-1 -> COM1 transfers (private key never leaves CGI-1).
    IdentityFile    = Join-Path $home_ '.ssh\cgi_handoff_ed25519'

    # Remote layout (created by bootstrap-com1.ps1)
    RemoteIncoming  = 'C:/cgi-handoff/incoming'   # transfer staging area ( ".part" packages )
    RemoteInbox     = 'C:/cgi-handoff/inbox'       # verified, immutable packages

    # ---- Source policy -------------------------------------------------------
    # Only directories under these roots may be transferred.
    AllowedSourceRoots = @(
        (Join-Path $home_ 'cgi-work\kbs261022'),
        (Join-Path $home_ 'cgi-work')
    )

    # Directories / files skipped while packaging.
    ExcludeDirNames  = @('.git', 'node_modules', '.venv', 'venv', '__pycache__',
                         '.pytest_cache', '.mypy_cache', 'dist', 'build', '.idea', '.vscode')
    ExcludeFileNames = @('desktop.ini', 'Thumbs.db')
    ExcludeExts      = @('.log', '.tmp', '.bak', '.old', '.swp')

    # Files whose names look secret-bearing are refused unless -AllowSensitive.
    SensitiveNamePatterns = @('^\.env', '(?i)id_rsa', '(?i)id_ed25519', '(?i)\.pem$', '(?i)\.pfx$',
                              '(?i)\.p12$', '(?i)credential', '(?i)secret', '(?i)\.password',
                              '(?i)token.*\.json$')

    # Files larger than this (MB) are skipped unless -IncludeLarge.
    MaxFileSizeMB = 50
}
