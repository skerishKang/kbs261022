# -*- coding: utf-8 -*-
"""rate_stats.py 회귀시험 — 이슈 #188 8차. 계산식·0.1%p 구간 경계·묶음 폴백·견본 격리."""
import json
import os
import sys
import unittest
from pathlib import Path

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO_ROOT, "tools", "procurement"))
import rate_stats as rs  # noqa: E402


def rec(no, agency, category, ep, base, presmpt, open_at="2026-10-01 09:00:00"):
    return {"no": no, "agency": agency, "category": category, "ep": ep,
            "base_amount": base, "presmpt_price": presmpt, "open_at": open_at}


class TestFormula(unittest.TestCase):
    def test_success_rate(self):
        self.assertEqual(rs.success_rate(100_000_000, 96_500_000), 96.5)
        self.assertEqual(rs.success_rate(100_000_000, 100_000_000), 100.0)
        self.assertIsNone(rs.success_rate(0, 96_500_000))
        self.assertIsNone(rs.success_rate(None, 96_500_000))
        self.assertIsNone(rs.success_rate(100, -1))

    def test_deviation(self):
        self.assertEqual(rs.deviation(96.5), -3.5)
        self.assertEqual(rs.deviation(100.0), 0.0)
        self.assertIsNone(rs.deviation(None))


class TestHistogram(unittest.TestCase):
    def test_bucket_boundaries(self):
        # [k*0.1, (k+1)*0.1) — 99.95는 99.9 구간, 100.05는 100.0 구간
        h = rs.histogram([99.95, 100.0, 100.05, 99.99])
        by = {x["bucket_low"]: x["count"] for x in h}
        self.assertEqual(by[99.9], 2)   # 99.95, 99.99
        self.assertEqual(by[100.0], 2)  # 100.0, 100.05
        self.assertEqual(sorted(by), [99.9, 100.0])
        for x in h:
            self.assertEqual(x["bucket_high"], round(x["bucket_low"] + 0.1, 4))

    def test_empty_buckets_not_emitted(self):
        h = rs.histogram([100.0, 100.3])
        self.assertEqual([x["bucket_low"] for x in h], [100.0, 100.3], "빈 구간은 건너뛴다")


class TestSummarize(unittest.TestCase):
    def test_mean_median_stdev(self):
        s = rs.summarize([100.0, 100.1, 99.9])
        self.assertEqual(s["n"], 3)
        self.assertEqual(s["mean"], 100.0)
        self.assertEqual(s["median"], 100.0)
        self.assertGreater(s["stdev"], 0)
        self.assertEqual(rs.summarize([])["n"], 0)


class TestBundles(unittest.TestCase):
    def setUp(self):
        # 발주기관 A(구매, 1억~10억) 표본 35건 — 충분
        self.records = [rec(f"N{i}", "기관A", "구매", 500_000_000, 1_000_000_000, 995_000_000)
                        for i in range(35)]

    def test_agency_bundle_first(self):
        sel = rs.select_bundle({"agency": "기관A", "category": "구매", "ep": 500_000_000}, self.records)
        self.assertEqual(sel["group"], "agency")
        self.assertEqual(len(sel["records"]), 35)

    def test_fallback_to_category_price(self):
        sel = rs.select_bundle({"agency": "기관B", "category": "구매", "ep": 500_000_000}, self.records)
        self.assertEqual(sel["group"], "category_price")
        self.assertIn("1억원~10억원", sel["bundle"])
        self.assertEqual(len(sel["records"]), 35)

    def test_fallback_to_category_when_band_short(self):
        # 기관B·용역(3천만~5천만 구간)은 5건뿐이고, 같은 금액대 용역도 20건뿐 → 분류 용역 전체(35건)로 내려간다
        records = self.records \
            + [rec(f"A{i}", "기관A", "용역", 500_000_000, 1_000_000_000, 995_000_000) for i in range(15)] \
            + [rec(f"B{i}", "기관A", "용역", 30_000_000, 100_000_000, 99_000_000) for i in range(15)] \
            + [rec(f"C{i}", "기관B", "용역", 30_000_000, 100_000_000, 99_000_000) for i in range(5)]
        sel = rs.select_bundle({"agency": "기관B", "category": "용역", "ep": 30_000_000}, records)
        self.assertEqual(sel["group"], "category")
        self.assertIn("용역", sel["bundle"])
        self.assertEqual(len(sel["records"]), 35)

    def test_all_insufficient(self):
        sel = rs.select_bundle({"agency": "기관B", "category": "용역", "ep": 500_000_000}, self.records)
        self.assertEqual(sel["group"], None)
        self.assertEqual(sel["bundle"], "표본 부족")

    def test_bid_stats_insufficient_has_no_numbers(self):
        s = rs.bid_stats({"agency": "기관B", "category": "용역", "ep": 500_000_000}, self.records)
        self.assertEqual(s, {"collected": False, "reason": "표본 부족", "bundle": "표본 부족"})
        self.assertNotIn("mean", s)

    def test_bid_stats_with_enough_sample(self):
        s = rs.bid_stats({"agency": "기관A", "category": "구매", "ep": 500_000_000}, self.records)
        self.assertTrue(s["collected"])
        self.assertEqual(s["n"], 35)
        self.assertEqual(s["mean"], 99.5)
        self.assertIn("histogram", s)
        self.assertEqual(sum(h["count"] for h in s["histogram"]), 35)
        self.assertEqual(s["bundle"], "발주기관: 기관A")

    def test_invalid_records_filtered(self):
        records = self.records + [rec("BAD", "기관A", "구매", 500_000_000, 0, 995_000_000)]
        valid = rs.valid_records(records)
        self.assertEqual(len(valid), 35, "기초금액 0 등 계산 불가 레코드는 뺀다")


class TestFixtureIsolation(unittest.TestCase):
    """견본(fixtures)은 산출물에 절대 섞이지 않는다."""

    def test_build_module_never_reads_fixtures(self):
        src = Path(rs.__file__).read_text(encoding="utf-8")
        self.assertNotIn("fixtures", src, "rate_stats는 fixtures를 읽지 않는다")
        import build_bid_data as bbd
        src2 = Path(bbd.__file__).read_text(encoding="utf-8")
        self.assertNotIn("fixtures", src2, "build_bid_data도 fixtures를 읽지 않는다")

    def test_fixture_sample_values_not_in_rate_stats_output(self):
        fixture = json.loads(Path(REPO_ROOT, "tools", "procurement", "fixtures",
                                  "sample_openg_result_prepar_pc_detail_thng.json").read_text(encoding="utf-8"))
        item = fixture["response"]["body"]["items"]["item"][0]
        # 빌드는 fixtures를 읽지 않으므로(위 테스트) 현재 상태(collected:false)에서
        # 견본의 예정가격·기초금액 값이 산출물에 있을 수 없다.
        import build_bid_data as bbd
        out = bbd.build_rate_stats_output(bbd.DEFAULT_SNAPSHOT, [], [])
        self.assertFalse(out["collected"])
        self.assertEqual(out["bundles"], {})
        self.assertNotIn(str(item["presmptPrce"]), json.dumps(out))
        self.assertNotIn(str(item["bssamt"]), json.dumps(out))


if __name__ == "__main__":
    unittest.main()
