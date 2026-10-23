#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Registration result/failure/retry log helper (JSONL).

Usage:
  python tools/erp/registration_log.py --add --system smartstore --id "samamusic:1" --status failed --reason "missing category"
  python tools/erp/registration_log.py --summary
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LOG_PATH = os.path.join(REPO_ROOT, "reports", "data", "registration_log.jsonl")


def add_entry(system, item_id, status, reason="", attempt=1, extra=None):
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "system": system,
        "item_id": item_id,
        "status": status,
        "reason": reason,
        "attempt": attempt,
    }
    if extra:
        entry.update(extra)
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry


def summary():
    if not os.path.exists(LOG_PATH):
        return {"total": 0}
    entries = []
    with open(LOG_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                entries.append(json.loads(line))
    by_system = {}
    by_status = {}
    for e in entries:
        by_system[e.get("system", "?")] = by_system.get(e.get("system", "?"), 0) + 1
        by_status[e.get("status", "?")] = by_status.get(e.get("status", "?"), 0) + 1
    return {"total": len(entries), "by_system": by_system, "by_status": by_status}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--add", action="store_true")
    parser.add_argument("--system", default="unknown")
    parser.add_argument("--id", default="")
    parser.add_argument("--status", default="unknown")
    parser.add_argument("--reason", default="")
    parser.add_argument("--attempt", type=int, default=1)
    parser.add_argument("--summary", action="store_true")
    args = parser.parse_args()

    if args.summary:
        print(json.dumps(summary(), ensure_ascii=False, indent=2))
        return
    if args.add:
        e = add_entry(args.system, args.id, args.status, args.reason, args.attempt)
        print(json.dumps(e, ensure_ascii=False))
        return
    print("use --add or --summary")


if __name__ == "__main__":
    main()
