"""이슈 #43 Stage 3 — 검토후보 2,311건의 사람 검토 체계.

Stage 1이 원본 표기로 자동 보완하고, Stage 2가 교차 실측으로 40건을 승격시켰다.
여기서 남은 검토 후보는 **사람이 화면을 보고 승인·반려·보류**해야 확정된다.
이 모듈은 그 검토를 파일 하나로 운영하고, 결과를 기계가 검증할 수 있는 패치로 내보낸다.

불변 규칙
---------
- 원본 마스터(``site/data/products.json``)는 읽기 전용. 어떤 검토 확정도 원본을 덮어쓰지 않는다.
- 승인 없는 값은 확정되지 않는다. 제안값이 비어 있는 행(근거없음)은 승인할 수 없다.
- 중복 후보 1,353쌍은 판정 기록만 남긴다. **자동 병합은 항상 0건**이고 원본 ID는 전부 유효하다.
- 가격·재고·공급가격은 이 산출물에 절대 생성하지 않는다.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import os
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

from . import quality as Q
from . import verify_review as V

STAGE3_VERSION = "1.2.0"

#: 검토후보 행의 결정 어휘 (빈 값 = 미검토)
DECISIONS: tuple[str, ...] = ("승인", "반려", "보류")

#: 중복 후보 쌍의 판정 어휘 (빈 값 = 미판정). 그 어떤 값도 병합을 수행하지 않는다.
DUP_VERDICTS: tuple[str, ...] = ("동일상품", "별도상품", "보류")

FIELD_LABELS = {"model": "모델명", "manufacturer": "제조사", "brand": "브랜드"}

DECISION_COLUMNS = ("검토결정", "확정값", "검토자", "검토일", "비고")

_QUEUE_SHEET = "검토후보"
_DUP_SHEET = "중복후보판정"
_GUIDE_SHEET = "검토방법"

#: 확정값이 이 값들이면 근거 없는 입력으로 본다.
_EMPTYISH = ("", "-", "없음", "null", "none", "nnnn")


# --------------------------------------------------------------------------
# 행 지문 (검토 중 제안값이 슬쩍 바뀌었는지 잡는다)
# --------------------------------------------------------------------------


def row_fingerprint(product_key: str, fld: str, before: str, proposed: str, priority: str) -> str:
    seed = "\x1f".join((product_key, fld, before, proposed, priority))
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()[:12]


def review_id(product_key: str, fld: str) -> str:
    """재생성해도 같은 행은 같은 ID 를 쓴다 (정렬과 무관하게 안정적)."""
    seed = "\x1f".join((product_key, fld))
    return f"RV-{hashlib.sha256(seed.encode('utf-8')).hexdigest()[:10].upper()}"


def dup_review_id(left_key: str, right_key: str) -> str:
    seed = "\x1f".join(sorted((left_key, right_key)))
    return f"DP-{hashlib.sha256(seed.encode('utf-8')).hexdigest()[:10].upper()}"


# --------------------------------------------------------------------------
# 검토 대기열 구성
# --------------------------------------------------------------------------


def _priority_sort_key(row: Mapping[str, Any]) -> tuple[str, str, str]:
    return (str(row.get("우선순위") or "9"), str(row.get("필드") or ""), str(row.get("검토ID") or ""))


def build_review_rows(
    patches: Sequence[Q.Patch],
    verification: Mapping[tuple[str, str], V.Verification],
    records: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """review_required 행만, 우선순위 순서로, 근거·전후값·입력란을 갖춰 나열한다."""
    by_key = {Q._clean(r.get("id")): r for r in records}
    rows: list[dict[str, Any]] = []
    for patch in patches:
        if patch.classification != Q.CLASS_REVIEW:
            continue
        ver = verification.get((patch.product_key, patch.field))
        record = by_key.get(patch.product_key) or {}
        priority = (ver.priority if ver else "") or "4"
        rows.append({
            "검토ID": review_id(patch.product_key, patch.field),
            "우선순위": priority,
            "우선순위설명": V.PRIORITY_LABELS.get(priority, ""),
            "필드": patch.field,
            "필드한글": FIELD_LABELS.get(patch.field, patch.field),
            "통합키": patch.product_key,
            "공급처": patch.site,
            "공급처표시": Q.LABEL_BY_SITE.get(patch.site, patch.site),
            "원본ID": patch.source_product_id,
            "상품명": patch.product_name,
            "브랜드": Q._clean(record.get("brand")),
            "보완전": patch.before,
            "제안값": patch.proposed,
            "근거유형": patch.evidence_type,
            "근거": patch.evidence,
            "근거URL": patch.evidence_url,
            "원본화면URL": (record.get("source") or {}).get("url", "") or patch.evidence_url,
            "신뢰도": f"{patch.confidence:.2f}",
            "실측독립ID": ver.attest_ids if ver else 0,
            "실측값": ver.attest_value if ver else "",
            "영문파생일치": "예" if ver and ver.english_matches_derived else "아니오",
            "중복판정등급": ver.duplicate_verdict if ver else "",
            "판정근거": ver.rationale if ver else "",
            "행지문": row_fingerprint(patch.product_key, patch.field, patch.before, patch.proposed, priority),
            "검토결정": "",
            "확정값": "",
            "검토자": "",
            "검토일": "",
            "비고": "",
        })
    rows.sort(key=_priority_sort_key)
    return rows


def build_dup_rows(duplicates: Sequence[Q.DuplicateCandidate]) -> list[dict[str, Any]]:
    """중복 후보 쌍의 식별자·근거 비교 결과. 판정 입력란만 있고 병합은 표현하지 않는다."""
    rows: list[dict[str, Any]] = []
    for dup in duplicates:
        rows.append({
            "판정ID": dup_review_id(dup.left_key, dup.right_key),
            "중복등급": dup.verdict,
            "자동병합가능": "예" if dup.auto_mergeable else "아니오",
            "왼쪽공급처": Q.LABEL_BY_SITE.get(dup.left_key.split(":")[0], dup.left_key.split(":")[0]),
            "왼쪽원본ID": dup.left_key,
            "왼쪽상품명": dup.left_name,
            "왼쪽브랜드": dup.left_brand,
            "왼쪽모델명": dup.left_model,
            "오른쪽공급처": Q.LABEL_BY_SITE.get(dup.right_key.split(":")[0], dup.right_key.split(":")[0]),
            "오른쪽원본ID": dup.right_key,
            "오른쪽상품명": dup.right_name,
            "오른쪽브랜드": dup.right_brand,
            "오른쪽모델명": dup.right_model,
            "공통모델표현": dup.shared_phrase,
            "이름유사도": dup.name_similarity,
            "변형충돌": dup.variant_conflict,
            "브랜드값일치": dup.brand_agreement,
            "근거": dup.reason,
            "근거출처": dup.origin,
            "현재조치": dup.resolution,
            "행지문": hashlib.sha256(
                "\x1f".join((dup.left_key, dup.right_key, dup.verdict)).encode("utf-8")
            ).hexdigest()[:12],
            "판정": "",
            "남길ID": "",
            "검토자": "",
            "검토일": "",
            "비고": "",
        })
    rows.sort(key=lambda r: ({"confirmed": 0, "same_site_exact": 1, "probable": 2}.get(r["중복등급"], 3),
                             r["판정ID"]))
    return rows


def queue_fingerprint(rows: Iterable[Mapping[str, Any]]) -> str:
    seed = "\n".join(f"{r['검토ID']}|{r['행지문']}" for r in rows)
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------
# 워크북 작성 (검토자가 쓰는 파일)
# --------------------------------------------------------------------------

_GUIDE_LINES = (
    ("검토 방법 — 이슈 #43 Stage 3",),
    ("1.", "'검토후보' 시트를 우선순위 P1 → P4 순(이미 정렬됨)로 본다. '원본화면URL' 로 공급처 화면을 확인한다."),
    ("2.", "'검토결정' 열을 드롭다운에서 승인 / 반려 / 보류 로 고른다. 비워 두면 미검토다."),
    ("3.", "승인할 때 '확정값' 은 비워도 된다(제안값이 확정된다). 제안값과 다른 값을 넣거나 제안값이 없으면 '비고' 에 근거를 적어야 한다."),
    ("4.", "'브랜드'·'제조사' 검토 행도 같은 규칙이다. 자리표시자(자체제작 등)를 그대로 승인하지 않는다."),
    ("5.", "'중복후보판정' 시트는 병합하지 않는다. 동일상품으로 판정해도 '남길ID' 기록만 남고 원본 ID 는 전부 유효하다(자동 병합 0건)."),
    ("6.", "이 파일을 저장한 뒤 다음 명령으로 결과를 내보낸다. 원본 마스터는 갱신되지 않는다."),
    ("", "python tools\\product_quality\\build_quality.py --decisions data\\product_quality\\product_quality_review_queue.xlsx"),
    ("7.", "'행지문' 열은 제안값·우선순위 해시다. 재생성 후 값이 바뀌면 검증 단계에서 거부된다."),
)


def write_queue_xlsx(
    review_rows: Sequence[Mapping[str, Any]],
    dup_rows: Sequence[Mapping[str, Any]],
    path: str,
    fingerprint: str,
    summary: Mapping[str, Any] | None = None,
) -> None:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    from openpyxl.utils import get_column_letter
    from openpyxl.worksheet.datavalidation import DataValidation

    workbook = Workbook()
    bold = Font(bold=True)
    input_fill = PatternFill("solid", fgColor="FFF2CC")

    def add_sheet(title: str, rows: Sequence[Mapping[str, Any]], decision_values: tuple[str, ...],
                  decision_column: str) -> Any:
        ws = workbook.create_sheet(title=title)
        if not rows:
            ws.append(["(해당 없음)"])
            return ws
        header = list(rows[0].keys())
        ws.append(header)
        for cell in ws[1]:
            cell.font = bold
        for row in rows:
            ws.append([row.get(name) for name in header])
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = f"A1:{get_column_letter(len(header))}{ws.max_row}"
        index = header.index(decision_column) + 1
        validation = DataValidation(
            type="list", formula1='"' + ",".join(decision_values) + '"', allow_blank=True,
            showDropDown=False, promptTitle="검토 결정",
            prompt="/".join(decision_values) + " 중 하나를 고른다. 비워 두면 미검토.",
        )
        ws.add_data_validation(validation)
        last = get_column_letter(index)
        validation.add(f"{last}2:{last}{ws.max_row}")
        for name in DECISION_COLUMNS if decision_column == "검토결정" else ("판정", "남길ID", "검토자", "검토일", "비고"):
            if name in header:
                column = get_column_letter(header.index(name) + 1)
                for row in range(2, ws.max_row + 1):
                    ws[f"{column}{row}"].fill = input_fill
        for i, name in enumerate(header, start=1):
            width = min(40, max(len(str(name)) + 2, 12))
            ws.column_dimensions[get_column_letter(i)].width = width
        return ws

    guide = workbook.active
    guide.title = _GUIDE_SHEET
    for line in _GUIDE_LINES:
        guide.append(list(line))
        guide.cell(row=guide.max_row, column=1).font = bold if line[0].startswith("검토") else Font()
    guide.append([])
    guide.append(["대기열 지문(검증 시 대조)", fingerprint])
    guide.append(["검토 대상", f"{len(review_rows)}행", "중복 후보", f"{len(dup_rows)}쌍"])
    stage = (summary or {}).get("stage3", {})
    for key in ("model_review", "manufacturer_review", "brand_review", "priority_counts"):
        if key in stage:
            guide.append([key, json.dumps(stage[key], ensure_ascii=False) if isinstance(stage[key], dict)
                          else stage[key]])
    guide.column_dimensions["A"].width = 26
    guide.column_dimensions["B"].width = 96

    add_sheet(_QUEUE_SHEET, review_rows, DECISIONS, "검토결정")
    add_sheet(_DUP_SHEET, dup_rows, DUP_VERDICTS, "판정")
    workbook.move_sheet(_GUIDE_SHEET, offset=-(len(workbook.sheetnames) - 1))
    workbook.save(path)


# --------------------------------------------------------------------------
# 결정 읽기 + 검증
# --------------------------------------------------------------------------


@dataclass
class Decision:
    review_id: str
    product_key: str
    field: str
    before: str
    proposed: str
    decision: str
    confirmed_value: str
    reviewer: str
    decided_at: str
    note: str
    fingerprint: str

    def to_row(self) -> dict[str, Any]:
        return {
            "검토ID": self.review_id,
            "통합키": self.product_key,
            "원본ID": self.product_key.split(":")[-1],
            "필드": self.field,
            "필드한글": FIELD_LABELS.get(self.field, self.field),
            "보완전": self.before,
            "제안값": self.proposed,
            "검토결정": self.decision,
            "확정값": self.confirmed_value,
            "검토자": self.reviewer,
            "검토일": self.decided_at,
            "비고": self.note,
            "행지문": self.fingerprint,
        }


@dataclass
class DupDecision:
    review_id: str
    left_key: str
    right_key: str
    verdict_grade: str
    verdict: str
    keep_id: str
    reviewer: str
    decided_at: str
    note: str

    def to_row(self) -> dict[str, Any]:
        return {
            "판정ID": self.review_id,
            "왼쪽원본ID": self.left_key,
            "오른쪽원본ID": self.right_key,
            "중복등급": self.verdict_grade,
            "판정": self.verdict,
            "남길ID": self.keep_id,
            "검토자": self.reviewer,
            "검토일": self.decided_at,
            "비고": self.note,
            "자동병합": "아니오",
        }


@dataclass
class DecisionResult:
    approved: list[Decision] = field(default_factory=list)
    rejected: list[Decision] = field(default_factory=list)
    held: list[Decision] = field(default_factory=list)
    pending: list[Decision] = field(default_factory=list)
    invalid: list[Decision] = field(default_factory=list)
    dup_decisions: list[DupDecision] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    queue_fingerprint: str = ""
    stats: dict[str, Any] = field(default_factory=dict)


def _cell_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    return "" if text in ("None", "null") else text


def load_workbook_rows(path: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str]:
    """검토 워크북에서 (검토후보 행, 중복후보 행, 지문) 을 읽는다."""
    from openpyxl import load_workbook

    workbook = load_workbook(path, read_only=True, data_only=True)
    try:
        fingerprint = ""
        if _GUIDE_SHEET in workbook.sheetnames:
            guide = workbook[_GUIDE_SHEET]
            for row in guide.iter_rows(values_only=True):
                cells = [_cell_text(c) for c in row]
                if cells and cells[0].startswith("대기열 지문") and len(cells) > 1:
                    fingerprint = cells[1]
        review = _sheet_dicts(workbook, _QUEUE_SHEET)
        dup = _sheet_dicts(workbook, _DUP_SHEET)
    finally:
        workbook.close()
    return review, dup, fingerprint


def _sheet_dicts(workbook: Any, name: str) -> list[dict[str, Any]]:
    if name not in workbook.sheetnames:
        return []
    ws = workbook[name]
    rows: list[dict[str, Any]] = []
    header: list[str] = []
    for raw in ws.iter_rows(values_only=True):
        if not header:
            header = [_cell_text(c) for c in raw]
            if header and header[0] in ("검토 방법 — 이슈 #43 Stage 3",):
                header = []
            continue
        if all(_cell_text(c) == "" for c in raw):
            continue
        rows.append({header[i]: _cell_text(raw[i]) if i < len(raw) else "" for i in range(len(header))})
    return rows


def read_decisions(
    review_rows: Sequence[Mapping[str, Any]],
    dup_rows: Sequence[Mapping[str, Any]],
    queue: Sequence[Mapping[str, Any]],
    expected_fingerprint: str = "",
) -> DecisionResult:
    """검토자가 채운 워크북을 대기열과 대조해 검증 가능한 결과로 바꾼다."""
    out = DecisionResult()
    by_id = {r["검토ID"]: r for r in queue}
    if expected_fingerprint:
        out.queue_fingerprint = expected_fingerprint
    seen: set[str] = set()
    for row in review_rows:
        review_id_value = row.get("검토ID", "")
        base = by_id.get(review_id_value)
        decision = row.get("검토결정", "")
        if base is None:
            out.errors.append(f"{review_id_value or '(검토ID 없음)'}: 대기열에 없는 검토 ID")
            continue
        if review_id_value in seen:
            out.errors.append(f"{review_id_value}: 중복된 검토 ID 행")
            continue
        seen.add(review_id_value)
        fingerprint = row.get("행지문") or base["행지문"]
        if fingerprint != base["행지문"]:
            out.errors.append(f"{review_id_value}: 행지문 불일치 — 대기열 재생성 후 제안값·우선순위가 바뀌었다")
        confirmed = row.get("확정값", "")
        item = Decision(
            review_id=review_id_value,
            product_key=base["통합키"],
            field=base["필드"],
            before=base["보완전"],
            proposed=base["제안값"],
            decision=decision,
            confirmed_value=confirmed,
            reviewer=row.get("검토자", ""),
            decided_at=row.get("검토일", ""),
            note=row.get("비고", ""),
            fingerprint=fingerprint,
        )
        if decision == "":
            if any(row.get(c, "") for c in ("확정값", "검토자", "검토일", "비고")):
                out.errors.append(f"{review_id_value}: 결정 없이 입력란만 채워졌다 — 검토결정 필수")
                out.invalid.append(item)
            else:
                out.pending.append(item)
            continue
        if decision not in DECISIONS:
            out.errors.append(f"{review_id_value}: 허용되지 않은 검토결정 '{decision}'")
            out.invalid.append(item)
            continue
        if decision == "승인":
            value = confirmed or item.proposed
            if not value or value.casefold() in _EMPTYISH or Q.is_placeholder(value):
                out.errors.append(f"{review_id_value}: 승인 실패 — 확정 가능한 실측값이 없다(근거 없는 값은 채택하지 않음)")
                out.invalid.append(item)
                continue
            if confirmed and confirmed != item.proposed and not item.note:
                out.errors.append(f"{review_id_value}: 승인 실패 — 제안값과 다른 확정값은 '비고' 에 근거 필수")
                out.invalid.append(item)
                continue
            if not item.reviewer:
                out.errors.append(f"{review_id_value}: 승인 실패 — '검토자' 기록 필수")
                out.invalid.append(item)
                continue
            item.confirmed_value = value
            out.approved.append(item)
        elif decision == "반려":
            out.rejected.append(item)
        else:
            out.held.append(item)

    for base in queue:
        if base["검토ID"] in seen:
            continue
        out.pending.append(Decision(
            review_id=base["검토ID"], product_key=base["통합키"], field=base["필드"],
            before=base["보완전"], proposed=base["제안값"], decision="", confirmed_value="",
            reviewer="", decided_at="", note="", fingerprint=base["행지문"],
        ))

    dup_by_id = {r["판정ID"]: r for r in dup_rows}
    out.dup_decisions = _iter_dup_decisions(dup_rows, dup_by_id)
    for row in dup_rows:
        verdict = row.get("판정", "")
        review_id_value = row.get("판정ID", "")
        if verdict and verdict not in DUP_VERDICTS:
            out.errors.append(f"{review_id_value or '(판정ID 없음)'}: 허용되지 않은 판정 '{verdict}'")
        elif verdict == "동일상품" and row.get("남길ID") not in (row.get("왼쪽원본ID"), row.get("오른쪽원본ID")):
            out.errors.append(f"{review_id_value}: 동일상품 판정은 '남길ID' 가 쌍의 원본ID 중 하나여야 한다"
                              " (어느 쪽이든 원본 ID 는 삭제하지 않는다)")
    stats = Counter()
    for name, bucket in (("approved", out.approved), ("rejected", out.rejected),
                         ("held", out.held), ("pending", out.pending), ("invalid", out.invalid)):
        stats[name] = len(bucket)
    stats["by_field_approved"] = dict(Counter(d.field for d in out.approved))
    stats["dup_decided"] = sum(1 for d in out.dup_decisions if d.verdict)
    stats["dup_identical"] = sum(1 for d in out.dup_decisions if d.verdict == "동일상품")
    stats["duplicates_merged"] = 0
    out.stats = dict(stats)
    return out


def _iter_dup_decisions(rows: Sequence[Mapping[str, Any]], by_id: Mapping[str, Mapping[str, Any]]) -> list[DupDecision]:
    out: list[DupDecision] = []
    seen: set[str] = set()
    for row in rows:
        review_id_value = row.get("판정ID", "")
        base = by_id.get(review_id_value)
        if base is None or review_id_value in seen:
            continue
        seen.add(review_id_value)
        verdict = row.get("판정", "")
        if verdict and verdict not in DUP_VERDICTS:
            continue
        out.append(DupDecision(
            review_id=review_id_value,
            left_key=base["왼쪽원본ID"],
            right_key=base["오른쪽원본ID"],
            verdict_grade=base["중복등급"],
            verdict=verdict,
            keep_id=row.get("남길ID", "") if verdict == "동일상품" else "",
            reviewer=row.get("검토자", ""),
            decided_at=row.get("검토일", ""),
            note=row.get("비고", ""),
        ))
    return out


# --------------------------------------------------------------------------
# 패치 내보내기
# --------------------------------------------------------------------------


def decisions_payload(result: DecisionResult, summary: Mapping[str, Any] | None = None) -> dict[str, Any]:
    return {
        "schema_version": STAGE3_VERSION,
        "issue": 43,
        "stage": "stage3_review_decisions",
        "queue_fingerprint": result.queue_fingerprint,
        "queue_version": (summary or {}).get("schema_version", ""),
        "counts": {
            "approved": len(result.approved),
            "rejected": len(result.rejected),
            "held": len(result.held),
            "pending": len(result.pending),
            "invalid": len(result.invalid),
            "duplicate_pairs_recorded": len(result.dup_decisions),
            "duplicate_pairs_decided": result.stats.get("dup_decided", 0),
        },
        "policy": {
            "original_master_overwritten": False,
            "duplicates_merged": 0,
            "price_invented": False,
            "stock_invented": False,
            "wholesale_invented": False,
            "new_scraping_performed": False,
            "unapproved_values_applied": False,
            "invalid_rows_rejected": len(result.invalid),
        },
        "approved": [d.to_row() | {"classification": "reviewer_confirmed",
                                   "applies_to": "patch layer only"} for d in result.approved],
        "rejected": [d.to_row() for d in result.rejected],
        "held": [d.to_row() for d in result.held],
        "invalid": [d.to_row() for d in result.invalid],
        "duplicate_verdicts": [d.to_row() for d in result.dup_decisions if d.verdict],
        "errors": list(result.errors),
    }


_DECISION_CSV_HEADER = [
    "버킷", "검토ID", "통합키", "원본ID", "필드", "필드한글", "보완전", "제안값",
    "검토결정", "확정값", "검토자", "검토일", "비고", "행지문", "classification", "applies_to",
]


def write_decisions_csv(decisions: Mapping[str, Any], path: str) -> int:
    """버킷과 무관하게 같은 열 구성으로 쓴다(소비 측 스키마 고정)."""
    rows = []
    for bucket in ("approved", "rejected", "held", "invalid"):
        for row in decisions.get(bucket, []):
            merged = dict(row)
            merged["버킷"] = bucket
            merged.setdefault("classification", "")
            merged.setdefault("applies_to", "")
            rows.append(merged)
    rows.sort(key=lambda r: (r["버킷"], r["검토ID"]))
    with io.open(path, "w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=_DECISION_CSV_HEADER, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)


# --------------------------------------------------------------------------
# 요약 지표 (대기열 통계는 산출물 재생성 시점의 검토 0건 기준)
# --------------------------------------------------------------------------


def build_stage3_stats(
    review_rows: Sequence[Mapping[str, Any]],
    dup_rows: Sequence[Mapping[str, Any]],
    fingerprint: str,
    decisions: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    priority_counts = Counter(r["우선순위"] for r in review_rows)
    by_field = Counter(r["필드"] for r in review_rows)
    stats = {
        "stage3_version": STAGE3_VERSION,
        "review_queue_rows": len(review_rows),
        "model_review": by_field.get("model", 0),
        "manufacturer_review": by_field.get("manufacturer", 0),
        "brand_review": by_field.get("brand", 0),
        "priority_counts": dict(sorted(priority_counts.items())),
        "priority_counts_by_field": {
            fld: dict(sorted(Counter(r["우선순위"] for r in review_rows if r["필드"] == fld).items()))
            for fld in ("model", "manufacturer", "brand")
        },
        "decision_vocabulary": list(DECISIONS),
        "duplicate_verdict_vocabulary": list(DUP_VERDICTS),
        "duplicate_pairs": len(dup_rows),
        "duplicate_merges_performed": 0,
        "queue_fingerprint": fingerprint,
        "reviewer_inputs_editable": True,
        "no_value_confirmed_without_review": True,
    }
    if decisions:
        stats["decisions"] = decisions["counts"]
        stats["decisions"]["invalid"] = decisions["counts"].get("invalid", 0)
        stats["duplicates_merged"] = 0
    return stats


def write_json(path: str, payload: Mapping[str, Any]) -> None:
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with io.open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=1)
        handle.write("\n")


def _read_decisions_csv(path: str) -> list[dict[str, Any]]:
    """내보낸 결정 CSV를 다시 읽어 검토 워크북과 같은 형태의 행으로 돌려준다."""
    with io.open(path, encoding="utf-8-sig", newline="") as handle:
        return [{key: _cell_text(value) for key, value in row.items()} for row in csv.DictReader(handle)]


def apply_decisions_file(
    decisions_path: str,
    queue: Sequence[Mapping[str, Any]],
    out_dir: str,
    summary: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """채워진 검토 워크북(또는 decisions CSV)을 읽어 검증된 패치 산출물로 내보낸다."""
    if decisions_path.lower().endswith(".xlsx"):
        review_rows, dup_rows, fingerprint = load_workbook_rows(decisions_path)
    else:
        review_rows, fingerprint = _read_decisions_csv(decisions_path), ""
        dup_rows = []
    result = read_decisions(review_rows, dup_rows, queue, expected_fingerprint=fingerprint)
    payload = decisions_payload(result, summary)
    os.makedirs(out_dir, exist_ok=True)
    json_path = os.path.join(out_dir, "product_review_decisions.json")
    csv_path = os.path.join(out_dir, "product_review_decisions.csv")
    write_json(json_path, payload)
    row_count = write_decisions_csv(payload, csv_path)
    payload["output_files"] = {"json": json_path, "csv": csv_path, "csv_rows": row_count}
    return payload
