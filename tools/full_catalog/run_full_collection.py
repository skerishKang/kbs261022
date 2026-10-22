#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
run_full_collection.py -- 전체 상품 대량 수집 드라이버 (이슈 #19)

기존 분석 결과를 재사용한다.
  - 파서/분석 로직: PR #12 `skills/cgi-catalog-collector/scripts/collect_cgi_catalog.py`
    를 `tools/full_catalog/collect_cgi_catalog.py` 에 그대로 포함(출처 표기)하고 import 해서 사용한다.
  - 카테고리 발견 경로(기존 검증값):
      * samasound(삼아사운드): sitemap 없음 → cate_no 1..520 스위프 + 하위 카테고리(유효 361)
      * samamusic(삼아스토어, canonical samastore.co.kr): sitemap.xml 의 /category/<name>/<id>/ 532개
  - 목록 크롤 → 상품 ID 집합 → 상세 크롤 순서. 동일 URL 은 디스크 캐시로 재사용.

규칙(PR #12 수집 규칙 준수)
  * 공개 GET 만 사용. 로그인/장바구니/주문/ERP/네이버 쓰기 API 없음.
  * robots.txt Disallow 경로(/admin /api /exec/front/ /member/ /myshop/ /protected/ /skin-*/ board·article 쓰기)는 방문하지 않는다.
  * 가격/공급가/재고는 공개 표기만 기록하고 추정하지 않는다.
  * 동시 요청은 소량(기본 6)으로 제한하고 호스트별 지연을 둔다.

사용 예
  python tools/full_catalog/run_full_collection.py --stage all --cache C:/cgi-cache --out data/full_catalog
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collect_cgi_catalog as CC  # noqa: E402  (PR #12 파서 재사용)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

ROBOTS_DISALLOW_PREFIX = [
    "/admin", "/api", "/exec/front/", "/member/", "/myshop/", "/protected/", "/skin-",
]


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def robots_allowed(url: str) -> bool:
    """두 사이트 robots.txt 의 Disallow 패턴 중 수집 대상과 충돌하는 경로를 막는다."""
    path = urllib.parse.urlparse(url).path or "/"
    for prefix in ROBOTS_DISALLOW_PREFIX:
        if path.startswith(prefix):
            return False
    if re.search(r"/(board|article)/", path) and any(k in path for k in ("write", "reply", "modify")):
        return False
    # list.html?cate_no=N&page=M 형태는 허용(Disallow 는 /*page_4= /*page_6= 뿐)
    return True


class ConcurrentFetcher:
    """스레드 안전 디스크 캐시 + 소량 동시 요청 HTTP 클라이언트."""

    def __init__(self, cache_dir: str, delay: float = 0.2, workers: int = 6, timeout: int = 40):
        self.cache_dir = cache_dir
        self.delay = delay
        self.timeout = timeout
        os.makedirs(cache_dir, exist_ok=True)
        self._local = threading.local()
        self._lock = threading.Lock()
        self._last = 0.0
        self.hits = 0
        self.misses = 0
        self.errors = 0

    def _session(self) -> requests.Session:
        s = getattr(self._local, "session", None)
        if s is None:
            s = requests.Session()
            s.headers.update({"User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9"})
            self._local.session = s
        return s

    def _path(self, url: str) -> str:
        return os.path.join(self.cache_dir, hashlib.sha1(url.encode("utf-8")).hexdigest() + ".html")

    def get(self, url: str, referer: Optional[str] = None) -> Tuple[int, str]:
        if not robots_allowed(url):
            return 0, ""
        path = self._path(url)
        if os.path.exists(path):
            with self._lock:
                self.hits += 1
            with open(path, "rb") as fh:
                return 200, fh.read().decode("utf-8", "replace")
        with self._lock:
            wait = self.delay - (time.time() - self._last)
            self._last = time.time()
        if wait > 0:
            time.sleep(wait)
        headers = {"Referer": referer} if referer else {}
        for attempt in range(3):
            try:
                resp = self._session().get(url, timeout=self.timeout, headers=headers)
            except requests.RequestException as exc:
                with self._lock:
                    self.errors += 1
                if attempt == 2:
                    return 0, f"__ERROR__{exc}"
                time.sleep(1.5 * (attempt + 1))
                continue
            with self._lock:
                self.misses += 1
            if resp.status_code != 200:
                return resp.status_code, ""
            resp.encoding = "utf-8"
            text = resp.text
            tmp = path + ".tmp"
            with open(tmp, "wb") as fh:
                fh.write(text.encode("utf-8"))
            os.replace(tmp, path)
            return 200, text
        return 0, ""


# ---------------------------------------------------------------- 카테고리 발견
def discover_samasound_categories(fetcher: ConcurrentFetcher, max_id: int = 520) -> List[int]:
    """sitemap 이 없는 Tri-A: cate_no 스위프로 유효 카테고리(브레드크럼 존재)만 채택."""
    cfg = CC.SITES["samasound"]
    valid: List[int] = []

    def probe(cid: int) -> Optional[int]:
        url = f"{cfg['origin']}{cfg['list_path']}?cate_no={cid}"
        status, html = fetcher.get(url)
        if status != 200 or not html:
            return None
        crumbs = CC.breadcrumb_categories(html)
        return cid if crumbs else None

    with ThreadPoolExecutor(max_workers=6) as ex:
        futures = {ex.submit(probe, cid): cid for cid in range(1, max_id + 1)}
        done = 0
        for fut in as_completed(futures):
            done += 1
            res = fut.result()
            if res:
                valid.append(res)
            if done % 100 == 0:
                log(f"  samasound category sweep {done}/{max_id} valid={len(valid)}")
    valid.sort()
    log(f"samasound categories discovered: {len(valid)}")
    return valid


def discover_samamusic_categories(fetcher: ConcurrentFetcher, extra_sweep: int = 520) -> List[int]:
    """Tri-B: sitemap 의 /category/<name>/<id>/ 532개 + 스위프로 보강."""
    cfg = CC.SITES["samamusic"]
    ids = set()
    status, xml = fetcher.get("https://samastore.co.kr/sitemap.xml")
    if status == 200 and xml:
        for loc in re.findall(r"<loc>(.*?)</loc>", xml):
            m = re.search(r"/category/[^/]+/(\d+)/?", loc)
            if m:
                ids.add(m.group(1))
    log(f"samamusic categories from sitemap: {len(ids)}")

    def probe(cid: int) -> Optional[int]:
        url = f"{cfg['origin']}{cfg['list_path']}?cate_no={cid}"
        status, html = fetcher.get(url)
        if status != 200 or not html:
            return None
        return cid if CC.breadcrumb_categories(html) else None

    with ThreadPoolExecutor(max_workers=6) as ex:
        futures = {ex.submit(probe, cid): cid for cid in range(1, extra_sweep + 1)}
        done = 0
        for fut in as_completed(futures):
            done += 1
            res = fut.result()
            if res:
                ids.add(res)
            if done % 100 == 0:
                log(f"  samamusic category sweep {done}/{extra_sweep} total={len(ids)}")
    log(f"samamusic categories discovered: {len(ids)}")
    return sorted(ids, key=int)


# ------------------------------------------------------------------- 목록 크롤
def crawl_lists(fetcher: ConcurrentFetcher, site: str, cate_ids: List[int], max_pages: int = 400) -> Dict[str, dict]:
    cfg = CC.SITES[site]
    parser = CC.LIST_PARSERS[site]
    rows: Dict[str, dict] = {}
    lock = threading.Lock()

    def crawl_category(cid: int) -> Tuple[int, List[dict], int]:
        got: List[dict] = []
        page = 1
        while page <= max_pages:
            url = f"{cfg['origin']}{cfg['list_path']}?cate_no={cid}&page={page}"
            status, html = fetcher.get(url)
            if status != 200 or not html:
                break
            items = parser(html)
            if not items:
                break
            for it in items:
                it["category_id"] = cid
                it["list_page_url"] = url
            got.extend(items)
            last = CC.last_page(html)
            if last and page >= last:
                break
            page += 1
        return cid, got, page

    done = 0
    with ThreadPoolExecutor(max_workers=6) as ex:
        futures = {ex.submit(crawl_category, cid): cid for cid in cate_ids}
        for fut in as_completed(futures):
            cid, items, pages = fut.result()
            done += 1
            with lock:
                for it in items:
                    rows.setdefault(str(it["product_id"]), it)
            if done % 50 == 0:
                log(f"  {site} lists {done}/{len(cate_ids)} unique_products={len(rows)}")
    log(f"{site} list crawl done: categories={len(cate_ids)} unique_products={len(rows)}")
    return rows


# ------------------------------------------------------------------- 상세 크롤
def crawl_details(fetcher: ConcurrentFetcher, site: str, products: Dict[str, dict]) -> List[dict]:
    cfg = CC.SITES[site]
    out: List[dict] = []
    lock = threading.Lock()

    def one(item: Tuple[str, dict]) -> Optional[dict]:
        pid, meta = item
        if site == "samamusic":
            cid = str(meta.get("category_id") or "1")
            url = (f"{cfg['origin']}/product/detail.html?product_no={pid}"
                   f"&cate_no={cid}&display_group=1")
        else:
            url = f"{cfg['origin']}/product/detail.html?product_no={pid}"
        status, html = fetcher.get(url, referer=cfg["origin"] + "/")
        if status != 200 or not html:
            return None
        rec = CC.parse_detail(html, site, pid, meta.get("list_url") or url)
        return rec

    items = list(products.items())
    done = 0
    with ThreadPoolExecutor(max_workers=6) as ex:
        futures = [ex.submit(one, it) for it in items]
        for fut in as_completed(futures):
            done += 1
            rec = fut.result()
            if rec:
                with lock:
                    out.append(rec)
            if done % 250 == 0:
                log(f"  {site} details {done}/{len(items)} ok={len(out)}")
    log(f"{site} detail crawl done: {len(out)}/{len(items)}")
    return out


def write_csv(path: Path, rows: List[dict], fields: List[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in fields})


def main() -> int:
    ap = argparse.ArgumentParser(description="CGI 공급처 전체 상품 수집 (이슈 #19)")
    ap.add_argument("--stage", default="all",
                    choices=["discover", "lists", "details", "all"])
    ap.add_argument("--cache", default="C:/cgi-cache")
    ap.add_argument("--out", default="data/full_catalog")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--delay", type=float, default=0.2)
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    fetcher = ConcurrentFetcher(args.cache, delay=args.delay, workers=args.workers)
    state_path = out_dir / "_collection_state.json"
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}

    cats_path = out_dir / "categories.json"
    if args.stage in ("discover", "all"):
        log("=== stage: discover categories ===")
        cats = {
            "samasound": discover_samasound_categories(fetcher),
            "samamusic": discover_samamusic_categories(fetcher),
        }
        cats_path.write_text(json.dumps(cats, ensure_ascii=False, indent=1), encoding="utf-8")
        state["categories"] = {k: len(v) for k, v in cats.items()}
        state_path.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    cats = json.loads(cats_path.read_text(encoding="utf-8"))

    list_path = out_dir / "list_products.json"
    if args.stage in ("lists", "all"):
        log("=== stage: list crawl ===")
        all_lists = {}
        for site in ("samasound", "samamusic"):
            rows = crawl_lists(fetcher, site, cats[site])
            all_lists[site] = rows
            write_csv(out_dir / f"{site}_list.csv", list(rows.values()),
                      ["source_site", "category_id", "product_id", "name", "summary",
                       "list_price", "product_code", "list_url", "image", "list_page_url"])
        list_path.write_text(json.dumps(all_lists, ensure_ascii=False), encoding="utf-8")
        state["list_unique"] = {k: len(v) for k, v in all_lists.items()}
        state_path.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    all_lists = json.loads(list_path.read_text(encoding="utf-8"))

    if args.stage in ("details", "all"):
        log("=== stage: detail crawl ===")
        for site in ("samasound", "samamusic"):
            recs = crawl_details(fetcher, site, all_lists[site])
            write_csv(out_dir / f"{site}_detail.csv", recs, CC.MASTER_FIELDS)
            (out_dir / f"{site}_detail.json").write_text(
                json.dumps(recs, ensure_ascii=False, indent=1), encoding="utf-8")
            state[f"{site}_details"] = len(recs)
            state_path.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")

    log(f"done. cache hit={fetcher.hits} miss={fetcher.misses} errors={fetcher.errors}")
    log(json.dumps(state, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
