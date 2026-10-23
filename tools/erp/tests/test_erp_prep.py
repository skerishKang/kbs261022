import csv
import json
import os
import sys
import unittest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO_ROOT, "tools", "erp"))
import build_erp_prep as bep
import validate_erp_prep as ver

UPLOAD_CSV = os.path.join(REPO_ROOT, "data", "erp_prep", "ecount_item_upload.csv")
UPLOAD_XLSX = os.path.join(REPO_ROOT, "data", "erp_prep", "ecount_item_upload.xlsx")
SPEC_JSON = os.path.join(REPO_ROOT, "reports", "data", "erp", "ecount_template_spec.json")


def valid_row(**overrides):
    row = {
        "품목코드": "SS-1",
        "품목명": "테스트 품목",
        "바코드": "",
        "규격구분": "1",
        "규격": "MODEL-1",
        "단위": "EA",
        "품목구분": "3",
        "세트여부": "0",
        "재고수량관리": "1",
        "입고단가": "",
        "입고단가 VAT포함여부": "0",
        "출고단가": "1000",
        "출고단가 VAT포함여부": "1",
        "부가세율(매출)": "10",
        "부가세율(매입)": "10",
        "검색창내용": "테스트 품목",
        "품목공유여부": "0",
    }
    row.update(overrides)
    return row


class TestErpPrep(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.master, cls.mapping = bep.load_source()
        cls.records, cls.stats = bep.build_records(cls.master, cls.mapping)

    def test_total(self):
        self.assertEqual(len(self.records), 4575)

    def test_unique_codes(self):
        codes = [record["품목코드"] for record in self.records]
        self.assertEqual(len(codes), len(set(codes)))

    def test_code_length_and_prefix(self):
        codes = [record["품목코드"] for record in self.records]
        self.assertTrue(all(len(code) <= 20 for code in codes))
        self.assertTrue(all(code.startswith(("SS-", "SM-")) for code in codes))
        self.assertEqual(sum(code.startswith("SS-") for code in codes), 2281)
        self.assertEqual(sum(code.startswith("SM-") for code in codes), 2294)

    def test_all_have_name_within_limit(self):
        self.assertTrue(all(record["품목명"] for record in self.records))
        self.assertTrue(all(len(record["품목명"]) <= 100 for record in self.records))

    def test_price_available(self):
        available = sum(1 for record in self.records if record["출고단가"] != "")
        self.assertEqual(available, 2117)

    def test_stock_management_split(self):
        managed = sum(1 for record in self.records if record["재고수량관리"] == "1")
        unmanaged = sum(1 for record in self.records if record["재고수량관리"] == "0")
        self.assertEqual(managed, 2294)
        self.assertEqual(unmanaged, 2281)

    def test_model_present(self):
        self.assertEqual(sum(1 for record in self.records if record["규격"]), 1740)

    def test_manufacturer_present(self):
        self.assertEqual(sum(1 for record in self.records if record["_manufacturer"]), 2281)

    def test_brand_present(self):
        self.assertEqual(sum(1 for record in self.records if record["_brand"]), 4575)

    def test_image_ok(self):
        self.assertEqual(sum(1 for record in self.records if record["_image"].startswith("http")), 4575)

    def test_barcode_only_when_unique(self):
        self.assertEqual(sum(1 for record in self.records if record["바코드"]), 2568)

    def test_duplicate_report(self):
        report = bep.duplicate_report(self.records)
        self.assertEqual(report["duplicate_code_count"], 0)
        self.assertEqual(report["too_long_codes"], 0)

    def test_missing_report(self):
        report = bep.missing_report(self.records, self.stats)
        self.assertEqual(report["total_items"], 4575)
        self.assertEqual(report["price_missing_count"], 2458)

    def test_upload_files(self):
        self.assertTrue(os.path.exists(UPLOAD_CSV))
        with open(UPLOAD_CSV, encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            self.assertEqual(reader.fieldnames, bep.ERP_UPLOAD_COLUMNS)
            self.assertEqual(len(list(reader)), 4575)
        header, rows = ver.read_xlsx_rows(UPLOAD_XLSX)
        self.assertEqual(header, bep.ERP_UPLOAD_COLUMNS)
        self.assertEqual(len(rows), 4575)

    def test_template_spec_matches(self):
        with open(SPEC_JSON, encoding="utf-8") as handle:
            spec = json.load(handle)
        self.assertEqual([column["header"] for column in spec["columns"]], bep.ERP_UPLOAD_COLUMNS)
        by_header = {column["header"]: column for column in spec["columns"]}
        self.assertEqual(set(by_header["품목구분"]["allowed"].values()), {"0", "1", "2", "3", "4", "7"})
        self.assertEqual(by_header["품목코드"]["max_length"], 20)
        self.assertEqual(by_header["입고단가"]["max_length"], 12)
        self.assertEqual(by_header["입고단가"]["decimal_places"], 6)


class TestValidator(unittest.TestCase):
    def test_valid_row_passes(self):
        errors, _ = ver.validate_rows([valid_row()], 1, ver.ERP_UPLOAD_COLUMNS)
        self.assertEqual(errors, [])

    def test_rejects_bad_allowed_value(self):
        errors, _ = ver.validate_rows([valid_row(품목구분="9")], 1)
        self.assertTrue(any("품목구분" in error for error in errors))

    def test_rejects_duplicate_codes(self):
        errors, _ = ver.validate_rows([valid_row(), valid_row()], 2)
        self.assertTrue(any("duplicate" in error for error in errors))

    def test_rejects_long_name(self):
        errors, _ = ver.validate_rows([valid_row(품목명="가" * 101)], 1)
        self.assertTrue(any("품목명" in error for error in errors))

    def test_rejects_bad_price(self):
        errors, _ = ver.validate_rows([valid_row(출고단가="1,000")], 1)
        self.assertTrue(any("출고단가" in error for error in errors))

    def test_rejects_set_item_for_non_goods(self):
        errors, _ = ver.validate_rows([valid_row(품목구분="0", 세트여부="1")], 1)
        self.assertTrue(any("세트여부" in error for error in errors))

    def test_accepts_blank_optional_cells(self):
        errors, _ = ver.validate_rows([valid_row(바코드="", 규격="", 입고단가="")], 1)
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
