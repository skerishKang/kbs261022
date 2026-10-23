"""이슈 #43 상품 DB 품질 개선 — 규칙 엔진.

``tools/product_master`` (이슈 #8) 의 원칙을 그대로 따른다.

1. 원천에 없는 값은 채우지 않는다.
2. 제조사 / 브랜드 / 모델명은 서로 다른 필드로 유지한다.
3. 확신 부족한 중복·보완은 자동 적용하지 않고 검토 후보로 분리한다.
4. 판매가 / 원가 / 재고 / 공급권한은 이 모듈의 대상이 아니다 (전달만 한다).

``products.json`` 원본은 읽기 전용이며, 이 모듈이 내보내는 것은 **패치 레이어**다.
"""

from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Optional, Sequence

from tools.product_master import normalize as N

SCHEMA_VERSION = "1.0.0"

#: 원본 마스터 (읽기 전용) — LOCAL2 정본. 덮어쓰지 않는다.
MASTER_PATH = "site/data/products.json"
#: 이슈 #8 정본 DB. 중복 판정(confirmed/probable/candidate)과 필드 근거를 재사용한다.
AUTHORITATIVE_XLSX = "data/full_catalog/product_db.xlsx"

SITE_BY_LABEL = {"삼아사운드": "samasound.co.kr", "삼아스토어": "samamusic.co.kr"}
LABEL_BY_SITE = {v: k for k, v in SITE_BY_LABEL.items()}

#: 출처 값으로 존재하지 않는 자리표시자. 자동 보완에 사용하지 않는다.
PLACEHOLDERS: frozenset[str] = frozenset(
    {
        "",
        "-",
        "없음",
        "미정",
        "unknown",
        "n/a",
        "nnnn",
        "자체브랜드",
        "자체제작",
        "기타",
        "temp",
    }
)

CLASS_AUTO = "auto_confirmed"
CLASS_REVIEW = "review_required"
CLASS_NONE = "no_evidence"

FIELD_CLASSIFIER_ORDER: tuple[str, ...] = (CLASS_AUTO, CLASS_REVIEW, CLASS_NONE)


def _clean(value: Any) -> str:
    text = N.normalize_text(value)
    return "" if text in ("None", "null") else text


def is_placeholder(value: Any) -> bool:
    return _clean(value).casefold() in PLACEHOLDERS


def spec_value(record: Mapping[str, Any], label: str) -> str:
    """원본 스펙행(화면 표기) 값. 근거로 쓰는 값은 항상 여기서 나온다."""
    for row in record.get("specs") or []:
        if _clean(row.get("label")) == label:
            return _clean(row.get("value"))
    return ""


# --------------------------------------------------------------------------
# 패치 / 결과 자료 구조
# --------------------------------------------------------------------------


@dataclass
class Patch:
    """필드 1건에 대한 보완 제안. 원본에는 손대지 않는다."""

    product_key: str
    site: str
    source_product_id: str
    product_name: str
    field: str  # model | manufacturer
    before: str
    proposed: str
    classification: str
    evidence_type: str
    evidence: str
    evidence_url: str
    confidence: float
    reason: str
    duplicate_ref: str = ""

    @property
    def actionable(self) -> bool:
        """원본 값이 이미 온당하면 조치 대상이 아니다 (재적용·재검토 대상에서 제외)."""
        return not (self.classification == CLASS_AUTO and self.proposed == self.before)

    def to_row(self) -> dict[str, Any]:
        return {
            "통합키": self.product_key,
            "공급처": self.site,
            "공급처표시": LABEL_BY_SITE.get(self.site, self.site),
            "원본ID": self.source_product_id,
            "상품명": self.product_name,
            "필드": self.field,
            "보완전": self.before,
            "제안값": self.proposed,
            "분류": self.classification,
            "근거유형": self.evidence_type,
            "근거": self.evidence,
            "근거URL": self.evidence_url,
            "신뢰도": f"{self.confidence:.2f}",
            "사유": self.reason,
            "중복참조": self.duplicate_ref,
        }


@dataclass
class DuplicateCandidate:
    """중복 후보 1쌍. 자동 병합 여부는 이슈 #8 판정을 재사용한다."""

    verdict: str
    auto_mergeable: bool
    left_key: str
    left_name: str
    left_brand: str
    left_model: str
    right_key: str
    right_name: str
    right_brand: str
    right_model: str
    shared_phrase: str
    name_similarity: str
    variant_conflict: str
    brand_agreement: str
    reason: str
    origin: str  # issue8_master | same_site_exact
    resolution: str = "검토 대기"  # 원본 보존: 병합 수행하지 않음

    def to_row(self) -> dict[str, Any]:
        return {
            "판정": self.verdict,
            "자동병합가능": "예" if self.auto_mergeable else "아니오",
            "출처": self.origin,
            "왼쪽통합키": self.left_key,
            "왼쪽상품명": self.left_name,
            "왼쪽브랜드": self.left_brand,
            "왼쪽모델명": self.left_model,
            "오른쪽통합키": self.right_key,
            "오른쪽상품명": self.right_name,
            "오른쪽브랜드": self.right_brand,
            "오른쪽모델명": self.right_model,
            "공통모델표현": self.shared_phrase,
            "이름유사도": self.name_similarity,
            "변형충돌": self.variant_conflict,
            "브랜드값일치": self.brand_agreement,
            "사유": self.reason,
            "조치": self.resolution,
        }


# --------------------------------------------------------------------------
# 규칙 1 — 제조사: 다른 공급처의 명시적 ``제조사`` 스펙행 실측 재사용
# --------------------------------------------------------------------------


def build_manufacturer_evidence(
    records: Sequence[Mapping[str, Any]],
) -> dict[str, dict[str, Any]]:
    """브랜드(정규) → 원본 ``제조사`` 스펙행에서 실측한 제조사 값.

    한 브랜드에 제조사 값이 **유일**할 때만 자동 근거로 쓴다. 값이 여러 개면
    검토 후보로 강등한다 (브랜드 하위에 복수 제조사가 있는 경우 등).
    """
    observed: dict[str, dict[str, dict[str, Any]]] = {}
    for record in records:
        raw = spec_value(record, "제조사")
        if not raw or is_placeholder(raw):
            continue
        brand = _clean(record.get("brand_norm")) or _clean(record.get("brand")).upper()
        if not brand or is_placeholder(brand):
            continue
        bucket = observed.setdefault(brand, {})
        entry = bucket.setdefault(raw, {"count": 0, "url": "", "product_key": ""})
        entry["count"] += 1
        if not entry["url"]:
            entry["url"] = (record.get("source") or {}).get("url", "")
            entry["product_key"] = _clean(record.get("id"))
    out: dict[str, dict[str, Any]] = {}
    for brand, values in observed.items():
        distinct = sorted(values, key=lambda v: -values[v]["count"])
        out[brand] = {
            "brand": brand,
            "candidates": distinct,
            "unique": len(distinct) == 1,
            "values": values,
        }
    return out


def manufacturer_patch(
    record: Mapping[str, Any],
    evidence: Mapping[str, Mapping[str, Any]],
) -> Patch:
    brand = _clean(record.get("brand_norm")) or _clean(record.get("brand")).upper()
    before = _clean(record.get("manufacturer"))
    key = _clean(record.get("id"))
    site = (record.get("source") or {}).get("site", "")
    name = _clean(record.get("name"))
    base = dict(
        product_key=key,
        site=site,
        source_product_id=_clean((record.get("source") or {}).get("product_id")),
        product_name=name,
        field="manufacturer",
        before=before,
    )
    if before and not is_placeholder(before):
        return Patch(**base, proposed=before, classification=CLASS_AUTO,
                    evidence_type="source_spec", evidence=f"제조사 스펙행: {before}",
                    evidence_url=(record.get("source") or {}).get("url", ""),
                    confidence=1.0, reason="이미 원본 값을 보유 (변경 없음)")

    entry = evidence.get(brand)
    if before:
        # 값은 있으나 '자체제작' 등 자리표시자 → 실제 제조사 확인이 필요한 검토 대상.
        if entry and entry["unique"] and not is_placeholder(entry["candidates"][0]):
            value = entry["candidates"][0]
            hits = entry["values"][value]
            return Patch(**base, proposed=value, classification=CLASS_AUTO,
                         evidence_type="placeholder_replacement",
                         evidence=f"'{before}' 표기를 같은 브랜드 '{brand}' 의 제조사 스펙행 실측 "
                                  f"{hits['count']}건 값 '{value}' 로 대체",
                         evidence_url=hits["url"], confidence=0.85,
                         reason="원본 값이 자리표시자이고 실측 대체 값이 유일 → 자동 보완")
        return Patch(**base, proposed=before, classification=CLASS_REVIEW,
                     evidence_type="placeholder_existing_value",
                     evidence=f"원본 제조사 표기 '{before}' 는 자리표시자 (브랜드 표기도 원천 없음)",
                     evidence_url=(record.get("source") or {}).get("url", ""),
                     confidence=0.2, reason="값은 있으나 실제 제조사가 아님 → 공급처 화면 확인 필요")
    if entry and entry["unique"] and not is_placeholder(entry["candidates"][0]):
        value = entry["candidates"][0]
        hits = entry["values"][value]
        return Patch(**base, proposed=value, classification=CLASS_AUTO,
                     evidence_type="cross_site_source_spec",
                     evidence=f"동일 브랜드 '{brand}' 의 제조사 스펙행 실측 {hits['count']}건, 관찰 값 1종",
                     evidence_url=hits["url"], confidence=0.9,
                     reason="원천 명시 제조사 값이 유일하게 관찰됨 → 자동 보완")
    if entry:
        values = ", ".join(entry["candidates"])
        return Patch(**base, proposed=entry["candidates"][0], classification=CLASS_REVIEW,
                     evidence_type="cross_site_source_spec_ambiguous",
                     evidence=f"동일 브랜드에서 제조사 값 {len(entry['candidates'])}종 관찰: {values}",
                     evidence_url=entry["values"][entry["candidates"][0]]["url"],
                     confidence=0.4, reason="제조사 값이 복수 → 사람이 공급처 확인 필요")
    suggestion = _clean(record.get("brand"))
    if suggestion and not is_placeholder(suggestion):
        return Patch(**base, proposed=suggestion, classification=CLASS_REVIEW,
                     evidence_type="brand_identity_assumption",
                     evidence=f"원본 제조사 스펙행 없음. 브랜드 표기 '{suggestion}' 만 근거로 존재",
                     evidence_url=(record.get("source") or {}).get("url", ""),
                     confidence=0.3, reason="브랜드=제조사 가정은 검증 필요 → 검토 후보")
    return Patch(**base, proposed="", classification=CLASS_NONE,
                 evidence_type="none", evidence="브랜드·제조사 원본 표기 없음",
                 evidence_url=(record.get("source") or {}).get("url", ""),
                 confidence=0.0, reason="근거 없음 → 원본 공백 유지")


# --------------------------------------------------------------------------
# 규칙 2 — 모델명: 명시 스펙행 > confirmed 중복 승계 > 파생 후보
# --------------------------------------------------------------------------


def model_patch(
    record: Mapping[str, Any],
    inheritance: Mapping[str, Mapping[str, Any]],
    inherit_conflicts: Sequence[str] = (),
) -> Patch:
    before = _clean(record.get("model"))
    key = _clean(record.get("id"))
    site = (record.get("source") or {}).get("site", "")
    url = (record.get("source") or {}).get("url", "")
    name = _clean(record.get("name"))
    base = dict(
        product_key=key,
        site=site,
        source_product_id=_clean((record.get("source") or {}).get("product_id")),
        product_name=name,
        field="model",
        before=before,
    )
    if before and not is_placeholder(before):
        return Patch(**base, proposed=before, classification=CLASS_AUTO,
                     evidence_type="source_spec", evidence=f"모델명 스펙행: {before}",
                     evidence_url=url, confidence=1.0, reason="이미 원본 값을 보유 (변경 없음)")

    inherited = inheritance.get(key)
    if inherited:
        return Patch(**base, proposed=inherited["model"], classification=CLASS_AUTO,
                     evidence_type="confirmed_duplicate_inheritance",
                     evidence=(f"이슈 #8 중복 판정 confirmed 인 동상품 "
                               f"{inherited['peer_key']}(원천 모델명 '{inherited['model']}')"),
                     evidence_url=inherited["peer_url"], confidence=0.85,
                     reason="confirmed 동일 상품 승계 → 자동 보완",
                     duplicate_ref=inherited["peer_key"])

    if key in inherit_conflicts:
        return Patch(**base, proposed="", classification=CLASS_REVIEW,
                     evidence_type="confirmed_duplicate_model_conflict",
                     evidence="confirmed 중복 쌍의 상대방에서 서로 다른 모델명 2종 이상 관찰",
                     evidence_url=url, confidence=0.3,
                     reason="자동 승계 불가 → 사람이 어느 모델명이 맞는지 확인")

    english = spec_value(record, "영문상품명")
    if english and not is_placeholder(english):
        return Patch(**base, proposed=english, classification=CLASS_REVIEW,
                     evidence_type="source_spec_english_name",
                     evidence=f"영문상품명 스펙행: {english}",
                     evidence_url=url, confidence=0.5,
                     reason="이슈 #8 정책상 영문상품명은 원본 증거로만 보존. 모델명 등재 여부 판단 필요")

    derived = N.extract_model_phrase(name, record.get("brand") or record.get("brand_norm"))
    if derived and not is_placeholder(derived):
        return Patch(**base, proposed=derived, classification=CLASS_REVIEW,
                     evidence_type="derived_from_product_name",
                     evidence=f"상품명 파생 모델 표현: {derived}",
                     evidence_url=url, confidence=0.35,
                     reason="원천 모델명 스펙행 없음. 파생 값은 사람이 화면 대조 후 확정")

    return Patch(**base, proposed="", classification=CLASS_NONE,
                 evidence_type="none", evidence="모델명 원본 표기·파생 후보 없음",
                 evidence_url=url, confidence=0.0, reason="근거 없음 → 원본 공백 유지")


# --------------------------------------------------------------------------
# 규칙 3 — 브랜드: 원천 표기 유무만 점검한다 (추정 생성 금지)
# --------------------------------------------------------------------------


def brand_patch(record: Mapping[str, Any]) -> Patch:
    before = _clean(record.get("brand"))
    base = dict(
        product_key=_clean(record.get("id")),
        site=(record.get("source") or {}).get("site", ""),
        source_product_id=_clean((record.get("source") or {}).get("product_id")),
        product_name=_clean(record.get("name")),
        field="brand",
        before=before,
    )
    url = (record.get("source") or {}).get("url", "")
    if before and not is_placeholder(before):
        spec_basis = "브랜드 스펙행" if spec_value(record, "브랜드") else "카테고리 표기"
        return Patch(**base, proposed=before, classification=CLASS_AUTO,
                     evidence_type="source_spec" if spec_value(record, "브랜드") else "category_label",
                     evidence=f"{spec_basis}: {before}", evidence_url=url,
                     confidence=1.0, reason="이미 원본 값을 보유 (변경 없음)")
    if before:
        return Patch(**base, proposed=before, classification=CLASS_REVIEW,
                     evidence_type="placeholder_existing_value",
                     evidence=f"브랜드 표기 '{before}' 는 자리표시자", evidence_url=url,
                     confidence=0.2, reason="자리표시자 → 실 브랜드 확인 필요")
    return Patch(**base, proposed="", classification=CLASS_NONE,
                 evidence_type="none", evidence="브랜드 원본 표기 없음", evidence_url=url,
                 confidence=0.0, reason="근거 없음 → 원본 공백 유지")


# --------------------------------------------------------------------------
# 규칙 4 — 중복: 정본 판정 재사용 + 같은 사이트 완전 일치
# --------------------------------------------------------------------------


def same_site_duplicates(records: Sequence[Mapping[str, Any]]) -> list[DuplicateCandidate]:
    """같은 사이트에서 (브랜드, 정규화 상품명) 이 완전히 같은 별개 원본ID 상품."""
    buckets: dict[tuple[str, str], list[Mapping[str, Any]]] = {}
    for record in records:
        brand = _clean(record.get("brand_norm"))
        name = _clean(N.normalize_name(record.get("name")))
        if is_placeholder(brand) or not name:
            continue
        site = (record.get("source") or {}).get("site", "")
        buckets.setdefault((site, brand + "|" + name.upper()), []).append(record)
    out: list[DuplicateCandidate] = []
    for (site, _), group in sorted(buckets.items()):
        if len(group) < 2:
            continue
        group.sort(key=lambda r: _clean(r.get("id")))
        anchor = group[0]
        for other in group[1:]:
            out.append(
                DuplicateCandidate(
                    verdict="same_site_exact",
                    auto_mergeable=False,
                    left_key=_clean(anchor.get("id")),
                    left_name=_clean(anchor.get("name")),
                    left_brand=_clean(anchor.get("brand")),
                    left_model=_clean(anchor.get("model")),
                    right_key=_clean(other.get("id")),
                    right_name=_clean(other.get("name")),
                    right_brand=_clean(other.get("brand")),
                    right_model=_clean(other.get("model")),
                    shared_phrase=N.model_compact(_clean(anchor.get("name"))) or "",
                    name_similarity="1.0",
                    variant_conflict="아니오",
                    brand_agreement="예",
                    reason=f"{site} 에서 브랜드+상품명 완전 일치 {len(group)}건. "
                           "별개 원본ID = 등록 중복 또는 색상/사양 차이, 원본 보존하므로 병합 안 함",
                    origin="same_site_exact",
                )
            )
    return out


# --------------------------------------------------------------------------
# 개선 레이어 assembly
# --------------------------------------------------------------------------


@dataclass
class QualityResult:
    generated_at: str
    master_count: int
    patches: list[Patch] = field(default_factory=list)
    duplicates: list[DuplicateCandidate] = field(default_factory=list)
    improved: list[dict[str, Any]] = field(default_factory=list)
    inherit_conflicts: list[str] = field(default_factory=list)
    summary: dict[str, Any] = field(default_factory=dict)


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_inheritance(
    records: Sequence[Mapping[str, Any]],
    confirmed_pairs: Iterable[Mapping[str, Any]],
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    """confirmed 중복 쌍에서 명시적 모델명이 있는 쪽 → 없는 쪽 승계 지도.

    서로 다른 모델명 두 개가 같은 상품에 걸리면 확신할 수 없으므로 승계하지
    않고 conflicts 로 돌려 검토 후보로 남긴다 (이슈 #8 규칙: 확신 부족한 자동화 금지).
    """
    by_key = {_clean(r.get("id")): r for r in records}
    gathered: dict[str, list[dict[str, Any]]] = {}
    for pair in confirmed_pairs:
        lr = by_key.get(_clean(pair.get("left_key")))
        rr = by_key.get(_clean(pair.get("right_key")))
        if not lr or not rr:
            continue
        for holder, peer in ((lr, rr), (rr, lr)):
            model = _clean(holder.get("model"))
            if not model or is_placeholder(model):
                continue
            peer_model = _clean(peer.get("model"))
            if peer_model and not is_placeholder(peer_model):
                continue
            gathered.setdefault(_clean(peer.get("id")), []).append(
                {
                    "model": model,
                    "peer_key": _clean(holder.get("id")),
                    "peer_url": (holder.get("source") or {}).get("url", ""),
                    "shared_phrase": _clean(pair.get("shared_phrase")),
                }
            )
    out: dict[str, dict[str, Any]] = {}
    conflicts: list[str] = []
    for peer_key, claims in gathered.items():
        distinct = {c["model"] for c in claims}
        if len(distinct) == 1:
            out[peer_key] = claims[0]
        else:
            conflicts.append(peer_key)
    return out, conflicts


def build_result(
    records: Sequence[Mapping[str, Any]],
    confirmed_pairs: Sequence[Mapping[str, Any]],
    master_pairs: Sequence[DuplicateCandidate],
) -> QualityResult:
    mfr_evidence = build_manufacturer_evidence(records)
    inheritance, inherit_conflicts = build_inheritance(records, confirmed_pairs)

    patches: list[Patch] = []
    improved: list[dict[str, Any]] = []
    for record in records:
        mp = manufacturer_patch(record, mfr_evidence)
        vp = model_patch(record, inheritance, inherit_conflicts)
        bp = brand_patch(record)
        patches.extend([mp, vp, bp])
        applied = {p.field: p for p in (mp, vp, bp) if p.classification == CLASS_AUTO
                   and p.proposed and p.proposed != p.before}
        improved.append(improve_record(record, mp, vp, bp, applied))

    duplicates = list(master_pairs) + same_site_duplicates(records)
    result = QualityResult(
        generated_at=_now_iso(),
        master_count=len(records),
        patches=patches,
        duplicates=duplicates,
        improved=improved,
        inherit_conflicts=sorted(inherit_conflicts),
    )
    result.summary = summarize(result)
    return result


def improve_record(
    record: Mapping[str, Any],
    mp: Patch,
    vp: Patch,
    bp: Patch,
    applied: Mapping[str, Patch],
) -> dict[str, Any]:
    source = record.get("source") or {}
    category = record.get("category") or {}
    price = record.get("price") or {}
    flags: list[str] = []
    for patch in (mp, vp, bp):
        if patch.classification == CLASS_REVIEW:
            flags.append(f"{patch.field}_review")
        if patch.classification == CLASS_NONE:
            flags.append(f"{patch.field}_no_evidence")
        if patch.evidence_type in ("placeholder_existing_value", "placeholder_replacement"):
            flags.append(f"{patch.field}_placeholder")
    return {
        "id": record.get("id"),
        "source_site": source.get("site"),
        "source_site_label": source.get("site_label"),
        "source_product_id": source.get("product_id"),
        "name": record.get("name"),
        "brand": record.get("brand"),
        "brand_norm": record.get("brand_norm"),
        "brand_basis": "source_spec" if spec_value(record, "브랜드") else "category",
        "manufacturer_before": mp.before,
        "manufacturer_after": applied.get("manufacturer").proposed if "manufacturer" in applied else mp.before,
        "model_before": vp.before,
        "model_after": applied.get("model").proposed if "model" in applied else vp.before,
        "category_name": category.get("name"),
        "category_id": category.get("id"),
        "category_path_ref": "site/data/products.json category_path",
        "source_url": source.get("url"),
        "list_url": source.get("list_url"),
        "image_count": len(record.get("images") or []),
        "price_original": price.get("value"),
        "price_state_original": price.get("state"),
        "quality_flags": flags,
        "patches": {
            "manufacturer": patch_public(mp),
            "model": patch_public(vp),
        },
        "patch_detail_ref": "product_quality_patch_candidates.csv (통합키+필드로 조인)",
        "changed_fields": sorted(applied.keys()),
    }


def patch_public(patch: Patch, full: bool = False) -> dict[str, Any]:
    """패치 제안 요약. 긴 근거 본문은 CSV/XLSX 에 있고 JSON 에는 참조만 남긴다."""
    out = {
        "classification": patch.classification,
        "proposed": patch.proposed,
        "evidence_type": patch.evidence_type,
        "evidence_url": patch.evidence_url,
        "confidence": round(patch.confidence, 2),
    }
    if full:
        out["evidence"] = patch.evidence
        out["reason"] = patch.reason
        out["duplicate_ref"] = patch.duplicate_ref
    return out


def summarize(result: QualityResult) -> dict[str, Any]:
    actionable = [p for p in result.patches if p.actionable]

    def bucket(field_name: str, classification: str) -> int:
        return sum(1 for p in actionable if p.field == field_name and p.classification == classification)

    already_ok = {
        field_name: sum(1 for p in result.patches
                        if p.field == field_name and not p.actionable)
        for field_name in ("model", "manufacturer", "brand")
    }
    placeholder_flagged = {
        field_name: sum(1 for p in result.patches
                        if p.field == field_name
                        and p.evidence_type in ("placeholder_existing_value", "placeholder_replacement"))
        for field_name in ("model", "manufacturer", "brand")
    }
    changed = sum(1 for r in result.improved if r["changed_fields"])
    records_with_change = {f: 0 for f in ("model", "manufacturer", "brand")}
    for record in result.improved:
        for f in records_with_change:
            if f in record["changed_fields"]:
                records_with_change[f] += 1
    verdicts: dict[str, int] = {}
    for dup in result.duplicates:
        verdicts[dup.verdict] = verdicts.get(dup.verdict, 0) + 1
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": result.generated_at,
        "original_products": result.master_count,
        "improved_products": len(result.improved),
        "missing_before": {
            "model": sum(1 for r in result.improved if not r["model_before"]),
            "manufacturer": sum(1 for r in result.improved if not r["manufacturer_before"]),
            "brand": sum(1 for r in result.improved if not _clean(r.get("brand"))),
        },
        "missing_after": {
            "model": sum(1 for r in result.improved if not r["model_after"]),
            "manufacturer": sum(1 for r in result.improved if not r["manufacturer_after"]),
            "brand": sum(1 for r in result.improved if not _clean(r.get("brand"))),
        },
        "auto_corrected_records": changed,
        "auto_corrected_fields": records_with_change,
        "patch_classification": {
            field_name: {c: bucket(field_name, c) for c in FIELD_CLASSIFIER_ORDER}
            for field_name in ("model", "manufacturer", "brand")
        },
        "patch_rows": {
            "total": len(result.patches),
            "actionable": len(actionable),
            "already_source_value": already_ok,
        },
        "placeholder_values_detected": placeholder_flagged,
        "review_required_total": sum(
            bucket(f, CLASS_REVIEW) for f in ("model", "manufacturer", "brand")
        ),
        "duplicate_candidates": {
            "total_pairs": len(result.duplicates),
            "by_verdict": verdicts,
            "auto_mergeable_pairs": sum(1 for d in result.duplicates if d.auto_mergeable),
            "model_inheritance_conflicts": len(result.inherit_conflicts),
            "affected_products": len(
                {d.left_key for d in result.duplicates} | {d.right_key for d in result.duplicates}
            ),
        },
        "policy": {
            "original_master_overwritten": False,
            "price_invented": False,
            "stock_invented": False,
            "wholesale_invented": False,
            "new_scraping_performed": False,
            "yamaha_673_recollected": False,
            "duplicates_merged": 0,
        },
    }
