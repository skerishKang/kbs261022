#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_full_catalog.py -- CGI 전체 상품 DB 검증 (이슈 #19).

검증 항목
    1. 원천 상품 수 대조            수집 원본 ↔ 마스터 ↔ XLSX ↔ 사이트 JSON
    2. 중복 상품 판정 결과 확인      confirmed / candidate / probable
    3. 가격·이미지·규격 누락률
    4. 사이트별 카테고리 구분 확인   cate_no namespace 분리
    5. Excel 파일 실제 열기 검증    openpyxl 로 재오픈 + 시트/행수 확인
    6. JSON 스키마 검사             PR #16 스키마로 마스터/사이트 JSON 검사
    7. HTML 연결 데이터 검사        site/data/products.json 과 Excel 대조

사용 예
    python tools/full_catalog/verify_full_catalog.py \
        --xlsx C:/cgi-work/catalog-data/full/product_db.xlsx \
        --master-json C:/cgi-work/catalog-data/full/product_master.full.json \
        --site-json site/data/products.json \
        --data-dir C:/cgi-work/catalog-data
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.product_master import schema as SC  # noqa: E402
from tools.product_master import validate as VA  # noqa: E402

#: XLSX 에 반드시 있어야 하는 시트 (이슈 #19 요구사항 3)
REQUIRED_SHEETS: List[str] = [
    "통합상품",
    "공급처원본",
    "브랜드_카테고리",
    "중복후보",
    "누락_검증현황",
    "네이버스토어준비",
    "이카운트품목매핑",
]

#: 사이트 JSON 이 반드시 가지고 있어야 하는 필드 (PR #17 스키마)
SITE_REQUIRED_FIELDS: List[str] = [
    "id",
    "name",
    "brand",
    "brand_raw",
    "brand_norm",
    "manufacturer",
    "model",
    "category_path",
    "category",
    "price",
    "availability",
    "images",
    "specs",
    "options",
    "source",
]


def check_source_counts(data_dir: Path) -> Dict[str, Any]:
    """수집 원본의 사이트별 건수."""
    out: Dict[str, Any] = {}
    for site in ("samasound", "samamusic"):
        path = data_dir / f"{site}_detail.json"
        if path.exists():
            out[site] = len(json.loads(path.read_text(encoding="utf-8")))
        else:
            out[site] = None
    out["total"] = sum(v for v in out.values() if isinstance(v, int))
    return out


def check_xlsx(path: Path) -> Dict[str, Any]:
    """Excel 파일을 실제로 열어 시트/행 수를 확인한다."""
    try:
        from openpyxl import load_workbook
    except ImportError:  # pragma: no cover
        return {"ok": False, "error": "openpyxl 미설치"}

    if not path.exists():
        return {"ok": False, "error": f"파일 없음: {path}"}

    wb = load_workbook(path, read_only=True, data_only=True)
    sheets: Dict[str, int] = {}
    headers: Dict[str, List[str]] = {}
    for name in wb.sheetnames:
        ws = wb[name]
        rows = ws.iter_rows(values_only=True)
        try:
            head = next(rows)
        except StopIteration:
            head = ()
        count = sum(1 for _ in rows)
        sheets[name] = count
        headers[name] = [str(h) for h in head if h is not None]
    wb.close()

    missing = [s for s in REQUIRED_SHEETS if s not in sheets]
    return {
        "ok": not missing,
        "path": str(path),
        "bytes": path.stat().st_size,
        "sheet_names": list(sheets),
        "sheet_rows": sheets,
        "sheet_headers": headers,
        "required_sheets_missing": missing,
    }


def check_master(master: List[Dict[str, Any]]) -> Dict[str, Any]:
    """마스터 레코드 스키마/정책 검증 + 누락률 + 중복 요약."""
    result = VA.validate_dataset(master)
    by_site = Counter(r["source_site"] for r in master)

    groups: Dict[str, List[str]] = {}
    for r in master:
        gid = r.get("dedupe_group_id")
        if gid:
            groups.setdefault(gid, []).append(r["source_key"])
    group_sizes = Counter(len(v) for v in groups.values())

    def rate(pred) -> Dict[str, Any]:
        missing = sum(1 for r in master if pred(r))
        return {
            "missing": missing,
            "present": len(master) - missing,
            "rate": round(missing / len(master), 4) if master else 0.0,
        }

    return {
        "ok": result["ok"],
        "count": len(master),
        "unique_keys": result["unique_key_count"],
        "by_site": dict(by_site),
        "structural_errors": result["structural_error_count"],
        "policy_errors": result["policy_error_count"],
        "duplicate_groups": len(groups),
        "duplicate_group_size_distribution": {str(k): v for k, v in sorted(group_sizes.items())},
        "missing_rates": {
            "public_price": rate(lambda r: r["public_price"] is None),
            "image": rate(lambda r: not r["image_urls"]),
            "specs": rate(lambda r: not r["specs"]),
            "brand": rate(lambda r: not r["brand"]),
            "manufacturer": rate(lambda r: not r["manufacturer"]),
            "model": rate(lambda r: not r["model"]),
            "options": rate(lambda r: not r["options"]),
        },
    }


def check_categories(master: List[Dict[str, Any]]) -> Dict[str, Any]:
    """사이트별 카테고리 namespace 분리와 cate_no 충돌 확인."""
    namespaces = {r["category_namespace"] for r in master}
    per_site: Dict[str, set] = {}
    for r in master:
        per_site.setdefault(r["source_site"], set()).add(r["category_leaf_cate_no"])
    samasound_ids = per_site.get("samasound", set())
    samamusic_ids = per_site.get("samamusic", set())
    shared = sorted(
        (s for s in samasound_ids & samamusic_ids if s), key=lambda x: int(x) if str(x).isdigit() else 0
    )
    return {
        "ok": len(namespaces) == len({r["source_site"] for r in master}),
        "namespaces": sorted(namespaces),
        "distinct_cate_no_by_site": {k: len(v) for k, v in per_site.items()},
        "shared_cate_no_numbers": shared,
        "shared_count": len(shared),
        "note": (
            "같은 숫자의 cate_no 가 양쪽에 있으면 서로 다른 카테고리를 가리킨다. "
            "예: 42 = samasound Shure / samamusic 스피커."
        ),
    }


def check_site_json(
    site_json: Path, master: List[Dict[str, Any]], xlsx_rows: Optional[int]
) -> Dict[str, Any]:
    """사이트 JSON 스키마 + Excel/마스터와의 건수·식별자 일치."""
    if not site_json.exists():
        return {"ok": False, "error": f"파일 없음: {site_json}"}
    products = json.loads(site_json.read_text(encoding="utf-8"))

    missing_fields: Counter = Counter()
    for p in products:
        for f in SITE_REQUIRED_FIELDS:
            if f not in p:
                missing_fields[f] += 1

    site_ids = [p.get("id", "") for p in products]
    master_ids = [f"{r['source_site']}.co.kr:{r['source_product_id']}" for r in master]
    site_set, master_set = set(site_ids), set(master_ids)

    result = {
        "ok": True,
        "path": str(site_json),
        "bytes": site_json.stat().st_size,
        "count": len(products),
        "count_match_master": len(products) == len(master),
        "id_match_master": site_set == master_set,
        "missing_in_site_count": len(master_set - site_set),
        "extra_in_site_count": len(site_set - master_set),
        "duplicate_ids": len(site_ids) - len(site_set),
        "required_fields_missing": dict(missing_fields),
        "brands": len({p.get("brand_norm") for p in products if p.get("brand_norm")}),
    }
    if xlsx_rows is not None:
        result["count_match_xlsx"] = len(products) == xlsx_rows
    result["ok"] = (
        result["count_match_master"]
        and result["id_match_master"]
        and not missing_fields
        and result["duplicate_ids"] == 0
    )
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description="CGI 전체 상품 DB 검증 (이슈 #19)")
    ap.add_argument("--xlsx", required=True)
    ap.add_argument("--master-json", required=True)
    ap.add_argument("--site-json", required=True)
    ap.add_argument("--data-dir", default="C:/cgi-work/catalog-data")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    master = json.loads(Path(args.master_json).read_text(encoding="utf-8"))["records"]

    report: Dict[str, Any] = {
        "source_counts": check_source_counts(Path(args.data_dir)),
        "master": check_master(master),
        "categories": check_categories(master),
        "xlsx": check_xlsx(Path(args.xlsx)),
        "site_json": check_site_json(
            Path(args.site_json), master, None
        ),
    }
    # XLSX 통합상품 행 수와 사이트 JSON 대조
    unified_rows = report["xlsx"].get("sheet_rows", {}).get("통합상품")
    if unified_rows is not None:
        report["site_json"]["count_match_xlsx"] = unified_rows == report["site_json"]["count"]
    report["site_json"]["ok"] = (
        report["site_json"]["count_match_master"]
        and report["site_json"]["id_match_master"]
        and not report["site_json"]["required_fields_missing"]
        and report["site_json"]["duplicate_ids"] == 0
    )

    checks = {
        "원천_마스터_건수_일치": report["source_counts"]["total"] == report["master"]["count"],
        "마스터_스키마_검증": report["master"]["ok"],
        "사이트_카테고리_namespace_분리": report["categories"]["ok"],
        "Excel_열기_검증": report["xlsx"]["ok"],
        "필수시트_7개_존재": not report["xlsx"].get("required_sheets_missing"),
        "Excel_마스터_건수_일치": unified_rows == report["master"]["count"]
        if unified_rows is not None
        else False,
        "HTML_JSON_건수_일치": report["site_json"].get("count_match_master", False),
        "HTML_JSON_식별자_일치": report["site_json"].get("id_match_master", False),
    }
    report["checks"] = checks
    report["ok"] = all(checks.values())

    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(text, encoding="utf-8")
    print(text)
    print(f"\nRESULT={'PASS' if report['ok'] else 'FAIL'}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
