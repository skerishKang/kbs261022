"""중복 판정 / 자동 병합 규칙 단위 테스트.

핵심: "확신 부족한 중복은 자동 병합하지 않는다" (issue #8 요구사항 3).
"""

from __future__ import annotations

import json
import os
import unittest

from tools.product_master import dedupe as DD
from tools.product_master import schema as SC

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SAMPLE = os.path.join(REPO_ROOT, "reports", "data", "product_master_sample.json")


def make_record(
    site: str,
    product_id: str,
    name: str,
    *,
    model: str | None = None,
    brand: str | None = None,
    manufacturer: str | None = None,
    public_price: int | None = None,
) -> dict:
    from tools.product_master import normalize as N

    derived = {
        "model_phrases": N.model_phrases(name, brand=brand, source_model=model),
        "model_phrase_compact": sorted(
            {c for c in (N.model_compact(p) for p in N.model_phrases(name, brand=brand, source_model=model)) if c}
        ),
        "variant_signature": sorted(N.variant_signature(name)),
    }
    return {
        "source_site": site,
        "source_product_id": product_id,
        "source_key": SC.source_key(site, product_id),
        "name": name,
        "brand": brand,
        "manufacturer": manufacturer,
        "model": model,
        "public_price": public_price,
        "derived": derived,
    }


def verdict_of(records, left_key, right_key) -> str:
    candidates = DD.find_candidates(records)
    for candidate in candidates:
        if {candidate.left["source_key"], candidate.right["source_key"]} == {left_key, right_key}:
            return candidate.verdict
    return "no_candidate"


class TestCrossSiteMatching(unittest.TestCase):
    def test_unique_model_on_both_sites_is_confirmed(self) -> None:
        records = [
            make_record("samasound", "3875", "WL185MB/C-TQG", manufacturer="Shure"),
            make_record(
                "samamusic",
                "5557",
                "SHURE WL185MB/C-TQG 무선용 단일 지향성 핀마이크 블랙",
                model="WL185MB/C-TQG",
                brand="SHURE",
                public_price=279000,
            ),
        ]
        self.assertEqual(verdict_of(records, "samasound:3875", "samamusic:5557"), "confirmed")

    def test_model_field_equality_is_confirmed(self) -> None:
        records = [
            make_record("samasound", "3823", "SHURE KSM40C 슈어 프리미엄 스튜디오 콘덴서 마이크", manufacturer="Shure"),
            make_record(
                "samamusic",
                "5492",
                "SHURE KSM40C 슈어 프리미엄 스튜디오 콘덴서 마이크",
                model="KSM40C",
                brand="SHURE",
                public_price=1830000,
            ),
        ]
        self.assertEqual(verdict_of(records, "samasound:3823", "samamusic:5492"), "confirmed")

    def test_spacing_difference_still_matches(self) -> None:
        # samasound "MVX2U G2" vs samamusic "MVX2UG2 (2세대)"
        records = [
            make_record("samasound", "3863", "MVX2U G2", manufacturer="Shure"),
            make_record(
                "samamusic",
                "5611",
                "SHURE MVX2UG2 2세대 슈어 XLR to USB-C 오디오 인터페이스 (모바일 지원)",
                model="MVX2UG2 (2세대)",
                brand="SHURE",
                public_price=237000,
            ),
        ]
        self.assertEqual(verdict_of(records, "samasound:3863", "samamusic:5611"), "confirmed")

    def test_variant_conflict_is_not_merged(self) -> None:
        # 같은 모델(KSM32C)의 라이트 세트와 프리미엄 세트는 다른 상품이다.
        records = [
            make_record("samasound", "3825", "SHURE KSM32C 슈어 스튜디오 콘덴서 마이크 라이트 세트", manufacturer="Shure"),
            make_record(
                "samamusic",
                "5491",
                "SHURE KSM32C 슈어 스튜디오 콘덴서 마이크 프리미엄 세트",
                model="KSM32C/SM",
                brand="SHURE",
                public_price=1510000,
            ),
        ]
        self.assertEqual(verdict_of(records, "samasound:3825", "samamusic:5491"), "candidate")

    def test_prefix_models_are_not_confused(self) -> None:
        # SLXD4+ 와 SLXD4D+ 는 다른 상품이다.
        records = [
            make_record("samasound", "3737", "SLXD4+", manufacturer="Shure"),
            make_record(
                "samamusic",
                "5525",
                "SHURE SLXD4D+ 듀얼채널 다이버시티 수신기",
                brand="SHURE",
                public_price=2300000,
            ),
        ]
        self.assertEqual(verdict_of(records, "samasound:3737", "samamusic:5525"), "no_candidate")

    def test_inclusion_mention_is_not_a_match(self) -> None:
        # samamusic 상품이 WL93 을 "포함"하는 세트일 뿐, WL93 자체 상품이 아니다.
        records = [
            make_record("samasound", "3868", "WL93", manufacturer="Shure"),
            make_record(
                "samamusic",
                "4344",
                "SHURE GLXD14R+/93 슈어 GLXD+ 1채널 랙 장착형 바디팩 무선 마이크 세트 WL93 포함",
                brand="SHURE",
                public_price=1457000,
            ),
        ]
        self.assertEqual(verdict_of(records, "samasound:3868", "samamusic:4344"), "no_candidate")

    def test_only_confirmed_is_auto_merged(self) -> None:
        records = [
            make_record("samasound", "3825", "SHURE KSM32C 슈어 스튜디오 콘덴서 마이크 라이트 세트", manufacturer="Shure"),
            make_record("samasound", "3824", "SHURE KSM32C 슈어 스튜디오 콘덴서 마이크 프리미엄 세트", manufacturer="Shure"),
            make_record(
                "samamusic",
                "5490",
                "SHURE KSM32C 슈어 스튜디오 콘덴서 마이크 라이트 세트",
                model="KSM32C/HM",
                brand="SHURE",
                public_price=1370000,
            ),
            make_record(
                "samamusic",
                "5491",
                "SHURE KSM32C 슈어 스튜디오 콘덴서 마이크 프리미엄 세트",
                model="KSM32C/SM",
                brand="SHURE",
                public_price=1510000,
            ),
        ]
        candidates = DD.find_candidates(records)
        groups = DD.build_groups(records, candidates)
        members = {frozenset(v) for v in groups.values()}
        self.assertIn(frozenset({"samamusic:5490", "samasound:3825"}), members)
        self.assertIn(frozenset({"samamusic:5491", "samasound:3824"}), members)
        # 라이트 세트와 프리미엄 세트가 한 그룹에 묶이면 안 된다.
        for group in members:
            self.assertNotIn(frozenset({"samamusic:5490", "samasound:3824"}), members)
            self.assertNotIn(frozenset({"samamusic:5491", "samasound:3825"}), members)
        self.assertEqual(len(groups), 2)

    def test_low_confidence_is_never_auto_merged(self) -> None:
        for candidate in DD.find_candidates(
            [
                make_record("samasound", "1", "A"),
                make_record("samamusic", "2", "B"),
            ]
        ):
            self.assertFalse(candidate.auto_mergeable)


class TestSameSite(unittest.TestCase):
    def test_duplicate_composite_key_is_detected(self) -> None:
        records = [
            make_record("samasound", "3875", "WL185MB/C-TQG"),
            make_record("samasound", "3875", "WL185MB/C-TQG"),
        ]
        dupes = DD.find_same_site_duplicates(records)
        self.assertEqual(len(dupes), 1)


@unittest.skipUnless(os.path.exists(SAMPLE), "공개 샘플 파일이 아직 생성되지 않음")
class TestRealSample(unittest.TestCase):
    """브라우저로 실제 확인한 29건 공개 샘플 기반 검증."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.records = SC.load_json(SAMPLE)

    def test_sample_has_both_sites(self) -> None:
        sites = {r["source_site"] for r in self.records}
        self.assertEqual(sites, {"samasound", "samamusic"})

    def test_sample_size(self) -> None:
        self.assertGreaterEqual(len(self.records), 20)

    def test_no_same_site_duplicates(self) -> None:
        self.assertEqual(DD.find_same_site_duplicates(self.records), [])

    def test_confirmed_pairs_exist(self) -> None:
        candidates = DD.find_candidates(self.records)
        confirmed = [c for c in candidates if c.verdict == "confirmed"]
        self.assertGreaterEqual(len(confirmed), 5)

    def test_no_merged_group_contains_a_variant_conflict(self) -> None:
        candidates = DD.find_candidates(self.records)
        groups = DD.build_groups(self.records, candidates)
        by_key = {r["source_key"]: r for r in self.records}
        for members in groups.values():
            names = [by_key[k]["name"] for k in members]
            self.assertFalse(
                any("라이트" in n and "프리미엄" in m for n in names for m in names if n != m),
                f"변형이 다른 상품이 같은 그룹에 묶임: {names}",
            )


if __name__ == "__main__":
    unittest.main()
