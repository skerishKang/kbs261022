"""스키마 / 정책(값이 없어야 할 자리를 채우지 않기) 단위 테스트."""

from __future__ import annotations

import copy
import json
import os
import unittest

from tools.product_master import build_records as BR
from tools.product_master import schema as SC
from tools.product_master import validate as VA

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SAMPLE = os.path.join(REPO_ROOT, "reports", "data", "product_master_sample.json")


def minimal_record(**overrides) -> dict:
    record = {
        "source_site": "samamusic",
        "source_product_id": "1299",
        "source_key": "samamusic:1299",
        "canonical_url": "https://samastore.co.kr/product/shure-sm58-k-lc/1299/",
        "collection_url": "https://www.samamusic.co.kr/product/detail.html?product_no=1299",
        "name": "SHURE SM58 K-LC 슈어 보컬용 유선 마이크 (스위치없음)",
        "brand": "SHURE",
        "manufacturer": None,
        "model": "SM58K-LC",
        "category_path": ["브랜드", "SHURE"],
        "category_namespace": "samamusic.cate_no",
        "category_path_cate_no": ["24", "671"],
        "category_leaf_cate_no": "671",
        "specs": {"원산지": "아시아 중국 또는 멕시코"},
        "options": [],
        "image_urls": [],
        "public_price": 197000,
        "public_price_text": "197,000원",
        "price_type": "public_selling_price",
        "dealer_price": None,
        "availability": None,
        "extraction_time": "2026-10-22T03:00:00Z",
        "extraction_method": "browser_zcode_iab",
        "brand_source": "spec",
        "manufacturer_source": "none",
        "source_evidence": {"url": "https://example.invalid"},
        "verification_status": "browser_verified",
        "derived": {},
        "naver_product_id": None,
        "erp_item_code": None,
        "smartstore_category_no": None,
        "mapping_ready": False,
        "quality_flags": [],
        "dedupe_group_id": None,
        "dedupe_confidence": None,
    }
    record.update(overrides)
    return record


class TestSchema(unittest.TestCase):
    def test_required_fields_are_present_in_master_fields(self) -> None:
        for field in SC.REQUIRED_FIELDS:
            self.assertIn(field, SC.MASTER_FIELDS)

    def test_composite_key_format(self) -> None:
        self.assertEqual(SC.source_key("samasound", "3875"), "samasound:3875")

    def test_csv_columns_cover_master_fields(self) -> None:
        self.assertEqual(set(SC.CSV_COLUMNS), set(SC.MASTER_FIELDS))

    def test_json_schema_is_serialisable_and_has_required(self) -> None:
        schema = SC.json_schema()
        json.dumps(schema, ensure_ascii=False)
        self.assertEqual(set(schema["required"]), set(SC.REQUIRED_FIELDS))

    def test_site_namespaces_are_distinct(self) -> None:
        namespaces = {s["namespace"] for s in SC.SITES.values()}
        self.assertEqual(len(namespaces), len(SC.SITES))
        self.assertIn("samasound.cate_no", namespaces)
        self.assertIn("samamusic.cate_no", namespaces)

    def test_cate_no_collision_is_documented(self) -> None:
        # cate_no=42 는 samasound 에서 Shure, samamusic 에서 스피커다.
        # 두 사이트의 42 가 같은 의미라는 전제가 없어야 한다.
        self.assertNotEqual(
            SC.SITES["samasound"]["namespace"], SC.SITES["samamusic"]["namespace"]
        )

    def test_csv_roundtrip(self) -> None:
        record = minimal_record()
        row = SC.to_csv_row(record)
        self.assertEqual(row["source_site"], "samamusic")
        self.assertEqual(row["specs"], json.dumps(record["specs"], ensure_ascii=False, sort_keys=True))
        self.assertEqual(row["dealer_price"], "")


class TestValidation(unittest.TestCase):
    def test_valid_record_passes(self) -> None:
        result = VA.validate_dataset([minimal_record()])
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["structural_error_count"], 0)
        self.assertEqual(result["policy_error_count"], 0)

    def test_missing_required_field_is_detected(self) -> None:
        record = minimal_record()
        del record["name"]
        errors = VA.validate_record(record)
        self.assertIn("missing_required_field:name", errors)

    def test_duplicate_composite_key_is_detected(self) -> None:
        result = VA.validate_dataset([minimal_record(), minimal_record()])
        self.assertFalse(result["ok"])
        self.assertEqual(result["unique_key_count"], 1)

    def test_invalid_extraction_time_is_detected(self) -> None:
        errors = VA.validate_record(minimal_record(extraction_time="2026-10-22"))
        self.assertTrue(any(e.startswith("invalid_extraction_time") for e in errors))


class TestNullPolicy(unittest.TestCase):
    def test_brand_not_offered_by_samasound_must_be_null(self) -> None:
        # samasound 에는 "브랜드" 스펙행이 없으므로 brand_source="spec" 는 위반이다.
        record = minimal_record(
            source_site="samasound",
            source_key="samasound:3875",
            category_namespace="samasound.cate_no",
            brand="Shure",
            brand_source="spec",
        )
        errors = VA.validate_policy(record)
        self.assertIn("brand_not_offered_by_site:'Shure'", errors)
        self.assertIn("brand_source_mismatch:'spec'!='category'", errors)

    def test_samasound_category_derived_brand_is_allowed(self) -> None:
        # 브랜드 카테고리에서 파생된 브랜드는 근거가 있으므로 허용된다.
        record = minimal_record(
            source_site="samasound",
            source_key="samasound:3875",
            category_namespace="samasound.cate_no",
            brand="Shure",
            brand_source="category",
            manufacturer="Shure",
            manufacturer_source="spec",
            model=None,
        )
        errors = VA.validate_policy(record)
        self.assertEqual(errors, [])

    def test_brand_without_source_is_rejected(self) -> None:
        record = minimal_record(brand_source=None)
        errors = VA.validate_policy(record)
        self.assertIn("brand_source_mismatch:None!='spec'", errors)

    def test_manufacturer_source_must_be_spec_when_value_present(self) -> None:
        record = minimal_record(manufacturer="Shure", manufacturer_source="none")
        errors = VA.validate_policy(record)
        self.assertIn("manufacturer_source_mismatch:'none'!='spec'", errors)

    def test_model_not_offered_by_samasound_must_be_null(self) -> None:
        record = minimal_record(
            source_site="samasound",
            source_key="samasound:3875",
            category_namespace="samasound.cate_no",
            model="WL185MB/C-TQG",
        )
        errors = VA.validate_policy(record)
        self.assertIn("model_not_offered_by_site:'WL185MB/C-TQG'", errors)

    def test_manufacturer_not_offered_by_samamusic_must_be_null(self) -> None:
        record = minimal_record(manufacturer="Shure", manufacturer_source="spec")
        errors = VA.validate_policy(record)
        self.assertIn("manufacturer_not_offered_by_site:'Shure'", errors)

    def test_dealer_price_must_stay_null(self) -> None:
        errors = VA.validate_policy(minimal_record(dealer_price=1000))
        self.assertIn("dealer_price_must_be_null:1000", errors)

    def test_availability_must_stay_null(self) -> None:
        errors = VA.validate_policy(minimal_record(availability="in_stock"))
        self.assertIn("availability_must_be_null:'in_stock'", errors)

    def test_inquiry_price_must_not_carry_number(self) -> None:
        errors = VA.validate_policy(
            minimal_record(public_price=1000, price_type="inquiry")
        )
        self.assertIn("inquiry_price_must_not_carry_number", errors)

    def test_store_mapping_must_be_null_before_store_opens(self) -> None:
        errors = VA.validate_policy(minimal_record(erp_item_code="E-1"))
        self.assertIn("erp_item_code_must_be_null_before_store_opens", errors)

    def test_category_namespace_mismatch_is_detected(self) -> None:
        errors = VA.validate_record(
            minimal_record(source_site="samamusic", category_namespace="samasound.cate_no")
        )
        self.assertTrue(any(e.startswith("category_namespace_mismatch") for e in errors))


class TestBuildRecords(unittest.TestCase):
    def test_missing_name_yields_no_record(self) -> None:
        dump = {
            "site": "samamusic",
            "source_product_id": "5523",
            "collection_url": "https://www.samamusic.co.kr/product/detail.html?product_no=5523",
            "final_url": "https://www.samamusic.co.kr/product/detail.html?product_no=5523",
            "raw_fields": {"판매가": "0원"},
        }
        self.assertIsNone(
            BR.build_record(dump, extraction_time="2026-10-22T03:00:00Z")
        )

    def test_site_field_map_keeps_manufacturer_and_brand_apart(self) -> None:
        dump = {
            "site": "samasound",
            "source_product_id": "3733",
            "collection_url": "https://www.samasound.co.kr/product/fender-studio-pro/3733/category/1/display/2/",
            "final_url": "https://www.samasound.co.kr/product/fender-studio-pro/3733/category/1/display/2/",
            "raw_fields": {
                "상품명": "Fender Studio Pro",
                "제조사": "PreSonus",
                "판매가": "가격 문의",
            },
        }
        record = BR.build_record(dump, extraction_time="2026-10-22T03:00:00Z")
        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record["manufacturer"], "PreSonus")
        self.assertIsNone(record["brand"])
        self.assertIsNone(record["model"])
        self.assertIsNone(record["public_price"])
        self.assertEqual(record["price_type"], "inquiry")


@unittest.skipUnless(os.path.exists(SAMPLE), "공개 샘플 파일이 아직 생성되지 않음")
class TestRealSamplePolicy(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.records = SC.load_json(SAMPLE)

    def test_sample_validates(self) -> None:
        result = VA.validate_dataset(self.records)
        self.assertTrue(result["ok"], VA.format_report(result))

    def test_samasound_records_have_no_brand_or_model(self) -> None:
        for record in self.records:
            if record["source_site"] == "samasound":
                self.assertIsNone(record["brand"])
                self.assertIsNone(record["model"])

    def test_samamusic_records_have_no_manufacturer(self) -> None:
        for record in self.records:
            if record["source_site"] == "samamusic":
                self.assertIsNone(record["manufacturer"])

    def test_samasound_public_price_is_never_a_number(self) -> None:
        for record in self.records:
            if record["source_site"] == "samasound":
                self.assertIsNone(record["public_price"])
                self.assertEqual(record["price_type"], "inquiry")

    def test_dealer_price_and_availability_always_null(self) -> None:
        for record in self.records:
            self.assertIsNone(record["dealer_price"])
            self.assertIsNone(record["availability"])


if __name__ == "__main__":
    unittest.main()
