"""브라우저 검증 샘플 ↔ HTTP 수집 결과 교차 검증 (issue #8 요구사항 8).

같은 ``(source_site, source_product_id)`` 에 대해 브라우저로 확인한 값과
HTTP 로 가져온 값이 실제로 일치하는지 필드 단위로 비교한다.

비교 대상 필드
--------------
``name`` / ``brand`` / ``manufacturer`` / ``model`` / ``public_price`` /
``public_price_text`` / ``canonical_url`` / ``price_type`` / ``category_leaf_cate_no``

주의
----
* 브라우저는 *렌더된* 화면, HTTP 는 *원본 HTML* 이다. 두 경로가 다르면
  어느 쪽이 옳은지는 이 모듈이 정하지 않는다. 불일치 목록을 그대로 낸다.
* 한쪽에만 존재하는 필드는 "불일치"가 아니라 "경로별 가용성 차이"로 분리한다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Sequence

from . import normalize as N

#: 값이 없을 수 있는 필드 (양쪽 다 없으면 일치로 본다).
NULLABLE_FIELDS = (
    "brand",
    "manufacturer",
    "model",
    "public_price",
)


@dataclass
class FieldComparison:
    field: str
    browser: Any
    http: Any
    status: str  # "match" | "mismatch" | "browser_only" | "http_only" | "both_null"
    detail: Optional[str] = None


@dataclass
class RecordComparison:
    source_key: str
    comparisons: list[FieldComparison] = field(default_factory=list)

    @property
    def mismatches(self) -> list[FieldComparison]:
        return [c for c in self.comparisons if c.status == "mismatch"]

    @property
    def ok(self) -> bool:
        return not self.mismatches

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_key": self.source_key,
            "ok": self.ok,
            "mismatch_count": len(self.mismatches),
            "comparisons": [
                {
                    "field": c.field,
                    "browser": c.browser,
                    "http": c.http,
                    "status": c.status,
                    "detail": c.detail,
                }
                for c in self.comparisons
            ],
        }


def _compare_field(name: str, left: Any, right: Any) -> FieldComparison:
    left_null = left is None or (isinstance(left, str) and not left.strip())
    right_null = right is None or (isinstance(right, str) and not right.strip())

    if left_null and right_null:
        return FieldComparison(name, left, right, "both_null")
    if left_null:
        return FieldComparison(name, left, right, "browser_only", "브라우저에서만 값이 있음")
    if right_null:
        return FieldComparison(name, left, right, "http_only", "HTTP 에서만 값이 있음")

    if name == "public_price":
        if int(left) == int(right):
            return FieldComparison(name, left, right, "match")
        return FieldComparison(name, left, right, "mismatch", "금액 불일치")

    if name in ("name", "public_price_text", "canonical_url", "category_leaf_cate_no"):
        if N.normalize_text(str(left)) == N.normalize_text(str(right)):
            return FieldComparison(name, left, right, "match")
        return FieldComparison(name, left, right, "mismatch", "문자열 불일치")

    if N.values_agree(str(left), str(right)):
        return FieldComparison(name, left, right, "match")
    return FieldComparison(name, left, right, "mismatch", "값 불일치")


def compare_records(
    browser_records: Sequence[Mapping[str, Any]],
    http_records: Sequence[Mapping[str, Any]],
) -> list[RecordComparison]:
    """브라우저 레코드와 HTTP 레코드를 ``source_key`` 로 맞춰 비교."""
    http_by_key = {r["source_key"]: r for r in http_records}
    out: list[RecordComparison] = []

    for browser in browser_records:
        key = browser["source_key"]
        http = http_by_key.get(key)
        if http is None:
            out.append(
                RecordComparison(
                    key,
                    [FieldComparison("__record__", key, None, "http_only", "HTTP 수집에 해당 상품 없음")],
                )
            )
            continue
        comparisons = [
            _compare_field("name", browser.get("name"), http.get("name")),
            _compare_field("brand", browser.get("brand"), http.get("brand")),
            _compare_field("manufacturer", browser.get("manufacturer"), http.get("manufacturer")),
            _compare_field("model", browser.get("model"), http.get("model")),
            _compare_field("public_price", browser.get("public_price"), http.get("public_price")),
            _compare_field(
                "public_price_text", browser.get("public_price_text"), http.get("public_price_text")
            ),
            _compare_field(
                "canonical_url", browser.get("canonical_url"), http.get("canonical_url")
            ),
            _compare_field(
                "category_leaf_cate_no",
                browser.get("category_leaf_cate_no"),
                http.get("category_leaf_cate_no"),
            ),
        ]
        out.append(RecordComparison(key, comparisons))
    return out


def summarize(comparisons: Sequence[RecordComparison]) -> dict[str, Any]:
    """교차 검증 요약."""
    total = len(comparisons)
    matched = sum(1 for c in comparisons if c.ok)
    field_status: dict[str, dict[str, int]] = {}
    for comparison in comparisons:
        for item in comparison.comparisons:
            bucket = field_status.setdefault(item.field, {})
            bucket[item.status] = bucket.get(item.status, 0) + 1
    return {
        "compared_records": total,
        "fully_matched_records": matched,
        "mismatched_records": total - matched,
        "match_rate": round(matched / total, 4) if total else 0.0,
        "field_status": field_status,
    }


def format_report(comparisons: Sequence[RecordComparison]) -> str:
    """사람이 읽을 수 있는 교차 검증 리포트."""
    summary = summarize(comparisons)
    lines = [
        "=== 브라우저 ↔ HTTP 교차 검증 ===",
        f"records={summary['compared_records']} matched={summary['fully_matched_records']} "
        f"mismatched={summary['mismatched_records']} rate={summary['match_rate']}",
        "",
    ]
    for comparison in comparisons:
        if comparison.ok:
            continue
        lines.append(f"[MISMATCH] {comparison.source_key}")
        for item in comparison.mismatches:
            lines.append(
                f"    {item.field}: browser={item.browser!r} http={item.http!r} ({item.detail})"
            )
    if summary["mismatched_records"] == 0:
        lines.append("RESULT=PASS  (모든 비교 레코드가 필드 단위로 일치)")
    else:
        lines.append("RESULT=FAIL")
    return "\n".join(lines)
