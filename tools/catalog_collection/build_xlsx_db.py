#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_xlsx_db.py -- 수집된 상품 마스터 CSV → #19 요구 XLSX DB (6개 시트)

  1 통합상품            : 상품 1행=1건. 핵심 필드 + 확장 필드 + 원본 JSON
  2 공급처원본          : 공급처별 원천 레코드(원천 ID·원문·원본 URL·수집시각·검증상태)
  3 브랜드·카테고리     : 브랜드 × 카테고리 집계 + 카테고리 메타
  4 중복후보            : 사이트 간 동일상품 후보(근거 컬럼 병기, 자동 병합 없음)
  5 누락·검증현황       : 필드별 확보율 + 미확정 사유 + 가격/재고 상태 분포
  6 향후 네이버·이카운트 : 매핑 준비도 표(카테고리 ID·ERP 필드 슬롯·네이버 카테고리 후보)

입력
  --master  product_master_full.csv          (40컬럼 상품 마스터)
  --cats    category_catalog_full.csv        (카테고리 메타)
  --quality product_master_full_quality.csv  (수집 단계별 품질 통계)
  --out     product_master_full.xlsx

주의
  - 엑셀 셀 최대 32,767자 제한으로 초과 필드는 잘라내고 표시한다(원본은 CSV/JSON 이 정본).
  - 공개되지 않은 값(공급가·실재고·CGI 판매가·취급승인)은 **생성하지 않는다**.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from collections import Counter, defaultdict
from typing import Any, Dict, List

csv.field_size_limit(50_000_000)

CELL_MAX = 32000


def load(path: str) -> List[Dict[str, str]]:
    with open(path, encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))


def clip(v: Any) -> Any:
    if isinstance(v, str) and len(v) > CELL_MAX:
        return v[:CELL_MAX] + f"…[잘림 {len(v)}자]"
    return v


CORE = [
    ("source_site", "공급처"),
    ("source_product_id", "원천상품ID"),
    ("product_name", "상품명"),
    ("source_brand", "브랜드"),
    ("manufacturer", "제조사"),
    ("model", "모델명"),
    ("source_category_path", "상품분류"),
    ("source_category_id", "분류ID"),
    ("published_price", "공개판매가"),
    ("published_price_text", "공개가원문"),
    ("published_price_state", "공개가상태"),
    ("retail_list_price", "정가(소비자가)"),
    ("option_count", "옵션수"),
    ("soldout_display", "품절표시"),
    ("stock_display", "재고표시"),
    ("canonical_url", "원본상세URL"),
    ("source_evidence", "검증근거URL"),
    ("source_list_url", "목록URL"),
    ("extraction_method", "수집방법"),
    ("verification_status", "검증상태"),
    ("updated_at", "수집시각"),
]

JSON_COLS = [
    ("specs", "규격(원본JSON)"),
    ("option_summary", "옵션(원본JSON)"),
    ("image_urls", "이미지URL"),
    ("availability_unverified", "재고(원본JSON)"),
    ("source_item_code", "아이템코드"),
    ("product_code", "상품코드"),
    ("product_status_flags", "상태플래그"),
    ("dealer_price_unverified", "공급가(미확인)"),
]


def sheet_write(ws, headers, rows, widths=None):
    from openpyxl.utils import get_column_letter

    ws.append(headers)
    for r in rows:
        ws.append([clip(r.get(h, "")) for h in headers])
    for i, h in enumerate(headers, 1):
        letter = get_column_letter(i)
        w = (widths or {}).get(h, 18)
        ws.column_dimensions[letter].width = w
    ws.freeze_panes = "A2"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--master", required=True)
    ap.add_argument("--cats", required=True)
    ap.add_argument("--quality", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--dupes", default=None, help="중복후보 CSV(선택)")
    args = ap.parse_args()

    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill

    rows = load(args.master)
    cats = load(args.cats)
    qual = load(args.quality)
    wb = Workbook()
    hdr_font = Font(bold=True, color="FFFFFF")
    hdr_fill = PatternFill("solid", fgColor="1F4E79")

    def style(ws):
        for c in ws[1]:
            c.font = hdr_font
            c.fill = hdr_fill
            c.alignment = Alignment(vertical="center", wrap_text=True)

    # ---- 1 통합상품 ----
    ws = wb.active
    ws.title = "통합상품"
    headers = [lbl for _, lbl in CORE] + [lbl for _, lbl in JSON_COLS]
    data = []
    for r in rows:
        rec = {lbl: r.get(key, "") for key, lbl in CORE}
        rec.update({lbl: r.get(key, "") for key, lbl in JSON_COLS})
        data.append(rec)
    sheet_write(ws, headers, data, {"상품명": 46, "브랜드": 18, "모델명": 20, "상품분류": 44,
                                     "원본상세URL": 52, "검증근거URL": 52, "목록URL": 52,
                                     "규격(원본JSON)": 60, "옵션(원본JSON)": 60, "이미지URL": 50})
    style(ws)
    ws.auto_filter.ref = ws.dimensions

    # ---- 2 공급처원본 ----
    ws2 = wb.create_sheet("공급처원본")
    h2 = ["공급처", "원천상품ID", "원문상품명", "원문요약", "원본상세URL", "목록URL", "원천분류경로",
          "원천브랜드", "원천모델", "아이템코드", "상품코드", "공개가원문", "공개가상태", "품절표시",
          "재고표시", "옵션수", "이미지수", "수집시각", "수집방법", "검증상태", "검증근거URL"]
    d2 = []
    for r in rows:
        d2.append({
            "공급처": r.get("source_site", ""), "원천상품ID": r.get("source_product_id", ""),
            "원문상품명": r.get("product_name", ""), "원문요약": r.get("summary", ""),
            "원본상세URL": r.get("canonical_url", ""), "목록URL": r.get("source_list_url", ""),
            "원천분류경로": r.get("source_category_path", ""), "원천브랜드": r.get("source_brand", ""),
            "원천모델": r.get("model", ""), "아이템코드": r.get("source_item_code", ""),
            "상품코드": r.get("product_code", ""), "공개가원문": r.get("published_price_text", ""),
            "공개가상태": r.get("published_price_state", ""), "품절표시": r.get("soldout_display", ""),
            "재고표시": r.get("stock_display", ""), "옵션수": r.get("option_count", ""),
            "이미지수": len([x for x in (r.get("image_urls") or "").split("|") if x]),
            "수집시각": r.get("updated_at", ""), "수집방법": r.get("extraction_method", ""),
            "검증상태": r.get("verification_status", ""), "검증근거URL": r.get("source_evidence", ""),
        })
    sheet_write(ws2, h2, d2, {"원문상품명": 46, "원본상세URL": 52, "목록URL": 52, "원천분류경로": 44,
                              "원문요약": 40, "검증근거URL": 52})
    style(ws2)
    ws2.auto_filter.ref = ws2.dimensions

    # ---- 3 브랜드·카테고리 ----
    ws3 = wb.create_sheet("브랜드·카테고리")
    h3 = ["공급처", "브랜드", "상품수", "공개가있음", "옵션보유", "평균공개가", "브랜드출현카테고리수"]
    agg = defaultdict(lambda: {"n": 0, "p": 0, "o": 0, "s": 0, "c": set()})
    for r in rows:
        k = (r.get("source_site", ""), r.get("source_brand", ""))
        a = agg[k]
        a["n"] += 1
        if (r.get("published_price") or "").strip():
            a["p"] += 1
            try:
                a["s"] += int(r.get("published_price") or 0)
            except ValueError:
                pass
        if (r.get("option_count") or "0") not in ("0", ""):
            a["o"] += 1
        a["c"].add((r.get("source_category_id", ""), r.get("source_category_name", "")))
    d3 = []
    for (site, br), a in sorted(agg.items(), key=lambda x: (-x[1]["n"], x[0])):
        d3.append({"공급처": site, "브랜드": br, "상품수": a["n"], "공개가있음": a["p"],
                   "옵션보유": a["o"],
                   "평균공개가": round(a["s"] / a["p"]) if a["p"] else "",
                   "브랜드출현카테고리수": len(a["c"])})
    sheet_write(ws3, h3, d3, {"브랜드": 24})
    style(ws3)
    ws3.auto_filter.ref = ws3.dimensions

    ws3b = wb.create_sheet("카테고리목록")
    h3b = ["공급처", "카테고리ID", "카테고리명", "카테고리경로", "등록상품수(카페24)", "수집상품수", "목록URL"]
    d3b = [{"공급처": c.get("source_site", ""), "카테고리ID": c.get("category_id", ""),
            "카테고리명": c.get("category_name", ""), "카테고리경로": c.get("category_path", ""),
            "등록상품수(카페24)": c.get("registered_count", ""),
            "수집상품수": c.get("product_count_on_site", ""), "목록URL": c.get("list_url", "")}
           for c in cats]
    sheet_write(ws3b, h3b, d3b, {"카테고리명": 26, "카테고리경로": 46, "목록URL": 50})
    style(ws3b)

    # ---- 4 중복후보 ----
    ws4 = wb.create_sheet("중복후보")
    h4 = ["유형", "공급처A", "상품IDA", "상품명A", "공급처B", "상품IDB", "상품명B",
          "근거", "브랜드", "자동병합여부"]
    d4 = []
    if args.dupes and os.path.exists(args.dupes):
        for d in load(args.dupes):
            d4.append(d)
    else:
        def norm(s):
            s = (s or "").lower()
            s = re.sub(r"\[[^\]]*\]", "", s)
            return re.sub(r"[\s\(\)\{\}/,·\|\-\+\*!?:;'\"]+", "", s)
        by = defaultdict(list)
        for r in rows:
            by[(r.get("source_site", ""), norm(r.get("product_name", "")))].append(r)
        for (site, k), lst in by.items():
            if len(lst) > 1 and k:
                base = lst[0]
                for other in lst[1:]:
                    d4.append({"유형": "동일공급처 동일상품명", "공급처A": site, "상품IDA": base["source_product_id"],
                               "상품명A": base["product_name"], "공급처B": site,
                               "상품IDB": other["source_product_id"], "상품명B": other["product_name"],
                               "근거": "정규화 상품명 완전일치", "브랜드": base.get("source_brand", ""),
                               "자동병합여부": "N"})
    sheet_write(ws4, h4, d4, {"상품명A": 44, "상품명B": 44, "근거": 30, "브랜드": 18})
    style(ws4)
    ws4.auto_filter.ref = ws4.dimensions

    # ---- 5 누락·검증현황 ----
    ws5 = wb.create_sheet("누락·검증현황")
    h5 = ["구분", "항목", "값", "설명"]
    d5 = []
    for q in qual:
        site = q.get("source_site", "")
        for k, v in q.items():
            if k == "source_site":
                continue
            d5.append({"구분": "수집단계 통계", "항목": f"{site}.{k}", "값": v, "설명": ""})
    # 필드별 확보율
    FIELDS = ["canonical_url", "product_name", "source_brand", "manufacturer", "model",
              "source_category_path", "specs", "image_urls", "option_summary",
              "published_price", "source_item_code", "summary", "country_of_origin",
              "soldout_display"]
    for site in sorted({r.get("source_site", "") for r in rows}):
        rs = [r for r in rows if r.get("source_site") == site]
        for f in FIELDS:
            c = sum(1 for r in rs if (r.get(f) or "").strip() and r.get(f) not in ("[]", "{}"))
            d5.append({"구분": "필드 확보율", "항목": f"{site}.{f}", "값": f"{c}/{len(rs)} ({c/max(1,len(rs))*100:.1f}%)",
                       "설명": ""})
    # 가격/재고 상태
    for site in sorted({r.get("source_site", "") for r in rows}):
        rs = [r for r in rows if r.get("source_site") == site]
        for st, c in Counter(r.get("published_price_state", "") for r in rs).most_common():
            d5.append({"구분": "공개가 상태", "항목": f"{site}.{st}", "값": c,
                       "설명": {"numeric_price": "공개 판매가 있음", "inquiry_price": "가격 문의(공개값 없음)",
                                 "sold_out_sale_completed": "판매 완료", "not_for_sale": "판매 불료",
                                 "empty": "값 없음", "other": "기타"}.get(st, "")})
        d5.append({"구분": "미확정 항목", "항목": f"{site}.dealer_price", "값": "NULL(미확인)",
                   "설명": "공급가는 공개 웹에 없음. 이카운트 전표(supply_amt)에서만 확정 가능"})
        d5.append({"구분": "미확정 항목", "항목": f"{site}.availability", "값": "미확인",
                   "설명": "실재고 공개 근거 없음. 페이지 표기값만 기록"})
        d5.append({"구분": "미확정 항목", "항목": f"{site}.cgi_approved", "값": "NULL",
                   "설명": "CGI 취급 승인 여부는 대표 확인 필요"})
    sheet_write(ws5, h5, d5, {"항목": 40, "값": 24, "설명": 44})
    style(ws5)
    ws5.auto_filter.ref = ws5.dimensions

    # ---- 6 향후 네이버·이카운트 ----
    ws6 = wb.create_sheet("향후네이버·이카운트")
    h6 = ["공급처", "원천상품ID", "상품명", "원천카테고리ID", "원천카테고리경로",
          "이카운트품목코드슬롯(prod_cd)", "이카운트브랜드슬롯(cont2)", "이카운트모델슬롯(cont3)",
          "이카운트규격슬롯(SIZE_DES)", "이카운트단위슬롯(unit)", "이카운트입고단가슬롯(in_price)",
          "이카운트출고단가슬롯(out_price)", "네이버카테고리ID", "네이버상품ID(쇼핑몰품목key)",
          "매핑준비도", "비고"]
    d6 = []
    for r in rows:
        has_model = "Y" if (r.get("model") or "").strip() else "N"
        d6.append({
            "공급처": r.get("source_site", ""), "원천상품ID": r.get("source_product_id", ""),
            "상품명": r.get("product_name", ""), "원천카테고리ID": r.get("source_category_id", ""),
            "원천카테고리경로": r.get("source_category_path", ""),
            "이카운트품목코드슬롯(prod_cd)": r.get("product_code", ""),
            "이카운트브랜드슬롯(cont2)": r.get("source_brand", ""),
            "이카운트모델슬롯(cont3)": r.get("model", ""),
            "이카운트규격슬롯(SIZE_DES)": r.get("model", ""),
            "이카운트단위슬롯(unit)": "", "이카운트입고단가슬롯(in_price)": "",
            "이카운트출고단가슬롯(out_price)": r.get("published_price", "") if (r.get("published_price") or "").strip() else "",
            "네이버카테고리ID": "", "네이버상품ID(쇼핑몰품목key)": "",
            "매핑준비도": ("키·브랜드·분류·이미지·가격" if has_model == "Y" else "키·브랜드·분류·이미지(모델 미확정)"),
            "비고": "이카운트 채널(스마트스토어2.0) 미등록 / 상품등록 지원 X",
        })
    sheet_write(ws6, h6, d6, {"상품명": 42, "원천카테고리경로": 40, "이카운트품목코드슬롯(prod_cd)": 22,
                              "이카운트브랜드슬롯(cont2)": 20, "이카운트모델슬롯(cont3)": 20,
                              "이카운트규격슬롯(SIZE_DES)": 20, "이카운트출고단가슬롯(out_price)": 22,
                              "매핑준비도": 26, "비고": 40})
    style(ws6)
    ws6.auto_filter.ref = ws6.dimensions

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    wb.save(args.out)
    print(f"rows={len(rows)} sheets={wb.sheetnames} -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
