#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Read-only comparison: Ecount ERP exported items vs CGI product master (4,575).

Inputs:
  ERP export: reports/data/erp/ecount_item_export.xlsx (downloaded, read-only)
  CGI DB:     data/full_catalog/product_db.xlsx ('통합상품')
Outputs (aggregated, no raw ERP dump):
  reports/data/erp/erp_readonly_comparison.json
  reports/data/erp/erp_readonly_comparison.csv
  reports/data/erp/erp_readonly_report.md
"""
from __future__ import annotations

import csv
import json
import os
import re
import sys
from collections import Counter, defaultdict

try:
    import openpyxl
except ImportError as exc:
    raise SystemExit("openpyxl required") from exc

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ERP_XLSX = os.path.join(REPO_ROOT, "reports", "data", "erp", "ecount_item_export.xlsx")
DB_PATH = os.path.join(REPO_ROOT, "data", "full_catalog", "product_db.xlsx")
OUT_DIR = os.path.join(REPO_ROOT, "reports", "data", "erp")


def norm(s):
    if s is None:
        return ""
    s = str(s).lower()
    s = re.sub(r"\s+", "", s)
    s = re.sub(r"[^a-z0-9가-힣]", "", s)
    return s


def load_erp_items():
    if not os.path.exists(ERP_XLSX):
        raise FileNotFoundError(ERP_XLSX)
    wb = openpyxl.load_workbook(ERP_XLSX, read_only=False, data_only=True)
    ws = wb["품목등록"]
    rows = list(ws.iter_rows(values_only=True))
    # row0 company, row1 header, data from row2, last row timestamp
    header = rows[1]
    idx = {name: i for i, name in enumerate(header) if name}
    items = []
    for r in rows[2:]:
        if not r or r[idx["품목코드"]] is None:
            continue
        # skip footer (timestamp in first col)
        code = str(r[idx["품목코드"]]).strip()
        if not code or code.startswith("202"):
            continue
        items.append({
            "erp_code": code,
            "erp_name": str(r[idx["품목명"]]).strip() if r[idx["품목명"]] is not None else "",
            "erp_type": str(r[idx["품목구분"]]).strip() if r[idx["품목구분"]] is not None else "",
            "erp_spec": str(r[idx["규격명"]]).strip() if r[idx["규격명"]] is not None else "",
            "erp_group": str(r[idx["계층그룹명"]]).strip() if r[idx["계층그룹명"]] is not None else "",
            "erp_search": str(r[idx["검색창내용"]]).strip() if r[idx["검색창내용"]] is not None else "",
            "erp_stock_mgmt": str(r[idx["재고수량관리"]]).strip() if r[idx["재고수량관리"]] is not None else "",
            "erp_vat_in": str(r[idx["입고단가Vat포함여부"]]).strip() if r[idx["입고단가Vat포함여부"]] is not None else "",
            "erp_vat_out": str(r[idx["출고단가Vat포함여부"]]).strip() if r[idx["출고단가Vat포함여부"]] is not None else "",
        })
    return items, idx


def load_cgi_master():
    wb = openpyxl.load_workbook(DB_PATH, read_only=True, data_only=True)
    ws = wb["통합상품"]
    rows = list(ws.iter_rows(values_only=True))
    header = rows[0]
    idx = {name: i for i, name in enumerate(header)}
    items = []
    for r in rows[1:]:
        if not r or r[idx["통합키"]] is None:
            continue
        items.append({
            "cgi_key": str(r[idx["통합키"]]),
            "cgi_name": str(r[idx["상품명"]]).strip() if r[idx["상품명"]] is not None else "",
            "cgi_brand": str(r[idx["브랜드"]]).strip() if r[idx["브랜드"]] is not None else "",
            "cgi_model": str(r[idx["모델명"]]).strip() if r[idx["모델명"]] is not None else "",
            "cgi_price": r[idx["공개판매가"]],
            "cgi_source": str(r[idx["공급처코드"]]).strip() if r[idx["공급처코드"]] is not None else "",
        })
    return items


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    erp_items, _ = load_erp_items()
    cgi_items = load_cgi_master()

    # index CGI by normalized name and model
    cgi_by_name = defaultdict(list)
    cgi_by_model = defaultdict(list)
    for c in cgi_items:
        cgi_by_name[norm(c["cgi_name"])].append(c)
        if c["cgi_model"]:
            cgi_by_model[norm(c["cgi_model"])].append(c)

    exact_code_matches = 0  # ERP codes are 000001 style, CGI are SS/SM-xxx => 0
    name_matches = []
    model_matches = []
    matched_cgi_keys = set()

    for e in erp_items:
        en = norm(e["erp_name"])
        es = norm(e["erp_spec"])
        esearch = norm(e["erp_search"])
        # name match
        if en and en in cgi_by_name:
            for c in cgi_by_name[en]:
                name_matches.append((e, c, "name_exact"))
                matched_cgi_keys.add(c["cgi_key"])
        # model match (spec or search contains model)
        if es:
            for c in cgi_by_model.get(es, []):
                model_matches.append((e, c, "model_exact"))
                matched_cgi_keys.add(c["cgi_key"])
        # fuzzy: erp spec contained in cgi model or vice versa
        # (handled separately as candidate)

    # candidate matches: erp spec/name substring in cgi model/name
    candidate_matches = []
    for e in erp_items:
        es = norm(e["erp_spec"]) or norm(e["erp_name"])
        if not es or len(es) < 4:
            continue
        for c in cgi_items:
            cm = norm(c["cgi_model"])
            cn = norm(c["cgi_name"])
            if not es:
                continue
            # require non-empty counterpart
            ok = False
            if cm and len(cm) >= 4 and (es in cm or cm in es):
                ok = True
            elif cn and len(cn) >= 6 and es in cn:
                ok = True
            if ok and c["cgi_key"] not in matched_cgi_keys:
                candidate_matches.append((e, c, "substring"))
                break

    # unique candidate cgi keys
    cand_keys = set(c["cgi_key"] for (_, c, _) in candidate_matches)

    erp_codes_set = set(e["erp_code"] for e in erp_items)
    cgi_keys_set = set(c["cgi_key"] for c in cgi_items)

    # ERP groups
    group_counts = Counter(e["erp_group"] for e in erp_items)
    type_counts = Counter(e["erp_type"] for e in erp_items)

    # CGI source distribution
    cgi_source_counts = Counter(c["cgi_source"] for c in cgi_items)

    report = {
        "generated_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "erp_total_items": len(erp_items),
        "cgi_total_items": len(cgi_items),
        "exact_code_matches": 0,
        "name_exact_matches": len(name_matches),
        "model_exact_matches": len(model_matches),
        "candidate_substring_matches": len(candidate_matches),
        "matched_cgi_unique": len(matched_cgi_keys | cand_keys),
        "erp_matched_count": len(set(e["erp_code"] for e, _, _ in (name_matches + model_matches + candidate_matches))),
        "erp_only_count": len(erp_items) - len(set(e["erp_code"] for e, _, _ in (name_matches + model_matches + candidate_matches))),
        "cgi_only_count": len(cgi_items) - len(matched_cgi_keys | cand_keys),
        "erp_groups": dict(group_counts),
        "erp_types": dict(type_counts),
        "cgi_sources": dict(cgi_source_counts),
        "price_comparison": "ERP export has no price columns; price differences not computable from this export",
        "stock_comparison": "ERP export has stock management flag only; quantities not included",
        "samples_name_matches": [{"erp_code": e["erp_code"], "erp_name": e["erp_name"], "cgi_key": c["cgi_key"], "cgi_name": c["cgi_name"]} for e, c, _ in name_matches[:20]],
        "samples_model_matches": [{"erp_code": e["erp_code"], "erp_spec": e["erp_spec"], "cgi_key": c["cgi_key"], "cgi_model": c["cgi_model"]} for e, c, _ in model_matches[:20]],
        "samples_candidates": [{"erp_code": e["erp_code"], "erp_spec": e["erp_spec"], "cgi_key": c["cgi_key"], "cgi_model": c["cgi_model"]} for e, c, _ in candidate_matches[:20]],
    }

    with open(os.path.join(OUT_DIR, "erp_readonly_comparison.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    # CSV of matched pairs
    csv_path = os.path.join(OUT_DIR, "erp_readonly_comparison.csv")
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["match_type", "erp_code", "erp_name", "erp_spec", "erp_group", "cgi_key", "cgi_name", "cgi_brand", "cgi_model", "cgi_source"])
        for e, c, t in name_matches:
            w.writerow([t, e["erp_code"], e["erp_name"], e["erp_spec"], e["erp_group"], c["cgi_key"], c["cgi_name"], c["cgi_brand"], c["cgi_model"], c["cgi_source"]])
        for e, c, t in model_matches:
            w.writerow([t, e["erp_code"], e["erp_name"], e["erp_spec"], e["erp_group"], c["cgi_key"], c["cgi_name"], c["cgi_brand"], c["cgi_model"], c["cgi_source"]])
        for e, c, t in candidate_matches:
            w.writerow([t, e["erp_code"], e["erp_name"], e["erp_spec"], e["erp_group"], c["cgi_key"], c["cgi_name"], c["cgi_brand"], c["cgi_model"], c["cgi_source"]])

    # markdown summary
    md = f"""# ERP 읽기 전용 대조 결과 (CGI LOCAL 3)

- ERP 실제 등록 품목 수: {len(erp_items)}
- CGI 기존 상품 수: {len(cgi_items)}
- 품목코드 정확 일치: 0 (ERP 코드 체계 000001 vs CGI SS/SM-xxx)
- 상품명 정확 일치: {len(name_matches)}
- 모델명 정확 일치: {len(model_matches)}
- 후보(substring) 매칭: {len(candidate_matches)}
- 매칭된 CGI 고유 건수: {len(matched_cgi_keys | cand_keys)}
- ERP에만 존재(매칭 안 된 ERP): {len(erp_items) - len(set(e['erp_code'] for e,_,_ in name_matches+model_matches))}
- CGI에만 존재(매칭 안 된 CGI): {len(cgi_items) - len(matched_cgi_keys | cand_keys)}

## ERP 품목 그룹 분포
{json.dumps(dict(group_counts), ensure_ascii=False, indent=2)}

## ERP 품목 구분 분포
{json.dumps(dict(type_counts), ensure_ascii=False, indent=2)}

## CGI 공급처 분포
{json.dumps(dict(cgi_source_counts), ensure_ascii=False, indent=2)}

## 참고
- ERP export에는 가격/재고수량 컬럼이 없어 가격·재고 불일치는 본 엑스포트 기준 산출 불가.
- ERP 데이터는 읽기 전용으로 추출; 쓰기 0건.
"""
    with open(os.path.join(OUT_DIR, "erp_readonly_report.md"), "w", encoding="utf-8") as f:
        f.write(md)

    print(json.dumps({k: report[k] for k in ["erp_total_items", "cgi_total_items", "exact_code_matches", "name_exact_matches", "model_exact_matches", "candidate_substring_matches", "matched_cgi_unique"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
