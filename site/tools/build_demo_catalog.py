#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
build_demo_catalog.py — 공개 샘플 CSV → CGI 카탈로그 사이트용 JSON 생성기.

입력(읽기 전용. 원본 CSV 는 수정하지 않는다):
  --sample-csv     PR #6 (research/model-a-site-analysis) 의
                   reports/data/samasound-samamusic-sample.csv
  --master-csv     PR #12 (feature/site-analysis-model-b) 의
                   reports/samples/product_master_sample.csv  (선택)
  --category-csv   PR #12 의 reports/samples/category_catalog_sample.csv (선택)

출력:
  site/data/catalog.demo.json   데이터 로더가 읽는 정규화 카탈로그
  site/data/catalog.demo.js     file:// 로 열어도 동작하도록 인라인 배포본

원칙
- 원본 CSV 는 절대 수정하지 않는다.
- 공개되지 않은 값(공급가/판매가/재고 수량)은 추정하지 않고 null + 상태값으로만 남긴다.
- 옵션 추가가는 원본 옵션 문자열에서만 추출하며, 없으면 미확정으로 둔다.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

SITE_LABEL = {
    "samamusic.co.kr": "삼아스토어 (samamusic.co.kr)",
    "samasound.co.kr": "삼아사운드 (samasound.co.kr)",
    "samasound": "삼아사운드 (samasound.co.kr)",
    "samamusic": "삼아스토어 (samamusic.co.kr)",
}
INQUIRY = {"가격 문의", "가격문의", "문의", "-", ""}


# ------------------------------------------------------------------ helpers

def read_csv(path: str) -> list[dict]:
    if not path or not os.path.isfile(path):
        return []
    with open(path, newline="", encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))


def parse_specs(raw: str) -> dict:
    """PR #6 형식 'k=v | k=v' → dict"""
    out = {}
    for part in (raw or "").split("|"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        k, v = part.split("=", 1)
        k, v = k.strip(), v.strip()
        if k and v:
            out[k] = v
    return out


def parse_images(raw: str) -> list[str]:
    return [u.strip() for u in (raw or "").split("|") if u.strip() and u.strip().startswith("http")]


def parse_price(raw: str) -> tuple[int | None, str, str]:
    """(숫자, 표시문자열, 상태) — 숫자가 아니면 추정하지 않는다."""
    s = (raw or "").strip()
    if not s:
        return None, "가격 정보 없음", "missing"
    if s in INQUIRY:
        # '가격 문의' 처럼 공급처에 문의해야 하는 상태. 금액을 추정하지 않는다.
        return None, "가격 문의 (공급처 문의 필요)", "inquiry_price"
    m = re.search(r"([0-9][0-9,]*)\s*원", s)
    if m:
        return int(m.group(1).replace(",", "")), s, "public"
    digits = re.sub(r"[^0-9]", "", s)
    if digits:
        return int(digits), s, "public"
    return None, s, "inquiry_price"


def parse_option_value(raw: str) -> dict:
    """'2m (+3,000원)' / '5m [품절] (+14,000원)' → {label, add_price, sold_out}"""
    s = (raw or "").strip()
    if not s:
        return {"label": "", "add_price": None, "sold_out": False}
    add = None
    m = re.search(r"\(\s*\+([0-9,]+)\s*원\s*\)", s)
    if m:
        add = int(m.group(1).replace(",", ""))
        s = re.sub(r"\(\s*\+[0-9,]+\s*원\s*\)", "", s).strip()
    sold = "[품절]" in s
    s = s.replace("[품절]", "").strip()
    return {"label": s, "add_price": add, "sold_out": sold}


def options_from_master(option_summary_json: str) -> tuple[list[dict], list[dict]]:
    """PR#12 의 구조화된 옵션 정보를 사용한다.
    반환: (옵션 그룹 목록, 구성/추가상품 목록)
    · addproduct_options 중 option_area 가 있는 항목 = 실제 옵션 그룹
    · option_area 가 null 인 항목과 addproducts = 구성/추가상품 (옵션 그룹이 아님)
    · 값별 item_code/품절 여부는 add_option_data 에서 조인한다
    """
    groups, bundles = [], []
    if not option_summary_json:
        return groups, bundles
    try:
        osum = json.loads(option_summary_json)
    except Exception:
        return groups, bundles
    if not isinstance(osum, dict):
        return groups, bundles

    # (addproduct_no, option_name, option_value) → item_code / 실제 품절 렌더 여부
    # 주의: use_soldout 은 '품절 표시를 쓸지' 템플릿 플래그이므로 품절 판정 근거가 아니다.
    # 실제 표시 기준은 soldout_rendered(사이트에 [품절] 로 렌더되었는지) 이다.
    detail_idx: dict[tuple, dict] = {}
    for d in (osum.get("add_option_data") or []):
        key = (str(d.get("addproduct_no")), d.get("option_name"), d.get("option_value"))
        detail_idx[key] = {
            "item_code": d.get("item_code"),
            "sold_out": bool(d.get("soldout_rendered")),
            "option_price": d.get("option_price"),
        }

    for ap in (osum.get("addproduct_options") or []):
        vals = []
        for v in (ap.get("values") or []):
            pv = parse_option_value(v)
            if not pv["label"] or pv["label"].startswith("- [필수]"):
                continue
            d = detail_idx.get((str(ap.get("addproduct_no")), ap.get("option_name"), pv["label"]))
            pv["item_code"] = (d or {}).get("item_code")
            if d and d.get("sold_out"):
                pv["sold_out"] = True
            vals.append(pv)
        if ap.get("option_area"):
            if vals:
                groups.append({
                    "name": ap.get("option_name", ""),
                    "option_type": ap.get("option_type", ""),
                    "item_codes": ap.get("item_codes") or [],
                    "values": vals,
                    "values_uncertain": False,
                })
        else:
            # option_area 가 없으면 실제 '구성/추가상품' 이다
            bundles.append({
                "name": ap.get("option_name", ""),
                "price_text": "",
                "sold_out": any(v.get("sold_out") for v in vals),
            })

    for ad in (osum.get("addproducts") or []):
        bundles.append({
            "name": ad.get("name", ""),
            "price_text": ad.get("price_text", ""),
            "sold_out": bool(ad.get("soldout_marked")),
        })
    return groups, bundles


def parse_options_from_specs(specs: dict) -> list[dict]:
    """제원 표 문자열 fallback. 값이 원본 HTML 에서 이어붙여져 있어 확정적이지 않으므로
    values_uncertain=True 로 표시한다."""
    out = []
    for label, value in specs.items():
        if label not in ("길이선택", "길이 선택", "색상 선택", "색상선택"):
            continue
        vals = []
        chunks = re.split(r"-{3,}", value)
        for chunk in chunks:
            chunk = chunk.strip()
            if not chunk or chunk.startswith("- [필수]") or "옵션을 선택해" in chunk:
                continue
            pairs = re.findall(r"([^\s()]+(?:\s[^\s()]+)?)\s*\(\+([0-9,]+)원\)", chunk)
            if pairs:
                for lab, add in pairs:
                    vals.append({"label": lab.strip(), "add_price": int(add.replace(",", "")),
                                 "sold_out": False, "item_code": None})
            else:
                toks = re.findall(r"\d+(?:\.\d+)?\s*[a-zA-Z가-힣]+", chunk)
                if toks:
                    for t in toks:
                        vals.append({"label": t.strip(), "add_price": None, "sold_out": False,
                                     "item_code": None})
                else:
                    vals.append({"label": chunk, "add_price": None, "sold_out": False,
                                 "item_code": None})
        if vals:
            out.append({"name": label, "option_type": "", "item_codes": [],
                        "values": vals, "values_uncertain": True})
    return out


def first_image(images: list[str]) -> str:
    for u in images:
        if "/web/product/" in u and ("/big/" in u or "/medium/" in u):
            return u
    return images[0] if images else ""


def parse_category(raw: str) -> tuple[str, str]:
    """'스피커(cate_no=42)' → ('42', '스피커') / '브랜드별-Shure' → ('', '브랜드별-Shure')"""
    s = (raw or "").strip()
    if not s:
        return "", ""
    m = re.search(r"\(cate_no=(\d+)\)", s)
    if m:
        return m.group(1), s[:m.start()].strip()
    return "", s


def site_key(site: str, pid: str) -> str:
    """'samamusic.co.kr' 와 'samamusic' 를 같은 키로 본다 (PR#6 / PR#12 표기 차이)."""
    return f"{(site or '').strip().replace('.co.kr', '').lower()}:{(pid or '').strip()}"


def normalize_product(row: dict, master: dict | None, cats: dict) -> dict:
    site = (row.get("source_site") or "").strip()
    pid = (row.get("source_product_id") or "").strip()
    m = master or {}

    specs = parse_specs(row.get("specs", ""))
    if m and m.get("specs"):
        try:
            mspecs = json.loads(m["specs"])
            if isinstance(mspecs, dict):
                for k, v in mspecs.items():
                    specs.setdefault(k, v)
        except Exception:
            pass

    # 가격: published_price 칸이 비어 있으면 '판매가' 제원 행을 사용한다.
    raw_price = (row.get("published_price") or "").strip()
    if not raw_price:
        raw_price = (specs.get("판매가") or specs.get("판매가(참고)") or "").strip()
    price_num, price_text, price_state = parse_price(raw_price)
    if m.get("published_price_state"):
        price_state = m["published_price_state"]
    # 가격 상태 어휘 정규화: numeric_price / public 은 동일 의미로 취급
    if price_state in ("numeric_price", "public_numeric"):
        price_state = "public"
    if price_state == "inquiry_price" and price_num is not None:
        price_state = "public"
    if m.get("published_price_text") and price_state == "public":
        price_text = m["published_price_text"]
    if m.get("published_price") and price_state == "public":
        price_num = int(m["published_price"])
    elif price_state == "public" and price_num is None:
        price_num = None

    images = parse_images(row.get("image_urls", ""))
    if m.get("image_urls") and len(parse_images(m["image_urls"])) > len(images):
        images = parse_images(m["image_urls"])

    raw_cat = (row.get("source_category") or "").strip()
    cat_id, cat_name = parse_category(raw_cat)
    cat_path = (m.get("source_category_path") or "").strip()
    if cat_path.startswith("홈 > "):
        cat_path = cat_path[4:]
    if not cat_path:
        cat_path = cat_name
    if m.get("source_category_id"):
        cat_id = str(m["source_category_id"])
    if m.get("source_category_name") and not cat_name:
        cat_name = m["source_category_name"]

    options, bundles = options_from_master(m.get("option_summary", ""))
    if not options:
        options = parse_options_from_specs(specs)
    if not bundles and m.get("option_summary"):
        pass

    brand = (row.get("brand") or m.get("source_brand") or specs.get("브랜드")
             or specs.get("제조사") or "").strip()
    model = (row.get("model") or m.get("model") or specs.get("모델명") or "").strip()
    name = (row.get("product_name") or m.get("product_name")
            or specs.get("상품명") or "").strip()
    summary = (m.get("summary") or specs.get("상품요약설명") or specs.get("상품간략설명") or "").strip()
    if not summary and specs.get("상품요약정보"):
        summary = specs["상품요약정보"].strip()

    return {
        "id": f"{site}:{pid}",
        "source_site": site,
        "source_site_label": SITE_LABEL.get(site, site),
        "source_product_id": pid,
        "source_category_id": str(cat_id) if cat_id else "",
        "source_category_path": cat_path,
        "brand": brand,
        "model": model,
        "product_name": name,
        "summary": summary,
        "manufacturer": (m.get("manufacturer") or specs.get("제조사") or "").strip(),
        "country_of_origin": (m.get("country_of_origin") or specs.get("원산지") or "").strip(),
        "canonical_url": (row.get("canonical_url") or m.get("canonical_url") or "").strip(),
        "source_list_url": (m.get("source_list_url") or "").strip(),
        "specs": specs,
        "options": options,
        "bundled_items": bundles,
        "image_urls": images,
        "image": first_image(images),
        "published_price": price_num,
        "published_price_text": price_text,
        "published_price_state": price_state,   # public | inquiry_price | missing
        "availability": (m.get("availability_unverified") or "").strip(),
        "review_count": m.get("review_count") or "",
        "extraction_method": (row.get("extraction_method") or m.get("extraction_method") or "").strip(),
        "verification_status": (row.get("verification_status") or m.get("verification_status") or "").strip(),
        "source_evidence": (row.get("source_evidence") or m.get("source_evidence") or "").strip(),
        "updated_at": (row.get("updated_at") or m.get("updated_at") or "").strip(),
        # ---- CGI 운영 필드 (전부 미승인/미확정으로 시작) ----
        "cgi_sale_status": "unapproved",        # approved | unapproved
        "cgi_sale_note": "CGI 취급 범위 확인 전 — 참고용 수집 정보",
        "cgi_dealer_price": None,               # 공급가: 미확정 (추정 금지)
        "cgi_dealer_price_state": "unconfirmed",
        "cgi_stock": None,
        "cgi_stock_state": "unconfirmed",
        "naver_smartstore_mapping": {
            "ready": False,
            "product_name": name,
            "category_id": None,
            "option_type": "".join(o["name"] for o in options) or None,
            "price": None,
            "stock": None,
            "image_urls": [],
            "memo": "스마트스토어 개설 후 확정 매핑 (Issue #11 §4)",
        },
    }


# ------------------------------------------------------------------ main

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample-csv", required=True)
    ap.add_argument("--extra-csv", action="append", default=[],
                    help="추가로 합칠 공개 샘플 CSV (중복 id 는 더 상세한 값을 우선)")
    ap.add_argument("--master-csv", default="")
    ap.add_argument("--category-csv", default="")
    ap.add_argument("--out-json", default="site/data/catalog.demo.json")
    ap.add_argument("--out-js", default="site/data/catalog.demo.js")
    args = ap.parse_args()

    sample = read_csv(args.sample_csv)
    extra = []
    for path in args.extra_csv:
        extra += read_csv(path)
    master_rows = read_csv(args.master_csv)
    cat_rows = read_csv(args.category_csv)
    if not sample:
        print(f"[FAIL] 샘플 CSV 를 읽지 못했습니다: {args.sample_csv}", file=sys.stderr)
        return 1

    master_by_key = {}
    for r in master_rows:
        master_by_key[site_key(r.get("source_site", ""), r.get("source_product_id", ""))] = r

    # 여러 공개 샘플을 id 로 합친다. 같은 id 이면 필드가 많은 쪽을 우선한다.
    merged_rows: dict[str, dict] = {}
    for r in sample + extra:
        key = site_key(r.get("source_site", ""), r.get("source_product_id", ""))
        if not key.endswith(":") and key.split(":")[1]:
            cur = merged_rows.get(key)
            if cur is None or len(r) < len(cur) or not cur.get("specs"):
                merged_rows[key] = r
    sample = list(merged_rows.values())

    cats = []
    for r in cat_rows:
        path = (r.get("category_path") or "").replace("홈 > ", "").strip()
        cats.append({
            "source_site": r.get("source_site", ""),
            "id": r.get("category_id", ""),
            "name": r.get("category_name", ""),
            "path": path,
            "level": int(r.get("category_level") or 0),
            "parent_id": r.get("parent_category_id", "") or "",
            "parent_name": r.get("parent_category_name", "") or "",
            "product_count": int(r.get("product_count_on_site") or 0),
            "list_url": r.get("list_url", ""),
        })

    products = []
    for row in sample:
        key = site_key(row.get("source_site", ""), row.get("source_product_id", ""))
        products.append(normalize_product(row, master_by_key.get(key), cats))

    # 브랜드 표기 정규화: 대소문자만 다른 표기는 하나로 묶는다 (표시는 가장 흔한 표기를 사용)
    variants: dict[str, dict[str, int]] = {}
    for p in products:
        b = (p["brand"] or "").strip()
        if not b:
            continue
        variants.setdefault(b.casefold(), {}).setdefault(b, 0)
        variants[b.casefold()][b] += 1
    canonical_brand: dict[str, str] = {}
    for cf, vs in variants.items():
        canonical_brand[cf] = sorted(vs.items(), key=lambda x: (-x[1], x[0]))[0][0]
    for p in products:
        b = (p["brand"] or "").strip()
        if b:
            p["brand"] = canonical_brand[b.casefold()]

    # 브랜드 목록 (수집 데이터에서만 집계)
    brands: dict[str, int] = {}
    for p in products:
        if p["brand"]:
            brands[p["brand"]] = brands.get(p["brand"], 0) + 1

    # 카테고리 목록: 원본 사이트의 LNB 11개 구조를 재사용 (수집 카테고리 카탈로그 우선)
    LNB = [(1152, "프로모션 보기"), (24, "브랜드"), (84, "마이크"), (42, "스피커"),
           (25, "이어폰/헤드폰"), (28, "레코딩/음향"), (379, "악기/앰프"), (1038, "Hi-Fi"),
           (366, "케이블/커넥터"), (758, "소프트웨어"), (97, "특가상품")]
    lnb = []
    for cid, cname in LNB:
        lnb.append({
            "id": str(cid), "name": cname, "parent_id": "", "level": 0,
            "path": cname, "product_count": 0,
            "list_url": f"https://www.samamusic.co.kr/product/list.html?cate_no={cid}",
        })
    for p in products:
        for c in lnb:
            if c["id"] == str(p.get("source_category_id", "")):
                c["product_count"] += 1

    catalog = {
        "meta": {
            "schema_version": "1.0",
            "catalog_id": "cgi-demo",
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "generated_by": "site/tools/build_demo_catalog.py",
            "data_basis": [
                "PR #6 reports/data/samasound-samamusic-sample.csv (공개 샘플, 시연 초기 데이터)",
                "PR #12 reports/samples/product_master_sample.csv (상품 마스터 보강, 선택)",
                "PR #12 reports/samples/category_catalog_sample.csv (카테고리 카탈로그, 선택)",
            ],
            "site_name": "CGI 상품 카탈로그",
            "site_owner": "CGI (김범신)",
            "disclaimer": [
                "수집된 전체 상품과 CGI 실제 판매 승인 상품은 서로 다른 집합입니다.",
                "표시 가격은 원본 공개 페이지의 참고용 공개가이며 CGI 판매가가 아닙니다.",
                "공급가·재고·판매가는 미확정이며 추정 금액을 표시하지 않습니다.",
                "네이버 스마트스토어 개설 전이므로 주문·결제 기능이 없습니다.",
            ],
            "brand_statement": "CGI 자체 브랜드이며 삼아스토어/삼아사운드의 상표·로고·화면을 복제하지 않습니다.",
        },
        "categories": lnb,
        "brands": [{"name": k, "count": v} for k, v in sorted(brands.items(), key=lambda x: (-x[1], x[0]))],
        "products": products,
    }

    for path in (args.out_json, args.out_js):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(args.out_json, "w", encoding="utf-8") as fh:
        json.dump(catalog, fh, ensure_ascii=False, indent=1)
    with open(args.out_js, "w", encoding="utf-8") as fh:
        fh.write("/* 자동 생성: site/tools/build_demo_catalog.py — 직접 수정하지 마세요 */\n")
        fh.write("window.CGI_CATALOG = ")
        json.dump(catalog, fh, ensure_ascii=False, indent=1)
        fh.write(";\n")

    print(f"[written] {args.out_json}  products={len(products)} categories={len(lnb)} brands={len(catalog['brands'])}")
    print(f"[written] {args.out_js}")
    for p in products:
        print(f"  {p['id']:<28} {p['brand'][:14]:<14} {p['product_name'][:40]:<40} "
              f"price={p['published_price']!s:<10} state={p['published_price_state']:<14} opts={len(p['options'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
