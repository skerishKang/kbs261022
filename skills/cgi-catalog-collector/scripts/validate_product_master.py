#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""상품 마스터 CSV가 스키마/추정 금지 규칙을 지켰는지 검증한다.

사용:
  python validate_product_master.py reports/samples/product_master_sample.csv \
      --schema skills/cgi-catalog-collector/schema/product-master.schema.json

종료 코드: 0 = 규칙 위반 없음, 1 = 위반 있음
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import Counter
from typing import List


def main(argv: List[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("csv_path")
    ap.add_argument("--schema", required=True)
    args = ap.parse_args(argv)

    with open(args.csv_path, encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))
    with open(args.schema, encoding="utf-8") as fh:
        schema = json.load(fh)
    props = set(schema["properties"])
    cols = set(rows[0].keys()) if rows else set()

    errors: List[str] = []
    if props - cols:
        errors.append(f"스키마에 있는데 CSV 에 없는 컬럼: {sorted(props - cols)}")
    if cols - props:
        errors.append(f"CSV 에 있는데 스키마에 없는 컬럼: {sorted(cols - props)}")

    for i, r in enumerate(rows, 1):
        for k in schema.get("required", []):
            if k not in r:
                errors.append(f"row{i}: required 컬럼 '{k}' 누락")
        state = (r.get("published_price_state") or "").strip()
        price = (r.get("published_price") or "").strip()
        if state == "numeric_price" and price == "":
            errors.append(f"row{i}: published_price_state=numeric_price인데 published_price 가 비어 있음")
        if state and state != "numeric_price" and price != "":
            errors.append(f"row{i}: published_price_state={state} 인데 published_price={price} (추정 의심)")
        if (r.get("dealer_price_unverified") or "").strip():
            errors.append(f"row{i}: dealer_price_unverified 에 값이 있음 (공개 근거 없음 → 추정 금지)")
        ev = (r.get("source_evidence") or "").strip()
        if not ev.startswith("http"):
            errors.append(f"row{i}: source_evidence 가 원본 URL 이 아님")
        cu = (r.get("canonical_url") or "").strip()
        if cu and not cu.startswith("https://"):
            errors.append(f"row{i}: canonical_url 이 https 가 아님")
        if cu and "/product/" not in cu:
            errors.append(f"row{i}: canonical_url 에 /product/ 경로가 없음")
        if not (r.get("verification_status") or "").strip():
            errors.append(f"row{i}: verification_status 누락")

    dup = Counter((r.get("source_site"), r.get("source_product_id")) for r in rows)
    for k, c in dup.items():
        if c > 1:
            errors.append(f"중복 키 (source_site, source_product_id) = {k} × {c}")

    print(f"rows={len(rows)} cols={len(cols)} violations={len(errors)}")
    print("site distribution:", dict(Counter(r.get("source_site") for r in rows)))
    print("price states:", dict(Counter(r.get("published_price_state") for r in rows)))
    for e in errors:
        print("  VIOLATION:", e)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
