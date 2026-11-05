# -*- coding: utf-8 -*-
"""build_bid_data.py 회귀시험 — 저장소의 수집 데이터로 bid-data.js 를 재현할 수 있어야 한다(이슈 #188 3차)."""
import os
import sys
import unittest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO_ROOT, "tools", "procurement"))
import build_bid_data as bbd  # noqa: E402
import validate_bid_data as vbd  # noqa: E402


class TestClassify(unittest.TestCase):
    def test_keyword_rules(self):
        self.assertEqual(bbd.classify("도서관 신축공사")[0], "공사")
        self.assertEqual(bbd.classify("DBMS 유지보수")[0], "용역")
        self.assertEqual(bbd.classify("도로 유지보수 단가공사")[0], "공사")
        self.assertEqual(bbd.classify("폐자재 매각")[0], "매각")
        self.assertEqual(bbd.classify("영상정보디스플레이장치 외 4종")[0], "구매")

    def test_original_task_div_wins(self):
        self.assertEqual(bbd.classify_bid({"title": "공사 같은 제목", "task_div": "물품"}, {}), ("구매", "원본"))
        self.assertEqual(bbd.classify_bid({"title": "제목"}, {"items": [{"class_no": "1"}]}), ("구매", "품명"))


class TestDates(unittest.TestCase):
    def test_pick_dt_prefers_list_for_changed_notices(self):
        # 변경공고: 목록 날짜가 다르면 목록 날짜 + 보강 시각
        self.assertEqual(bbd.pick_dt("2026-12-01", "2026-11-24 11:00:00", "18:00:00", True), "2026-12-01 11:00:00")
        # 등록공고: 보강 값 우선
        self.assertEqual(bbd.pick_dt("2026-10-19", "2026-10-20 14:00:00", "18:00:00", False), "2026-10-20 14:00:00")
        # 보강 없음: 목록 + 기본 시각
        self.assertEqual(bbd.pick_dt("2026-10-19", None, "18:00:00", False), "2026-10-19 18:00:00")
        self.assertIsNone(bbd.pick_dt(None, None, "18:00:00", True))

    def test_region_helpers(self):
        self.assertEqual(bbd.region_from_original({"region_names": ["전라남도 장성군"]}), "전남")
        self.assertEqual(bbd.region_from_original({"region_text": "지역제한 [광주광역시]"}), "광주")
        self.assertIsNone(bbd.region_from_original({}))
        self.assertEqual(bbd.guess_region("서울시 강남구 공고", "x"), "서울")


class TestBuild(unittest.TestCase):
    def test_build_reproduces_committed_data(self):
        data = bbd.build(bbd.DEFAULT_SNAPSHOT)
        self.assertEqual(vbd.validate_bids(data), [])
        current = bbd.current_payload()
        self.assertIsNotNone(current, "bid-data.js 가 없다")
        self.assertEqual(current["snapshot"], data["snapshot"])
        self.assertEqual(current["bids"], data["bids"], "bid-data.js 가 소스와 다르다 — build_bid_data.py 로 재생성하라")

    def test_long_term_flagged(self):
        data = bbd.build(bbd.DEFAULT_SNAPSHOT)
        lt = [b for b in data["bids"] if b.get("lt")]
        self.assertTrue(all(int(b["cd"][:4]) - int(b["pd"][:4]) >= 1 for b in lt))


if __name__ == "__main__":
    unittest.main()
