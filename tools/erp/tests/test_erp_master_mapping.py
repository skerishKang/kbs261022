#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Synthetic-sample tests for the ERP×master duplicate mapping (issue #1/#101).

No live ERP rows and no customer data appear here — every fixture is fabricated.
"""
import copy
import csv
import io
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..")))
from tools.erp.erp_master_mapping import (  # noqa: E402
    proposed_code, brand_ok, score_pair, suspect_score, guard_downgrade,
    build_mapping, integrity_check, summarize, write_mapping_csv,
    EXACT_FLOOR, SCORE_SUSPECT_MAX,
)


def master(key, name, brand, model, source="samasound", sid=None, opts="0", spec_rows="0"):
    return {
        "cgi_key": key, "cgi_name": name, "cgi_brand": brand, "cgi_model": model,
        "cgi_source": source, "cgi_manufacturer": brand,
        "cgi_source_id": sid if sid is not None else key.split(":")[1],
        "cgi_option_count": opts, "cgi_spec_rows": spec_rows, "cgi_quality_flag": "",
    }


def erp(code, name, spec="", typ="[상품]", group="음향장비", search=""):
    return {
        "erp_code": code, "erp_name": name, "erp_type": typ, "erp_spec": spec,
        "erp_group": group, "erp_stock_mgmt": "수량관리대상", "erp_search": search or f"{name} {spec}",
    }


class TestIdentifiers(unittest.TestCase):
    def test_proposed_code_rule(self):
        self.assertEqual(proposed_code("samasound:3836", "samasound"), "SS-3836")
        self.assertEqual(proposed_code("samamusic:1948", "samamusic"), "SM-1948")
        self.assertEqual(proposed_code("other:1", "unknown"), "")

    def test_brand_ok_english_and_token(self):
        m = master("samasound:1", "믹서", "ALLEN&HEATH", "SQ5")
        self.assertTrue(brand_ok(m, erp("000100", "SQ5 믹서", "SQ5", search="allen&heath sq5 믹서")))
        self.assertTrue(brand_ok(m, erp("000100", "SQ5 믹서", "SQ5", search="ALLEN HEATH SQ5")))
        self.assertFalse(brand_ok(m, erp("000100", "SQ5 믹서", "SQ5", search="야마하 sq5")))


class TestScoring(unittest.TestCase):
    def test_exact_model_brand(self):
        m = master("samasound:10", "디지털 믹서 SQ5+", "ALLEN&HEATH", "SQ5+")
        e = erp("000200", "디지털 믹서", "SQ5+", search="알렌히스 SQ5+ 믹서 ALLEN&HEATH")
        sc, basis = score_pair(m, e)
        self.assertGreaterEqual(sc, EXACT_FLOOR)
        self.assertEqual(basis, "model_brand_exact")

    def test_model_exact_brand_diff_is_normalized_floor(self):
        m = master("samasound:11", "케이블", "KLOTZ", "MY206SW")
        e = erp("000201", "오디오 케이블", "MY206SW", search="마이크 케이블")
        sc, basis = score_pair(m, e)
        self.assertEqual((sc, basis), (80, "model_exact_brand_diff"))

    def test_name_exact(self):
        m = master("samasound:12", "스피커 스탠드", "", "")
        e = erp("000202", "스피커 스탠드")
        sc, basis = score_pair(m, e)
        self.assertEqual((sc, basis), (75, "name_exact"))

    def test_suspect_capped(self):
        m = master("samasound:13", "인터페이스 포커RITE USB", "FOCUSRITE", "SCARLETT2I2")
        e = erp("000203", "포커스코어 scarlett2i2 인터페이스")
        s = suspect_score(m, e)
        self.assertLessEqual(s, SCORE_SUSPECT_MAX)
        self.assertGreater(s, 0)

    def test_set_guard_downgrades_exact(self):
        m = master("samasound:14", "마이크 단품", "SHURE", "SM58")
        e = erp("000204", "SM58 보컬 마이크 세트", "SM58", typ="[세트상품]", search="SHURE SM58 보컬 마이크 세트")
        sc, basis = score_pair(m, e)
        self.assertGreaterEqual(sc, EXACT_FLOOR)
        sc2, basis2, rv = guard_downgrade(m, e, sc, basis)
        self.assertLess(sc2, EXACT_FLOOR)
        self.assertEqual(rv, "Y")
        self.assertIn("erp_set_vs_single_master", basis2)

    def test_master_set_vs_single_erp_guard(self):
        m = master("samasound:16", "SM58 세트 구성", "SHURE", "SM58")
        e = erp("000206", "SM58 마이크", "SM58", search="SHURE SM58")
        sc, basis = score_pair(m, e)
        self.assertGreaterEqual(sc, EXACT_FLOOR)
        sc2, basis2, rv = guard_downgrade(m, e, sc, basis)
        self.assertLess(sc2, EXACT_FLOOR)
        self.assertIn("master_set_vs_single_erp", basis2)

    def test_state_token_guard(self):
        m = master("samasound:15", "[리퍼비시] 믹서", "YAMAHA", "MG16")
        e = erp("000205", "믹서", "MG16", search="야마하 mg16")
        sc, basis, rv = guard_downgrade(m, e, 95, "model_brand_exact")
        self.assertIn("state_token_mismatch", basis)
        self.assertEqual(rv, "Y")


class TestMapping(unittest.TestCase):
    def setUp(self):
        self.masters = [
            master("samasound:1", "믹서 SQ5", "ALLEN&HEATH", "SQ5"),
            master("samasound:2", "케이블", "KLOTZ", "PW02X"),
            master("samasound:3", "미확인 제품", "NNNN", ""),
            master("samasound:4", "독립 신규 상품 XYZ", "GENELEC", "XYZ999"),
            master("samasound:5", "SM58 세트 구성", "SHURE", "SM58"),
        ]
        self.ers = [
            erp("000001", "디지털 믹서", "SQ5", search="ALLEN&HEATH SQ5 믹서"),
            erp("000002", "케이블 2ch", "PW02X", search="KLOTZ PW02X"),
            erp("000003", "무관 품목", "", search="무관"),
            erp("000004", "SM58 마이크", "SM58", search="SHURE SM58"),
        ]

    def rows(self):
        return build_mapping(self.masters, self.ers, {"samasound:1"})

    def test_classification(self):
        by_key = {r["master_product_id"]: r for r in self.rows()}
        self.assertEqual(by_key["samasound:1"]["matching_type"], "EXACT_MATCH")
        self.assertEqual(by_key["samasound:1"]["erp_item_code"], "000001")
        self.assertEqual(by_key["samasound:1"]["naver_registered"], "Y")
        self.assertEqual(by_key["samasound:2"]["matching_type"], "EXACT_MATCH")
        self.assertEqual(by_key["samasound:3"]["matching_type"], "INSUFFICIENT_DATA")
        self.assertEqual(by_key["samasound:4"]["matching_type"], "NEW_CANDIDATE")

    def test_set_vs_single_not_merged(self):
        by_key = {r["master_product_id"]: r for r in self.rows()}
        r = by_key["samasound:5"]
        self.assertEqual(r["matching_type"], "SUSPECTED_DUPLICATE")
        self.assertEqual(r["review_required"], "Y")

    def test_determinism(self):
        a = build_mapping(copy.deepcopy(self.masters), copy.deepcopy(self.ers), set())
        b = build_mapping(copy.deepcopy(self.masters), copy.deepcopy(self.ers), set())
        buf_a, buf_b = io.StringIO(), io.StringIO()
        w_a = csv.DictWriter(buf_a, fieldnames=list(a[0].keys()), extrasaction="ignore")
        w_a.writeheader(); [w_a.writerow(r) for r in a]
        w_b = csv.DictWriter(buf_b, fieldnames=list(b[0].keys()), extrasaction="ignore")
        w_b.writeheader(); [w_b.writerow(r) for r in b]
        self.assertEqual(buf_a.getvalue(), buf_b.getvalue())

    def test_inputs_not_mutated(self):
        m0, e0 = copy.deepcopy(self.masters), copy.deepcopy(self.ers)
        build_mapping(self.masters, self.ers, set())
        self.assertEqual(m0, self.masters)
        self.assertEqual(e0, self.ers)

    def test_conflict_multi_master_same_erp(self):
        masters = [
            master("samasound:1", "A 믹서", "ALLEN&HEATH", "SQ5"),
            master("samasound:2", "B 믹서", "ALLEN&HEATH", "SQ5"),
        ]
        ers = [erp("000001", "믹서", "SQ5", search="ALLEN&HEATH SQ5")]
        rows = build_mapping(masters, ers, set())
        types = sorted(r["matching_type"] for r in rows)
        self.assertIn("EXACT_MATCH", types)
        self.assertIn("CONFLICT", types)
        winner = next(r for r in rows if r["matching_type"] == "EXACT_MATCH")
        self.assertEqual(winner["review_required"], "Y")
        self.assertEqual(winner["conflict_reason"], "multi_master_same_erp")

    def test_integrity_clean_and_broken(self):
        rows = self.rows()
        self.assertEqual(integrity_check(rows, self.masters, self.ers), [])
        bad = copy.deepcopy(rows)
        bad[0]["erp_item_code"] = "999999"
        issues = integrity_check(bad, self.masters, self.ers)
        self.assertTrue(any("unknown_erp_code" in i for i in issues))

    def test_summary_fields(self):
        s = summarize(self.rows(), self.ers)
        self.assertEqual(s["mapping_rows"], 5)
        self.assertEqual(s["erp_actual_items"], 4)
        self.assertEqual(s["classification_counts"]["EXACT_MATCH"], 2)
        self.assertEqual(s["erp_items_confirmed_mapped"], 2)
        self.assertEqual(s["unmatched_erp_items"], 2)
        self.assertEqual(s["erp_writes"], 0)
        self.assertEqual(s["naver_writes"], 0)
        self.assertEqual(s["master_writes"], 0)

    def test_write_csv_utf8_bom_sig(self):
        rows = self.rows()
        buf = io.StringIO()
        # write_mapping_csv needs a path; use temp dir
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "m.csv")
            write_mapping_csv(rows, p)
            with open(p, "rb") as fh:
                raw = fh.read()
            self.assertTrue(raw.startswith(b"\xef\xbb\xbf"))
            text = raw.decode("utf-8-sig")
            self.assertIn("master_product_id", text)
            self.assertEqual(len(list(csv.DictReader(io.StringIO(text)))), 5)


if __name__ == "__main__":
    unittest.main()
