#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Validate the generated Ecount item upload files.

Checks the official 17-column template contract, value domains from the
template comments, and CSV/XLSX parity. Read-only: never calls the ERP.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from collections import Counter

try:
    import openpyxl
except ImportError as exc:  # pragma: no cover
    raise SystemExit("openpyxl is required") from exc

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEFAULT_CSV = os.path.join(REPO_ROOT, "data", "erp_prep", "ecount_item_upload.csv")
DEFAULT_XLSX = os.path.join(REPO_ROOT, "data", "erp_prep", "ecount_item_upload.xlsx")
SUMMARY_JSON = os.path.join(REPO_ROOT, "reports", "data", "erp", "summary.json")

ERP_UPLOAD_COLUMNS = [
    "품목코드",
    "품목명",
    "바코드",
    "규격구분",
    "규격",
    "단위",
    "품목구분",
    "세트여부",
    "재고수량관리",
    "입고단가",
    "입고단가 VAT포함여부",
    "출고단가",
    "출고단가 VAT포함여부",
    "부가세율(매출)",
    "부가세율(매입)",
    "검색창내용",
    "품목공유여부",
]

ALLOWED = {
    "규격구분": {"1", "2", "3", "4"},
    "품목구분": {"0", "1", "2", "3", "4", "7"},
    "세트여부": {"0", "1"},
    "재고수량관리": {"0", "1"},
    "입고단가 VAT포함여부": {"0", "1"},
    "출고단가 VAT포함여부": {"0", "1"},
    "품목공유여부": {"0", "1"},
}
MAX_LENGTH = {"품목코드": 20, "품목명": 100, "바코드": 30, "규격": 100, "단위": 20, "검색창내용": 100}
PRICE_RE = re.compile(r"^\d{1,12}(\.\d{1,6})?$")
TAX_RE = re.compile(r"^\d{1,3}(\.\d{1,3})?$")


def normalize_cell(value):
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def read_csv_rows(path):
    with open(path, encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        header = reader.fieldnames or []
        return header, [dict(row) for row in reader]


def read_xlsx_rows(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return [], []
    header = [normalize_cell(cell) for cell in rows[0]]
    body = []
    for row in rows[1:]:
        if all(cell is None or cell == "" for cell in row):
            continue
        body.append({header[i]: normalize_cell(row[i]) if i < len(row) else "" for i in range(len(header))})
    return header, body


def validate_rows(rows, expected_total=None, header=None):
    errors = []
    warnings = []
    if header is not None and header != ERP_UPLOAD_COLUMNS:
        errors.append("header does not match the official 17-column template")
    if expected_total is not None and len(rows) != expected_total:
        errors.append(f"row count {len(rows)} != {expected_total}")
    codes = [row.get("품목코드", "") for row in rows]
    duplicates = {code: count for code, count in Counter(codes).items() if count > 1}
    if duplicates:
        errors.append(f"duplicate item codes: {len(duplicates)}")
    if any(len(code) > 20 for code in codes):
        errors.append("item code exceeds 20 characters")
    if any(not code for code in codes):
        errors.append("empty item code")
    for index, row in enumerate(rows, start=2):
        for column, limit in MAX_LENGTH.items():
            value = row.get(column, "")
            if len(value) > limit:
                errors.append(f"row {index}: {column} exceeds {limit} chars")
        if not row.get("품목명"):
            errors.append(f"row {index}: empty 품목명")
        for column, allowed in ALLOWED.items():
            value = row.get(column, "")
            if value not in allowed:
                errors.append(f"row {index}: {column}={value!r} not in {sorted(allowed)}")
        if row.get("품목구분") not in {"1", "3"} and row.get("세트여부") == "1":
            errors.append(f"row {index}: 세트여부=1 requires 품목구분 1 or 3")
        for column in ("입고단가", "출고단가"):
            value = row.get(column, "")
            if value and not PRICE_RE.match(value):
                errors.append(f"row {index}: {column}={value!r} is not a valid 12.6 price")
        for column in ("부가세율(매출)", "부가세율(매입)"):
            value = row.get(column, "")
            if value and (not TAX_RE.match(value) or float(value) > 100):
                errors.append(f"row {index}: {column}={value!r} is not a valid 3.3 tax rate")
        if len(errors) >= 50:
            errors.append("too many errors; stopped early")
            break
    if rows:
        price_rows = sum(1 for row in rows if row.get("출고단가"))
        managed = sum(1 for row in rows if row.get("재고수량관리") == "1")
        if price_rows == 0:
            warnings.append("no 출고단가 values")
        if managed == 0:
            warnings.append("no stock-managed items")
    return errors, warnings


def compare_csv_xlsx(csv_rows, xlsx_rows):
    errors = []
    if len(csv_rows) != len(xlsx_rows):
        return [f"CSV rows {len(csv_rows)} != XLSX rows {len(xlsx_rows)}"]
    for index, (csv_row, xlsx_row) in enumerate(zip(csv_rows, xlsx_rows), start=2):
        for column in ERP_UPLOAD_COLUMNS:
            if normalize_cell(csv_row.get(column)) != normalize_cell(xlsx_row.get(column)):
                errors.append(f"row {index}: CSV/XLSX mismatch in {column}")
                break
        if len(errors) >= 10:
            errors.append("too many CSV/XLSX mismatches")
            break
    return errors


def expected_total_from_summary():
    if not os.path.exists(SUMMARY_JSON):
        return None
    with open(SUMMARY_JSON, encoding="utf-8") as handle:
        return json.load(handle).get("total_items")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", default=DEFAULT_CSV)
    parser.add_argument("--xlsx", default=DEFAULT_XLSX)
    parser.add_argument("--expected-total", type=int)
    args = parser.parse_args()

    if not os.path.exists(args.csv):
        print("FAIL: upload csv not found:", args.csv)
        return 1
    if not os.path.exists(args.xlsx):
        print("FAIL: upload xlsx not found:", args.xlsx)
        return 1
    expected = args.expected_total if args.expected_total is not None else expected_total_from_summary()
    csv_header, csv_rows = read_csv_rows(args.csv)
    xlsx_header, xlsx_rows = read_xlsx_rows(args.xlsx)
    errors, warnings = validate_rows(csv_rows, expected, csv_header)
    errors.extend(compare_csv_xlsx(csv_rows, xlsx_rows))
    if xlsx_header != ERP_UPLOAD_COLUMNS:
        errors.append("XLSX header does not match the official 17-column template")

    if errors:
        print("VALIDATION FAILED")
        for error in errors:
            print("  ERROR:", error)
        for warning in warnings:
            print("  WARN:", warning)
        return 1
    print("VALIDATION PASSED")
    print(f"  rows: {len(csv_rows)}")
    print(f"  unique codes: {len(set(row['품목코드'] for row in csv_rows))}")
    print(f"  price available: {sum(1 for row in csv_rows if row.get('출고단가'))}")
    print(f"  stock managed: {sum(1 for row in csv_rows if row.get('재고수량관리') == '1')}")
    for warning in warnings:
        print("  WARN:", warning)
    return 0


if __name__ == "__main__":
    sys.exit(main())
