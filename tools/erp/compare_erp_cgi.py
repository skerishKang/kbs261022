#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Read-only comparison of Ecount item/inventory exports with the CGI master.

Only aggregate counts are written to the repository. Item-level ERP rows are
never persisted; the source exports live under the gitignored live/ directory.

Usage:
  python tools/erp/compare_erp_cgi.py \
      --erp-xlsx reports/data/erp/live/ecount_item_export.xlsx \
      --inventory-xlsx reports/data/erp/live/inventory_export_excel_click.xlsx
"""
from __future__ import annotations

import argparse
import json
import os
import re
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from datetime import datetime, timezone

try:
    import openpyxl
except ImportError as exc:  # pragma: no cover
    raise SystemExit("openpyxl required") from exc

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DB_PATH = os.path.join(REPO_ROOT, "data", "full_catalog", "product_db.xlsx")
OUT_DIR = os.path.join(REPO_ROOT, "reports", "data", "erp")
DEFAULT_ERP = os.path.join(OUT_DIR, "live", "ecount_item_export.xlsx")
DEFAULT_INVENTORY = os.path.join(OUT_DIR, "live", "inventory_export_excel_click.xlsx")
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def norm(value):
    if value is None:
        return ""
    text = str(value).lower()
    text = re.sub(r"\s+", "", text)
    return re.sub(r"[^a-z0-9가-힣]", "", text)


def read_inline_xlsx(path):
    """Read Ecount-exported xlsx files that use inline strings and a bogus A1 dimension."""
    with zipfile.ZipFile(path) as archive:
        sheet = archive.read("xl/worksheets/sheet1.xml")
    if b"<!DOCTYPE" in sheet or b"<!ENTITY" in sheet:
        raise ValueError("unexpected DTD/entity in xlsx worksheet")
    root = ET.fromstring(sheet.decode("utf-8-sig"))
    rows = []
    for row in root.findall(".//m:sheetData/m:row", NS):
        cells = []
        for cell in row.findall("m:c", NS):
            if cell.get("t") == "inlineStr":
                cells.append("".join(node.text or "" for node in cell.iter() if node.tag.endswith("}t")))
            else:
                value = cell.find("m:v", NS)
                cells.append(value.text if value is not None and value.text else "")
        rows.append(cells)
    return rows


def load_erp_items(path):
    rows = read_inline_xlsx(path)
    if len(rows) < 3:
        raise ValueError(f"unexpected ERP export: {path}")
    header = rows[1]
    idx = {name: index for index, name in enumerate(header) if name}
    items = []
    for row in rows[2:]:
        if not row or "품목코드" not in idx or len(row) <= idx["품목코드"]:
            continue
        code = str(row[idx["품목코드"]]).strip()
        if not code or re.match(r"^\d{4}[/.-]\d{1,2}[/.-]\d{1,2}", code):
            continue
        items.append({
            "erp_code": code,
            "erp_name": row[idx["품목명"]] if "품목명" in idx else "",
            "erp_type": row[idx["품목구분"]] if "품목구분" in idx else "",
            "erp_spec": row[idx["규격명"]] if "규격명" in idx else "",
            "erp_group": row[idx["계층그룹명"]] if "계층그룹명" in idx else "",
            "erp_stock_mgmt": row[idx["재고수량관리"]] if "재고수량관리" in idx else "",
        })
    return items


def load_cgi_master():
    wb = openpyxl.load_workbook(DB_PATH, read_only=True, data_only=True)
    ws = wb["통합상품"]
    rows = list(ws.iter_rows(values_only=True))
    idx = {name: index for index, name in enumerate(rows[0])}
    items = []
    for row in rows[1:]:
        if not row or row[idx["통합키"]] is None:
            continue
        items.append({
            "cgi_key": str(row[idx["통합키"]]),
            "cgi_name": str(row[idx["상품명"]] or "").strip(),
            "cgi_brand": str(row[idx["브랜드"]] or "").strip(),
            "cgi_model": str(row[idx["모델명"]] or "").strip(),
            "cgi_source": str(row[idx["공급처코드"]] or "").strip(),
        })
    return items


def load_inventory_summary(path):
    if not path or not os.path.exists(path):
        return None
    rows = read_inline_xlsx(path)
    if len(rows) < 3:
        return None
    header = rows[1]
    idx = {name: index for index, name in enumerate(header) if name}
    qty_index = idx.get("재고수량")
    price_index = idx.get("입고단가")
    codes = []
    qty_positive = 0
    price_present = 0
    for row in rows[2:]:
        if not row or len(row) <= max(qty_index or 0, price_index or 0):
            continue
        code = str(row[idx.get("품목코드", 0)]).strip()
        if not code or re.match(r"^\d{4}[/.-]\d{1,2}[/.-]\d{1,2}", code) or code == "합계":
            continue
        codes.append(code)
        try:
            if qty_index is not None and float(str(row[qty_index]).replace(",", "")) > 0:
                qty_positive += 1
        except ValueError:
            pass
        if price_index is not None and str(row[price_index]).strip():
            price_present += 1
    return {
        "inventory_rows": len(codes),
        "qty_positive_rows": qty_positive,
        "in_price_present_rows": price_present,
        "inventory_codes": set(codes),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--erp-xlsx", default=DEFAULT_ERP)
    parser.add_argument("--inventory-xlsx", default=DEFAULT_INVENTORY)
    args = parser.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    erp_items = load_erp_items(args.erp_xlsx)
    cgi_items = load_cgi_master()

    cgi_by_name = defaultdict(list)
    cgi_by_model = defaultdict(list)
    for item in cgi_items:
        if item["cgi_name"]:
            cgi_by_name[norm(item["cgi_name"])].append(item)
        if item["cgi_model"]:
            cgi_by_model[norm(item["cgi_model"])].append(item)

    name_matches = 0
    model_matches = 0
    candidate_matches = 0
    matched_cgi = set()
    matched_erp = set()
    for erp in erp_items:
        erp_name = norm(erp["erp_name"])
        erp_spec = norm(erp["erp_spec"])
        if erp_name and erp_name in cgi_by_name:
            name_matches += len(cgi_by_name[erp_name])
            matched_erp.add(erp["erp_code"])
            matched_cgi.update(item["cgi_key"] for item in cgi_by_name[erp_name])
        if erp_spec and erp_spec in cgi_by_model:
            model_matches += len(cgi_by_model[erp_spec])
            matched_erp.add(erp["erp_code"])
            matched_cgi.update(item["cgi_key"] for item in cgi_by_model[erp_spec])
        probe = erp_spec or erp_name
        if len(probe) >= 4 and erp["erp_code"] not in matched_erp:
            for item in cgi_items:
                model = norm(item["cgi_model"])
                name = norm(item["cgi_name"])
                if (model and len(model) >= 4 and (probe in model or model in probe)) or (
                    name and len(name) >= 6 and probe in name
                ):
                    candidate_matches += 1
                    matched_erp.add(erp["erp_code"])
                    matched_cgi.add(item["cgi_key"])
                    break

    inventory = load_inventory_summary(args.inventory_xlsx)
    inventory_report = None
    if inventory:
        erp_codes = {item["erp_code"] for item in erp_items}
        inventory_report = {
            "inventory_rows": inventory["inventory_rows"],
            "qty_positive_rows": inventory["qty_positive_rows"],
            "in_price_present_rows": inventory["in_price_present_rows"],
            "codes_also_in_erp_export": len(inventory["inventory_codes"] & erp_codes),
        }

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "erp_total_items": len(erp_items),
        "cgi_total_items": len(cgi_items),
        "exact_code_matches": 0,
        "name_exact_pairs": name_matches,
        "model_exact_pairs": model_matches,
        "candidate_pairs": candidate_matches,
        "erp_items_matched": len(matched_erp),
        "erp_items_unmatched": len(erp_items) - len(matched_erp),
        "cgi_items_matched": len(matched_cgi),
        "cgi_items_unmatched": len(cgi_items) - len(matched_cgi),
        "erp_groups": dict(Counter(item["erp_group"] for item in erp_items)),
        "erp_types": dict(Counter(item["erp_type"] for item in erp_items)),
        "cgi_sources": dict(Counter(item["cgi_source"] for item in cgi_items)),
        "inventory": inventory_report,
        "limitations": [
            "ERP item codes (000001) and CGI codes (SS-/SM-) are different namespaces.",
            "The item export has no price columns; the inventory export has 입고단가만.",
            "Name/model matching is only an indicator, not a validated mapping.",
            "Item-level ERP rows are not stored in the repository.",
        ],
    }
    with open(os.path.join(OUT_DIR, "erp_readonly_comparison.json"), "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)

    inventory_line = (
        f"- 재고현황 export: {inventory_report['inventory_rows']}행, "
        f"재고수량>0 {inventory_report['qty_positive_rows']}행, "
        f"입고단가 있음 {inventory_report['in_price_present_rows']}행, "
        f"ERP 품목 export와 코드 교집합 {inventory_report['codes_also_in_erp_export']}건"
        if inventory_report else "- 재고현황 export: 미제공"
    )
    markdown = f"""# ERP 읽기 전용 대조 결과 (집계 전용)

- ERP 등록 품목: {len(erp_items)}
- CGI 상품 마스터: {len(cgi_items)}
- 품목코드 정확 일치: 0 (ERP 000001 vs CGI SS-/SM-)
- 상품명 정확 일치(쌍): {name_matches}
- 모델명 정확 일치(쌍): {model_matches}
- 부분 문자열 후보(쌍): {candidate_matches}
- 매칭된 ERP 품목: {len(matched_erp)} / 미매칭 {len(erp_items) - len(matched_erp)}
- 매칭된 CGI 상품: {len(matched_cgi)} / 미매칭 {len(cgi_items) - len(matched_cgi)}
{inventory_line}

## ERP 품목 그룹 분포
{json.dumps(dict(Counter(item['erp_group'] for item in erp_items)), ensure_ascii=False, indent=2)}

## ERP 품목 구분 분포
{json.dumps(dict(Counter(item['erp_type'] for item in erp_items)), ensure_ascii=False, indent=2)}

## CGI 공급처 분포
{json.dumps(dict(Counter(item['cgi_source'] for item in cgi_items)), ensure_ascii=False, indent=2)}

## 한계
- ERP와 CGI는 품목코드 체계가 달라 코드 대조가 불가능하다.
- 품목 export에는 가격 컬럼이 없고, 재고현황 export에는 입고단가만 있다.
- 이름/모델 일치는 후보 판정이며 확정 매핑이 아니다.
- 품목 단위 실데이터는 저장소에 기록하지 않았다.
"""
    with open(os.path.join(OUT_DIR, "erp_readonly_report.md"), "w", encoding="utf-8") as handle:
        handle.write(markdown)
    print(json.dumps({key: report[key] for key in (
        "erp_total_items", "cgi_total_items", "name_exact_pairs", "model_exact_pairs",
        "candidate_pairs", "erp_items_matched", "erp_items_unmatched",
        "cgi_items_matched", "cgi_items_unmatched", "inventory",
    )}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
