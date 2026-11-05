#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""bid/assets/data/bid-data.js (및 result-data.js) 형식 검증 — CI(bid-tests)에서 돈다.

깨진 데이터가 화면에 올라가는 것을 막는다(이슈 #188 3차).
  - 공고번호 중복 없음, 필수 키 존재, 분류값·상태값이 허용 집합 안
  - 날짜 형식(YYYY-MM-DD / YYYY-MM-DD HH:MM:SS), 공고일 ≤ 마감 ≤ 개찰(있을 때)
  - 마감이 공고일로부터 1년 넘게 뒤면 `lt`(장기 접수) 표시가 있어야 함
  - 취소공고는 포함하지 않음, 금액은 정수 또는 null
  - `cgi_match`는 불리언이고 `mk`(적중 키워드)는 문자열 목록이며, true면 비어 있지 않고
    false면 비어 있어야 한다(이슈 #188 7차)
사용: python tools/procurement/validate_bid_data.py  (종료 코드 0=정상, 1=오류)
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BID_DATA = REPO / "bid" / "assets" / "data" / "bid-data.js"
RESULT_DATA = REPO / "bid" / "assets" / "data" / "result-data.js"

CATS = {"구매", "공사", "용역", "매각"}
STATUSES = {"등록공고", "재공고", "변경공고", "긴급공고", "정정공고"}
REQUIRED = ("no", "t", "a", "c", "k", "s", "pd", "cu")
RE_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
RE_DT = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")
LONG_TERM_DAYS = 365


def load_js(path: Path):
    src = path.read_text(encoding="utf-8")
    body = src[src.index("=") + 1:].rstrip().rstrip(";").strip()
    return json.loads(body) if body != "null" else None


def _d(s):
    return datetime.strptime(str(s)[:10], "%Y-%m-%d")


def validate_bids(data) -> list[str]:
    errs: list[str] = []
    if not isinstance(data, dict):
        return ["bid-data.js: 객체가 아님"]
    if not RE_DATE.match(str(data.get("snapshot") or "")):
        errs.append(f"snapshot 형식 오류: {data.get('snapshot')!r}")
    bids = data.get("bids")
    if not isinstance(bids, list) or not bids:
        return errs + ["bids 비어 있음"]
    seen = set()
    for i, b in enumerate(bids):
        tag = f"[{i}] {b.get('no')}"
        for k in REQUIRED:
            if b.get(k) in (None, ""):
                errs.append(f"{tag}: 필수 키 없음 {k}")
        if b.get("no") in seen:
            errs.append(f"{tag}: 공고번호 중복")
        seen.add(b.get("no"))
        if b.get("c") not in CATS:
            errs.append(f"{tag}: 분류값 오류 {b.get('c')!r}")
        if b.get("s") not in STATUSES:
            errs.append(f"{tag}: 상태값 오류 {b.get('s')!r}")
        if "취소" in str(b.get("s") or ""):
            errs.append(f"{tag}: 취소공고 포함")
        for k in ("ep", "ab"):
            if b.get(k) is not None and not isinstance(b.get(k), int):
                errs.append(f"{tag}: {k} 정수 아님 {b.get(k)!r}")
        if not RE_DATE.match(str(b.get("pd") or "")):
            errs.append(f"{tag}: 공고일 형식 오류 {b.get('pd')!r}")
        for k in ("cd", "od"):
            if b.get(k) is not None and not RE_DT.match(str(b.get(k))):
                errs.append(f"{tag}: {k} 형식 오류 {b.get(k)!r}")
        try:
            pd = _d(b["pd"]) if RE_DATE.match(str(b.get("pd") or "")) else None
            cd = _d(b["cd"]) if b.get("cd") and RE_DT.match(str(b["cd"])) else None
            od = _d(b["od"]) if b.get("od") and RE_DT.match(str(b["od"])) else None
            if pd and cd and cd < pd:
                errs.append(f"{tag}: 마감({b['cd']})이 공고일({b['pd']})보다 앞")
            if cd and od and od < cd and not b.get("lt"):
                # 장기(상시) 접수 공고는 개찰·마감이 계약기간식으로 적혀 순서가 뒤집힐 수 있어 제외한다.
                errs.append(f"{tag}: 개찰({b['od']})이 마감({b['cd']})보다 앞")
            if pd and cd and (cd - pd).days > LONG_TERM_DAYS and not b.get("lt"):
                errs.append(f"{tag}: 마감이 1년 넘게 뒤인데 lt(장기 접수) 표시 없음 ({b['pd']} → {b['cd']})")
            if pd and cd and (cd - pd).days <= LONG_TERM_DAYS and b.get("lt"):
                errs.append(f"{tag}: lt 표시가 있지만 장기 접수가 아님")
        except ValueError as exc:
            errs.append(f"{tag}: 날짜 해석 실패 {exc}")
        if b.get("cu") and not str(b["cu"]).startswith("https://www.g2b.go.kr"):
            errs.append(f"{tag}: 원문 주소가 나라장터가 아님 {b['cu']!r}")
        # CGI 취급 품목 매칭 필드(이슈 #188 7차)
        if not isinstance(b.get("cgi_match"), bool):
            errs.append(f"{tag}: cgi_match 불리언 아님 {b.get('cgi_match')!r}")
        mk = b.get("mk")
        if not isinstance(mk, list) or not all(isinstance(x, str) for x in mk):
            errs.append(f"{tag}: mk 문자열 목록 아님 {mk!r}")
        elif b.get("cgi_match") is True and not mk:
            errs.append(f"{tag}: CGI 매칭인데 적중 키워드가 비어 있음")
        elif b.get("cgi_match") is False and mk:
            errs.append(f"{tag}: CGI 매칭 아닌데 적중 키워드가 있음 {mk!r}")
    return errs


def validate_results(data) -> list[str]:
    if data is None:
        return []  # 자리표시자(null) — 낙찰 데이터 수집 전
    errs: list[str] = []
    if not isinstance(data, dict) or not isinstance(data.get("results"), list):
        return ["result-data.js: results 목록이 아님"]
    for i, r in enumerate(data["results"]):
        tag = f"[{i}] {r.get('no')}"
        if not r.get("no"):
            errs.append(f"{tag}: 공고번호 없음")
        for k in ("base_amount", "success_rate", "low_rate", "bid_amount", "bidder_count"):
            if r.get(k) is not None and not isinstance(r.get(k), (int, float)):
                errs.append(f"{tag}: {k} 숫자 아님 {r.get(k)!r}")
        if r.get("success_rate") is not None and not (0 < float(r["success_rate"]) <= 120):
            errs.append(f"{tag}: 사정률/낙찰률 범위 밖 {r['success_rate']!r}")
    return errs


def main() -> int:
    errs = validate_bids(load_js(BID_DATA))
    if RESULT_DATA.exists():
        errs += validate_results(load_js(RESULT_DATA))
    if errs:
        print(f"bid 데이터 검증 실패 {len(errs)}건")
        for e in errs[:50]:
            print("  - " + e)
        return 1
    print("bid 데이터 검증 통과")
    return 0


if __name__ == "__main__":
    sys.exit(main())
