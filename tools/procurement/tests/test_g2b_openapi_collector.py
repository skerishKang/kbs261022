# -*- coding: utf-8 -*-
"""오픈데이터 수집기 단위시험 — 네트워크 없이 요청 구성·응답 변환만 검증한다(이슈 #188 3차)."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO_ROOT, "tools", "procurement"))
import g2b_openapi_collector as col  # noqa: E402
import validate_bid_data as vbd  # noqa: E402

FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "openapi_bid_list_sample.json"


class TestRequestBuilding(unittest.TestCase):
    def test_operation_names_are_the_confirmed_ones(self):
        self.assertEqual(col.OPERATIONS["공사"], "getBidPblancListInfoCnstwk")
        self.assertEqual(col.OPERATIONS["외자"], "getBidPblancListInfoFrgcpt")
        self.assertEqual(col.RESULT_OPERATIONS["공사"], "getScsbidListSttusCnstwk")
        self.assertEqual(col.OPENING_OPERATIONS["물품"], "getOpengResultListInfoThng")
        self.assertEqual(col.BASE_AMOUNT_OPERATIONS["용역"], "getBidPblancListInfoServcBsisAmount")
        for name in list(col.OPERATIONS.values()) + list(col.RESULT_OPERATIONS.values()):
            self.assertNotIn("Constr", name)
            self.assertNotIn("ResulBid", name)

    def test_base_url_is_current_path_not_legacy(self):
        self.assertNotIn("BidPublicInfoService04", col.BASE_URL)
        self.assertTrue(col.BASE_URL.startswith("https://apis.data.go.kr/1230000/"))
        self.assertTrue(col.RESULT_BASE_URL.endswith("/as/ScsbidInfoService"))

    def test_build_url_has_window_and_paging(self):
        url = col.build_url("getBidPblancListInfoThng", "abc+def", "20261101", "20261105", 2)
        self.assertIn("/getBidPblancListInfoThng?", url)
        self.assertIn("serviceKey=abc%2Bdef", url)  # 원문 키는 한 번만 인코딩
        self.assertIn("inqryBgnDt=202611010000", url)
        self.assertIn("inqryEndDt=202611052359", url)
        self.assertIn("pageNo=2", url)
        self.assertIn("type=json", url)

    def test_encoded_key_is_not_double_encoded(self):
        url = col.build_url("getBidPblancListInfoThng", "abc%2Bdef%3D%3D", "20261101", "20261105", 1)
        self.assertIn("serviceKey=abc%2Bdef%3D%3D&", url)

    def test_mask_url_hides_key(self):
        url = col.build_url("getBidPblancListInfoThng", "SECRETKEY", "20261101", "20261105", 1)
        self.assertNotIn("SECRETKEY", col.mask_url(url))
        self.assertIn("serviceKey=***", col.mask_url(url))

    def test_date_chunks(self):
        self.assertEqual(col.date_chunks("20261101", "20261103", 1),
                         [("20261101", "20261101"), ("20261102", "20261102"), ("20261103", "20261103")])
        self.assertEqual(col.date_chunks("20261101", "20261105", 3),
                         [("20261101", "20261103"), ("20261104", "20261105")])
        self.assertEqual(col.date_chunks("20261105", "20261105", 7), [("20261105", "20261105")])


class TestResponseParsing(unittest.TestCase):
    def test_parse_body_list_and_nested_and_single(self):
        env = {"response": {"header": {"resultCode": "00"}, "body": {"items": [{"a": 1}], "totalCount": 1}}}
        self.assertEqual(col.parse_body(env), ([{"a": 1}], 1, None))
        env["response"]["body"]["items"] = {"item": [{"a": 1}, {"a": 2}]}
        self.assertEqual(col.parse_body(env)[0], [{"a": 1}, {"a": 2}])
        env["response"]["body"]["items"] = {"item": {"a": 3}}
        self.assertEqual(col.parse_body(env)[0], [{"a": 3}])

    def test_parse_body_nodata_is_empty_not_error(self):
        env = {"response": {"header": {"resultCode": "03", "resultMsg": "NODATA_ERROR"}, "body": {}}}
        self.assertEqual(col.parse_body(env), ([], 0, None))

    def test_parse_body_error_code(self):
        env = {"response": {"header": {"resultCode": "30", "resultMsg": "SERVICE_KEY_IS_NOT_REGISTERED_ERROR"}}}
        items, total, err = col.parse_body(env)
        self.assertEqual(items, [])
        self.assertIn("30", err)


class TestNormalize(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sample = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def test_normalize_list_item(self):
        items, total, err = col.parse_body(self.sample["bid_list"])
        self.assertIsNone(err)
        rec = col.normalize(items[0], "공사")
        self.assertEqual(rec["no"], "R26BK01900001")
        self.assertEqual(rec["ord"], "000")
        self.assertEqual(rec["c"], "공사")
        self.assertEqual(rec["k"], "제한경쟁")
        self.assertEqual(rec["ep"], 450000000)
        self.assertEqual(rec["pd"], "2026-11-04 10:12:00")
        self.assertTrue(rec["cu"].startswith("https://www.g2b.go.kr"))

    def test_normalize_uses_task_div_when_field_missing(self):
        rec = col.normalize({"bidNtceNo": "R1", "bidNtceNm": "x"}, "용역")
        self.assertEqual(rec["c"], "용역")
        self.assertEqual(col.normalize({"bidNtceNo": "R1", "bizDivNm": "외자"})["c"], "구매")
        self.assertIsNone(col.normalize({"bidNtceNm": "no number"}))

    def test_dedupe_and_latest_ord(self):
        rows = [{"no": "A", "ord": "000"}, {"no": "A", "ord": "000"}, {"no": "A", "ord": "001"}, {"no": "B", "ord": "000"}]
        d = col.dedupe(rows)
        self.assertEqual(len(d), 3)
        latest = {r["no"]: r["ord"] for r in col.latest_ord_only(d)}
        self.assertEqual(latest, {"A": "001", "B": "000"})

    def test_enrichment_merges_base_amount_and_region(self):
        items, _, _ = col.parse_body(self.sample["bid_list"])
        bids = [col.normalize(it, "공사") for it in items]
        ba = [col.normalize_base_amount(it) for it in col.parse_body(self.sample["base_amount"])[0]]
        rg = [col.normalize_region(it) for it in col.parse_body(self.sample["region"])[0]]
        stats = col.apply_enrichment(bids, ba, rg)
        self.assertEqual(stats, {"base_amount": 1, "region": 1})
        self.assertEqual(bids[0]["bs"], 430000000)
        self.assertEqual(bids[0]["pr"], [-2.0, 2.0])
        self.assertEqual(bids[0]["r"], "전남")
        self.assertEqual(bids[0]["rn"], ["전라남도"])
        self.assertNotIn("bs", bids[1])

    def test_short_region(self):
        self.assertEqual(col.short_region("전라남도"), "전남")
        self.assertEqual(col.short_region("광주광역시"), "광주")
        self.assertEqual(col.short_region("세종특별자치시"), "세종")
        self.assertEqual(col.short_region("경기도 성남시"), "경기")
        self.assertIsNone(col.short_region("전국"))
        self.assertIsNone(col.short_region(None))

    def test_normalize_result(self):
        items, _, _ = col.parse_body(self.sample["scsbid"])
        rec = col.normalize_result(items[0])
        self.assertEqual(rec["no"], "R26BK01900001")
        self.assertEqual(rec["bid_amount"], 401230000.0)
        self.assertEqual(rec["success_rate"], 89.21)
        self.assertEqual(rec["winner"], "예시건설(주)")
        self.assertEqual(rec["bidder_count"], 37.0)
        self.assertEqual(rec["open_at"], "2026-11-05 11:00:00")

    def test_norm_dt_formats(self):
        self.assertEqual(col._norm_dt("2026-11-05"), "2026-11-05 18:00:00")
        self.assertEqual(col._norm_dt("2026-11-05 11:00"), "2026-11-05 11:00:00")
        self.assertEqual(col._norm_dt("2026/11/05 11:00:00"), "2026-11-05 11:00:00")
        self.assertEqual(col._norm_dt("202611051100"), "2026-11-05 11:00:00")
        self.assertIsNone(col._norm_dt(None))


class TestPayload(unittest.TestCase):
    def test_build_payload_passes_validator_and_flags_long_term(self):
        sample = json.loads(FIXTURE.read_text(encoding="utf-8"))
        items, _, _ = col.parse_body(sample["bid_list"])
        bids = [col.normalize(it, "공사") for it in items]
        bids.append({"no": "R26BK01900009", "ord": "000", "t": "취소된 공고", "a": "기관", "c": "공사", "k": "-",
                     "s": "취소공고", "pd": "2026-11-01", "cd": "2026-11-10 18:00:00", "od": None, "cu": "https://www.g2b.go.kr#x"})
        bids.append({"no": "R26BK01900010", "ord": "000", "t": "다수공급자 장기 공고", "a": "조달청", "c": None, "k": "일반경쟁",
                     "s": "등록공고", "pd": "2026-11-01", "cd": "2036-11-01 18:00:00", "od": "2036-10-01 09:00:00",
                     "cu": "https://www.g2b.go.kr#y"})
        payload = col.build_payload(bids, "2026-11-05", "test")
        nos = [b["no"] for b in payload["bids"]]
        self.assertNotIn("R26BK01900009", nos)  # 취소공고 제외
        long = [b for b in payload["bids"] if b["no"] == "R26BK01900010"][0]
        self.assertTrue(long.get("lt"))
        self.assertEqual(long["c"], "구매")  # 매핑 없는 업무구분은 구매 표기
        self.assertEqual(vbd.validate_bids(payload), [])

    def test_write_bid_data_roundtrip(self):
        sample = json.loads(FIXTURE.read_text(encoding="utf-8"))
        items, _, _ = col.parse_body(sample["bid_list"])
        bids = [col.normalize(it, "공사") for it in items]
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "bid-data.js"
            with mock.patch.object(col, "BID_DATA_PATH", path):
                col.write_bid_data(bids, "2026-11-05")
            payload = vbd.load_js(path)
            self.assertEqual(payload["snapshot"], "2026-11-05")
            self.assertEqual(vbd.validate_bids(payload), [])
            self.assertIn("공공데이터포털", payload["source"])


if __name__ == "__main__":
    unittest.main()
