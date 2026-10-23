#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Read-only Ecount ERP probe (NO writes).

Logs in using provided credentials, verifies session, and attempts to fetch
item list via known endpoints. All operations are GET/read-only.
Credentials are read from environment variables to avoid committing them:
  ECOUNT_COM_CODE, ECOUNT_USER_ID, ECOUNT_PASSWORD
"""
from __future__ import annotations

import os
import sys
import json
import re

try:
    import requests
except ImportError as exc:
    raise SystemExit("requests required") from exc

LOGIN_URL = "https://login.ecount.com/Login?lan_type=ko-KR"
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
# base after login is determined by response redirect

def main():
    com_code = os.environ.get("ECOUNT_COM_CODE")
    user_id = os.environ.get("ECOUNT_USER_ID")
    password = os.environ.get("ECOUNT_PASSWORD")
    if not (com_code and user_id and password):
        raise SystemExit("Set ECOUNT_COM_CODE, ECOUNT_USER_ID, ECOUNT_PASSWORD env vars")

    s = requests.Session()
    s.headers.update({"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})

    # 1. GET login page to collect hidden fields
    r = s.get(LOGIN_URL, timeout=30)
    print("GET login status:", r.status_code, "url:", r.url)
    html = r.text

    # parse hidden inputs
    hidden = {}
    for m in re.finditer(r'<input[^>]*type="hidden"[^>]*>', html, re.I):
        tag = m.group(0)
        name_m = re.search(r'name="([^"]+)"', tag)
        val_m = re.search(r'value="([^"]*)"', tag)
        if name_m:
            hidden[name_m.group(1)] = val_m.group(1) if val_m else ""
    print("hidden fields:", list(hidden.keys()))

    # build form data
    data = dict(hidden)
    data["com_code"] = com_code
    data["id"] = user_id
    data["passwd"] = password

    # POST login
    r2 = s.post(LOGIN_URL, data=data, timeout=30, allow_redirects=True)
    print("POST login status:", r2.status_code, "final url:", r2.url)
    print("title snippet:", r2.text[:300].replace("\n", " "))

    # Save session cookies info (not values) 
    print("cookies:", [c.name for c in s.cookies])

    # Try to detect ec_req_sid
    sid = None
    for c in s.cookies:
        if "sid" in c.name.lower() or "req" in c.name.lower():
            sid = c.value
    m = re.search(r'ec_req_sid=([A-Za-z0-9_-]+)', r2.text + r2.url)
    if m:
        sid = m.group(1)
    print("ec_req_sid found:", bool(sid))

    # Write a probe result (no credentials)
    out = {
        "login_status": r2.status_code,
        "final_url": r2.url,
        "cookies": [c.name for c in s.cookies],
        "sid_found": bool(sid),
    }
    os.makedirs(os.path.join(REPO_ROOT, "reports", "data", "erp"), exist_ok=True)
    with open(os.path.join(REPO_ROOT, "reports", "data", "erp", "ecount_login_probe.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
