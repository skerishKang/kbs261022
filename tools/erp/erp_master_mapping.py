#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ERP(이카운트) 964품목 × CGI 통합 상품 마스터 4,575건 읽기 전용 중복 대조·매핑.

compare_erp_cgi.py의 로더·정규화를 재사용한다(신규 마스터 DB 구축 없음).
분류 6종: EXACT_MATCH / NORMALIZED_MATCH / SUSPECTED_DUPLICATE /
NEW_CANDIDATE / INSUFFICIENT_DATA / CONFLICT.

보안·운영 경계:
- ERP·네이버·마스터 입력은 전부 읽기 전용. 쓰기 대상은 산출 파일뿐이다.
- 품목 단위 매핑 CSV는 비공개 위치(--mapping-out, 저장소 밖 권장)에만 쓴다.
- 저장소에 커밋되는 산출물은 비식별 집계 요약(--summary-out)뿐이다.
- 결정적 출력: 입력이 같으면 바이트 단위로 동일한 매핑표가 재생성된다.

Usage:
  python tools/erp/erp_master_mapping.py \
      --erp-xlsx <비공개>/ecount_item_export.xlsx \
      --mapping-out <비공개>/erp_master_mapping.csv \
      --summary-out reports/data/erp/erp_master_mapping_summary.json
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from collections import defaultdict

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
from tools.erp.compare_erp_cgi import (  # noqa: E402
    norm, load_erp_items, load_cgi_master, REPO_ROOT,
)

MATCH_TYPES = (
    "EXACT_MATCH", "NORMALIZED_MATCH", "SUSPECTED_DUPLICATE",
    "NEW_CANDIDATE", "INSUFFICIENT_DATA", "CONFLICT",
)

# 점수 기준(결정적). 상한은 등급 경계와 결합된다.
SCORE_CODE = 100          # 제안 품목코드(SS-/SM-) 실재 일치
SCORE_MODEL_BRAND = 95    # 모델 정확 + 브랜드 일치
SCORE_SEARCH_BRAND = 90   # 검색창 내용 모델 토 정확 + 브랜드 일치
SCORE_MODEL_ONLY = 80     # 모델 정확, 브랜드 불일치/결측 → 표기 차이 동일 품목 후보
SCORE_NAME_EXACT = 75     # 품목명 정규화 정확 일치
SCORE_SUSPECT_MAX = 65    # 유사도 상한(자동 확정 금지 경계)

EXACT_FLOOR = 90          # EXACT 등급 하한
NORMALIZED_FLOOR = 75     # NORMALIZED 등급 하한

STATE_TOKENS = ("리퍼", "박스손상", "개봉", "교환상품", "흠집", "전시", "단종", "임박")
SET_HINT_ERP = ("세트", "번들", "PACKAGE", "KIT")

# 공급처 원본 ID → 제안 ERP 품목코드 규칙(ERP_PREP §3와 동일 계약)
SOURCE_PREFIX = {"samasound": "SS", "samamusic": "SM"}


def proposed_code(cgi_key: str, source: str) -> str:
    sid = cgi_key.split(":", 1)[1] if ":" in cgi_key else ""
    prefix = SOURCE_PREFIX.get(source, "")
    return f"{prefix}-{sid}" if prefix and sid else ""


def brand_ok(master, erp) -> bool:
    """브랜드 일치: 영문 직접 비교 + 검색창내용 내 영문 브랜드/한글 표기."""
    mb = norm(master["cgi_brand"]) or norm(master.get("cgi_manufacturer"))
    if not mb:
        return False
    search = norm(erp.get("erp_search"))
    name = norm(erp.get("erp_name"))
    if mb and (mb in search or mb in name):
        return True
    # 브랜드 영문 첫 토큰(예: ALLEN&HEATH → allen, heath)으로도 본다
    for tok in re.split(r"[^a-z0-9]+", mb):
        if len(tok) >= 4 and (tok in search or tok in name):
            return True
    return False


def model_of_master(master) -> str:
    return norm(master["cgi_model"])


def erp_model_tokens(erp) -> set:
    text = f"{erp.get('erp_spec') or ''} {erp.get('erp_search') or ''}"
    toks = set()
    for t in re.split(r"[^0-9A-Za-z가-힣]+", str(text).lower()):
        t = re.sub(r"[^a-z0-9가-힣]", "", t)
        if len(t) >= 3 and re.search(r"[a-z0-9]", t) and not re.fullmatch(r"[가-힣]+", t):
            toks.add(t)
    return toks


def state_tokens(text) -> frozenset:
    low = str(text or "").lower()
    return frozenset(t for t in STATE_TOKENS if t in low)


def is_set_erp(erp) -> bool:
    blob = f"{erp.get('erp_name') or ''}{erp.get('erp_type') or ''}".lower()
    return any(h.lower() in blob for h in SET_HINT_ERP)


def score_pair(master, erp) -> tuple:
    """(score, basis) — 결정적 단일 경로. 점수·근거를 함께 반환한다."""
    mm = model_of_master(master)
    spec = norm(erp.get("erp_spec"))
    prop = proposed_code(master["cgi_key"], master["cgi_source"])

    if prop and prop == str(erp.get("erp_code", "")).strip():
        return SCORE_CODE, "erp_code_exact"
    if mm and spec and mm == spec:
        if brand_ok(master, erp):
            return SCORE_MODEL_BRAND, "model_brand_exact"
        return SCORE_MODEL_ONLY, "model_exact_brand_diff"
    if mm and mm in erp_model_tokens(erp):
        if brand_ok(master, erp):
            return SCORE_SEARCH_BRAND, "model_search_brand"
    if norm(master["cgi_name"]) and norm(master["cgi_name"]) == norm(erp.get("erp_name")):
        return SCORE_NAME_EXACT, "name_exact"
    return 0, ""


def suspect_score(master, erp) -> int:
    """3차 유사도(후보 발견용). 확정은 금지 — 상한 SCORE_SUSPECT_MAX."""
    probe = norm(erp.get("erp_spec")) or norm(erp.get("erp_name"))
    if len(probe) < 4:
        return 0
    mm = model_of_master(master)
    name = norm(master["cgi_name"])
    s = 0
    if mm and len(mm) >= 4 and (probe in mm or mm in probe):
        s = 55 if brand_ok(master, erp) else 45
    elif name and len(name) >= 6 and probe in name:
        s = 50 if brand_ok(master, erp) else 40
    return min(s, SCORE_SUSPECT_MAX)


def guard_downgrade(master, erp, score, basis):
    """단품/세트·옵션·상태 토큰 불일치 → 자동 병합 금지(SUSPECTED로 강등)."""
    if score < EXACT_FLOOR:
        return score, basis, ""
    reasons = []
    master_is_set = bool(re.search(r"세트|키트|\bkit\b|\bset\b", master["cgi_name"], re.I))
    if is_set_erp(erp) and not master_is_set:
        reasons.append("erp_set_vs_single_master")
    if master_is_set and not is_set_erp(erp):
        reasons.append("master_set_vs_single_erp")
    if state_tokens(master["cgi_name"]) != state_tokens(erp.get("erp_name")):
        reasons.append("state_token_mismatch")
    try:
        opts = int(master.get("cgi_option_count") or 0)
    except ValueError:
        opts = 0
    if opts > 1 and not norm(erp.get("erp_spec")):
        reasons.append("multi_option_master_vs_plain_erp")
    if reasons:
        return SCORE_SUSPECT_MAX, basis + "|guarded:" + ",".join(reasons), "Y"
    return score, basis, ""


def has_identifier(master) -> bool:
    if model_of_master(master):
        return True
    b = norm(master["cgi_brand"])
    return bool(b) and b not in {"nnnn", "기타", "none", "null"}


def build_mapping(masters, erps, naver_ids=None):
    """4,575건 × 964건 대조 → 분류 행. 입력 순서·내용이 같으면 출력도 동일하다."""
    naver_ids = naver_ids or set()
    erps = sorted(erps, key=lambda e: str(e.get("erp_code", "")))
    masters = sorted(masters, key=lambda m: (m["cgi_key"], m["cgi_source"]))

    by_model = defaultdict(list)
    by_name = defaultdict(list)
    by_code = {}
    for e in erps:
        by_code[str(e.get("erp_code", "")).strip()] = e
        sp = norm(e.get("erp_spec"))
        if sp:
            by_model[sp].append(e)
        nm = norm(e.get("erp_name"))
        if nm:
            by_name[nm].append(e)

    # 1) 마스터별 최고 후보 수집(전량 스캔 대신 인덱스 히트 + 필요 시 유사도 스캔)
    claims = []  # (score desc, master_key, erp_code, basis, review)
    per_master = {}
    for m in masters:
        cands = {}
        mm = model_of_master(m)
        pool = list(by_model.get(mm, [])) if mm else []
        pool += list(by_name.get(norm(m["cgi_name"]), []))
        prop = proposed_code(m["cgi_key"], m["cgi_source"])
        if prop and prop in by_code:
            pool.append(by_code[prop])
        best = (0, "", "", "")
        for e in pool:
            sc, basis = score_pair(m, e)
            review = ""
            if sc:
                sc, basis, review = guard_downgrade(m, e, sc, basis)
            if sc > best[0] or (sc == best[0] and sc and str(e["erp_code"]) < str(best[1])):
                best = (sc, str(e.get("erp_code", "")), basis, review)
        if best[0] < EXACT_FLOOR and best[0] < SCORE_NAME_EXACT:
            # 3차 유사도: 후보 발견 전용(전체 스캔, 결정적 최소 히트)
            for e in erps:
                s2 = suspect_score(m, e)
                if s2 > best[0]:
                    best = (s2, str(e.get("erp_code", "")), "token_containment", "Y")
        per_master[m["cgi_key"]] = best
        if best[0] > 0:
            claims.append((best[0], m["cgi_key"], best[1], best[2], best[3]))

    # 2) 다중 실체 판정: 같은 ERP를 EXACT/NORMALIZED로 요구하는 마스터가 2↑ → CONFLICT
    erp_exact_owners = defaultdict(list)
    for sc, mk, ec, basis, rv in claims:
        if sc >= NORMALIZED_FLOOR:
            erp_exact_owners[ec].append(mk)

    # 3) 1:1 배정(결정적): 점수↓, 마스터키↑, ERP코드↑. 밀린 행은 SUSPECTED 강등.
    claims.sort(key=lambda t: (-t[0], t[1], t[2]))
    assigned_master = set()
    assigned_erp = set()
    final = {}
    for sc, mk, ec, basis, rv in claims:
        if mk in assigned_master or ec in assigned_erp:
            continue
        assigned_master.add(mk)
        assigned_erp.add(ec)
        final[mk] = (sc, ec, basis, rv)

    conflict_ers = {ec for ec, owners in erp_exact_owners.items() if len(owners) > 1}

    rows = []
    for m in masters:
        mk = m["cgi_key"]
        sc, ec, basis, rv = final.get(mk, (0, "", "", ""))
        raw_sc, raw_ec, raw_basis, raw_rv = per_master.get(mk, (0, "", "", ""))
        if ec:
            shared = ec in conflict_ers
            if sc >= EXACT_FLOOR:
                mt, reason = "EXACT_MATCH", ("multi_master_same_erp" if shared else "")
            elif sc >= NORMALIZED_FLOOR:
                mt, reason = "NORMALIZED_MATCH", ("multi_master_same_erp" if shared else "")
            else:
                mt, reason = "SUSPECTED_DUPLICATE", ""
            if shared:
                rv = "Y"
        elif raw_sc >= NORMALIZED_FLOOR and raw_ec:
            # 배정에서 밀렸지만 실 후보는 존재 → 수동 확인
            mt, reason, ec, basis = "CONFLICT", "lost_1to1_assignment", "", raw_basis
        elif raw_sc > 0 and raw_ec:
            mt, reason = "SUSPECTED_DUPLICATE", ""
            ec, basis = "", raw_basis  # 근거 코드만 비고에
        elif not has_identifier(m):
            mt, reason = "INSUFFICIENT_DATA", ""
            basis = "no_brand_no_model"
        else:
            mt, reason = "NEW_CANDIDATE", ""

        # 마스터→ERP 다중 후보 관계(확정 전) 기록
        others = []
        mm = model_of_master(m)
        for e in by_model.get(mm, []):
            if str(e["erp_code"]) != ec:
                others.append(str(e["erp_code"]))
        if not ec and raw_ec:
            others.append(raw_ec)
        conf = round(sc / 100, 2) if sc else (0.0 if mt in ("NEW_CANDIDATE",) else "")
        review_flag = rv or ("Y" if mt in ("SUSPECTED_DUPLICATE", "CONFLICT", "INSUFFICIENT_DATA") else "")
        rows.append({
            "master_product_id": mk,
            "source_product_code": f"{m['cgi_source']}:{m['cgi_source_id']}",
            "proposed_prod_cd": proposed_code(mk, m["cgi_source"]),
            "naver_registered": "Y" if mk in naver_ids else "N",
            "erp_item_code": ec,
            "matching_type": mt,
            "matching_basis": basis,
            "confidence": conf,
            "conflict_reason": reason,
            "other_erp_candidates": ";".join(sorted(set(others))[:5]),
            "review_required": review_flag,
        })
    return rows


def integrity_check(rows, masters, erps):
    issues = []
    if len(rows) != len(masters):
        issues.append(f"row_count_mismatch rows={len(rows)} masters={len(masters)}")
    seen = set()
    for r in rows:
        if r["master_product_id"] in seen:
            issues.append(f"duplicate_master_row {r['master_product_id']}")
        seen.add(r["master_product_id"])
    valid_codes = {str(e.get("erp_code", "")).strip() for e in erps}
    for r in rows:
        if r["erp_item_code"] and r["erp_item_code"] not in valid_codes:
            issues.append(f"unknown_erp_code {r['master_product_id']} -> {r['erp_item_code']}")
    used = defaultdict(list)
    for r in rows:
        if r["erp_item_code"] and r["matching_type"] in ("EXACT_MATCH", "NORMALIZED_MATCH"):
            used[r["erp_item_code"]].append(r["master_product_id"])
    for ec, owners in used.items():
        if len(owners) > 1:
            issues.append(f"erp_code_reused {ec} by {owners}")
    used_masters = defaultdict(list)
    for r in rows:
        if r["erp_item_code"] and r["matching_type"] in ("EXACT_MATCH", "NORMALIZED_MATCH"):
            used_masters[r["master_product_id"]].append(r["erp_item_code"])
    for mk, ecs in used_masters.items():
        if len(ecs) > 1:
            issues.append(f"master_multi_exact {mk} -> {ecs}")
    return issues


def summarize(rows, erps):
    counts = {t: 0 for t in MATCH_TYPES}
    for r in rows:
        counts[r["matching_type"]] += 1
    confirmed = ("EXACT_MATCH", "NORMALIZED_MATCH")
    matched_codes = {r["erp_item_code"] for r in rows if r["erp_item_code"] and r["matching_type"] in confirmed}
    multi = defaultdict(list)
    for r in rows:
        if r["erp_item_code"] and r["matching_type"] in confirmed:
            multi[r["erp_item_code"]].append(r["master_product_id"])
    return {
        "mapping_rows": len(rows),
        "erp_actual_items": len(erps),
        "classification_counts": counts,
        "erp_items_confirmed_mapped": len(matched_codes),
        "erp_items_suspected_referenced": len({r["erp_item_code"] for r in rows if r["erp_item_code"] and r["matching_type"] not in confirmed}),
        "unmatched_erp_items": len(erps) - len(matched_codes),
        "multi_master_to_same_erp_pairs": sum(1 for v in multi.values() if len(v) > 1),
        "new_candidate_count": counts["NEW_CANDIDATE"],
        "review_required_count": sum(1 for r in rows if r["review_required"] == "Y"),
        "naver_registered_reference_count": sum(1 for r in rows if r["naver_registered"] == "Y"),
        "erp_writes": 0,
        "naver_writes": 0,
        "master_writes": 0,
    }


def load_naver_reference(path):
    if not path or not os.path.exists(path):
        return set()
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    return {str(r.get("cgiId", "")) for r in doc.get("records", []) if r.get("cgiId")}


def write_mapping_csv(rows, path):
    cols = ["master_product_id", "source_product_code", "proposed_prod_cd", "naver_registered",
            "erp_item_code", "matching_type", "matching_basis", "confidence",
            "conflict_reason", "other_erp_candidates", "review_required"]
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(path, "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow(r)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--erp-xlsx", required=True)
    ap.add_argument("--master-xlsx", default=os.path.join(REPO_ROOT, "data", "full_catalog", "product_db.xlsx"))
    ap.add_argument("--naver-ledger", default=os.path.join(REPO_ROOT, "reports", "data", "erp", "linkage_plan_20261030.json"))
    ap.add_argument("--mapping-out", required=True, help="비공개 위치에만 저장할 전체 매핑표 CSV")
    ap.add_argument("--summary-out", default="", help="저장소 커밋용 비식별 집계 JSON")
    args = ap.parse_args()

    erps = load_erp_items(args.erp_xlsx)
    masters = load_cgi_master()
    naver = load_naver_reference(args.naver_ledger)

    rows = build_mapping(masters, erps, naver)
    issues = integrity_check(rows, masters, erps)
    summary = summarize(rows, erps)
    summary["integrity_issues"] = issues
    summary["inputs"] = {
        "erp_xlsx": os.path.basename(args.erp_xlsx),
        "master_rows": len(masters),
        "naver_ledger_rows": len(naver),
    }

    write_mapping_csv(rows, args.mapping_out)
    if args.summary_out:
        os.makedirs(os.path.dirname(args.summary_out), exist_ok=True)
        with open(args.summary_out, "w", encoding="utf-8") as fh:
            json.dump(summary, fh, ensure_ascii=False, indent=2, sort_keys=True)
            fh.write("\n")
    print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True))
    return 1 if issues else 0


if __name__ == "__main__":
    raise SystemExit(main())
