#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
collect_full_catalog.py -- CGI 공급처 2곳의 **전체 상품 상세** 수집 오케스트레이터 (이슈 #19)

설계 원칙
  1. **기존 수집기 재사용, 수정 없음.** PR #12 의 `skills/cgi-catalog-collector/scripts/collect_cgi_catalog.py`
     를 모듈로 import 하여 HTTP 파서·캐시·지연·목록 파서를 그대로 사용한다. 원본 파일은 열지 않는다(읽기 전용 import).
  2. **ID 로스터는 카테고리 목록 크롤 결과**를 사용한다. samamusic 의 sitemap(1,597) 은 불완전하므로 기준이 아니다.
  3. **상세 URL 은 상품이 실제로 속한 카테고리(cate_no)를 포함**한다. Tri-B 는 cate_no=1 로 두면
     setCategoryCookie 가 '전체' 로 뭉개져 카테고리가 소실된다.
  4. **추정 금지.** 공개되지 않은 값(공급가·실재고·승인여부)은 비워둔다. 상태는 토큰으로만 표현한다.
  5. 로컬 산출물은 .work/ 아래( gitignore 대상 ). GitHub 제출은 스키마·코드·비식별 품질 통계만 한다.

사용법
  # 1) 카테고리 목록 크롤 ( 캐시가 있으면 네트워크 0 )
  python tools/full_catalog/collect_full_catalog.py --stage categories --site samasound
  python tools/full_catalog/collect_full_catalog.py --stage categories --site samamusic
  # 2) 전체 상세 수집
  python tools/full_catalog/collect_full_catalog.py --stage details --site samasound
  python tools/full_catalog/collect_full_catalog.py --stage details --site samamusic
  # 3) 병합 + 품질 통계
  python tools/full_catalog/collect_full_catalog.py --stage merge
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

csv.field_size_limit(50_000_000)  # 옵션/스펙 JSON 셀은 128KB 를 넘을 수 있다

REPO = Path(__file__).resolve().parents[2]
COLLECTOR_REL = "skills/cgi-catalog-collector/scripts/collect_cgi_catalog.py"
COLLECTOR_PATH = REPO / COLLECTOR_REL
WORK = REPO / ".work" / "full_catalog"
# PR #12 수집기를 **수정하지 않고** 재사용한다. 아직 main 에 합쳐지지 않았으면
# 지정 브랜치에서 읽어 로컬 캐시에落的して import 한다(중복 개발 없음).
FALLBACK_REFS = [
    "origin/feature/site-analysis-model-b",
    "origin/main",
]


def resolve_collector() -> Path:
    if COLLECTOR_PATH.exists():
        return COLLECTOR_PATH
    cache = WORK / "_vendor" / "collect_cgi_catalog.py"
    cache.parent.mkdir(parents=True, exist_ok=True)
    for ref in FALLBACK_REFS:
        try:
            blob = subprocess.run(["git", "-C", str(REPO), "show", f"{ref}:{COLLECTOR_REL}"],
                                  capture_output=True, check=True).stdout
        except Exception:
            continue
        cache.write_bytes(blob)
        return cache
    raise SystemExit(
        f"수집기 {COLLECTOR_REL} 를 찾지 못했다. PR #12 를 먼저 병합하거나 "
        f"--collector-ref 로 브랜치를 지정하라."
    )


COLLECTOR_PATH = resolve_collector()
sys.path.insert(0, str(COLLECTOR_PATH.parent))
import collect_cgi_catalog as C  # noqa: E402  (PR #12 수집기 재사용)

# --------------------------------------------------------------------------------------
# 이미지 수집 정책 오버라이드 (수집 단계 + 브라우저 교차검증에서 확인한 실제 결함 2건 보정)
#
# 결함 1) PR #12 수집기의 extract_images() 는 `data-src` 를 전부 수집하여
#        /web/upload/NNEditor/..., /_wg/img/category_bnr/..., gi.esmplus.com/... 를
#        상품 이미지로 섞어 넣는다.
# 결함 2) 같은 함수의 정규식 `class="(?:BigImage|ThumbImage)"` 는 실제 마크업의
#        `class="BigImage "`(후행 공백) 를 놓쳐 **대표 이미지(big)를 빠뜨린다.**
#
# 보정: 상세 HTML 안의 **/web/product/ 경로 이미지 전부**를 상품 이미지로 취급한다.
#       (PR #12 원본은 수정하지 않는다 — 별도 PR 로 상위 반영 필요)
# --------------------------------------------------------------------------------------
_IMG_TAG = re.compile(r"<img\b[^>]*>", re.I)
_ATTR_SRC = re.compile(r'(?:src|data-src)\s*=\s*"([^"]+)"', re.I)


def _product_images_only(html: str) -> List[str]:
    urls: List[str] = []
    seen = set()
    for tag in _IMG_TAG.findall(html or ""):
        m = _ATTR_SRC.search(tag)
        if not m:
            continue
        u = m.group(1).split("?")[0]
        if "/web/product/" not in u:
            continue
        if u.startswith("//"):
            u = "https:" + u
        elif u.startswith("/"):
            continue  # 상대경로는 원천 호스트가站点마다 달라 보존하지 않는다(검증 단계에서 별도 확인)
        if u in seen:
            continue
        seen.add(u)
        urls.append(u)
    return urls


C.extract_images = _product_images_only

MASTER_FIELDS = list(C.MASTER_FIELDS) + ["list_observed_price", "list_page_url"]

SITES = {
    "samasound": {
        "origin": "https://www.samasound.co.kr",
        "list_csv": WORK / "samasound_product_list.csv",
        "cats_csv": WORK / "samasound_categories.csv",
        "detail_out": WORK / "samasound_detail.csv",
    },
    "samamusic": {
        "origin": "https://www.samamusic.co.kr",
        "list_csv": WORK / "samamusic_product_list.csv",
        "cats_csv": WORK / "samamusic_categories.csv",
        "detail_out": WORK / "samamusic_detail.csv",
    },
}

# 수집 대상 ID 로스터( 카테고리 크롤 결과 )
ROSTER = {
    "samasound": WORK / "samasound_product_list.csv",
    "samamusic": WORK / "samamusic_product_list.csv",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------- 리스트


def load_csv(path: Path) -> List[Dict[str, str]]:
    if not path.exists():
        return []
    with open(path, encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))


def build_category_paths(cats_csv: Path) -> Dict[str, str]:
    """category_id -> '상위 > 중간 > 리프' 경로 (부모는 child_categories 로 복원)."""
    rows = load_csv(cats_csv)
    if not rows:
        return {}
    name = {r["category_id"]: r["category_name"] for r in rows}
    # Tri-B 는 상세/목록에 카테고리 경로가 없으므로 sitemap 이름으로 채운다
    names_file = WORK / "samamusic_category_names.json"
    if names_file.exists():
        for cid, nm in json.load(open(names_file, encoding="utf-8")).items():
            if not name.get(cid):
                name[cid] = nm
    parent: Dict[str, str] = {}
    for r in rows:
        kids: List[Dict[str, Any]] = []
        for col in ("child_categories", "child_category_ids"):
            raw = r.get(col) or ""
            if not raw:
                continue
            try:
                parsed = json.loads(raw)
            except Exception:
                continue
            if isinstance(parsed, list):
                kids = parsed
                break
        for k in kids:
            if isinstance(k, dict) and k.get("id") is not None:
                parent.setdefault(str(k["id"]), r["category_id"])

    def path_of(cid: str) -> str:
        parts: List[str] = []
        cur: Optional[str] = cid
        seen = set()
        while cur and cur not in seen:
            seen.add(cur)
            if name.get(cur):
                parts.append(name[cur])
            cur = parent.get(cur)
        return " > ".join(reversed(parts))

    return {cid: path_of(cid) for cid in name}


# --------------------------------------------------------------------- stages


def stage_categories(site: str, delay: float, cache: str, max_pages: int) -> None:
    """카테고리 목록을 전수 크롤해 (목록 CSV + 카테고리 CSV) 를 만든다."""
    cfg = SITES[site]
    WORK.mkdir(parents=True, exist_ok=True)
    ids_file = WORK / f"{site}_cate_ids.json"
    if not ids_file.exists():
        log(f"[{site}] cate id 목록이 없다: {ids_file} 를 먼저 만들어야 한다")
        return
    ids = json.load(open(ids_file, encoding="utf-8"))
    fetcher = C.Fetcher(cache, delay=delay)
    out_list = cfg["list_csv"]
    out_cats = cfg["cats_csv"]
    list_fields = [
        "source_site", "category_id", "category_name", "product_id", "name", "summary",
        "list_price", "list_retail_price", "product_code", "list_url", "image", "list_page_url",
    ]
    cat_fields = C.CATEGORY_FIELDS
    prod_rows: List[Dict[str, Any]] = []
    cat_rows: List[Dict[str, Any]] = []
    for i, cid in enumerate(ids):
        url = f"{cfg['origin']}/product/list.html?cate_no={cid}"
        st, html = fetcher.get(url)
        if st != 200 or not html:
            continue
        try:
            kids = json.loads(re.search(r'childCategories\s*[:=]\s*(\[.*?\]);', html, re.S).group(1))
        except Exception:
            kids = []
        crumbs = C.breadcrumb_categories(html)
        parser = C.LIST_PARSERS[site]
        total = C.last_page(html) or 1
        items: Dict[str, Any] = {}
        for page in range(1, min(total, max_pages) + 1):
            purl = url if page == 1 else f"{url}&page={page}"
            pst, ph = fetcher.get(purl)
            if pst != 200 or not ph:
                break
            for it in parser(ph):
                items[it["product_id"]] = it
        cname = crumbs[-1]["name"] if crumbs else ""
        cat_rows.append({
            "source_site": site, "category_id": cid, "category_name": cname,
            "category_path": " > ".join(c["name"] for c in crumbs if c.get("name")),
            "registered_count": C.registered_count(html) or "", "total_pages": total,
            "child_categories": json.dumps(kids, ensure_ascii=False),
            "product_count_on_site": len(items), "list_url": url,
        })
        for pid, it in items.items():
            prod_rows.append({
                "source_site": site, "category_id": cid, "category_name": cname,
                "product_id": pid, "name": it["name"], "summary": it["summary"],
                "list_price": it["list_price"] if it["list_price"] is not None else "",
                "list_retail_price": it.get("list_retail_price") if it.get("list_retail_price") is not None else "",
                "product_code": it.get("product_code") or "", "list_url": cfg["origin"] + it["list_url"],
                "image": it["image"], "list_page_url": it.get("list_page_url", ""),
            })
        if i % 50 == 0:
            log(f"[{site}] category {i}/{len(ids)} 상품누적={len(prod_rows)}")
    with open(out_list, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=list_fields)
        w.writeheader()
        for r in prod_rows:
            w.writerow(r)
    with open(out_cats, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=cat_fields)
        w.writeheader()
        for r in cat_rows:
            w.writerow(r)
    uniq = len({r["product_id"] for r in prod_rows})
    log(f"[{site}] category 완료: 카테고리 {len(cat_rows)} / 상품행 {len(prod_rows)} / unique {uniq}")


def stage_details(site: str, delay: float, cache: str, workers: int) -> None:
    """전체 상품 상세 수집. Tri-B 는 실제 cate_no 를 붙여 상세 URL 을 만든다."""
    cfg = SITES[site]
    rows = load_csv(ROSTER[site])
    if not rows:
        log(f"[{site}] 로스터가 없다: {ROSTER[site]}")
        return
    # 상품별 대표 카테고리( 목록에 처음 등장한 카테고리 ) + 카테고리 경로
    paths = build_category_paths(cfg["cats_csv"])
    prod: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        pid = r["product_id"]
        if pid not in prod:
            prod[pid] = r
    log(f"[{site}] 상세 대상 {len(prod)}건 (워커 {workers})")

    lock = threading.Lock()
    local = threading.local()
    results: List[Dict[str, Any]] = []
    done = {"n": 0, "ok": 0, "fail": 0}
    ts = now_iso()

    def get_fetcher() -> C.Fetcher:
        if not hasattr(local, "f"):
            local.f = C.Fetcher(cache, delay=delay)
        return local.f

    def work(item: Tuple[str, Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        pid, r = item
        if site == "samamusic":
            url = (f"{cfg['origin']}/product/detail.html?product_no={pid}"
                   f"&cate_no={r['category_id']}&display_group=1")
        else:
            url = f"{cfg['origin']}/product/detail.html?product_no={pid}"
        f = get_fetcher()
        st, html = f.get(url, referer=cfg["origin"] + "/")
        with lock:
            done["n"] += 1
            if st != 200 or not html:
                done["fail"] += 1
            else:
                done["ok"] += 1
            if done["n"] % 200 == 0:
                log(f"[{site}] {done['n']}/{len(prod)} ok={done['ok']} fail={done['fail']}")
        if st != 200 or not html:
            return None
        rec = C.parse_detail(html, site, pid, url)
        # 품절 표기를 '메인상품'/'추가구성상품' 으로 분리 (수집기 원본은 둘을 합친다)
        flags = [f for f in (rec.get("product_status_flags") or "").split(";") if f]
        if C.js_var(html, "is_soldout_icon") == "T":
            flags.append("main_soldout_icon")
        addon = C.js_json_var(html, "aSoldoutDisplay") or {}
        if addon:
            flags.append("addon_soldout:" + ",".join(sorted(str(k) for k in addon)))
        rec["product_status_flags"] = ";".join(dict.fromkeys(flags))
        # 카테고리 ID/명은 **상세 페이지가 스스로 밝힌 값**(Tri-A: setCategoryCookie, Tri-B: cate_no 실값)을
        # 우선한다. 목록 크롤 값은 '최초 발견 카테고리'라서 리프가 아닐 수 있다.
        if not rec.get("source_category_id"):
            rec["source_category_id"] = r["category_id"]
        if not rec.get("source_category_name"):
            rec["source_category_name"] = r.get("category_name") or ""
        if not rec.get("source_category_path"):
            rec["source_category_path"] = paths.get(str(r["category_id"]), "")
        rec["source_list_url"] = r.get("list_url") or url
        rec["updated_at"] = ts
        rec["list_observed_price"] = r.get("list_price") or ""
        rec["list_page_url"] = r.get("list_page_url") or ""
        if not rec.get("verification_status"):
            rec["verification_status"] = "verified_against_source_page"
        return rec

    with ThreadPoolExecutor(max_workers=workers) as ex:
        for rec in ex.map(work, list(prod.items())):
            if rec:
                results.append(rec)

    results.sort(key=lambda x: (x["source_site"], str(x["source_product_id"]).zfill(9)))
    with open(cfg["detail_out"], "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=MASTER_FIELDS)
        w.writeheader()
        for rec in results:
            w.writerow({k: rec.get(k, "") for k in MASTER_FIELDS})
    log(f"[{site}] detail 완료 {len(results)}/{len(prod)} (fail={done['fail']}) -> {cfg['detail_out']}")


def load_dalue_primary() -> Dict[str, Dict[str, str]]:
    """Tri-B 스토어 자체 등록 카테고리 (Dalue categoryNos) → product_no 맵.

    Dalue 의 categoryNos 는 ';' 로 여러 경로, '^' 로 계층을 표현한다.
    첫 경로의 마지막 id 를 대표 카테고리로 삼는다.
    """
    p = WORK / "triB_dalue_full.json"
    if not p.exists():
        return {}
    names = json.load(open(WORK / "samamusic_category_names.json", encoding="utf-8")) \
        if (WORK / "samamusic_category_names.json").exists() else {}
    items = json.load(open(p, encoding="utf-8")).get("items", [])
    out: Dict[str, Dict[str, str]] = {}
    for x in items:
        pid = str(x.get("productNo") or "")
        r1, r2 = x.get("categoryRoot1"), x.get("categoryRoot2")
        best = None
        for path in (x.get("categoryNos") or "").split(";"):
            if not path:
                continue
            ids = path.split("^")
            nm = []
            for i, cid in enumerate(ids):
                if i == 0 and r1:
                    nm.append(r1)
                elif i == 1 and r2 and not (len(ids) == 2 and r2 == "브랜드" and r1 == "브랜드"):
                    nm.append(r2)
                else:
                    nm.append(names.get(cid, cid))
            if not nm:
                continue
            if best is None or len(nm) > len(best[1]):
                best = (ids[-1], " > ".join(nm))
        if best:
            out[pid] = {"cat_id": best[0], "path": best[1], "leaf": best[1].split(" > ")[-1]}
    return out


def stage_merge() -> None:
    """두 사이트 상세 CSV 를 병합하고 품질 통계를 낸다."""
    out_csv = WORK / "product_master_full.csv"
    out_json = WORK / "product_master_full.json"
    out_q = WORK / "product_master_full_quality.csv"
    rows: List[Dict[str, Any]] = []
    for site in SITES:
        p = SITES[site]["detail_out"]
        rows.extend(load_csv(p))
    # Tri-B 카테고리 경로/명 보강 (sitemap 이름 + 카테고리 그래프)
    paths = build_category_paths(SITES["samamusic"]["cats_csv"])
    names_file = WORK / "samamusic_category_names.json"
    leaf_names = json.load(open(names_file, encoding="utf-8")) if names_file.exists() else {}
    # Tri-B 스토어 자체 등록 카테고리(Dalue categoryNos)를 우선 사용
    dalue_primary = load_dalue_primary()
    for r in rows:
        if r["source_site"] != "samamusic":
            continue
        cid = str(r.get("source_category_id") or "")
        dp = dalue_primary.get(str(r.get("source_product_id") or ""))
        if dp:
            r["source_category_id"] = dp["cat_id"]
            r["source_category_name"] = dp["leaf"]
            r["source_category_path"] = dp["path"]
            continue
        if not (r.get("source_category_path") or "").strip():
            r["source_category_path"] = paths.get(cid, "")
        if not (r.get("source_category_name") or "").strip():
            r["source_category_name"] = leaf_names.get(cid, "")
    with open(out_csv, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=MASTER_FIELDS)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in MASTER_FIELDS})
    with open(out_json, "w", encoding="utf-8") as fh:
        json.dump(rows, fh, ensure_ascii=False, indent=1)
    # 품질 통계
    stats = []
    for site in SITES:
        rs = [r for r in rows if r["source_site"] == site]
        if not rs:
            continue
        n = len(rs)

        def cov(field: str) -> int:
            return sum(1 for r in rs if (r.get(field) or "").strip() and r.get(field) != "[]" and r.get(field) != "{}")

        stats.append({
            "source_site": site, "records": n,
            "has_canonical_url": cov("canonical_url"),
            "has_product_name": cov("product_name"),
            "has_brand": cov("source_brand"),
            "has_manufacturer": cov("manufacturer"),
            "has_model": cov("model"),
            "has_category_path": cov("source_category_path"),
            "has_specs": cov("specs"),
            "has_images": cov("image_urls"),
            "has_option_summary": cov("option_summary"),
            "has_public_price": sum(1 for r in rs if (r.get("published_price") or "").strip()),
            "price_state_inquiry": sum(1 for r in rs if r.get("published_price_state") == "inquiry_price"),
            "price_state_numeric": sum(1 for r in rs if r.get("published_price_state") == "numeric_price"),
            "price_state_soldout": sum(1 for r in rs if r.get("published_price_state") == "sold_out_sale_completed"),
            "price_state_not_for_sale": sum(1 for r in rs if r.get("published_price_state") == "not_for_sale"),
            "has_soldout_marker": cov("soldout_display"),
            "has_item_code": cov("source_item_code"),
            "has_product_code": cov("product_code"),
            "dealer_price_filled": sum(1 for r in rs if (r.get("dealer_price_unverified") or "").strip()),
        })
    with open(out_q, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=list(stats[0].keys()))
        w.writeheader()
        for s in stats:
            w.writerow(s)
    log(f"병합 완료 {len(rows)}건 -> {out_csv}")
    for s in stats:
        log(json.dumps(s, ensure_ascii=False))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True, choices=["categories", "details", "merge"])
    ap.add_argument("--site", choices=list(SITES))
    ap.add_argument("--delay", type=float, default=0.30)
    ap.add_argument("--cache", default=str(REPO / ".cache" / "cgi-catalog"))
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--max-pages", type=int, default=500)
    args = ap.parse_args()
    WORK.mkdir(parents=True, exist_ok=True)
    if args.stage == "merge":
        stage_merge()
        return 0
    if not args.site:
        ap.error("--site 필요")
    if args.stage == "categories":
        stage_categories(args.site, args.delay, args.cache, args.max_pages)
    else:
        stage_details(args.site, args.delay, args.cache, args.workers)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
