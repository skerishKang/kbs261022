"""이슈 #43 상품 DB 품질 개선 산출물 빌더.

실행 (저장소 루트):

    python tools\\product_quality\\build_quality.py

읽기 전용 입력
    - ``site/data/products.json``           원본 마스터 4,575건 (덮어쓰지 않음)
    - ``data/full_catalog/product_db.xlsx`` 이슈 #8 정본 — 중복 판정 재사용

쓰기 위치: ``data/product_quality/`` (신규 영역. LOCAL2/LOCAL3 파일과 충돌하지 않음)
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
from typing import Any, Mapping, Sequence

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from tools.product_quality import quality as Q  # noqa: E402

OUT_DIR = "data/product_quality"
FILES = {
    "patch_candidates": "product_quality_patch_candidates.csv",
    "duplicate_candidates": "product_duplicate_candidates.csv",
    "improved": "product_quality_improved.json",
    "summary": "product_quality_summary.json",
    "review": "product_quality_review.xlsx",
}

# 정본 XLSX 중복후보 시트 → (좌측, 우측) 열 이름
SHEET_DUPLICATE = "중복후보"
COLS = {
    "verdict": "판정",
    "auto": "자동병합가능",
    "left_site": "왼쪽공급처",
    "left_id": "왼쪽원본ID",
    "left_name": "왼쪽상품명",
    "left_brand": "왼쪽브랜드",
    "left_model": "왼쪽모델명",
    "right_site": "오른쪽공급처",
    "right_id": "오른쪽원본ID",
    "right_name": "오른쪽상품명",
    "right_brand": "오른쪽브랜드",
    "right_model": "오른쪽모델명",
    "phrase": "공통모델표현",
    "similarity": "이름유사도",
    "conflict": "변형충돌",
    "brand_ok": "브랜드값일치",
    "reason": "사유",
}


def _clean(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _key(site_label: str, product_id: Any) -> str:
    site = Q.SITE_BY_LABEL.get(_clean(site_label), _clean(site_label))
    return f"{site}:{_clean(product_id)}"


def load_master(path: str) -> list[dict[str, Any]]:
    with io.open(path, "r", encoding="utf-8") as handle:
        records = json.load(handle)
    if not isinstance(records, list):
        raise SystemExit(f"{path}: 원본 마스터는 리스트여야 합니다")
    return records


def load_duplicate_sheet(path: str) -> tuple[list[Q.DuplicateCandidate], list[Mapping[str, Any]]]:
    """정본의 중복 판정을 재사용한다 (재계산·재수집 없음)."""
    from openpyxl import load_workbook

    workbook = load_workbook(path, read_only=True, data_only=True)
    sheet = workbook[SHEET_DUPLICATE]
    rows = sheet.iter_rows(values_only=True)
    header = [_clean(h) for h in next(rows)]
    index = {name: header.index(name) for name in COLS.values() if name in header}
    missing = [name for name in COLS.values() if name not in index]
    if missing:
        raise SystemExit(f"{path}:{SHEET_DUPLICATE} 필요한 열 없음: {missing}")

    master_pairs: list[Q.DuplicateCandidate] = []
    confirmed_pairs: list[Mapping[str, Any]] = []
    for raw in rows:
        if raw is None or all(c is None or _clean(c) == "" for c in raw):
            continue
        get = lambda name: _clean(raw[index[name]])  # noqa: E731
        left_key = _key(get(COLS["left_site"]), get(COLS["left_id"]))
        right_key = _key(get(COLS["right_site"]), get(COLS["right_id"]))
        verdict = get(COLS["verdict"])
        auto = get(COLS["auto"]) == "예"
        master_pairs.append(
            Q.DuplicateCandidate(
                verdict=verdict,
                auto_mergeable=auto,
                left_key=left_key,
                left_name=get(COLS["left_name"]),
                left_brand=get(COLS["left_brand"]),
                left_model=get(COLS["left_model"]),
                right_key=right_key,
                right_name=get(COLS["right_name"]),
                right_brand=get(COLS["right_brand"]),
                right_model=get(COLS["right_model"]),
                shared_phrase=get(COLS["phrase"]),
                name_similarity=get(COLS["similarity"]),
                variant_conflict=get(COLS["conflict"]),
                brand_agreement=get(COLS["brand_ok"]),
                reason=get(COLS["reason"]),
                origin="issue8_master",
            )
        )
        if verdict == "confirmed":
            confirmed_pairs.append(
                {"left_key": left_key, "right_key": right_key, "shared_phrase": get(COLS["phrase"])}
            )
    workbook.close()
    return master_pairs, confirmed_pairs


def write_patch_csv(patches: Sequence[Q.Patch], path: str) -> int:
    rows = [p.to_row() for p in patches]
    header = list(rows[0].keys())
    with io.open(path, "w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=header)
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)


def write_duplicate_csv(duplicates: Sequence[Q.DuplicateCandidate], path: str) -> int:
    rows = [d.to_row() for d in duplicates]
    header = list(rows[0].keys())
    with io.open(path, "w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=header)
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)


def write_json(payload: Any, path: str, compact: bool = False) -> None:
    with io.open(path, "w", encoding="utf-8") as handle:
        if compact:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(payload, handle, ensure_ascii=False, indent=1)
        handle.write("\n")


def write_review_xlsx(result: Q.QualityResult, summary: Mapping[str, Any], path: str) -> None:
    from openpyxl import Workbook
    from openpyxl.styles import Font
    from openpyxl.utils import get_column_letter

    workbook = Workbook()
    bold = Font(bold=True)

    def sheet(title: str, rows: Sequence[Mapping[str, Any]], note: str = ""):
        ws = workbook.create_sheet(title=title)
        if note:
            ws.append([note])
            ws.cell(row=1, column=1).font = bold
        if not rows:
            ws.append(["(해당 없음)"])
            return ws
        header = list(rows[0].keys())
        ws.append(header)
        for cell in ws[ws.max_row]:
            cell.font = bold
        for row in rows:
            ws.append([_cell(row.get(name)) for name in header])
        ws.freeze_panes = ws["A3" if note else "A2"]
        for i, name in enumerate(header, start=1):
            width = min(46, max(len(str(name)) + 2, 12))
            ws.column_dimensions[get_column_letter(i)].width = width
        return ws

    def _cell(value: Any) -> Any:
        if isinstance(value, (list, tuple)):
            return " > ".join(str(v) for v in value)
        if isinstance(value, dict):
            return json.dumps(value, ensure_ascii=False)
        if isinstance(value, bool):
            return "예" if value else "아니오"
        return value

    auto_rows = [p.to_row() for p in result.patches if p.classification == Q.CLASS_AUTO and p.proposed != p.before]
    review_rows = [p.to_row() for p in result.patches if p.classification == Q.CLASS_REVIEW]
    none_rows = [p.to_row() for p in result.patches if p.classification == Q.CLASS_NONE]
    field_rows = field_status_rows(result)
    contract_rows = local2_contract_rows(summary)

    del workbook["Sheet"]
    sheet("요약", [{k: _cell(v) for k, v in dict(flatten(summary)).items()}],
          "이슈 #43 상품 DB 품질 개선 — 보완 전후 요약 (원본 4,575건 보존)")
    sheet("자동보완", auto_rows, "원천 근거가 유일한 항목. LOCAL2는 즉시 사용 가능")
    sheet("검토후보", review_rows, "근거가 약하거나 복수. 사람이 확정하기 전까지 반영 금지")
    sheet("근거없음", none_rows, "원천에 표기가 없어 공백 유지. 임의 생성 금지")
    sheet("중복후보", [d.to_row() for d in result.duplicates],
          "이슈 #8 정본 판정 재사용 + 같은 사이트 완전 일치. 원본 보존, 병합 0건")
    sheet("필드현황", field_rows, "필드별 누락 전후 및 공급처 분해")
    sheet("LOCAL2계약", contract_rows, "product_quality_improved.json 열 의미")

    workbook.save(path)


def flatten(summary: Mapping[str, Any], prefix: str = "") -> list[tuple[str, Any]]:
    out: list[tuple[str, Any]] = []
    for key, value in summary.items():
        name = f"{prefix}{key}"
        if isinstance(value, dict):
            out.extend(flatten(value, name + "."))
        else:
            out.append((name, value))
    return out


def field_status_rows(result: Q.QualityResult) -> list[dict[str, Any]]:
    by_field: dict[tuple[str, str], list[Q.Patch]] = {}
    for patch in result.patches:
        by_field.setdefault((patch.field, patch.site), []).append(patch)
    counts: dict[tuple[str, str], dict[str, int]] = {}
    for (field_name, site), patches in by_field.items():
        actionable = [p for p in patches if p.actionable]
        counts[(field_name, site)] = {
            "자동보완": sum(1 for p in actionable if p.classification == Q.CLASS_AUTO),
            "검토후보": sum(1 for p in actionable if p.classification == Q.CLASS_REVIEW),
            "근거없음": sum(1 for p in actionable if p.classification == Q.CLASS_NONE),
            "이미원본값": len(patches) - len(actionable),
            "자리표시자": sum(1 for p in patches
                              if p.evidence_type in ("placeholder_existing_value", "placeholder_replacement")),
        }
    rows: list[dict[str, Any]] = []
    for field_name in ("model", "manufacturer", "brand"):
        for site in ("samasound.co.kr", "samamusic.co.kr"):
            subset = [r for r in result.improved if r["source_site"] == site]
            if field_name == "brand":
                missing_before = sum(1 for r in subset if not _clean(r.get("brand")))
                missing_after = missing_before
            else:
                missing_before = sum(1 for r in subset if not r[f"{field_name}_before"])
                missing_after = sum(1 for r in subset if not r[f"{field_name}_after"])
            stat = counts.get((field_name, site), {})
            rows.append(
                {
                    "필드": field_name,
                    "공급처": site,
                    "상품수": len(subset),
                    "보완전누락": missing_before,
                    "보완후누락": missing_after,
                    **stat,
                }
            )
    return rows


def local2_contract_rows(summary: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [
        {"항목": "파일", "내용": "data/product_quality/product_quality_improved.json"},
        {"항목": "성격", "내용": "패치 레이어. 원본 site/data/products.json 을 덮어쓰지 않는다"},
        {"항목": "적용 방법", "내용": "products.json 의 id 와 improved.products[].id 를 조인한 뒤 "
                                        "manufacturer_after / model_after 를 우선 사용"},
        {"항목": "즉시 사용 가능", "내용": "classification=auto_confirmed 항목 (총 {}건 레코드)".format(
            summary["auto_corrected_records"])},
        {"항목": "반영 금지", "내용": "classification=review_required / no_evidence 항목. "
                                       "product_quality_review.xlsx 검토후보 시트 확정 전까지 원본값 유지"},
        {"항목": "가격·재고", "내용": "price_original / price_state_original 은 원본 전달값뿐이며 새로 만든 값이 없다"},
        {"항목": "중복", "내용": "중복 후보는 표시만 했다. 병합 0건, 원본 4,575건 그대로"},
        {"항목": "Yamaha", "내용": "673건 재수집 없음. site/data/yamaha_catalog.json 은 이 작업에서 읽지 않았다"},
    ]


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="이슈 #43 상품 DB 품질 개선 산출물 생성")
    parser.add_argument("--master", default=Q.MASTER_PATH)
    parser.add_argument("--authoritative", default=Q.AUTHORITATIVE_XLSX)
    parser.add_argument("--out-dir", default=OUT_DIR)
    args = parser.parse_args(argv)

    os.makedirs(args.out_dir, exist_ok=True)
    records = load_master(args.master)
    master_pairs, confirmed_pairs = load_duplicate_sheet(args.authoritative)
    result = Q.build_result(records, confirmed_pairs, master_pairs)

    actionable = [p for p in result.patches if p.actionable]
    patch_rows = write_patch_csv(actionable, os.path.join(args.out_dir, FILES["patch_candidates"]))
    dup_rows = write_duplicate_csv(result.duplicates, os.path.join(args.out_dir, FILES["duplicate_candidates"]))
    improved_payload = {
        "schema_version": Q.SCHEMA_VERSION,
        "generated_at": result.generated_at,
        "issue": 43,
        "layer": "patch",
        "base_master": "site/data/products.json",
        "original_products": result.master_count,
        "products": result.improved,
    }
    write_json(improved_payload, os.path.join(args.out_dir, FILES["improved"]), compact=True)
    write_json(result.summary, os.path.join(args.out_dir, FILES["summary"]))
    write_review_xlsx(result, result.summary, os.path.join(args.out_dir, FILES["review"]))

    print(json.dumps(result.summary, ensure_ascii=False, indent=1))
    print(f"patch_rows={patch_rows} duplicate_rows={dup_rows} out_dir={args.out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
