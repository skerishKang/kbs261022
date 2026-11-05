#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""kbs261022 수집 데이터 -> bid/assets/data/bid-data.js 변환 스크립트 (3차, 저장소 반입본).

이슈 #188. 1~2차에서 저장소 밖(`scripts/build_data.py`)에 있던 변환 스크립트를 저장소로
들여와 저장소만으로 데이터를 다시 만들 수 있게 했다. 분류·지역 규칙은 2차 개정과 같다.

분류 우선순위:
  1) 나라장터 원본의 업무구분 필드(task_div/bsnsDivNm 등) — 현재 수집본에는 없음
  2) 물품분류번호(items[].class_no) 존재 -> 물품(구매)
  3) 키워드 추정(유지보수/보수 충돌 수정 포함)

지역 우선순위: 원본 region_names -> region_text -> 기관명·공고명 키워드 추정 -> 미지정(칸 숨김).

3차 추가:
  - 장기(상시) 접수 공고 표시 `lt`: 투찰 마감이 공고일로부터 1년 넘게 뒤인 공고(다수공급자계약 등).
    화면은 D-day 대신 "상시 접수"로 보여 주고 마감 임박 집계에서 뺀다.
  - 마감일이 원본에 없는 공고(`cd` 없음)는 그대로 둔다(화면이 개찰일시를 기준으로 상태를 판단).

7차 추가(이슈 #188):
  - `cgi_match`(bool)·`mk`(적중 키워드 목록): tools/procurement/cgi_bid_keywords.json 기준으로
    공고 제목을 대조해 채운다. 부정 키워드(의료·소방 등)가 제목에 있으면 적중이 있어도 false.
    라틴 키워드(PA·LED·AS·A/S)는 토큰 단위로만 적중한다(부분일치 오검출 방지).

입력(저장소 내 공개 수집 결과만 사용):
  - data/procurement/g2b_real_bids.json                 (나라장터 입찰공고 목록)
  - reports/data/procurement/g2b_detail_enrichment.json (공고 상세 보강)

사용:
  python tools/procurement/build_bid_data.py                      # 기준일은 기본값(수집일)
  python tools/procurement/build_bid_data.py --snapshot 2026-10-23
  python tools/procurement/build_bid_data.py --check              # 파일을 쓰지 않고 현재 파일과 비교만
"""
from __future__ import annotations

import argparse
import html as _html
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SRC_BIDS = REPO / "data" / "procurement" / "g2b_real_bids.json"
SRC_ENR = REPO / "reports" / "data" / "procurement" / "g2b_detail_enrichment.json"
DEST = REPO / "bid" / "assets" / "data" / "bid-data.js"
DEFAULT_SNAPSHOT = "2026-10-23"  # 수집일(기준일). 수집기 재실행 성공 시에만 갱신한다.
LONG_TERM_DAYS = 365

REGIONS = [
    ("서울", "서울"), ("부산", "부산"), ("대구", "대구"), ("인천", "인천"), ("광주", "광주"),
    ("대전", "대전"), ("울산", "울산"), ("세종", "세종"), ("경기", "경기"), ("강원", "강원"),
    ("충북", "충북"), ("충남", "충남"), ("전북", "전북"), ("전남", "전남"), ("경북", "경북"),
    ("경남", "경남"), ("제주", "제주"),
]
# 원본 지역명은 '전라남도', '광주광역시'처럼 긴 이름으로 오므로 약칭으로 먼저 줄인다(3차 수정 —
# 2차 표는 약칭끼리만 비교해 긴 이름을 놓쳤다).
REGION_FULL = {
    "전남광주통합특별시": "전남광주",  # 2026 통합 명칭(원본 지역제한에 등장) — 옛 '전남'·'광주'와 구분해 둔다
    "전라남도": "전남", "전라북도": "전북", "전북특별자치도": "전북", "경상남도": "경남", "경상북도": "경북",
    "충청남도": "충남", "충청북도": "충북", "강원특별자치도": "강원", "강원도": "강원", "경기도": "경기",
    "제주특별자치도": "제주", "제주도": "제주", "서울특별시": "서울", "부산광역시": "부산", "대구광역시": "대구",
    "인천광역시": "인천", "광주광역시": "광주", "대전광역시": "대전", "울산광역시": "울산", "세종특별자치시": "세종",
}


def norm_region_token(v):
    v = str(v or "")
    for full, short in REGION_FULL.items():
        if full in v:
            return short
    for short, full in REGIONS:
        if full in v:
            return short
    return None


def region_from_original(e):
    """원본 지역제한 정보(region_names/region_text)에서 시도를 뽑는다. 복수면 첫 시도."""
    names = e.get("region_names") or []
    for n in names:
        t = norm_region_token(n)
        if t:
            return t
    txt = e.get("region_text") or ""
    m = re.search(r"\[([^\]]+)\]", txt)
    if m:
        t = norm_region_token(m.group(1))
        if t:
            return t
    return None


def guess_region(title, agency):
    hay = (title or "") + " " + (agency or "")
    for short, full in REGIONS:
        if full in hay:
            return short
    return None


RE_SALE = re.compile(r"매각|처분|경매|임대입찰")
RE_MAINT = re.compile(r"유지보수|유지·보수|유지/보수|보수유지|운영위탁|기술지원")  # 공사 '보수'와 충돌하는 유지보수계열
RE_CONS = re.compile(r"공사|건설|시공|철거|정화|신축|증축|포장|조성|준설|방수|토목|건축|복원|확장|보수|개선")
RE_SVC = re.compile(r"용역|임대|판독|조사|연구|설계|감리|컨설팅|운영|평가서|수행능력|진단|교육|리스|정비|유지관리|모니터링|위탁|취급|제작|대행|사업자\s*선정")
RE_CONS_EXPLICIT = re.compile(r"단가공사|공사")

REPO_TOOLS = Path(__file__).resolve().parent
KW_PATH = REPO_TOOLS / "cgi_bid_keywords.json"  # CGI 취급 품목 키워드(이슈 #188 7차)
RE_LATIN_KW = re.compile(r"^[A-Za-z][A-Za-z/]*$")  # PA·LED·AS·A/S 같은 라틴 키워드


def load_keywords(path: Path = KW_PATH) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def keyword_hit(kw: str, title: str) -> bool:
    """키워드 적중. 라틴 키워드는 토큰 단위만(부분일치면 'AS'가 'case'에 걸린다), 한글은 부분일치."""
    if RE_LATIN_KW.match(kw):
        return re.search(r"(?<![A-Za-z])" + re.escape(kw) + r"(?![A-Za-z])", title, re.IGNORECASE) is not None
    return kw in title


def cgi_match_fields(title, keywords: dict | None = None) -> dict:
    """공고 제목을 CGI 취급 키워드와 대조해 cgi_match(bool)·mk(적중 키워드)를 만든다(이슈 #188 7차).

    - 적중 키워드는 JSON 카테고리 나열 순서대로 중복 없이 담는다(화면 칩이 그 순서로 표시된다).
    - 부정 키워드(의료·소방 등)가 제목에 있으면 적중이 있어도 CGI 관련 아님으로 본다(mk는 비운다).
    """
    kw = keywords if keywords is not None else load_keywords()
    t = title or ""
    matched: list[str] = []
    for kws in kw.get("cgi_categories", {}).values():
        for k in kws:
            if k not in matched and keyword_hit(k, t):
                matched.append(k)
    if any(keyword_hit(nk, t) for nk in kw.get("cgi_negative_keywords", [])):
        return {"cgi_match": False, "mk": []}
    return {"cgi_match": bool(matched), "mk": matched}


def classify(title):
    t = title or ""
    if RE_SALE.search(t):
        return "매각", "추정"
    if RE_MAINT.search(t):
        # 유지보수이되 '단가공사' 등 공사 계약임이 명시되고 용역 문구가 없으면 공사로 본다.
        if RE_CONS_EXPLICIT.search(t) and not RE_SVC.search(t):
            return "공사", "추정"
        return "용역", "추정"
    if RE_CONS.search(t):
        return "공사", "추정"
    if RE_SVC.search(t):
        return "용역", "추정"
    return "구매", "추정"


ORIGINAL_TASK_KEYS = ("task_div", "bsnsDivNm", "prdtTypeNm", "bizDivNm", "업무구분")


def classify_bid(b, e):
    """원본 업무구분 우선, 없으면 물품분류번호 근거, 없으면 키워드 추정. (값, 근거) 반환."""
    for k in ORIGINAL_TASK_KEYS:
        v = (b.get(k) if b else None) or (e.get(k) if e else None)
        if v:
            v = str(v).strip()
            if v in ("물품", "공사", "용역", "매각", "외자"):
                return ("구매" if v in ("물품", "외자") else v), "원본"
    if e and e.get("items"):
        return "구매", "품명"
    return classify(b.get("title"))


def to_iso_date(s):
    if not s:
        return None
    s = str(s).strip().replace("/", "-").replace(".", "-")
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else None


def clean_dt(s):
    if not s:
        return None
    s = str(s).strip().replace("/", "-")
    s = re.sub(r"\s+", " ", s)
    if re.match(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}$", s):
        s += ":00"
    return s


CHANGED_STATUSES = ("변경공고", "재공고", "정정공고")


def pick_dt(src_iso: str | None, enr_dt: str | None, default_time: str, prefer_list: bool) -> str | None:
    """목록(source)의 날짜와 상세 보강(enrichment)의 일시를 합친다.

    - 보강은 원 공고(차수 000)를 읽은 것이라 변경·재공고에서는 날짜가 낡을 수 있다.
      변경·재공고(prefer_list)이고 목록 날짜가 보강 날짜와 다르면 목록 날짜를 쓴다.
    - 날짜가 같으면 시각이 있는 보강 값을 쓴다. 목록만 있으면 기본 시각을 붙인다.
      목록 날짜로 바꿀 때 보강에 시각이 있으면 그 시각을 유지한다(변경공고는 보통 날짜만 미룬다).
    """
    enr_clean = clean_dt(enr_dt)
    enr_iso = enr_clean[:10] if enr_clean else None
    if prefer_list and src_iso and enr_iso and src_iso != enr_iso:
        enr_time = enr_clean[11:19] if len(enr_clean) >= 19 else default_time
        return src_iso + " " + enr_time
    if enr_clean:
        return enr_clean
    return src_iso + " " + default_time if src_iso else None


def _days_between(a_iso: str | None, b_iso: str | None):
    try:
        a = datetime.strptime(str(a_iso)[:10], "%Y-%m-%d")
        b = datetime.strptime(str(b_iso)[:10], "%Y-%m-%d")
    except (TypeError, ValueError):
        return None
    return (b - a).days


def build(snapshot: str) -> dict:
    bids = json.loads(SRC_BIDS.read_text(encoding="utf-8"))["bids"]
    enr = json.loads(SRC_ENR.read_text(encoding="utf-8"))
    enr_by_no = {e["bid_no"]: e for e in enr if e.get("fetch_status") == "ok"}
    kw = load_keywords()

    out = []
    skipped_cancel = 0
    basis_counter = {"원본": 0, "품명": 0, "추정": 0}
    long_term = 0
    for b in bids:
        if b.get("status") == "취소공고":
            skipped_cancel += 1
            continue
        e = enr_by_no.get(b.get("bid_no"), {})
        cat, basis = classify_bid(b, e)
        basis_counter[basis] += 1
        region = region_from_original(e) or guess_region(b.get("title"), e.get("notice_agency") or b.get("agency"))
        ep = e.get("estimated_price")
        ab = e.get("allocated_budget")
        agency = _html.unescape(e.get("notice_agency") or b.get("agency") or "")
        close_iso = to_iso_date(b.get("close_date"))
        open_iso = to_iso_date(b.get("open_date"))
        status = b.get("status") or "등록공고"
        prefer_list = status in CHANGED_STATUSES
        rec = {
            "no": b.get("bid_no"),
            "t": _html.unescape(b.get("title") or ""),
            "a": agency,
            "c": cat,
            "k": b.get("category") or "-",
            "s": status,
            "r": region,  # None이면 UI에서 지역 칸을 숨긴다
            "ep": int(ep) if isinstance(ep, (int, float)) else None,
            "ab": int(ab) if isinstance(ab, (int, float)) else None,
            "pd": to_iso_date(b.get("post_date") or e.get("posted_at")),
            "cd": pick_dt(close_iso, e.get("bid_close"), "18:00:00", prefer_list),
            "od": pick_dt(open_iso, e.get("open_at"), "09:00:00", prefer_list),
            "cm": e.get("contract_method") or None,
            "am": e.get("award_method") or None,
            "cu": b.get("detail_url") or None,
        }
        rec.update(cgi_match_fields(rec["t"], kw))
        if not rec["a"] or not rec["no"]:
            continue
        gap = _days_between(rec["pd"], rec["cd"])
        if gap is not None and gap > LONG_TERM_DAYS:
            rec["lt"] = True  # 장기(상시) 접수 — 다수공급자계약 등
            long_term += 1
        out.append(rec)

    out.sort(key=lambda r: (r["cd"] or "", r["no"] or ""))
    return {
        "snapshot": snapshot,
        "generated": date.today().isoformat(),
        "source": f"나라장터(www.g2b.go.kr) 입찰공고 {snapshot} 수집분 · kbs261022 data/procurement",
        "counts": {
            "total": len(bids), "published": len(out), "cancelSkipped": skipped_cancel,
            "longTerm": long_term, "basis": basis_counter,
            "cgiMatched": sum(1 for r in out if r["cgi_match"]),
        },
        "bids": out,
    }


def render(data: dict) -> str:
    return (
        "/* 나라장터 입찰공고 데이터 — 생성: tools/procurement/build_bid_data.py (수정 금지, 재생성으로 갱신) */\n"
        "window.CGI_BID_DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n"
    )


def current_payload(path: Path = DEST):
    if not path.exists():
        return None
    src = path.read_text(encoding="utf-8")
    return json.loads(src[src.index("=") + 1:].rstrip().rstrip(";"))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--snapshot", default=DEFAULT_SNAPSHOT, help="데이터 기준일(수집일)")
    ap.add_argument("--check", action="store_true", help="파일을 쓰지 않고 현재 bid-data.js의 공고 목록과 같은지만 확인")
    args = ap.parse_args()

    data = build(args.snapshot)
    cats = {}
    for r in data["bids"]:
        cats[r["c"]] = cats.get(r["c"], 0) + 1

    if args.check:
        cur = current_payload()
        same = cur is not None and cur.get("bids") == data["bids"] and cur.get("snapshot") == data["snapshot"]
        print("bid-data.js 일치" if same else "bid-data.js 불일치 — 재생성 필요")
        return 0 if same else 1

    DEST.parent.mkdir(parents=True, exist_ok=True)
    DEST.write_text(render(data), encoding="utf-8")
    print("published:", data["counts"]["published"], "| cancel skipped:", data["counts"]["cancelSkipped"],
          "| long-term:", data["counts"]["longTerm"])
    print("categories:", cats)
    print("분류 근거:", data["counts"]["basis"])
    print("price present:", sum(1 for r in data["bids"] if r["ep"]))
    print("region present:", sum(1 for r in data["bids"] if r["r"]), "/", len(data["bids"]))
    print("written:", DEST, DEST.stat().st_size, "bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
