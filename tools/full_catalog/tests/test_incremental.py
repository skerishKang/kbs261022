"""이슈 #5 증분 갱신 reconciler · 필드 준비도 단위 테스트(오프라인, 네트워크/파일 불필요)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.full_catalog import incremental_update as IU  # noqa: E402
from tools.full_catalog import naver_field_readiness as NF  # noqa: E402


def _base(site, pid, **kw):
    row = {"source_site": site, "source_product_id": pid, "product_name": "",
           "public_price": "", "brand": "", "model": "", "source_url": "", "sales_status": ""}
    row.update(kw)
    return row


def _snap(site, pid, **kw):
    row = {"product_name": "", "public_price": "", "brand": "", "model": "", "source_url": ""}
    row.update(kw)
    return row


class DiffRecordsTest(unittest.TestCase):
    def test_new_product(self):
        base = {}
        snap = {"samasound:9999": _snap("samasound", "9999", product_name="NEW ITEM")}
        rows = IU.diff_records(base, snap, full_enum=True)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["change_type"], "new")
        self.assertEqual(rows[0]["source_product_id"], "9999")

    def test_removed_only_when_full(self):
        base = {"samamusic:1": _base("samamusic", "1")}
        snap = {}
        full = IU.diff_records(base, snap, full_enum=True)
        self.assertEqual(full[0]["change_type"], "removed_candidate")
        part = IU.diff_records(base, snap, full_enum=False)
        self.assertEqual(part[0]["change_type"], "partial_unobserved")
        # 부분열거에서는 삭제(removed_candidate)가 절대 나오지 않는다 → 추정 금지.
        self.assertNotIn("removed_candidate", {r["change_type"] for r in part})

    def test_changed_name(self):
        base = {"samasound:5": _base("samasound", "5", product_name="OLD")}
        snap = {"samasound:5": _snap("samasound", "5", product_name="NEW")}
        rows = IU.diff_records(base, snap, full_enum=True)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["change_type"], "changed")
        self.assertIn("name", rows[0]["changed_fields"].split(","))

    def test_empty_snapshot_field_not_changed(self):
        base = {"samasound:5": _base("samasound", "5", product_name="X", public_price="1000")}
        snap = {"samasound:5": _snap("samasound", "5", product_name="", public_price="")}
        rows = IU.diff_records(base, snap, full_enum=True)
        self.assertEqual(rows, [])  # 미수집(빈 값)은 변경으로 잡지 않는다.

    def test_url_never_compared(self):
        # canonical vs list URL 이 달라 전원 오탐하던 회귀 방지.
        base = {"samasound:5": _base("samasound", "5", product_name="S", source_url="https://samasound.co.kr/a/5/")}
        snap = {"samasound:5": _snap("samasound", "5", product_name="S", source_url="https://www.samasound.co.kr/product/list/5")}
        rows = IU.diff_records(base, snap, full_enum=True)
        self.assertEqual(rows, [])

    def test_unchanged_excluded(self):
        base = {"samasound:5": _base("samasound", "5", product_name="S", public_price="100")}
        snap = {"samasound:5": _snap("samasound", "5", product_name="S", public_price="100")}
        self.assertEqual(IU.diff_records(base, snap, full_enum=True), [])

    def test_cosmetic_whitespace_not_changed(self):
        # 이중 공백 등 표기 차이는 실제 변경으로 잡지 않는다(회귀 방지).
        base = {"samasound:5": _base("samasound", "5", product_name="One for iOS,  Mac&Windows  오디오")}
        snap = {"samasound:5": _snap("samasound", "5", product_name="One for iOS, Mac&Windows 오디오")}
        self.assertEqual(IU.diff_records(base, snap, full_enum=True), [])

    def test_price_change_detected(self):
        base = {"samamusic:7": _base("samamusic", "7", public_price="1000")}
        snap = {"samamusic:7": _snap("samamusic", "7", public_price="2000")}
        rows = IU.diff_records(base, snap, full_enum=False)
        self.assertEqual(rows[0]["change_type"], "changed")
        self.assertIn("price", rows[0]["changed_fields"].split(","))


class BuildStatsTest(unittest.TestCase):
    def test_counts_per_site(self):
        rows = [
            {"change_type": "new", "source_site": "samasound", "source_product_id": "1", "changed_fields": ""},
            {"change_type": "changed", "source_site": "samasound", "source_product_id": "2", "changed_fields": "name,price"},
            {"change_type": "removed_candidate", "source_site": "samasound", "source_product_id": "3", "changed_fields": ""},
        ]
        counts = {"samasound": {"baseline_products": 3, "snapshot_products": 2}}
        st = IU.build_stats_rows(rows, counts)
        self.assertEqual(st["totals"]["new"], 1)
        self.assertEqual(st["totals"]["changed"], 1)
        self.assertEqual(st["totals"]["removed_candidate"], 1)
        self.assertEqual(st["totals"]["changed_breakdown"]["name"], 1)
        self.assertEqual(st["per_site"]["samasound"]["snapshot_products"], 2)


class FieldReadinessTest(unittest.TestCase):
    def test_public_price_has_price(self):
        a = NF.assess({"source_site": "samamusic", "product_name": "P", "public_price_state": "public",
                       "public_price": "1000", "image_count": "3", "brand": "X", "model": "M", "manufacturer": ""})
        self.assertNotIn("판매가", a["missing_required"].split(";"))
        self.assertNotIn("대표이미지", a["missing_required"].split(";"))
        self.assertEqual(a["ready"], "partial")

    def test_inquiry_price_missing_price(self):
        a = NF.assess({"source_site": "samasound", "product_name": "P", "public_price_state": "inquiry_price",
                       "public_price": "", "image_count": "2", "brand": "", "model": "", "manufacturer": ""})
        self.assertIn("판매가", a["missing_required"].split(";"))

    def test_no_image_blocked(self):
        a = NF.assess({"source_site": "samamusic", "product_name": "P", "public_price_state": "public",
                       "public_price": "100", "image_count": "0", "brand": "B", "model": "M", "manufacturer": "F"})
        self.assertIn("대표이미지", a["missing_required"].split(";"))
        self.assertEqual(a["ready"], "blocked")

    def test_structural_fields_always_missing(self):
        # 공급처 공개 소스에 없는 필드는 항상 누락(추정 금지).
        a = NF.assess({"source_site": "samamusic", "product_name": "P", "public_price_state": "public",
                       "public_price": "100", "image_count": "1", "brand": "B", "model": "M", "manufacturer": "F"})
        for f in ("상세설명", "카테고리번호", "원산지코드", "ASTemplateCode", "배송비", "재고수량"):
            self.assertIn(f, a["missing_required"].split(";"), f)


if __name__ == "__main__":
    unittest.main()
