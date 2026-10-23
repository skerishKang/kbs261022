"""이슈 #43 품질 규칙 집중 테스트.

기대값은 모두 실제 원본 표기(제조사/모델명/브랜드 스펙행)에서 가져온 합성 사례다.
원칙 검증에 집중한다: 근거 없는 값 생성 금지, 원본 보존, 자동화 범위 제한.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, ROOT)

from tools.product_quality import quality as Q  # noqa: E402


def record(site_label, product_id, name, brand, manufacturer="", model="",
           english_name=None, brand_row=None, price_value=None, price_state="inquiry_price"):
    site = {"삼아사운드": "samasound.co.kr", "삼아스토어": "samamusic.co.kr"}[site_label]
    specs = [{"label": "상품명", "value": name}]
    if manufacturer:
        specs.append({"label": "제조사", "value": manufacturer})
    if model:
        specs.append({"label": "모델명", "value": model})
    if english_name:
        specs.append({"label": "영문상품명", "value": english_name})
    if brand_row:
        specs.append({"label": "브랜드", "value": brand_row})
    return {
        "id": f"{site}:{product_id}",
        "name": name,
        "brand": brand,
        "brand_raw": brand,
        "brand_norm": Q._clean(brand).upper(),
        "manufacturer": manufacturer,
        "model": model,
        "category_path": ["홈", "믹서"],
        "category": {"id": "44", "name": "디지털 믹서", "list_url": "/x/"},
        "price": {"value": price_value, "text": "가격 문의" if price_value is None else f"{price_value:,}원",
                  "state": price_state},
        "availability": "{}",
        "images": ["https://example.invalid/a.png"],
        "specs": specs,
        "options": [],
        "source": {
            "site": site,
            "site_label": site_label,
            "product_id": str(product_id),
            "url": f"https://{site}/product/{product_id}/",
            "list_url": f"/p/{product_id}/",
            "verification_status": "http_verified",
        },
    }


FIXTURE = [
    # 삼아사운드: 제조사 스펙행 O, 모델명 스펙행 X
    record("삼아사운드", "1", "SM58 다이내믹 마이크", "SHURE", manufacturer="Shure"),
    record("삼아사운드", "2", "8010A 제네렉 스튜디오 모니터 스피커", "GENELEC",
           manufacturer="Genelec", english_name="8010A"),
    record("삼아사운드", "3", "주문 제작 스탠드", "자체제작", manufacturer="자체제작"),
    # 삼아스토어: 브랜드 스펙행 O, 모델명 스펙행 O, 제조사 스펙행 X
    record("삼아스토어", "1", "[SHURE] SM58 마이크", "SHURE", model="SM58", brand_row="SHURE",
           price_value=620000, price_state="public"),
    record("삼아스토어", "2", "기타 액세서리", "자체브랜드", brand_row="자체브랜드"),
]

CONFIRMED = [{"left_key": "samamusic.co.kr:1", "right_key": "samasound.co.kr:1", "shared_phrase": "SM58"}]


def build(fixture=FIXTURE, confirmed=CONFIRMED):
    pairs = [
        Q.DuplicateCandidate(
            verdict="confirmed", auto_mergeable=True,
            left_key=c["left_key"], left_name="", left_brand="", left_model="",
            right_key=c["right_key"], right_name="", right_brand="", right_model="",
            shared_phrase=c["shared_phrase"], name_similarity="1.0", variant_conflict="아니오",
            brand_agreement="예", reason="test", origin="test",
        )
        for c in confirmed
    ]
    return Q.build_result(fixture, confirmed, pairs)


class TestEvidence(unittest.TestCase):
    def setUp(self) -> None:
        self.result = build()
        self.by_key = {p["id"]: p for p in self.result.improved}

    def patch(self, key, field):
        return self.by_key[key]["patches"][field]

    def test_manufacturer_evidence_from_other_site_spec(self) -> None:
        evidence = Q.build_manufacturer_evidence(FIXTURE)
        self.assertTrue(evidence["SHURE"]["unique"])
        self.assertEqual(evidence["SHURE"]["candidates"], ["Shure"])

    def test_placeholder_manufacturer_is_not_evidence(self) -> None:
        evidence = Q.build_manufacturer_evidence(FIXTURE)
        self.assertNotIn("자체제작", evidence["SHURE"]["candidates"])
        self.assertNotIn("NNNN", evidence)

    def test_brand_placeholder_record_gets_no_auto_value(self) -> None:
        patch = self.patch("samamusic.co.kr:2", "manufacturer")
        self.assertEqual(patch["classification"], Q.CLASS_NONE)
        self.assertEqual(patch["proposed"], "")

    def test_model_inherited_only_from_confirmed_pair(self) -> None:
        patch = self.patch("samasound.co.kr:1", "model")
        self.assertEqual(patch["classification"], Q.CLASS_AUTO)
        self.assertEqual(patch["proposed"], "SM58")
        self.assertEqual(self.by_key["samasound.co.kr:1"]["model_after"], "SM58")

    def test_model_inheritance_requires_unique_value(self) -> None:
        conflicting = [
            {"left_key": "samamusic.co.kr:1", "right_key": "samasound.co.kr:2", "shared_phrase": "8010A"},
            {"left_key": "samamusic.co.kr:2", "right_key": "samasound.co.kr:2", "shared_phrase": "X1"},
        ]
        # samamusic.co.kr:2 (SM58) 와 samamusic... 모델명 두 개가 같은 상품으로 오면 승계하지 않는다.
        fixture = list(FIXTURE) + [record("삼아스토어", "9", "WL93", "SHURE", model="SM61", brand_row="SHURE")]
        confirmed = conflicting + [{"left_key": "samamusic.co.kr:9", "right_key": "samasound.co.kr:2",
                                    "shared_phrase": "8010A"}]
        result = build(fixture, confirmed)
        target = next(p for p in result.improved if p["id"] == "samasound.co.kr:2")
        self.assertIn(target["patches"]["model"]["classification"], (Q.CLASS_REVIEW, Q.CLASS_NONE))
        self.assertEqual(target["model_after"], target["model_before"])

    def test_english_name_is_review_not_auto(self) -> None:
        result = build(FIXTURE, confirmed=[])
        target = next(p for p in result.improved if p["id"] == "samasound.co.kr:2")
        self.assertEqual(target["patches"]["model"]["classification"], Q.CLASS_REVIEW)
        self.assertEqual(target["patches"]["model"]["proposed"], "8010A")
        self.assertEqual(target["model_after"], "", "검토후보 값은 자동 반영하지 않는다")

    def test_placeholder_manufacturer_value_is_review_not_auto(self) -> None:
        patch = self.patch("samasound.co.kr:3", "manufacturer")
        self.assertEqual(patch["classification"], Q.CLASS_REVIEW)
        self.assertIn("manufacturer_placeholder", self.by_key["samasound.co.kr:3"]["quality_flags"])

    def test_existing_source_value_is_not_actionable(self) -> None:
        patch = Q.manufacturer_patch(FIXTURE[0], Q.build_manufacturer_evidence(FIXTURE))
        self.assertEqual(patch.classification, Q.CLASS_AUTO)
        self.assertFalse(patch.actionable)


class TestPolicy(unittest.TestCase):
    def setUp(self) -> None:
        self.result = build()

    def test_price_and_stock_are_never_invented(self) -> None:
        for original, improved in zip(FIXTURE, self.result.improved):
            self.assertEqual(improved["price_original"], original["price"]["value"])
            self.assertEqual(improved["price_state_original"], original["price"]["state"])
            self.assertEqual(improved["id"], original["id"])

    def test_record_count_preserved(self) -> None:
        self.assertEqual(self.result.master_count, len(FIXTURE))
        self.assertEqual(len(self.result.improved), len(FIXTURE))

    def test_duplicates_are_never_merged(self) -> None:
        self.assertEqual(self.result.summary["policy"]["duplicates_merged"], 0)
        for dup in self.result.duplicates:
            self.assertEqual(dup.resolution, "검토 대기")

    def test_summary_partition_is_closed(self) -> None:
        for field_name, buckets in self.result.summary["patch_classification"].items():
            actionable = [p for p in self.result.patches if p.field == field_name and p.actionable]
            self.assertEqual(sum(buckets.values()), len(actionable), field_name)

    def test_missing_after_never_exceeds_missing_before(self) -> None:
        for field_name in ("model", "manufacturer"):
            self.assertLessEqual(self.result.summary["missing_after"][field_name],
                                 self.result.summary["missing_before"][field_name])

    def test_auto_corrected_fields_match_applied_records(self) -> None:
        counts = {"model": 0, "manufacturer": 0, "brand": 0}
        for record_out in self.result.improved:
            for field_name in counts:
                if field_name in record_out["changed_fields"]:
                    counts[field_name] += 1
        self.assertEqual(self.result.summary["auto_corrected_fields"], counts)


class TestSameSiteDuplicates(unittest.TestCase):
    def test_exact_same_site_pair_is_flagged_not_merged(self) -> None:
        fixture = [
            record("삼아스토어", "10", "KSM32 마이크", "SHURE", brand_row="SHURE"),
            record("삼아스토어", "11", "KSM32 마이크", "SHURE", brand_row="SHURE"),
        ]
        found = Q.same_site_duplicates(fixture)
        self.assertEqual(len(found), 1)
        self.assertFalse(found[0].auto_mergeable)
        self.assertEqual(found[0].verdict, "same_site_exact")

    def test_different_names_are_not_duplicates(self) -> None:
        fixture = [
            record("삼아스토어", "12", "KSM32 마이크", "SHURE", brand_row="SHURE"),
            record("삼아스토어", "13", "SM58 마이크", "SHURE", brand_row="SHURE"),
        ]
        self.assertEqual(Q.same_site_duplicates(fixture), [])


@unittest.skipUnless(
    os.path.exists(os.path.join(ROOT, "site", "data", "products.json")),
    "원본 마스터가 있는 작업 환경에서만 실행",
)
class TestRealMaster(unittest.TestCase):
    """실 데이터 4,575건 대상 무결성 회귀."""

    @classmethod
    def setUpClass(cls) -> None:
        from tools.product_quality import build_quality as B
        from tools.product_quality import verify_review as V

        cls.master_path = os.path.join(ROOT, "site", "data", "products.json")
        with io.open(cls.master_path, "rb") as handle:
            cls.sha_before = hashlib.sha256(handle.read()).hexdigest()
        cls.master = B.load_master(cls.master_path)
        cls.master_pairs, cls.confirmed_pairs = B.load_duplicate_sheet(
            os.path.join(ROOT, "data", "full_catalog", "product_db.xlsx")
        )
        cls.result = Q.build_result(cls.master, cls.confirmed_pairs, cls.master_pairs)
        cls.stage2_result = Q.build_result(cls.master, cls.confirmed_pairs, cls.master_pairs)
        cls.stage2 = V.apply(cls.stage2_result, cls.master)
        cls.tmp = tempfile.mkdtemp(prefix="pq43-")
        cls.out = os.path.join(cls.tmp, "product_quality")
        B.main(["--out-dir", cls.out, "--quiet"])
        with io.open(cls.master_path, "rb") as handle:
            cls.sha_after = hashlib.sha256(handle.read()).hexdigest()

    def test_original_master_is_4575_and_untouched(self) -> None:
        self.assertEqual(len(self.master), 4575)
        self.assertEqual(self.sha_before, self.sha_after)

    def test_all_artifacts_generated(self) -> None:
        for name in B_FILES:
            self.assertTrue(os.path.getsize(os.path.join(self.out, name)) > 0, name)

    def test_improved_output_matches_master_keys(self) -> None:
        with io.open(os.path.join(self.out, "product_quality_improved.json"), encoding="utf-8") as handle:
            payload = json.load(handle)
        self.assertEqual(payload["original_products"], 4575)
        self.assertEqual(len(payload["products"]), 4575)
        self.assertEqual([p["id"] for p in payload["products"]], [r["id"] for r in self.master])

    def test_no_value_applied_without_auto_classification(self) -> None:
        for rec in self.result.improved:
            for field_name in ("model", "manufacturer"):
                if rec[f"{field_name}_before"] == rec[f"{field_name}_after"]:
                    continue
                self.assertEqual(rec["patches"][field_name]["classification"], Q.CLASS_AUTO, rec["id"])
                self.assertTrue(rec["patches"][field_name]["evidence_type"], rec["id"])
                self.assertTrue(rec["patches"][field_name]["evidence_url"], rec["id"])

    def test_yamaha_rows_not_recollected_or_duplicated(self) -> None:
        self.assertEqual(self.result.summary["policy"]["yamaha_673_recollected"], False)
        self.assertEqual(self.result.summary["policy"]["new_scraping_performed"], False)

    def test_price_state_distribution_preserved(self) -> None:
        from collections import Counter

        before = Counter((r.get("price") or {}).get("state") for r in self.master)
        after = Counter(r["price_state_original"] for r in self.result.improved)
        self.assertEqual(before, after)


B_FILES = [
    "product_quality_patch_candidates.csv",
    "product_duplicate_candidates.csv",
    "product_quality_improved.json",
    "product_quality_summary.json",
    "product_quality_review.xlsx",
    "product_quality_stage2_verification.csv",
]

if __name__ == "__main__":
    unittest.main(verbosity=2)
