#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Deterministic A/B/C classification and enrichment merge for G2B bids."""

from __future__ import annotations

import csv
import html
import json
import os
import re
from collections import Counter, defaultdict
from datetime import date, datetime, timezone

AS_OF_DEFAULT = "2026-10-23"

DIRECT = [
    "음향콘솔", "오디오믹서", "믹싱콘솔", "디지털믹서", "스피커", "앰프", "마이크",
    "음향장비", "음향설비", "음향시스템", "음향기기", "음향장치", "무대음향",
    "전관방송", "구내방송", "pa시스템",
    "방송장비", "방송설비", "방송시스템", "방송장치", "방송카메라", "카메라세트",
    "영상스위처", "스위처", "인터컴",
    "영상장비", "영상설비", "영상시스템", "av장비", "av시스템",
    "영상회의", "화상회의", "회의시스템", "프로젝터", "비디오프로젝터", "비디오캡처보드",
]
SPECIAL = [
    "재난방송", "비상방송", "경보방송", "경고방송", "확성기", "라디오재방송",
    "지하재방송", "소방방송", "마을방송", "방송수신기", "재난방송수신설비",
    "중계설비", "방송전용회선",
]
LIGHT = [
    "무대조명", "조명장치", "조명장비", "무빙라이트", "leddimming", "객석조명",
    "방송실용조명", "공연장조명",
]
FIELD = [
    "방송", "영상", "음향", "스피커", "마이크", "앰프", "믹서", "콘솔", "오디오", "av",
    "영상회의", "화상회의", "회의시스템", "프로젝터", "디스플레이", "카메라",
    "중계방송", "중계설비", "영상중계차", "방송실", "방송선로", "방송통신",
    "방송전용회선", "확성기", "전관방송", "구내방송", "비상방송", "안내방송",
    "재난방송", "경보방송", "마을방송", "라디오재방송", "지하재방송", "소방방송",
    "무대조명", "조명장치", "조명장비", "무빙라이트", "leddimming", "객석조명",
    "방송실용조명", "공연장통합운영시스템", "영상제작센터", "영상편집실",
    "영상스튜디오", "방송스튜디오", "방송수신기",
]
SURV = [
    "cctv", "영상감시", "영상기록장치", "블랙박스", "무인교통", "영상분석",
    "화상분석", "영상모니터링", "저조도영상", "이동형영상감시", "투과영상",
    "영상확대",
]
STAGE = [
    "무대장치", "무대기계", "무대막", "커튼", "무대세트", "세트제작", "막구조물",
    "폰툰", "무대대기실", "무대설치", "무대제작", "무대용역비", "무대시스템",
    "무대중계", "무대연출", "출연진", "공연연출",
]
ACQUIRE = [
    "구매", "구입", "납품", "제조구매", "구매설치", "교체", "보강", "현대화",
    "구축", "제조", "제3자단가", "단가계약", "시범구매", "직접구매",
    "조달청계약", "계약요청", "설치", "관급자재",
]
VETO = [
    "임차", "대여", "렌탈", "운영", "운용", "유지보수", "유지관리", "보수", "정비",
    "진단", "감리", "설계", "컨설팅", "기술지도", "연출", "대행", "위탁", "촬영",
    "중계방송", "원격제작", "송출", "모집", "선정", "협력사", "행사", "축제",
    "무대설치", "무대제작", "무대세트", "출연진", "폰툰", "용역",
    "미술세트", "아카이브", "저장관리", "기록관리", "시험",
]
ABS = [
    ("medical", [
        "의료", "영상의학", "영상검사", "영상판독", "원격판독", "의료영상",
        "초음파", "mri", "엑스선", "방사선", "내시경", "청력", "음향코통기도",
        "이음향방사", "생체광학", "광음향", "판독", "영상합성", "영상진단",
        "영상확대", "핵의학",
    ], "의료영상·의료기기 계열"),
    ("content", [
        "홍보영상", "홍보동영상", "영상제작", "영상콘텐츠", "영상물", "동영상",
        "영상촬영", "촬영", "영상편집", "모션그래픽", "아카이빙", "후반작업",
        "cg/vfx", "애니메이션", "프로그램제작", "중계방송제작", "공익광고",
        "화면해설", "송출", "백서", "전시연출", "영상연출", "콘텐츠", "이러닝",
        "영상광고", "에셋", "뉴스", "저작권", "학술행사", "연수", "콜센터",
        "인터넷서비스", "사장후보", "국민추천위원회", "외주제작", "미술세트",
        "광고", "필름디지털화",
    ], "영상 콘텐츠 제작·송출·행사 용역"),
    ("imagery", ["위성영상", "정사영상", "항공영상", "원격탐사", "영상부가처리"],
     "위성·항공 영상 처리"),
    ("acoustics", [
        "음향탐측", "음향탐지", "음향측정", "음향분석", "소음", "구조음향",
        "음향이미저", "음향이탈기", "음향신호기", "음향코통기도",
        "음향익사이터", "수중음향", "음향시각화", "데시벨", "음향이미징",
    ], "음향 측정·탐지·분석 장비"),
    ("clothing", ["교복", "학생복", "동복", "하복"], "교복·학생복"),
    ("other", [
        "발전기", "전력공급", "승강기", "냉난방", "ghp", "히트펌프", "열펌프",
        "질소발생기", "로봇", "차량", "항공권", "여행", "보험", "채용", "세무",
        "회계", "법률", "청소", "경비", "인쇄", "가구", "의약품", "식품",
        "측정장비", "측정기", "시험장비", "시험영상", "시험선", "내구시험",
        "빙해수조", "엑스레이", "투과영상", "방사능", "방사선", "디스크",
        "하드디스크", "어레이", "서버", "전산", "정보시스템", "소프트웨어",
        "클라우드", "dbms", "데이터베이스", "네트워크", "보안", "데이터센터",
        "전산기기", "정보통신시스템", "정보통신설비", "기록관리시스템",
        "문서유통", "암호모듈", "라이선스", "프로그램테스트", "솔루션", "saas",
        "플랫폼", "홈페이지", "웹", "앱", "정보화", "원격검침", "자가통신망",
        "통신망", "구내통신설비", "its", "드론", "무인항공기", "위성",
        "공정장비", "검증환경", "기능안전", "코팅", "피복관", "아크이온",
        "전력구", "변전", "배전", "154kv", "t/l", "무정전", "태양광",
        "배터리", "공조", "보일러", "가스엔진", "표준기록", "전자문서",
        "휴머노이드", "cloud", "실습실", "상용sw", "데이터분산저장",
    ], "정보시스템·연구·시설 장비"),
]
GEO_C = ["영상골", "방송지구"]
DIRECT_ITEMS = [
    "구내방송장치", "오디오믹서", "스피커", "오디오앰프",
    "융복합음향기기", "융복합무선마이크", "융복합스피커",
    "융복합오디오프리젠테이션", "비디오프로젝터", "비디오캡처보드",
]
CLASS_LABELS = {
    "A": "CGI 취급 상품과 직접 연관",
    "B": "음향·AV·방송 분야, 세부 조건 확인 필요",
    "C": "CGI 영업 관련성 낮음",
}


def _norm(value):
    text = html.unescape(str(value or ""))
    return re.sub(r"\s+", " ", text).strip()


def _compact(value):
    return re.sub(r"\s+", "", _norm(value)).lower()


def _find(text, terms):
    return [term for term in terms if term in text]


def _is_content_facility(text):
    return any(x in text for x in ["영상제작센터", "영상편집실", "영상스튜디오", "방송스튜디오"])


def _is_construction(title_compact, title_norm):
    if "공사" in title_compact:
        return True
    return any(x in title_compact for x in ["(전기)", "(통신)", "(소방)", "(건축)", "(기계)"])


def classify_av(title, item_classes=None):
    """Classify one notice as A/B/C using title and verified item classes only."""
    text = _compact(title)
    items = [x for x in (item_classes or []) if x]
    item_hits = [x for x in items if any(k in _compact(x) for k in DIRECT_ITEMS)]

    if "방송전용회선" in text:
        return {"av_class": "B", "av_reason": "방송 전용회선·전송망",
                "evidence_terms": ["방송전용회선"], "evidence_source": "title"}

    for category, terms, reason in ABS:
        hits = _find(text, terms)
        if hits:
            if category == "content" and _is_content_facility(text):
                continue
            return {"av_class": "C", "av_reason": reason,
                    "evidence_terms": hits, "evidence_source": "title"}

    geo = _find(text, GEO_C)
    if geo:
        return {"av_class": "C", "av_reason": "지명·지구명에 포함된 문자열",
                "evidence_terms": geo, "evidence_source": "title"}

    surv = _find(text, SURV)
    av_text = text
    for term in SURV:
        av_text = av_text.replace(term, " ")

    direct = _find(av_text, DIRECT)
    if not direct:
        if "음향" in av_text and any(k in av_text for k in ["시스템", "장비", "설비", "기기", "장치", "콘솔"]):
            direct = [k for k in ["음향", "시스템"] if k in av_text]
        elif "방송" in av_text and any(k in av_text for k in ["시스템", "장비", "설비", "장치"]):
            direct = [k for k in ["방송", "시스템"] if k in av_text]
        elif "영상" in av_text and any(k in av_text for k in ["시스템", "장비", "설비", "회의"]):
            direct = [k for k in ["영상", "시스템"] if k in av_text]

    if surv and not direct and not _find(text, SPECIAL):
        return {"av_class": "C", "av_reason": "CCTV·영상감시·영상분석 계열",
                "evidence_terms": surv, "evidence_source": "title"}

    acquire = _find(text, ACQUIRE)
    veto = _find(text, VETO)
    special = _find(text, SPECIAL)
    construction = _is_construction(text, _norm(title))
    exempt = any(x in text for x in ["관급자재", "직접구매자재"])

    if direct and acquire and not veto and not special and not (construction and not exempt):
        if items and not item_hits:
            return {"av_class": "B", "av_reason": "제목상 직접 연관이나 검증 품목이 비(非)음향/AV",
                    "evidence_terms": direct + acquire + item_hits, "evidence_source": "title+item"}
        return {"av_class": "A", "av_reason": "직접 상품 구매/설치",
                "evidence_terms": direct + acquire + item_hits,
                "evidence_source": "title+item" if item_hits else "title"}

    if special and (acquire or direct):
        return {"av_class": "B", "av_reason": "특수 방송설비(재난/비상/경보/확성기 등)",
                "evidence_terms": direct + special + acquire, "evidence_source": "title"}

    if direct and acquire and construction and not exempt:
        return {"av_class": "B", "av_reason": "공사·전기/통신 계약에 포함된 방송/AV 자재",
                "evidence_terms": direct + acquire + ["공사"], "evidence_source": "title"}

    field = _find(text, FIELD)
    if veto and (direct or field):
        return {"av_class": "B", "av_reason": "임차·운영·유지보수·용역성 입찰",
                "evidence_terms": (direct or field) + veto, "evidence_source": "title"}

    light = _find(text, LIGHT)
    if light:
        return {"av_class": "B", "av_reason": "무대조명 장비",
                "evidence_terms": light, "evidence_source": "title"}

    if field:
        return {"av_class": "B", "av_reason": "음향·AV·방송 인접 분야",
                "evidence_terms": field, "evidence_source": "title"}

    stage = _find(text, STAGE)
    if stage:
        return {"av_class": "C", "av_reason": "무대기계·세트·막 구조물",
                "evidence_terms": stage, "evidence_source": "title"}

    return {"av_class": "C", "av_reason": "직접 연관 없음",
            "evidence_terms": [], "evidence_source": "none"}


def load_enrichment(path):
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    if isinstance(data, dict):
        data = data.get("items") or data.get("records") or data.get("bids") or []
    return {row.get("bid_no"): row for row in data if row.get("bid_no")}


def _to_number(value):
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return value
    text = str(value).replace(",", "").replace("원", "").strip()
    try:
        return float(text) if "." in text else int(text)
    except ValueError:
        return None


def parse_date(value):
    if value is None or value == "" or value == "-":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip().replace("/", "-").replace(".", "-")
    match = re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})", text)
    if not match:
        return None
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


def clean_text(value):
    text = html.unescape(str(value or ""))
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\[\s+", "[", text)
    text = re.sub(r"\s+\]", "]", text)
    return text


def _close_text(value):
    if value is None:
        return None
    text = str(value).strip()
    if not text or text == "-":
        return None
    return text.replace("/", "-").replace(".", "-")


def _title_key(title):
    return re.sub(r"[^0-9a-z가-힣]", "", _norm(title).lower())


def _item_classes(enrichment):
    classes = []
    for item in (enrichment or {}).get("items") or []:
        name = item.get("class_name")
        if name:
            classes.append(name)
    return classes


def _item_details(enrichment):
    details = []
    for item in (enrichment or {}).get("items") or []:
        details.append({
            "class_no": item.get("class_no"),
            "class_name": item.get("class_name"),
            "detail_name": item.get("detail_name"),
            "qty": item.get("qty"),
        })
    return details


def _duplicate_map(bids):
    groups = defaultdict(list)
    for bid in bids:
        key = _title_key(bid.get("title"))
        if key:
            groups[key].append(bid.get("bid_no"))
    info = {}
    for key, bid_nos in groups.items():
        if len(bid_nos) > 1:
            for rank, bid_no in enumerate(bid_nos, start=1):
                info[bid_no] = {
                    "duplicate_group_id": bid_nos[0],
                    "duplicate_group_size": len(bid_nos),
                    "duplicate_rank": rank,
                }
    return info, {k: v for k, v in groups.items() if len(v) > 1}


def _lifecycle(close_value, status, as_of):
    as_of_date = parse_date(as_of) if isinstance(as_of, str) else as_of
    status_text = _norm(status)
    cancelled = "취소" in status_text
    close_date = parse_date(close_value)

    if cancelled:
        return {"state": "cancelled", "is_open": False, "close_date": close_date.isoformat() if close_date else None,
                "days_left": None, "note": "취소 공고"}
    if close_date is None:
        return {"state": "unknown", "is_open": None, "close_date": None,
                "days_left": None, "note": "마감일 미확인 — 원문 확인 필요"}
    if close_date.year - as_of_date.year > 5:
        return {"state": "unknown", "is_open": None, "close_date": close_date.isoformat(),
                "days_left": None, "note": "마감일 이상값 — 원문 확인 필요"}
    days_left = (close_date - as_of_date).days
    if days_left >= 0:
        return {"state": "open", "is_open": True, "close_date": close_date.isoformat(),
                "days_left": days_left, "note": "당일 마감" if days_left == 0 else "입찰 진행"}
    return {"state": "closed", "is_open": False, "close_date": close_date.isoformat(),
            "days_left": days_left, "note": "입찰 마감"}


def _qualification_note(record):
    if record["detail_status"] != "ok":
        return "G2B 상세 API 미제공 — 자격·품목·금액 원문 확인 필요"
    parts = []
    if record["region_restricted"] == "Y":
        parts.append("지역제한: " + (record["region_text"] or "원문 확인"))
    if record["license_restricted"] == "Y":
        parts.append("업종제한: " + (record["license_text"] or "원문 확인"))
    if record["performance_restricted"] == "Y":
        parts.append("실적제한: " + (record["performance_text"] or "원문 확인"))
    if record["manufacture_restricted"] == "Y":
        parts.append("제조제한: " + (record["manufacture_text"] or "원문 확인"))
    if not parts:
        parts.append("상세 API상 지역·업종·실적 제한 없음")
    if record["av_class"] in ("A", "B"):
        if record["item_check"] == "item_mismatch":
            parts.append("품목분류가 음향/AV와 불일치 — 규격서 확인 필요")
        elif record["item_check"] == "no_item_data":
            parts.append("품목분류 미제공 — 규격서 확인 필요")
    return "; ".join(parts)


def _amount_status(value, detail_status):
    if detail_status != "ok":
        return "detail_unavailable"
    if value is None:
        return "not_provided"
    if _to_number(value) is not None and _to_number(value) <= 1:
        return "placeholder"
    return "ok"


def build_records(bids, enrichment_map, as_of=AS_OF_DEFAULT):
    duplicate_info, duplicate_groups = _duplicate_map(bids)
    records = []
    for bid in bids:
        enrichment = enrichment_map.get(bid.get("bid_no")) or {}
        fetch_status = enrichment.get("fetch_status")
        detail_status = "ok" if fetch_status == "ok" else ("unavailable" if enrichment else "missing")

        close_raw = bid.get("close_date")
        close_enriched = enrichment.get("bid_close")
        close_value = close_enriched or close_raw
        close_basis = "enriched_bid_close" if close_enriched else ("raw_close_date" if close_raw not in (None, "", "-") else "none")

        estimated = bid.get("estimated_price")
        if estimated is None:
            estimated = enrichment.get("estimated_price")
        estimated = _to_number(estimated)

        item_classes = _item_classes(enrichment)
        if detail_status != "ok":
            item_check = "unavailable"
        elif not item_classes:
            item_check = "no_item_data"
        else:
            item_check = "direct_item_match" if any(
                any(k in _compact(name) for k in DIRECT_ITEMS) for name in item_classes
            ) else "item_mismatch"

        classification = classify_av(bid.get("title"), item_classes)
        lifecycle = _lifecycle(close_value, bid.get("status"), as_of)
        duplicate = duplicate_info.get(bid.get("bid_no"), {})

        if detail_status == "ok":
            region_restricted = enrichment.get("region_restricted") or "N"
            license_restricted = enrichment.get("license_restricted") or "N"
            performance_restricted = enrichment.get("performance_restricted") or "N"
            manufacture_restricted = enrichment.get("manufacture_restricted") or "N"
        else:
            region_restricted = None
            license_restricted = None
            performance_restricted = None
            manufacture_restricted = None

        record = dict(bid)
        record.update({
            "notice_agency": enrichment.get("notice_agency") or bid.get("agency"),
            "demand_agency": enrichment.get("demand_agency") or bid.get("agency"),
            "contract_method": enrichment.get("contract_method"),
            "bid_method": enrichment.get("bid_method"),
            "award_method": enrichment.get("award_method"),
            "bid_close": _close_text(close_value),
            "close_date_basis": close_basis,
            "qual_reg_close": enrichment.get("qual_reg_close"),
            "estimated_price": estimated,
            "estimated_price_status": _amount_status(estimated, detail_status),
            "allocated_budget": _to_number(enrichment.get("allocated_budget")),
            "business_amount": _to_number(enrichment.get("business_amount")),
            "vat": _to_number(enrichment.get("vat")),
            "region_restricted": region_restricted,
            "region_text": clean_text(enrichment.get("region_text")),
            "license_restricted": license_restricted,
            "license_text": clean_text(enrichment.get("license_text")),
            "performance_restricted": performance_restricted,
            "performance_text": clean_text(enrichment.get("performance_text")),
            "manufacture_restricted": manufacture_restricted,
            "manufacture_text": clean_text(enrichment.get("manufacture_text")),
            "item_class_limit": clean_text(enrichment.get("item_class_limit")),
            "item_classes": ";".join(dict.fromkeys(item_classes)),
            "item_details": _item_details(enrichment),
            "item_check": item_check,
            "detail_status": detail_status,
            "detail_error": enrichment.get("error"),
            "detail_verified_at": enrichment.get("verified_at"),
            "av_class": classification["av_class"],
            "av_reason": classification["av_reason"],
            "evidence_terms": classification["evidence_terms"],
            "evidence_source": classification["evidence_source"],
            "lifecycle_state": lifecycle["state"],
            "is_open": lifecycle["is_open"],
            "lifecycle_close_date": lifecycle["close_date"],
            "days_left": lifecycle["days_left"],
            "lifecycle_note": lifecycle["note"],
            "duplicate_group_id": duplicate.get("duplicate_group_id"),
            "duplicate_group_size": duplicate.get("duplicate_group_size", 1),
            "duplicate_rank": duplicate.get("duplicate_rank", 1),
            "detail_url_verified": False,
            "url_note": "수집 링크 미검증 — 공고번호로 G2B 통합검색 확인",
        })
        record["qualification_note"] = _qualification_note(record)
        record["review_flags"] = _review_flags(record)
        records.append(record)

    return records, duplicate_groups


def _review_flags(record):
    flags = []
    if record["av_class"] == "A":
        flags.append("direct_match")
    if record["detail_status"] != "ok":
        flags.append("detail_unavailable")
    if record["item_check"] == "item_mismatch":
        flags.append("item_mismatch")
    if record["duplicate_group_size"] > 1:
        flags.append("duplicate_title")
    if record["region_restricted"] == "Y":
        flags.append("region_restricted")
    if record["license_restricted"] == "Y":
        flags.append("license_restricted")
    if record["estimated_price_status"] in ("not_provided", "placeholder"):
        flags.append("amount_unconfirmed")
    if record["lifecycle_state"] == "open" and record["days_left"] is not None and record["days_left"] <= 7:
        flags.append("deadline_within_7d")
    if record["av_class"] == "B":
        if "특수 방송설비" in record["av_reason"]:
            flags.append("special_broadcast")
        if "임차·운영" in record["av_reason"]:
            flags.append("service_or_rental")
        if "공사" in record["av_reason"]:
            flags.append("construction_context")
        if "무대조명" in record["av_reason"]:
            flags.append("lighting")
    return flags


def _review_priority(record):
    if record["av_class"] == "A":
        if record["lifecycle_state"] in ("open", "unknown"):
            return 1
        return 2
    return 3


def _next_action(record):
    if record["lifecycle_state"] == "cancelled":
        return "취소 공고 — 제외"
    if record["lifecycle_state"] == "closed":
        return "마감 — 차기 공고 모니터링"
    if record["lifecycle_state"] == "unknown":
        return "마감일·원문 확인 필요"
    if record["detail_status"] != "ok":
        return "원문 확인 필요"
    if record["av_class"] == "A":
        return "규격서·자격요건 확인 후 투찰 검토"
    return "세부 품목·계약방식 확인"


def build_stats(records, legacy_bids, enrichment_map, as_of=AS_OF_DEFAULT):
    class_counts = Counter(record["av_class"] for record in records)
    reason_counts = Counter(record["av_reason"] for record in records)
    lifecycle_counts = Counter(record["lifecycle_state"] for record in records)
    by_class_lifecycle = Counter((record["av_class"], record["lifecycle_state"]) for record in records)
    by_class_status = Counter((record["av_class"], record["status"] or "미상") for record in records)
    item_check_counts = Counter(record["item_check"] for record in records)
    detail_counts = Counter(record["detail_status"] for record in records)
    amount_counts = Counter(record["estimated_price_status"] for record in records)

    duplicate_groups = defaultdict(list)
    for record in records:
        if record["duplicate_group_size"] > 1:
            duplicate_groups[record["duplicate_group_id"]].append(record["bid_no"])

    legacy_nos = {bid.get("bid_no") for bid in legacy_bids}
    legacy_records = [record for record in records if record["bid_no"] in legacy_nos]

    return {
        "as_of": as_of,
        "total_bids": len(records),
        "valid_bids": sum(1 for r in records if r.get("bid_no") and r.get("title")),
        "classification": {
            code: {
                "label": CLASS_LABELS[code],
                "count": class_counts.get(code, 0),
                "share_pct": round(class_counts.get(code, 0) / len(records) * 100, 2) if records else 0,
            }
            for code in ("A", "B", "C")
        },
        "by_class_lifecycle": {
            code: {state: by_class_lifecycle.get((code, state), 0)
                   for state in ("open", "closed", "cancelled", "unknown")}
            for code in ("A", "B", "C")
        },
        "by_class_status": {
            code: {status: count for (c, status), count in by_class_status.items() if c == code}
            for code in ("A", "B", "C")
        },
        "reason_counts": dict(reason_counts.most_common()),
        "lifecycle_counts": dict(lifecycle_counts),
        "item_check_counts": dict(item_check_counts),
        "detail_counts": dict(detail_counts),
        "amount_counts": dict(amount_counts),
        "rated_bids": sum(1 for r in records if r.get("bid_rate_pct") is not None),
        "unrated_bids": sum(1 for r in records if r.get("bid_rate_pct") is None),
        "rated_note": "원본에 낙찰금액·투찰금액 필드가 없어 투찰률 계산 불가",
        "duplicates": {
            "groups": len(duplicate_groups),
            "excess_records": sum(len(v) - 1 for v in duplicate_groups.values()),
            "group_members": dict(duplicate_groups),
        },
        "legacy": {
            "count": len(legacy_records),
            "excluded_count": len(records) - len(legacy_records),
            "method": "기존 classify_cgi(제목+계약구분+발주기관, 부정키워드) 결과",
            "excluded_bid_nos": sorted({r["bid_no"] for r in records} - legacy_nos),
        },
        "source_detail": {
            "enriched_records": len(enrichment_map),
            "available": detail_counts.get("ok", 0),
            "unavailable": detail_counts.get("unavailable", 0),
        },
        "catalog_note": "CGI 상품 카탈로그의 브랜드·모델명은 공고 제목에서 확인되지 않아 품목분류·제목 근거로만 판정",
    }


ANALYSIS_COLUMNS = [
    "bid_no", "title", "av_class", "av_reason", "evidence_terms", "evidence_source",
    "item_check", "item_classes", "status", "lifecycle_state", "bid_close", "days_left",
    "notice_agency", "demand_agency", "estimated_price", "estimated_price_status",
    "region_restricted", "region_text", "license_restricted", "license_text",
    "detail_status", "duplicate_group_size", "detail_url", "detail_url_verified",
    "url_note", "qualification_note",
]
QUALIFICATION_COLUMNS = [
    "bid_no", "title", "av_class", "status", "lifecycle_state", "bid_close", "qual_reg_close",
    "notice_agency", "demand_agency", "contract_method", "bid_method", "award_method",
    "estimated_price", "allocated_budget", "business_amount", "region_restricted", "region_text",
    "license_restricted", "license_text", "performance_restricted", "performance_text",
    "manufacture_restricted", "manufacture_text", "item_class_limit", "item_classes",
    "item_check", "qualification_note", "detail_status", "detail_url", "detail_url_verified",
]
MANUAL_COLUMNS = [
    "priority", "bid_no", "title", "av_class", "av_reason", "evidence_terms", "item_check",
    "item_classes", "status", "lifecycle_state", "bid_close", "days_left", "notice_agency",
    "demand_agency", "estimated_price", "estimated_price_status", "region_restricted",
    "region_text", "license_restricted", "license_text", "detail_status", "review_flags",
    "next_action", "duplicate_group_size",
]


def _flatten(record, columns):
    row = {}
    for column in columns:
        value = record.get(column)
        if isinstance(value, (list, dict)):
            value = json.dumps(value, ensure_ascii=False)
        row[column] = value
    return row


def write_csv(path, records, columns):
    with open(path, "w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for record in records:
            writer.writerow(_flatten(record, columns))


def _manual_rows(records):
    rows = []
    for record in records:
        if record["av_class"] not in ("A", "B"):
            continue
        row = dict(record)
        row["priority"] = _review_priority(record)
        row["review_flags"] = ";".join(record["review_flags"])
        row["next_action"] = _next_action(record)
        rows.append(row)
    rows.sort(key=lambda r: (r["priority"], r["days_left"] if r["days_left"] is not None else 9999,
                             r["bid_no"]))
    return rows


def write_classification_outputs(out_dir, records, stats, legacy_records):
    os.makedirs(out_dir, exist_ok=True)

    direct = [r for r in records if r["av_class"] == "A"]
    review = [r for r in records if r["av_class"] == "B"]
    related = [r for r in records if r["av_class"] in ("A", "B")]
    manual = _manual_rows(records)

    outputs = {
        "bid_classification.csv": (records, ANALYSIS_COLUMNS),
        "cgi_direct_bids.csv": (direct, ANALYSIS_COLUMNS),
        "cgi_review_bids.csv": (review, ANALYSIS_COLUMNS),
        "cgi_related_bids.csv": (related, ANALYSIS_COLUMNS),
        "manual_review_bids.csv": (manual, MANUAL_COLUMNS),
        "bid_qualification_summary.csv": (records, QUALIFICATION_COLUMNS),
    }
    for name, (rows, columns) in outputs.items():
        write_csv(os.path.join(out_dir, name), rows, columns)

    with open(os.path.join(out_dir, "classification_stats.json"), "w", encoding="utf-8") as handle:
        json.dump(stats, handle, ensure_ascii=False, indent=2)

    legacy_summary = dict(stats["legacy"])
    legacy_summary.update({
        "raw_count": stats["total_bids"],
        "as_of": stats["as_of"],
        "classification_counts": dict(Counter(r["av_class"] for r in legacy_records)),
    })
    with open(os.path.join(out_dir, "legacy_356_analysis.json"), "w", encoding="utf-8") as handle:
        json.dump({"summary": legacy_summary, "bids": legacy_records}, handle, ensure_ascii=False, indent=2)

    return outputs
