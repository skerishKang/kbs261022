#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
samasound_collect.py — CAFE24 기반 공급처 사이트(삼아사운드) 공개 정보 수집 도구.

플랫폼: CAFE24 (mall id: samassi)
  - 목록(카테고리) : https://www.samasound.co.kr/product/list.html?cate_no={N}&page={P}
  - 브랜드 목록    : https://www.samasound.co.kr/category/{brand}/{brand_id}/
  - 상세          : https://www.samasound.co.kr/product/{slug}/{product_id}/category/{cate_no}/display/1/
  - 이미지 CDN     : https://www.samasound.co.kr/web/product/{size}/{YYYYMM}/{hash}.jpg

사용:
  python tools/samasound_collect.py --discover
  python tools/samasound_collect.py --sample 20 --out reports/sample-products.csv
"""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

BASE = "https://www.samasound.co.kr"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36")

# ---------------------------------------------------------------- http

def encode_url(url: str) -> str:
    """상품 URL 에 한글 경로가 포함되므로 percent-encoding 한다 (urllib 의 ascii 오류 방지)."""
    p = urllib.parse.urlsplit(url)
    path = urllib.parse.quote(p.path, safe="/~!*()'-._")
    query = urllib.parse.quote(p.query, safe="=&?/~!*()'-._%+")
    return urllib.parse.urlunsplit((p.scheme, p.netloc, path, query, p.fragment))


def fetch(url: str, timeout: int = 30, retries: int = 3, delay: float = 0.35) -> str | None:
    """SSR 페이지를 평문 HTML로 가져온다. 실패 시 None."""
    last = None
    url = encode_url(url)
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
                "Accept-Encoding": "gzip, deflate",
                "Referer": BASE + "/",
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return raw.decode("utf-8", errors="replace")
        except Exception as exc:            # noqa: BLE001 - 원인을 그대로 보고한다
            last = exc
            time.sleep(1.0 + attempt)
    print(f"  [FETCH-FAIL] {url} -> {last}", file=sys.stderr)
    return None


def strip_tags(s: str) -> str:
    s = re.sub(r"<script.*?</script>", " ", s, flags=re.S | re.I)
    s = re.sub(r"<style.*?</style>", " ", s, flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    s = s.replace("&quot;", '"').replace("&#39;", "'")
    return re.sub(r"\s+", " ", s).strip()


# ---------------------------------------------------------------- category tree

def discover_categories() -> list[dict]:
    """홈 + 주요 목록 페이지에서 cate_no / 이름 / 브랜드 를 수집한다."""
    found: dict[int, dict] = {}

    home = fetch(BASE + "/")
    if home:
        for m in re.finditer(r'<a[^>]+href="([^"]*cate_no=(\d+)[^"]*)"[^>]*>(.*?)</a>', home, re.S):
            href, no, text = m.group(1), int(m.group(2)), strip_tags(m.group(3))
            if text and no not in found:
                found[no] = {"cate_no": no, "name": text, "list_url": BASE + f"/product/list.html?cate_no={no}"}

    brands = []
    if home:
        for m in re.finditer(r'<a[^>]+href="(/category/([^/"]+)/(\d+)/)"[^>]*>(.*?)</a>', home, re.S):
            href, slug, bid, text = m.group(1), m.group(2), int(m.group(3)), strip_tags(m.group(4))
            brands.append({"brand": text or slug, "brand_slug": slug, "brand_id": bid,
                           "url": BASE + href})

    # 각 cate_no 의 총 페이지 수(=상품 규모) 를 마지막 페이지 링크에서 실측
    for no, info in sorted(found.items()):
        html = fetch(info["list_url"])
        if not html:
            info["pages"] = None
            info["products_est"] = None
            continue
        pages = 1
        for m in re.finditer(r'page=(\d+)"', html):
            pages = max(pages, int(m.group(1)))
        per_page = len(re.findall(r'id="anchorBoxId_\d+"', html))
        info["pages"] = pages
        info["per_page"] = per_page
        info["products_est"] = pages * per_page if per_page else None
        # 상위 카테고리명 (cafe24 는 cate_no 를 경로에 넣어 같은 카테고리/하위 카테고리의
        # 다른 디자인 페이지로 연결한다)
        m = re.search(r'"category_no":(\d+),"category_name":"([^"]*)"', html)
        if m:
            info["page_category_name"] = m.group(2)
        time.sleep(0.2)

    return list(found.values()), brands


# ---------------------------------------------------------------- list parsing

CARD_RE = re.compile(
    r'<li[^>]*id="anchorBoxId_(\d+)"[^>]*class="xans-record-".*?</li>', re.S)


def parse_list(html: str) -> list[dict]:
    """목록 페이지에서 상품 카드(상품명/요약/이미지/상세URL/상품ID)를 뽑는다."""
    out = []
    for m in CARD_RE.finditer(html):
        pid = m.group(1)
        block = m.group(0)
        link = re.search(r'href="(/product/[^"]+)"', block)
        img = re.search(r'<img[^>]+src="(//[^"]+)"', block)
        name = ""
        nm = re.search(r'class="name">.*?<span[^>]*>([^<]*)</span>', block, re.S)
        if nm:
            name = strip_tags(nm.group(1))
        if not name:
            alt = re.search(r'alt="([^"]*)"', block)
            name = strip_tags(alt.group(1)) if alt else ""
        summary = ""
        sm = re.search(r'class="[^"]*spec[^"]*">(.*?)</ul>', block, re.S)
        if sm:
            summary = strip_tags(sm.group(1)).replace("상품요약정보", "").strip()
        out.append({
            "source_product_id": pid,
            "product_name": name,
            "summary": summary,
            "detail_path": link.group(1) if link else "",
            "image_url": ("https:" + img.group(1)) if img else "",
        })
    return out


# ---------------------------------------------------------------- detail parsing

def parse_detail(html: str) -> dict:
    """상세 페이지에서 JSON-LD + 제원표 + 옵션 + 이미지를 뽑는다."""
    d: dict = {}
    # 1) JSON-LD Product 스키마 (가장 안정적인 단일 소스)
    for m in re.finditer(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S):
        raw = m.group(1).strip()
        try:
            obj = json.loads(raw)
        except Exception:
            continue
        items = obj if isinstance(obj, list) else [obj]
        for it in items:
            if isinstance(it, dict) and it.get("@type") == "Product":
                d["name"] = it.get("name", "")
                d["description"] = it.get("description", "")
                brand = it.get("brand") or {}
                d["brand"] = brand.get("name", "") if isinstance(brand, dict) else str(brand)
                d["sku"] = it.get("sku", "")
                img = it.get("image") or []
                d["image_urls"] = img if isinstance(img, list) else [img]
                off = it.get("offers") or {}
                if isinstance(off, list):
                    off = off[0] if off else {}
                d["published_price_raw"] = str(off.get("price", ""))
                d["price_currency"] = off.get("priceCurrency", "")
                av = str(off.get("availability", ""))
                d["availability"] = av.rsplit("/", 1)[-1] if av else ""
                d["offer_url"] = off.get("url", "")
                break
    # 2) 제원 표 (th/td 쌍)
    specs = []
    for tm in re.finditer(r'<tr[^>]*class="[^"]*xans-record[^"]*"[^>]*>(.*?)</tr>', html, re.S):
        cells = re.findall(r'<t[hd][^>]*>(.*?)</t[hd]>', tm.group(1), re.S)
        if len(cells) >= 2:
            k, v = strip_tags(cells[0]), strip_tags(cells[1])
            if k and v and len(k) < 40:
                specs.append({"label": k, "value": v})
    d["spec_rows"] = specs
    # 3) 옵션
    opts = []
    for om in re.finditer(r'<li[^>]*>\s*<label[^>]*>(.*?)</label>.*?<span[^>]*>(.*?)</span>', html, re.S):
        k, v = strip_tags(om.group(1)), strip_tags(om.group(2))
        if k:
            opts.append({"name": k, "value": v})
    d["options"] = opts
    # 4) 상세 이미지 전체
    bigs = []
    for m in re.finditer(r'(//www\.samasound\.co\.kr/web/product/(?:big|extra/big)/\d+/[0-9a-f]+\.(?:jpg|png|gif))', html):
        u = "https:" + m.group(1)
        if u not in bigs:
            bigs.append(u)
    d["detail_image_urls"] = bigs
    return d


# ---------------------------------------------------------------- main

COLUMNS = ["source_site", "brand", "source_category", "product_name", "model",
           "source_product_id", "canonical_url", "specs", "image_urls",
           "published_price", "dealer_price_unverified", "availability_unverified",
           "updated_at", "extraction_method", "verification_status", "source_evidence"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--discover", action="store_true")
    ap.add_argument("--sample", type=int, default=0)
    ap.add_argument("--out", default=None)
    ap.add_argument("--json-out", default=None)
    ap.add_argument("--categories", default="", help="comma list of cate_no for sampling")
    args = ap.parse_args()

    if args.discover:
        cats, brands = discover_categories()
        print(json.dumps({"categories": cats, "brands": brands}, ensure_ascii=False, indent=2))
        return 0

    if args.sample:
        cats, brands = discover_categories()
        order = [int(x) for x in args.categories.split(",") if x.strip()]
        if not order:
            order = sorted(c["cate_no"] for c in cats if c.get("per_page"))
        rows = []
        seen_ids = set()
        for no in order:
            cat = next((c for c in cats if c["cate_no"] == no), {})
            url = f"{BASE}/product/list.html?cate_no={no}"
            html = fetch(url)
            if not html:
                continue
            cards = parse_list(html)
            for card in cards:
                if card["source_product_id"] in seen_ids:
                    continue
                seen_ids.add(card["source_product_id"])
                detail_url = BASE + card["detail_path"]
                dh = fetch(detail_url)
                det = parse_detail(dh) if dh else {}
                specs = {s["label"]: s["value"] for s in det.get("spec_rows", [])}
                model = ""
                for key in ("모델명", "모델", "Model", "Part Number", "품번"):
                    if key in specs:
                        model = specs[key]
                        break
                if not model:
                    model = card["product_name"]
                imgs = det.get("image_urls") or ([card["image_url"]] if card["image_url"] else [])
                rows.append({
                    "source_site": "samasound.co.kr",
                    "brand": det.get("brand", ""),
                    "source_category": f"cate_no={no}" + (f" ({cat.get('name','')})" if cat.get("name") else ""),
                    "product_name": card["product_name"] or det.get("name", ""),
                    "model": model,
                    "source_product_id": card["source_product_id"],
                    "canonical_url": detail_url,
                    "specs": json.dumps(specs, ensure_ascii=False),
                    "image_urls": json.dumps(imgs, ensure_ascii=False),
                    "published_price": det.get("published_price_raw", ""),
                    "dealer_price_unverified": "",
                    "availability_unverified": det.get("availability", ""),
                    "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "extraction_method": "http-ssr+json-ld",
                    "verification_status": "verified-by-http-fetch",
                    "source_evidence": json.dumps({
                        "list_url": url,
                        "sku": det.get("sku", ""),
                        "description": det.get("description", "")[:200],
                        "options": det.get("options", [])[:5],
                        "spec_rows": det.get("spec_rows", [])[:12],
                    }, ensure_ascii=False),
                })
                if len(rows) >= args.sample:
                    break
                time.sleep(0.25)
            if len(rows) >= args.sample:
                break

        if args.out:
            os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
            with open(args.out, "w", newline="", encoding="utf-8-sig") as fh:
                w = csv.DictWriter(fh, fieldnames=COLUMNS)
                w.writeheader()
                w.writerows(rows)
            print(f"[written] {args.out} rows={len(rows)}")
        if args.json_out:
            with open(args.json_out, "w", encoding="utf-8") as fh:
                json.dump(rows, fh, ensure_ascii=False, indent=2)
        for r in rows:
            print(f"{r['source_product_id']:>6} | {r['brand'][:18]:<18} | {r['product_name'][:44]:<44} | "
                  f"price={r['published_price']!r} | avail={r['availability_unverified']} | {r['canonical_url']}")
        return 0

    ap.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
