#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
samasound / samamusic 공개 상품 정보 수집기 (Model A 분석 기반).

이 스크립트는 "방법 검증" 단계에서 사용한 수집 경로를 재현 가능하게 만든 것이다.
- 목록 페이지(HTTP/HTML) → 상품 식별자·이름·이미지·공개 가격
- 상세 페이지(HTTP/HTML) → 브랜드·모델명·규격·원산지·인증번호·공개 가격
- samamusic sitemap.xml(파일 카탈로그) → product_no 기준 전체 상품 URL 목록

사용 원칙(분석 결과에서 확정된 것만 지킨다)
1. robots.txt Disallow 경로(/api, /exec/front/, /admin, /member/, /myshop/,
   /protected/, /skin-*/, board/article page=)는 요청하지 않는다.
2. User-Agent에 "python-requests" 문자열을 쓰면 Cafe24가 403으로 막는다.
   브라우저 UA 또는 curl UA를 사용한다.
3. 요청 사이 최소 1.2초 간격을 둔다.
4. 라벨이 없는 값은 추정하지 않는다. 미확인 필드는 빈칸으로 둔다.

사용:
  python tools/collect_samasound_samamusic.py --site samamusic --list-pages 1 --out out.csv
  python tools/collect_samasound_samamusic.py --site samasound --details urls.txt --out out.csv
"""
from __future__ import print_function

import argparse
import csv
import io
import json
import os
import re
import sys
import time

try:
    import requests
except ImportError:
    sys.stderr.write("requests 가 필요합니다: pip install requests\n")
    sys.exit(2)

try:
    from bs4 import BeautifulSoup
except ImportError:
    sys.stderr.write("beautifulsoup4 가 필요합니다: pip install beautifulsoup4\n")
    sys.exit(2)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
HEADERS = {"User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9"}
MIN_INTERVAL = 1.2

SITES = {
    "samasound": {
        "base": "https://www.samasound.co.kr/",
        "all_cate": "23",
        "detail_re": re.compile(r"/product/[^/?]+/(\d+)/"),
    },
    "samamusic": {
        "base": "https://www.samamusic.co.kr/",
        "all_cate": None,
        "detail_re": re.compile(r"product_no=(\d+)"),
    },
}

FIELDS = [
    "source_site", "brand", "source_category", "product_name", "model",
    "source_product_id", "canonical_url", "specs", "image_urls", "published_price",
    "updated_at", "extraction_method", "verification_status", "source_evidence",
]

LABEL_NAME = "상품명"
LABEL_BRAND = "브랜드"
LABEL_MODEL = "모델명"
LABEL_PRICE = "판매가"
LABEL_CONSUMER = "소비자가"
LABEL_MAKER = "제조사"

_last = [0.0]


def get(url):
    gap = time.time() - _last[0]
    if gap < MIN_INTERVAL:
        time.sleep(MIN_INTERVAL - gap)
    _last[0] = time.time()
    r = requests.get(url, headers=HEADERS, timeout=45)
    r.raise_for_status()
    return r


def clean_name(s):
    s = re.sub(r"^\s*상품명\s*[:：]\s*", "", s or "")
    return " ".join(s.split())


def num_of(s):
    if not s:
        return ""
    m = re.search(r"([\d,]{4,})\s*원", s)
    return m.group(1) if m else ""


def spec_pairs(soup):
    pairs = {}
    for tbl in soup.find_all("table"):
        rows = tbl.find_all("tr")
        if len(rows) < 3:
            continue
        got = {}
        for tr in rows:
            ths, tds = tr.find_all("th"), tr.find_all("td")
            if len(ths) == 1 and tds:
                k = " ".join(ths[0].get_text(" ", strip=True).split())
                v = " ".join(tds[0].get_text(" ", strip=True).split())
                if k and len(k) <= 40:
                    got[k] = v
        if any(k in got for k in (LABEL_NAME, LABEL_PRICE, LABEL_BRAND, LABEL_MODEL)):
            pairs.update(got)
    return pairs


def first_of(pairs, *labels):
    for lb in labels:
        if pairs.get(lb):
            return pairs[lb]
    return ""


CODE_ONLY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9\-/+\. ]{0,29}$")


def conservative_model(name, explicit):
    if explicit:
        return explicit
    n = clean_name(name)
    if n and CODE_ONLY.match(n) and re.search(r"\d", n):
        return n
    return ""


def detail_images(soup, base):
    out = []
    for el in soup.find_all("img"):
        v = el.get("src") or el.get("data-src")
        if not v:
            continue
        if v.startswith("//"):
            v = "https:" + v
        elif v.startswith("/"):
            v = base.rstrip("/") + v
        if ("/web/product/" in v or "/web/upload/" in v) and "icon_" not in v:
            if v not in out:
                out.append(v)
    return out


def row_from_detail(site, url, html, method="HTTP/HTML(detail)"):
    base = SITES[site]["base"]
    soup = BeautifulSoup(html, "html.parser")
    pairs = spec_pairs(soup)
    m = re.search(r"product_no=(\d+)", url) or SITES[site]["detail_re"].search(url)
    pno = m.group(1) if m else ""

    name = first_of(pairs, LABEL_NAME)
    if not name:
        t = soup.find("title")
        name = clean_name(t.get_text(strip=True)) if t else ""
    name = clean_name(name)

    price = num_of(first_of(pairs, LABEL_PRICE)) or num_of(first_of(pairs, LABEL_CONSUMER))
    brand = first_of(pairs, LABEL_BRAND, LABEL_MAKER)
    model = conservative_model(name, first_of(pairs, LABEL_MODEL))
    imgs = detail_images(soup, base)

    specs = []
    for k, v in pairs.items():
        if k in ("수량", "배송비", "구매방법", "정기결제") or not v:
            continue
        specs.append("%s=%s" % (k, " ".join(v.split())[:160]))

    return {
        "source_site": site + ".co.kr",
        "brand": brand,
        "source_category": "",
        "product_name": name,
        "model": model,
        "source_product_id": pno,
        "canonical_url": url,
        "specs": " | ".join(specs[:16]),
        "image_urls": " | ".join(imgs[:5]),
        "published_price": price,
        "updated_at": "",
        "extraction_method": method,
        "verification_status": "detail_page_verified",
        "source_evidence": "detail=%s" % url,
    }


def row_from_list(site, url, html, brand_ctx="", category=""):
    base = SITES[site]["base"]
    soup = BeautifulSoup(html, "html.parser")
    rows, seen = [], set()
    for li in soup.select("li[id^=anchorBoxId_], li.product, .prdList li, .product_list li"):
        a = li.find("a", href=True)
        if not a:
            continue
        href = a["href"]
        if href.startswith("/"):
            href = base.rstrip("/") + href
        if "/product/detail.html" not in href and not re.search(r"/product/[^/?]+/\d+/", href):
            continue
        m = re.search(r"product_no=(\d+)", href) or SITES[site]["detail_re"].search(href)
        if not m:
            continue
        pno = m.group(1)
        if pno in seen:
            continue
        seen.add(pno)

        name = ""
        for sel in (".prd_name", ".name", ".product-name", ".txt strong", ".title"):
            el = li.select_one(sel)
            if el:
                t = " ".join(el.get_text(" ", strip=True).split())
                if t:
                    name = t
                    break
        if not name:
            mm = re.search(r"상품명\s*:\s*([^<]{1,160})", str(li))
            name = mm.group(1) if mm else ""
        name = clean_name(name)

        txt = " ".join(li.get_text(" ", strip=True).split())
        price = ""
        for lb in (LABEL_PRICE, LABEL_CONSUMER):
            pm = re.search(lb + r"\s*[:：]?\s*([\d,]{4,})\s*원", txt)
            if pm:
                price = pm.group(1)
                break

        img = ""
        for el in li.find_all("img"):
            v = el.get("src") or el.get("data-src")
            if v and "/web/product/" in v:
                img = v if v.startswith("http") else (("https:" + v) if v.startswith("//")
                                                     else base.rstrip("/") + v)
                break
        if img:
            img = img.replace("/web/product/medium/", "/web/product/large/")

        rows.append({
            "source_site": site + ".co.kr",
            "brand": brand_ctx,
            "source_category": category,
            "product_name": name,
            "model": conservative_model(name, ""),
            "source_product_id": pno,
            "canonical_url": href,
            "specs": "",
            "image_urls": img,
            "published_price": price,
            "updated_at": "",
            "extraction_method": "HTTP/HTML(list)",
            "verification_status": "list_page_verified",
            "source_evidence": "list=%s" % url,
        })
    return rows


def sitemap_product_ids(site):
    """samamusic sitemap.xml 에서 product_no 기준 전체 상품 URL 목록을 얻는다."""
    if site != "samamusic":
        return []
    r = get(SITES[site]["base"].rstrip("/") + "/sitemap.xml")
    if "xml" not in (r.headers.get("Content-Type") or ""):
        return []
    urls = re.findall(r"<loc>\s*([^<\s]+)</loc>", r.text)
    out = []
    for u in urls:
        if "/product/" in u and re.search(r"/\d+/?$", u):
            m = re.search(r"/(\d+)/?$", u)
            if m:
                out.append((m.group(1), u))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True, choices=sorted(SITES))
    ap.add_argument("--list-pages", type=int, default=0,
                    help="cate_no 기준 목록 페이지 N장을 수집 (samasound: 23=전체)")
    ap.add_argument("--cate", default=None, help="목록 카테고리 번호")
    ap.add_argument("--details", default=None, help="상세 URL 목록 파일(1줄 1개)")
    ap.add_argument("--sitemap-only", action="store_true",
                    help="sitemap.xml 의 product_no 전체 목록만 출력")
    ap.add_argument("--out", default="samples.csv")
    args = ap.parse_args()

    site = args.site
    rows = []

    if args.sitemap_only:
        pairs = sitemap_product_ids(site)
        print("sitemap product_no count: %d" % len(pairs))
        for pno, u in pairs[:20]:
            print("  %-8s %s" % (pno, u))
        return 0

    if args.list_pages:
        cate = args.cate or SITES[site]["all_cate"]
        base = SITES[site]["base"]
        for page in range(1, args.list_pages + 1):
            if site == "samamusic":
                url = "%sproduct/list.html?cate_no=%s&page=%d" % (base, cate, page)
            else:
                url = "%sproduct/list.html?cate_no=%s&page=%d" % (base, cate, page)
            try:
                r = get(url)
            except Exception as e:
                sys.stderr.write("list failed %s: %s\n" % (url, e))
                continue
            got = row_from_list(site, url, r.text, category="cate_no=%s p=%d" % (cate, page))
            sys.stderr.write("list p%d -> %d\n" % (page, len(got)))
            rows.extend(got)

    if args.details:
        with io.open(args.details, encoding="utf-8") as f:
            for line in f:
                u = line.strip()
                if not u or u.startswith("#"):
                    continue
                try:
                    r = get(u)
                except Exception as e:
                    sys.stderr.write("detail failed %s: %s\n" % (u, e))
                    continue
                rows.append(row_from_detail(site, u, r.text))
                sys.stderr.write("detail ok %s\n" % u)

    if not rows:
        sys.stderr.write("수집된 행이 없습니다.\n")
        return 1

    outdir = os.path.dirname(os.path.abspath(args.out))
    if outdir:
        try:
            os.makedirs(outdir)
        except OSError:
            pass
    with io.open(args.out, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for r in rows:
            w.writerow(r)
    sys.stderr.write("wrote %s (%d rows)\n" % (args.out, len(rows)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
