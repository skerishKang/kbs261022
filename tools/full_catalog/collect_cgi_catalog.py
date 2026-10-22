#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# 출처: skerishKang/kbs261022 PR #12 (브랜치 feature/site-analysis-model-b, 커밋 5814f24)
#       skills/cgi-catalog-collector/scripts/collect_cgi_catalog.py
#       모델 B가 Tri-A(삼아사운드)/Tri-B(삼아스토어) 실측으로 검증한 수집 경로·파서.
#       본 파일은 원본을 수정 없이 포함한다(이슈 #19 전수 수집 드라이버에서 import 재사용).
#       대량 실행은 tools/full_catalog/run_full_collection.py 사용(동시성 Fetcher, 동일 캐시 포맷).
# ---------------------------------------------------------------------------
# -*- coding: utf-8 -*-
"""
CGI(김범신) 공급처 공개 사이트 카탈로그 수집기 — Tri-A(삼아사운드) / Tri-B(삼아스토어).

두 사이트는 모두 Cafe24 기반이므로 공통 파서 + 사이트별 어댑터 구조로 구현한다.

설계 원칙
  1. 공개 페이지(GET)만 사용한다. 로그인/세션/결제/장바구니 쓰기 API는 호출하지 않는다.
  2. 값이 공개되지 않은 필드는 절대 추정하지 않는다. "미확인" 상태로만 기록한다.
     - published_price  : 공개된 판매가만. "가격 문의" 상품은 published_price_unavailable=1 로 표기.
     - dealer_price     : 공개 데이터 없음 → 항상 빈 값(미확인).
     - availability     : 페이지에 공개된 stock/use_soldout 표기만 기록. 추정 금지.
  3. 모든 요청은 순차 + 지연(delay)을 두고, 동일 URL은 로컬 캐시로 재사용한다.
  4. 산출물은 UTF-8 CSV 1행=1상품(상품 마스터) 및 카테고리/옵션 부속 CSV.

사용법
  python collect_cgi_catalog.py --site samasound --mode list --out out/samasound_list.csv
  python collect_cgi_catalog.py --site samamusic --mode detail --limit 20 --out out/samamusic_detail.csv
  python collect_cgi_catalog.py --site samamusic --mode sitemap --out out/samamusic_sitemap.csv

종속: python-requests, beautifulsoup4 (표준 라이브러리만으로도 동작하도록 정규식 폴백 포함)
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple

try:
    import requests
except ImportError:  # pragma: no cover
    sys.stderr.write("requests 가 필요합니다: pip install requests\n")
    raise

try:
    from bs4 import BeautifulSoup  # type: ignore
except ImportError:  # pragma: no cover
    BeautifulSoup = None  # type: ignore


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# --------------------------------------------------------------------------------------
# 사이트 정의
# --------------------------------------------------------------------------------------

SITES: Dict[str, Dict[str, Any]] = {
    "samasound": {
        "label": "Tri-A / 삼아사운드",
        "origin": "https://www.samasound.co.kr",
        "canonical_origin": "https://samasound.co.kr",
        "list_path": "/product/list.html",
        "detail_path": "/product/{slug}/{product_no}/display/{display_group}/",
        "root_cate": 23,          # 전체보기
        "brand_cate": 24,         # 브랜드별 보기
        "type_cate": 25,          # 제품분류별 보기
        "host": "www.samasound.co.kr",
        "image_host": "//www.samasound.co.kr",
    },
    "samamusic": {
        "label": "Tri-B / 삼아스토어",
        "origin": "https://www.samamusic.co.kr",
        "canonical_origin": "https://samastore.co.kr",
        "list_path": "/product/list.html",
        "detail_path": "/product/detail.html?product_no={product_no}&cate_no={cate_no}&display_group={display_group}",
        "root_cate": None,        # 전체 카테고리가 별도 노출되지 않음(사이트맵 기준)
        "host": "www.samamusic.co.kr",
        "image_host": "//www.samamusic.co.kr",
    },
}

# 상품 마스터 CSV 헤더 (보고서/스키마와 1:1 대응)
MASTER_FIELDS = [
    "source_site",
    "source_site_label",
    "source_category_id",
    "source_category_name",
    "source_category_path",
    "source_brand",
    "source_product_id",
    "source_item_code",
    "product_name",
    "model",
    "canonical_url",
    "source_list_url",
    "summary",
    "short_description",
    "manufacturer",
    "country_of_origin",
    "specs",
    "image_urls",
    "option_summary",
    "option_count",
    "published_price",
    "published_price_text",
    "published_price_state",
    "published_price_unavailable",
    "retail_list_price",
    "consumer_price",
    "min_selling_price",
    "tax_excluded_component",
    "dealer_price_unverified",
    "availability_unverified",
    "stock_display",
    "soldout_display",
    "product_code",
    "product_status_flags",
    "updated_at",
    "extraction_method",
    "verification_status",
    "source_evidence",
]


# --------------------------------------------------------------------------------------
# HTTP 클라이언트 (캐시 + 지연)
# --------------------------------------------------------------------------------------


class Fetcher:
    """순차 요청 + 디스크 캐시. 동일 URL 재요청을 차단한다."""

    def __init__(self, cache_dir: str, delay: float = 0.35, timeout: int = 30):
        self.cache_dir = cache_dir
        self.delay = delay
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT, "Accept-Language": "ko-KR,ko;q=0.9"})
        self.hits = 0
        self.misses = 0
        self._last = 0.0
        os.makedirs(self.cache_dir, exist_ok=True)

    def _key(self, url: str) -> str:
        import hashlib

        return hashlib.sha1(url.encode("utf-8")).hexdigest()

    def get(self, url: str, referer: Optional[str] = None) -> Tuple[int, str]:
        path = os.path.join(self.cache_dir, self._key(url) + ".html")
        if os.path.exists(path):
            self.hits += 1
            with open(path, "rb") as fh:
                raw = fh.read()
            return 200, raw.decode("utf-8", "replace")
        wait = self.delay - (time.time() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.time()
        headers = {"Referer": referer} if referer else {}
        try:
            resp = self.session.get(url, timeout=self.timeout, headers=headers)
        except requests.RequestException as exc:
            self.misses += 1
            return 0, f"__ERROR__{exc}"
        self.misses += 1
        if resp.status_code != 200:
            return resp.status_code, ""
        # 두 사이트 모두 UTF-8 응답. apparent_encoding(charset 유추)은 오탐 위험이 있어 고정한다.
        resp.encoding = "utf-8"
        text = resp.text
        with open(path, "wb") as fh:
            fh.write(text.encode("utf-8"))
        return resp.status_code, text


# --------------------------------------------------------------------------------------
# 파싱 유틸
# --------------------------------------------------------------------------------------

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def strip_tags(fragment: str) -> str:
    import html as _html

    text = _TAG_RE.sub(" ", fragment or "")
    text = _html.unescape(text)
    return _WS_RE.sub(" ", text).strip()


def js_var(html: str, name: str) -> Optional[str]:
    """var NAME = 'value'; / var NAME = 123; 형태의 Cafe24 프런트엔드 전역 변수를 읽는다.

    문자열 내부의 \\uXXXX 이스케이프는 JSON 규칙으로 디코딩한다(한글 깨짐 방지).
    """
    m = re.search(r"\bvar\s+" + re.escape(name) + r"\s*=\s*'((?:[^'\\]|\\.)*)'\s*;", html)
    if m:
        return _unescape_js(m.group(1))
    m = re.search(r"\bvar\s+" + re.escape(name) + r"\s*=\s*(-?\d+(?:\.\d+)?)\s*;", html)
    if m:
        return m.group(1)
    m = re.search(r"\bvar\s+" + re.escape(name) + r"\s*=\s*\"((?:[^\"\\]|\\.)*)\"\s*;", html)
    if m:
        return _unescape_js(m.group(1))
    return None


def _unescape_js(raw: str) -> str:
    try:
        return json.loads('"' + raw.replace('"', '\\"') + '"')
    except Exception:
        return (
            raw.replace("\\u", "\\u")
            .replace("\\'", "'")
            .replace('\\"', '"')
            .replace("\\\\", "\\")
        )


def js_json_var(html: str, name: str) -> Optional[Any]:
    """var NAME = '{...}'; 형태의 JSON 문자열 변수를 파싱한다."""
    raw = js_var(html, name)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def set_category_cookie(html: str) -> Dict[str, Any]:
    """setCategoryCookie({"category_no":84,"category_name":"마이크"}) 를 읽는다."""
    m = re.search(r"setCategoryCookie\((\{.*?\})\)", html, re.S)
    if not m:
        return {}
    try:
        return json.loads(m.group(1))
    except Exception:
        return {}


def breadcrumb_categories(html: str) -> List[Dict[str, Any]]:
    """현재 위치 경로에서 (id, name) 목록을 추출한다."""
    idx = html.find("xans-product-headcategory path")
    if idx < 0:
        return []
    seg = html[idx : idx + 3000]
    ol = re.search(r"<ol[^>]*>(.*?)</ol>", seg, re.S)
    if not ol:
        return []
    out: List[Dict[str, Any]] = []
    for href, name in re.findall(r'<li[^>]*>\s*<a href="([^"]*)"[^>]*>(.*?)</a>', ol.group(1), re.S):
        cid = None
        m = re.search(r"/category/[^/]+/(\d+)/", href) or re.search(r"cate_no=(\d+)", href)
        if m:
            cid = int(m.group(1))
        out.append({"id": cid, "name": strip_tags(name)})
    return out


def find_basic_info_rows(html: str) -> Dict[str, str]:
    """'기본 정보' 표에서 th/td 쌍을 {라벨: 값} 으로 추출한다."""
    rows: Dict[str, str] = {}
    idx = html.find("xans-product-detaildesign")
    if idx < 0:
        return rows
    seg = html[idx : idx + 40000]
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", seg, re.S):
        th = re.search(r"<th[^>]*>(.*?)</th>", tr, re.S)
        td = re.search(r"<td[^>]*>(.*?)</td>", tr, re.S)
        if not th or not td:
            continue
        label = strip_tags(th.group(1))
        value = strip_tags(td.group(1))
        if label and label not in rows:
            rows[label] = value
    return rows


def breadcrumb(html: str) -> List[str]:
    """현재 위치( 카테고리 경로 )를 추출한다."""
    idx = html.find("xans-product-headcategory path")
    if idx < 0:
        return []
    seg = html[idx : idx + 3000]
    ol = re.search(r"<ol[^>]*>(.*?)</ol>", seg, re.S)
    if not ol:
        return []
    out = []
    for li in re.findall(r"<li[^>]*>(.*?)</li>", ol.group(1), re.S):
        txt = strip_tags(li)
        if txt:
            out.append(txt)
    return out


def registered_count(html: str) -> Optional[int]:
    m = re.search(r"등록 제품\s*:\s*<strong>(\d+)</strong>", html)
    return int(m.group(1)) if m else None


def last_page(html: str) -> Optional[int]:
    for pat in (
        r'class="last"[^>]*href="[^"]*[?&]page=(\d+)"',
        r'href="[^"]*[?&]page=(\d+)"[^>]*class="last"',
        r'class="last"[^>]*href="[^"]*page=(\d+)"',
    ):
        m = re.search(pat, html)
        if m:
            return int(m.group(1))
    return None


def extract_images(html: str) -> List[str]:
    """대표 이미지(큰 크기) + 추가/외부 이미지 URL 목록(중복 제거, 원본 URL)."""
    urls: List[str] = []
    for m in re.finditer(r'<img[^>]+src="([^"]+)"[^>]*(?:class="(?:BigImage|ThumbImage)")', html):
        urls.append(m.group(1))
    for m in re.finditer(r'<img[^>]+data-src="([^"]+)"', html):
        urls.append(m.group(1))
    seen, out = set(), []
    for u in urls:
        if not u or u in ("", "#"):
            continue
        u = u.split("?")[0]
        if u in seen:
            continue
        seen.add(u)
        out.append(u if u.startswith("http") else ("https:" + u if u.startswith("//") else u))
    return out


def extract_option_table(html: str) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """(메인상품 옵션, 추가구성상품(추가상품) 옵션) 을 추출한다.

    Cafe24 옵션 분류
      * product_option_area="product_option_XXX"  → 메인 상품 옵션
      * product_option_area="addproduct_option_XXX" → 추가구성상품 자체의 옵션
      * id/name="addproduct_option_(id|name)_XXX"  → 옵션이 없는 추가구성상품의 '상품선택' 드롭다운
    옵션 추가금액/재고 표기는 JS add_option_data 로 제공된다.
    """
    main: List[Dict[str, Any]] = []
    addp: List[Dict[str, Any]] = []
    for m in re.finditer(r"<select\b([^>]*)>(.*?)</select>", html, re.S):
        attrs = m.group(1)
        body = m.group(2)
        tm = re.search(r'option_title="([^"]*)"', attrs)
        title = strip_tags(tm.group(1)) if tm else ""
        values, item_codes = [], []
        for opt in re.findall(r'<option\s+value="([^"]*)"[^>]*>(.*?)</option>', body, re.S):
            val, text = opt[0], strip_tags(opt[1])
            if val in ("*", "**"):
                continue
            values.append(text or val)
            if re.fullmatch(r"[A-Z0-9]{6,}", val or ""):
                item_codes.append(val)
        area = re.search(r'product_option_area="([^"]*)"', attrs)
        idm = re.search(r'addproduct_option_(?:id|name)_(\d+)', attrs)
        otm = re.search(r'(?<!product_)option_type="([^"]*)"', attrs)
        rec: Dict[str, Any] = {
            "option_name": title,
            "values": values,
            "item_codes": item_codes,
            "option_area": area.group(1) if area else None,
            "option_type": otm.group(1) if otm else None,
        }
        if idm:
            rec["addproduct_no"] = int(idm.group(1))
            addp.append(rec)
        elif area and area.group(1).startswith("addproduct_option_"):
            am = re.search(r"addproduct_option_(\d+)", area.group(1))
            rec["addproduct_no"] = int(am.group(1)) if am else None
            addp.append(rec)
        elif area and area.group(1).startswith("product_option_"):
            main.append(rec)
        else:
            # 배송국가/검색조건 등 상품 옵션이 아닌 select 는 제외한다.
            continue
    return main, addp


def extract_addon_products(html: str) -> List[Dict[str, Any]]:
    """추가구성상품(추가상품) 목록: product_no / 상품명 / 가격 / 품절 표기."""
    out: List[Dict[str, Any]] = []
    for m in re.finditer(
        r'<li class="product xans-record-">(.*?)(?=<li class="product xans-record-">|\Z)', html, re.S
    ):
        block = m.group(1)
        pid = re.search(r"/product/detail\.html\?product_no=(\d+)", block)
        if not pid:
            continue
        name = re.search(r'<p class="name"[^>]*>(.*?)</p>', block, re.S)
        price = re.search(r'<p class="price[^"]*"[^>]*>(.*?)</p>', block, re.S)
        soldout = "품절" in block
        out.append(
            {
                "addproduct_no": int(pid.group(1)),
                "name": strip_tags(name.group(1)) if name else "",
                "price_text": strip_tags(price.group(1)) if price else "",
                "soldout_marked": soldout,
            }
        )
    return out


def parse_add_option_data(html: str) -> List[Dict[str, Any]]:
    """add_option_data JSON → 옵션별 추가금액/재고표기 파라미터."""
    raw = js_var(html, "add_option_data")
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except Exception:
        return []
    out: List[Dict[str, Any]] = []
    for add_no, info in (data or {}).items():
        stock_blob = info.get("option_stock_data")
        try:
            stock = json.loads(stock_blob) if isinstance(stock_blob, str) else (stock_blob or {})
        except Exception:
            stock = {}
        for item_code, opt in stock.items():
            added = opt.get("origin_option_added_price")
            try:
                added_num = float(added) if added not in (None, "") else None
            except (TypeError, ValueError):
                added_num = None
            out.append(
                {
                    "addproduct_no": int(add_no) if str(add_no).isdigit() else add_no,
                    "addproduct_name": info.get("product_name"),
                    "item_code": item_code,
                    "option_name": opt.get("option_name"),
                    "option_value": opt.get("option_value"),
                    "option_price": opt.get("option_price"),
                    "origin_option_added_price": added_num,
                    "stock_number": opt.get("stock_number"),
                    "use_soldout": opt.get("use_soldout"),
                    "is_selling": opt.get("is_selling"),
                    "soldout_rendered": bool((opt.get("stock_number") or 0) == 0),
                }
            )
    return out


def enrich_option_values(options: List[Dict[str, Any]], add_data: List[Dict[str, Any]]) -> None:
    """옵션 값에 추가금액/품절 표기를 붙인다(브라우저 렌더링과 동일한 정보원)."""
    idx: Dict[Tuple[Any, str], Dict[str, Any]] = {}
    for row in add_data:
        idx[(row.get("addproduct_no"), row.get("option_value"))] = row
    for opt in options:
        target = opt.get("addproduct_no")
        if target is None:
            continue
        enriched = []
        for v in opt.get("values", []):
            key = (target, v)
            row = idx.get(key)
            if row:
                v2 = v
                if row.get("origin_option_added_price"):
                    v2 += f" (+{int(row['origin_option_added_price']):,}원)"
                if row.get("soldout_rendered"):
                    v2 += " [품절]"
                enriched.append(v2)
            else:
                enriched.append(v)
        opt["values"] = enriched


def normalize_price(text: str) -> Optional[int]:
    if not text:
        return None
    m = re.search(r"([0-9][0-9,]*)\s*원", text) or re.search(r"([0-9][0-9,]*)", text)
    if not m:
        return None
    return int(m.group(1).replace(",", ""))


# --------------------------------------------------------------------------------------
# 목록 파서
# --------------------------------------------------------------------------------------


def _last_span_text(container: str) -> str:
    """컨테이너 안의 마지막 <span ...>TEXT</span> 텍스트를 반환한다(레이블 span 제외용)."""
    spans = re.findall(r"<span\b[^>]*>(.*?)</span>", container, re.S)
    for sp in reversed(spans):
        txt = strip_tags(sp)
        if txt:
            return txt
    return ""


def parse_list_samasound(html: str) -> List[Dict[str, Any]]:
    out = []
    for m in re.finditer(r'<li id="anchorBoxId_(\d+)"(.*?)(?=<li id="anchorBoxId_|\Z)', html, re.S):
        pid = m.group(1)
        block = m.group(2)
        href = re.search(r'<a href="(/product/[^"]+)"', block)
        if not href:
            continue
        url = href.group(1)
        img = re.search(r'<img[^>]+src="([^"]+)"[^>]*alt="([^"]*)"', block)
        name = ""
        nblock = re.search(r'<strong class="name">(.*?)</strong>', block, re.S)
        if nblock:
            name = _last_span_text(nblock.group(1))
        summary = ""
        sblock = re.search(r'xans-product-listitem spec"[^>]*>(.*?)</ul>', block, re.S)
        if sblock:
            summary = _last_span_text(sblock.group(1))
        out.append(
            {
                "product_id": pid,
                "name": name,
                "summary": summary,
                "list_url": url,
                "image": ("https:" + img.group(1)) if img and img.group(1).startswith("//") else (img.group(1) if img else ""),
                "image_alt": img.group(2) if img else "",
                "list_price": None,
                "product_code": None,
            }
        )
    return out


def parse_price_attr(raw: str) -> Tuple[Optional[int], Optional[int]]:
    """Cafe24 data-price 속성을 (정가/원가, 판매가) 로 분리한다.

    Cafe24 규칙: "정가^판매가" (정가 생략 시 "^판매가"), 값이 "전화 문의" 등 비숫자면 판매가 미확인.
    """
    if not raw:
        return None, None
    parts = raw.split("^")
    retail: Optional[int] = None
    sale: Optional[int] = None
    if len(parts) == 1:
        sale = _to_int(parts[0])
    else:
        retail = _to_int(parts[0])
        sale = _to_int(parts[1])
    return retail, sale


def _to_int(text: str) -> Optional[int]:
    m = re.search(r"([0-9][0-9,]*)", text or "")
    return int(m.group(1).replace(",", "")) if m else None


def normalize_price_text(text: str) -> str:
    """가격 표기 문자열을 표준 상태 토큰으로 정규화한다(추정 금지, 표기 정규화만)."""
    t = re.sub(r"\s+", " ", (text or "")).strip()
    if not t:
        return "empty"
    if re.search(r"판매\s*완료|판매완료", t):
        return "sold_out_sale_completed"
    if re.search(r"판매\s*불료|판매불료|미판매", t):
        return "not_for_sale"
    if re.search(r"문의", t):
        return "inquiry_price"
    if re.search(r"[0-9]", t):
        return "numeric_price"
    return "other"


def parse_list_samamusic(html: str) -> List[Dict[str, Any]]:
    out = []
    for m in re.finditer(r'<li id="anchorBoxId_(\d+)"([^>]*)>(.*?)(?=<li id="anchorBoxId_|\Z)', html, re.S):
        pid = m.group(1)
        attrs = m.group(2)
        block = m.group(3)
        href = re.search(r'<a href="(/product/detail\.html\?product_no=\d+[^"]*)"', block)
        if not href:
            continue
        retail, sale = parse_price_attr(
            (re.search(r'data-price="([^"]*)"', attrs) or [None, ""])[1]
        )
        img = re.search(r'<img[^>]+src="([^"]+)"[^>]*id="eListPrdImage', block)
        name = ""
        nblock = re.search(r'<p class="name">(.*?)</p>', block, re.S)
        if nblock:
            name = _last_span_text(nblock.group(1))
        summary = ""
        sblock = re.search(r'xans-product-listitem spec"[^>]*>(.*?)</ul>', block, re.S)
        if sblock:
            summary = _last_span_text(sblock.group(1))
        pcode = None
        pcm = re.search(r"category_add_basket\([^)]*?,'([A-Z0-9]{6,})'\)", block)
        if pcm:
            pcode = pcm.group(1)
        out.append(
            {
                "product_id": pid,
                "name": name,
                "summary": summary,
                "list_url": href.group(1),
                "image": ("https:" + img.group(1)) if img and img.group(1).startswith("//") else (img.group(1) if img else ""),
                "image_alt": "",
                "list_price": sale,
                "list_retail_price": retail,
                "product_code": pcode,
            }
        )
    return out


LIST_PARSERS = {"samasound": parse_list_samasound, "samamusic": parse_list_samamusic}


# --------------------------------------------------------------------------------------
# 상세 파서
# --------------------------------------------------------------------------------------


def parse_detail(html: str, site: str, product_id: str, list_url: str) -> Dict[str, Any]:
    cfg = SITES[site]
    basic = find_basic_info_rows(html)
    main_opts, add_opts = extract_option_table(html)
    add_data = parse_add_option_data(html)
    enrich_option_values(add_opts, add_data)
    stock = js_json_var(html, "single_option_stock_data") or {}
    cat_cookie = set_category_cookie(html)
    crumbs = breadcrumb_categories(html)
    cat_id = cat_cookie.get("category_no")
    cat_name = cat_cookie.get("category_name")
    if cat_id in (None, 0, "0"):
        leaf = [c for c in crumbs if c.get("id")]
        if leaf:
            cat_id = leaf[-1]["id"]
            cat_name = leaf[-1]["name"]
    cat_path = " > ".join(c["name"] for c in crumbs if c.get("name"))

    price_text = basic.get("판매가") or ""
    price_js = js_var(html, "product_price")
    price_val: Optional[int] = None
    price_unavailable = 0
    if price_js and price_js.isdigit() and int(price_js) > 0:
        price_val = int(price_js)
    else:
        parsed = normalize_price(price_text)
        if parsed and "문의" not in price_text:
            price_val = parsed
    if price_val is None:
        price_unavailable = 1
    price_state = normalize_price_text(price_text)

    # 상세 infoArea 의 data-price="정가^판매가" 로 정가(할인가 기준가)를 확보한다.
    retail_val: Optional[int] = None
    dm = re.search(r'class="infoArea[^"]*"[^>]*data-price="([^"]*)"', html)
    if dm:
        r2, s2 = parse_price_attr(dm.group(1))
        retail_val = r2 if (r2 or 0) > 0 else None  # 0.00 은 '정가 미설정' 표기
        if price_val is None and s2:
            price_val = s2

    brand = basic.get("브랜드") or basic.get("제조사") or ""
    model = basic.get("모델명") or ""
    consumer_price = normalize_price(basic.get("소비자가") or "") or ""
    retail_price_row = normalize_price(basic.get("최저판매가") or "") or ""
    canonical = ""
    cm = re.search(r'<link[^>]+rel="canonical"[^>]+href="([^"]+)"', html)
    if cm:
        canonical = cm.group(1)
    else:
        lpd = js_var(html, "link_product_detail") or ""
        canonical = (cfg.get("canonical_origin") or cfg["origin"]) + lpd
        canonical = re.sub(r"/display/\d+/?$", "/", canonical)
    canonical = canonical.rstrip("/") + "/" if canonical else canonical
    if canonical.startswith("http://"):
        canonical = "https://" + canonical[7:]

    soldout_display = ""
    sold = js_var(html, "is_soldout_icon")
    if sold == "T":
        soldout_display = "soldout_icon"
    a_soldout = js_json_var(html, "aSoldoutDisplay") or {}
    if a_soldout:
        soldout_display = ",".join(sorted({str(v) for v in a_soldout.values()}))

    opt_count = len(main_opts) + len(add_opts)
    flags = []
    if stock.get("use_stock") is False:
        flags.append("use_stock=false")
    if stock.get("use_soldout") == "T":
        flags.append("use_soldout=T")
    if stock.get("is_reserve_stat") == "Y":
        flags.append("reserve_stock=Y")
    if js_var(html, "option_type") == "T":
        flags.append("option_type=T")
    if js_var(html, "has_option") == "T":
        flags.append("has_option=T")
    if js_var(html, "item_listing_type") == "S":
        flags.append("item_listing_type=S")

    return {
        "source_site": site,
        "source_site_label": cfg["label"],
        "source_category_id": cat_id,
        "source_category_name": cat_name,
        "source_category_path": cat_path,
        "source_brand": brand,
        "source_product_id": product_id,
        "source_item_code": js_var(html, "item_code") or "",
        "product_name": js_var(html, "product_name") or basic.get("상품명") or "",
        "model": model,
        "canonical_url": canonical,
        "source_list_url": list_url,
        "summary": basic.get("상품요약정보") or "",
        "short_description": basic.get("상품간략설명") or "",
        "manufacturer": basic.get("제조사") or "",
        "country_of_origin": basic.get("원산지") or "",
        "specs": json.dumps(basic, ensure_ascii=False, sort_keys=True),
        "image_urls": "|".join(extract_images(html)),
        "option_summary": json.dumps(
            {
                "main": main_opts,
                "addproduct_options": add_opts,
                "addproducts": extract_addon_products(html),
                "add_option_data": add_data,
            },
            ensure_ascii=False,
        ),
        "option_count": opt_count,
        "published_price": price_val if price_val is not None else "",
        "published_price_text": price_text,
        "published_price_state": price_state,
        "published_price_unavailable": price_unavailable,
        "retail_list_price": retail_val if retail_val is not None else "",
        "consumer_price": consumer_price,
        "min_selling_price": retail_price_row,
        "tax_excluded_component": js_var(html, "_iPrdtPriceOrg") or "",
        "dealer_price_unverified": "",
        "availability_unverified": json.dumps(
            {"stock_number_displayed": js_var(html, "stock_number"),
             "use_stock": stock.get("use_stock"),
             "use_soldout": stock.get("use_soldout"),
             "is_reserve_stat": stock.get("is_reserve_stat")},
            ensure_ascii=False,
        ),
        "stock_display": js_var(html, "stock_number") or "",
        "soldout_display": soldout_display,
        "product_code": js_var(html, "product_code") or "",
        "product_status_flags": ";".join(flags),
        "updated_at": "",
        "extraction_method": "http_get_public_html" if site == "samamusic" else "http_get_public_html",
        "verification_status": "verified_against_source_page",
        "source_evidence": list_url,
    }


# --------------------------------------------------------------------------------------
# 수집 모드
# --------------------------------------------------------------------------------------


def collect_list(fetcher: Fetcher, site: str, cate_no: int, max_pages: int, out_path: str,
                 delay_note: str = "") -> int:
    cfg = SITES[site]
    parser = LIST_PARSERS[site]
    rows: Dict[str, Dict[str, Any]] = {}
    page = 1
    total_pages: Optional[int] = None
    while page <= max_pages:
        url = f"{cfg['origin']}{cfg['list_path']}?cate_no={cate_no}&page={page}"
        status, html = fetcher.get(url)
        if status != 200 or not html:
            break
        if total_pages is None:
            total_pages = last_page(html)
            count = registered_count(html)
            print(f"[{site}] cate_no={cate_no} 등록상품={count} 페이지수={total_pages}", file=sys.stderr)
        items = parser(html)
        if not items:
            break
        for it in items:
            it["category_id"] = cate_no
            it["list_page_url"] = url
            rows[it["product_id"]] = it
        page += 1
    fields = [
        "source_site", "source_site_label", "category_id", "product_id", "name", "summary",
        "list_price", "product_code", "list_url", "image", "list_page_url",
    ]
    with open(out_path, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        for it in rows.values():
            w.writerow(
                {
                    "source_site": site,
                    "source_site_label": cfg["label"],
                    "category_id": it.get("category_id"),
                    "product_id": it["product_id"],
                    "name": it["name"],
                    "summary": it["summary"],
                    "list_price": it["list_price"] if it["list_price"] is not None else "",
                    "product_code": it.get("product_code") or "",
                    "list_url": cfg["origin"] + it["list_url"],
                    "image": it["image"],
                    "list_page_url": it["list_page_url"],
                }
            )
    print(f"[{site}] cate_no={cate_no} 수집 {len(rows)}건 -> {out_path}", file=sys.stderr)
    return len(rows)


def collect_detail(fetcher: Fetcher, site: str, ids: Iterable[str], out_path: str) -> int:
    cfg = SITES[site]
    n = 0
    fields = MASTER_FIELDS
    with open(out_path, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        for pid in ids:
            if site == "samamusic":
                url = f"{cfg['origin']}/product/detail.html?product_no={pid}&cate_no=1&display_group=1"
            else:
                url = f"{cfg['origin']}/product/detail.html?product_no={pid}"
            status, html = fetcher.get(url, referer=cfg["origin"] + "/")
            if status != 200 or not html:
                print(f"[{site}] detail 실패 {pid} status={status}", file=sys.stderr)
                continue
            rec = parse_detail(html, site, pid, url)
            w.writerow({k: rec.get(k, "") for k in fields})
            n += 1
    print(f"[{site}] detail {n}건 -> {out_path}", file=sys.stderr)
    return n


def collect_sitemap(fetcher: Fetcher, site: str, out_path: str) -> int:
    cfg = SITES[site]
    url = f"{cfg['origin']}/sitemap.xml"
    status, html = fetcher.get(url)
    if status != 200:
        print(f"[{site}] sitemap 실패 status={status}", file=sys.stderr)
        return 0
    locs = re.findall(r"<loc>(.*?)</loc>", html)
    rows = []
    for loc in locs:
        m = re.match(r"^(https?://[^/]+)/product/(?:detail\.html\?product_no=(\d+)|([^/]+)/(\d+)/)", loc)
        if not m:
            continue
        pid = m.group(2) or m.group(4)
        rows.append({"source_site": site, "url": loc, "product_id": pid, "lastmod": ""})
    with open(out_path, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=["source_site", "url", "product_id", "lastmod"])
        w.writeheader()
        for r in rows:
            w.writerow(r)
    print(f"[{site}] sitemap product {len(rows)}건 -> {out_path}", file=sys.stderr)
    return len(rows)


CATEGORY_FIELDS = [
    "source_site", "category_id", "category_name", "category_path", "registered_count",
    "total_pages", "child_categories", "product_count_on_site", "list_url",
]


def collect_category(fetcher: Fetcher, site: str, cate_no: int) -> Optional[Dict[str, Any]]:
    """카테고리 1개를 탐색해 (메타 + 하위 카테고리 + 수집 상품수) 를 반환한다."""
    cfg = SITES[site]
    parser = LIST_PARSERS[site]
    url = f"{cfg['origin']}{cfg['list_path']}?cate_no={cate_no}"
    status, html = fetcher.get(url)
    if status != 200 or not html:
        print(f"[{site}] category 실패 cate_no={cate_no} status={status}", file=sys.stderr)
        return None
    crumbs = breadcrumb_categories(html)
    children: List[Dict[str, Any]] = []
    for href, name in re.findall(r'<a href="(/category/[^"]+)"[^>]*>(.*?)</a>', html):
        m = re.search(r"/category/[^/]+/(\d+)/", href)
        if not m:
            continue
        nm = strip_tags(name)
        if not nm:
            continue
        children.append({"id": int(m.group(1)), "name": nm, "url": cfg["origin"] + href})
    seen = set()
    uniq_children = []
    for c in children:
        if c["id"] in seen:
            continue
        seen.add(c["id"])
        uniq_children.append(c)

    total_pages = last_page(html) or 1
    rows: Dict[str, Dict[str, Any]] = {}
    for page in range(1, total_pages + 1):
        purl = url if page == 1 else f"{url}&page={page}"
        st, ph = fetcher.get(purl)
        if st != 200 or not ph:
            break
        for it in parser(ph):
            it["category_id"] = cate_no
            it["list_page_url"] = purl
            rows[it["product_id"]] = it

    print(
        f"[{site}] cate {cate_no} ({crumbs[-1]['name'] if crumbs else '?'}) "
        f"등록={registered_count(html)} 페이지={total_pages} 수집상품={len(rows)} 자식카테고리={len(uniq_children)}",
        file=sys.stderr,
    )
    return {
        "source_site": site,
        "category_id": cate_no,
        "category_name": crumbs[-1]["name"] if crumbs else "",
        "category_path": " > ".join(c["name"] for c in crumbs if c.get("name")),
        "registered_count": registered_count(html) or "",
        "total_pages": total_pages,
        "child_categories": json.dumps(uniq_children, ensure_ascii=False),
        "product_count_on_site": len(rows),
        "list_url": url,
    }


def collect_categories(fetcher: Fetcher, site: str, cate_nos: Iterable[int], out_path: str) -> int:
    """여러 카테고리를 순회해 카테고리 메타 CSV를 만든다."""
    out_rows: List[Dict[str, Any]] = []
    for cid in cate_nos:
        rec = collect_category(fetcher, site, cid)
        if rec:
            out_rows.append(rec)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=CATEGORY_FIELDS)
        w.writeheader()
        for r in out_rows:
            w.writerow(r)
    print(f"[{site}] category meta {len(out_rows)}건 -> {out_path}", file=sys.stderr)
    return len(out_rows)


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="CGI 공급처 공개 카탈로그 수집기")
    ap.add_argument("--site", required=True, choices=sorted(SITES))
    ap.add_argument("--mode", required=True, choices=["list", "detail", "sitemap", "category", "categories"])
    ap.add_argument("--cate-no", type=int, default=None)
    ap.add_argument("--ids", default=None, help="쉼표로 구분한 product_no 목록 (detail 모드)")
    ap.add_argument("--ids-file", default=None, help="product_no 목록 파일 (1줄 1개)")
    ap.add_argument("--max-pages", type=int, default=500)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--delay", type=float, default=0.35)
    ap.add_argument("--cache", default=".cache/cgi-catalog")
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    fetcher = Fetcher(args.cache, delay=args.delay)

    if args.mode == "sitemap":
        collect_sitemap(fetcher, args.site, args.out)
    elif args.mode == "list":
        cate = args.cate_no if args.cate_no is not None else SITES[args.site]["root_cate"]
        collect_list(fetcher, args.site, cate, args.max_pages, args.out)
    elif args.mode == "category":
        cate = args.cate_no if args.cate_no is not None else SITES[args.site]["root_cate"]
        rec = collect_category(fetcher, args.site, cate)
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", newline="", encoding="utf-8-sig") as fh:
            w = csv.DictWriter(fh, fieldnames=CATEGORY_FIELDS)
            w.writeheader()
            if rec:
                w.writerow(rec)
    elif args.mode == "categories":
        if not args.ids:
            ap.error("categories 모드에는 --ids(카테고리 id 목록)가 필요하다")
        ids = [int(x.strip()) for x in args.ids.split(",") if x.strip()]
        collect_categories(fetcher, args.site, ids, args.out)
    elif args.mode == "detail":
        ids: List[str] = []
        if args.ids:
            ids = [x.strip() for x in args.ids.split(",") if x.strip()]
        elif args.ids_file:
            with open(args.ids_file, encoding="utf-8") as fh:
                ids = [ln.strip() for ln in fh if ln.strip()]
        if args.limit:
            ids = ids[: args.limit]
        collect_detail(fetcher, args.site, ids, args.out)
    else:
        ap.error("unsupported mode")

    print(f"http cache hit={fetcher.hits} miss={fetcher.misses}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
