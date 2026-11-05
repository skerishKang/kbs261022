#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""사정율 통계 계산 모듈 — 이슈 #188 8차.

입력은 "기초금액·예정가격이 확정된 개찰 결과 레코드"다(개찰결과 예비가격상세 수집분).
화면의 히스토그램·평균·표본 수·기간은 이 모듈의 계산 결과만 사용한다.

정의(ANALYSIS_DESIGN.md와 같다):
  사정률(%) = 예정가격 / 기초금액 × 100
  편차(%)   = 사정률 − 100
  히스토그램 = 0.1%p 구간(bucket)별 건수. 구간은 [k*0.1, (k+1)*0.1) 이고 k 늘어나며 정렬한다.

표본 묶음 우선순위(n≥30 기준, 순서대로 내려가며 처음 충족한 묶음을 쓴다):
  1) 같은 발주기관
  2) 같은 분류(물품/공사/용역) + 같은 금액대(5천만 미만/5천~1억/1억~10억/10억 이상, 추정가격 기준)
  3) 같은 분류 전체
  어느 묶음도 n<30이면 표본 부족으로 본다(숫자를 만들지 않는다).

입력 레코드 형식(수집기가 만든다):
  {"no": 공고번호, "agency": 발주기관명, "category": "물품|공사|용역", "ep": 추정가격,
   "base_amount": 기초금액, "presmpt_price": 예정가격, "open_at": "YYYY-MM-DD HH:MM:SS",
   "multi_prepaid": 복수예비가격 여부, "lottery": 추첨 여부}
"""
from __future__ import annotations

import math
from datetime import datetime

MIN_SAMPLE = 30
HISTOGRAM_WIDTH = 0.1
# 금액대 경계(추정가격 기준) — 화면 목록 필터와 같은 구간을 쓴다
PRICE_BANDS = (
    ("5천만원 미만", 0, 50_000_000),
    ("5천만원~1억원", 50_000_000, 100_000_000),
    ("1억원~10억원", 100_000_000, 1_000_000_000),
    ("10억원 이상", 1_000_000_000, None),
)


def success_rate(base_amount, presmpt_price) -> float | None:
    """사정률(%) = 예정가격 / 기초금액 × 100. 기초금액·예정가격이 양수가 아니면 None."""
    try:
        b, p = float(base_amount), float(presmpt_price)
    except (TypeError, ValueError):
        return None
    if not (b > 0 and p > 0):
        return None
    return round(p / b * 100, 4)


def deviation(rate: float | None) -> float | None:
    """편차(%) = 사정률 − 100."""
    return None if rate is None else round(rate - 100, 4)


def price_band(ep) -> str | None:
    """추정가격 → 금액대 이름. 금액이 없으면 None."""
    if ep is None:
        return None
    try:
        v = float(ep)
    except (TypeError, ValueError):
        return None
    for name, lo, hi in PRICE_BANDS:
        if v >= lo and (hi is None or v < hi):
            return name
    return None


def bucket_low(rate: float, width: float = HISTOGRAM_WIDTH) -> float:
    """rate가 속한 구간의 아래 끝. [k*width, (k+1)*width) 형태라 99.95 → 99.9, 100.05 → 100.0."""
    r = round(rate, 4)
    # 나눗셈 오차(100.3/0.1 = 1002.9999…)를 막기 위해 몫을 먼저 반올림한다.
    return round(math.floor(round(r / width, 6)) * width, 4)


def histogram(rates: list[float], width: float = HISTOGRAM_WIDTH) -> list[dict]:
    """0.1%p 구간별 건수. 구간 아래 끝 오름차순. 빈 구간은 내보내지 않는다."""
    counts: dict[float, int] = {}
    for r in rates:
        k = bucket_low(r, width)
        counts[k] = counts.get(k, 0) + 1
    return [
        {"bucket_low": k, "bucket_high": round(k + width, 4), "count": counts[k]}
        for k in sorted(counts)
    ]


def summarize(rates: list[float]) -> dict:
    """평균·중앙값·표준편차(모집단, Δ제곱 평균의 제곱근)·표본 수."""
    n = len(rates)
    if not n:
        return {"n": 0}
    s = sorted(rates)
    mean = sum(s) / n
    median = s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2
    var = sum((x - mean) ** 2 for x in s) / n
    return {
        "n": n,
        "mean": round(mean, 2),
        "median": round(median, 2),
        "stdev": round(math.sqrt(var), 2),
        "min": round(s[0], 2),
        "max": round(s[-1], 2),
    }


def valid_records(records: list[dict]) -> list[dict]:
    """기초금액·예정가격으로 사정률을 계산할 수 있는 레코드만 남긴다(개찰일 있는 것)."""
    out = []
    for r in records:
        rate = success_rate(r.get("base_amount"), r.get("presmpt_price"))
        if rate is None or not r.get("open_at"):
            continue
        out.append({**r, "rate": rate})
    return out


def select_bundle(target: dict, records: list[dict], min_n: int = MIN_SAMPLE) -> dict:
    """표본 묶음 우선순위: 같은 발주기관 → 같은 분류+금액대 → 분류 전체.

    target: {"agency":…, "category":…, "ep":…}  records: valid_records() 출력.
    반환: {"group": "agency"|"category_price"|"category", "bundle": 이름, "records": [...]}
    어느 묶음도 min_n 미만이면 {"group": None, "bundle": "표본 부족", "records": []}.
    """
    band = price_band(target.get("ep"))
    same_agency = [r for r in records if r.get("agency") == target.get("agency")]
    if len(same_agency) >= min_n:
        return {"group": "agency", "bundle": f"발주기관: {target.get('agency')}", "records": same_agency}
    same_cat_band = [
        r for r in records
        if r.get("category") == target.get("category") and price_band(r.get("ep")) == band
    ]
    if len(same_cat_band) >= min_n:
        return {"group": "category_price", "bundle": f"분류 {target.get('category')} · 금액대 {band}", "records": same_cat_band}
    same_cat = [r for r in records if r.get("category") == target.get("category")]
    if len(same_cat) >= min_n:
        return {"group": "category", "bundle": f"분류 {target.get('category')} 전체", "records": same_cat}
    return {"group": None, "bundle": "표본 부족", "records": []}


def open_period(records: list[dict]) -> dict:
    """기간(최초~최종 개찰일, YYYY-MM-DD)."""
    ds = sorted(str(r.get("open_at"))[:10] for r in records if r.get("open_at"))
    return {"first_open": ds[0] if ds else None, "last_open": ds[-1] if ds else None}


def bid_stats(target: dict, records: list[dict], min_n: int = MIN_SAMPLE) -> dict:
    """공고 1건의 사정율 통계. 숫자는 실표본이 충분할 때만 내보낸다(그렇지 않으면 표본 부족)."""
    valid = valid_records(records)
    sel = select_bundle(target, valid, min_n)
    if sel["group"] is None:
        return {"collected": False, "reason": "표본 부족", "bundle": sel["bundle"]}
    rates = [r["rate"] for r in sel["records"]]
    s = summarize(rates)
    period = open_period(sel["records"])
    return {
        "collected": True,
        "bundle": sel["bundle"],
        "group": sel["group"],
        **s,
        "histogram": histogram(rates),
        **period,
    }
