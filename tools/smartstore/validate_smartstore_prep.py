#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Validate the generated Smart Store registration prep files.

Checks:
  - file exists and readable
  - header matches PREP_COLUMNS
  - row count == 4575
  - no duplicate 공급처원본ID
  - required columns non-null where expected (상품명, 대표이미지URL)
  - image URL validity
  - missing-field counts consistent
  - duplicate id report consistency
"""
from __future__ import annotations

import csv
import json
import os
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PREP_CSV = os.path.join(REPO_ROOT, "data", "smartstore_prep", "smartstore_registration_prep.csv")
DUP_JSON = os.path.join(REPO_ROOT, "reports", "data", "smartstore", "duplicate_ids_report.json")
MISSING_JSON = os.path.join(REPO_ROOT, "reports", "data", "smartstore", "missing_fields_report.json")

PREP_COLUMNS = [
    "공급처원본ID", "네이버상품ID", "상품명", "브랜드", "제조사", "모델명",
    "카테고리경로_CGI", "스마트스토어카테고리번호", "판매가", "가격확인필요",
    "재고수량", "대표이미지URL", "상세이미지수", "상세설명", "옵션수",
    "옵션SKU요약", "원산지코드", "수입사", "ASTemplateCode", "배송비",
    "반품교환정책", "KC고시정보", "판매자코드", "출처URL", "등록상태",
    "등록가능여부_DB", "사유_DB", "누락필수값", "준비도",
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

    if header != PREP_COLUMNS:
        errors.append(f"header mismatch: got {header}")

    if len(rows) != 4575:
        errors.append(f"row count {len(rows)} != 4575")

    # duplicate id check
    ids = [r["공급처원본ID"] for r in rows]
    if len(ids) != len(set(ids)):
        dup = len(ids) - len(set(ids))
        errors.append(f"duplicate source ids: {dup}")

    # required non-null
    for r in rows:
        if not r.get("상품명"):
            errors.append(f"missing name: {r.get('공급처원본ID')}")
            break
        if not (r.get("대표이미지URL") or "").startswith("http"):
            errors.append(f"bad image: {r.get('공급처원본ID')}")
            break

    # consistency with missing report
    if os.path.exists(MISSING_JSON):
        with open(MISSING_JSON, encoding="utf-8") as f:
            mr = json.load(f)
        if mr.get("total_products") != len(rows):
            errors.append("missing report total mismatch")

    # consistency with dup report
    if os.path.exists(DUP_JSON):
        with open(DUP_JSON, encoding="utf-8") as f:
            dr = json.load(f)
        if dr.get("duplicate_key_count", -1) != 0:
            warnings.append(f"duplicate keys present: {dr.get('duplicate_key_count')}")

    # image mapping file
    img_path = os.path.join(REPO_ROOT, "reports", "data", "smartstore", "image_url_mapping.csv")
    if os.path.exists(img_path):
        with open(img_path, encoding="utf-8-sig", newline="") as f:
            img_rows = list(csv.DictReader(f))
        if len(img_rows) != len(rows):
            errors.append("image mapping row count mismatch")

    if errors:
        print("VALIDATION FAILED")
        for e in errors:
            print("  ERROR:", e)
        for w in warnings:
            print("  WARN:", w)
        return 1
    print("VALIDATION PASSED")
    print(f"  rows: {len(rows)}")
    print(f"  unique ids: {len(set(ids))}")
    print(f"  images ok: {sum(1 for r in rows if (r.get('대표이미지URL') or '').startswith('http'))}")
    for w in warnings:
        print("  WARN:", w)
    return 0


if __name__ == "__main__":
    sys.exit(main())
