#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
collect_samples.py — 두 공급처 사이트(samasound.co.kr / samamusic.co.kr)의
공개 상품 샘플을 수집해 이슈 #5 표준 컬럼 CSV 로 만든다.

플랫폼: 둘 다 CAFE24 (mall id: samasound=samassi, samamusic=sama2015)
대량 수집이 아니라 '방법 검증'용 10~20건 샘플만 추출한다.

사용:
  python tools/collect_samples.py --out reports/sample-products.csv
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from samasound_collect import fetch, strip_tags          # noqa: E402

SA = "https://www.samasound.co.kr"
SM = "https://www.samamusic.co.kr"

COLUMNS = ["source_site", "brand", "source_category", "product_name", "model",
           "source_product_id", "canonical_url", "specs", "image_urls",
           "published_price", "dealer_price_unverified", "availability_unverified",
           "updated_at", "extraction_method", "verification_status", "source_evidence"]

NOW = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ------------------------------------------------------------------ helpers

def jsonld_product(html: str) -> dict:
    """JSON-LD Product / ProductGroup 를 정규화한다.
    일부 상품은 옵션(색상 등)을 갖는 ProductGroup 로 나오며 hasVariant 배열을 담는다."""
    for m in re.finditer(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S):
        try:
            obj = json.loads(m.group(1).strip())
        except Exception:
            continue
        for it in (obj if isinstance(obj, list) else [obj]):
            if not isinstance(it, dict):
                continue
            if it.get("@type") not in ("Product", "ProductGroup"):
                continue
            brand = it.get("brand") or {}
            off = it.get("offers") or {}
            if isinstance(off, list):
                off = off[0] if off else {}
            img = it.get("image") or []
            av = str(off.get("availability", ""))
            variants = []
            for v in (it.get("hasVariant") or []):
                voff = v.get("offers") or {}
                if isinstance(voff, list):
                    voff = voff[0] if voff else {}
                variants.append({
                    "name": v.get("name", ""),
                    "sku": v.get("sku", ""),
                    "price": str(voff.get("price", "")),
                    "availability": str(voff.get("availability", "")).rsplit("/", 1)[-1],
                })
            return {
                "type": it.get("@type", ""),
                "name": it.get("name", ""),
                "description": it.get("description", ""),
                "brand": brand.get("name", "") if isinstance(brand, dict) else str(brand),
                "sku": it.get("sku") or it.get("productGroupID", ""),
                "images": img if isinstance(img, list) else [img],
                "price": str(off.get("price", "")),
                "currency": off.get("priceCurrency", ""),
                "availability": av.rsplit("/", 1)[-1] if av else "",
                "variants": variants,
            }
    return {}


def spec_rows(html: str) -> list[dict]:
    """'기본 정보' 표의 th/td 라벨-값 쌍만 추출한다 (버튼/팝업이 섞인 행은 제외)."""
    rows, seen = [], set()
    for tm in re.finditer(r'<tr[^>]*>(.*?)</tr>', html, re.S):
        body = tm.group(1)
        if "<th" not in body or "scope=" not in body:
            continue
        if len(body) > 1200:                     # 팝업/버튼이 끼면 버린다
            continue
        cells = re.findall(r'<t[hd][^>]*>(.*?)</t[hd]>', body, re.S)
        if len(cells) < 2:
            continue
        k, v = strip_tags(cells[0]), strip_tags(cells[1])
        if not k or not v or len(k) > 40 or len(v) > 400 or k in seen:
            continue
        seen.add(k)
        rows.append({"label": k, "value": v})
    return rows


def find_model(specs: list[dict], fallback: str) -> str:
    for key in ("모델명", "모델", "Model", "Model Name", "Part Number", "품번"):
        for s in specs:
            if s["label"] == key and s["value"]:
                return s["value"]
    return fallback


def list_cards(html: str) -> list[dict]:
    """목록 카드 파싱. 상품명은 eListPrdImage 이미지의 alt 를 사용한다
    (좋아요/장바구니 아이콘의 alt 와 혼동되지 않음)."""
    out = []
    for m in re.finditer(r'<li([^>]*id="anchorBoxId_(\d+)"[^>]*)>(.*?)</li>', html, re.S):
        tag, pid, block = m.group(1), m.group(2), m.group(3)
        link = re.search(r'href="([^"]*product[^"]*)"', block)
        img = re.search(r'<img[^>]+id="eListPrdImage[^"]*"[^>]+alt="([^"]*)"', block)
        if not img:
            img = re.search(r'<img[^>]+alt="([^"]*)"[^>]+id="eListPrdImage[^"]*"', block)
        src = re.search(r'<img[^>]+id="eListPrdImage[^"]*"[^>]+src="([^"]+)"', block)
        if not src:
            src = re.search(r'<img[^>]+src="([^"]+)"[^>]+id="eListPrdImage[^"]*"', block)
        price = re.search(r'data-price="([^"]*)"', tag)      # 속성은 <li ...> 여는 태그에 있다
        name = strip_tags(img.group(1)) if img else ""
        summary = ""
        sm = re.search(r'class="[^"]*spec[^"]*">(.*?)</ul>', block, re.S)
        if sm:
            summary = strip_tags(sm.group(1)).replace("상품요약정보", "").strip()
        out.append({"id": pid, "name": name, "summary": summary,
                    "href": link.group(1) if link else "",
                    "image": ("https:" + src.group(1)) if src and src.group(1).startswith("//") else (src.group(1) if src else ""),
                    "data_price": price.group(1) if price else ""})
    return out


def detail_price(html: str) -> str:
    """상세 페이지의 실제 판매가 텍스트 (span_product_price_text)."""
    m = re.search(r'id="span_product_price_text"[^>]*>([^<]*)<', html)
    if m:
        return strip_tags(m.group(1)).replace("원", "").replace(",", "").strip()
    m = re.search(r'<span[^>]*class="price"[^>]*>\s*([0-9][0-9,]*)\s*원', html)
    if m:
        return m.group(1).replace(",", "")
    m = re.search(r'id="product_price"[^>]*value="([0-9]+)"', html)
    if m and m.group(1) not in ("", "0"):
        return m.group(1)
    return ""


def norm_href(href: str, base: str) -> str:
    if href.startswith("http"):
        return href
    if href.startswith("//"):
        return "https:" + href
    return base.rstrip("/") + href


# ------------------------------------------------------------------ category tree

_TREE_CACHE: dict = {}


def category_tree(base: str) -> dict:
    """공개 JSON 카테고리 트리: /exec/front/Product/SubCategory"""
    if base in _TREE_CACHE:
        return _TREE_CACHE[base]
    nodes: dict[int, dict] = {}
    try:
        req = urllib.request.Request(f"{base}/exec/front/Product/SubCategory",
                                     headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
        for d in data:
            nodes[int(d["cate_no"])] = {
                "name": d.get("name", ""),
                "parent": int(d.get("parent_cate_no", 0) or 0),
                "param": d.get("param", ""),
            }
    except Exception as exc:                       # noqa: BLE001
        print(f"  [WARN] category tree fetch failed for {base}: {exc}", file=sys.stderr)
    _TREE_CACHE[base] = nodes
    return nodes


def cate_path(nodes: dict, cate_no: int) -> str:
    """cate_no 에서 루트까지의 경로를 'A > B > C' 로 만든다."""
    parts, seen = [], set()
    cur = cate_no
    while cur and cur in nodes and cur not in seen:
        seen.add(cur)
        parts.append(nodes[cur]["name"])
        cur = nodes[cur]["parent"]
    return " > ".join(reversed(parts))


def detail_breadcrumb(html: str) -> str:
    """상세 페이지의 카테고리 경로 (xans-product-headcategory)."""
    m = re.search(r'xans-product-headcategory[^"]*"[^>]*>(.*?)</div>', html, re.S)
    if not m:
        return ""
    names = [strip_tags(x) for x in re.findall(r"<a[^>]*>([^<]*)</a>", m.group(1))]
    names = [n for n in names if n and n != "홈"]
    return " > ".join(names)


def dalue_category_path(catenos: str, tree: dict) -> str:
    """Dalue categoryNos('84;24^671;84^85') 를 카테고리 트리 경로로 변환한다.
    '^' 는 parent>child 체인, ';' 는 서로 다른 경로 구분자."""
    out = []
    for chain in (catenos or "").split(";"):
        parts = [p for p in chain.split("^") if p.strip().isdigit()]
        if not parts:
            continue
        path = cate_path(tree, int(parts[-1]))
        if path and path not in out:
            out.append(path)
    return " | ".join(out)


_DALUE: dict = {}


def dalue_map(mall_id: str = "sama2015") -> dict:
    """Dalue API 로 전체 상품을 1회에 받아 productNo 인덱스를 만든다."""
    if mall_id in _DALUE:
        return _DALUE[mall_id]
    import dalue_export
    try:
        out = dalue_export.query(mall_id, size=2000)
        idx = {str(it.get("productNo")): it for it in out.get("items", [])}
        print(f"  [dalue] {mall_id}: totalCount={out['header'].get('totalCount')} fetched={len(idx)}")
    except Exception as exc:                       # noqa: BLE001
        print(f"  [WARN] dalue fetch failed: {exc}", file=sys.stderr)
        idx = {}
    _DALUE[mall_id] = idx
    return idx


def unescape(v):
    """HTML 엔티티를 실제 문자로 되돌린다 (예: 'Allen&amp;Heath')."""
    import html as _h
    if isinstance(v, str):
        return _h.unescape(v)
    if isinstance(v, list):
        return [unescape(x) for x in v]
    if isinstance(v, dict):
        return {k: unescape(x) for k, x in v.items()}
    return v


# ------------------------------------------------------------------ samasound

def sample_samasound(limit: int) -> list[dict]:
    rows = []
    seen = set()
    tree = category_tree(SA)
    # 전체보기(cate_no=23) 가 전체 카탈로그의 정규 뷰. 여러 페이지에서 층화 샘플.
    for page in (1, 2, 3, 4):
        html = fetch(f"{SA}/product/list.html?cate_no=23&page={page}")
        if not html:
            continue
        cards = list_cards(html)
        step = max(1, len(cards) // 6)
        for c in cards[::step]:
            if c["id"] in seen or len(rows) >= limit:
                continue
            seen.add(c["id"])
            url = norm_href(c["href"], SA)
            dh = fetch(url)
            if not dh:
                continue
            jl = jsonld_product(dh)
            specs = spec_rows(dh)
            sdict = {s["label"]: s["value"] for s in specs}
            imgs = jl.get("images") or ([c["image"]] if c["image"] else [])
            brand = jl.get("brand", "") or sdict.get("제조사", "")
            price = jl.get("price", "") or c["data_price"].lstrip("^")
            # 실제 카테고리 경로: /product/detail.html?product_no=N 형태에서만 전체 breadcrumb 이 나온다
            dh2 = fetch(f"{SA}/product/detail.html?product_no={c['id']}")
            crumb = detail_breadcrumb(dh2) if dh2 else ""
            if not crumb:
                crumb = cate_path(tree, 23) or "전체보기"
            rows.append({
                "source_site": "samasound.co.kr",
                "brand": brand,
                "source_category": crumb,
                "product_name": c["name"] or jl.get("name", ""),
                "model": find_model(specs, c["name"] or jl.get("name", "")),
                "source_product_id": c["id"],
                "canonical_url": url,
                "specs": json.dumps(sdict, ensure_ascii=False),
                "image_urls": json.dumps(imgs, ensure_ascii=False),
                "published_price": price,
                "dealer_price_unverified": "",
                "availability_unverified": jl.get("availability", ""),
                "updated_at": NOW,
                "extraction_method": "http-ssr+json-ld",
                "verification_status": "verified-by-http-fetch",
                "source_evidence": json.dumps({
                    "list_url": f"{SA}/product/list.html?cate_no=23&page={page}",
                    "sku": jl.get("sku", ""),
                    "jsonld_type": jl.get("type", ""),
                    "description": jl.get("description", "")[:200],
                    "summary": c["summary"][:200],
                    "spec_rows": specs[:14],
                }, ensure_ascii=False),
            })
            time.sleep(0.2)
        if len(rows) >= limit:
            break
    return rows


# ------------------------------------------------------------------ samamusic

SM_CATS = [
    (84, "마이크"), (42, "스피커"), (25, "이어폰/헤드폰"), (28, "레코딩/음향"),
    (379, "악기/앰프"), (366, "케이블/커넥터"), (758, "소프트웨어"),
    (1038, "Hi-Fi"), (97, "특가상품"),
]


def sample_samamusic(limit: int) -> list[dict]:
    rows = []
    seen = set()
    dmap = dalue_map("sama2015")
    per_cat = max(1, limit // len(SM_CATS))
    for no, cname in SM_CATS:
        html = fetch(f"{SM}/product/list.html?cate_no={no}")
        if not html:
            continue
        cards = list_cards(html)
        step = max(1, len(cards) // per_cat)
        picked = 0
        for c in cards[::step]:
            if c["id"] in seen or picked >= per_cat or len(rows) >= limit:
                continue
            seen.add(c["id"])
            picked += 1
            url = norm_href(c["href"], SM)
            dh = fetch(url)
            if not dh:
                continue
            jl = jsonld_product(dh)
            specs = spec_rows(dh)
            sdict = {s["label"]: s["value"] for s in specs}
            imgs = jl.get("images") or ([c["image"]] if c["image"] else [])
            price = detail_price(dh) or jl.get("price", "")
            if not price or price in ("가격 문의", "0"):
                price = c["data_price"].lstrip("^")
            brand = jl.get("brand", "") or sdict.get("브랜드", "")
            tree = category_tree(SM)
            cat_path = cate_path(tree, no) or cname
            # Dalue 공개 API 로 per-product 카테고리 경로/가격/모델명을 교차검증한다
            dz = dmap.get(c["id"], {})
            dz_path = dalue_category_path(dz.get("categoryNos", ""), tree)
            if dz_path:
                cat_path = dz_path
            dprice = str(dz.get("pcDiscountPrice", "") or "")
            if dprice and price and dprice != price:
                price = f"{price} (dalue={dprice})"
            elif not price and dprice:
                price = dprice
            dmodel = str(dz.get("modelName", "") or "")
            if dmodel and not sdict.get("모델명"):
                sdict["모델명"] = dmodel
            if dz.get("brandName") and not brand:
                brand = dz["brandName"]
            # 재고/판매상태: JSON-LD offers.availability 가 없을 때 Dalue 플래그로 대체
            avail = jl.get("availability", "")
            avail_src = "json-ld-offers"
            if not avail and dz:
                if str(dz.get("soldOut")) == "1":
                    avail, avail_src = "SoldOut", "dalue-soldOut"
                elif str(dz.get("display")) == "1" and str(dz.get("selling")) == "1":
                    avail, avail_src = "InStock", "dalue-display-selling"
            rows.append({
                "source_site": "samamusic.co.kr",
                "brand": brand,
                "source_category": cat_path,
                "product_name": c["name"] or jl.get("name", ""),
                "model": find_model([{"label": k, "value": v} for k, v in sdict.items()],
                                    c["name"] or jl.get("name", "")),
                "source_product_id": c["id"],
                "canonical_url": url,
                "specs": json.dumps(sdict, ensure_ascii=False),
                "image_urls": json.dumps(imgs, ensure_ascii=False),
                "published_price": price,
                "dealer_price_unverified": "",
                "availability_unverified": avail,
                "updated_at": NOW,
                "extraction_method": "http-ssr+json-ld+dalue-api",
                "verification_status": "verified-by-http-fetch",
                "source_evidence": json.dumps({
                    "list_url": f"{SM}/product/list.html?cate_no={no}",
                    "sku": jl.get("sku", ""),
                    "jsonld_type": jl.get("type", ""),
                    "availability_source": avail_src,
                    "description": jl.get("description", "")[:200],
                    "summary": c["summary"][:200],
                    "spec_rows": specs[:14],
                    "variants": jl.get("variants", [])[:6],
                    "dalue_categoryNos": dz.get("categoryNos", ""),
                    "dalue_soldOut": dz.get("soldOut"),
                }, ensure_ascii=False),
            })
            time.sleep(0.2)
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="reports/sample-products.csv")
    ap.add_argument("--json-out", default="reports/sample-products.json")
    ap.add_argument("--samasound", type=int, default=10)
    ap.add_argument("--samamusic", type=int, default=10)
    args = ap.parse_args()

    rows = []
    print(f"[1/2] samasound.co.kr sample ({args.samasound}) ...")
    rows += sample_samasound(args.samasound)
    print(f"      -> {len(rows)} rows")
    print(f"[2/2] samamusic.co.kr sample ({args.samamusic}) ...")
    rows += sample_samamusic(args.samamusic)
    print(f"      -> {len(rows)} rows total")
    rows = [unescape(r) for r in rows]

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(rows)
    print(f"[written] {args.out} ({len(rows)} rows)")
    with open(args.json_out, "w", encoding="utf-8") as fh:
        json.dump(rows, fh, ensure_ascii=False, indent=2)
    print(f"[written] {args.json_out}")

    for r in rows:
        print(f"  {r['source_site']:<16} {r['source_product_id']:>6} | {r['brand'][:20]:<20} | "
              f"{r['product_name'][:46]:<46} | model={r['model'][:26]:<26} | price={r['published_price'][:22]!r} | "
              f"avail={r['availability_unverified']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
