#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""나라장터 입찰공고 오픈데이터 수집기 (공공데이터포털 "조달청_나라장터 입찰공고정보서비스").

키 운용 규칙:
  - 키는 환경변수 G2B_OPENAPI_KEY 에서만 읽는다. 코드·로그·커밋에 키 값을 남기지 않는다.
  - 키가 없으면 안내만 출력하고 종료(0). 기존 bid-data.js 는 건드리지 않는다(유지).

사용:
  python tools/procurement/g2b_openapi_collector.py --days 7            # 최근 7일 공고 수집
  python tools/procurement/g2b_openapi_collector.py --days 7 --write-bid-data
      # bid/assets/data/bid-data.js 까지 재생성(기준일 = 오늘)
  python tools/procurement/g2b_openapi_collector.py --days 7 --results --write-result-data
      # 낙찰정보(개찰결과) 수집 + bid/assets/data/result-data.js 재생성
      # results.html · 분석 카드(ANALYSIS_DESIGN.md §4)가 읽는 형식
  python tools/procurement/g2b_openapi_collector.py --dry-run --days 7  # 요청 URL 미리보기(키 마스크)

주의:
  - operation 명은 공공데이터포털 활용가이드 기준이며, 키 발급 후 실응답으로 검증한다.
    물품/공사/용역 각각 별도 operation을 호출하고(--ops 로 선택), 일부가 실패해도
    나머지는 수집을 진행한다.
  - 업무구분은 응답의 bizDivNm(원본)을 분류에 우선 사용한다(물품→구매 표기).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / "reports" / "data" / "procurement"
BID_DATA_PATH = REPO_ROOT / "bid" / "assets" / "data" / "bid-data.js"

BASE_URL = "https://apis.data.go.kr/1230000/BidPublicInfoService04"
# 업무구분별 공고 목록 operation. 키 발급 후 실응답에서 검증·보정한다.
OPERATIONS = {
    "물품": "getBidPblancListInfoThng",
    "공사": "getBidPblancListInfoConstr",
    "용역": "getBidPblancListInfoServc",
}
# UI 분류(구매/공사/용역/매각)로의 표기 매핑 — 원본 업무구분을 우선 사용한다.
TASK_DIV_MAP = {
    "물품": "구매",
    "외자": "구매",
    "기타": "구매",
    "공사": "공사",
    "용역": "용역",
    "매각": "매각",
}

# ── 낙찰정보(개찰결과) ────────────────────────────────────────────
# 카탈로그: https://www.data.go.kr/data/15129397/openapi.do (endPoint 확인 2026-11-05)
RESULT_BASE_URL = "https://apis.data.go.kr/1230000/as/ScsbidInfoService"
# 개찰결과 물품/공사/용역 목록 조회 후보 operation. 카탈로그에는 한국어 상세기능만 표시되어
# 영문명은 개별 기능 가이드에서 확정해야 한다(키 발급 후 실응답으로 보정).
RESULT_OPERATIONS = {
    "물품": "getResulBidListInfoThng",
    "공사": "getResulBidListInfoConstr",
    "용역": "getResulBidListInfoServc",
}
# 응답 필드 후보(서비스마다 명칭이 다르므로 여러 키를 허용한다). 키 발급 후 실응답 키로 확정.
RESULT_FIELD_CANDIDATES = {
    "bid_no": ("bidNtceNo", "ntceNo"),
    "ord": ("bidNtceOrd", "ntceOrd"),
    "t": ("bidNtceNm", "ntceNm"),
    "a": ("dminsttNm", "ntceInsttNm"),
    "base_amount": ("bidwrntAmtOpen", "prtcPrceBaseAmt", "bsisAmt", "baseAmt"),
    "success_rate": ("sucsfbidRate", "sucessbidRate", "bidPrcnt"),
    "low_rate": ("sucsfbidLwltRate", "lwltRate"),
    "bid_amount": ("scsbidAmt", "sucsfbidAmt", "sucsBidAmt"),
    "bidder_count": ("bidprcCnt", "bidtprCnt", "prsrBsnmCnt"),
    "winner": ("sucsfbidCorNm", "bizNm", "prsrBsnm"),
    "open_at": ("opengDt", "bidOpenDt"),
}

PAGE_ROWS = 100
MAX_PAGES = 10  # 업무구분당 최대 1,000건


def guidance() -> None:
    print("G2B_OPENAPI_KEY 환경변수가 없어 수집기를 실행하지 않았습니다. 기존 데이터는 그대로 유지됩니다.")
    print("")
    print("키 발급: 공공데이터포털(data.go.kr)에서 무료 활용신청 후 ServiceKey 를 환경변수로 지정하십시오.")
    print("  · 입찰공고: '조달청_나라장터 입찰공고정보서비스'  https://www.data.go.kr/data/15129394/openapi.do")
    print("  · 낙찰정보: '조달청 나라장터 낙찰정보서비스'    https://www.data.go.kr/data/15129397/openapi.do (--results)")
    print("")
    print("  PowerShell :  $env:G2B_OPENAPI_KEY = \"발급받은 키\"")
    print("  bash       :  export G2B_OPENAPI_KEY=\"발급받은 키\"")
    print("")
    print("실행 예시:")
    print("  python tools/procurement/g2b_openapi_collector.py --days 7 --write-bid-data")
    print("  python tools/procurement/g2b_openapi_collector.py --dry-run --days 7")


def build_url(op: str, key: str, bgn: str, end: str, page: int) -> str:
    q = urllib.parse.urlencode({
        "serviceKey": key,
        "inqryDiv": "1",  # 1: 공고일시 기준
        "inqryBgnDt": bgn + "0000",
        "inqryEndDt": end + "2359",
        "numOfRows": str(PAGE_ROWS),
        "pageNo": str(page),
        "type": "json",
    })
    return f"{BASE_URL}/{op}?{q}"


def fetch_op(op: str, key: str, bgn: str, end: str, timeout: int = 30):
    """한 operation의 모든 페이지를 읽어 (rows, errors) 반환."""
    rows: list[dict] = []
    errors: list[str] = []
    for page in range(1, MAX_PAGES + 1):
        url = build_url(op, key, bgn, end, page)
        try:
            with urllib.request.urlopen(url, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception as exc:
            errors.append(f"{op} p{page}: {type(exc).__name__}: {exc}")
            break
        header = (data.get("response") or {}).get("header") or {}
        if header.get("resultCode") not in ("00", "0", None):
            errors.append(f"{op} p{page}: API {header.get('resultCode')} {header.get('resultMsg')}")
            break
        body = (data.get("response") or {}).get("body") or {}
        items = body.get("items") or []
        if isinstance(items, dict):
            items = [items]
        rows.extend(it for it in items if isinstance(it, dict))
        total = int(body.get("totalCount") or 0)
        if page * PAGE_ROWS >= total or not items:
            break
    return rows, errors


def first(it: dict, *keys: str):
    for k in keys:
        v = it.get(k)
        if v not in (None, "", "-"):
            return v
    return None


def normalize(it: dict) -> dict | None:
    bid_no = first(it, "bidNtceNo")
    if not bid_no:
        return None
    ord_part = first(it, "bidNtceOrd") or "000"
    raw_div = first(it, "bizDivNm", "ntceKindNm") or ""
    div = str(raw_div).strip()
    cat = TASK_DIV_MAP.get(div)  # 원본 업무구분 우선 — 매핑에 없으면 표기 근거 '원본미지원'
    return {
        "no": str(bid_no),
        "ord": str(ord_part).zfill(3),
        "t": first(it, "bidNtceNm") or "",
        "a": first(it, "dminsttNm", "ntceInsttNm") or "",
        "c": cat,
        "task_div": div or None,
        "k": first(it, "bidMethdNm") or "-",
        "s": first(it, "bidSttusNm") or "등록공고",
        "r": first(it, "bidRgnNm"),
        "ep": first(it, "presmptPrce"),
        "ab": first(it, "asignBdgtAmt"),
        "pd": first(it, "bidNtceDt"),
        "cd": first(it, "bidClseDt"),
        "od": first(it, "opengDt"),
        "cm": first(it, "cntrctCnclsMthdNm"),
        "am": first(it, "awardMthdNm") or None,
        "cu": first(it, "bidNtceDtlUrl") or f"https://www.g2b.go.kr#PNPE027_01?bidPbancNo={bid_no}&bidPbancOrd={str(ord_part).zfill(3)}",
    }


def dedupe(rows: list[dict]) -> list[dict]:
    """공고번호+차수 기준 중복 제거(재공고는 차수가 다른 별건)."""
    seen = set()
    out = []
    for r in rows:
        key = (r["no"], r["ord"])
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def write_bid_data(bids: list[dict], snapshot: str) -> Path:
    """bid-data.js 재생성. 업무구분은 원본(bizDivNm)이 우선이며, 원본이 비면 기존 키워드 추정에 맡긴다
    (이 수집기는 원본이 있는 건만 기록하므로 'basis'는 전부 원본이다)."""
    pub = []
    for b in bids:
        if (b.get("s") or "").find("취소") >= 0:
            continue
        rec = dict(b)
        rec["pd"] = _norm_date(b.get("pd"))
        rec["cd"] = _norm_dt(b.get("cd"))
        rec["od"] = _norm_dt(b.get("od"))
        for k in ("ep", "ab"):
            try:
                rec[k] = int(str(rec[k]).replace(",", "")) if rec[k] not in (None, "") else None
            except (TypeError, ValueError):
                rec[k] = None
        pub.append(rec)
    pub.sort(key=lambda r: (r["cd"] or "", r["no"] or ""))
    counts = {}
    for r in pub:
        counts[r["c"]] = counts.get(r["c"], 0) + 1
    data = {
        "snapshot": snapshot,
        "generated": date.today().isoformat(),
        "source": f"나라장터 오픈데이터 API(BidPublicInfoService04) {snapshot} 수집분 · 조달청_나라장터 입찰공고정보서비스",
        "counts": {"total": len(pub), "published": len(pub), "basis": {"원본": len(pub)}},
        "bids": pub,
    }
    BID_DATA_PATH.write_text(
        "/* 나라장터 입찰공고 데이터 — 생성: tools/procurement/g2b_openapi_collector.py (수정 금지, 재생성으로 갱신) */\n"
        "window.CGI_BID_DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    return BID_DATA_PATH


def normalize_result(it: dict) -> dict | None:
    no = first(it, *RESULT_FIELD_CANDIDATES["bid_no"])
    if not no:
        return None
    rec = {"no": str(no), "ord": str(first(it, *RESULT_FIELD_CANDIDATES["ord"]) or "000").zfill(3),
           "t": first(it, *RESULT_FIELD_CANDIDATES["t"]) or "",
           "a": first(it, *RESULT_FIELD_CANDIDATES["a"]) or "",
           "open_at": first(it, *RESULT_FIELD_CANDIDATES["open_at"])}
    for k in ("base_amount", "success_rate", "low_rate", "bid_amount", "bidder_count"):
        v = first(it, *RESULT_FIELD_CANDIDATES[k])
        if v in (None, "", "-"):
            rec[k] = None
        else:
            try:
                rec[k] = float(str(v).replace(",", ""))
            except (TypeError, ValueError):
                rec[k] = None
    rec["winner"] = first(it, *RESULT_FIELD_CANDIDATES["winner"])
    return rec


def write_result_data(results: list[dict], snapshot: str) -> Path:
    """result-data.js 재생성 — results.html·분석 카드가 읽는 형식(ANALYSIS_DESIGN.md §4).
    파일이 없거나 값이 없는 필드는 두 화면이 '개찰 후 반영'을 유지한다."""
    results.sort(key=lambda r: (r.get("open_at") or "", r["no"] or ""))
    data = {
        "snapshot": snapshot,
        "generated": date.today().isoformat(),
        "source": "조달청 나라장터 낙찰정보서비스(오픈데이터) " + snapshot + " 수집분 · bid/ANALYSIS_DESIGN.md §4",
        "results": results,
    }
    path = REPO_ROOT / "bid" / "assets" / "data" / "result-data.js"
    js = ("/* 나라장터 낙찰결과 데이터 — 생성: tools/procurement/g2b_openapi_collector.py (수정 금지) */\n"
          "window.CGI_RESULT_DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n")
    path.write_text(js, encoding="utf-8")
    return path


def _norm_date(s):
    if not s:
        return None
    m = re.match(r"(\d{4})-?(\d{2})-?(\d{2})", str(s))
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else None


def _norm_dt(s):
    if not s:
        return None
    s = str(s).strip().replace("/", "-")
    s = re.sub(r"\s+", " ", s)
    if re.match(r"\d{4}-\d{2}-\d{2}$", s):
        return s + " 18:00:00"
    if re.match(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}$", s):
        return s + ":00"
    return s


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--days", type=int, default=7, help="공고일 기준 최근 N일")
    ap.add_argument("--ops", default="물품,공사,용역", help="수집할 업무구분 목록")
    ap.add_argument("--write-bid-data", action="store_true", help="bid-data.js 재생성")
    ap.add_argument("--results", action="store_true", help="낙찰정보(개찰결과) 수집")
    ap.add_argument("--write-result-data", action="store_true", help="result-data.js 재생성")
    ap.add_argument("--dry-run", action="store_true", help="요청 URL 미리보기(키 마스크)만 수행")
    args = ap.parse_args()

    today = date.today()
    bgn = (today - timedelta(days=args.days)).strftime("%Y%m%d")
    end = today.strftime("%Y%m%d")
    ops = [(lbl, OPERATIONS[lbl]) for lbl in (o.strip() for o in args.ops.split(",")) if lbl in OPERATIONS]
    unknown = [o.strip() for o in args.ops.split(",") if o.strip() not in OPERATIONS]
    if unknown:
        print(f"알 수 없는 업무구분 무시: {', '.join(unknown)} (지원: {', '.join(OPERATIONS)})")

    if args.dry_run:
        # 요청 구성 검증용. 실제 전송이 없으므로 키 없이도 실행되며 키는 마스크로 표시한다.
        print("[dry-run] 입찰공고 아래 URL로 요청한다(실제 전송 없음, 키 마스크).")
        for _lbl, opname in ops:
            print(build_url(opname, "MASKED", bgn, end, 1).replace("serviceKey=MASKED", "serviceKey=***"))
        if args.results:
            print("[dry-run] 낙찰정보(개찰결과) 아래 URL로 요청한다.")
            for _lbl, opname in result_ops(args):
                print(build_result_url(opname, "MASKED", bgn, end, 1).replace("serviceKey=MASKED", "serviceKey=***"))
        print(f"[dry-run] 페이지당 {PAGE_ROWS}건, 업무구분당 최대 {MAX_PAGES}페이지까지 순회.")
        return 0

    key = os.environ.get("G2B_OPENAPI_KEY")
    if not key:
        guidance()
        return 0

    all_rows: list[dict] = []
    all_errors: list[str] = []
    for lbl, opname in ops:
        rows, errors = fetch_op(opname, key, bgn, end)
        print(f"[{lbl}] {len(rows)}건 수집")
        all_rows.extend(rows)
        all_errors.extend(errors)

    results = None
    if args.results:
        results = []
        for lbl, opname in result_ops(args):
            rows, errors = fetch_result_op(opname, key, bgn, end)
            print(f"[낙찰정보:{lbl}] {len(rows)}건 수집")
            results.extend(rows)
            all_errors.extend(errors)
        results = [r for r in (normalize_result(it) for it in results) if r]
        results = dedupe_result(results)
        out_r = OUT_DIR / f"openapi_results_{end}.json"
        out_r.write_text(json.dumps({
            "meta": {"collected_at": today.isoformat(), "bgn": bgn, "end": end,
                     "count": len(results), "errors": all_errors},
            "results": results,
        }, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"저장: {out_r} ({len(results)}건)")

    if all_errors:
        print("경고:")
        for e in all_errors:
            print("  " + e)

    bids = [r for r in (normalize(it) for it in all_rows) if r]
    bids = dedupe(bids)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / f"openapi_bids_{end}.json"
    out_path.write_text(
        json.dumps({
            "meta": {"collected_at": today.isoformat(), "bgn": bgn, "end": end,
                     "ops": ops, "count": len(bids), "errors": all_errors},
            "bids": bids,
        }, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print(f"저장: {out_path} ({len(bids)}건)")

    missing_div = sum(1 for b in bids if not b["c"])
    if missing_div:
        print(f"참고: 업무구분 매핑에 없는 원본 값이 {missing_div}건 — 해당 건은 표기에서 제외되며 분류 규칙을 보정하십시오.")

    if args.write_bid_data:
        path = write_bid_data(bids, today.isoformat())
        cats = {}
        src = path.read_text(encoding="utf-8")
        import json as _json
        payload = _json.loads(src[src.index("=") + 1:].rstrip().rstrip(";"))
        for r in payload["bids"]:
            cats[r["c"]] = cats.get(r["c"], 0) + 1
        print(f"bid-data.js 재생성: {path} ({len(payload['bids'])}건, 분류 {cats}, 기준일 {payload['snapshot']})")

    if args.write_result_data:
        if results is None:
            print("참고: --results 없이는 낙찰 데이터를 수집하지 않아 result-data.js를 건드리지 않는다.")
        else:
            path = write_result_data(results, today.isoformat())
            filled = sum(1 for r in results if r.get("bid_amount"))
            print(f"result-data.js 재생성: {path} ({len(results)}건, 낙찰금액 있음 {filled}건, 기준일 {today.isoformat()})")
    return 0


def result_ops(args):
    return [(lbl, RESULT_OPERATIONS[lbl]) for lbl in (o.strip() for o in args.ops.split(",")) if lbl in RESULT_OPERATIONS]


def build_result_url(opname: str, key: str, bgn: str, end: str, page: int) -> str:
    q = urllib.parse.urlencode({
        "serviceKey": key,
        "inqryDiv": "1",
        "inqryBgnDt": bgn + "0000",
        "inqryEndDt": end + "2359",
        "numOfRows": str(PAGE_ROWS),
        "pageNo": str(page),
        "type": "json",
    })
    return f"{RESULT_BASE_URL}/{opname}?{q}"


def fetch_result_op(opname: str, key: str, bgn: str, end: str, timeout: int = 30):
    rows: list[dict] = []
    errors: list[str] = []
    for page in range(1, MAX_PAGES + 1):
        url = build_result_url(opname, key, bgn, end, page)
        try:
            with urllib.request.urlopen(url, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception as exc:
            errors.append(f"낙찰 {opname} p{page}: {type(exc).__name__}: {exc}")
            break
        header = (data.get("response") or {}).get("header") or {}
        if header.get("resultCode") not in ("00", "0", None):
            errors.append(f"낙찰 {opname} p{page}: API {header.get('resultCode')} {header.get('resultMsg')}")
            break
        body = (data.get("response") or {}).get("body") or {}
        items = body.get("items") or []
        if isinstance(items, dict):
            items = [items]
        rows.extend(it for it in items if isinstance(it, dict))
        total = int(body.get("totalCount") or 0)
        if page * PAGE_ROWS >= total or not items:
            break
    return rows, errors


def dedupe_result(rows: list[dict]) -> list[dict]:
    seen = set()
    out = []
    for r in rows:
        key = (r["no"], r["ord"])
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


if __name__ == "__main__":
    sys.exit(main())
