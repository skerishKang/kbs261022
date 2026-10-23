import csv
import io
import json
import os
import sys
import tempfile
import unittest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO_ROOT, "tools", "procurement"))
import g2b_bid_analysis as gba
import g2b_bid_classifier as classifier

DATA = os.path.join(REPO_ROOT, "data", "procurement", "g2b_real_bids.json")
ENRICHMENT = os.path.join(
    REPO_ROOT, "reports", "data", "procurement", "g2b_detail_enrichment.json"
)


class TestClassificationRules(unittest.TestCase):
    def test_audio_console_purchase_is_direct(self):
        result = classifier.classify_av(
            "세종문화회관 대극장 노후 음향콘솔 교체 입찰 공고",
            ["오디오믹서,증폭기결합"],
        )
        self.assertEqual(result["av_class"], "A")

    def test_school_broadcast_equipment_purchase_is_direct(self):
        result = classifier.classify_av(
            "2026학년도 오현초등학교 방송장비 구매 및 설치",
            ["구내방송장치"],
        )
        self.assertEqual(result["av_class"], "A")

    def test_construction_supply_exemption_is_direct(self):
        result = classifier.classify_av(
            "(가칭)동탄13중 신축 통신공사 직접구매자재(방송장치) 구매",
            ["구내방송장치"],
        )
        self.assertEqual(result["av_class"], "A")

    def test_item_mismatch_downgrades_to_review(self):
        result = classifier.classify_av(
            "2026학년도 학과별 디스플레이 및 영상·음향 설비 구매·설치",
            ["전자복사칠판및액세서리"],
        )
        self.assertEqual(result["av_class"], "B")
        self.assertIn("비(非)음향/AV", result["av_reason"])

    def test_missing_item_data_does_not_downgrade(self):
        result = classifier.classify_av("수업용 음향시스템 구매", [])
        self.assertEqual(result["av_class"], "A")

    def test_rental_service_is_review(self):
        result = classifier.classify_av("2026 이천펫축제 음향장비 및 행사물품 임차 용역")
        self.assertEqual(result["av_class"], "B")
        self.assertIn("임차", result["av_reason"])

    def test_special_broadcast_is_review(self):
        result = classifier.classify_av("2026년 수동터널 비상방송 스피커 제조구매(설치포함)")
        self.assertEqual(result["av_class"], "B")
        self.assertIn("특수 방송설비", result["av_reason"])

    def test_construction_included_broadcast_is_review(self):
        result = classifier.classify_av("2026년 전통시장 CCTV 및 방송설비 설치(전기)")
        self.assertEqual(result["av_class"], "B")
        self.assertIn("공사", result["av_reason"])

    def test_lighting_is_review(self):
        result = classifier.classify_av("인천문화예술회관 무대조명 무빙라이트 구매")
        self.assertEqual(result["av_class"], "B")
        self.assertEqual(result["av_reason"], "무대조명 장비")

    def test_surveillance_is_not_relevant(self):
        result = classifier.classify_av(
            "경의선 남가좌리 건널목 외 93개소 지장물검지 지능형 영상분석시스템 구매설치"
        )
        self.assertEqual(result["av_class"], "C")

    def test_medical_acoustics_is_not_relevant(self):
        result = classifier.classify_av("[의료기기] 음향코통기도 검사기 1SET 구매")
        self.assertEqual(result["av_class"], "C")

    def test_stage_curtain_is_not_relevant(self):
        result = classifier.classify_av("부산오페라하우스 건립 관급자재(무대막) 구매·설치")
        self.assertEqual(result["av_class"], "C")

    def test_content_production_is_not_relevant(self):
        result = classifier.classify_av("2026년 도시 브랜드 홍보 영상 제작 용역")
        self.assertEqual(result["av_class"], "C")

    def test_place_name_is_not_relevant(self):
        result = classifier.classify_av("진전면 상촌영상골천 제방정비공사")
        self.assertEqual(result["av_class"], "C")

    def test_broadcast_line_is_review(self):
        result = classifier.classify_av("tbn 전국 네트워크 방송전용회선 구축")
        self.assertEqual(result["av_class"], "B")

    def test_empty_title_is_not_relevant(self):
        result = classifier.classify_av("")
        self.assertEqual(result["av_class"], "C")


class TestLifecycleAndDuplicates(unittest.TestCase):
    def test_same_day_deadline_is_open(self):
        lifecycle = classifier._lifecycle("2026-10-23 10:00:00", "등록공고", "2026-10-23")
        self.assertEqual(lifecycle["state"], "open")
        self.assertEqual(lifecycle["days_left"], 0)

    def test_past_deadline_is_closed(self):
        lifecycle = classifier._lifecycle("2026-10-22 10:00:00", "등록공고", "2026-10-23")
        self.assertEqual(lifecycle["state"], "closed")

    def test_cancelled_status_is_not_open(self):
        lifecycle = classifier._lifecycle("2026-10-30 10:00:00", "취소공고", "2026-10-23")
        self.assertEqual(lifecycle["state"], "cancelled")
        self.assertFalse(lifecycle["is_open"])

    def test_missing_deadline_is_unknown(self):
        lifecycle = classifier._lifecycle(None, "등록공고", "2026-10-23")
        self.assertEqual(lifecycle["state"], "unknown")
        self.assertIsNone(lifecycle["is_open"])

    def test_anomalous_deadline_is_unknown(self):
        lifecycle = classifier._lifecycle("2037-03-28 18:00:00", "변경공고", "2026-10-23")
        self.assertEqual(lifecycle["state"], "unknown")

    def test_duplicate_title_group(self):
        info, groups = classifier._duplicate_map([
            {"bid_no": "A1", "title": "세종 음향콘솔 교체"},
            {"bid_no": "A2", "title": "세종  음향콘솔 교체"},
            {"bid_no": "B1", "title": "다른 공고"},
        ])
        self.assertEqual(len(groups), 1)
        self.assertEqual(info["A1"]["duplicate_group_size"], 2)
        self.assertEqual(info["A2"]["duplicate_group_id"], "A1")


class TestEnrichmentMerge(unittest.TestCase):
    def test_unavailable_detail_does_not_assert_no_restriction(self):
        records, _ = classifier.build_records(
            [{"bid_no": "X1", "title": "음향장비 구매", "status": "등록공고"}],
            {"X1": {"bid_no": "X1", "fetch_status": "error"}},
        )
        record = records[0]
        self.assertEqual(record["av_class"], "A")
        self.assertEqual(record["detail_status"], "unavailable")
        self.assertIsNone(record["region_restricted"])
        self.assertIsNone(record["license_restricted"])
        self.assertEqual(record["estimated_price_status"], "detail_unavailable")
        self.assertIn("원문 확인", record["qualification_note"])

    def test_amount_placeholder_is_flagged(self):
        records, _ = classifier.build_records(
            [{"bid_no": "X2", "title": "방송장비 교체", "status": "등록공고"}],
            {"X2": {"bid_no": "X2", "fetch_status": "ok", "estimated_price": 1,
                    "region_restricted": "N", "license_restricted": "N"}},
        )
        self.assertEqual(records[0]["estimated_price_status"], "placeholder")
        self.assertIn("amount_unconfirmed", records[0]["review_flags"])


class TestRealDataset(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(DATA, encoding="utf-8") as handle:
            raw = json.load(handle)["bids"]
        cls.bids = gba.normalize(raw, "file:test")
        cls.enrichment = classifier.load_enrichment(ENRICHMENT)
        cls.records, cls.groups = classifier.build_records(
            cls.bids, cls.enrichment, "2026-10-23"
        )
        cls.legacy = [bid for bid in cls.bids if bid["cgi_relevant"]]
        cls.stats = classifier.build_stats(
            cls.records, cls.legacy, cls.enrichment, "2026-10-23"
        )

    def test_dataset_shape(self):
        self.assertEqual(len(self.records), 384)
        self.assertEqual(self.stats["valid_bids"], 384)
        self.assertEqual(len(self.enrichment), 384)

    def test_detail_availability(self):
        self.assertEqual(self.stats["detail_counts"]["ok"], 337)
        self.assertEqual(self.stats["detail_counts"]["unavailable"], 47)

    def test_classification_counts(self):
        counts = {code: self.stats["classification"][code]["count"] for code in "ABC"}
        self.assertEqual(counts, {"A": 27, "B": 52, "C": 305})

    def test_known_direct_leads(self):
        by_no = {record["bid_no"]: record for record in self.records}
        for bid_no in ("R26BK01787191", "R26BK01781066", "R26BK01763002",
                       "R26BK01785428", "2026LNJ002239962"):
            self.assertEqual(by_no[bid_no]["av_class"], "A", bid_no)

    def test_known_non_relevant(self):
        by_no = {record["bid_no"]: record for record in self.records}
        for bid_no in ("R26BK01785460", "2026-03-000242", "R26BK01773778",
                       "R26BK01773136"):
            self.assertEqual(by_no[bid_no]["av_class"], "C", bid_no)

    def test_legacy_filter_reproduces_356(self):
        self.assertEqual(len(self.legacy), 356)
        self.assertEqual(self.stats["legacy"]["count"], 356)
        self.assertEqual(self.stats["legacy"]["excluded_count"], 28)

    def test_duplicate_counts(self):
        self.assertEqual(self.stats["duplicates"]["groups"], 20)
        self.assertEqual(self.stats["duplicates"]["excess_records"], 21)

    def test_no_fabricated_bid_rates(self):
        self.assertEqual(self.stats["rated_bids"], 0)
        self.assertEqual(self.stats["unrated_bids"], 384)

    def test_lifecycle_counts(self):
        self.assertEqual(self.stats["lifecycle_counts"]["open"], 185)
        self.assertEqual(self.stats["lifecycle_counts"]["closed"], 141)
        self.assertEqual(self.stats["lifecycle_counts"]["cancelled"], 18)
        self.assertEqual(self.stats["lifecycle_counts"]["unknown"], 40)

    def test_output_files(self):
        legacy_records, _ = classifier.build_records(
            self.legacy, self.enrichment, "2026-10-23"
        )
        with tempfile.TemporaryDirectory() as tmp:
            classifier.write_classification_outputs(
                tmp, self.records, self.stats, legacy_records
            )
            expected = [
                "bid_classification.csv", "cgi_direct_bids.csv", "cgi_review_bids.csv",
                "cgi_related_bids.csv", "manual_review_bids.csv",
                "bid_qualification_summary.csv", "classification_stats.json",
                "legacy_356_analysis.json",
            ]
            for name in expected:
                self.assertTrue(os.path.exists(os.path.join(tmp, name)), name)
            with io.open(os.path.join(tmp, "cgi_direct_bids.csv"), encoding="utf-8-sig") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(len(rows), 27)
            self.assertIn("qualification_note", rows[0])


if __name__ == "__main__":
    unittest.main()
