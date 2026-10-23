import csv
import json
import os
import sys
import unittest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO_ROOT, "tools", "erp"))
import build_erp_prep as bep

PREP_CSV = os.path.join(REPO_ROOT, "data", "erp_prep", "ecount_item_bulk_prep.csv")


class TestErpPrep(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.master = bep.load_master()
        cls.records = bep.build_records(cls.master)

    def test_total(self):
        self.assertEqual(len(self.records), 4575)

    def test_unique_codes(self):
        codes = [r["품목코드"] for r in self.records]
        self.assertEqual(len(codes), len(set(codes)))

    def test_code_length(self):
        self.assertTrue(all(len(str(r["품목코드"])) <= 20 for r in self.records))

    def test_all_have_name(self):
        self.assertTrue(all(r["품목명"] for r in self.records))

    def test_price_available(self):
        avail = sum(1 for r in self.records if r["출고단가"] is not None)
        self.assertEqual(avail, 2117)

    def test_model_present(self):
        m = sum(1 for r in self.records if r["규격"])
        self.assertEqual(m, 1740)

    def test_manufacturer_present(self):
        m = sum(1 for r in self.records if r["제조사_cont4"])
        self.assertEqual(m, 2281)

    def test_brand_present(self):
        m = sum(1 for r in self.records if r["브랜드_cont2"])
        self.assertEqual(m, 4575)

    def test_image_ok(self):
        m = sum(1 for r in self.records if str(r["이미지URL"]).startswith("http"))
        self.assertEqual(m, 4575)

    def test_duplicate_report(self):
        dr = bep.duplicate_report(self.records)
        self.assertEqual(dr["duplicate_code_count"], 0)
        self.assertEqual(dr["too_long_codes"], 0)

    def test_missing_report(self):
        mr = bep.missing_report(self.records)
        self.assertEqual(mr["total_items"], 4575)
        self.assertEqual(mr["price_missing_count"], 2458)

    def test_prep_csv(self):
        self.assertTrue(os.path.exists(PREP_CSV))
        with open(PREP_CSV, encoding="utf-8-sig", newline="") as f:
            rows = list(csv.DictReader(f))
        self.assertEqual(len(rows), 4575)


if __name__ == "__main__":
    unittest.main()
