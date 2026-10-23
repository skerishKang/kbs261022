import csv
import json
import os
import sys
import unittest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO_ROOT, "tools", "smartstore"))
import build_smartstore_prep as bsp

PREP_CSV = os.path.join(REPO_ROOT, "data", "smartstore_prep", "smartstore_registration_prep.csv")
MISSING_JSON = os.path.join(REPO_ROOT, "reports", "data", "smartstore", "missing_fields_report.json")
DUP_JSON = os.path.join(REPO_ROOT, "reports", "data", "smartstore", "duplicate_ids_report.json")


class TestSmartstorePrep(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.master, cls.naver, cls.options = bsp.load_sheets()
        cls.records = bsp.build_prep(cls.master, cls.naver, bsp.build_option_summary(cls.options))

    def test_total_products(self):
        self.assertEqual(len(self.records), 4575)

    def test_unique_source_ids(self):
        ids = [r["공급처원본ID"] for r in self.records]
        self.assertEqual(len(ids), len(set(ids)))

    def test_all_have_name(self):
        self.assertTrue(all(r["상품명"] for r in self.records))

    def test_all_have_image(self):
        self.assertTrue(all(str(r["대표이미지URL"]).startswith("http") for r in self.records))

    def test_price_available_count(self):
        avail = sum(1 for r in self.records if r["판매가"] is not None)
        self.assertEqual(avail, 2117)

    def test_option_products(self):
        opt = sum(1 for r in self.records if (r["옵션수"] or 0) > 0)
        self.assertEqual(opt, 580)

    def test_missing_required_contains_category_for_all(self):
        for r in self.records:
            self.assertIn("카테고리번호", r["누락필수값"])

    def test_missing_required_contains_origin_for_all(self):
        for r in self.records:
            self.assertIn("원산지코드", r["누락필수값"])

    def test_missing_required_contains_as_template_for_all(self):
        for r in self.records:
            self.assertIn("ASTemplateCode", r["누락필수값"])

    def test_missing_required_contains_shipping_for_all(self):
        for r in self.records:
            self.assertIn("배송비", r["누락필수값"])

    def test_missing_required_contains_stock_for_all(self):
        for r in self.records:
            self.assertIn("재고수량", r["누락필수값"])

    def test_prep_ready_zero_before_customer_confirmation(self):
        # No product can be fully ready until customer confirms price/policy fields.
        ready = sum(1 for r in self.records if r["준비도"] == "ready")
        self.assertEqual(ready, 0)

    def test_classify_ready_logic(self):
        self.assertEqual(bsp.classify_ready([]), "ready")
        self.assertEqual(bsp.classify_ready(["판매가"]), "partial")
        self.assertEqual(bsp.classify_ready(["상품명"]), "blocked")

    def test_duplicate_report(self):
        dr = bsp.duplicate_report(self.master)
        self.assertEqual(dr["duplicate_key_count"], 0)
        self.assertEqual(dr["total_keys"], 4575)

    def test_missing_report_counts(self):
        mr = bsp.missing_fields_report(self.records)
        self.assertEqual(mr["total_products"], 4575)
        self.assertEqual(mr["price_available_count"], 2117)
        self.assertEqual(mr["price_missing_count"], 2458)
        self.assertEqual(mr["image_ok_count"], 4575)

    def test_prep_csv_exists_and_header(self):
        self.assertTrue(os.path.exists(PREP_CSV))
        with open(PREP_CSV, encoding="utf-8-sig", newline="") as f:
            reader = csv.reader(f)
            header = next(reader)
        self.assertEqual(header, bsp.PREP_COLUMNS)

    def test_prep_csv_row_count(self):
        with open(PREP_CSV, encoding="utf-8-sig", newline="") as f:
            rows = list(csv.DictReader(f))
        self.assertEqual(len(rows), 4575)

    def test_missing_report_file(self):
        self.assertTrue(os.path.exists(MISSING_JSON))
        with open(MISSING_JSON, encoding="utf-8") as f:
            mr = json.load(f)
        self.assertEqual(mr["total_products"], 4575)

    def test_dup_report_file(self):
        self.assertTrue(os.path.exists(DUP_JSON))
        with open(DUP_JSON, encoding="utf-8") as f:
            dr = json.load(f)
        self.assertEqual(dr["duplicate_key_count"], 0)


if __name__ == "__main__":
    unittest.main()
