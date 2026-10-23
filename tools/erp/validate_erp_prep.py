#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Validate Ecount ERP prep file."""
from __future__ import annotations

import csv
import json
import os
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PREP_CSV = os.path.join(REPO_ROOT, "data", "erp_prep", "ecount_item_bulk_prep.csv")
DUP_JSON = os.path.join(REPO_ROOT, "reports", "data", "erp", "duplicate_item_codes_report.json")
MISSING_JSON = os.path.join(REPO_ROOT, "reports", "data", "erp", "missing_erp_fields_report.json")

ERP_COLUMNS = [
    "품목코드", "품목명", "규격", "재고수량관리", "안전재고", "품목그룹",
    "출고단가", "입고단가", "부가세율", "적요", "검색창내용", "브랜드_cont2",
    "모델_cont3", "제조사_cont4", "원산지_cont5", "이미지URL", "쇼핑몰품목key",
    "공급처원본ID", "출처",
]


def main():
    errors = []
    warnings = []
    if not os.path.exists(PREP_CSV):
        print("FAIL: prep csv not found:", PREP_CSV)
        return 1
    with open(PREP_CSV, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        header = reader.fieldnames or []
        rows = list(reader)
    if header != ERP_COLUMNS:
        errors.append(f"header mismatch")
    if len(rows) != 4575:
        errors.append(f"row count {len(rows)} != 4575")
    codes = [r["품목코드"] for r in rows]
    if len(codes) != len(set(codes)):
        errors.append(f"duplicate item codes: {len(codes)-len(set(codes))}")
    if any(len(str(c)) > 20 for c in codes):
        errors.append("item code too long (>20)")
    for r in rows:
        if not r.get("품목명"):
            errors.append(f"missing name: {r.get('품목코드')}")
            break
        if not r.get("품목코드"):
            errors.append("missing item code")
            break
    if os.path.exists(MISSING_JSON):
        with open(MISSING_JSON, encoding="utf-8") as f:
            mr = json.load(f)
        if mr.get("total_items") != len(rows):
            errors.append("missing report total mismatch")
    if os.path.exists(DUP_JSON):
        with open(DUP_JSON, encoding="utf-8") as f:
            dr = json.load(f)
        if dr.get("duplicate_code_count", -1) != 0:
            warnings.append(f"duplicate codes: {dr.get('duplicate_code_count')}")
        if dr.get("too_long_codes", 0) != 0:
            errors.append(f"too long codes: {dr.get('too_long_codes')}")

    if errors:
        print("VALIDATION FAILED")
        for e in errors:
            print("  ERROR:", e)
        for w in warnings:
            print("  WARN:", w)
        return 1
    print("VALIDATION PASSED")
    print(f"  rows: {len(rows)}")
    print(f"  unique codes: {len(set(codes))}")
    print(f"  price available: {sum(1 for r in rows if r.get('출고단가'))}")
    for w in warnings:
        print("  WARN:", w)
    return 0


if __name__ == "__main__":
    sys.exit(main())
