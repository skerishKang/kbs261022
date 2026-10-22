#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_browser.py -- 수집된 상품 마스터를 **실제 브라우저 렌더**와 대조 검증한다 (이슈 #19)

검증 2층
  L1 렌더 대조 : Playwright 로 실제 페이지를 열어 *보이는* 값(기본정보 표, 판매가, 옵션 select,
                  이미지, canonical, 품절 표시)을 읽고 수집 레코드와 항목별로 비교한다.
  L2 경로 동등성 : 브라우저가 받은 HTML 을 PR #12 수집기의 parse_detail 로 다시 파싱해
                    HTTP 수집 결과와 비교한다. (요청기 == 브라우저 동일 결과 입증)

입력
  --master <product_master_full.csv>
  --sample <sample.csv>          # source_site,source_product_id 로 지정 (없으면 자동 층화추출)
  --out <verification.csv>       # 비교 결과
  --limit N
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO = Path(__file__).resolve().parents[2]
COLLECTOR_REL = "skills/cgi-catalog-collector/scripts/collect_cgi_catalog.py"
COLLECTOR_PATH = REPO / COLLECTOR_REL
WORK = REPO / ".work" / "full_catalog"
# PR #12 수집기를 수정 없이 재사용. main 미병합 시 지정 브랜치에서 읽어 로컬 캐시에 복사한다.
FALLBACK_REFS = ["origin/feature/site-analysis-model-b", "origin/main"]


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
    raise SystemExit(f"수집기 {COLLECTOR_REL} 를 찾지 못했다. PR #12 병합 후 재실행하라.")


COLLECTOR_PATH = resolve_collector()
sys.path.insert(0, str(COLLECTOR_PATH.parent))
import collect_cgi_catalog as C  # noqa: E402

csv.field_size_limit(50_000_000)

OUT_FIELDS = [
    "source_site", "source_product_id", "product_name", "canonical_url", "checked_at",
    "l1_name", "l1_brand", "l1_model", "l1_price_text", "l1_price_value", "l1_image_count",
    "l1_option_groups", "l1_option_value_count",     "l1_soldout", "l1_category", "l1_canonical",
    "m_name", "m_brand", "m_model", "m_price_value", "m_image_count", "m_option_count",
    "l1_match", "l2_parse_match", "mismatch_fields", "verdict", "note", "l1_notes",
]


def load(path: str) -> List[Dict[str, str]]:
    with open(path, encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))


# ------------------------------------------------------------------ 브라우저 추출
EXTRACT_JS = r"""
() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const out = { basic: {}, priceText: null, priceValue: null, images: [], optionGroups: [],
                optionValueCount: 0, soldout: false, category: null, canonical: null,
                h2Name: null, brandField: null, modelField: null, productText: null };
  // 기본정보 표
  document.querySelectorAll('table').forEach(t => {
    const cap = t.querySelector('caption');
    if (!cap || !cap.innerText.includes('기본 정보')) return;
    t.querySelectorAll('tr').forEach(tr => {
      const th = tr.querySelector('th'), td = tr.querySelector('td');
      if (th && td) out.basic[clean(th.innerText)] = clean(td.innerText);
    });
  });
  const p = document.querySelector('#span_product_price_text');
  if (p) out.priceText = clean(p.innerText);
  out.h2Name = clean(document.querySelector('h2.item_name')?.innerText);
  out.brandField = out.basic['브랜드'] || out.basic['제조사'] || null;
  out.modelField = out.basic['모델명'] || null;
  out.priceValue = out.priceText ? (out.priceText.match(/([0-9][0-9,]*)\s*원/) || [])[1] || null : null;
  // 상품 이미지만 (Cafe24 상품 이미지 경로)
  const seen = new Set();
  document.querySelectorAll('img').forEach(i => {
    const s = (i.getAttribute('src') || i.getAttribute('data-src') || '').split('?')[0];
    if (!/web\/product\//.test(s)) return;
    const abs = s.startsWith('//') ? 'https:' + s : s;
    if (seen.has(abs)) return; seen.add(abs); out.images.push(abs);
  });
  // 옵션 select: 상품 옵션 영역(메인 + 추가구성상품)만
  document.querySelectorAll('select').forEach(s => {
    const title = s.getAttribute('option_title');
    if (!title) return;
    const area = s.getAttribute('product_option_area') || '';
    if (!area) return;   // 배송국가/검색조건 등 제외
    const vals = [...s.options].map(o => clean(o.text)).filter(t => t && !t.startsWith('-'));
    out.optionGroups.push({ title, count: vals.length, values: vals, area });
    out.optionValueCount += vals.length;
  });
  // 품절 표기: (a) 기본정보 표의 '판매 완료/불료' = 메인상품 판매중지
  //            (b) 추가구성상품(연결상품) 목록의 [품절] = 추가상품 품절
  const priceCell = out.basic['판매가'] || '';
  out.soldoutMain = /판매\s*완료|판매\s*불료/.test(priceCell);
  const addonBlocks = [...document.querySelectorAll('li.product.xans-record')];
  out.soldoutAddon = addonBlocks.some(li => /\[?품절\]?/.test(li.innerText || ''));
  out.soldout = out.soldoutMain || out.soldoutAddon;
  const holder = document.querySelector('.buy-wrapper') || document.querySelector('.item_name')?.parentElement || document.body;
  out.productText = clean(holder.innerText).slice(0, 400);
  // 카테고리
  const bc = [...document.querySelectorAll('.xans-product-headcategory.path li, ol.position li')]
    .map(e => clean(e.innerText)).filter(Boolean);
  out.category = bc.join(' > ') || null;
  const c = document.querySelector('link[rel=canonical]');
  out.canonical = c ? c.href : null;
  return out;
}
"""


def norm_img(u: str) -> str:
    u = (u or "").split("?")[0]
    return re.sub(r"/(tiny|small|medium|big|extra)/", "/{size}/", u)


def norm_url(u: str) -> str:
    """canonical 비교용 정규화: 퍼센트 인코딩 차이를 제거."""
    from urllib.parse import unquote
    return unquote((u or "").rstrip("/"))


def norm_price(v: Any) -> Optional[int]:
    if v in (None, ""):
        return None
    m = re.search(r"([0-9][0-9,]*)", str(v))
    return int(m.group(1).replace(",", "")) if m else None


def compare(rec: Dict[str, str], b: Dict[str, Any], parsed: Dict[str, Any]) -> Dict[str, Any]:
    """L1(브라우저 렌더) 대조."""
    diffs: List[str] = []

    b_name = b.get("h2Name") or b.get("basic", {}).get("상품명")
    if b_name and rec.get("product_name", "").strip() and b_name.strip() != rec["product_name"].strip():
        diffs.append("product_name")

    b_brand = b.get("brandField")
    if b_brand and rec.get("source_brand", "").strip() and b_brand.strip().lower() != rec["source_brand"].strip().lower():
        diffs.append("source_brand")

    b_model = b.get("modelField")
    if b_model is not None:
        if rec.get("model", "").strip() != b_model.strip():
            diffs.append("model")

    b_price = norm_price(b.get("priceValue"))
    r_price = norm_price(rec.get("published_price"))
    if b_price != r_price:
        diffs.append("published_price")

    b_imgs = {norm_img(u) for u in b.get("images", [])}
    r_imgs = {norm_img(u) for u in (rec.get("image_urls") or "").split("|") if u}
    if r_imgs and b_imgs and not (r_imgs <= b_imgs):
        diffs.append(f"image_urls(누락{len(r_imgs - b_imgs)})")

    b_optvals = b.get("optionValueCount", 0)
    b_optgroups = len(b.get("optionGroups", []))
    try:
        r_opt_n = int(rec.get("option_count") or 0)
    except ValueError:
        r_opt_n = 0
    if b_optgroups and r_opt_n and b_optgroups != r_opt_n:
        diffs.append(f"option_group_count({b_optgroups}!={r_opt_n})")

    # 품절: 메인상품/추가상품을 분리해 비교
    #  ※ samamusic 스킨은 일부 상품에서 품절 아이콘을 'style="display:none"' 로 숨긴다.
    #    스토어 자체 신호(is_soldout_icon / 판매완료 텍스트)가 기준이고,
    #    '화면에 보이는 배지' 는 약한 신호이므로 NOTE 로 분리한다.
    flags = (rec.get("product_status_flags") or "")
    m_main = bool(re.search(r"main_soldout_icon", flags)) or \
        rec.get("published_price_state") == "sold_out_sale_completed"
    m_addon = bool(re.search(r"addon_soldout:", flags))
    notes: List[str] = []
    if bool(b.get("soldoutMain")) != m_main:
        notes.append(f"품절배지_표시={int(bool(b.get('soldoutMain')))}/스토어신호={int(m_main)}")
    if bool(b.get("soldoutAddon")) != m_addon:
        diffs.append("soldout_addon")

    b_canon = norm_url(b.get("canonical") or "")
    r_canon = norm_url(rec.get("canonical_url") or "")
    if b_canon and r_canon and b_canon != r_canon:
        diffs.append("canonical_url")

    # L2: 브라우저 HTML 을 수집기 파서로 재파싱 → HTTP 수집 결과와 비교
    l2_diffs: List[str] = []
    for k in ("product_name", "source_brand", "model", "published_price", "canonical_url"):
        if str(parsed.get(k, "")).strip() != str(rec.get(k, "")).strip():
            l2_diffs.append(k)
    if str(parsed.get("published_price_state", "")) != str(rec.get("published_price_state", "")):
        l2_diffs.append("published_price_state")

    return {
        "l1_diffs": diffs,
        "l2_diffs": l2_diffs,
        "notes": notes,
        "b": b,
        "parsed": parsed,
    }


def pick_sample(rows: List[Dict[str, str]], limit: int) -> List[Dict[str, str]]:
    """공급처 × 가격공개여부 × 옵션유무 × 브랜드 로 층화추출."""
    import collections
    import random

    random.seed(20261022)
    buckets: Dict[str, List[Dict[str, str]]] = collections.defaultdict(list)
    brands: Dict[str, set] = collections.defaultdict(set)
    for r in rows:
        has_opt = "1" if (r.get("option_count") or "0") not in ("0", "") else "0"
        key = f"{r['source_site']}|{r.get('published_price_state','?')}|opt={has_opt}"
        buckets[key].append(r)
        brands[r["source_site"]].add(r.get("source_brand", ""))
    out: List[Dict[str, str]] = []
    keys = sorted(buckets)
    i = 0
    # 가격 상태 × 옵션 유무 를 모두 커버
    while len(out) < limit and any(buckets[k] for k in keys):
        k = keys[i % len(keys)]
        i += 1
        if not buckets[k]:
            continue
        pool = buckets[k]
        pick = pool.pop(random.randrange(len(pool)))
        out.append(pick)
    # 브랜드 커버리지 보강 (사이트별 상위 브랜드 + 저가 브랜드)
    for site in sorted(brands):
        site_rows = [r for r in rows if r["source_site"] == site]
        cnt = collections.Counter(r.get("source_brand", "") for r in site_rows)
        for br in [b for b, _ in cnt.most_common(3)] + [b for b, _ in cnt.most_common()[-2:]]:
            cand = [r for r in site_rows if r.get("source_brand") == br and r not in out]
            if cand and len(out) < limit:
                out.append(random.choice(cand))
    return out[:limit]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--master", required=True)
    ap.add_argument("--sample")
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=40)
    ap.add_argument("--headless", action="store_true", default=True)
    args = ap.parse_args()

    rows = load(args.master)
    if args.sample:
        wanted = {(r["source_site"], r["source_product_id"]) for r in load(args.sample)}
        sel = [r for r in rows if (r["source_site"], r["source_product_id"]) in wanted]
    else:
        sel = pick_sample(rows, args.limit)
    print(f"검증 대상 {len(sel)}건", file=sys.stderr)

    from playwright.sync_api import sync_playwright  # type: ignore

    results: List[Dict[str, Any]] = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=args.headless)
        ctx = browser.new_context(locale="ko-KR", viewport={"width": 1440, "height": 1000})
        page = ctx.new_page()
        for i, rec in enumerate(sel):
            url = rec.get("source_list_url") or rec.get("canonical_url")
            if not url:
                continue
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=45000)
                page.wait_for_timeout(1200)
                b = page.evaluate(EXTRACT_JS)
                html = page.content()
            except Exception as exc:  # noqa: BLE001
                results.append({"rec": rec, "error": str(exc)[:160], "b": {}, "parsed": {},
                                "l1_diffs": ["navigation_error"], "l2_diffs": []})
                print(f"[{i+1}/{len(sel)}] NAV-FAIL {rec['source_product_id']}: {str(exc)[:80]}", file=sys.stderr)
                continue
            site = rec["source_site"]
            parsed = C.parse_detail(html, site, rec["source_product_id"], url)
            cmp = compare(rec, b, parsed)
            results.append({"rec": rec, "b": b, "parsed": parsed, **cmp})
            print(f"[{i+1}/{len(sel)}] {site}#{rec['source_product_id']} "
                  f"l1={cmp['l1_diffs'] or 'OK'} l2={cmp['l2_diffs'] or 'OK'}", file=sys.stderr)
            time.sleep(0.4)
        browser.close()

    with open(args.out, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=OUT_FIELDS)
        w.writeheader()
        for r in results:
            rec, b, p = r["rec"], r.get("b", {}), r.get("parsed", {})
            l1 = r.get("l1_diffs") or []
            l2 = r.get("l2_diffs") or []
            hard = [d for d in l1 if "!" not in d]
            verdict = "MATCH" if not hard and not l2 else ("MISMATCH" if hard or l2 else "WARN")
            w.writerow({
                "source_site": rec["source_site"], "source_product_id": rec["source_product_id"],
                "product_name": rec.get("product_name", ""), "canonical_url": rec.get("canonical_url", ""),
                "checked_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "l1_name": b.get("h2Name") or b.get("basic", {}).get("상품명", ""),
                "l1_brand": b.get("brandField") or "", "l1_model": b.get("modelField") or "",
                "l1_price_text": b.get("priceText") or "", "l1_price_value": b.get("priceValue") or "",
                "l1_image_count": len(b.get("images", [])), "l1_option_groups": len(b.get("optionGroups", [])),
                "l1_option_value_count": b.get("optionValueCount", 0),
                "l1_soldout": int(bool(b.get("soldout"))), "l1_category": b.get("category") or "",
                "l1_canonical": b.get("canonical") or "",
                "m_name": rec.get("product_name", ""), "m_brand": rec.get("source_brand", ""),
                "m_model": rec.get("model", ""), "m_price_value": rec.get("published_price", ""),
                "m_image_count": len([x for x in (rec.get("image_urls") or "").split("|") if x]),
                "m_option_count": rec.get("option_count", ""),
                "l1_match": "OK" if not hard else "|".join(hard),
                "l2_parse_match": "OK" if not l2 else "|".join(l2),
                "mismatch_fields": "|".join(hard + l2),
                "verdict": verdict, "note": r.get("error", ""),
                "l1_notes": "|".join(r.get("notes") or []),
            })
    tot = len(results)
    match = sum(1 for r in results if not (r.get("l1_diffs") or []) and not (r.get("l2_diffs") or []))
    print(f"브라우저 검증 {tot}건 / 일치 {match}건 ({match/max(1,tot)*100:.1f}%)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
