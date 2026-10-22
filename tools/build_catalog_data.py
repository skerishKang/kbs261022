#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_catalog_data.py -- CGI 상품 카탈로그 사이트용 데이터 정규화 빌더 (이슈 #11)

역할
    공급처 공개 수집 샘플(원시 JSON / CSV)을 사이트가 바로 consume 가능한
    단일 스키마로 정규화하고 `site/data/products.json` 과 `site/data/products.js` 를 만든다.

입력(기본값은 PR #13 / PR #12 브랜치에서 추출한 샘플)
    --master-csv   상품 마스터 스키마 CSV (PR #12, reports/samples/product_master_sample.csv)
    --sample-json  Model A 샘플 JSON      (PR #13, reports/sample-products.json)
    --categories   카테고리 카탈로그 CSV   (PR #12, reports/samples/category_catalog_sample.csv)

출력
    site/data/products.json   정규화 상품 배열 (사이트 로더가 ?data= 로 직접 읽을 수 있음)
    site/data/products.js     window.CGI_PRODUCTS / window.CGI_PRODUCT_META (file:// 동작용)

사용 예
    python tools/build_catalog_data.py
    python tools/build_catalog_data.py --master-csv path.csv --out-dir site/data
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

SITE_LABEL = {
    "samasound.co.kr": "삼아사운드",
    "samasound": "삼아사운드",
    "samamusic.co.kr": "삼아스토어",
    "samamusic": "삼아스토어",
}

# 사이트 라벨이 브랜드 칸에 들어온 데이터(삼아스토어/삼아사운드)는 브랜드가 아니다
SITE_LIKE_BRANDS = {"삼아스토어", "삼아사운드", "tri-a / 삼아사운드", "tri-b / 삼아스토어"}

# 공급처 공개 카탈로그 규모 (CGI 판매 가능 수량이 아님)
SUPPLIER_CATALOG_TOTALS = {
    "samasound.co.kr": {
        "count": 2229,
        "source": "PR #12 reports/samples/category_catalog_sample.csv (registered_count)",
    },
    "samamusic.co.kr": {
        "count": 1969,
        "source": "PR #12 reports/site-analysis-model-b.md (Dalue totalCount)",
    },
}


def is_site_like_brand(raw: str) -> bool:
    """사이트 이름이 브랜드 칸에 들어온 경우를 걸러낸다"""
    if not raw:
        return False
    value = re.sub(r"\s+", " ", str(raw)).strip().lower()
    if value in SITE_LIKE_BRANDS:
        return True
    return any(label in value for label in ("삼아사운드", "삼아스토어"))



def normalize_site(raw: str) -> str:
    """'samasound' / 'samamusic.co.kr' / 'Tri-A / 삼아사운드' -> 'samasound.co.kr'"""
    if not raw:
        return ""
    s = str(raw).strip().lower()
    for key, domain in (("samasound", "samasound.co.kr"), ("samamusic", "samamusic.co.kr")):
        if s.startswith(key):
            return domain
    return s

# 카테고리 경로에서 의미 없는 프레임워크 문자열
CATEGORY_NOISE = {
    "전체상품목록", "전체보기", "상품분류", "브랜드", "프로모션", "프로모션 보기",
    "상품분류[전체보기]", "special", "goods", "product", "category",
}

# 가격 문자열 -> (정수값 or None, 상태)
def parse_price(raw: str):
    """'40,000원' / '40000' / '가격 문의' / '' -> (value, state, text)"""
    if raw is None:
        return None, "unknown", "가격 미확인"
    text = str(raw).strip()
    if not text:
        return None, "unknown", "가격 미확인"
    if re.search(r"문의|미확인|별도문의", text):
        return None, "inquiry", "가격 문의"
    digits = re.sub(r"[^\d]", "", text)
    if not digits:
        return None, "unknown", "가격 미확인"
    return int(digits), "public", f"{int(digits):,}원"


def norm_brand(brand: str) -> str:
    if not brand:
        return ""
    return re.sub(r"\s+", " ", str(brand)).strip().upper()


def split_category(raw: str) -> list[str]:
    """'상품분류[전체보기] > 마이크> 무선마이크' / '마이크 | 브랜드> SHURE' -> ['마이크','무선마이크',...]"""
    if not raw:
        return []
    parts = re.split(r"[>|]", str(raw))
    out: list[str] = []
    for p in parts:
        seg = re.sub(r"\s+", " ", p).strip(" -·")
        if not seg:
            continue
        if seg.lower() in CATEGORY_NOISE or seg in CATEGORY_NOISE:
            continue
        if seg.startswith("상품분류[") and seg.endswith("]"):
            seg = "전체상품"
        if out and out[-1] == seg:
            continue
        out.append(seg)
    return out


def cate_no_from_url(url: str):
    if not url:
        return None
    m = re.search(r"cate_no=(\d+)", url)
    if m:
        return m.group(1)
    m = re.search(r"/category/(\d+)/", url)
    if m:
        return m.group(1)
    return None


def split_images(raw, site: str = "") -> list[str]:
    """JSON 배열 / '|' 구분 / 단일 URL 을 모두 처리하고 상대 경로는 절대 URL 로 만든다"""
    if not raw:
        return []
    if isinstance(raw, list):
        candidates = [str(i).strip() for i in raw if str(i).strip()]
    else:
        text = str(raw).strip()
        if not text:
            return []
        if text.startswith("["):
            parsed = parse_json_field(text, [])
            candidates = [str(i).strip() for i in parsed if str(i).strip()] if isinstance(parsed, list) else []
        else:
            candidates = [p.strip() for p in text.split("|") if p.strip()]
    out = []
    for url in candidates:
        if not url:
            continue
        if url.startswith("//"):
            url = "https:" + url
        elif url.startswith("/") and site:
            # 공급처 상대 경로(예: /web/upload/...)는 원본 도메인으로 절대화한다
            host = site if "." in site else ("www." + site + ".co.kr")
            url = "https://" + host + url
        elif not url.startswith("http"):
            continue
        out.append(url)
    return out


def parse_json_field(raw, default):
    if raw in (None, ""):
        return default
    if isinstance(raw, (list, dict)):
        return raw
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return default


def spec_rows_from(specs, evidence):
    """원본 스펙을 [{label, value}] 목록으로 정규화"""
    rows = []
    obj = parse_json_field(specs, {})
    if isinstance(obj, dict):
        for k, v in obj.items():
            if v in (None, ""):
                continue
            rows.append({"label": str(k).strip(), "value": str(v).strip()})
    if not rows:
        ev = parse_json_field(evidence, {})
        for r in (ev.get("spec_rows") or []):
            label = str(r.get("label", "")).strip()
            value = str(r.get("value", "")).strip()
            if label and value:
                rows.append({"label": label, "value": value})
    return rows


def build_index(categories_csv: Path) -> dict:
    """(source_site, category_id) -> 카테고리 정보"""
    index = {}
    if not categories_csv or not categories_csv.exists():
        return index
    with open(categories_csv, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            site = normalize_site(row.get("source_site"))
            cid = (row.get("category_id") or "").strip()
            if not site or not cid:
                continue
            try:
                count = int((row.get("registered_count") or "0").strip() or 0)
            except ValueError:
                count = 0
            index[(site, cid)] = {
                "id": cid,
                "name": (row.get("category_name") or "").strip(),
                "path": (row.get("category_path") or "").strip(),
                "level": (row.get("category_level") or "").strip(),
                "parent": (row.get("parent_category_id") or "").strip(),
                "registered_count": count,
                "list_url": (row.get("list_url") or "").strip(),
            }
    return index


def from_master_csv(path: Path, cat_index: dict) -> list[dict]:
    out = []
    if not path.exists():
        return out
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            site = normalize_site(row.get("source_site"))
            if not site:
                continue
            url = (row.get("canonical_url") or "").strip()
            list_url = (row.get("source_list_url") or "").strip()
            cid = cate_no_from_url(url) or cate_no_from_url(list_url) or (row.get("source_category_id") or "").strip()
            cat = cat_index.get((site, cid)) or {}
            price_value, price_state, price_text = parse_price(row.get("published_price_text") or row.get("published_price"))
            specs = spec_rows_from(row.get("specs"), row.get("source_evidence"))
            images = split_images(row.get("image_urls"), site)
            options = []
            summary = parse_json_field(row.get("option_summary"), {})
            if isinstance(summary, dict):
                for group in ("main", "addproduct_options", "addproducts", "add_option_data"):
                    for v in (summary.get(group) or []):
                        if not isinstance(v, dict):
                            continue
                        ov, _ost, otx = parse_price(v.get("price") or v.get("option_price"))
                        options.append({
                            "name": str(v.get("name") or v.get("option_name") or "").strip(),
                            "sku": str(v.get("sku") or v.get("option_id") or "").strip(),
                            "price": ov,
                            "price_text": otx,
                            "availability": str(v.get("availability") or "").strip(),
                            "group": group,
                        })
            cat_path = split_category(row.get("source_category_path") or cat.get("path", ""))
            raw_brand = (row.get("source_brand") or "").strip()
            brand = "" if is_site_like_brand(raw_brand) else raw_brand
            cat_name = (row.get("source_category_name") or "").strip() or cat.get("name", "")
            out.append({
                "id": f"{site}:{row.get('source_product_id','')}",
                "name": (row.get("product_name") or "").strip(),
                "brand": brand,
                "brand_raw": raw_brand,
                "brand_norm": norm_brand(brand),
                "manufacturer": (row.get("manufacturer") or "").strip(),
                "model": (row.get("model") or "").strip(),
                "category_path": cat_path,
                "category": {
                    "id": cid or "",
                    "name": cat_name,
                    "path": (row.get("source_category_path") or cat.get("path", "")).strip(),
                    "registered_count": cat.get("registered_count", 0),
                    "list_url": cat.get("list_url", "") or list_url,
                },
                "price": {"value": price_value, "text": price_text, "state": price_state},
                "availability": (row.get("availability_unverified") or "").strip(),
                "images": images,
                "specs": specs,
                "options": options,
                "source": {
                    "site": site,
                    "site_label": SITE_LABEL.get(site, site),
                    "product_id": (row.get("source_product_id") or "").strip(),
                    "url": url,
                    "list_url": list_url,
                    "extraction_method": (row.get("extraction_method") or "").strip(),
                    "verification_status": (row.get("verification_status") or "").strip(),
                    "updated_at": (row.get("updated_at") or "").strip(),
                },
            })
    return out


def from_sample_json(path: Path, cat_index: dict) -> list[dict]:
    out = []
    if not path.exists():
        return out
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    for row in data:
        site = normalize_site(row.get("source_site"))
        if not site:
            continue
        url = (row.get("canonical_url") or "").strip()
        ev = parse_json_field(row.get("source_evidence"), {})
        list_url = (ev.get("list_url") or "").strip()
        cid = cate_no_from_url(url) or cate_no_from_url(list_url)
        cat = cat_index.get((site, cid)) or {}
        price_value, price_state, price_text = parse_price(row.get("published_price"))
        specs = spec_rows_from(row.get("specs"), row.get("source_evidence"))
        images = split_images(row.get("image_urls"), site)
        options = []
        for v in (ev.get("variants") or []):
            ov, _ost, otx = parse_price(v.get("price"))
            options.append({
                "name": str(v.get("name", "")).strip(),
                "sku": str(v.get("sku", "")).strip(),
                "price": ov,
                "price_text": otx,
                "availability": str(v.get("availability", "")).strip(),
                "group": "variants",
            })
        cat_path = split_category(row.get("source_category"))
        raw_brand = (row.get("brand") or "").strip()
        brand = "" if is_site_like_brand(raw_brand) else raw_brand
        out.append({
            "id": f"{site}:{row.get('source_product_id','')}",
            "name": (row.get("product_name") or "").strip(),
            "brand": brand,
            "brand_raw": raw_brand,
            "brand_norm": norm_brand(brand),
            "manufacturer": _manufacturer_from_specs(specs),
            "model": (row.get("model") or "").strip(),
            "category_path": cat_path,
            "category": {
                "id": cid or "",
                "name": cat.get("name", ""),
                "path": cat.get("path", ""),
                "registered_count": cat.get("registered_count", 0),
                "list_url": cat.get("list_url", "") or list_url,
            },
            "price": {"value": price_value, "text": price_text, "state": price_state},
            "availability": (row.get("availability_unverified") or "").strip(),
            "images": images,
            "specs": specs,
            "options": options,
            "source": {
                "site": site,
                "site_label": SITE_LABEL.get(site, site),
                "product_id": (row.get("source_product_id") or "").strip(),
                "url": url,
                "list_url": list_url,
                "extraction_method": (row.get("extraction_method") or "").strip(),
                "verification_status": (row.get("verification_status") or "").strip(),
                "updated_at": (row.get("updated_at") or "").strip(),
            },
        })
    return out


def _manufacturer_from_specs(specs):
    for row in specs:
        if row["label"] in ("제조사", " 제조사"):
            return row["value"]
    return ""


def dedupe(items: list[dict]) -> list[dict]:
    seen = {}
    for item in items:
        seen.setdefault(item["id"], item)
    return list(seen.values())


def main() -> int:
    ap = argparse.ArgumentParser(description="CGI 카탈로그 사이트 데이터 정규화 빌더")
    root = Path(__file__).resolve().parents[1]
    ap.add_argument("--master-csv", default=str(root / "site/data/_source_product_master_sample.csv"))
    ap.add_argument("--sample-json", default=str(root / "site/data/_source_sample-products.json"))
    ap.add_argument("--categories", default=str(root / "site/data/_source_category_catalog.csv"))
    ap.add_argument("--out-dir", default=str(root / "site/data"))
    args = ap.parse_args()

    cat_index = build_index(Path(args.categories))
    products = dedupe(
        from_master_csv(Path(args.master_csv), cat_index)
        + from_sample_json(Path(args.sample_json), cat_index)
    )
    for p in products:
        if not p["brand_norm"]:
            p["brand_norm"] = norm_brand(p["brand"])
        if not p["name"]:
            p["name"] = p["model"] or p["id"]

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    brands = sorted({p["brand_norm"] for p in products if p["brand_norm"]})
    sites = sorted({p["source"]["site"] for p in products})
    # 공급처 카탈로그 규모: 카테고리 카탈로그 실측값 우선, 없으면 출처 명시된 고정값
    supplier_totals = {}
    for (site, _cid), info in cat_index.items():
        if not info["registered_count"]:
            continue
        current = supplier_totals.get(site)
        # 공급처 카탈로그 규모는 해당 사이트의 최상위(=최대) 등록 건수를 사용한다
        if not current or info["registered_count"] > current["count"]:
            supplier_totals[site] = {
                "count": info["registered_count"],
                "source": "PR #12 reports/samples/category_catalog_sample.csv (registered_count, 최상위 카테고리)",
            }
    for site, info in SUPPLIER_CATALOG_TOTALS.items():
        if site not in supplier_totals:
            supplier_totals[site] = dict(info)

    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "product_count": len(products),
        "brands": brands,
        "sources": sites,
        "source_labels": {s: SITE_LABEL.get(s, s) for s in sites},
        "supplier_catalog_totals": supplier_totals,
        "data_origin": [
            "PR #13 (branch feature/issue-5-site-analysis-model-a) reports/sample-products.json",
            "PR #12 (branch feature/site-analysis-model-b) reports/samples/product_master_sample.csv",
            "PR #12 (branch feature/site-analysis-model-b) reports/samples/category_catalog_sample.csv",
        ],
        "notes": [
            "공개 수집 샘플만 포함. 허위 상품/가격/재고 없음.",
            "published_price 는 공급처 공개 판매가만 표기. 미공개는 '가격 문의'.",
            "supplier_catalog_totals 는 공급처 카탈로그 규모이며 CGI 판매 가능 수량이 아니다.",
        ],
    }

    (out_dir / "products.json").write_text(
        json.dumps(products, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    js = (
        "/* CGI 상품 카탈로그 데이터 (자동 생성: tools/build_catalog_data.py)\n"
        "   출처: PR #13 / PR #12 공개 수집 샘플. 재생성 방법과 전체 카탈로그 교체 절차는\n"
        "   docs/CGI_CATALOG_SITE.md 참고. */\n"
        "window.CGI_PRODUCTS = " + json.dumps(products, ensure_ascii=False, indent=1) + ";\n"
        "window.CGI_PRODUCT_META = " + json.dumps(meta, ensure_ascii=False, indent=1) + ";\n"
    )
    (out_dir / "products.js").write_text(js, encoding="utf-8")

    print(f"[build_catalog_data] products={len(products)} brands={len(brands)} sources={sites}")
    print(f"[build_catalog_data] wrote {out_dir / 'products.json'}")
    print(f"[build_catalog_data] wrote {out_dir / 'products.js'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())


