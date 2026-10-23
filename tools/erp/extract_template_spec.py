#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Extract upload column rules from an Ecount blank template.

Usage:
  python tools/erp/extract_template_spec.py <Template.xlsx> \
      --out reports/data/erp/ecount_template_spec.json

Only header text and cell comments are stored. Data rows are ignored.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime, timezone

try:
    import openpyxl
except ImportError as exc:  # pragma: no cover
    raise SystemExit("openpyxl is required") from exc

OPTION_RE = re.compile(r"([^/()\[\]\n]+?)\s*[\(\[]\s*(\d+)\s*[\)\]]")
MAX_RE = re.compile(r"최대\s*(\d+)\s*자")
DECIMAL_RE = re.compile(r"최대\s*(\d+)\s*자\s*[\(\[]\s*소수")


def parse_comment(text):
    text = (text or "").replace("\r\n", "\n").strip()
    lengths = [int(value) for value in MAX_RE.findall(text)]
    decimals = [int(value) for value in DECIMAL_RE.findall(text)]
    allowed = {}
    limit_section = text.split("입력글자제한", 1)[-1]
    for line in limit_section.split("\n"):
        line = line.strip().lstrip("-").strip()
        if "/" not in line or "최대" in line:
            continue
        for label, code in OPTION_RE.findall(line):
            label = label.strip()
            if label and code not in allowed.values():
                allowed[label] = code
    return {
        "max_length": lengths[0] if lengths else None,
        "decimal_places": decimals[0] if decimals else None,
        "allowed": allowed,
        "comment": text,
    }


def extract(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.active
    columns = []
    for cell in ws[1]:
        if cell.value is None:
            continue
        parsed = parse_comment(cell.comment.text if cell.comment else "")
        columns.append({
            "column": cell.column_letter,
            "index": cell.column,
            "header": str(cell.value).strip(),
            **parsed,
        })
    return {
        "source": "이카운트 품목등록 > 웹자료올리기 > 엑셀서식내려받기 (빈 서식)",
        "extracted_at": datetime.now(timezone.utc).isoformat(),
        "sheet": ws.title,
        "columns": columns,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("template")
    parser.add_argument("--out", default="reports/data/erp/ecount_template_spec.json")
    args = parser.parse_args()
    if not os.path.exists(args.template):
        raise SystemExit(f"template not found: {args.template}")
    spec = extract(args.template)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(spec, handle, ensure_ascii=False, indent=2)
    print(json.dumps({"sheet": spec["sheet"], "columns": [c["header"] for c in spec["columns"]]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
