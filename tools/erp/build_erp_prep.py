#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build Ecount ERP upload files from the CGI product master.

Output columns match the official template downloaded from
품목등록 > 웹자료올리기 > 엑셀서식내려받기 (2026-10-23), sheet 품목등록.

Inputs:
  data/full_catalog/product_db.xlsx
    - 통합상품          (canonical product fields)
    - 이카운트품목매핑   (Cafe24 original codes; non-unique)
Outputs:
  data/erp_prep/ecount_item_upload.csv    (UTF-8 BOM, 17 columns)
  data/erp_prep/ecount_item_upload.xlsx   (sheet 품목등록, 17 columns)
  data/erp_prep/erp_extended_mapping.csv  (internal enrichment, not uploadable)
  reports/data/erp/summary.json
  reports/data/erp/missing_erp_fields_report.json
  reports/data/erp/duplicate_item_codes_report.json

No ERP API calls and no writes are performed by this tool.
"""
from __future__ import annotations

import csv
import json
import os
from collections import Counter
from datetime import datetime, timezone

try:
    import openpyxl
except ImportError as exc:  # pragma: no cover
    raise SystemExit("openpyxl is required") from exc

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DB_PATH = os.path.join(REPO_ROOT, "data", "full_catalog", "product_db.xlsx")
OUT_DIR = os.path.join(REPO_ROOT, "data", "erp_prep")
REP_DIR = os.path.join(REPO_ROOT, "reports", "data", "erp")

# Exact headers from the official blank template. The space in
# "입고단가 VAT포함여부" is part of the header.
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

EXTENDED_COLUMNS = [
    "품목코드",
    "상품명",
    "브랜드_cont2",
    "모델_cont3",
    "제조사_cont4",
    "원산지_cont5",
    "공급사_cont6",
    "카페24상품코드",
    "카페24품목코드",
    "카테고리경로",
    "공개판매가",
    "대표이미지",
    "출처URL",
    "공급처원본ID",
]

SITE_PREFIX = {"samasound": "SS", "samamusic": "SM"}
SITE_STOCK_MANAGED = {"samasound": "0", "samamusic": "1"}
SITE_SUPPLIER_LABEL = {"samasound": "삼아사운드", "samamusic": "삼아스토어"}

UNIT_DEFAULT = "EA"
PRODUCT_TYPE_GOODS = "3"
VAT_RATE_STANDARD = "10"


def clean_text(value, limit=None):
    if value is None:
        return ""
    text = " ".join(str(value).replace("\r", " ").replace("\n", " ").split())
    if limit is not None:
        text = text[:limit]
    return text


def numeric_price(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value) if float(value).is_integer() else round(float(value), 6)
    text = str(value).strip().replace(",", "")
    if not text or not text.replace(".", "", 1).isdigit():
        return None
    number = float(text)
    return int(number) if number.is_integer() else round(number, 6)


def make_item_code(source_site, source_id):
    prefix = SITE_PREFIX.get(str(source_site).lower(), "CG")
    return f"{prefix}-{source_id}"


def load_source():
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(DB_PATH)
    wb = openpyxl.load_workbook(DB_PATH, read_only=True, data_only=True)
    for sheet in ("통합상품", "이카운트품목매핑"):
        if sheet not in wb.sheetnames:
            raise ValueError(f"missing sheet {sheet}")
    master_rows = list(wb["통합상품"].iter_rows(values_only=True))
    mapping_rows = list(wb["이카운트품목매핑"].iter_rows(values_only=True))
    mapping_header = mapping_rows[0]
    midx = {name: i for i, name in enumerate(mapping_header)}
    mapping = {}
    for row in mapping_rows[1:]:
        if not row or row[midx["공급처원본ID"]] is None:
            continue
        mapping[str(row[midx["공급처원본ID"]])] = {
            "product_code": clean_text(row[midx["원본상품코드"]]),
            "item_code": clean_text(row[midx["원본품목코드"]]),
        }
    return master_rows, mapping


def build_records(master_rows, mapping):
    idx = {name: i for i, name in enumerate(master_rows[0])}
    barcode_counts = Counter(
        item["item_code"] for item in mapping.values() if item["item_code"]
    )
    records = []
    stats = {
        "name_truncated": 0,
        "spec_truncated": 0,
        "search_truncated": 0,
        "barcode_duplicate_skipped": 0,
        "unknown_site": 0,
    }
    for row in master_rows[1:]:
        if not row or row[idx["통합키"]] is None:
            continue
        key = str(row[idx["통합키"]])
        source_site = str(row[idx["공급처코드"]] or "").strip().lower()
        source_id = str(row[idx["공급처원본ID"]]).strip()
        raw_name = clean_text(row[idx["상품명"]])
        name = raw_name[:100]
        if len(raw_name) > 100:
            stats["name_truncated"] += 1
        raw_model = clean_text(row[idx["모델명"]])
        model = raw_model[:100]
        if len(raw_model) > 100:
            stats["spec_truncated"] += 1
        brand = clean_text(row[idx["브랜드"]])
        manufacturer = clean_text(row[idx["제조사"]])
        source_codes = mapping.get(key, {})
        barcode = ""
        cafe24_item = source_codes.get("item_code", "")
        if cafe24_item and barcode_counts.get(cafe24_item, 0) == 1:
            barcode = cafe24_item[:30]
        elif cafe24_item:
            stats["barcode_duplicate_skipped"] += 1
        terms = []
        for part in (brand, model, name):
            if part and part not in terms:
                terms.append(part)
        search_text = " ".join(terms)
        if len(search_text) > 100:
            search_text = search_text[:100]
            stats["search_truncated"] += 1
        if source_site not in SITE_PREFIX:
            stats["unknown_site"] += 1
        price = numeric_price(row[idx["공개판매가"]])
        records.append({
            "품목코드": make_item_code(source_site, source_id),
            "품목명": name,
            "바코드": barcode,
            "규격구분": "1",
            "규격": model,
            "단위": UNIT_DEFAULT,
            "품목구분": PRODUCT_TYPE_GOODS,
            "세트여부": "0",
            "재고수량관리": SITE_STOCK_MANAGED.get(source_site, "1"),
            "입고단가": "",
            "입고단가 VAT포함여부": "0",
            "출고단가": price if price is not None else "",
            "출고단가 VAT포함여부": "1",
            "부가세율(매출)": VAT_RATE_STANDARD,
            "부가세율(매입)": VAT_RATE_STANDARD,
            "검색창내용": search_text,
            "품목공유여부": "0",
            "_key": key,
            "_site": source_site,
            "_brand": brand,
            "_model": model,
            "_manufacturer": manufacturer,
            "_category": clean_text(row[idx["카테고리경로"]]),
            "_image": clean_text(row[idx["대표이미지"]]),
            "_source_url": clean_text(row[idx["출처URL"]]),
            "_cafe24_product_code": source_codes.get("product_code", ""),
            "_cafe24_item_code": cafe24_item,
        })
    codes = [record["품목코드"] for record in records]
    duplicates = [code for code, count in Counter(codes).items() if count > 1]
    if duplicates:
        raise ValueError(f"duplicate item codes after conversion: {duplicates[:5]}")
    too_long = [code for code in codes if len(code) > 20]
    if too_long:
        raise ValueError(f"item codes over 20 chars: {too_long[:5]}")
    return records, stats


def write_upload_csv(records, path):
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=ERP_UPLOAD_COLUMNS)
        writer.writeheader()
        for record in records:
            writer.writerow({column: record[column] for column in ERP_UPLOAD_COLUMNS})


def write_upload_xlsx(records, path):
    from openpyxl.styles import Font, PatternFill

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "품목등록"
    ws.append(ERP_UPLOAD_COLUMNS)
    for record in records:
        ws.append([record[column] if record[column] != "" else None for column in ERP_UPLOAD_COLUMNS])
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.fill = PatternFill("solid", fgColor="DDEBF7")
    ws.freeze_panes = "B2"
    wb.save(path)


def write_extended_csv(records, path):
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=EXTENDED_COLUMNS)
        writer.writeheader()
        for record in records:
            writer.writerow({
                "품목코드": record["품목코드"],
                "상품명": record["품목명"],
                "브랜드_cont2": record["_brand"],
                "모델_cont3": record["_model"],
                "제조사_cont4": record["_manufacturer"],
                "원산지_cont5": "",
                "공급사_cont6": SITE_SUPPLIER_LABEL.get(record["_site"], record["_site"]),
                "카페24상품코드": record["_cafe24_product_code"],
                "카페24품목코드": record["_cafe24_item_code"],
                "카테고리경로": record["_category"],
                "공개판매가": record["출고단가"],
                "대표이미지": record["_image"],
                "출처URL": record["_source_url"],
                "공급처원본ID": record["_key"],
            })


def duplicate_report(records):
    counts = Counter(record["품목코드"] for record in records)
    duplicates = {code: count for code, count in counts.items() if count > 1}
    return {
        "total_items": len(records),
        "unique_codes": len(counts),
        "duplicate_code_count": len(duplicates),
        "duplicate_rows_extra": sum(count - 1 for count in duplicates.values()),
        "too_long_codes": sum(1 for code in counts if len(code) > 20),
        "samples": dict(list(duplicates.items())[:20]),
    }


def missing_report(records, stats):
    return {
        "total_items": len(records),
        "missing_field_counts": {
            "품목명": sum(1 for r in records if not r["품목명"]),
            "규격": sum(1 for r in records if not r["규격"]),
            "바코드": sum(1 for r in records if not r["바코드"]),
            "검색창내용": sum(1 for r in records if not r["검색창내용"]),
            "출고단가": sum(1 for r in records if r["출고단가"] == ""),
            "입고단가": sum(1 for r in records if r["입고단가"] == ""),
        },
        "price_available_count": sum(1 for r in records if r["출고단가"] != ""),
        "price_missing_count": sum(1 for r in records if r["출고단가"] == ""),
        "model_present_count": sum(1 for r in records if r["규격"]),
        "brand_present_count": sum(1 for r in records if r["_brand"]),
        "manufacturer_present_count": sum(1 for r in records if r["_manufacturer"]),
        "image_ok_count": sum(1 for r in records if r["_image"].startswith("http")),
        "barcode_filled_count": sum(1 for r in records if r["바코드"]),
        "stock_managed_count": sum(1 for r in records if r["재고수량관리"] == "1"),
        "stock_unmanaged_count": sum(1 for r in records if r["재고수량관리"] == "0"),
        **stats,
    }


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(REP_DIR, exist_ok=True)
    master_rows, mapping = load_source()
    records, conversion_stats = build_records(master_rows, mapping)

    upload_csv = os.path.join(OUT_DIR, "ecount_item_upload.csv")
    upload_xlsx = os.path.join(OUT_DIR, "ecount_item_upload.xlsx")
    extended_csv = os.path.join(OUT_DIR, "erp_extended_mapping.csv")
    write_upload_csv(records, upload_csv)
    write_upload_xlsx(records, upload_xlsx)
    write_extended_csv(records, extended_csv)

    duplicates = duplicate_report(records)
    missing = missing_report(records, conversion_stats)
    with open(os.path.join(REP_DIR, "duplicate_item_codes_report.json"), "w", encoding="utf-8") as f:
        json.dump(duplicates, f, ensure_ascii=False, indent=2)
    with open(os.path.join(REP_DIR, "missing_erp_fields_report.json"), "w", encoding="utf-8") as f:
        json.dump(missing, f, ensure_ascii=False, indent=2)

    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_db": "data/full_catalog/product_db.xlsx",
        "template_source": "이카운트 품목등록 > 웹자료올리기 > 엑셀서식내려받기 (2026-10-23)",
        "upload_columns": ERP_UPLOAD_COLUMNS,
        "total_items": len(records),
        "unique_item_codes": duplicates["unique_codes"],
        "duplicate_codes": duplicates["duplicate_code_count"],
        "item_code_rule": "SS-<통합키 seq> / SM-<통합키 seq> (Cafe24 codes are not unique)",
        "price_available_count": missing["price_available_count"],
        "price_missing_count": missing["price_missing_count"],
        "model_present_count": missing["model_present_count"],
        "brand_present_count": missing["brand_present_count"],
        "manufacturer_present_count": missing["manufacturer_present_count"],
        "image_ok_count": missing["image_ok_count"],
        "barcode_filled_count": missing["barcode_filled_count"],
        "stock_managed_count": missing["stock_managed_count"],
        "stock_unmanaged_count": missing["stock_unmanaged_count"],
        "live_erp_write_performed": False,
        "erp_account_access_verified": True,
        "erp_access_verified_at": "2026-10-23",
        "outputs": {
            "upload_csv": "data/erp_prep/ecount_item_upload.csv",
            "upload_xlsx": "data/erp_prep/ecount_item_upload.xlsx",
            "extended_mapping_csv": "data/erp_prep/erp_extended_mapping.csv",
            "missing_erp_fields_report": "reports/data/erp/missing_erp_fields_report.json",
            "duplicate_item_codes_report": "reports/data/erp/duplicate_item_codes_report.json",
        },
    }
    with open(os.path.join(REP_DIR, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print(json.dumps({key: summary[key] for key in (
        "total_items", "unique_item_codes", "duplicate_codes",
        "price_available_count", "price_missing_count",
        "barcode_filled_count", "stock_managed_count", "stock_unmanaged_count",
    )}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
