#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build Ecount ERP item-master bulk-registration prep files from product_db.xlsx.

Reuses existing mapping report reports/erp-item-master-mapping.csv and
reports/ecount-item-bulk-registration.md (17-column upload template).

Inputs:
  data/full_catalog/product_db.xlsx  ('통합상품' sheet)
Outputs:
  data/erp_prep/ecount_item_bulk_prep.csv   (UTF-8 BOM)
  data/erp_prep/ecount_item_bulk_prep.xlsx
  reports/data/erp/missing_erp_fields_report.json
  reports/data/erp/duplicate_item_codes_report.json
  reports/data/erp/summary.json
"""
from __future__ import annotations

import csv
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

try:
    import openpyxl
except ImportError as exc:  # pragma: no cover
    raise SystemExit("openpyxl is required") from exc

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DB_PATH = os.path.join(REPO_ROOT, "data", "full_catalog", "product_db.xlsx")
OUT_DIR = os.path.join(REPO_ROOT, "data", "erp_prep")
REP_DIR = os.path.join(REPO_ROOT, "reports", "data", "erp")

ERP_COLUMNS = [
    "품목코드",          # prod_cd (<=20 chars)
    "품목명",            # prod_des
    "규격",              # size_des_base
    "재고수량관리",       # bal_flag (1=manage)
    "안전재고",          # safe_qty
    "품목그룹",          # class_cd
    "출고단가",          # out_price
    "입고단가",          # in_price
    "부가세율",          # tax (blank = unverified)
    "적요",              # remarks
    "검색창내용",        # remarks_win
    "브랜드_cont2",      # cont2
    "모델_cont3",        # cont3
    "제조사_cont4",      # cont4
    "원산지_cont5",      # cont5
    "이미지URL",         # prod_image
    "쇼핑몰품목key",     # om_prod_cd
    "공급처원본ID",      # traceability
    "출처",              # canonical_url
]

# mapping of CGI source site code -> short prefix for item code
SITE_PREFIX = {"samasound": "SS", "samamusic": "SM"}


def load_master():
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(DB_PATH)
    wb = openpyxl.load_workbook(DB_PATH, read_only=True, data_only=True)
    if "통합상품" not in wb.sheetnames:
        raise ValueError("missing sheet 통합상품")
    rows = list(wb["통합상품"].iter_rows(values_only=True))
    return rows


def index_header(rows):
    return {name: i for i, name in enumerate(rows[0])}


def make_item_code(source_site, source_id):
    # <=20 chars, unique
    prefix = SITE_PREFIX.get(str(source_site).lower(), "CG")
    sid = str(source_id)
    code = f"{prefix}-{sid}"
    if len(code) > 20:
        code = code[:20]
    return code


def sanitize_name(name):
    if name is None:
        return ""
    s = str(name).strip()
    # Ecount item name: remove control chars
    return s.replace("\n", " ").replace("\r", " ")


def build_records(master_rows):
    hdr = index_header(master_rows)
    records = []
    for m in master_rows[1:]:
        if not m:
            continue
        key = m[hdr["통합키"]]
        if key is None:
            continue
        source_site = m[hdr["공급처코드"]]
        source_id = m[hdr["공급처원본ID"]]
        pid = str(key)
        name = sanitize_name(m[hdr["상품명"]])
        brand = m[hdr["브랜드"]]
        manufacturer = m[hdr["제조사"]]
        model = m[hdr["모델명"]]
        cat_path = m[hdr["카테고리경로"]]
        published_price = m[hdr["공개판매가"]]
        image = m[hdr["대표이미지"]]
        specs = m[hdr["규격행수"]]
        summary = m[hdr["출처URL"]]
        canonical = m[hdr["출처URL"]]

        item_code = make_item_code(source_site, source_id)

        # remarks from spec count
        remarks = ""
        if specs:
            remarks = f"규격행 {specs}"

        # option summary not in master; placeholder
        records.append({
            "품목코드": item_code,
            "품목명": name,
            "규격": model if model else "",
            "재고수량관리": 1,
            "안전재고": None,
            "품목그룹": None,
            "출고단가": published_price,
            "입고단가": None,
            "부가세율": None,
            "적요": remarks,
            "검색창내용": (brand or "") if not name else name[:100],
            "브랜드_cont2": brand,
            "모델_cont3": model,
            "제조사_cont4": manufacturer,
            "원산지_cont5": None,
            "이미지URL": image,
            "쇼핑몰품목key": pid,
            "공급처원본ID": pid,
            "출처": canonical,
        })
    return records


def write_csv(records, path):
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=ERP_COLUMNS)
        w.writeheader()
        for r in records:
            w.writerow(r)


def write_xlsx(records, path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "이카운트품목벌크"
    ws.append(ERP_COLUMNS)
    for r in records:
        ws.append([r[c] for c in ERP_COLUMNS])
    from openpyxl.styles import Font, PatternFill
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.fill = PatternFill("solid", fgColor="DDEBF7")
    ws.freeze_panes = "B2"
    wb.save(path)


def duplicate_report(records):
    seen = defaultdict(list)
    for i, r in enumerate(records, start=2):
        seen[r["품목코드"]].append(i)
    dups = {k: v for k, v in seen.items() if len(v) > 1}
    # also check length >20
    too_long = [r["품목코드"] for r in records if len(str(r["품목코드"])) > 20]
    return {
        "total_items": len(records),
        "unique_codes": len(seen),
        "duplicate_code_count": len(dups),
        "duplicate_rows_extra": sum(len(v) - 1 for v in dups.values()),
        "too_long_codes": len(too_long),
        "samples": {k: v for k, v in list(dups.items())[:20]},
    }


def missing_report(records):
    counter = Counter()
    for r in records:
        if not r["품목코드"]:
            counter["품목코드"] += 1
        if not r["품목명"]:
            counter["품목명"] += 1
        if r["출고단가"] is None:
            counter["출고단가"] += 1
        if r["규격"] in (None, ""):
            counter["규격"] += 1
        if r["브랜드_cont2"] in (None, ""):
            counter["브랜드_cont2"] += 1
        if r["제조사_cont4"] in (None, ""):
            counter["제조사_cont4"] += 1
    return {
        "total_items": len(records),
        "missing_field_counts": dict(sorted(counter.items())),
        "price_available_count": sum(1 for r in records if r["출고단가"] is not None),
        "price_missing_count": sum(1 for r in records if r["출고단가"] is None),
        "image_ok_count": sum(1 for r in records if r["이미지URL"] and str(r["이미지URL"]).startswith("http")),
        "model_present_count": sum(1 for r in records if r["규격"]),
        "brand_present_count": sum(1 for r in records if r["브랜드_cont2"]),
        "manufacturer_present_count": sum(1 for r in records if r["제조사_cont4"]),
    }


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(REP_DIR, exist_ok=True)
    master_rows = load_master()
    records = build_records(master_rows)

    csv_path = os.path.join(OUT_DIR, "ecount_item_bulk_prep.csv")
    xlsx_path = os.path.join(OUT_DIR, "ecount_item_bulk_prep.xlsx")
    missing_path = os.path.join(REP_DIR, "missing_erp_fields_report.json")
    dup_path = os.path.join(REP_DIR, "duplicate_item_codes_report.json")
    summary_path = os.path.join(REP_DIR, "summary.json")

    write_csv(records, csv_path)
    write_xlsx(records, xlsx_path)

    mr = missing_report(records)
    with open(missing_path, "w", encoding="utf-8") as f:
        json.dump(mr, f, ensure_ascii=False, indent=2)

    dr = duplicate_report(records)
    with open(dup_path, "w", encoding="utf-8") as f:
        json.dump(dr, f, ensure_ascii=False, indent=2)

    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_db": "data/full_catalog/product_db.xlsx",
        "total_items": len(records),
        "unique_item_codes": dr["unique_codes"],
        "duplicate_codes": dr["duplicate_code_count"],
        "price_available_count": mr["price_available_count"],
        "price_missing_count": mr["price_missing_count"],
        "model_present_count": mr["model_present_count"],
        "brand_present_count": mr["brand_present_count"],
        "manufacturer_present_count": mr["manufacturer_present_count"],
        "image_ok_count": mr["image_ok_count"],
        "live_erp_write_performed": False,
        "erp_account_access_verified": False,
        "outputs": {
            "csv": "data/erp_prep/ecount_item_bulk_prep.csv",
            "xlsx": "data/erp_prep/ecount_item_bulk_prep.xlsx",
            "missing_erp_fields_report": "reports/data/erp/missing_erp_fields_report.json",
            "duplicate_item_codes_report": "reports/data/erp/duplicate_item_codes_report.json",
        },
    }
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
