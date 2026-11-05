#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""나라장터 입찰공고·낙찰정보 오픈데이터 수집기 (공공데이터포털, 조달청).

키 운용 규칙:
  - 키는 환경변수 G2B_OPENAPI_KEY 에서만 읽는다. 코드·로그·커밋에 키 값을 남기지 않는다.
  - 키가 없으면 안내만 출력하고 종료(0). 기존 bid-data.js 는 건드리지 않는다(유지).

사용:
  python tools/procurement/g2b_openapi_collector.py --days 7                   # 최근 7일 공고 수집
  python tools/procurement/g2b_openapi_collector.py --days 7 --write-bid-data  # bid-data.js 재생성(기준일 = 오늘)
  python tools/procurement/g2b_openapi_collector.py --days 7 --enrich          # 기초금액·참가가능지역 보강까지
  python tools/procurement/g2b_openapi_collector.py --days 7 --results --write-result-data
      # 낙찰정보(낙찰된 목록) 수집 + bid/assets/data/result-data.js 재생성
  python tools/procurement/g2b_openapi_collector.py --dry-run --days 7         # 요청 URL 미리보기(키 마스크)

3차(2026-11-05) 정정 사항 — 두 공개 클라이언트 구현과 카탈로그로 교차 확인한 이름이다:
  - 공사 operation 은 `...Cnstwk` 다(`...Constr` 는 존재하지 않는다). 외자(`...Frgcpt`)를 추가했다.
  - 낙찰은 `getScsbidListSttus{Thng,Cnstwk,Servc,Frgcpt}`(낙찰된 목록),
    개찰 결과는 `getOpengResultListInfo{...}` 다(`getResulBidListInfo*` 는 존재하지 않는다).
  - 기초금액은 목록 응답에 없고 `getBidPblancListInfo{Thng,Cnstwk,Servc}BsisAmount` 로 따로 받는다.
    참가가능지역은 `getBidPblancListInfoPrtcptPsblRgn` 이다(--enrich).
  - 서비스 경로는 구 명칭(`BidPublicInfoService04`)이 아니라 현행 `ad/BidPublicInfoService` 를
    기본값으로 두되, 환경변수 G2B_OPENAPI_BASE 로 바꿀 수 있다. 키 발급 뒤 실응답으로 확정한다.
  - 업무구분당 100건×10페이지 상한이 하루 공고량보다 작을 수 있어 조회 기간을 --chunk-days 단위로
    잘라 요청한다(기본 1일).
  - 응답 필드명은 서비스마다 조금씩 달라 후보 목록으로 받는다. 실응답으로 확정하면 후보를 줄인다.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_bid_data import cgi_match_fields, load_keywords  # noqa: E402  # CGI 취급 품목 매칭(7차) 재사용

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / "reports" / "data" / "procurement"
BID_DATA_PATH = REPO_ROOT / "bid" / "assets" / "data" / "bid-data.js"
RESULT_DATA_PATH = REPO_ROOT / "bid" / "assets" / "data" / "result-data.js"

# 입찰공고정보서비스(현행 경로). 구 명칭 BidPublicInfoService04 는 쓰지 않는다.
BASE_URL = os.environ.get("G2B_OPENAPI_BASE") or "https://apis.data.go.kr/1230000/ad/BidPublicInfoService"
# 낙찰정보서비스(카탈로그 15129397, endPoint 확인 2026-11-05)
RESULT_BASE_URL = os.environ.get("G2B_OPENAPI_RESULT_BASE") or "https://apis.data.go.kr/1230000/as/ScsbidInfoService"

# 업무구분별 공고 목록 operation(확인됨).
OPERATIONS = {
    "물품": "getBidPblancListInfoThng",
    "공사": "getBidPblancListInfoCnstwk",
    "용역": "getBidPblancListInfoServc",
    "외자": "getBidPblancListInfoFrgcpt",
}
# 기초금액 조회 operation(외자는 제공되지 않는다).
BASE_AMOUNT_OPERATIONS = {
    "물품": "getBidPblancListInfoThngBsisAmount",
    "공사": "getBidPblancListInfoCnstwkBsisAmount",
    "용역": "getBidPblancListInfoServcBsisAmount",
}
# 참가가능지역 조회 operation(업무구분 공통).
REGION_OPERATION = "getBidPblancListInfoPrtcptPsblRgn"

# UI 분류(구매/공사/용역/매각)로의 표기 매핑 — 원본 업무구분을 우선 사용한다.
TASK_DIV_MAP = {
    "물품": "구매",
    "외자": "구매",
    "기타": "구매",
    "공사": "공사",
    "용역": "용역",
    "매각": "매각",
}

# ── 낙찰정보 ──────────────────────────────────────────────────────
# 낙찰된 목록 현황(낙찰업체·낙찰금액·낙찰률)이 1순위, 개찰결과 목록은 참가업체 수 보강용이다.
RESULT_OPERATIONS = {
    "물품": "getScsbidListSttusThng",
    "공사": "getScsbidListSttusCnstwk",
    "용역": "getScsbidListSttusServc",
    "외자": "getScsbidListSttusFrgcpt",
}
OPENING_OPERATIONS = {
    "물품": "getOpengResultListInfoThng",
    "공사": "getOpengResultListInfoCnstwk",
    "용역": "getOpengResultListInfoServc",
    "외자": "getOpengResultListInfoFrgcpt",
}
# 응답 필드 후보(서비스마다 명칭이 다르므로 여러 키를 허용). 키 발급 후 실응답 키로 확정한다.
RESULT_FIELD_CANDIDATES = {
    "bid_no": ("bidNtceNo", "ntceNo"),
    "ord": ("bidNtceOrd", "ntceOrd"),
    "t": ("bidNtceNm", "ntceNm"),
    "a": ("dminsttNm", "ntceInsttNm"),
    "base_amount": ("bssamt", "bsisAmt", "baseAmt", "prtcPrceBaseAmt"),
    "success_rate": ("sucsfbidRate", "fnlSucsfRt", "sucessbidRate", "bidPrcnt"),
    "low_rate": ("sucsfbidLwltRate", "lwltRate", "sucsfLwstbidPrcntRate"),
    "bid_amount": ("sucsfbidAmt", "fnlSucsfAmt", "scsbidAmt", "sucsBidAmt"),
    "bidder_count": ("prtcptCnum", "bidprcCnt", "bidtprCnt", "prsrBsnmCnt"),
    "winner": ("bidwinnrNm", "fnlSucsfCorpNm", "sucsfbidCorNm", "bizNm", "prsrBsnm"),
    "open_at": ("rlOpengDt", "opengDt", "bidOpenDt"),
}
BASE_AMOUNT_FIELD_CANDIDATES = {
    "base_amount": ("bssamt", "bsisAmt", "baseAmt"),
    "base_amount_open_at": ("bssamtOpenDt", "bsisAmtOpenDt"),
    "price_range_bgn": ("rsrvtnPrceRngBgnRate", "rsrvtnPrceRngBgnRt"),
    "price_range_end": ("rsrvtnPrceRngEndRate", "rsrvtnPrceRngEndRt"),
}
REGION_FIELD_CANDIDATES = ("prtcptPsblRgnNm", "prtcptPsblRgn", "rgnNm")

PAGE_ROWS = 100
MAX_PAGES = 10  # 요청 구간(chunk)·업무구분당 최대 1,000건 — 넘으면 경고하고 구간을 더 잘라야 한다
NODATA_CODES = ("03",)  # 공공데이터포털 NODATA_ERROR — 오류가 아니라 빈 결과로 본다


def guidance() -> None:
    print("G2B_OPENAPI_KEY 환경변수가 없어 수집기를 실행하지 않았습니다. 기존 데이터는 그대로 유지됩니다.")
    print("")
    print("키 발급: 공공데이터포털(data.go.kr)에서 무료 활용신청 후 ServiceKey 를 환경변수로 지정하십시오.")
    print("  · 입찰공고: '조달청_나라장터 입찰공고정보서비스'  https://www.data.go.kr/data/15129394/openapi.do")
    print("  · 낙찰정보: '조달청_나라장터 낙찰정보서비스'    https://www.data.go.kr/data/15129397/openapi.do (--results)")
    print("  · 발급 화면의 '일반 인증키(Encoding)'·'(Decoding)' 둘 중 어느 것을 넣어도 된다(인코딩 여부를 자동 판별).")
    print("")
    print("  PowerShell :  $env:G2B_OPENAPI_KEY = \"발급받은 키\"")
    print("  bash       :  export G2B_OPENAPI_KEY=\"발급받은 키\"")
    print("")
    print("실행 예시:")
    print("  python tools/procurement/g2b_openapi_collector.py --days 7 --write-bid-data")
    print("  python tools/procurement/g2b_openapi_collector.py --dry-run --days 7")


# ── 요청 구성 ─────────────────────────────────────────────────────
def encode_key(key: str) -> str:
    """공공데이터포털 키는 Encoding 키(이미 %xx)와 Decoding 키(원문) 두 가지로 발급된다.
    %xx 가 보이면 그대로 쓰고, 아니면 한 번만 URL 인코딩한다(이중 인코딩 방지)."""
    if re.search(r"%[0-9A-Fa-f]{2}", key):
        return key
    return urllib.parse.quote(key, safe="")


def _query(key: str, bgn: str, end: str, page: int, extra: dict | None = None) -> str:
    params = {
        "inqryDiv": "1",  # 1: 공고일시 기준
        "inqryBgnDt": bgn + "0000",
        "inqryEndDt": end + "2359",
        "numOfRows": str(PAGE_ROWS),
        "pageNo": str(page),
        "type": "json",
    }
    if extra:
        params.update(extra)
    return "serviceKey=" + encode_key(key) + "&" + urllib.parse.urlencode(params)


def build_url(op: str, key: str, bgn: str, end: str, page: int, base: str = BASE_URL) -> str:
    return f"{base}/{op}?{_query(key, bgn, end, page)}"


def build_result_url(opname: str, key: str, bgn: str, end: str, page: int) -> str:
    return build_url(opname, key, bgn, end, page, base=RESULT_BASE_URL)


def mask_url(url: str) -> str:
    return re.sub(r"serviceKey=[^&]*", "serviceKey=***", url)


def date_chunks(bgn: str, end: str, chunk_days: int) -> list[tuple[str, str]]:
    """YYYYMMDD 구간을 chunk_days 일 단위로 자른다(양끝 포함)."""
    b = datetime.strptime(bgn, "%Y%m%d").date()
    e = datetime.strptime(end, "%Y%m%d").date()
    if chunk_days < 1:
        chunk_days = 1
    out = []
    cur = b
    while cur <= e:
        nxt = min(cur + timedelta(days=chunk_days - 1), e)
        out.append((cur.strftime("%Y%m%d"), nxt.strftime("%Y%m%d")))
        cur = nxt + timedelta(days=1)
    return out


# ── 응답 처리 ─────────────────────────────────────────────────────
def parse_body(data: dict) -> tuple[list[dict], int, str | None]:
    """(items, totalCount, error) — 공공데이터포털 공통 봉투를 푼다.
    items 는 [..] 또는 {"item": [..]} 또는 단일 객체로 올 수 있다."""
    resp = data.get("response") or {}
    header = resp.get("header") or {}
    code = str(header.get("resultCode") or "00")
    if code in NODATA_CODES:
        return [], 0, None
    if code not in ("00", "0"):
        return [], 0, f"API {code} {header.get('resultMsg')}"
    body = resp.get("body") or {}
    items = body.get("items")
    if isinstance(items, dict) and "item" in items:
        items = items.get("item")  # {"items": {"item": [...]}} 형태
    if not items:
        items = []
    if isinstance(items, dict):
        items = [items]  # 단일 객체
    total = int(body.get("totalCount") or 0)
    return [it for it in items if isinstance(it, dict)], total, None


def fetch_pages(url_builder, label: str, timeout: int = 30):
    """url_builder(page) 로 모든 페이지를 읽어 (rows, errors) 반환."""
    rows: list[dict] = []
    errors: list[str] = []
    for page in range(1, MAX_PAGES + 1):
        url = url_builder(page)
        try:
            with urllib.request.urlopen(url, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001 — 네트워크·형식 오류를 모두 기록하고 멈춘다
            errors.append(f"{label} p{page}: {type(exc).__name__}: {exc}")
            break
        items, total, err = parse_body(data)
        if err:
            errors.append(f"{label} p{page}: {err}")
            break
        rows.extend(items)
        if page * PAGE_ROWS >= total or not items:
            break
        if page == MAX_PAGES and total > PAGE_ROWS * MAX_PAGES:
            errors.append(f"{label}: 총 {total}건 중 {PAGE_ROWS * MAX_PAGES}건까지만 수집 — --chunk-days 를 줄이십시오")
    return rows, errors


def fetch_op(op: str, key: str, bgn: str, end: str, timeout: int = 30, chunk_days: int = 1):
    """한 operation 을 구간별로 읽어 (rows, errors) 반환."""
    rows: list[dict] = []
    errors: list[str] = []
    for cb, ce in date_chunks(bgn, end, chunk_days):
        r, e = fetch_pages(lambda page: build_url(op, key, cb, ce, page), f"{op} {cb}~{ce}", timeout)
        rows.extend(r)
        errors.extend(e)
    return rows, errors


def fetch_result_op(opname: str, key: str, bgn: str, end: str, timeout: int = 30, chunk_days: int = 1):
    rows: list[dict] = []
    errors: list[str] = []
    for cb, ce in date_chunks(bgn, end, chunk_days):
        r, e = fetch_pages(lambda page: build_result_url(opname, key, cb, ce, page), f"낙찰 {opname} {cb}~{ce}", timeout)
        rows.extend(r)
        errors.extend(e)
    return rows, errors


def first(it: dict, *keys: str):
    for k in keys:
        v = it.get(k)
        if v not in (None, "", "-"):
            return v
    return None


def _num(v):
    if v in (None, "", "-"):
        return None
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None


def _int(v):
    f = _num(v)
    return int(f) if f is not None else None


def normalize(it: dict, task_div: str | None = None) -> dict | None:
    """목록 응답 1건 → 화면 레코드. task_div 는 호출한 operation 의 업무구분(응답에 없을 때의 근거)."""
    bid_no = first(it, "bidNtceNo")
    if not bid_no:
        return None
    ord_part = str(first(it, "bidNtceOrd") or "000").zfill(3)
    raw_div = str(first(it, "bizDivNm", "bsnsDivNm") or task_div or "").strip()
    cat = TASK_DIV_MAP.get(raw_div)  # 매핑에 없으면 None — 호출자가 분류 보정
    return {
        "no": str(bid_no),
        "ord": ord_part,
        "t": first(it, "bidNtceNm") or "",
        "a": first(it, "dminsttNm", "ntceInsttNm") or "",
        "c": cat,
        "task_div": raw_div or None,
        # 경쟁방식(일반경쟁·제한경쟁·지명경쟁·수의계약)은 계약체결방법명 칸에 온다.
        "k": first(it, "cntrctCnclsMthdNm", "bidMethdNm") or "-",
        "s": first(it, "ntceKindNm", "bidSttusNm") or "등록공고",
        "r": None,  # 참가가능지역은 --enrich 로 보강한다
        "ep": _int(first(it, "presmptPrce")),
        "ab": _int(first(it, "asignBdgtAmt")),
        "pd": first(it, "bidNtceDt"),
        "cd": first(it, "bidClseDt"),
        "od": first(it, "opengDt"),
        "cm": first(it, "cntrctMthdNm", "cntrctCnclsSttusNm"),  # 총액·단가 등(실응답으로 확정)
        "am": first(it, "sucsfbidMthdNm", "awardMthdNm"),
        "cu": first(it, "bidNtceDtlUrl") or f"https://www.g2b.go.kr#PNPE027_01?bidPbancNo={bid_no}&bidPbancOrd={ord_part}",
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


def latest_ord_only(rows: list[dict]) -> list[dict]:
    """같은 공고번호는 가장 큰 차수(변경·재공고)만 화면에 낸다."""
    best: dict[str, dict] = {}
    for r in rows:
        cur = best.get(r["no"])
        if cur is None or r["ord"] > cur["ord"]:
            best[r["no"]] = r
    return list(best.values())


# ── 보강(기초금액·참가가능지역) ──────────────────────────────────────
def normalize_base_amount(it: dict) -> dict | None:
    no = first(it, "bidNtceNo")
    if not no:
        return None
    rec = {"no": str(no), "ord": str(first(it, "bidNtceOrd") or "000").zfill(3)}
    rec["base_amount"] = _int(first(it, *BASE_AMOUNT_FIELD_CANDIDATES["base_amount"]))
    rec["base_amount_open_at"] = first(it, *BASE_AMOUNT_FIELD_CANDIDATES["base_amount_open_at"])
    rec["price_range_bgn"] = _num(first(it, *BASE_AMOUNT_FIELD_CANDIDATES["price_range_bgn"]))
    rec["price_range_end"] = _num(first(it, *BASE_AMOUNT_FIELD_CANDIDATES["price_range_end"]))
    return rec


def normalize_region(it: dict) -> dict | None:
    no = first(it, "bidNtceNo")
    if not no:
        return None
    return {"no": str(no), "ord": str(first(it, "bidNtceOrd") or "000").zfill(3),
            "region": first(it, *REGION_FIELD_CANDIDATES)}


REGION_SHORT = ("전남광주", "서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기", "강원",
                "충북", "충남", "전북", "전남", "경북", "경남", "제주")


def short_region(name: str | None) -> str | None:
    """'전라남도', '경기도 성남시' 같은 참가가능지역명을 시도 약칭으로 줄인다. 복수면 첫 지역."""
    if not name:
        return None
    s = str(name)
    s = s.replace("특별자치도", "").replace("특별자치시", "").replace("광역시", "").replace("특별시", "")
    for short in REGION_SHORT:
        if s.startswith(short):
            return short
    full = {"전남광주통합특별시": "전남광주", "전라남도": "전남", "전라북도": "전북", "경상남도": "경남",
            "경상북도": "경북", "충청남도": "충남", "충청북도": "충북", "강원도": "강원", "경기도": "경기",
            "제주도": "제주"}
    for k, v in full.items():
        if s.startswith(k):
            return v
    return None


def apply_enrichment(bids: list[dict], base_amounts: list[dict], regions: list[dict]) -> dict:
    """공고 레코드에 기초금액(bs)·예가 범위(pr)·지역(r)을 붙인다. 반환: 통계."""
    ba = {(x["no"], x["ord"]): x for x in base_amounts if x}
    rg: dict[tuple[str, str], list[str]] = {}
    for x in regions:
        if x and x.get("region"):
            rg.setdefault((x["no"], x["ord"]), []).append(str(x["region"]))
    stats = {"base_amount": 0, "region": 0}
    for b in bids:
        key = (b["no"], b["ord"])
        if key in ba and ba[key].get("base_amount") is not None:
            b["bs"] = ba[key]["base_amount"]  # 기초금액 — 화면 정책(무료/회원)은 화면이 정한다
            if ba[key].get("price_range_bgn") is not None:
                b["pr"] = [ba[key]["price_range_bgn"], ba[key]["price_range_end"]]
            stats["base_amount"] += 1
        if key in rg:
            b["rn"] = rg[key]  # 참가가능지역 원문 목록
            b["r"] = short_region(rg[key][0])
            if b["r"]:
                stats["region"] += 1
    return stats


# ── 저장 ───────────────────────────────────────────────────────────
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
    if re.match(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$", s):
        return s
    # 202611051800 / 20261105 형태
    m = re.match(r"^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?$", s)
    if m:
        hh, mm = m.group(4) or "18", m.group(5) or "00"
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)} {hh}:{mm}:00"
    return s


def build_payload(bids: list[dict], snapshot: str, source: str) -> dict:
    """화면 레코드 목록 → bid-data.js 본문. 취소공고 제외, 장기 접수(lt) 표시, CGI 매칭(7차)."""
    kw = load_keywords()
    pub = []
    for b in bids:
        if "취소" in (b.get("s") or ""):
            continue
        rec = dict(b)
        rec["pd"] = _norm_date(b.get("pd"))
        rec["cd"] = _norm_dt(b.get("cd"))
        rec["od"] = _norm_dt(b.get("od"))
        for k in ("ep", "ab"):
            rec[k] = _int(rec.get(k))
        if not rec.get("c"):
            rec["c"] = "구매"  # 매핑에 없는 업무구분(기타 등)은 구매로 표기
        rec.update(cgi_match_fields(rec.get("t"), kw))
        try:
            if rec["pd"] and rec["cd"] and (datetime.strptime(rec["cd"][:10], "%Y-%m-%d") - datetime.strptime(rec["pd"], "%Y-%m-%d")).days > 365:
                rec["lt"] = True
        except ValueError:
            pass
        pub.append(rec)
    pub.sort(key=lambda r: (r["cd"] or "", r["no"] or ""))
    counts = {}
    for r in pub:
        counts[r["c"]] = counts.get(r["c"], 0) + 1
    return {
        "snapshot": snapshot,
        "generated": date.today().isoformat(),
        "source": source,
        "counts": {"total": len(bids), "published": len(pub), "byCategory": counts,
                   "basis": {"원본": sum(1 for r in pub if r.get("task_div")), "추정": sum(1 for r in pub if not r.get("task_div"))}},
        "bids": pub,
    }


def write_bid_data(bids: list[dict], snapshot: str) -> Path:
    data = build_payload(bids, snapshot,
                         f"조달청 나라장터 오픈데이터(입찰공고정보서비스) {snapshot} 수집분 · 공공데이터포털")
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
           "open_at": _norm_dt(first(it, *RESULT_FIELD_CANDIDATES["open_at"]))}
    for k in ("base_amount", "success_rate", "low_rate", "bid_amount", "bidder_count"):
        rec[k] = _num(first(it, *RESULT_FIELD_CANDIDATES[k]))
    rec["winner"] = first(it, *RESULT_FIELD_CANDIDATES["winner"])
    return rec


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


def write_result_data(results: list[dict], snapshot: str) -> Path:
    """result-data.js 재생성 — results.html·분석 카드가 읽는 형식(ANALYSIS_DESIGN.md §4).
    파일이 null 이거나 값이 없는 필드는 두 화면이 '개찰 후 반영'을 유지한다."""
    results.sort(key=lambda r: (r.get("open_at") or "", r["no"] or ""))
    data = {
        "snapshot": snapshot,
        "generated": date.today().isoformat(),
        "source": "조달청 나라장터 낙찰정보서비스(오픈데이터) " + snapshot + " 수집분 · bid/ANALYSIS_DESIGN.md §4",
        "results": results,
    }
    RESULT_DATA_PATH.write_text(
        "/* 나라장터 낙찰결과 데이터 — 생성: tools/procurement/g2b_openapi_collector.py (수정 금지) */\n"
        "window.CGI_RESULT_DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    return RESULT_DATA_PATH


# ── 실행 ───────────────────────────────────────────────────────────
def _ops(args, table: dict) -> list[tuple[str, str]]:
    return [(lbl, table[lbl]) for lbl in (o.strip() for o in args.ops.split(",")) if lbl in table]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--days", type=int, default=7, help="공고일 기준 최근 N일")
    ap.add_argument("--chunk-days", type=int, default=1, help="요청 구간 길이(일). 구간당 최대 1,000건")
    ap.add_argument("--ops", default="물품,공사,용역,외자", help="수집할 업무구분 목록")
    ap.add_argument("--enrich", action="store_true", help="기초금액·참가가능지역 보강 호출")
    ap.add_argument("--write-bid-data", action="store_true", help="bid-data.js 재생성")
    ap.add_argument("--results", action="store_true", help="낙찰정보(낙찰된 목록) 수집")
    ap.add_argument("--write-result-data", action="store_true", help="result-data.js 재생성")
    ap.add_argument("--dry-run", action="store_true", help="요청 URL 미리보기(키 마스크)만 수행")
    args = ap.parse_args()

    today = date.today()
    bgn = (today - timedelta(days=args.days)).strftime("%Y%m%d")
    end = today.strftime("%Y%m%d")
    ops = _ops(args, OPERATIONS)
    unknown = [o.strip() for o in args.ops.split(",") if o.strip() not in OPERATIONS]
    if unknown:
        print(f"알 수 없는 업무구분 무시: {', '.join(unknown)} (지원: {', '.join(OPERATIONS)})")

    if args.dry_run:
        chunks = date_chunks(bgn, end, args.chunk_days)
        cb, ce = chunks[0]
        print(f"[dry-run] 입찰공고 — 구간 {len(chunks)}개({args.chunk_days}일씩), 첫 구간 URL(실제 전송 없음, 키 마스크):")
        for _lbl, opname in ops:
            print("  " + mask_url(build_url(opname, "MASKED", cb, ce, 1)))
        if args.enrich:
            print("[dry-run] 보강 — 기초금액·참가가능지역:")
            for lbl, opname in _ops(args, BASE_AMOUNT_OPERATIONS):
                print("  " + mask_url(build_url(opname, "MASKED", cb, ce, 1)))
            print("  " + mask_url(build_url(REGION_OPERATION, "MASKED", cb, ce, 1)))
        if args.results:
            print("[dry-run] 낙찰정보(낙찰된 목록):")
            for _lbl, opname in _ops(args, RESULT_OPERATIONS):
                print("  " + mask_url(build_result_url(opname, "MASKED", cb, ce, 1)))
        print(f"[dry-run] 페이지당 {PAGE_ROWS}건, 구간·업무구분당 최대 {MAX_PAGES}페이지까지 순회.")
        return 0

    key = os.environ.get("G2B_OPENAPI_KEY")
    if not key:
        guidance()
        return 0

    all_rows: list[dict] = []
    all_errors: list[str] = []
    for lbl, opname in ops:
        rows, errors = fetch_op(opname, key, bgn, end, chunk_days=args.chunk_days)
        print(f"[{lbl}] {len(rows)}건 수집")
        all_rows.extend({**it, "_task_div": lbl} for it in rows)
        all_errors.extend(errors)

    bids = [r for r in (normalize(it, it.get("_task_div")) for it in all_rows) if r]
    bids = latest_ord_only(dedupe(bids))

    if args.enrich:
        base_amounts: list[dict] = []
        for lbl, opname in _ops(args, BASE_AMOUNT_OPERATIONS):
            rows, errors = fetch_op(opname, key, bgn, end, chunk_days=args.chunk_days)
            base_amounts.extend(r for r in (normalize_base_amount(it) for it in rows) if r)
            all_errors.extend(errors)
        rows, errors = fetch_op(REGION_OPERATION, key, bgn, end, chunk_days=args.chunk_days)
        regions = [r for r in (normalize_region(it) for it in rows) if r]
        all_errors.extend(errors)
        stats = apply_enrichment(bids, base_amounts, regions)
        print(f"[보강] 기초금액 {stats['base_amount']}건, 지역 {stats['region']}건")

    results = None
    if args.results:
        results = []
        for lbl, opname in _ops(args, RESULT_OPERATIONS):
            rows, errors = fetch_result_op(opname, key, bgn, end, chunk_days=args.chunk_days)
            print(f"[낙찰정보:{lbl}] {len(rows)}건 수집")
            results.extend(rows)
            all_errors.extend(errors)
        results = dedupe_result([r for r in (normalize_result(it) for it in results) if r])
        OUT_DIR.mkdir(parents=True, exist_ok=True)
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
        print(f"참고: 업무구분 매핑에 없는 원본 값이 {missing_div}건 — 구매로 표기되며 분류 규칙을 보정하십시오.")

    if args.write_bid_data:
        if not bids:
            print("수집 결과가 0건이라 bid-data.js 를 바꾸지 않았습니다(기존 데이터 유지).")
        else:
            path = write_bid_data(bids, today.isoformat())
            print(f"bid-data.js 재생성: {path} ({len(bids)}건, 기준일 {today.isoformat()})")

    if args.write_result_data:
        if results is None:
            print("참고: --results 없이는 낙찰 데이터를 수집하지 않아 result-data.js를 건드리지 않는다.")
        elif not results:
            print("낙찰 수집 결과가 0건이라 result-data.js 를 바꾸지 않았습니다.")
        else:
            path = write_result_data(results, today.isoformat())
            filled = sum(1 for r in results if r.get("bid_amount"))
            print(f"result-data.js 재생성: {path} ({len(results)}건, 낙찰금액 있음 {filled}건, 기준일 {today.isoformat()})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
