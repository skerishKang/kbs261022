"""사이트 간 중복 후보 탐지 및 병합 판정 (issue #8 요구사항 3).

원칙
----
* 확신 부족한 중복은 **자동 병합하지 않는다** (요구사항 3).
* 같은 사이트 안에서는 ``(site, product_id)`` 가 유일해야 한다. 중복은 데이터
  오류로 보고 ``same_site_duplicate`` 로 표면화한다.
* 카테고리 번호는 사이트 namespace 로 분리된 상태로만 비교한다.

판정 단계
----------
``confirmed``  자동 병합 가능
``probable``   사람 검토 필요 (자동 병합 금지)
``candidate``  대조 필요 (자동 병합 금지)
``no_candidate`` 중복 후보 아님

핵심 규칙
----------
1. 모델 표현이 겹치지 않으면 중복 후보가 아니다.
   (``WL93`` 과 ``GLXD14R+/93`` 처럼 부분 문자열 포함 관계는 후보가 아니다)
2. 같은 모델 표현이 한 사이트에서 여러 상품에 걸리는 경우(= 모호), 그
   표현만으로는 구분할 수 없다 → **변형 서명** 이 일치해야 confirmed.
   (``KSM32C 라이트 세트`` 와 ``KSM32C 프리미엄 세트`` 는 자동 병합 금지)
3. 모호하지 않은 모델 표현은 양쪽에서 각각 단일 상품만 가리키면 confirmed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Optional, Sequence

from . import normalize as N

#: 자동 병합 가능한 판정.
AUTO_MERGE_VERDICTS: frozenset[str] = frozenset({"confirmed"})

VERDICTS: tuple[str, ...] = ("confirmed", "probable", "candidate", "no_candidate", "same_site_duplicate")


@dataclass
class MatchCandidate:
    """교차 사이트 중복 후보 1건."""

    left: Mapping[str, Any]
    right: Mapping[str, Any]
    verdict: str
    shared_phrases: list[str] = field(default_factory=list)
    signals: dict[str, Any] = field(default_factory=dict)
    reasons: list[str] = field(default_factory=list)

    @property
    def auto_mergeable(self) -> bool:
        return self.verdict in AUTO_MERGE_VERDICTS

    @property
    def group_key(self) -> str:
        return "|".join(sorted((self.left["source_key"], self.right["source_key"])))

    def to_dict(self) -> dict[str, Any]:
        return {
            "left_source_key": self.left["source_key"],
            "right_source_key": self.right["source_key"],
            "verdict": self.verdict,
            "auto_mergeable": self.auto_mergeable,
            "shared_phrases": self.shared_phrases,
            "signals": self.signals,
            "reasons": self.reasons,
        }


def _phrases(record: Mapping[str, Any]) -> set[str]:
    derived = record.get("derived") or {}
    values = derived.get("model_phrase_compact") or []
    out = {str(v) for v in values if v}
    model = record.get("model")
    compact = N.model_compact(model)
    if compact:
        out.add(compact)
    return out


def _phrase_index(records: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, set[str]]]:
    """사이트별 모델 표현 인덱스.

    ``index[site][phrase]`` = 해당 사이트에서 그 표현을 가진 레코드 key 집합.
    사이트를 분리해야 "이 표현이 이 사이트에서 단일 상품인가" 를 판단할 수 있다.
    """
    index: dict[str, dict[str, set[str]]] = {}
    for record in records:
        site = record["source_site"]
        bucket = index.setdefault(site, {})
        for phrase in _phrases(record):
            bucket.setdefault(phrase, set()).add(record["source_key"])
    return index


def _site_index(
    index: Mapping[str, Mapping[str, set[str]]], site: str
) -> Mapping[str, set[str]]:
    return index.get(site, {})


def _source_model_conflict(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    """양쪽 모두 모델명 스펙행이 있는데 값이 다르면 충돌."""
    lm = N.model_compact(left.get("model"))
    rm = N.model_compact(right.get("model"))
    if not lm or not rm:
        return False
    return lm != rm


def _org_agreement(left: Mapping[str, Any], right: Mapping[str, Any]) -> tuple[bool, list[str]]:
    """브랜드/제조사 값 일치 여부.

    필드 종류가 다르더라도(브랜드 vs 제조사) **값**이 같으면 참고 신호로만
    사용한다. 사유에 어떤 필드를 비교했는지 기록해 혼동을 막는다.
    """
    compared: list[str] = []
    agree = False
    for lf, rf in (("brand", "brand"), ("manufacturer", "manufacturer"), ("brand", "manufacturer")):
        lv, rv = left.get(lf), right.get(rf)
        if not lv or not rv:
            continue
        compared.append(f"{lf}~{rf}")
        if N.values_agree(lv, rv):
            agree = True
    return agree, compared


def classify(
    left: Mapping[str, Any],
    right: Mapping[str, Any],
    index: Mapping[str, set[str]],
) -> MatchCandidate:
    """두 레코드가 같은 상품인지 판정한다."""
    reasons: list[str] = []

    if left["source_site"] == right["source_site"]:
        return MatchCandidate(
            left, right, "same_site_duplicate", reasons=["같은 사이트의 동일 product_id"]
        )

    lph, rph = _phrases(left), _phrases(right)
    shared = sorted(lph & rph)
    name_sim = N.jaccard(left.get("name"), right.get("name"))
    org_agree, org_compared = _org_agreement(left, right)
    variant_conflict = N.variant_conflict(left.get("name"), right.get("name"))
    model_conflict = _source_model_conflict(left, right)

    signals = {
        "name_similarity": round(name_sim, 4),
        "org_value_agreement": org_agree,
        "org_fields_compared": org_compared,
        "variant_conflict": variant_conflict,
        "source_model_conflict": model_conflict,
        "left_model_field": left.get("model"),
        "right_model_field": right.get("model"),
    }

    if not shared:
        # 모델 표현이 전혀 겹치지 않으면 중복 후보가 아니다.
        if name_sim >= 0.8 and org_agree:
            reasons.append("이름 유사도가 높으나 모델 표현 불일치 → 검토 필요")
            return MatchCandidate(left, right, "probable", [], signals, reasons)
        reasons.append("공통 모델 표현 없음")
        return MatchCandidate(left, right, "no_candidate", [], signals, reasons)

    # 공유 표현이 양쪽 사이트에서 각각 단일 상품을 가리키는지
    left_index = _site_index(index, left["source_site"])
    right_index = _site_index(index, right["source_site"])
    cardinality = {
        p: {
            "left": len(left_index.get(p, set())),
            "right": len(right_index.get(p, set())),
        }
        for p in shared
    }
    unique_both = all(
        cardinality[p]["left"] == 1 and cardinality[p]["right"] == 1 for p in shared
    )
    ambiguous_phrases = [
        p for p in shared if cardinality[p]["left"] > 1 or cardinality[p]["right"] > 1
    ]
    signals["shared_phrase_cardinality"] = cardinality
    signals["unique_on_both_sites"] = unique_both

    if variant_conflict:
        reasons.append("변형 서명 충돌(예: 라이트 세트 vs 프리미엄 세트) → 자동 병합 금지")
        return MatchCandidate(left, right, "candidate", shared, signals, reasons)

    if model_conflict:
        reasons.append("원본 모델명 스펙행 값이 상이 → 자동 병합 금지")
        return MatchCandidate(left, right, "candidate", shared, signals, reasons)

    if unique_both:
        reasons.append(f"공통 모델 표현 {shared} 이 양 사이트에서 각각 단일 상품")
        return MatchCandidate(left, right, "confirmed", shared, signals, reasons)

    # 모호한 표현 → 변형 서명 일치 여부로 구분
    if ambiguous_phrases:
        lsig = set((left.get("derived") or {}).get("variant_signature") or [])
        rsig = set((right.get("derived") or {}).get("variant_signature") or [])
        variant_agree = (not lsig) or (not rsig) or (lsig == rsig)
        signals["variant_signature_left"] = sorted(lsig)
        signals["variant_signature_right"] = sorted(rsig)
        signals["variant_agreement"] = variant_agree
        if variant_agree and name_sim >= 0.5:
            reasons.append(
                f"모호한 모델 표현 {ambiguous_phrases} 이지만 변형 서명이 일치하고 이름이 유사"
            )
            return MatchCandidate(left, right, "confirmed", shared, signals, reasons)
        reasons.append(f"모호한 모델 표현 {ambiguous_phrases} 이고 변형 구분 근거 부족 → 사람 검토")
        return MatchCandidate(left, right, "probable", shared, signals, reasons)

    reasons.append("판정 근거 부족 → 사람 검토")
    return MatchCandidate(left, right, "candidate", shared, signals, reasons)


def find_candidates(
    records: Sequence[Mapping[str, Any]],
) -> list[MatchCandidate]:
    """전체 레코드에서 교차 사이트 중복 후보를 찾는다.

    같은 사이트끼리는 비교하지 않는다(복합키 위반은 별도 검사).
    """
    index = _phrase_index(records)
    by_site: dict[str, list[Mapping[str, Any]]] = {}
    for record in records:
        by_site.setdefault(record["source_site"], []).append(record)

    sites = sorted(by_site)
    out: list[MatchCandidate] = []
    for i, left_site in enumerate(sites):
        for right_site in sites[i + 1:]:
            for left in by_site[left_site]:
                for right in by_site[right_site]:
                    candidate = classify(left, right, index)
                    if candidate.verdict != "no_candidate":
                        out.append(candidate)
    out.sort(key=lambda c: (c.verdict, c.group_key))
    return out


def find_same_site_duplicates(
    records: Sequence[Mapping[str, Any]],
) -> list[tuple[str, str]]:
    """같은 사이트에서 중복된 ``(site, product_id)`` 쌍을 반환."""
    seen: dict[str, str] = {}
    dupes: list[tuple[str, str]] = []
    for record in records:
        key = record["source_key"]
        if key in seen:
            dupes.append((key, seen[key]))
        else:
            seen[key] = key
    return dupes


def build_groups(
    records: Sequence[Mapping[str, Any]],
    candidates: Sequence[MatchCandidate],
) -> dict[str, list[str]]:
    """``confirmed`` 후보만으로 중복 그룹을 만든다.

    ``probable`` / ``candidate`` 는 그룹을 만들지 않는다 (자동 병합 금지).
    """
    parent: dict[str, str] = {r["source_key"]: r["source_key"] for r in records}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for candidate in candidates:
        if candidate.auto_mergeable:
            union(candidate.left["source_key"], candidate.right["source_key"])

    groups: dict[str, list[str]] = {}
    for record in records:
        root = find(record["source_key"])
        groups.setdefault(root, []).append(record["source_key"])
    return {k: sorted(v) for k, v in groups.items() if len(v) > 1}


def apply_groups(
    records: Sequence[Mapping[str, Any]],
    groups: Mapping[str, Sequence[str]],
) -> list[dict[str, Any]]:
    """레코드에 ``dedupe_group_id`` / ``dedupe_confidence`` 를 기록한다.

    그룹이 없는 레코드는 그대로 두고, 그룹에 속한 레코드만 표기한다.
    """
    by_key = {r["source_key"]: r for r in records}
    out: list[dict[str, Any]] = []
    for record in records:
        copy = dict(record)
        key = record["source_key"]
        member_of = None
        for gid, members in groups.items():
            if key in members:
                member_of = gid
                break
        if member_of:
            copy["dedupe_group_id"] = member_of
            copy["dedupe_confidence"] = "confirmed"
        out.append(copy)
    return out
