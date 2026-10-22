#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""sample-products.csv -> 마크다운 표 (보고서에 삽입용)."""
import csv, json, sys
sys.stdout.reconfigure(encoding="utf-8")

rows = list(csv.DictReader(open("reports/sample-products.csv", encoding="utf-8-sig")))


def esc(s):
    return (s or "").replace("|", "\\|").replace("\n", " ")


def short_specs(s):
    try:
        d = json.loads(s or "{}")
    except Exception:
        return ""
    skip = {"상품명", "판매가", "번호", "제목"}
    out = []
    for k, v in d.items():
        if k in skip:
            continue
        out.append(f"{k}={v}")
    return "; ".join(out)[:150]


for site in ("samasound.co.kr", "samamusic.co.kr"):
    sub = [r for r in rows if r["source_site"] == site]
    print(f"\n### {site} ({len(sub)}건)\n")
    print("| # | source_product_id | brand | product_name | model | source_category | published_price | availability | specs (확인된 항목) |")
    print("|---|---|---|---|---|---|---|---|---|")
    for i, r in enumerate(sub, 1):
        print(f"| {i} | `{r['source_product_id']}` | {esc(r['brand'])} | {esc(r['product_name'])[:70]} | "
              f"{esc(r['model'])[:40]} | {esc(r['source_category'])[:52]} | "
              f"**{esc(r['published_price']) or '(없음)'}** | {esc(r['availability_unverified']) or '미확인'} | "
              f"{esc(short_specs(r['specs']))} |")
print()
