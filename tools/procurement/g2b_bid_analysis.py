#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Prototype: Nara (G2B) bid analysis — estimated price vs bid rate.

This is a PROTOTYPE. It does NOT guarantee win probability. It computes
descriptive statistics from public bid data. Live fetch requires
G2B_API_KEY environment variable (data.go.kr service key); otherwise it
falls back to the bundled sample data.

Usage:
  python tools/procurement/g2b_bid_analysis.py
  python tools/procurement/g2b_bid_analysis.py --input data/procurement/sample_bids.json
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SAMPLE_PATH = os.path.join(REPO_ROOT, "data", "procurement", "sample_bids.json")
OUT_DIR = os.path.join(REPO_ROOT, "reports", "data", "procurement")


def load_bids(path):
    if path.endswith(".json"):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    if path.endswith(".csv"):
        with open(path, encoding="utf-8-sig", newline="") as f:
            return list(csv.DictReader(f))
    raise ValueError("unsupported input format")


def normalize(bids):
    out = []
    for b in bids:
        est = b.get("estimated_price")
        win = b.get("winning_bid")
        rate = None
        if est and win:
            try:
                rate = round(float(win) / float(est) * 100, 2)
            except (TypeError, ValueError, ZeroDivisionError):
                rate = None
        out.append({
            "bid_no": b.get("bid_no"),
            "title": b.get("title"),
            "agency": b.get("agency"),
            "category": b.get("category"),
            "estimated_price": est,
            "winning_bid": win,
            "bid_rate_pct": rate,
            "bidders": b.get("bidders"),
            "status": b.get("status"),
        })
    return out


def summarize(bids):
    rates = [b["bid_rate_pct"] for b in bids if b["bid_rate_pct"] is not None]
    by_cat = defaultdict(list)
    by_status = defaultdict(int)
    for b in bids:
        if b["bid_rate_pct"] is not None:
            by_cat[b["category"] or "미분류"].append(b["bid_rate_pct"])
        by_status[b["status"] or "미상"] += 1

    def stats(xs):
        if not xs:
            return {"count": 0}
        xs_sorted = sorted(xs)
        n = len(xs_sorted)
        mean = sum(xs_sorted) / n
        mid = n // 2
        median = xs_sorted[mid] if n % 2 else (xs_sorted[mid - 1] + xs_sorted[mid]) / 2
        return {
            "count": n,
            "min": min(xs_sorted),
            "max": max(xs_sorted),
            "mean": round(mean, 2),
            "median": round(median, 2),
        }

    return {
        "total_bids": len(bids),
        "rated_bids": len(rates),
        "unrated_bids": len(bids) - len(rates),
        "overall_rate_stats": stats(rates),
        "by_category": {k: stats(v) for k, v in by_cat.items()},
        "by_status": dict(by_status),
        "disclaimer": "Descriptive statistics only. No win-probability guarantee.",
    }


def fetch_live(keyword, begin, end):
    """Optional live fetch via data.go.kr if G2B_API_KEY is set.

    Returns (bids_list, error_string). Only basic bid-notice fetch is
    attempted; full scoring is out of scope for this prototype.
    """
    key = os.environ.get("G2B_API_KEY")
    if not key:
        return None, "G2B_API_KEY not set; using sample data"
    try:
        import urllib.request
        import urllib.parse
    except Exception as exc:
        return None, f"urllib unavailable: {exc}"
    # BidPublicInfoService04 - getBidPblancListInfoThngPPSSrch (goods)
    url = (
        "http://apis.data.go.kr/1230000/BidPublicInfoService04/"
        "getBidPblancListInfoThngPPSSrch"
        f"?serviceKey={urllib.parse.quote(key, safe='')}"
        "&inqryDiv=1"
        f"&inqryBgnDt={begin}0000"
        f"&inqryEndDt={end}2359"
        f"&bidNtceNm={urllib.parse.quote(keyword)}"
        "&numOfRows=50&pageNo=1&type=json"
    )
    try:
        with urllib.request.urlopen(url, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        items = data.get("response", {}).get("body", {}).get("items", [])
        if isinstance(items, dict):
            items = [items]
        bids = []
        for it in items:
            bids.append({
                "bid_no": it.get("bidNtceNo"),
                "title": it.get("bidNtceNm"),
                "agency": it.get("dminsttNm"),
                "category": "물품",
                "estimated_price": it.get("presmptPrce") or it.get("asignBdgtAmt"),
                "winning_bid": None,
                "bidders": None,
                "status": "공고",
            })
        return bids, None
    except Exception as exc:
        return None, f"live fetch failed: {exc}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default=None, help="JSON/CSV bid data path")
    parser.add_argument("--live-keyword", default=None, help="optional live fetch keyword")
    parser.add_argument("--live-begin", default=None, help="YYYYMMDD")
    parser.add_argument("--live-end", default=None, help="YYYYMMDD")
    args = parser.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)

    live_error = None
    if args.live_keyword:
        begin = args.live_begin or datetime.now().strftime("%Y%m%d")
        end = args.live_end or begin
        bids, live_error = fetch_live(args.live_keyword, begin, end)
        if bids is None:
            bids = None
    else:
        bids = None

    if bids is None:
        path = args.input or SAMPLE_PATH
        bids = load_bids(path)
        source = path
    else:
        source = "live:data.go.kr"

    norm = normalize(bids)
    summary = summarize(norm)
    summary["source"] = source
    if live_error:
        summary["live_error"] = live_error
    summary["generated_at"] = datetime.now(timezone.utc).isoformat()

    out_json = os.path.join(OUT_DIR, "bid_analysis_report.json")
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump({"summary": summary, "bids": norm}, f, ensure_ascii=False, indent=2)

    # CSV output
    out_csv = os.path.join(OUT_DIR, "bid_analysis.csv")
    with open(out_csv, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(norm[0].keys()) if norm else [])
        if norm:
            w.writeheader()
            for r in norm:
                w.writerow(r)

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print("outputs:", out_json, out_csv)


if __name__ == "__main__":
    main()
