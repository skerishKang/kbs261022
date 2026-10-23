#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
naver_field_readiness.py -- 이슈 #5 스마트스토어 등록용 필수·누락 필드 준비도 보고서.

data/full_catalog/product_db_compact.csv(커밋 마스터)만으로 계산한다 → product_db.xlsx
'sheet 의존(build_smartstore_prep.py)' 없이 어디서든 재실행 가능한 견고한 준비도 점검.

핵심 원칙
  * 여기에 적힌 '판매가'는 **공급처 공개 판매가**이다. CGI 공급가·판매가는 DB 어디에도
    없으며(항상 빈 값/미확정) 이 보고서로 대체·추정하지 않는다.
  * 재고·판매상태는 공개 표기(stock/soldout)만 근거로 하며 'unverified' 로 둔다.
  * 네이버 표준 카테고리 번호·원산지코드·ASTemplateCode·배송비·상세설명 정책은
    공급처 공개 정보에서 확보 불가 → 누락으로 명시(실등록 단계에서 고객/운영이 확정).
  * 실제 상품 게시·등록은 이 도구의 범위가 아니다(별도 단계).
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# 네이버 대량등록 템플릿의 필수 항목(공식 템플릿 조사 기반).
REQUIRED = ["상품명", "판매가", "재고수량", "대표이미지", "상세설명",
            "카테고리번호", "원산지코드", "ASTemplateCode", "배송비"]
RECOMMENDED = ["브랜드", "제조사", "모델명", "옵션", "검색태그", "판매자코드"]

# compact CSV 로 판정 가능한 항목만 True. 나머지는 원천 미확보 → 누락 처리.
DERIVABLE = {"상품명", "판매가", "대표이미지", "재고수량"}


def assess(row: dict) -> dict:
    """1상품에 대해 누락 필수값·준비도를 계산한다."""
    missing = []
    name = (row.get("product_name") or "").strip()
    price_state = (row.get("public_price_state") or "").strip()
    price = (row.get("public_price") or "").strip()
    img = int(row.get("image_count") or 0) if (row.get("image_count") or "").strip().isdigit() else 0

    if not name:
        missing.append("상품명")
    # 판매가: 공급처 '공개' 가격만 사용. 문의/품절/미확인 → 판매가 확정 불가로 누락 처리.
    if not (price and price_state == "public"):
        missing.append("판매가")
    # 재고수량: 공개 표기만 있고 확정 수량 아님 → 항상 미확정(누락) 처리.
    missing.append("재고수량")
    if img <= 0:
        missing.append("대표이미지")
    # 아래는 공급처 공개 DB에 없음 → 구조적 누락.
    for f in ["상세설명", "카테고리번호", "원산지코드", "ASTemplateCode", "배송비"]:
        missing.append(f)

    structural = {"상품명", "대표이미지"}
    if structural & set(missing):
        ready = "blocked"
    elif set(missing) <= {"재고수량", "상세설명", "카테고리번호", "원산지코드", "ASTemplateCode", "배송비", "판매가"}:
        # 가격만 없으면 partial, 그 외 정책류 누락은 partial(구조물은 갖춤)
        ready = "partial"
    else:
        ready = "partial"
    rec_missing = [f for f in RECOMMENDED if f in ("브랜드", "모델명", "제조사") and not (row.get({"브랜드": "brand", "모델명": "model", "제조사": "manufacturer"}[f]) or "").strip()]
    return {"missing_required": ";".join(missing), "ready": ready, "price_state": price_state,
            "rec_missing": ";".join(rec_missing)}


def build(baseline: Path) -> dict:
    rows = list(csv.DictReader(io.open(baseline, encoding="utf-8-sig", newline="")))
    per_row = []
    req_counter = Counter()
    rec_counter = Counter()
    ready_counter = Counter()
    by_site_ready = {}
    price_public = 0
    for r in rows:
        a = assess(r)
        site = (r.get("source_site") or "").strip()
        for f in a["missing_required"].split(";"):
            if f:
                req_counter[f] += 1
        for f in a["rec_missing"].split(";"):
            if f:
                rec_counter[f] += 1
        ready_counter[a["ready"]] += 1
        s = by_site_ready.setdefault(site, Counter())
        s[a["ready"]] += 1
        if a["price_state"] == "public":
            price_public += 1
        per_row.append({"source_key": f"{site}:{r.get('source_product_id')}",
                        "source_site": site, "product_name": r.get("product_name"),
                        "ready": a["ready"], "missing_required": a["missing_required"],
                        "recommended_missing": a["rec_missing"]})

    total = len(rows)
    return {
        "generated_from": "data/full_catalog/product_db_compact.csv",
        "total_products": total,
        "note_price": "'판매가'는 공급처 공개 판매가이며 CGI 공급가·판매가와 무관. 문의/품절/미확인 상품은 판매가 누락으로 계상.",
        "note_scope": "실제 네이버 상품 게시·등록은 별도 단계. 본 보고서는 필드 준비도만 산출.",
        "required_fields": REQUIRED,
        "derivable_from_source": sorted(DERIVABLE),
        "structurally_unavailable_from_public_source": [f for f in REQUIRED if f not in DERIVABLE],
        "required_missing_counts": dict(sorted(req_counter.items(), key=lambda kv: -kv[1])),
        "recommended_missing_counts": dict(sorted(rec_counter.items(), key=lambda kv: -kv[1])),
        "readiness_counts": dict(ready_counter),
        "readiness_by_site": {s: dict(c) for s, c in by_site_ready.items()},
        "public_price_available_count": price_public,
        "public_price_available_pct": round(100.0 * price_public / total, 1) if total else 0.0,
        "products_with_any_required_missing": sum(1 for r in per_row if r["missing_required"]),
        "fully_ready_count": ready_counter["ready"],
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="스마트스토어 필드 준비도(CSV 기반)")
    ap.add_argument("--baseline", default=str(REPO_ROOT / "data" / "full_catalog" / "product_db_compact.csv"))
    ap.add_argument("--out-json", default=str(REPO_ROOT / "reports" / "data" / "smartstore" / "field_readiness_report.json"))
    ap.add_argument("--out-rows", default=str(REPO_ROOT / "reports" / "data" / "smartstore" / "field_readiness_rows.csv"))
    args = ap.parse_args(argv)
    # per-row 재계산(보고서 본문에는 집계만; 행 단위 CSV는 별도)
    rows = list(csv.DictReader(io.open(args.baseline, encoding="utf-8-sig", newline="")))
    stats = build(Path(args.baseline))
    os.makedirs(os.path.dirname(args.out_json), exist_ok=True)
    Path(args.out_json).write_text(json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")
    with io.open(args.out_rows, "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["source_key", "source_site", "product_name",
                                           "ready", "missing_required", "recommended_missing"])
        w.writeheader()
        for r in rows:
            site = (r.get("source_site") or "").strip()
            a = assess(r)
            w.writerow({"source_key": f"{site}:{r.get('source_product_id')}", "source_site": site,
                        "product_name": r.get("product_name"), "ready": a["ready"],
                        "missing_required": a["missing_required"], "recommended_missing": a["rec_missing"]})
    print(json.dumps({k: stats[k] for k in ("total_products", "readiness_counts", "required_missing_counts",
                                            "public_price_available_count")}, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
