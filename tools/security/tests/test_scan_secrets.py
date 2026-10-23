import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools" / "security"))
import scan_secrets as ss

FAKE_VALUE = "".join(["fake", "-", "credential", "-", "9x7q"])
OPAQUE_LONG_VALUE = "".join(["tok", "-", "abcdefghijklmnop", "-", "0123456789"])
ENV_VAR_NAME = "NAVER_" + "PW"


def rules_for(text):
    return [rule for rule, _ in ss.scan_text(text)]


class ScanTextTests(unittest.TestCase):
    def test_env_fallback_credential_is_detected(self):
        line = f"const pw = process.env.{ENV_VAR_NAME} || '{FAKE_VALUE}';"
        self.assertEqual(rules_for(line), ["env-fallback-credential"])

    def test_python_env_fallback_credential_is_detected(self):
        line = f"pw = os.environ.get('{ENV_VAR_NAME}', '{FAKE_VALUE}')"
        self.assertEqual(rules_for(line), ["python-env-fallback-credential"])

    def test_hardcoded_assignment_is_detected(self):
        line = f"const {ENV_VAR_NAME} = '{FAKE_VALUE}';"
        self.assertEqual(rules_for(line), ["hardcoded-credential-assignment"])

    def test_credential_field_literal_fill_is_detected(self):
        selector = "#" + "id"
        line = f"await page.fill('{selector}', '{FAKE_VALUE}');"
        self.assertEqual(rules_for(line), ["credential-field-literal-fill"])

    def test_session_token_in_url_is_detected(self):
        line = f"https://loginca.ecount.com/ec5/view?ec_req_sid={OPAQUE_LONG_VALUE}"
        self.assertEqual(rules_for(line), ["session-token-in-url"])

    def test_bearer_token_is_detected(self):
        line = f"Authorization: Bearer {OPAQUE_LONG_VALUE}"
        self.assertEqual(rules_for(line), ["bearer-token"])

    def test_private_key_marker_is_detected(self):
        marker = "-" * 5 + "BEGIN RSA PRIVATE KEY" + "-" * 5
        self.assertEqual(rules_for(marker), ["private-key-marker"])

    def test_github_token_is_detected(self):
        sample = "gh" + "p_" + "A" * 36
        self.assertEqual(rules_for(sample), ["github-token"])

    def test_aws_access_key_is_detected(self):
        key = "AK" + "IA" + "ABCDEFGHIJKLMNOP"
        self.assertEqual(rules_for(key), ["aws-access-key"])

    def test_module_path_fallback_is_allowed(self):
        line = "const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');"
        self.assertEqual(rules_for(line), [])

    def test_credential_name_with_path_value_is_allowed(self):
        line = f"process.env.{ENV_VAR_NAME} || 'D:/config/naver.env'"
        self.assertEqual(rules_for(line), [])

    def test_empty_placeholder_is_allowed(self):
        self.assertEqual(rules_for(f"{ENV_VAR_NAME}="), [])

    def test_redaction_line_is_allowed(self):
        line = "url.replace(/ec_req_sid=[^&]*/gi, 'ec_req_sid=REDACTED')"
        self.assertEqual(rules_for(line), [])

    def test_selector_value_is_allowed(self):
        self.assertEqual(rules_for("PASSWORD = '#passwd'"), [])

    def test_scan_text_never_returns_values(self):
        line = f"const {ENV_VAR_NAME} = '{FAKE_VALUE}';"
        for rule, lineno in ss.scan_text(line):
            self.assertIsInstance(rule, str)
            self.assertIsInstance(lineno, int)
            self.assertNotIn(FAKE_VALUE, rule)


class TrackedFileScanTests(unittest.TestCase):
    def _run_scanner(self, content, filename="probe.js"):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / filename).write_text(content, encoding="utf-8")
        subprocess.run(["git", "-C", str(root), "init", "-q"], check=True)
        subprocess.run(["git", "-C", str(root), "add", filename], check=True)
        proc = subprocess.run(
            [sys.executable, str(REPO_ROOT / "tools" / "security" / "scan_secrets.py"),
             "--root", str(root)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        return proc, root

    def test_scanner_fails_without_leaking_value(self):
        content = f"const pw = process.env.{ENV_VAR_NAME} || '{FAKE_VALUE}';\n"
        proc, _ = self._run_scanner(content)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("env-fallback-credential", proc.stdout)
        self.assertIn("probe.js:1", proc.stdout)
        self.assertNotIn(FAKE_VALUE, proc.stdout)
        self.assertNotIn(FAKE_VALUE, proc.stderr)

    def test_scanner_passes_on_clean_file(self):
        content = "const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');\n"
        proc, _ = self._run_scanner(content)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("SECRET SCAN PASS", proc.stdout)

    def test_untracked_file_is_ignored(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / "clean.js").write_text("console.log('ok');\n", encoding="utf-8")
        (root / "local.env").write_text(f"{ENV_VAR_NAME}={FAKE_VALUE}\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(root), "init", "-q"], check=True)
        subprocess.run(["git", "-C", str(root), "add", "clean.js"], check=True)
        proc = subprocess.run(
            [sys.executable, str(REPO_ROOT / "tools" / "security" / "scan_secrets.py"),
             "--root", str(root)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        self.assertEqual(proc.returncode, 0, proc.stdout)


if __name__ == "__main__":
    unittest.main()
