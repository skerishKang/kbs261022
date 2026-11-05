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


class TestCgiMatch(unittest.TestCase):
    """CGI 취급 품목 매칭(이슈 #188 7차) — cgi_bid_keywords.json 기준."""

    def test_positive_keywords_and_order(self):
        f = bbd.cgi_match_fields("학교 교실방송 및 음향설비 구매")
        self.assertTrue(f["cgi_match"])
        # JSON 카테고리 나열 순서대로 적중 키워드가 담긴다
        self.assertIn("음향", f["mk"])
        self.assertIn("학교", f["mk"])

    def test_latin_keyword_is_token_matched(self):
        # 'AS' 부분일치 오검출 방지: 'case'에는 걸리지 않는다
        self.assertFalse(bbd.keyword_hit("AS", "데이터베이스 CASE 도구 구매"))
        self.assertFalse(bbd.keyword_hit("AS", "복사기 A/S 용역"), "'AS'는 'A/S'와 별개 토큰")
        # 'A/S' 키워드가 'A/S' 표기에 걸린다
        self.assertTrue(bbd.keyword_hit("A/S", "복사기 A/S 용역"))
        self.assertTrue(bbd.cgi_match_fields("복사기 A/S 용역")["cgi_match"])
        self.assertFalse(bbd.cgi_match_fields("데이터베이스 CASE 도구 구매")["cgi_match"])

    def test_negative_keyword_blocks(self):
        f = bbd.cgi_match_fields("음향기기 구매 — 의료기관용")
        self.assertFalse(f["cgi_match"])
        self.assertEqual(f["mk"], [])
        self.assertEqual(f["cgi_tier"], "none")

    def test_no_match(self):
        f = bbd.cgi_match_fields("도서관 신축공사")
        self.assertFalse(f["cgi_match"])
        self.assertEqual(f["mk"], [])
        self.assertEqual(f["cgi_tier"], "none")

    def test_tier_core_beats_related(self):
        # 음향(core) + 운영(related)이 같이 적중하면 core
        self.assertEqual(bbd.cgi_match_fields("음향설비 운영")["cgi_tier"], "core")
        # 학교·관리처럼 related만 적중하면 related
        f = bbd.cgi_match_fields("학교 시설 관리")
        self.assertTrue(f["cgi_match"])
        self.assertEqual(f["cgi_tier"], "related")

    def test_built_data_has_fields_and_validates(self):
        data = bbd.build(bbd.DEFAULT_SNAPSHOT)
        self.assertTrue(all(isinstance(r["cgi_match"], bool) and isinstance(r["mk"], list) for r in data["bids"]))
        self.assertTrue(all(r["cgi_tier"] in ("core", "related", "none") for r in data["bids"]))
        for r in data["bids"]:
            if r["cgi_tier"] in ("core", "related"):
                self.assertTrue(r["cgi_match"])
            else:
                self.assertFalse(r["cgi_match"])
        self.assertEqual(vbd.validate_bids(data), [])
        self.assertEqual(data["counts"]["cgiMatched"], sum(1 for r in data["bids"] if r["cgi_match"]))

    def test_rate_stats_output_empty_until_real_data(self):
        stats = bbd.build_rate_stats_output(bbd.DEFAULT_SNAPSHOT, [], [])
        self.assertFalse(stats["collected"])
        self.assertEqual(stats["bundles"], {})
        self.assertIn("낙찰 데이터 수집 전", stats["reason"])
        self.assertEqual(vbd.validate_rate_stats(stats), [])

    def test_rate_stats_output_from_price_records(self):
        # 실수집 형식(예비가격상세 원본)을 넣으면 조인해 묶음 통계를 만든다
        bids = [{"no": f"N{i}", "t": "음향장비 구매", "a": "기관A", "c": "구매", "ep": 500_000_000,
                 "s": "등록공고", "cgi_match": True, "mk": ["음향"], "cgi_tier": "core"} for i in range(35)]
        price = [{"bid_no": f"N{i}", "base_amount": 1_000_000_000, "presmpt_price": 995_000_000,
                  "open_at": "2026-10-01 09:00:00", "multi_prepaid": "N", "lottery": "N"} for i in range(35)]
        stats = bbd.build_rate_stats_output("2026-10-23", price, bids)
        self.assertTrue(stats["collected"])
        self.assertEqual(len(stats["bundles"]), 35)
        s = stats["bundles"]["N0"]
        self.assertEqual(s["n"], 35)
        self.assertEqual(s["bundle"], "발주기관: 기관A")
        self.assertEqual(vbd.validate_rate_stats(stats), [])


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
