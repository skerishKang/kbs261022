import csv
import json
import os
import sys
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
        norm = gba.normalize(bids)
        rated = [b for b in norm if b["bid_rate_pct"] is not None]
        self.assertEqual(len(rated), 3)
        # first: 89500000/100000000 = 89.5
        self.assertAlmostEqual(norm[0]["bid_rate_pct"], 89.5)

    def test_summary(self):
        bids = gba.load_bids(SAMPLE)
        norm = gba.normalize(bids)
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
        norm = gba.normalize(bids)
        s = gba.summarize(norm)
        self.assertIn("disclaimer", s)
        self.assertIn("No win-probability guarantee", s["disclaimer"])

    def test_unrated_bid_has_none_rate(self):
        bids = gba.load_bids(SAMPLE)
        norm = gba.normalize(bids)
        unrated = [b for b in norm if b["bid_rate_pct"] is None]
        self.assertEqual(len(unrated), 1)
        self.assertEqual(unrated[0]["status"], "유찰")

    def test_run_main(self):
        # run main with sample input, ensure report written
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        old_argv = sys.argv
        sys.argv = ["g2b_bid_analysis.py", "--input", SAMPLE]
        try:
            with redirect_stdout(buf):
                gba.main()
        finally:
            sys.argv = old_argv
        out_json = os.path.join(REPO_ROOT, "reports", "data", "procurement", "bid_analysis_report.json")
        self.assertTrue(os.path.exists(out_json))

    def test_live_fetch_without_key_returns_error(self):
        # ensure no crash when no key
        os.environ.pop("G2B_API_KEY", None)
        bids, err = gba.fetch_live("IT", "20260101", "20260102")
        self.assertIsNone(bids)
        self.assertIn("G2B_API_KEY not set", err)


if __name__ == "__main__":
    unittest.main()
