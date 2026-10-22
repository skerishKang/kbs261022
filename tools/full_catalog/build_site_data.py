#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_site_data.py -- 카탈로그 사이트(PR #17)용 상품 JSON 생성 + Excel↔JSON 대조 (이슈 #19).

역할
    1. PR #17 의 `tools/build_catalog_data.py` 를 **그대로 재사용**해
       `site/data/products.json` 과 `site/data/products.js` 를 생성한다.
       (쇼핑몰 UI/스키마는 건드리지 않는다)
    2. 생성된 JSON 과 통합 상품 마스터(XLSX)의 건수·식별자가 일치하는지 검증한다.

입력
    --master-csv   build_full_catalog.py 가 만든 catalog_source.csv
    --categories   build_full_catalog.py 가 만든 category_catalog.csv
    --master-json  통합 상품 마스터 JSON (Excel 과 같은 레코드)
    --out-dir      site/data 디렉터리

출력
    site/data/products.json, site/data/products.js
    <out-dir>/../site_data_verification.json
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path
from collections import Counter
from typing import Any, Dict, List

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def load_pr17_builder():
    """PR #17 의 tools/build_catalog_data.py 를 모듈로 로드한다 (수정 없이 재사용)."""
    path = REPO_ROOT / "tools" / "build_catalog_data.py"
    if not path.exists():
        raise SystemExit(f"PR #17 빌더를 찾을 수 없습니다: {path}")
    spec = importlib.util.spec_from_file_location("pr17_build_catalog_data", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_minified(out_dir: Path, products: List[Dict[str, Any]], meta: Dict[str, Any]) -> Dict[str, str]:
    """indent 없는 JSON 으로 써서 저장 크기를 줄인다 (스키마는 동일)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "products.json"
    js_path = out_dir / "products.js"

    json_path.write_text(
        json.dumps(products, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    js_path.write_text(
        "/* CGI 상품 카탈로그 데이터 (자동 생성: tools/full_catalog/build_site_data.py)\n"
        "   출처: 공급처 공개 전수 수집(이슈 #19) -> 이슈 #8 통합 상품 마스터 -> PR #17 정규화.\n"
        "   재생성 방법: docs/CGI_FULL_CATALOG_EXCEL.md 참고. */\n"
        "window.CGI_PRODUCTS = "
        + json.dumps(products, ensure_ascii=False, separators=(",", ":"))
        + ";\nwindow.CGI_PRODUCT_META = "
        + json.dumps(meta, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )
    return {
        "products_json": str(json_path),
        "products_js": str(js_path),
        "products_json_bytes": str(json_path.stat().st_size),
        "products_js_bytes": str(js_path.stat().st_size),
    }


def verify_match(products: List[Dict[str, Any]], master: List[Dict[str, Any]]) -> Dict[str, Any]:
    """사이트 JSON 과 통합 마스터의 건수·식별자 일치 검증."""
    site_ids = [p.get("id", "") for p in products]
    master_ids = [
        f"{r['source_site']}.co.kr:{r['source_product_id']}" for r in master
    ]
    site_set, master_set = set(site_ids), set(master_ids)
    missing_in_site = sorted(master_set - site_set)
    extra_in_site = sorted(site_set - master_set)
    duplicates = len(site_ids) - len(site_set)
    return {
        "site_products": len(products),
        "master_products": len(master),
        "count_match": len(products) == len(master),
        "id_match": site_set == master_set,
        "missing_in_site": missing_in_site[:50],
        "missing_in_site_count": len(missing_in_site),
        "extra_in_site": extra_in_site[:50],
        "extra_in_site_count": len(extra_in_site),
        "duplicate_ids_in_site": duplicates,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="카탈로그 사이트 데이터 빌더 (이슈 #19)")
    ap.add_argument("--master-csv", required=True)
    ap.add_argument("--categories", required=True)
    ap.add_argument("--master-json", required=True)
    ap.add_argument("--out-dir", default=str(REPO_ROOT / "site" / "data"))
    ap.add_argument("--verification-out", default=None)
    args = ap.parse_args()

    builder = load_pr17_builder()
    cat_index = builder.build_index(Path(args.categories))
    products = builder.from_master_csv(Path(args.master_csv), cat_index)
    if not products:
        print("[ERROR] 상품이 0건입니다")
        return 2

    brands = sorted({p["brand_norm"] for p in products if p["brand_norm"]})
    sites = sorted({p["source"]["site"] for p in products})

    # 공급처 카탈로그 규모 = 해당 공급처에서 실제로 수집한 상품 수.
    # (PR #17 의 샘플 빌더는 카테고리별 최대 등록 건수를 썼다. 전수 수집에서는
    #  그 값이 카테고리 하나 크기여서, 사이트 전체 수집 수로 계산한다.)
    per_site: Counter = Counter()
    for p in products:
        per_site[p.get("source", {}).get("site", "unknown")] += 1
    supplier_totals: Dict[str, Dict[str, Any]] = {
        site: {
            "count": count,
            "source": "이슈 #19 전수 수집 (해당 공급처에서 수집한 상품 수)",
        }
        for site, count in sorted(per_site.items())
    }

    meta = {
        "generated_at": builder.datetime.now(builder.timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "product_count": len(products),
        "brands": brands,
        "sources": sites,
        "source_labels": {s: builder.SITE_LABEL.get(s, s) for s in sites},
        "supplier_catalog_totals": supplier_totals,
        "data_origin": [
            "공급처 공개 전수 수집 (이슈 #19, tools/full_catalog/run_full_collection.py)",
            "통합 상품 마스터 (이슈 #8, PR #16 tools/product_master/)",
        ],
        "notes": [
            "공급처 공개 수집 데이터이며 CGI 판매 가능 수량이 아닙니다.",
            "published_price 는 공급처 공개 판매가만 표기. 미공개는 '가격 문의'.",
            "재고·도매가는 공개 근거가 없어 표기하지 않습니다.",
        ],
    }

    out_dir = Path(args.out_dir)
    written = write_minified(out_dir, products, meta)

    master = json.loads(Path(args.master_json).read_text(encoding="utf-8"))["records"]
    match = verify_match(products, master)
    verification = {
        "written": written,
        "brands": len(brands),
        "sources": sites,
        "match": match,
    }
    vpath = Path(args.verification_out) if args.verification_out else out_dir.parent / "site_data_verification.json"
    vpath.parent.mkdir(parents=True, exist_ok=True)
    vpath.write_text(json.dumps(verification, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"[build_site_data] products={len(products)} brands={len(brands)}")
    for k, v in written.items():
        print(f"  {k}: {v}")
    print(f"  match: {json.dumps(match, ensure_ascii=False)}")
    print(f"  verification: {vpath}")
    return 0 if match["count_match"] and match["id_match"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
