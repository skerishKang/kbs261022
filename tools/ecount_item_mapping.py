#!/usr/bin/env python3
"""Build a review-only CGI product to ECOUNT item candidate CSV.

The ECOUNT export itself is supplied locally by an administrator. This tool
never connects to ECOUNT and never writes an approved mapping to a database.
"""

from __future__ import annotations

import argparse
import csv
import difflib
import io
import json
import posixpath
import re
import sys
import unicodedata
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PRODUCTS = ROOT / "site" / "data" / "products.json"

FIELD_ALIASES = {
    "code": {
        "prodcd", "itemcd", "itemcode", "productcode", "productcd", "itemnumber",
        "품목코드", "상품코드", "제품코드", "품번", "품목번호",
    },
    "name": {
        "proddes", "itemname", "productname", "description", "name",
        "품목명", "상품명", "제품명", "품명",
    },
    "spec": {
        "sizedes", "spec", "specification", "size", "model", "modelname",
        "규격", "모델", "모델명", "제품규격",
    },
    "unit": {
        "unit", "uom", "unitname", "quantityunit", "단위", "수량단위", "재고단위",
    },
    "barcode": {
        "barcode", "barcodenumber", "barcodeid", "ean", "ean13", "gtin", "upc",
        "바코드", "바코드번호", "바코드코드",
    },
}

OUTPUT_FIELDS = [
    "shop_product_id", "shop_product_name", "model",
    *[field for index in range(1, 4) for field in (
        f"candidate{index}_code", f"candidate{index}_name",
        f"candidate{index}_score", f"candidate{index}_evidence",
    )],
    "approved_ecount_code",
]


def normalize_header(value: Any) -> str:
    value = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return "".join(char for char in value if char.isalnum())


NORMALIZED_ALIASES = {
    field: {normalize_header(alias) for alias in aliases}
    for field, aliases in FIELD_ALIASES.items()
}


def normalize_text(value: Any) -> str:
    value = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return " ".join(re.findall(r"[^\W_]+", value, flags=re.UNICODE))


def compact(value: Any) -> str:
    value = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return "".join(char for char in value if char.isalnum())


def first_value(record: dict[str, Any], names: tuple[str, ...]) -> str:
    for name in names:
        value = record.get(name)
        if value is not None and str(value).strip():
            return str(value).strip()
    folded = {str(key).casefold(): value for key, value in record.items()}
    for name in names:
        value = folded.get(name.casefold())
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def cell_text(cell: ET.Element, shared_strings: list[str], number_formats: dict[int, str], cell_formats: list[int]) -> str:
    cell_type = cell.attrib.get("t", "")
    raw = cell.findtext("{*}v", default="")
    if cell_type == "s" and raw:
        try:
            return shared_strings[int(raw)]
        except (ValueError, IndexError):
            return raw
    if cell_type == "inlineStr":
        inline = cell.find("{*}is")
        return "".join(part.text or "" for part in inline.iter("{*}t")) if inline is not None else ""
    if cell_type in {"str", "e", "b"} or not raw:
        return raw

    # Preserve leading zeroes when Excel stores a code/barcode as a number with
    # a zero-mask format (for example 0000000000000).
    style_index = int(cell.attrib.get("s", "0") or 0)
    format_id = cell_formats[style_index] if style_index < len(cell_formats) else 0
    number_format = number_formats.get(format_id, "")
    if re.fullmatch(r"0{2,}", number_format) and re.fullmatch(r"\d+", raw):
        return raw.zfill(len(number_format))
    if re.fullmatch(r"\d+\.0+", raw):
        return raw.split(".", 1)[0]
    return raw


def xlsx_tables(path: Path) -> list[list[list[str]]]:
    main_ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    package_rel_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    with zipfile.ZipFile(path) as book:
        names = set(book.namelist())
        shared_strings: list[str] = []
        if "xl/sharedStrings.xml" in names:
            root = ET.fromstring(book.read("xl/sharedStrings.xml"))
            for entry in root.findall(f"{{{main_ns}}}si"):
                shared_strings.append("".join(part.text or "" for part in entry.iter(f"{{{main_ns}}}t")))

        number_formats: dict[int, str] = {}
        cell_formats: list[int] = [0]
        if "xl/styles.xml" in names:
            styles = ET.fromstring(book.read("xl/styles.xml"))
            custom_formats = styles.find(f"{{{main_ns}}}numFmts")
            if custom_formats is not None:
                number_formats = {
                    int(item.attrib["numFmtId"]): item.attrib.get("formatCode", "")
                    for item in custom_formats
                }
            xfs = styles.find(f"{{{main_ns}}}cellXfs")
            if xfs is not None:
                cell_formats = [int(item.attrib.get("numFmtId", "0")) for item in xfs]

        workbook = ET.fromstring(book.read("xl/workbook.xml"))
        relationships = ET.fromstring(book.read("xl/_rels/workbook.xml.rels"))
        target_by_id = {
            rel.attrib["Id"]: rel.attrib["Target"]
            for rel in relationships.findall(f"{{{package_rel_ns}}}Relationship")
        }
        tables: list[list[list[str]]] = []
        sheets = workbook.find(f"{{{main_ns}}}sheets")
        if sheets is None:
            return tables
        for sheet in sheets.findall(f"{{{main_ns}}}sheet"):
            relation_id = sheet.attrib.get(f"{{{rel_ns}}}id")
            target = target_by_id.get(relation_id or "")
            if not target:
                continue
            sheet_path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
            if sheet_path not in names:
                continue
            root = ET.fromstring(book.read(sheet_path))
            table: list[list[str]] = []
            for row in root.iter(f"{{{main_ns}}}row"):
                values: dict[int, str] = {}
                max_column = -1
                for cell in row.findall(f"{{{main_ns}}}c"):
                    reference = cell.attrib.get("r", "")
                    letters = re.match(r"([A-Z]+)", reference.upper())
                    if not letters:
                        continue
                    column = 0
                    for letter in letters.group(1):
                        column = column * 26 + ord(letter) - ord("A") + 1
                    column -= 1
                    values[column] = cell_text(cell, shared_strings, number_formats, cell_formats)
                    max_column = max(max_column, column)
                table.append([values.get(column, "") for column in range(max_column + 1)])
            tables.append(table)
        return tables


def csv_table(path: Path) -> list[list[str]]:
    raw = path.read_bytes()
    decoded = None
    last_error = None
    for encoding in ("utf-8-sig", "cp949", "euc-kr", "utf-8"):
        try:
            decoded = raw.decode(encoding)
            break
        except UnicodeDecodeError as error:
            last_error = error
    if decoded is None:
        raise ValueError(f"Cannot decode CSV using UTF-8 or Korean legacy encodings: {last_error}")
    sample = decoded[:8192]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",\t;")
        return [list(row) for row in csv.reader(io.StringIO(decoded), dialect)]
    except csv.Error:
        delimiter = max((",", "\t", ";"), key=lambda value: sample.count(value))
        return [list(row) for row in csv.reader(io.StringIO(decoded), delimiter=delimiter, quotechar='"')]


def header_mapping(rows: list[list[str]]) -> tuple[int, dict[str, int]] | None:
    for row_number, row in enumerate(rows[:30]):
        by_name: dict[str, int] = {}
        for index, header in enumerate(row):
            key = normalize_header(header)
            for field, aliases in NORMALIZED_ALIASES.items():
                if key in aliases and field not in by_name:
                    by_name[field] = index
        if "code" in by_name and "name" in by_name:
            return row_number, by_name
    return None


def read_ecount_items(path: Path) -> list[dict[str, str]]:
    suffix = path.suffix.casefold()
    tables = xlsx_tables(path) if suffix == ".xlsx" else [csv_table(path)] if suffix == ".csv" else None
    if tables is None:
        raise ValueError("ECOUNT input must be .xlsx or .csv")
    found_header = False
    for rows in tables:
        mapping = header_mapping(rows)
        if not mapping:
            continue
        found_header = True
        header_row, columns = mapping
        records: list[dict[str, str]] = []
        seen_codes: set[str] = set()
        duplicate_codes: list[str] = []
        for row in rows[header_row + 1:]:
            code = row[columns["code"]].strip() if columns["code"] < len(row) else ""
            name = row[columns["name"]].strip() if columns["name"] < len(row) else ""
            if not code or not name:
                continue
            if code in seen_codes:
                duplicate_codes.append(code)
                continue
            seen_codes.add(code)
            records.append({
                "code": code,
                "name": name,
                "spec": row[columns["spec"]].strip() if columns.get("spec", 999999) < len(row) else "",
                "unit": row[columns["unit"]].strip() if columns.get("unit", 999999) < len(row) else "",
                "barcode": row[columns["barcode"]].strip() if columns.get("barcode", 999999) < len(row) else "",
            })
        if duplicate_codes:
            raise ValueError(f"ECOUNT export has duplicate item codes; first duplicate: {duplicate_codes[0]}")
        if records:
            return records
    if found_header:
        raise ValueError("ECOUNT export header was recognized, but no item rows with both code and name were found")
    raise ValueError("Could not find a header row with both ECOUNT item code and item name columns")


def product_specs(record: dict[str, Any]) -> list[tuple[str, str]]:
    raw = record.get("specs") or record.get("specifications") or []
    pairs: list[tuple[str, str]] = []
    if isinstance(raw, dict):
        pairs.extend((str(key), str(value)) for key, value in raw.items() if value not in (None, ""))
    elif isinstance(raw, list):
        for entry in raw:
            if isinstance(entry, dict):
                label = entry.get("label") or entry.get("name") or entry.get("key") or ""
                value = entry.get("value") or entry.get("text") or ""
                if value:
                    pairs.append((str(label), str(value)))
    return pairs


def product_record(record: dict[str, Any]) -> dict[str, Any] | None:
    product_id = first_value(record, ("id", "product_id", "cgi_id", "master_product_key"))
    name = first_value(record, ("name", "product_name", "productName", "display_name"))
    if not product_id or not name:
        return None
    manufacturer = first_value(record, ("manufacturer", "brand", "maker"))
    model_values = [first_value(record, ("model", "model_name", "modelName", "model_number"))]
    barcode_values = [first_value(record, ("barcode", "bar_code", "ean", "ean13", "gtin", "upc"))]
    other_specs: list[str] = []
    model_words = ("model", "modelname", "modelnumber", "모델", "형번", "품번")
    barcode_words = ("barcode", "ean", "gtin", "upc", "바코드")
    for label, value in product_specs(record):
        label_key = normalize_header(label)
        if any(word in label_key for word in model_words):
            model_values.append(value)
        elif any(word in label_key for word in barcode_words):
            barcode_values.append(value)
        else:
            other_specs.append(value)
    models = sorted({compact(value) for value in model_values if compact(value)})
    barcodes = sorted({compact(value) for value in barcode_values if compact(value)})
    searchable = " ".join([name, manufacturer, *model_values, *other_specs]).strip()
    return {
        "id": product_id,
        "name": name,
        "manufacturer": manufacturer,
        "model_display": next((value for value in model_values if value.strip()), ""),
        "models": models,
        "barcodes": barcodes,
        "other_specs": other_specs,
        "search_text": searchable,
        "search_normalized": normalize_text(searchable),
        "search_compact": compact(searchable),
        "name_normalized": normalize_text(name),
        "name_compact": compact(name),
        "manufacturer_compact": compact(manufacturer),
    }


def load_products(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    records = data.get("records", []) if isinstance(data, dict) else data
    if not isinstance(records, list):
        raise ValueError("Product source JSON must be an array or an object with a records array")
    products = [item for item in (product_record(row) for row in records if isinstance(row, dict)) if item]
    if not products:
        raise ValueError("No shop products with an ID and name were found")
    return products


def ngrams(value: str, size: int = 3) -> set[str]:
    if len(value) < size:
        return {value} if value else set()
    return {value[index:index + size] for index in range(len(value) - size + 1)}


def score_candidates(products: list[dict[str, Any]], items: list[dict[str, str]], min_name_score: int = 35) -> list[dict[str, str]]:
    code_by_model: dict[str, set[int]] = {}
    code_by_barcode: dict[str, set[int]] = {}
    gram_index: dict[str, set[int]] = {}
    token_index: dict[str, set[int]] = {}
    prepared_items: list[dict[str, Any]] = []
    for index, item in enumerate(items):
        name_text = " ".join((item["name"], item["spec"]))
        name_normalized = normalize_text(name_text)
        name_compact = compact(name_text)
        spec_compact = compact(item["spec"])
        search_text = " ".join((item["name"], item["spec"]))
        search_normalized = normalize_text(search_text)
        search_compact = compact(search_text)
        prepared_items.append({
            **item,
            "name_normalized": name_normalized,
            "name_compact": name_compact,
            "spec_compact": spec_compact,
            "search_normalized": search_normalized,
            "search_compact": search_compact,
        })
        if spec_compact:
            code_by_model.setdefault(spec_compact, set()).add(index)
        barcode = compact(item["barcode"])
        if barcode:
            code_by_barcode.setdefault(barcode, set()).add(index)
        for gram in ngrams(search_compact):
            gram_index.setdefault(gram, set()).add(index)
        for token in set(search_normalized.split()):
            if len(token) >= 2:
                token_index.setdefault(token, set()).add(index)

    gram_limit = max(80, len(items) // 3)
    token_limit = max(80, len(items) // 3)
    output: list[dict[str, str]] = []
    for product in products:
        model_matches: set[int] = set()
        for model in product["models"]:
            model_matches.update(code_by_model.get(model, set()))
        barcode_matches: set[int] = set()
        for barcode in product["barcodes"]:
            barcode_matches.update(code_by_barcode.get(barcode, set()))

        possible: set[int] = set(model_matches) | set(barcode_matches)
        query_name = product["name_compact"]
        for gram in ngrams(query_name):
            ids = gram_index.get(gram, set())
            if len(ids) <= gram_limit:
                possible.update(ids)
        for token in set(product["search_normalized"].split()):
            if len(token) < 2:
                continue
            ids = token_index.get(token, set())
            if len(ids) <= token_limit:
                possible.update(ids)

        candidates: list[tuple[int, int, str, dict[str, str]]] = []
        for item_index in possible:
            item = prepared_items[item_index]
            model_exact = item_index in model_matches
            barcode_exact = item_index in barcode_matches
            if model_exact:
                priority, score = 0, 100
                evidence = "model exact (shop model ↔ ECOUNT SIZE_DES)"
                if barcode_exact:
                    evidence += "; barcode exact"
            elif barcode_exact:
                priority, score = 1, 98
                evidence = "barcode exact (shop barcode ↔ ECOUNT BAR_CODE)"
            else:
                ratio = difflib.SequenceMatcher(None, product["name_compact"], item["name_compact"], autojunk=False).ratio()
                brand_exact = bool(product["manufacturer_compact"] and product["manufacturer_compact"] in item["search_compact"])
                matching_specs = [value for value in product["other_specs"] if len(compact(value)) >= 5 and compact(value) in item["search_compact"]]
                score = min(95, round(ratio * 85 + (5 if brand_exact else 0) + (4 if matching_specs else 0)))
                if score < min_name_score:
                    continue
                priority = 2
                evidence_parts = [f"normalized name similarity ({round(ratio * 100)}%)"]
                if brand_exact:
                    evidence_parts.append("manufacturer/brand exact in ECOUNT name/spec")
                if matching_specs:
                    evidence_parts.append("shop specification exact in ECOUNT name/spec")
                evidence = "; ".join(evidence_parts)
            candidate = {
                "code": item["code"],
                "name": item["name"],
                "score": str(score),
                "evidence": evidence,
            }
            candidates.append((priority, -score, item["code"], candidate))
        candidates.sort(key=lambda entry: (entry[0], entry[1], entry[2]))
        selected: list[dict[str, str]] = []
        seen_codes: set[str] = set()
        for _, _, code, candidate in candidates:
            if code in seen_codes:
                continue
            seen_codes.add(code)
            selected.append(candidate)
            if len(selected) == 3:
                break

        row = {
            "shop_product_id": product["id"],
            "shop_product_name": product["name"],
            "model": product["model_display"],
            "approved_ecount_code": "",
        }
        for index in range(1, 4):
            candidate = selected[index - 1] if index <= len(selected) else {}
            row[f"candidate{index}_code"] = candidate.get("code", "")
            row[f"candidate{index}_name"] = candidate.get("name", "")
            row[f"candidate{index}_score"] = candidate.get("score", "")
            row[f"candidate{index}_evidence"] = candidate.get("evidence", "")
        output.append(row)
    return output


def display_field_name(field: str) -> str:
    names = {
        "code": "\uD488\uBAA9\uCF54\uB4DC",
        "name": "\uD488\uBAA9\uBA85",
        "spec": "\uADDC\uACA9/\uBAA8\uB378",
        "unit": "\uB2E8\uC704",
        "barcode": "\uBC14\uCF54\uB4DC",
    }
    return names[field]


def korean_output_fields() -> list[str]:
    fields = ["\uC1FC\uD551\uBAB0 \uC0C1\uD488 ID", "\uC0C1\uD488\uBA85", "\uBAA8\uB378"]
    for index in range(1, 4):
        fields.extend([
            f"\uD6C4\uBCF4{index} \uCF54\uB4DC",
            f"\uD6C4\uBCF4{index} \uD488\uBAA9\uBA85",
            f"\uD6C4\uBCF4{index} \uC810\uC218",
            f"\uD6C4\uBCF4{index} \uADFC\uAC70",
        ])
    fields.append("\uC2B9\uC778")
    return fields


def write_candidates(path: Path, rows: list[dict[str, str]]) -> None:
    output_fields = korean_output_fields()
    key_fields = OUTPUT_FIELDS
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=output_fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(dict(zip(output_fields, (row.get(field, "") for field in key_fields))))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate a review CSV for CGI product to ECOUNT item matching.")
    parser.add_argument("--ecount-file", required=True, type=Path, help="Local ECOUNT item export (.xlsx or .csv).")
    parser.add_argument("--products", type=Path, default=DEFAULT_PRODUCTS, help="Shop product JSON source (default: site/data/products.json).")
    parser.add_argument("--output", required=True, type=Path, help="Candidate review CSV output path.")
    parser.add_argument("--min-name-score", type=int, default=35, help="Minimum fuzzy name score from 0 to 100 (default: 35).")
    args = parser.parse_args(argv)
    if not 0 <= args.min_name_score <= 100:
        parser.error("--min-name-score must be between 0 and 100")
    if not args.ecount_file.is_file():
        parser.error(f"ECOUNT input file does not exist: {args.ecount_file}")
    if not args.products.is_file():
        parser.error(f"Product JSON does not exist: {args.products}")
    try:
        items = read_ecount_items(args.ecount_file)
        products = load_products(args.products)
        rows = score_candidates(products, items, args.min_name_score)
        write_candidates(args.output, rows)
    except (OSError, ValueError, json.JSONDecodeError, zipfile.BadZipFile, ET.ParseError) as error:
        print(f"ecount_item_mapping: {error}", file=sys.stderr)
        return 2
    print(f"products={len(products)} ecount_items={len(items)} output_rows={len(rows)} output={args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
