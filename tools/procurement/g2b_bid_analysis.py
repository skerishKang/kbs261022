#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CGI procurement bid analysis tool (G2B / Nara).

Supports:
  - sample data (bundled)
  - user-provided JSON/CSV files
  - optional live fetch from data.go.kr (requires G2B_API_KEY)
  - CGI industry keyword filtering (audio/video/stage/public broadcast)
  - duplicate removal by bid_no
  - normalization of estimated/bid/winning fields
  - CSV/XLSX export

This tool is descriptive only. It does NOT guarantee win probability.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

try:
    import openpyxl
except ImportError:  # pragma: no cover
    openpyxl = None

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SAMPLE_PATH = os.path.join(REPO_ROOT, "data", "procurement", "sample_bids.json")
KEYWORDS_PATH = os.path.join(REPO_ROOT, "tools", "procurement", "cgi_bid_keywords.json")
OUT_DIR = os.path.join(REPO_ROOT, "reports", "data", "procurement")


def load_bids(path):
    if path.endswith(".json"):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            # support {"bids":[...]} or {"items":[...]}
            for key in ("bids", "items", "data"):
                if key in data and isinstance(data[key], list):
                    return data[key]
            return [data]
        return data
    if path.endswith(".csv"):
        with open(path, encoding="utf-8-sig", newline="") as f:
            return list(csv.DictReader(f))
    raise ValueError("unsupported input format: " + path)


def load_keywords():
    if not os.path.exists(KEYWORDS_PATH):
        return {"cgi_categories": {}, "cgi_negative_keywords": []}
    with open(KEYWORDS_PATH, encoding="utf-8") as f:
        return json.load(f)


def classify_cgi(text):
    cfg = load_keywords()
    cats = cfg.get("cgi_categories", {})
    neg = [w.lower() for w in cfg.get("cgi_negative_keywords", [])]
    low = (text or "").lower()
    if any(w in low for w in neg):
        return None
    matched = []
    for cat, words in cats.items():
        if any(w.lower() in low for w in words):
            matched.append(cat)
    return matched if matched else []


def normalize(bids, source):
    out = []
    seen = set()
    for b in bids:
        bid_no = b.get("bid_no") or b.get("bidNtceNo") or b.get("bid_notice_no")
        if bid_no:
            if bid_no in seen:
                continue
            seen.add(bid_no)
        # field normalization (support both sample and live/API-ish keys)
        title = b.get("title") or b.get("bidNtceNm") or b.get("bid_title")
        agency = b.get("agency") or b.get("dminsttNm") or b.get("demand_agency")
        region = b.get("region") or b.get("bidRgnNm") or b.get("region_name")
        category = b.get("category") or b.get("bidClsfcNm") or b.get("bsnsDivNm")
        estimated = b.get("estimated_price")
        if estimated is None:
            estimated = b.get("presmptPrce") or b.get("asignBdgtAmt") or b.get("basis_amount")
        winning = b.get("winning_bid")
        if winning is None:
            winning = b.get("scsbidAmt") or b.get("bidwinnrAmt")
        bid_amount = b.get("bid_amount")
        if bid_amount is None:
            bid_amount = b.get("bidprcAmt")
        bidders = b.get("bidders")
        if bidders is None:
            bidders = b.get("bidprcCnt") or b.get("bidder_count")
        status = b.get("status") or b.get("bidSttusNm") or b.get("status_name")
        close_date = b.get("close_date") or b.get("bidClseDt") or b.get("bid_close_date")
        notice_date = (
            b.get("notice_date") or b.get("bidNtceDt") or b.get("dltlPubnDt")
            or b.get("pubnDt") or b.get("notice_date_")
        )
        detail_url = b.get("detail_url") or b.get("bidNtceDtlUrl") or b.get("detail_link")

        est_val = _to_number(estimated)
        win_val = _to_number(winning)
        bid_val = _to_number(bid_amount)

        rate = None
        if est_val and win_val:
            rate = round(win_val / est_val * 100, 2)
        elif est_val and bid_val:
            rate = round(bid_val / est_val * 100, 2)

        cgi_cats = classify_cgi(" ".join(str(x) for x in [title, category, agency] if x))

        out.append({
            "bid_no": bid_no,
            "title": title,
            "agency": agency,
            "region": region,
            "category": category,
            "estimated_price": est_val,
            "bid_amount": bid_val,
            "winning_bid": win_val,
            "bid_rate_pct": rate,
            "bidders": _to_int(bidders),
            "status": status,
            "close_date": close_date,
            "notice_date": notice_date,
            "detail_url": detail_url,
            "cgi_categories": ";".join(cgi_cats) if cgi_cats else "",
            "cgi_relevant": bool(cgi_cats),
            "data_source": source,
        })
    return out


def _to_number(v):
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return v
    s = str(v).replace(",", "").replace("원", "").strip()
    try:
        return float(s) if "." in s else int(s)
    except ValueError:
        return None


def _to_int(v):
    n = _to_number(v)
    return int(n) if n is not None else None


def summarize(bids):
    rates = [b["bid_rate_pct"] for b in bids if b["bid_rate_pct"] is not None]
    by_cat = defaultdict(list)
    by_cgi = defaultdict(list)
    by_status = Counter()
    for b in bids:
        if b["bid_rate_pct"] is not None:
            by_cat[b["category"] or "미분류"].append(b["bid_rate_pct"])
            for c in (b["cgi_categories"] or "").split(";"):
                if c:
                    by_cgi[c].append(b["bid_rate_pct"])
        by_status[b["status"] or "미상"] += 1

    def stats(xs):
        if not xs:
            return {"count": 0}
        s = sorted(xs)
        n = len(s)
        mean = sum(s) / n
        mid = n // 2
        median = s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2
        return {"count": n, "min": min(s), "max": max(s),
                "mean": round(mean, 2), "median": round(median, 2)}

    cgi_relevant_count = sum(1 for b in bids if b["cgi_relevant"])
    return {
        "total_bids": len(bids),
        "rated_bids": len(rates),
        "unrated_bids": len(bids) - len(rates),
        "cgi_relevant_bids": cgi_relevant_count,
        "overall_rate_stats": stats(rates),
        "by_category": {k: stats(v) for k, v in by_cat.items()},
        "by_cgi_category": {k: stats(v) for k, v in by_cgi.items()},
        "by_status": dict(by_status),
        "disclaimer": "Descriptive statistics only. No win-probability guarantee.",
    }


def apply_filters(bids, args):
    out = bids
    if args.cgi_only:
        out = [b for b in out if b["cgi_relevant"]]
    if args.keyword:
        kw = args.keyword.lower()
        out = [b for b in out if kw in (b["title"] or "").lower()
               or kw in (b["agency"] or "").lower()]
    if args.region:
        r = args.region.lower()
        out = [b for b in out if r in (b["region"] or "").lower()]
    if args.agency:
        a = args.agency.lower()
        out = [b for b in out if a in (b["agency"] or "").lower()]
    if args.status:
        st = args.status.lower()
        out = [b for b in out if st in (b["status"] or "").lower()]
    # date range on close_date (best-effort string compare)
    if args.begin:
        out = [b for b in out if (b["close_date"] or "") >= args.begin]
    if args.end:
        out = [b for b in out if (b["close_date"] or "") <= args.end]
    return out


def fetch_live(keyword, begin, end):
    """Optional live fetch via data.go.kr. Returns (bids, error)."""
    key = os.environ.get("G2B_API_KEY")
    if not key:
        return None, "G2B_API_KEY not set; using sample/file data"
    try:
        import urllib.request
        import urllib.parse
    except Exception as exc:  # pragma: no cover
        return None, f"urllib unavailable: {exc}"
    url = (
        "http://apis.data.go.kr/1230000/BidPublicInfoService04/"
        "getBidPblancListInfoThngPPSSrch"
        f"?serviceKey={urllib.parse.quote(key, safe='')}"
        "&inqryDiv=1"
        f"&inqryBgnDt={begin}0000"
        f"&inqryEndDt={end}2359"
        f"&bidNtceNm={urllib.parse.quote(keyword)}"
        "&numOfRows=100&pageNo=1&type=json"
    )
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        body = data.get("response", {}).get("body", {})
        items = body.get("items", [])
        if isinstance(items, dict):
            items = [items]
        if items is None:
            items = []
        bids = []
        for it in items:
            bids.append({
                "bid_no": it.get("bidNtceNo"),
                "title": it.get("bidNtceNm"),
                "agency": it.get("dminsttNm"),
                "region": it.get("bidRgnNm"),
                "category": it.get("bsnsDivNm") or "물품",
                "estimated_price": it.get("presmptPrce") or it.get("asignBdgtAmt"),
                "winning_bid": None,
                "bidders": it.get("bidprcCnt"),
                "status": "공고",
                "close_date": it.get("bidClseDt"),
                "detail_url": it.get("bidNtceDtlUrl"),
            })
        return bids, None
    except Exception as exc:
        return None, f"live fetch failed: {exc}"


def write_xlsx(bids, path):
    if openpyxl is None:
        return False
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "G2B_Bids"
    if not bids:
        wb.save(path)
        return True
    cols = list(bids[0].keys())
    ws.append(cols)
    for b in bids:
        ws.append([b.get(c) for c in cols])
    from openpyxl.styles import Font, PatternFill
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.fill = PatternFill("solid", fgColor="DDEBF7")
    ws.freeze_panes = "C2"
    wb.save(path)
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default=None, help="JSON/CSV bid data path")
    parser.add_argument("--live-keyword", default=None, help="live fetch keyword")
    parser.add_argument("--live-begin", default=None, help="YYYYMMDD")
    parser.add_argument("--live-end", default=None, help="YYYYMMDD")
    parser.add_argument("--cgi-only", action="store_true", help="filter CGI-relevant bids")
    parser.add_argument("--keyword", default=None, help="title/agency keyword filter")
    parser.add_argument("--region", default=None)
    parser.add_argument("--agency", default=None)
    parser.add_argument("--status", default=None)
    parser.add_argument("--begin", default=None, help="close_date >= (string)")
    parser.add_argument("--end", default=None, help="close_date <= (string)")
    args = parser.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)

    live_error = None
    live_bids = None
    if args.live_keyword:
        begin = args.live_begin or datetime.now().strftime("%Y%m%d")
        end = args.live_end or begin
        live_bids, live_error = fetch_live(args.live_keyword, begin, end)

    live_attempted = bool(args.live_keyword)
    if live_bids is not None:
        source = "live:data.go.kr"
        bids_raw = live_bids
    elif live_attempted:
        source = "live_failed:fallback_sample"
        bids_raw = load_bids(SAMPLE_PATH)
    elif args.input:
        source = f"file:{args.input}"
        bids_raw = load_bids(args.input)
    else:
        source = f"sample:{SAMPLE_PATH}"
        bids_raw = load_bids(SAMPLE_PATH)

    norm = normalize(bids_raw, source)
    filtered = apply_filters(norm, args)

    summary = summarize(filtered)
    summary["source"] = source
    summary["raw_count"] = len(norm)
    summary["filtered_count"] = len(filtered)
    if live_error:
        summary["live_error"] = live_error
    summary["generated_at"] = datetime.now(timezone.utc).isoformat()
    summary["filters"] = {
        "cgi_only": args.cgi_only,
        "keyword": args.keyword,
        "region": args.region,
        "agency": args.agency,
        "status": args.status,
        "begin": args.begin,
        "end": args.end,
    }

    out_json = os.path.join(OUT_DIR, "bid_analysis_report.json")
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump({"summary": summary, "bids": filtered}, f, ensure_ascii=False, indent=2)

    out_csv = os.path.join(OUT_DIR, "bid_analysis.csv")
    with open(out_csv, "w", encoding="utf-8-sig", newline="") as f:
        if filtered:
            w = csv.DictWriter(f, fieldnames=list(filtered[0].keys()))
            w.writeheader()
            for r in filtered:
                w.writerow(r)

    out_xlsx = os.path.join(OUT_DIR, "bid_analysis.xlsx")
    write_xlsx(filtered, out_xlsx)

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print("outputs:", out_json, out_csv, out_xlsx)


if __name__ == "__main__":
    main()
