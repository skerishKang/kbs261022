#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
incremental_update.py -- 이슈 #5 삼아사운드/삼아스토어 상품 증분 갱신 reconciler.

목적
  커밋된 baseline 스냅샷(data/full_catalog/product_db_compact.csv, 2026-10-22 수집
  samasound 2,281 + samamusic 2,294 = 4,575) 대비, 현재 사이트를 (재)수집해
  신규(NEW) / 변경(CHANGED) / 삭제·단종후보(REMOVED) 를 판별한다.

원칙 (이슈 #5 재사용/추정 금지/무제한 요청 금지)
  * 수집 파서·Fetcher 는 tools/full_catalog/collect_cgi_catalog.py 를 그대로 재사용한다.
  * 안정 키 = (source_site, source_product_id)  [product_master 스키마와 동일]
  * 열거 신뢰도를 구분한다:
      - full    : '전체보기' 카테고리 목록 전 페이지 순회 → 현재 게시 집합의 완전한 초집합.
                  이 경우에만 baseline−snapshot 을 삭제·단종 후보로 분류한다.
      - partial : sitemap 등 부분 소스 → 관측분 안에서만 NEW/CHANGED 판정,
                  미관측 baseline 은 '삭제'로 단정하지 않고 'partial_unobserved' 로 보류한다
                  (예: samamusic sitemap 1,597 < baseline 2,294 → 삭제 추정 금지).
  * 가격은 공개 표기만 비교한다. CGI 공급가·판매가는 baseline 에서도 항상 비어/미확정으로
   유지하며 절대혼합하지 않는다.
  * 변경 판정은 스냅샷에 실제로 값이 있는 필드만 비교한다(빈 값=미수집→변경으로 잡지 않음).

산출물 (--out-dir)
  증분_변경후보.csv      change_type / source_site / source_product_id / 필드별 before·after / 근거
  incremental_stats.json 사이트별 new/changed/removed/unchanged/partial_unobserved 집계
"""
from __future__ import annotations

import argparse
import csv
import datetime as _dt
import importlib.util
import io
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]

# ---------------------------------------------------------------- collector 재사용
def _load_collector():
    path = REPO_ROOT / "tools" / "full_catalog" / "collect_cgi_catalog.py"
    spec = importlib.util.spec_from_file_location("collect_cgi_catalog", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

# ---------------------------------------------------------------- 기본 필드
BASELINE_DEFAULT = REPO_ROOT / "data" / "full_catalog" / "product_db_compact.csv"

# baseline(compact) ↔ snapshot(list) 필드 대응. 스냅샷에 값이 있는 것만 비교한다.
# 주의) URL 은 소스별 형태가 달라(정규 canonical vs 목록 display URL) 목록 스냅샷과
#       교차 비교하면 전원 오탐한다. 따라서 URL 은 추적 변경 대상에서 제외한다.
CHANGED_FIELDS = [
    ("product_name", "product_name", "name"),
    ("public_price", "public_price", "price"),
    ("brand", "brand", "brand"),
    ("model", "model", "model"),
]
# baseline 컬럼명 → snapshot 키(리스트 파서의 it[]) 로 대조할 때 쓰는 정규화 키
def _norm(v: Any) -> str:
    # 내부 연속 공백을 단일화 → 수집 시점의 공백 표기 차이(이중 space 등)가
    # 실제 변경으로 오탐되지 않도록 한다. 값 자체의 의미 변경만 잡는다.
    return "" if v is None else re.sub(r"\s+", " ", str(v)).strip()


def load_baseline(path: Path) -> Dict[str, Dict[str, str]]:
    out: Dict[str, Dict[str, str]] = {}
    with io.open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            site = _norm(row.get("source_site"))
            pid = _norm(row.get("source_product_id"))
            if not site or not pid:
                continue
            out[f"{site}:{pid}"] = row
    return out


# ============================================================ 순수 diff 로직(테스트 대상)
def diff_records(
    baseline: Dict[str, Dict[str, str]],
    snapshot: Dict[str, Dict[str, str]],
    *,
    full_enum: bool,
    tracked: Optional[List[Tuple[str, str, str]]] = None,
) -> List[Dict[str, Any]]:
    """baseline·snapshot 을 (site:id) 키로 비교해 변경 후보 행을 만든다.

    snapshot 행은 최소 keys: product_name, public_price, brand, model, source_url (값 없으면 "").
    반환 행의 change_type ∈ {new, changed, removed_candidate, partial_unobserved}
    unchanged 는 반환하지 않는다(집계 카운터에만 반영).
    """
    tracked = tracked or CHANGED_FIELDS
    rows: List[Dict[str, Any]] = []
    base_keys, snap_keys = set(baseline), set(snapshot)

    for key in snap_keys - base_keys:
        site, pid = key.split(":", 1)
        s = snapshot[key]
        rows.append({
            "change_type": "new",
            "source_site": site,
            "source_product_id": pid,
            "product_name": _norm(s.get("product_name")),
            "public_price": _norm(s.get("public_price")),
            "brand": _norm(s.get("brand")),
            "model": _norm(s.get("model")),
            "before": "",
            "after": "newly_observed",
            "changed_fields": "",
            "evidence_url": _norm(s.get("source_url")),
            "note": "baseline에 없던 상품. 신규 등록 후보(판매승인·공급가 미확정).",
        })

    for key in base_keys - snap_keys:
        site, pid = key.split(":", 1)
        b = baseline[key]
        if full_enum:
            ctype, note = "removed_candidate", "현재 전체목록에 없음. 삭제/단종 후보(실삭제 아님, 원문 보존)."
        else:
            ctype, note = "partial_unobserved", "부분열거(sitemap등)로 미관측. 삭제 단정 금지."
        rows.append({
            "change_type": ctype,
            "source_site": site,
            "source_product_id": pid,
            "product_name": _norm(b.get("product_name")),
            "public_price": _norm(b.get("public_price")),
            "brand": _norm(b.get("brand")),
            "model": _norm(b.get("model")),
            "before": _norm(b.get("sales_status")),
            "after": "",
            "changed_fields": "",
            "evidence_url": _norm(b.get("source_url")),
            "note": note,
        })

    for key in base_keys & snap_keys:
        site, pid = key.split(":", 1)
        b, s = baseline[key], snapshot[key]
        diffs = []
        for bcol, scol, label in tracked:
            bval, sval = _norm(b.get(bcol)), _norm(s.get(scol))
            if sval == "":          # 스냅샷 미수집 → 비교 불가
                continue
            if bval != sval:
                diffs.append((label, bval, sval))
        if diffs:
            rows.append({
                "change_type": "changed",
                "source_site": site,
                "source_product_id": pid,
                "product_name": _norm(s.get("product_name")) or _norm(b.get("product_name")),
                "public_price": _norm(s.get("public_price")) or _norm(b.get("public_price")),
                "brand": _norm(b.get("brand")),
                "model": _norm(b.get("model")),
                "before": "; ".join(f"{l}={ov}" for l, ov, _ in diffs),
                "after": "; ".join(f"{l}={nv}" for l, _, nv in diffs),
                "changed_fields": ",".join(l for l, _, _ in diffs),
                "evidence_url": _norm(s.get("source_url")) or _norm(b.get("source_url")),
                "note": "추적 필드 변경.",
            })
    rows.sort(key=lambda r: (r["change_type"], r["source_site"], r["source_product_id"]))
    return rows


def build_stats(csv_path: Path, site_counts: Dict[str, Dict[str, int]]) -> Dict[str, Any]:
    rows = list(csv.DictReader(io.open(csv_path, encoding="utf-8-sig", newline="")))
    return build_stats_rows(rows, site_counts)


def build_stats_rows(rows: List[Dict[str, Any]], site_counts: Dict[str, Dict[str, int]]) -> Dict[str, Any]:
    """누적된 변경후보 행을 사이트별 집계로 요약. site_counts 는 사이트별 총량."""
    from collections import Counter
    by_site_type = Counter((r["source_site"], r["change_type"]) for r in rows)
    ctype = Counter(r["change_type"] for r in rows)
    sites = sorted({r["source_site"] for r in rows} | set(site_counts))
    per_site = {}
    for site in sites:
        c = site_counts.get(site, {})
        bcount = c.get("baseline_products", 0)
        scount = c.get("snapshot_products", 0)
        per_site[site] = {
            "baseline_products": bcount,
            "snapshot_products": scount,
            "new": by_site_type[(site, "new")],
            "changed": by_site_type[(site, "changed")],
            "removed_candidate": by_site_type[(site, "removed_candidate")],
            "partial_unobserved": by_site_type[(site, "partial_unobserved")],
            "unchanged": max(scount - by_site_type[(site, "new")] - by_site_type[(site, "changed")], 0),
        }
    return {
        "generated_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "site_counts": site_counts,
        "totals": {
            "baseline_products": sum(v.get("baseline_products", 0) for v in site_counts.values()),
            "snapshot_products": sum(v.get("snapshot_products", 0) for v in site_counts.values()),
            "new": ctype["new"],
            "changed": ctype["changed"],
            "removed_candidate": ctype["removed_candidate"],
            "partial_unobserved": ctype["partial_unobserved"],
            "changed_breakdown": dict(Counter(f for r in rows if r["change_type"] == "changed"
                                              for f in (r.get("changed_fields") or "").split(",") if f)),
        },
        "per_site": per_site,
    }


# ============================================================ 스냅샷 로더
def snapshot_from_list_csv(path: Path) -> Dict[str, Dict[str, str]]:
    out: Dict[str, Dict[str, str]] = {}
    with io.open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            site = _norm(row.get("source_site"))
            pid = _norm(row.get("product_id"))
            if not site or not pid:
                continue
            out[f"{site}:{pid}"] = {
                "product_name": _norm(row.get("name")),
                "public_price": _norm(row.get("list_price")),
                "brand": "",                         # 목록에서는 브랜드 미확보(상세 필요)
                "model": "",
                "source_url": _norm(row.get("list_url")),
            }
    return out


def snapshot_from_sitemap_csv(path: Path, site: str) -> Dict[str, Dict[str, str]]:
    out: Dict[str, Dict[str, str]] = {}
    with io.open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            pid = _norm(row.get("product_id"))
            if not pid:
                continue
            out[f"{site}:{pid}"] = {
                "product_name": "", "public_price": "", "brand": "", "model": "",
                "source_url": _norm(row.get("url")),
            }
    return out


# ============================================================ 라이브 스냅샷(재사용 수집기)
def cmd_snapshot(site: str, enum: str, out_path: Path, cache: str, cate_no: Optional[int],
                 max_pages: int) -> int:
    C = _load_collector()
    fetcher = C.Fetcher(cache)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if enum == "sitemap":
        return C.collect_sitemap(fetcher, site, str(out_path))
    if enum == "full":
        root = cate_no if cate_no is not None else C.SITES[site].get("root_cate")
        if not root:
            print(f"[{site}] root_cate 미설정. --cate-no 지정 필요", file=sys.stderr)
            return 0
        return C.collect_list(fetcher, site, root, max_pages, str(out_path))
    raise ValueError("enum must be full|sitemap")


# ============================================================ CLI
def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="이슈 #5 상품 증분 갱신 reconciler")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_snap = sub.add_parser("snapshot", help="현재 사이트 수집 → 스냅샷 CSV")
    p_snap.add_argument("--site", required=True, choices=["samasound", "samamusic"])
    p_snap.add_argument("--enum", required=True, choices=["full", "sitemap"])
    p_snap.add_argument("--out", required=True)
    p_snap.add_argument("--cache", default=str(REPO_ROOT / ".cache" / "cgi-catalog"))
    p_snap.add_argument("--cate-no", type=int, default=None)
    p_snap.add_argument("--max-pages", type=int, default=200)

    p_diff = sub.add_parser("diff", help="baseline vs snapshot → 증분_변경후보.csv + stats")
    p_diff.add_argument("--baseline", default=str(BASELINE_DEFAULT))
    p_diff.add_argument("--site", required=True, choices=["samasound", "samamusic"])
    p_diff.add_argument("--snapshot", required=True, help="snapshot CSV (list 또는 sitemap)")
    p_diff.add_argument("--enum", required=True, choices=["full", "partial"])
    p_diff.add_argument("--out-dir", required=True)
    p_diff.add_argument("--append", action="store_true", help="같은 사이트의 여러 스냅샷 누적용(내부)")

    p_stat = sub.add_parser("report", help="누적된 변경후보 CSV에서 stats 재생성")
    p_stat.add_argument("--candidates", required=True)
    p_stat.add_argument("--out", required=True)

    args = ap.parse_args(argv)

    if args.cmd == "snapshot":
        n = cmd_snapshot(args.site, args.enum, Path(args.out), args.cache, args.cate_no, args.max_pages)
        print(f"[snapshot] {args.site} {args.enum} → {args.out} ({n}건)")
        return 0

    if args.cmd == "diff":
        baseline_all = load_baseline(Path(args.baseline))
        baseline = {k: v for k, v in baseline_all.items() if k.split(":", 1)[0] == args.site}
        # snapshot 포맷 자동 판별(list: name 컬럼 있음 / sitemap: url 컬럼만)
        srow = next(csv.DictReader(io.open(args.snapshot, encoding="utf-8-sig", newline="")), {})
        if "name" in srow:
            snapshot = snapshot_from_list_csv(Path(args.snapshot))
        else:
            snapshot = snapshot_from_sitemap_csv(Path(args.snapshot), args.site)
        snapshot = {k: v for k, v in snapshot.items() if k.split(":", 1)[0] == args.site}
        rows = diff_records(baseline, snapshot, full_enum=(args.enum == "full"))
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        csv_path = out_dir / "증분_변경후보.csv"
        _merge_write(csv_path, rows)
        stats_path = out_dir / "incremental_stats.json"
        # 사이트별 baseline/snapshot 총량은 누적 유지(다른 사이트 재실행에 안 깨짐)
        counts: Dict[str, Dict[str, int]] = {}
        if stats_path.exists():
            try:
                counts = json.loads(stats_path.read_text(encoding="utf-8")).get("site_counts", {})
            except Exception:
                counts = {}
        counts[args.site] = {"baseline_products": len(baseline), "snapshot_products": len(snapshot)}
        stats = build_stats(csv_path, counts)
        stats_path.write_text(json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")
        print(json.dumps(stats["per_site"][args.site], ensure_ascii=False))
        print(f"[diff] {args.site} enum={args.enum} → {csv_path}")
        return 0

    if args.cmd == "report":
        stats = build_stats(Path(args.candidates), {})
        Path(args.out).write_text(json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")
        print(json.dumps(stats["totals"], ensure_ascii=False))
        return 0

    return 0


CAND_FIELDS = ["change_type", "source_site", "source_product_id", "product_name", "public_price",
               "brand", "model", "before", "after", "changed_fields", "evidence_url", "note"]


def _merge_write(csv_path: Path, rows: List[Dict[str, Any]]) -> None:
    """같은 key가 이미 있으면 새 관측으로 갱신(사이트별 누적)."""
    existing: Dict[str, Dict[str, Any]] = {}
    if csv_path.exists():
        for r in csv.DictReader(io.open(csv_path, encoding="utf-8-sig", newline="")):
            existing[f"{r['source_site']}:{r['source_product_id']}"] = r
    for r in rows:
        existing[f"{r['source_site']}:{r['source_product_id']}"] = {k: r.get(k, "") for k in CAND_FIELDS}
    merged = sorted(existing.values(), key=lambda r: (r["change_type"], r["source_site"], r["source_product_id"]))
    with io.open(csv_path, "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=CAND_FIELDS)
        w.writeheader()
        for r in merged:
            w.writerow({k: r.get(k, "") for k in CAND_FIELDS})


if __name__ == "__main__":
    raise SystemExit(main())
