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


# 브랜드 별칭·비브랜드 값 정리 (#213 D4)
# - 같은 브랜드의 다른 표기는 대표 표기(풀네임)로 합친다.
# - 브랜드가 아닌 값(자체제작·브랜드 미확인·안전사·자체브랜드)은 "기타" 하나로 묶어
#   브랜드 필터 맨 아래에 둔다(화면의 기타 후순 정렬과 짝을 이룬다).
BRAND_ALIASES = {
    "K&M": "KÖNIG & MEYER",
    "AGS": "ACOUSTIC GROVE SYSTEM",
    "TUTTLE GUITARS": "MICHAEL TUTTLE GUITARS",
}
NON_BRAND_VALUES = {"자체제작", "브랜드 미확인", "안전사", "자체브랜드"}
OTHER_BRAND_LABEL = "기타"


def canonical_brand(brand: str) -> str:
    """brand_norm 을 화면·필터에 쓸 대표 브랜드 이름으로 정규화한다."""
    b = norm_brand(brand)
    if not b:
        return ""
    if b in NON_BRAND_VALUES:
        return OTHER_BRAND_LABEL
    return BRAND_ALIASES.get(b, b)


# 상품이 아닌 항목(#216 G1): 공급처의 개별 결제용 페이지가 상품으로 올라오는 것을
# 빌드 단계에서 제외한다. 상품명에 결제창·잔금·계약금 이 들어간 건 전부 해당된다.
NON_PRODUCT_RE = re.compile(r"결제창|잔금|계약금")


# 검색에서 뺄 공급처 구매 옵션 라벨 (#216 G4)
SEARCH_NOISE_SPEC_LABELS = {"구매방법", "배송주기"}


def is_non_product(product: dict) -> bool:
    """결제창·잔금·계약금 페이지는 상품이 아니므로 카탈로그에서 뺀다 (#216 G1)."""
    name = str(product.get("name") or "")
    return bool(NON_PRODUCT_RE.search(name))


# 화면용 상품명 정리 (#209 A5): 공급처 문구 접두사([..])와 SCM 코드는 화면에서만 제거하고
# 원본 products.json 의 name 은 그대로 둔다. 상품 상태 태그([리퍼비쉬] 등)는 사이트가
# 배지로 분리해 보여 주므로 접두사에 남겨 둔다.
CONDITION_DISPLAY_TAGS = {
    "박스손상", "리퍼비쉬", "전시상품", "전시제품", "전시/단종 클리어런스",
    "단순개봉", "교환상품", "미세흠집", "입고후발송", "커버 무료증정",
}
_SUPPLIER_PREFIX_RE = re.compile(r"^(?:\[([^\]]+)\]|\(([^)]+)\))\s*")
_SCM_CODE_RE = re.compile(r"\bSCM[-_]?\s?\d+(?:\s*,\s*SCM[-_]?\s?\d+)*\b", re.IGNORECASE)


def display_name(raw: str) -> str:
    """원본 상품명에서 화면에 노출할 이름만 만든다 (products.json 은 불변)."""
    original = re.sub(r"\s+", " ", str(raw or "")).strip()
    s = _SCM_CODE_RE.sub(" ", original)
    while True:
        m = _SUPPLIER_PREFIX_RE.match(s)
        if not m:
            break
        tag = (m.group(1) or m.group(2) or "").strip()
        if tag in CONDITION_DISPLAY_TAGS:
            break
        s = s[m.end():].strip()
    s = re.sub(r"\s{2,}", " ", s).strip(" -·,")
    return s or original


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


# ---------------------------------------------------------------------------
# 배포용 분할 산출물 (PR-3)
#
# products.json 은 11MB 로 목록 한 번 보는 데 전부 필요하지 않다. 배포에서는
#   catalog.json          목록·필터·검색·장바구니에 필요한 칸만
#   brands.json           브랜드 이름 + 건수 (홈페이지 전용)
#   details/part-XXXX.json 상세 화면 칸(사양·옵션·이미지 전체) 100건 단위
# 만 내보내고 products.json / products.js 는 빌드 입력으로만 남긴다.
# ---------------------------------------------------------------------------

DETAIL_PART_SIZE = 100


def _category_label(product: dict) -> str:
    cat = product.get("category") or {}
    if cat.get("name"):
        return str(cat["name"])
    path = product.get("category_path") or []
    if path:
        return str(path[-1])
    return "미분류"


def _search_text(product: dict) -> str:
    """cgi-catalog.js prepare() 의 _search 입력과 같은 순서로 만든다.

    구매방법·배송주기 값은 공급처 구매 옵션 문구라 검색 잡음이라 (#216 G4)
    검색 대상에서 뺀다. "할인"·"정기배송"으로 검색해 전 상품이 나오는 것을 막는다.
    """
    specs = product.get("specs") or []
    parts = [
        product.get("name") or "",
        product.get("model") or "",
        product.get("brand") or "",
        product.get("brand_raw") or "",
        product.get("manufacturer") or "",
        _category_label(product),
        " ".join(str(p) for p in (product.get("category_path") or [])),
        " ".join(
            f"{s.get('label', '')} {s.get('value', '')}".strip()
            for s in specs
            if str(s.get("label", "")).strip() not in SEARCH_NOISE_SPEC_LABELS
        ),
    ]
    return " ".join(parts)


def to_light(product: dict, shard: int) -> dict:
    cat = product.get("category") or {}
    source = product.get("source") or {}
    images = product.get("images") or []
    return {
        "id": product.get("id", ""),
        "name": display_name(product.get("name", "")),
        "brand": product.get("brand", ""),
        "brand_raw": product.get("brand_raw", ""),
        "brand_norm": canonical_brand(product.get("brand_norm", "") or product.get("brand", "")),
        "manufacturer": product.get("manufacturer", ""),
        "model": product.get("model", ""),
        "category_path": product.get("category_path") or [],
        "category": {
            "id": cat.get("id", ""),
            "name": cat.get("name", ""),
            "path": cat.get("path", ""),
        },
        "price": product.get("price") or {"value": None, "text": "가격 미확인", "state": "unknown"},
        "availability": product.get("availability", ""),
        "images": images[:1],
        "source": {
            "site": source.get("site", ""),
            "site_label": source.get("site_label", ""),
            "updated_at": source.get("updated_at", ""),
        },
        "search_text": _search_text(product),
        "shard": shard,
    }


def write_split_outputs(products: list[dict], out_dir: Path, meta: dict, detail_size: int = DETAIL_PART_SIZE) -> dict:
    """목록 경량 파일·브랜드 파일·상세 분할 파일을 쓴다. 크기/건수를 돌려준다."""
    if detail_size < 1:
        raise ValueError("detail_size must be >= 1")
    out_dir.mkdir(parents=True, exist_ok=True)
    details_dir = out_dir / "details"
    details_dir.mkdir(parents=True, exist_ok=True)

    counts: dict[str, int] = {}
    for p in products:
        key = canonical_brand((p.get("brand_norm") or p.get("brand") or "")).strip()
        if not key:
            continue
        counts[key] = counts.get(key, 0) + 1

    brands_payload = {
        "generated_at": meta.get("generated_at"),
        "product_count": len(products),
        # "기타"(비브랜드 묶음)는 맨 아래에 고정 — 홈페이지 브랜드 목록 순서와 쇼핑몰
        # 필터 순서를 맞춘다 (#213 D4).
        "brands": [
            {"name": name, "count": count}
            for name, count in sorted(
                counts.items(),
                key=lambda kv: (kv[0] == OTHER_BRAND_LABEL, -kv[1], kv[0]),
            )
        ],
    }
    brands_path = out_dir / "brands.json"
    brands_path.write_text(json.dumps(brands_payload, ensure_ascii=False, indent=1), encoding="utf-8")

    # id 순서를 고정해 두면 재빌드 때 shard 번호가 흔들리지 않는다.
    ordered = sorted(products, key=lambda p: str(p.get("id", "")))
    light_products = []
    detail_files = 0
    for index, product in enumerate(ordered):
        shard = index // detail_size + 1
        light_products.append(to_light(product, shard))
    for start in range(0, len(ordered), detail_size):
        shard = start // detail_size + 1
        chunk = ordered[start:start + detail_size]
        payload = {
            "part": shard,
            "products": [
                {
                    "id": p.get("id", ""),
                    "images": p.get("images") or [],
                    "specs": p.get("specs") or [],
                    "options": p.get("options") or [],
                    "source": p.get("source") or {},
                }
                for p in chunk
            ],
        }
        (details_dir / f"part-{shard:04d}.json").write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
        detail_files += 1

    catalog_payload = {
        "meta": {
            "generated_at": meta.get("generated_at"),
            "product_count": len(products),
            "brands": sorted(counts),
            "sources": meta.get("sources") or [],
            "source_labels": meta.get("source_labels") or {},
            "supplier_catalog_totals": meta.get("supplier_catalog_totals") or {},
            "data_origin": meta.get("data_origin") or [],
            "notes": meta.get("notes") or [],
            "detail_part_size": detail_size,
            "detail_parts": detail_files,
        },
        "products": light_products,
    }
    catalog_path = out_dir / "catalog.json"
    # 6MB 목록 파일은 사람이 읽는 파일이 아니다 — 공백을 빼 전송 크기를 줄인다.
    catalog_path.write_text(
        json.dumps(catalog_payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    def size_of(path: Path) -> int:
        return path.stat().st_size if path.exists() else 0

    detail_bytes = sum(size_of(p) for p in details_dir.glob("part-*.json"))
    return {
        "brands": brands_path,
        "brands_bytes": size_of(brands_path),
        "catalog": catalog_path,
        "catalog_bytes": size_of(catalog_path),
        "detail_files": detail_files,
        "detail_bytes": detail_bytes,
        "brand_count": len(counts),
        "product_count": len(products),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="CGI 카탈로그 사이트 데이터 정규화 빌더")
    root = Path(__file__).resolve().parents[1]
    ap.add_argument("--master-csv", default=str(root / "site/data/_source_product_master_sample.csv"))
    ap.add_argument("--sample-json", default=str(root / "site/data/_source_sample-products.json"))
    ap.add_argument("--categories", default=str(root / "site/data/_source_category_catalog.csv"))
    ap.add_argument("--out-dir", default=str(root / "site/data"))
    ap.add_argument(
        "--split-only", action="store_true",
        help="products.json을 다시 만들지 않고 배포용 분할 산출물만 다시 쓴다",
    )
    ap.add_argument(
        "--from-json", default=str(root / "site/data/products.json"),
        help="--split-only 입력 (정규화된 전체 상품 배열)",
    )
    ap.add_argument(
        "--detail-part-size", type=int, default=DETAIL_PART_SIZE,
        help="상세 분할 파일당 상품 수 (기본 100)",
    )
    args = ap.parse_args()

    if args.split_only:
        source = Path(args.from_json)
        if not source.exists():
            print(f"[build_catalog_data] missing input: {source}", file=sys.stderr)
            return 1
        products = json.loads(source.read_text(encoding="utf-8"))
        if not isinstance(products, list):
            print("[build_catalog_data] products.json must be a JSON array", file=sys.stderr)
            return 1
        meta = {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "sources": sorted({(p.get("source") or {}).get("site", "") for p in products if (p.get("source") or {}).get("site")}),
            "source_labels": SITE_LABEL,
            "supplier_catalog_totals": SUPPLIER_CATALOG_TOTALS,
            "data_origin": ["site/data/products.json"],
            "notes": ["--split-only: 기존 products.json을 배포용으로 분할했다."],
        }
        result = write_split_outputs(products, Path(args.out_dir), meta, args.detail_part_size)
        print(
            f"[build_catalog_data] split-only products={result['product_count']} brands={result['brand_count']} "
            f"catalog={result['catalog_bytes']}B brands={result['brands_bytes']}B "
            f"details={result['detail_files']} files/{result['detail_bytes']}B"
        )
        print(f"[build_catalog_data] wrote {result['catalog']}")
        print(f"[build_catalog_data] wrote {result['brands']}")
        return 0

    cat_index = build_index(Path(args.categories))
    products = dedupe(
        from_master_csv(Path(args.master_csv), cat_index)
        + from_sample_json(Path(args.sample_json), cat_index)
    )
    # 상품이 아닌 항목 제외 (#216 G1): 결제창·잔금·계약금 페이지
    excluded_non_products = [p for p in products if is_non_product(p)]
    if excluded_non_products:
        products = [p for p in products if not is_non_product(p)]
        print(
            f"[build_catalog_data] excluded non-product pages: {len(excluded_non_products)} "
            f"({', '.join(sorted(p['id'] for p in excluded_non_products))})"
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

    # 배포용 경량 산출물 — products.json 이 단일 원본이고, 이것들은 파생물이다.
    split = write_split_outputs(products, out_dir, meta, args.detail_part_size)

    print(f"[build_catalog_data] products={len(products)} brands={len(brands)} sources={sites}")
    print(f"[build_catalog_data] wrote {out_dir / 'products.json'}")
    print(f"[build_catalog_data] wrote {out_dir / 'products.js'}")
    print(
        f"[build_catalog_data] split catalog={split['catalog_bytes']}B brands={split['brands_bytes']}B "
        f"details={split['detail_files']} files/{split['detail_bytes']}B"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())


