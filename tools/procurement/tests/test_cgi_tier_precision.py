# -*- coding: utf-8 -*-
"""CGI 등급 정밀화 회귀시험 — 이슈 #188 9차. 정답표(fixtures/cgi_tier_gold.json) 기준.

기준: core precision ≥ 0.90, core recall ≥ 0.85, CTO가 지적한 5건은 core가 아니어야 한다.
"""
import json
import os
import sys
import unittest
from pathlib import Path

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO_ROOT, "tools", "procurement"))
import build_bid_data as bbd  # noqa: E402

GOLD = Path(REPO_ROOT, "tools", "procurement", "fixtures", "cgi_tier_gold.json")
PRECISION_MIN = 0.90
RECALL_MIN = 0.85
# CTO가 9차 지시에서 오분류로 지적한 5건(반드시 core가 아니어야 한다)
MUST_NOT_CORE = [
    "2026LHM02302026-16196",  # 00부대 의무대대 주둔지 울타리 공사 — '무대'
    "R26BK01780437",  # 평생교육이용권 공모전 영상 제작 — '영상'
    "R26BK01773839",  # 국립대구과학관 4D영상관 휴머노이드 — '영상관'
    "R26BK01745800",  # 방송미디어통신심의위원회 정보시스템 유지보수 — '방송'
    "R26BK01763141",  # 드론쇼 상설 공연장 구축 사업 평가위원 — '공연장'
]
GOLD_NOTES = {b["no"]: b["reason"] for b in json.loads(GOLD.read_text(encoding="utf-8"))["items"]}


class TestGoldPrecision(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        gold = json.loads(GOLD.read_text(encoding="utf-8"))
        cls.kw = bbd.load_keywords()
        cls.results = [
            {**it, "pred": bbd.cgi_match_fields(it["t"], cls.kw, agency=it["a"])["cgi_tier"]}
            for it in gold["items"]
        ]
        gold_core = [r for r in cls.results if r["gold"] == "core"]
        pred_core = [r for r in cls.results if r["pred"] == "core"]
        cls.tp = [r for r in pred_core if r["gold"] == "core"]
        cls.fp = [r for r in pred_core if r["gold"] != "core"]
        cls.fn = [r for r in gold_core if r["pred"] != "core"]
        cls.precision = len(cls.tp) / len(pred_core) if pred_core else 1.0
        cls.recall = len(cls.tp) / len(gold_core) if gold_core else 1.0

    def test_core_precision_at_least_90(self):
        self.assertGreaterEqual(
            self.precision, PRECISION_MIN,
            "core precision %.3f — 오탐: %s" % (
                self.precision, [(r["no"], r["t"][:30], r["gold"]) for r in self.fp]))

    def test_core_recall_at_least_85(self):
        self.assertGreaterEqual(
            self.recall, RECALL_MIN,
            "core recall %.3f — 누락: %s" % (
                self.recall, [(r["no"], r["t"][:30], r["reason"]) for r in self.fn]))

    def test_cto_examples_are_not_core(self):
        by_no = {r["no"]: r for r in self.results}
        for no in MUST_NOT_CORE:
            self.assertIn(no, by_no, "정답표에 없는 공고: " + no)
            self.assertNotEqual(
                by_no[no]["pred"], "core",
                "여전히 core로 분류: %s (%s) — %s" % (no, by_no[no]["t"][:30], GOLD_NOTES.get(no, "")))

    def test_report_values(self):
        """수치를 보고용으로 출력한다(테스트 출력에 남긴다)."""
        print("\n[9차 정밀도] 정답표 %d건 — core precision %.3f (TP %d / 예측 core %d), "
              "core recall %.3f (TP %d / 정답 core %d)"
              % (len(self.results), self.precision, len(self.tp),
                 len(self.tp) + len(self.fp), self.recall, len(self.tp),
                 len(self.tp) + len(self.fn)))


if __name__ == "__main__":
    unittest.main()
