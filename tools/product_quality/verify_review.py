"""이슈 #43 Stage 2 — 검토 후보의 자동 검증(교차 실측) 규칙.

Stage 1이 원본 스펙행과 이슈 #8 confirmed 판정만 자동화했다면, Stage 2는
**검토로 남긴 후보를 이미 수집된 원본 어휘로 재대조**해서 승격 가능한 것만 올린다.

승격 규칙 (대표 결정 1-B)
------------------------
후보 모델명 문자열이 **같은 브랜드**의 명시적 ``모델명`` 스펙행에서
**독립 원본 ID 2건 이상**으로 관찰될 때만 auto_confirmed 로 승격한다.
같은 원본 ID에서 반복 관찰되는 것은 독립 증거로 치지 않는다.

승격하지 않고 우선검토로 표시만 하는 것 (결정 3-B)
--------------------------------------------------
- 실측 1건(1-B 미만족) / 영문상품명과 파생 표현 일치 / 상대 사이트 probable·candidate 판정
- 브랜드 자리표시자 중 모델명 어휘가 단일 브랜드로 실증되는 경우 → 제안만, 원본 표기 유지
- 제조사 검토(브랜드 미관찰·자리표시자)는 승격 근거가 없어 현행 유지
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

from tools.product_master import normalize as N

from . import quality as Q

STAGE2_VERSION = "1.1.0"

#: 승격에 필요한 최소 독립 원본 ID 수 (대표 결정 1-B)
REQUIRED_INDEPENDENT_IDS = 2

PRIORITY_LABELS = {
    "1": "P1 실측됨(승격 기준 미달 또는 브랜드 제안)",
    "2": "P2 영문상품명=파생 일치",
    "3": "P3 상대 공급처 중복 판정 보유",
    "4": "P4 교차 실측·일치·링크 없음",
}

_VERDICT_RANK = {"confirmed": 3, "probable": 2, "candidate": 1, "same_site_exact": 1}


@dataclass
class Verification:
    """검토·승격 판정에 쓰인 실측 지표. 시트·CSV 컬럼으로 그대로 노출된다."""

    attest_ids: int = 0
    attest_observations: int = 0
    attest_value: str = ""
    attest_sample_url: str = ""
    other_brand_hits: int = 0
    english_matches_derived: bool = False
    duplicate_verdict: str = ""
    priority: str = "4"
    rationale: str = ""
    promoted: bool = False
    candidate: str = ""

    def to_columns(self) -> dict[str, Any]:
        return {
            "실측독립ID": self.attest_ids,
            "실측관찰": self.attest_observations,
            "실측값": self.attest_value,
            "타브랜드출현": self.other_brand_hits,
            "영문파생일치": "예" if self.english_matches_derived else "아니오",
            "중복판정등급": self.duplicate_verdict,
            "검토우선순위": self.priority,
            "판정근거": self.rationale,
        }


@dataclass
class Stage2Result:
    promoted: list[str] = field(default_factory=list)
    promotions: list[dict[str, Any]] = field(default_factory=list)
    verification: dict[tuple[str, str], Verification] = field(default_factory=dict)
    stats: dict[str, Any] = field(default_factory=dict)


# --------------------------------------------------------------------------
# 어휘: 원본 ``모델명`` 스펙행에서 실측한 값 (독립 원본 ID 단위)
# --------------------------------------------------------------------------


def build_model_lexicon(records: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    """compact 모델명 → {ids: {원본ID}, by_brand: {brand_norm: {원본ID}}, brand_observations: Counter, values: Counter}."""
    lexicon: dict[str, dict[str, Any]] = {}
    for record in records:
        raw = Q._clean(record.get("model"))
        if not raw or Q.is_placeholder(raw):
            continue
        compact = N.model_compact(raw)
        if not compact:
            continue
        entry = lexicon.setdefault(compact, {
            "ids": set(),
            "by_brand": defaultdict(set),
            "brand_observations": Counter(),
            "values": Counter(),
            "urls": {},
        })
        key = Q._clean(record.get("id"))
        entry["ids"].add(key)
        brand = Q._clean(record.get("brand_norm"))
        entry["by_brand"][brand].add(key)
        entry["brand_observations"][brand] += 1
        entry["values"][raw] += 1
        entry["urls"].setdefault(key, (record.get("source") or {}).get("url", ""))
    return lexicon


def build_duplicate_verdicts(duplicates: Iterable[Q.DuplicateCandidate]) -> dict[str, str]:
    """상품 키 → 그 상품이 참여한 중복 쌍 중 가장 높은 판정 등급."""
    best: dict[str, str] = {}
    for dup in duplicates:
        for key, verdict in ((dup.left_key, dup.verdict), (dup.right_key, dup.verdict)):
            if _VERDICT_RANK.get(verdict, 0) > _VERDICT_RANK.get(best.get(key, ""), 0):
                best[key] = verdict
    return best


def measure(
    record: Mapping[str, Any],
    candidate_value: str,
    lexicon: Mapping[str, Mapping[str, Any]],
    duplicate_verdict: str,
) -> Verification:
    """검토 후보 1건에 대한 실측 지표. 승격 여부는 여기서 결정하지 않는다."""
    out = Verification(duplicate_verdict=duplicate_verdict)
    if not candidate_value or Q.is_placeholder(candidate_value):
        out.rationale = "비교할 후보 값 없음"
        out.priority = "4"
        return out
    compact = N.model_compact(candidate_value)
    entry = lexicon.get(compact)
    brand = Q._clean(record.get("brand_norm"))
    self_key = Q._clean(record.get("id"))
    if entry:
        same_ids = {i for i in entry["by_brand"].get(brand, set()) if i != self_key}
        out.attest_ids = len(same_ids)
        out.attest_observations = entry["brand_observations"].get(brand, 0)
        out.attest_value = entry["values"].most_common(1)[0][0] if entry["values"] else candidate_value
        out.other_brand_hits = len({b for b in entry["by_brand"] if b != brand})
        if same_ids:
            out.attest_sample_url = entry["urls"].get(sorted(same_ids)[0], "")
    english = Q.spec_value(record, "영문상품명")
    derived = N.extract_model_phrase(Q._clean(record.get("name")), record.get("brand") or brand)
    out.english_matches_derived = bool(
        english and derived and N.model_compact(english) == N.model_compact(derived)
    )
    if out.attest_ids >= REQUIRED_INDEPENDENT_IDS:
        out.priority = "1"
        out.rationale = (f"같은 브랜드 '{brand}' 의 명시 모델명 스펙행에서 독립 원본 ID "
                         f"{out.attest_ids}건 실측 → 승격 기준(2건) 충족")
    elif out.attest_ids == 1:
        out.priority = "1"
        out.rationale = "실측 1건 — 승격 기준(독립 2건) 미달, 원본 화면 확인"
    elif out.english_matches_derived:
        out.priority = "2"
        out.rationale = "영문상품명과 상품명 파생 표현 일치. 어휘 실측은 없어 확정 불가"
    elif out.duplicate_verdict in ("probable", "candidate"):
        out.priority = "3"
        out.rationale = f"상대 공급처 {out.duplicate_verdict} 중복 판정 보유 — 짝 확인 후 결정"
    else:
        out.priority = "4"
        out.rationale = "교차 실측·일치·중복 링크 없음"
    return out


# --------------------------------------------------------------------------
# Stage 2 적용
# --------------------------------------------------------------------------


def _brand_attestation(
    record: Mapping[str, Any],
    lexicon: Mapping[str, Mapping[str, Any]],
    models_by_brand: Mapping[str, set[str]],
) -> tuple[str, int]:
    """브랜드 자리표시자 상품에 대해 모델명 어휘가 가리키는 단일 브랜드와 건수를 돌려준다."""
    value = Q._clean(record.get("model")) or N.extract_model_phrase(
        Q._clean(record.get("name")), None)
    if not value:
        return "", 0
    brands = models_by_brand.get(N.model_compact(value) or "", set())
    real = {b for b in brands if b and not Q.is_placeholder(b)}
    if len(real) == 1:
        only = next(iter(real))
        return only, len(lexicon.get(N.model_compact(value), {}).get("ids", ()))
    return "", 0


def apply(
    result: Q.QualityResult,
    records: Sequence[Mapping[str, Any]],
) -> Stage2Result:
    """result를 제자리에서 갱신한다. 원본 레코드(records)는 읽기 전용."""
    lexicon = build_model_lexicon(records)
    by_key = {Q._clean(r.get("id")): r for r in records}
    verdicts = build_duplicate_verdicts(result.duplicates)
    models_by_brand: dict[str, set[str]] = defaultdict(set)
    for record in records:
        raw = Q._clean(record.get("model"))
        if raw and not Q.is_placeholder(raw):
            models_by_brand[N.model_compact(raw) or ""].add(Q._clean(record.get("brand_norm")))

    improved_by_key = {Q._clean(r.get("id")): r for r in result.improved}
    stage2 = Stage2Result()
    stats = Counter()

    for patch in result.patches:
        record = by_key.get(patch.product_key)
        if record is None:
            continue
        if patch.field == "model":
            if patch.classification != Q.CLASS_REVIEW:
                # Stage 1에서 이미 auto(원본값 보유 / confirmed 승계)이거나 근거없음인 행은 검증 대상이 아니다.
                verification = Verification(
                    duplicate_verdict=verdicts.get(patch.product_key, ""),
                    priority="",
                    rationale="Stage 1 자동 확정 — 검증 대상 아님"
                    if patch.classification == Q.CLASS_AUTO else "근거없음 — 검증 대상 아님",
                )
            else:
                verification = measure(record, patch.proposed, lexicon, verdicts.get(patch.product_key, ""))
                if verification.attest_ids >= REQUIRED_INDEPENDENT_IDS:
                    candidate = patch.proposed
                    verification.promoted = True
                    verification.candidate = candidate
                    patch.classification = Q.CLASS_AUTO
                    patch.evidence_type = "multi_source_attestation"
                    # 승격 표기는 후보 문자열이 아니라 원본 스펙행에서 실측된 표기로 쓴다.
                    if verification.attest_value:
                        patch.proposed = verification.attest_value
                    patch.evidence = (f"같은 브랜드 '{Q._clean(record.get('brand_norm'))}' 의 명시 모델명 스펙행에서 "
                                      f"독립 원본 ID {verification.attest_ids}건이 '{verification.attest_value}' 로 실측")
                    patch.evidence_url = verification.attest_sample_url or patch.evidence_url
                    patch.confidence = 0.8 if verification.attest_ids >= 3 else 0.7
                    patch.reason = f"Stage 2 자동 승격 (기준 {REQUIRED_INDEPENDENT_IDS}건 이상)"
                    stage2.promoted.append(patch.product_key)
                    stage2.promotions.append(
                        {
                            "id": patch.product_key,
                            "source_site": patch.site,
                            "source_product_id": patch.source_product_id,
                            "name": patch.product_name,
                            "brand_norm": Q._clean(record.get("brand_norm")),
                            "model_before": patch.before,
                            "candidate": candidate,
                            "model_after": patch.proposed,
                            "attest_value": verification.attest_value,
                            "attest_independent_ids": verification.attest_ids,
                            "attest_observations": verification.attest_observations,
                            "confidence": patch.confidence,
                            "evidence": patch.evidence,
                            "evidence_url": patch.evidence_url,
                        }
                    )
                    stats["promoted"] += 1
                else:
                    stats["model_review_remaining"] += 1
                    stats[f"model_priority_{verification.priority}"] += 1
            stage2.verification[(patch.product_key, "model")] = verification
            _write_back(patch, verification, improved_by_key.get(patch.product_key))
        elif patch.field == "brand":
            verification = Verification(duplicate_verdict=verdicts.get(patch.product_key, ""), priority="")
            if patch.classification == Q.CLASS_REVIEW:
                proposed_brand, hits = _brand_attestation(record, lexicon, models_by_brand)
                verification.priority = "4"
                verification.rationale = "브랜드 실측 링크 없음"
                stats["brand_review_remaining"] += 1
                if proposed_brand:
                    # 결정 3-B: 자동 변경하지 않고 우선검토로만 표시한다.
                    patch.proposed = proposed_brand
                    patch.evidence_type = "model_lexicon_brand_attestation"
                    patch.evidence = (f"모델명 어휘가 단일 브랜드 '{proposed_brand}' 로 {hits}건 실측. "
                                      f"원본 표기 '{patch.before}' 는 유지")
                    patch.confidence = 0.5
                    patch.reason = "우선검토(자동 변경 없음) — 제안 브랜드만 제시"
                    verification.priority = "1"
                    verification.rationale = f"모델명 어휘가 '{proposed_brand}' 단 1 브랜드로만 실측({hits}건)"
                    verification.attest_ids = hits
                    verification.attest_value = proposed_brand
                    stats["brand_proposed_priority"] += 1
                    stats["brand_review_remaining"] -= 1
            stage2.verification[(patch.product_key, "brand")] = verification
            _write_back(patch, verification, improved_by_key.get(patch.product_key))
        else:  # manufacturer: Stage 2 승격 근거 없음(실측 0) — 지표만 부기
            verification = Verification(duplicate_verdict=verdicts.get(patch.product_key, ""), priority="")
            if patch.classification == Q.CLASS_REVIEW:
                verification.priority = "4"
                verification.rationale = "제조사 교차 실측 근거 0건 (브랜드↔제조사 별칭·어휘 링크 없음) — 현행 검토 유지"
                stats["manufacturer_review_remaining"] += 1
            stage2.verification[(patch.product_key, "manufacturer")] = verification
            _write_back(patch, verification, improved_by_key.get(patch.product_key))

    stage2.stats = build_stage2_stats(result, stage2, stats)
    return stage2


def _write_back(
    patch: Q.Patch,
    verification: Verification,
    improved: Mapping[str, Any] | None,
) -> None:
    """승격 결과를 패치 레이어(_after)와 플래그에 반영. 원본 record 는 건드리지 않는다."""
    if improved is None:
        return
    field_name = patch.field
    if field_name == "model" and verification.promoted:
        improved["model_after"] = patch.proposed
        improved["changed_fields"] = sorted(set(improved["changed_fields"]) | {"model"})
        improved["quality_flags"] = sorted(
            set(f for f in improved["quality_flags"] if f != "model_review") | {"model_stage2_promoted"}
        )
        improved["patches"]["model"] = Q.patch_public(patch)
    if verification.priority or verification.promoted:
        improved.setdefault("verification", {})[field_name] = {
            "attest_independent_ids": verification.attest_ids,
            "attest_value": verification.attest_value,
            "other_brand_hits": verification.other_brand_hits,
            "english_matches_derived": verification.english_matches_derived,
            "duplicate_verdict": verification.duplicate_verdict,
            "priority": verification.priority,
            "priority_label": PRIORITY_LABELS.get(verification.priority, ""),
            "promoted_by_stage2": verification.promoted,
        }


def build_stage2_stats(
    result: Q.QualityResult,
    stage2: "Stage2Result",
    counters: Counter,
) -> dict[str, Any]:
    model_promoted = len(stage2.promoted)
    missing_model_after = sum(1 for r in result.improved if not r["model_after"])
    missing_model_stage1 = result.summary.get("missing_after", {}).get("model")
    review_total_stage1 = result.summary.get("review_required_total")
    review_total_after = sum(
        1 for p in result.patches if p.actionable and p.classification == Q.CLASS_REVIEW
    )
    priorities: dict[str, int] = {}
    for (key, fld), ver in stage2.verification.items():
        if fld != "model":
            continue
        if ver.promoted:
            priorities["promoted"] = priorities.get("promoted", 0) + 1
        elif ver.priority:
            priorities[ver.priority] = priorities.get(ver.priority, 0) + 1
    return {
        "stage2_version": STAGE2_VERSION,
        "rule": f"같은 브랜드의 명시 모델명 스펙행에서 독립 원본 ID {REQUIRED_INDEPENDENT_IDS}건 이상 실측 시 승격",
        "auto_promoted_model": model_promoted,
        "auto_promoted_manufacturer": 0,
        "auto_promoted_brand": 0,
        "model_missing_after_stage1": missing_model_stage1,
        "model_missing_after_stage2": missing_model_after,
        "review_priority_remaining": dict(sorted(priorities.items())),
        "brand_placeholder_proposed_only": counters.get("brand_proposed_priority", 0),
        "brand_placeholder_remaining": counters.get("brand_review_remaining", 0),
        "manufacturer_review_remaining": counters.get("manufacturer_review_remaining", 0),
        "independent_evidence_definition": "원본 ID(site:product_id) 단위로 중복 제거한 관찰",
        "change_history": [
            "Stage 1 검토 {a}건 → Stage 2 승격 {p}건 → 남은 검토 {b}건".format(
                a=review_total_stage1, p=model_promoted, b=review_total_after),
            f"schema_version {Q.SCHEMA_VERSION} → {STAGE2_VERSION}",
            f"모델명 미확정 {missing_model_stage1} → {missing_model_after}건",
            "브랜드 자리표시자 중 어휘 실증 {a}건은 우선검토(P1) 표시만 하고 원본 표기를 유지했다".format(
                a=counters.get("brand_proposed_priority", 0)),
            "제조사 검토 {a}건은 교차 실측 근거 0건으로 현행 유지".format(
                a=counters.get("manufacturer_review_remaining", 0)),
        ],
        "original_master_modified": False,
        "new_scraping_performed": False,
    }
