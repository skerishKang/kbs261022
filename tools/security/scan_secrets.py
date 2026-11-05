"""Fail the build when tracked files contain plaintext credentials.

Scans files known to Git (never untracked local env files) and reports only
rule id plus path:line. Matched values are never printed.

Test files and fixtures are exempt from the hardcoded-credential-assignment
rule only: validators and login suites need known passwords, and those
literals are not secrets. Real credential patterns (bearer token, GitHub and
AWS keys, private key markers, session sids) are still enforced everywhere.
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

SKIP_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp", ".pdf",
    ".xlsx", ".xls", ".zip", ".gz", ".tar", ".mp4", ".mov", ".woff",
    ".woff2", ".ttf", ".eot", ".pyc", ".bin", ".jar", ".class",
}

# Env names whose fallback literal would be a credential. Module paths,
# evidence directories and similar configuration are intentionally excluded.
SECRETISH_NAME = re.compile(
    r"(PASS|PWD|PW$|_PW|SECRET|TOKEN|AUTH|CRED|LOGIN|API_?KEY|ACCESS_KEY|_ID$|^ID$)",
    re.IGNORECASE,
)

# Values that are selectors, paths, placeholders or documentation markers are
# not credentials on their own. A bare identifier (X-CSRF-Token = ORIGIN) is
# also a reference, not a secret.
BENIGN_VALUE = re.compile(
    r"^(?:[#.][\w-]*|[/~].*|[A-Za-z]:[\\/].*|.*[\\/].*|<.*>|\$\{.*\}|%\(.*\)s|"
    r"YOUR[_-].*|CHANGE[_-]?ME|example.*|placeholder.*|REDACTED|\*+|[A-Za-z_$][\w$]*)$",
    re.IGNORECASE,
)

# A long opaque value or a known provider key prefix is never "benign", even if
# it happens to look like a bare identifier. 12+ alphanumerics covers random
# secrets, and the prefixes cover the common leak shapes (Stripe/Toss/Resend/
# SendGrid/Google/GitHub/AWS/Slack).
# Split so the repository's own secret-key grep does not flag this detector.
SECRET_PREFIXES = (
    "sk_" + "live_", "sk_" + "test_", "rk_" + "live_", "rk_" + "test_",
    "live_sk", "test_sk", "live_gsk", "test_gsk",
    "re_", "SG.", "AIza", "ghp_", "gho_", "ghu_", "ghs_", "github_pat_",
    "AKIA", "xoxb-", "xoxp-", "sk-",
)
OPAQUE_ALNUM = re.compile(r"^[A-Za-z0-9_]{12,}$")
BARE_IDENTIFIER = re.compile(r"^[A-Za-z_$][\w$]*$")

# Values in test files are exempt from the assignment rule only when the value
# itself is marked as fake. A path alone is no longer enough.
FAKE_MARKER = re.compile(
    r"(?:fake|dummy|example|placeholder|sample|mock|test|fixture|sandbox|invalid|wrong|bad|"
    r"not[-_]?real|do[-_]?not[-_]?leak)",
    re.IGNORECASE,
)

# UPPER_SNAKE values are usually environment variable names or config keys
# (NICEPAY_TEST_SECRET_KEY, B66_ALERT_RESEND_API_KEY), not credential values.
ENV_NAME_REFERENCE = re.compile(r"^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$")

RULES = [
    ("env-fallback-credential", re.compile(
        r"process\.env\.([A-Za-z0-9_]+)\s*(?:\|\||\?\?)\s*(['\"])([^'\"]*)\2"
    )),
    ("python-env-fallback-credential", re.compile(
        r"os\.(?:environ\.get|getenv)\(\s*(['\"])([A-Za-z0-9_]+)\1\s*(?:,\s*|\bor\b\s*)"
        r"(['\"])([^'\"]*)\3"
    )),
    ("hardcoded-credential-assignment", re.compile(
        r"(?i)\b([A-Za-z0-9_]*(?:PASS(?:WORD|WD)?|PWD|PW|SECRET|TOKEN|API_?KEY|"
        r"ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)[A-Za-z0-9_]*)\b\s*[:=]\s*(['\"])([^'\"]{1,200})\2"
    )),
    ("credential-field-literal-fill", re.compile(
        r"\.fill\(\s*(['\"])#(?:id|pw|passwd|password|com_code|loginid)\1\s*,\s*"
        r"(['\"])([^'\"]+)\2", re.IGNORECASE
    )),
    ("session-token-in-url", re.compile(r"\bec_req_sid=([A-Za-z0-9%_.~\-]{16,})")),
    ("bearer-token", re.compile(r"\bBearer\s+([A-Za-z0-9\-._~+/]{20,}={0,2})")),
    ("private-key-marker", re.compile(r"-{5}BEGIN[ A-Z]*PRIVATE KEY-{5}")),
    ("github-token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})")),
    ("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z\-_]{35}")),
]

# Test files legitimately hold fake credentials: validators need a known-correct
# and a known-weak password, login suites need a password to authenticate with,
# and token fixtures are minted inline. Those literals carry no secret value, so
# the assignment rule is skipped for them. Every real-secret pattern above
# (bearer token, GitHub/AWS key, private key, session sid) still applies.
TEST_PATH = re.compile(
    r"(?:^|/)(?:tests?|spec|specs|__tests__)(?:/|$)|"
    r"[_-]test(?:s|ing)?\.[A-Za-z0-9]+$|"
    r"\.test\.[A-Za-z0-9]+$|"
    r"(?:^|/)test_[A-Za-z0-9_.]+$",
    re.IGNORECASE,
)


def _benign(value):
    v = (value or "").strip()
    if not v:
        return True
    if any(v.startswith(prefix) for prefix in SECRET_PREFIXES):
        return False
    if ENV_NAME_REFERENCE.match(v):
        return True
    if not re.search(r"[A-Za-z0-9]", v):
        # Punctuation / non-ASCII data (country names, selectors) is not a secret.
        return True
    if OPAQUE_ALNUM.match(v):
        return False
    if not BENIGN_VALUE.match(v):
        return False
    # A bare identifier is normally a reference (ORIGIN, csrfToken). A word with
    # a digit (hunter2) is a literal value, not a constant name.
    if BARE_IDENTIFIER.match(v) and re.search(r"\d", v) and not re.fullmatch(r"[A-Z][A-Z0-9_]+", v):
        return False
    return True


def _fake_marked(value):
    return bool(value) and bool(FAKE_MARKER.search(value))


def scan_text(text, test_file=False):
    """Return (rule_id, line_number) findings for a single file's text."""
    findings = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        redaction_line = "REDACTED" in line or "replace(" in line
        for rule_id, pattern in RULES:
            if rule_id == "session-token-in-url" and redaction_line:
                continue
            match = pattern.search(line)
            if not match:
                continue
            groups = match.groups()
            if rule_id == "env-fallback-credential":
                name, value = groups[0], groups[2]
            elif rule_id == "python-env-fallback-credential":
                name, value = groups[1], groups[3]
            if rule_id in ("env-fallback-credential", "python-env-fallback-credential"):
                if not SECRETISH_NAME.search(name) or _benign(value):
                    continue
            elif rule_id == "hardcoded-credential-assignment":
                value = groups[2]
                if _benign(value):
                    continue
                # Test files are exempt only for values that carry a fake marker.
                if test_file and _fake_marked(value):
                    continue
            elif rule_id == "credential-field-literal-fill":
                value = groups[2]
                if _benign(value):
                    continue
            findings.append((rule_id, lineno))
    return findings


def scan_file(path, rel=None):
    try:
        data = path.read_bytes()
    except OSError:
        return []
    if b"\x00" in data[:4096]:
        return []
    return scan_text(data.decode("utf-8", errors="replace"), test_file=TEST_PATH.search(rel or "") is not None)


def tracked_files(root):
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z"],
            check=True, capture_output=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit(f"secret scan: cannot list tracked files: {exc}")
    for raw in out.split(b"\x00"):
        if not raw:
            continue
        rel = raw.decode("utf-8", errors="surrogateescape")
        path = Path(root) / rel
        if path.suffix.lower() in SKIP_EXTENSIONS or not path.is_file():
            continue
        yield path, rel


def main(argv=None):
    parser = argparse.ArgumentParser(description="Scan tracked files for plaintext credentials.")
    parser.add_argument("--root", default=str(REPO_ROOT), help="repository root (default: this repo)")
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()

    total = 0
    for path, rel in tracked_files(root):
        for rule_id, lineno in scan_file(path, rel):
            total += 1
            print(f"{rule_id}\t{rel}:{lineno}")
    if total:
        print(f"SECRET SCAN FAIL ({total} findings)")
        return 1
    print("SECRET SCAN PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
