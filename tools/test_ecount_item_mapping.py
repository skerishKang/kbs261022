from __future__ import annotations

import csv
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
FIXTURES = ROOT / "backend" / "test" / "fixtures" / "ecount-item-mapping"
sys.path.insert(0, str(TOOLS))

import ecount_item_mapping as mapping  # noqa: E402


class EcountItemMappingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.products = mapping.load_products(FIXTURES / "shop_products.json")

    def test_korean_header_csv_has_thirty_fake_items(self) -> None:
        items = mapping.read_ecount_items(FIXTURES / "fake_items_korean.csv")
        self.assertEqual(len(items), 30)
        self.assertEqual(items[0]["code"], "FAKE-001")
        self.assertEqual(items[0]["spec"], "AH-SQ5-REV-B")
        self.assertEqual(items[0]["unit"], "EA")
        self.assertEqual(items[0]["barcode"], "880000000001")

    def test_api_field_xlsx_has_thirty_fake_items(self) -> None:
        items = mapping.read_ecount_items(FIXTURES / "fake_items_api_fields.xlsx")
        self.assertEqual(len(items), 30)
        self.assertEqual(items[0]["code"], "FAKE-001")
        self.assertEqual(items[0]["name"], self.products[0]["name"])

    def test_exact_model_match_ranks_before_exact_barcode_for_both_exports(self) -> None:
        for filename in ("fake_items_korean.csv", "fake_items_api_fields.xlsx"):
            with self.subTest(filename=filename):
                rows = mapping.score_candidates(self.products, mapping.read_ecount_items(FIXTURES / filename))
                result = next(row for row in rows if row["shop_product_id"] == "fake-shop-model-exact")
                self.assertEqual(result["candidate1_code"], "FAKE-001")
                self.assertIn("model exact", result["candidate1_evidence"])
                self.assertEqual(result["candidate2_code"], "FAKE-002")
                self.assertIn("barcode exact", result["candidate2_evidence"])

    def test_normalized_name_match_ignores_case_spaces_hyphen_and_parentheses(self) -> None:
        rows = mapping.score_candidates(self.products, mapping.read_ecount_items(FIXTURES / "fake_items_korean.csv"))
        result = next(row for row in rows if row["shop_product_id"] == "fake-shop-name-format")
        self.assertEqual(result["candidate1_code"], "FAKE-003")
        self.assertEqual(result["model"], "QU-6")
        self.assertIn("model exact", result["candidate1_evidence"])
        self.assertEqual(result["recommendation"], "\uCD94\uCC9C")

    def test_barcode_match_ranks_before_a_similar_name(self) -> None:
        rows = mapping.score_candidates(self.products, mapping.read_ecount_items(FIXTURES / "fake_items_api_fields.xlsx"))
        result = next(row for row in rows if row["shop_product_id"] == "fake-shop-barcode")
        self.assertEqual(result["candidate1_code"], "FAKE-004")
        self.assertIn("barcode exact", result["candidate1_evidence"])

    def test_no_candidate_leaves_all_candidate_columns_blank(self) -> None:
        rows = mapping.score_candidates(self.products, mapping.read_ecount_items(FIXTURES / "fake_items_korean.csv"))
        result = next(row for row in rows if row["shop_product_id"] == "fake-shop-no-candidate")
        for index in range(1, 4):
            self.assertEqual(result[f"candidate{index}_code"], "")

    def test_equal_scores_sort_stably_by_ecount_code(self) -> None:
        rows = mapping.score_candidates(self.products, mapping.read_ecount_items(FIXTURES / "fake_items_korean.csv"))
        result = next(row for row in rows if row["shop_product_id"] == "fake-shop-score-tie")
        self.assertEqual(result["candidate1_code"], "TIE-001")
        self.assertEqual(result["candidate2_code"], "TIE-002")
        self.assertEqual(result["candidate1_score"], result["candidate2_score"])

    def test_review_csv_has_blank_approval_column(self) -> None:
        rows = mapping.score_candidates(self.products, mapping.read_ecount_items(FIXTURES / "fake_items_korean.csv"))
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "review.csv"
            mapping.write_candidates(output, rows)
            with output.open(encoding="utf-8-sig", newline="") as handle:
                records = list(csv.DictReader(handle))
            self.assertEqual(len(records), len(self.products))
            self.assertEqual(records[0]["\uC2B9\uC778"], "")
            self.assertIn("\uCD94\uCC9C", records[0])

    def test_model_extraction_normalizes_common_label_variants(self) -> None:
        cases = {
            "QU-5": "QU5",
            "qu 5": "QU5",
            "CQ-18T": "CQ18T",
            "CQ 18 t": "CQ18T",
            "SQ5+": "SQ5+",
            "SQ 5 +": "SQ5+",
            "ME-500": "ME500",
            "64x64": "64X64",
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertIn(expected, mapping.extract_model_mentions(text)[0])

    def test_qu7_and_cq12_do_not_recommend_different_model_numbers(self) -> None:
        cases = [
            ("QU-7 (NEW)", "qu 6 new"),
            ("CQ-12T", "CQ-18T"),
        ]
        for index, (shop_name, ecount_name) in enumerate(cases):
            with self.subTest(shop=shop_name, ecount=ecount_name):
                product = mapping.product_record({"id": f"model-conflict-{index}", "name": shop_name, "model": ""})
                item = {"code": f"BAD-{index}", "name": ecount_name, "spec": "", "unit": "EA", "barcode": ""}
                result = mapping.score_candidates([product], [item])[0]
                self.assertEqual(result["candidate1_code"], "")
                self.assertEqual(result["recommendation"], "")

    def test_qu7_does_not_get_the_qu6_candidate_from_the_mixed_fixture(self) -> None:
        rows = mapping.score_candidates(self.products, mapping.read_ecount_items(FIXTURES / "fake_items_korean.csv"))
        result = next(row for row in rows if row["shop_product_id"] == "fake-shop-qu7-number-conflict")
        self.assertNotIn(result["candidate1_code"], {"FAKE-003", "FAKE-CAT-006"})

    def test_suffix_mismatch_is_retained_only_as_low_confidence_with_evidence(self) -> None:
        product = mapping.product_record({"id": "sq5", "name": "SQ5", "model": ""})
        item = {"code": "SQ5-PLUS", "name": "SQ5+", "spec": "", "unit": "EA", "barcode": ""}
        result = mapping.score_candidates([product], [item])[0]
        self.assertEqual(result["candidate1_code"], "SQ5-PLUS")
        self.assertLessEqual(int(result["candidate1_score"]), 30)
        self.assertIn("\uBAA8\uB378 \uC811\uBBF8 \uD45C\uAE30 \uBD88\uC77C\uCE58", result["candidate1_evidence"])
        self.assertEqual(result["recommendation"], "")

    def test_solo_suffix_presence_is_penalized(self) -> None:
        product = mapping.product_record({"id": "avantis", "name": "Avantis", "model": ""})
        item = {"code": "AVANTIS-SOLO", "name": "Avantis Solo", "spec": "", "unit": "EA", "barcode": ""}
        result = mapping.score_candidates([product], [item])[0]
        self.assertEqual(result["candidate1_code"], "AVANTIS-SOLO")
        self.assertLessEqual(int(result["candidate1_score"]), 30)
        self.assertIn("\uBAA8\uB378 \uC811\uBBF8 \uD45C\uAE30 \uBD88\uC77C\uCE58", result["candidate1_evidence"])

    def test_recommendation_requires_exact_model_and_a_fifteen_point_margin(self) -> None:
        exact = {"model_exact": True, "numeric_conflict": False, "suffix_mismatch": False, "score": "100"}
        self.assertEqual(mapping.recommendation_for(exact, {"score": "85"}), "\uCD94\uCC9C")
        self.assertEqual(mapping.recommendation_for(exact, {"score": "86"}), "")
        self.assertEqual(mapping.recommendation_for({**exact, "model_exact": False}, None), "")
        self.assertEqual(mapping.recommendation_for({**exact, "numeric_conflict": True}, None), "")


if __name__ == "__main__":
    unittest.main()
