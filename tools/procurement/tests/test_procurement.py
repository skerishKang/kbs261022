import csv
import json
import argparse
import os
import sys
import tempfile
import unittest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO_ROOT, "tools", "procurement"))
import g2b_bid_analysis as gba

SAMPLE = os.path.join(REPO_ROOT, "data", "procurement", "sample_bids.json")


class TestProcurement(unittest.TestCase):
    def test_load_sample(self):
        bids = gba.load_bids(SAMPLE)
        self.assertEqual(len(bids), 4)

    def test_normalize_rates(self):
        bids = gba.load_bids(SAMPLE)
        norm = gba.normalize(bids, "sample:test")
        rated = [b for b in norm if b["bid_rate_pct"] is not None]
        self.assertEqual(len(rated), 3)
        # first: 89500000/100000000 = 89.5
        self.assertAlmostEqual(norm[0]["bid_rate_pct"], 89.5)

    def test_summary(self):
        bids = gba.load_bids(SAMPLE)
        norm = gba.normalize(bids, "sample:test")
        s = gba.summarize(norm)
        self.assertEqual(s["total_bids"], 4)
        self.assertEqual(s["rated_bids"], 3)
        self.assertEqual(s["unrated_bids"], 1)
        self.assertIn("overall_rate_stats", s)
        self.assertEqual(s["overall_rate_stats"]["count"], 3)
        self.assertIn("by_category", s)
        self.assertIn("by_status", s)

    def test_no_win_probability_claim(self):
        bids = gba.load_bids(SAMPLE)
        norm = gba.normalize(bids, "sample:test")
        s = gba.summarize(norm)
        self.assertIn("disclaimer", s)
        self.assertIn("No win-probability guarantee", s["disclaimer"])

    def test_unrated_bid_has_none_rate(self):
        bids = gba.load_bids(SAMPLE)
        norm = gba.normalize(bids, "sample:test")
        unrated = [b for b in norm if b["bid_rate_pct"] is None]
        self.assertEqual(len(unrated), 1)
        self.assertEqual(unrated[0]["status"], "유찰")

    def test_run_main(self):
        # main() 은 샘플 입력으로 돌리되 저장된 나라장터 산출물을 건드리면 안 된다.
        # OUT_DIR 을 임시 디렉터리로 돌리지 않으면 384건 보고서가 샘플 4건으로 덮어써진다.
        import io
        import hashlib
        from contextlib import redirect_stdout
        tracked = os.path.join(REPO_ROOT, "reports", "data", "procurement", "bid_analysis_report.json")
        before = hashlib.sha256(open(tracked, "rb").read()).hexdigest() if os.path.exists(tracked) else None
        buf = io.StringIO()
        old_argv = sys.argv
        old_out_dir = gba.OUT_DIR
        with tempfile.TemporaryDirectory() as tmp:
            sys.argv = ["g2b_bid_analysis.py", "--input", SAMPLE]
            gba.OUT_DIR = tmp
            try:
                with redirect_stdout(buf):
                    gba.main()
            finally:
                sys.argv = old_argv
                gba.OUT_DIR = old_out_dir
            out_json = os.path.join(tmp, "bid_analysis_report.json")
            self.assertTrue(os.path.exists(out_json))
            summary = json.load(open(out_json, encoding="utf-8"))["summary"]
            self.assertEqual(summary["total_bids"], 4)
        if before is not None:
            after = hashlib.sha256(open(tracked, "rb").read()).hexdigest()
            self.assertEqual(before, after, "테스트가 저장소 산출물을 덮어썼습니다")

    def test_live_fetch_without_key_returns_error(self):
        # ensure no crash when no key
        os.environ.pop("G2B_API_KEY", None)
        bids, err = gba.fetch_live("IT", "20260101", "20260102")
        self.assertIsNone(bids)
        self.assertIn("G2B_API_KEY not set", err)


class TestProcurementNew(unittest.TestCase):
    def test_normalize_source_field(self):
        bids = gba.load_bids(SAMPLE)
        norm = gba.normalize(bids, "sample:test")
        self.assertTrue(all(b["data_source"] == "sample:test" for b in norm))

    def test_duplicate_removal(self):
        bids = gba.load_bids(SAMPLE)
        # duplicate first bid
        bids2 = bids + [dict(bids[0])]
        norm = gba.normalize(bids2, "sample:test")
        self.assertEqual(len(norm), len(bids))

    def test_cgi_classification(self):
        bids = gba.load_bids(SAMPLE)
        norm = gba.normalize(bids, "sample:test")
        # sample titles don't contain cgi keywords -> cgi_relevant False for all
        self.assertTrue(all(b["cgi_relevant"] is False for b in norm))

    def test_cgi_classification_keyword(self):
        b = {"bid_no": "X", "title": "음향장비 납품 및 설치", "category": "물품",
             "estimated_price": 1000000, "winning_bid": 900000, "status": "낙찰"}
        norm = gba.normalize([b], "test")
        self.assertTrue(norm[0]["cgi_relevant"])
        self.assertIn("음향장비", norm[0]["cgi_categories"])

    def test_apply_filters_cgi_only(self):
        b = {"bid_no": "X", "title": "음향장비 납품", "category": "물품",
             "estimated_price": 1000000, "winning_bid": 900000, "status": "낙찰"}
        b2 = {"bid_no": "Y", "title": "도로 포장 공사", "category": "공사",
              "estimated_price": 2000000, "winning_bid": 1800000, "status": "낙찰"}
        norm = gba.normalize([b, b2], "test")
        args = argparse.Namespace(cgi_only=True, keyword=None, region=None,
                                  agency=None, status=None, begin=None, end=None)
        filtered = gba.apply_filters(norm, args)
        self.assertEqual(len(filtered), 1)
        self.assertEqual(filtered[0]["bid_no"], "X")

    def test_xlsx_written(self):
        bids = gba.load_bids(SAMPLE)
        norm = gba.normalize(bids, "sample:test")
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "_test.xlsx")
            ok = gba.write_xlsx(norm, path)
            self.assertTrue(ok)
            self.assertTrue(os.path.exists(path))

    def test_live_fetch_no_key(self):
        os.environ.pop("G2B_API_KEY", None)
        bids, err = gba.fetch_live("IT", "20260101", "20260102")
        self.assertIsNone(bids)
        self.assertIn("G2B_API_KEY not set", err)

    def test_summary_cgi_category(self):
        b = {"bid_no": "X", "title": "음향장비 납품", "category": "물품",
             "estimated_price": 1000000, "winning_bid": 900000, "status": "낙찰"}
        norm = gba.normalize([b], "test")
        s = gba.summarize(norm)
        self.assertIn("by_cgi_category", s)
        self.assertIn("음향장비", s["by_cgi_category"])
        self.assertEqual(s["cgi_relevant_bids"], 1)


if __name__ == "__main__":
    unittest.main()
