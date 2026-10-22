#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_product_db.py -- 이슈 #19 상품 DB(엑셀/JSON) 생성기

입력: run_full_collection.py 가 만든 수집 결과
      list_products.json (사이트별 상품 목록), {site}_detail.json (상세)

출력(시트/파일)
    통합상품            source_product 단위 통합 행 (master_product_key 포함)
    공급처원본          공급처별 원천 레코드(원본 ID·목록 URL·수집 근거 보존)
    옵션SKU            옵션/추가구성 1행 1옵션 (option_name·option_price)
    브랜드·카테고리     브랜드 × 카테고리 집계
    중복후보            master key 동일/유사 후보
    누락·검증현황       필드별 미확인·검증 상태
    향후 네이버·이카운트 매핑  매핑 준비 상태(확정값 아님)
    product_db.xlsx     위 시트를 담은 통합 엑셀
    catalog.full.json   쇼핑몰(#11) 데이터 계약에 맞춘 전체 카탈로그 JSON
    catalog_products.csv / product_db.csv  평문 CSV

원칙
  * 원천 레코드는 모두 보존한다(중복 후보는 별도 시트로만 관리).
  * 확인하지 못한 값은 빈 값/NULL 로 둔다(추정 금지).
  * 가격은 공개 표기만. 공급가·재고·CGI 판매가는 unconfirmed 로 둔다.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

SITE_LABEL = {"samasound": "삼아사운드", "samamusic": "삼아스토어"}
SITE_HOST = {"samasound": "samasound.co.kr", "samamusic": "samamusic.co.kr"}


# ------------------------------------------------------------------ 정규화 유틸
def norm_text(value: Any) -> str:
    if value is None:
        return ""
    s = unicodedata.normalize("NFKC", str(value)).upper()
    s = re.sub(r"[^0-9A-Z가-힣]+", "", s)
    return s


def norm_brand(value: Any) -> str:
    if not value:
        return ""
    s = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value))).strip()
    return s.upper()


def parse_json_maybe(raw: Any, default: Any):
    if raw in (None, ""):
        return default
    if isinstance(raw, (list, dict)):
        return raw
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return default


def clean_price_state(rec: dict) -> str:
    state = (rec.get("published_price_state") or "").strip().lower()
    price = rec.get("published_price")
    text = (rec.get("published_price_text") or "").strip()
    if state in ("public", "inquiry_price", "missing", "sold_out_sale_completed"):
        return state
    if text in ("판매 완료", "판매완료", "판매 불료"):
        return "sold_out_sale_completed"
    if "문의" in text:
        return "inquiry_price"
    if price not in (None, ""):
        try:
            if int(price) > 0:
                return "public"
        except (TypeError, ValueError):
            pass
    return "missing"


def price_value(rec: dict) -> Optional[int]:
    raw = rec.get("published_price")
    if raw in (None, ""):
        return None
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def sales_status(rec: dict, price_state: str) -> str:
    """판매 상태. 공개 표기(stock/soldout/판매완료)만 근거로 하며 추정하지 않는다."""
    if price_state == "sold_out_sale_completed":
        return "판매완료"
    flags = " ".join(str(rec.get(k) or "") for k in
                     ("soldout_display", "stock_display", "product_status_flags"))
    if "판매 완료" in flags or "판매완료" in flags:
        return "판매완료"
    av = parse_json_maybe(rec.get("availability_unverified"), {})
    if not isinstance(av, dict):
        av = {}
    use_stock = av.get("use_stock")
    use_soldout = str(av.get("use_soldout") or "").upper()
    stock_displayed = av.get("stock_number_displayed")
    if "soldout" in flags.lower() or use_soldout == "T" and str(stock_displayed) == "0":
        return "품절(판매중지)"
    if use_stock is False:
        return "재고미관리"
    if use_stock is True:
        return "판매중"
    return "미확인"


def master_key(rec: dict) -> Tuple[str, str]:
    """통합 상품 후보 키. 모델이 있으면 brand|model, 없으면 brand|상품명(정규화)."""
    brand = norm_brand(rec.get("brand"))
    model = norm_text(rec.get("model"))
    name = norm_text(rec.get("product_name"))
    if brand and model and len(model) >= 3:
        return f"{brand}|{model}", "brand+model"
    if brand and name:
        return f"{brand}|{name}", "brand+name"
    if name:
        return f"|{name}", "name"
    return f"|{rec.get('source_product_id','')}", "fallback_id"


# ------------------------------------------------------------------ 옵션 파싱
def parse_images(raw: Any) -> List[str]:
    """수집 원본의 image_urls 는 JSON 배열 또는 '|' 구분 문자열이다."""
    if not raw:
        return []
    if isinstance(raw, list):
        return [str(i).strip() for i in raw if str(i).strip()]
    text = str(raw).strip()
    if not text:
        return []
    if text.startswith("["):
        parsed = parse_json_maybe(text, [])
        if isinstance(parsed, list):
            return [str(i).strip() for i in parsed if str(i).strip()]
    return [p.strip() for p in text.split("|") if p.strip()]


def options_of(rec: dict) -> Tuple[List[dict], List[dict]]:
    """옵션 그룹과 번들(추가구성) 목록을 정규화.

    원본 option_summary 구조: {"main": [...], "addproduct_options": [...],
    "addproducts": [...], "add_option_data": [...]} — addproducts 는 옵션이 아니라 구성상품.
    """
    summary = rec.get("option_summary")
    if isinstance(summary, str):
        summary = parse_json_maybe(summary, {})
    if not isinstance(summary, dict):
        summary = {}
    evidence = rec.get("source_evidence")
    if isinstance(evidence, str):
        evidence = parse_json_maybe(evidence, {})
    if not isinstance(evidence, dict):
        evidence = {}

    def opt_value(v: dict) -> dict:
        add = v.get("option_price") or v.get("origin_option_added_price") or v.get("price")
        try:
            add_i = int(str(add).strip()) if add not in (None, "") else None
        except (TypeError, ValueError):
            add_i = None
        return {
            "label": str(v.get("name") or v.get("option_name") or v.get("label") or "").strip(),
            "add_price": add_i,
            "sold_out": bool(v.get("soldout") or v.get("is_soldout") or v.get("sold_out")),
            "item_code": str(v.get("item_code") or v.get("sku") or "").strip() or None,
        }

    options: List[dict] = []
    for group in ("main", "addproduct_options", "add_option_data"):
        values = summary.get(group)
        if not isinstance(values, list) or not values:
            continue
        vals = [opt_value(v) for v in values if isinstance(v, dict)]
        vals = [v for v in vals if v["label"] or v["add_price"] is not None]
        if vals:
            options.append({
                "name": group,
                "option_type": "select",
                "values": vals,
                "item_codes": [v["item_code"] for v in vals if v["item_code"]],
                "values_uncertain": False,
            })

    if not options:
        variants = evidence.get("variants") or []
        vals = [opt_value(v) for v in variants if isinstance(v, dict)]
        vals = [v for v in vals if v["label"]]
        if vals:
            options.append({"name": "variants", "option_type": "select", "values": vals,
                            "item_codes": [v["item_code"] for v in vals if v["item_code"]],
                            "values_uncertain": False})

    bundles: List[dict] = []
    for b in (summary.get("addproducts") or []):
        if isinstance(b, dict):
            bundles.append({
                "name": str(b.get("name") or "").strip(),
                "price_text": str(b.get("price_text") or b.get("price") or "").strip(),
                "sold_out": bool(b.get("soldout") or b.get("sold_out")),
            })
    return options, bundles


# ------------------------------------------------------------------ 메인 빌드
def build(data_dir: Path, out_dir: Path) -> Dict[str, Any]:
    lists = json.loads((data_dir / "list_products.json").read_text(encoding="utf-8"))
    details: Dict[str, List[dict]] = {}
    for site in ("samasound", "samamusic"):
        p = data_dir / f"{site}_detail.json"
        details[site] = json.loads(p.read_text(encoding="utf-8")) if p.exists() else []

    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    unified: List[dict] = []
    source_rows: List[dict] = []
    option_rows: List[dict] = []

    for site in ("samasound", "samamusic"):
        list_items = lists.get(site, {})
        detail_by_id = {str(d.get("source_product_id")): d for d in details.get(site, [])}
        for pid, meta in list_items.items():
            det = detail_by_id.get(str(pid), {})
            rec = dict(det)
            if not rec:
                # 상세 미확보 → 목록에서 확보 가능한 최소 정보만 유지
                rec = {
                    "source_site": site,
                    "source_product_id": str(pid),
                    "product_name": meta.get("name", ""),
                    "canonical_url": meta.get("list_url", ""),
                    "source_list_url": meta.get("list_page_url", ""),
                    "image_urls": json.dumps([meta["image"]] if meta.get("image") else [], ensure_ascii=False),
                    "published_price": meta.get("list_price", ""),
                    "verification_status": "unverified",
                    "extraction_method": "list-only",
                }
            specs = parse_json_maybe(rec.get("specs"), {})
            if not isinstance(specs, dict):
                specs = {}
            images = parse_images(rec.get("image_urls"))
            options, bundles = options_of(rec)
            state = clean_price_state(rec)
            pvalue = price_value(rec)
            mkey, mkey_basis = master_key(rec)
            category_path = rec.get("source_category_path") or ""
            cat_id = rec.get("source_category_id") or ""
            cat_name = rec.get("source_category_name") or ""
            status = sales_status(rec, state)
            verification = (rec.get("verification_status") or "").strip() or (
                "http_verified" if det else "unverified")
            option_names = "; ".join(
                f"{o['name']}:{v['label']}" for o in options for v in o["values"] if v.get("label"))
            option_prices = "; ".join(
                str(v["add_price"]) for o in options for v in o["values"] if v.get("add_price") is not None)

            unified.append({
                "master_product_key": mkey,
                "master_key_basis": mkey_basis,
                "source_site": site,
                "source_site_label": SITE_LABEL.get(site, site),
                "source_product_id": str(pid),
                "source_key": f"{site}:{pid}",
                "product_name": rec.get("product_name", "") or meta.get("name", ""),
                "brand": rec.get("source_brand", "") or rec.get("brand", ""),
                "brand_norm": norm_brand(rec.get("source_brand", "") or rec.get("brand", "")),
                "manufacturer": rec.get("manufacturer", ""),
                "model": rec.get("model", ""),
                "category_id": cat_id,
                "category_name": cat_name,
                "category_path": category_path,
                "category_namespace": f"{site}.cate_no",
                "specifications": json.dumps(specs, ensure_ascii=False),
                "spec_field_count": len(specs),
                "option_name": option_names,
                "option_price": option_prices,
                "option_group_count": len(options),
                "option_value_count": sum(len(o["values"]) for o in options),
                "bundled_item_count": len(bundles),
                "image_urls": json.dumps(images, ensure_ascii=False),
                "image_count": len(images),
                "public_price": pvalue if pvalue is not None else "",
                "public_price_text": rec.get("published_price_text", "") or (
                    f"{pvalue:,}원" if pvalue else ""),
                "public_price_state": state,
                "sales_status": status,
                "availability": rec.get("availability_unverified", "") or rec.get("stock_display", ""),
                "source_url": rec.get("canonical_url", "") or meta.get("list_url", ""),
                "source_list_url": rec.get("source_list_url", "") or meta.get("list_page_url", ""),
                "collected_at": rec.get("updated_at", "") or now,
                "verification_status": verification,
                "extraction_method": rec.get("extraction_method", "") or "list-only",
                "product_code": rec.get("product_code", "") or meta.get("product_code", ""),
                "item_code": rec.get("source_item_code", ""),
                "summary": rec.get("summary", "") or rec.get("short_description", ""),
                "country_of_origin": rec.get("country_of_origin", ""),
                "cgi_sale_status": "unapproved",
                "cgi_dealer_price": "",
                "cgi_stock": "",
                "naver_smartstore_mapping_ready": "false",
            })
            source_rows.append({
                "source_site": site,
                "source_site_label": SITE_LABEL.get(site, site),
                "source_product_id": str(pid),
                "source_category_id": cat_id,
                "source_category_name": cat_name,
                "source_category_path": category_path,
                "source_brand": rec.get("source_brand", "") or rec.get("brand", ""),
                "source_item_code": rec.get("source_item_code", ""),
                "product_code": rec.get("product_code", "") or meta.get("product_code", ""),
                "product_name": rec.get("product_name", "") or meta.get("name", ""),
                "list_page_url": meta.get("list_page_url", ""),
                "list_price": meta.get("list_price", ""),
                "canonical_url": rec.get("canonical_url", "") or meta.get("list_url", ""),
                "detail_collected": "Y" if det else "N",
                "extraction_method": rec.get("extraction_method", "") or "list-only",
                "verification_status": verification,
                "source_evidence": rec.get("source_evidence", ""),
            })
            for o in options:
                for v in o["values"]:
                    option_rows.append({
                        "source_key": f"{site}:{pid}",
                        "source_site": site,
                        "source_product_id": str(pid),
                        "product_name": rec.get("product_name", "") or meta.get("name", ""),
                        "option_group": o["name"],
                        "option_name": v.get("label", ""),
                        "option_price": v.get("add_price") if v.get("add_price") is not None else "",
                        "option_sold_out": "Y" if v.get("sold_out") else "N",
                        "option_item_code": v.get("item_code") or "",
                    })
            for b in bundles:
                option_rows.append({
                    "source_key": f"{site}:{pid}",
                    "source_site": site,
                    "source_product_id": str(pid),
                    "product_name": rec.get("product_name", "") or meta.get("name", ""),
                    "option_group": "추가구성",
                    "option_name": b.get("name", ""),
                    "option_price": b.get("price_text", ""),
                    "option_sold_out": "Y" if b.get("sold_out") else "N",
                    "option_item_code": "",
                })

    # ---- 중복 후보 ---------------------------------------------------------
    groups: Dict[str, List[dict]] = defaultdict(list)
    for row in unified:
        groups[row["master_product_key"]].append(row)
    dup_rows: List[dict] = []
    for key, rows in groups.items():
        if len(rows) < 2:
            continue
        sites = {r["source_site"] for r in rows}
        confidence = "high" if (key and rows[0]["master_key_basis"] == "brand+model") else "medium"
        for r in rows:
            dup_rows.append({
                "master_product_key": key,
                "master_key_basis": rows[0]["master_key_basis"],
                "confidence": confidence,
                "group_size": len(rows),
                "cross_site": "Y" if len(sites) > 1 else "N",
                "source_key": r["source_key"],
                "source_site": r["source_site"],
                "source_product_id": r["source_product_id"],
                "product_name": r["product_name"],
                "brand": r["brand"],
                "model": r["model"],
                "public_price": r["public_price"],
                "public_price_state": r["public_price_state"],
                "note": "동일 master key. 자동 병합하지 않음(확인 필요).",
            })

    # ---- 브랜드 × 카테고리 -------------------------------------------------
    bc: Dict[Tuple[str, str, str], int] = Counter()
    for r in unified:
        bc[(r["source_site"], r["brand_norm"] or "(브랜드 미확인)", r["category_name"] or r["category_id"] or "(미분류)")] += 1
    brand_cat_rows = [
        {"source_site": k[0], "brand": k[1], "category": k[2], "product_count": v}
        for k, v in sorted(bc.items())
    ]

    # ---- 누락 · 검증 현황 --------------------------------------------------
    check_fields = ["product_name", "brand", "model", "manufacturer", "canonical_url",
                    "public_price", "image_urls", "specifications", "category_name"]
    gap_rows = []
    for r in unified:
        missing = []
        for f in check_fields:
            val = r.get(f)
            if f == "public_price":
                if r["public_price_state"] != "public":
                    missing.append("public_price(공개가 아님)")
                continue
            if f == "image_urls":
                if not parse_json_maybe(val, []):
                    missing.append("image_urls(없음)")
                continue
            if f == "specifications":
                if not parse_json_maybe(val, {}):
                    missing.append("specifications(없음)")
                continue
            if not val:
                missing.append(f + "(없음)")
        gap_rows.append({
            "source_key": r["source_key"],
            "source_site": r["source_site"],
            "source_product_id": r["source_product_id"],
            "product_name": r["product_name"],
            "verification_status": r["verification_status"],
            "detail_collected": "Y" if r["extraction_method"] != "list-only" else "N",
            "missing_fields": "; ".join(missing) if missing else "(없음)",
            "missing_count": len(missing),
            "public_price_state": r["public_price_state"],
            "sales_status": r["sales_status"],
            "image_count": r["image_count"],
            "option_value_count": r["option_value_count"],
        })

    # ---- 향후 네이버·이카운트 매핑 -----------------------------------------
    map_rows = []
    for r in unified:
        map_rows.append({
            "source_key": r["source_key"],
            "product_name": r["product_name"],
            "brand": r["brand"],
            "model": r["model"],
            "smartstore_category_no": "",      # 네이버 표준 카테고리 ID 미확보
            "naver_product_id": "",
            "erp_item_code": r["item_code"],
            "erp_product_code": r["product_code"],
            "image_count": r["image_count"],
            "public_price": r["public_price"],
            "public_price_state": r["public_price_state"],
            "cgi_sale_status": r["cgi_sale_status"],
            "cgi_dealer_price": "",
            "cgi_stock": "",
            "mapping_ready": "false",
            "note": "카테고리 ID·CGI 판매가·공급가 미확정. 매핑 확정 전까지 등록 금지.",
        })

    out_dir.mkdir(parents=True, exist_ok=True)
    stats = {
        "generated_at": now,
        "source_products": {s: sum(1 for r in unified if r["source_site"] == s) for s in ("samasound", "samamusic")},
        "total_source_products": len(unified),
        "unique_master_keys": len(groups),
        "duplicate_candidate_rows": len(dup_rows),
        "duplicate_groups": sum(1 for k, v in groups.items() if len(v) > 1),
        "option_sku_rows": len(option_rows),
        "products_with_options": sum(1 for r in unified if r["option_value_count"]),
        "products_with_images": sum(1 for r in unified if r["image_count"]),
        "products_with_public_price": sum(1 for r in unified if r["public_price_state"] == "public"),
        "products_inquiry_price": sum(1 for r in unified if r["public_price_state"] == "inquiry_price"),
        "products_sold_out_state": sum(1 for r in unified if r["public_price_state"] == "sold_out_sale_completed"),
        "sales_status_distribution": dict(Counter(r["sales_status"] for r in unified)),
        "price_state_distribution": dict(Counter(r["public_price_state"] for r in unified)),
        "detail_collected": sum(1 for r in unified if r["extraction_method"] != "list-only"),
        "distinct_brands": len({r["brand_norm"] for r in unified if r["brand_norm"]}),
        "distinct_categories": len({(r["source_site"], r["category_id"]) for r in unified if r["category_id"]}),
    }
    return {
        "unified": unified, "source": source_rows, "options": option_rows,
        "dup": dup_rows, "brand_cat": brand_cat_rows, "gap": gap_rows, "map": map_rows,
        "stats": stats,
    }


def write_csv(path: Path, rows: List[dict]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fields = list(rows[0].keys())
    with open(path, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)


def build_catalog_json(data: Dict[str, Any], lists: Dict[str, Any]) -> Dict[str, Any]:
    """#11 쇼핑몰 데이터 계약(catalog.schema.json v1.0)에 맞춘 전체 카탈로그."""
    products = []
    for r in data["unified"]:
        specs = parse_json_maybe(r["specifications"], {})
        images = parse_json_maybe(r["image_urls"], [])
        products.append({
            "id": r["source_key"],
            "source_site": SITE_HOST.get(r["source_site"], r["source_site"]),
            "source_site_label": r["source_site_label"],
            "source_product_id": r["source_product_id"],
            "source_category_id": r["category_id"],
            "source_category_path": r["category_path"],
            "brand": r["brand"],
            "model": r["model"],
            "product_name": r["product_name"],
            "summary": r["summary"],
            "manufacturer": r["manufacturer"],
            "country_of_origin": r["country_of_origin"],
            "canonical_url": r["source_url"],
            "source_list_url": r["source_list_url"],
            "specs": specs,
            "options": [],
            "bundled_items": [],
            "image_urls": images,
            "image": images[0] if images else "",
            "published_price": r["public_price"] if r["public_price"] != "" else None,
            "published_price_text": r["public_price_text"],
            "published_price_state": r["public_price_state"],
            "availability": r["availability"],
            "review_count": "",
            "extraction_method": r["extraction_method"],
            "verification_status": r["verification_status"],
            "source_evidence": r["source_list_url"],
            "updated_at": r["collected_at"],
            "cgi_sale_status": r["cgi_sale_status"],
            "cgi_sale_note": "전체 수집 상품이며 CGI 판매 승인 상품이 아님",
            "cgi_dealer_price": None,
            "cgi_dealer_price_state": "unconfirmed",
            "cgi_stock": None,
            "cgi_stock_state": "unconfirmed",
            "naver_smartstore_mapping": {
                "ready": False,
                "product_name": r["product_name"],
                "category_id": None,
                "option_type": None,
                "price": r["public_price"] if r["public_price"] != "" else None,
                "stock": None,
                "image_urls": images,
                "memo": "공급처 공개 정보 기반 초안. 네이버 카테고리 ID·CGI 판매가 미확정.",
            },
        })
    cats = Counter()
    cat_names: Dict[str, str] = {}
    for r in data["unified"]:
        cid = r["category_id"] or "0"
        cats[cid] += 1
        cat_names[cid] = r["category_name"] or r["category_path"] or "미분류"
    brands = Counter(r["brand"] for r in data["unified"] if r["brand"])
    return {
        "meta": {
            "schema_version": "1.0",
            "catalog_id": "cgi-full-catalog",
            "generated_at": data["stats"]["generated_at"],
            "generated_by": "CGI-1 LOCAL 에이전트 (이슈 #19 전수 수집)",
            "data_basis": [
                "PR #12 skills/cgi-catalog-collector (수집 파서 재사용)",
                "PR #13 / PR #12 공개 수집 샘플",
                "2026-10-22 전수 수집(list 2사이트 + 상세)",
            ],
            "site_name": "CGI 상품 카탈로그",
            "site_owner": "CGI",
            "disclaimer": [
                "공급처 공개 수집 데이터이며 CGI 판매 가능 수량이 아닙니다.",
                "가격은 공급처 공개 판매가 기준이며 변동될 수 있습니다.",
                "공급가·재고·네이버 카테고리 ID는 미확정입니다.",
            ],
            "brand_statement": "CGI 독자 브랜드. 삼아스토어·삼아사운드 등 원본 상표·화면을 복제하지 않았으며 공식 사이트가 아닙니다.",
        },
        "categories": [{"id": cid, "name": cat_names.get(cid, cid), "product_count": n}
                       for cid, n in sorted(cats.items(), key=lambda kv: -kv[1])],
        "brands": [{"name": b, "count": n} for b, n in sorted(brands.items(), key=lambda kv: (-kv[1], kv[0]))],
        "products": products,
    }


def write_xlsx(path: Path, sheets: List[Tuple[str, List[dict]]]) -> None:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment

    wb = Workbook()
    wb.remove(wb.active)
    head_font = Font(bold=True, color="FFFFFF")
    head_fill = PatternFill("solid", fgColor="1F3A93")
    for name, rows in sheets:
        ws = wb.create_sheet(title=name[:31])
        if not rows:
            ws.append(["(데이터 없음)"])
            continue
        fields = list(rows[0].keys())
        ws.append(fields)
        for c in ws[1]:
            c.font = head_font
            c.fill = head_fill
            c.alignment = Alignment(vertical="center")
        for r in rows:
            ws.append([r.get(f, "") for f in fields])
        ws.freeze_panes = "A2"
        for i, f in enumerate(fields, start=1):
            width = max(len(str(f)) + 2, 12)
            ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = min(width, 46)
    wb.save(path)


def main() -> int:
    ap = argparse.ArgumentParser(description="CGI 전체 상품 DB 빌더 (이슈 #19)")
    ap.add_argument("--data-dir", default="C:/cgi-work/catalog-data")
    ap.add_argument("--out-dir", default="data/full_catalog")
    ap.add_argument("--xlsx", default="C:/cgi-work/catalog-data/product_db.xlsx")
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    out_dir = Path(args.out_dir)
    data = build(data_dir, out_dir)

    write_csv(out_dir / "통합상품.csv", data["unified"])
    write_csv(out_dir / "공급처원본.csv", data["source"])
    write_csv(out_dir / "옵션SKU.csv", data["options"])
    write_csv(out_dir / "브랜드_카테고리.csv", data["brand_cat"])
    write_csv(out_dir / "중복후보.csv", data["dup"])
    write_csv(out_dir / "누락_검증현황.csv", data["gap"])
    write_csv(out_dir / "향후_네이버_이카운트_매핑.csv", data["map"])

    lists = json.loads((data_dir / "list_products.json").read_text(encoding="utf-8"))
    catalog = build_catalog_json(data, lists)
    (out_dir / "catalog.full.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=1), encoding="utf-8")

    # 경량 내보내기: GitHub 공개 저장소에 올릴 수 있는 크기의 핵심 필드만
    compact_fields = ["master_product_key", "source_site", "source_site_label", "source_product_id",
                      "product_name", "brand", "manufacturer", "model", "category_id", "category_name",
                      "public_price", "public_price_text", "public_price_state", "sales_status",
                      "image_count", "option_value_count", "availability", "source_url",
                      "collected_at", "verification_status", "cgi_sale_status"]
    write_csv(out_dir / "product_db_compact.csv",
              [{k: r.get(k, "") for k in compact_fields} for r in data["unified"]])
    # 옵션 요약(상품 1행 1옵션) 경량판
    write_csv(out_dir / "options_compact.csv", data["options"])

    # 쇼핑몰(#11) 로더 호환 형식: site/assets/js/cgi-catalog.js 가 읽는 window.CGI_PRODUCTS 배열
    site_rows = []
    for r in data["unified"]:
        specs = parse_json_maybe(r["specifications"], {})
        images = parse_json_maybe(r["image_urls"], [])
        price_value = r["public_price"] if r["public_price"] != "" else None
        site_rows.append({
            "id": r["source_key"],
            "name": r["product_name"],
            "brand": r["brand"],
            "brand_norm": r["brand_norm"],
            "manufacturer": r["manufacturer"],
            "model": r["model"],
            "category_path": [s for s in (r["category_path"] or "").split(">") if s.strip()],
            "category": {"id": r["category_id"], "name": r["category_name"],
                         "path": r["category_path"], "registered_count": 0, "list_url": ""},
            "price": {"value": price_value, "text": r["public_price_text"], "state": r["public_price_state"]},
            "availability": r["availability"],
            "images": images,
            "specs": specs if isinstance(specs, dict) else {},
            "options": [],
            "source": {
                "site": SITE_HOST.get(r["source_site"], r["source_site"]),
                "site_label": r["source_site_label"],
                "product_id": r["source_product_id"],
                "url": r["source_url"],
                "list_url": r["source_list_url"],
                "extraction_method": r["extraction_method"],
                "verification_status": r["verification_status"],
                "updated_at": r["collected_at"],
            },
            "master_product_key": r["master_product_key"],
            "cgi_sale_status": r["cgi_sale_status"],
        })
    (out_dir / "products.full.json").write_text(
        json.dumps(site_rows, ensure_ascii=False, indent=1), encoding="utf-8")
    (out_dir / "products.full.js").write_text(
        "/* 전체 상품 카탈로그(4,575건) — 자동 생성: tools/full_catalog/build_product_db.py\n"
        "   site/data/products.js 를 이 파일로 교체하면 쇼핑몰이 전체 상품을 표시한다. */\n"
        "window.CGI_PRODUCTS = " + json.dumps(site_rows, ensure_ascii=False, indent=1) + ";\n",
        encoding="utf-8")

    write_xlsx(Path(args.xlsx), [
        ("통합상품", data["unified"]),
        ("공급처원본", data["source"]),
        ("옵션SKU", data["options"]),
        ("브랜드_카테고리", data["brand_cat"]),
        ("중복후보", data["dup"]),
        ("누락_검증현황", data["gap"]),
        ("향후네이버이카운트매핑", data["map"]),
    ])

    stats = data["stats"]
    (out_dir / "collection_stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(stats, ensure_ascii=False, indent=1))
    xlsx = Path(args.xlsx)
    if xlsx.exists():
        stats["xlsx_path"] = str(xlsx)
        stats["xlsx_sha256"] = hashlib.sha256(xlsx.read_bytes()).hexdigest()
        stats["xlsx_bytes"] = xlsx.stat().st_size
    (out_dir / "collection_stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"xlsx -> {xlsx} ({stats.get('xlsx_bytes')} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
