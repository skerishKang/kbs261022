"""정규화 규칙 단위 테스트.

모든 기대값은 브라우저/Http 로 실제 확인한 화면 표기에서 가져왔다.
"""

from __future__ import annotations

import unittest

from tools.product_master import normalize as N


class TestPrice(unittest.TestCase):
    def test_public_price_with_thousands_separator(self) -> None:
        result = N.normalize_price("279,000원")
        self.assertEqual(result.value, 279000)
        self.assertEqual(result.price_type, "public_selling_price")
        self.assertTrue(result.is_public)

    def test_price_inquiry_marker_has_no_number(self) -> None:
        result = N.normalize_price("가격 문의")
        self.assertIsNone(result.value)
        self.assertEqual(result.price_type, "inquiry")
        self.assertFalse(result.is_public)

    def test_dealer_inquiry_marker_has_no_number(self) -> None:
        # samamusic 목록의 data-price="^대리점 문의" 에 대응한다.
        result = N.normalize_price("대리점 문의")
        self.assertIsNone(result.value)
        self.assertEqual(result.price_type, "inquiry")

    def test_unknown_price(self) -> None:
        result = N.normalize_price("별도")
        self.assertIsNone(result.value)
        self.assertEqual(result.price_type, "inquiry")

    def test_empty_and_none(self) -> None:
        for value in (None, "", "   "):
            result = N.normalize_price(value)
            self.assertIsNone(result.value)
            self.assertEqual(result.price_type, "unknown")


class TestModelPhrase(unittest.TestCase):
    def test_samasound_name_is_the_model(self) -> None:
        self.assertEqual(N.extract_model_phrase("SM35-XLR"), "SM35-XLR")

    def test_leading_brand_token_is_removed(self) -> None:
        # samasound 는 브랜드 스펙행이 없어 이름에 박힌 "SHURE" 를 제거해야 한다.
        phrase = N.extract_model_phrase("SHURE KSM40C 슈어 프리미엄 스튜디오 콘덴서 마이크")
        self.assertEqual(phrase, "KSM40C")

    def test_brand_field_prefix_is_removed(self) -> None:
        phrase = N.extract_model_phrase(
            "SHURE WL185MB/C-TQG 무선용 단일 지향성 핀마이크 블랙", brand="SHURE"
        )
        self.assertEqual(phrase, "WL185MB/C-TQG")

    def test_model_with_digits_is_not_treated_as_brand(self) -> None:
        phrase = N.extract_model_phrase("MVX2U G2")
        self.assertEqual(phrase, "MVX2U G2")

    def test_generation_suffix_is_trimmed(self) -> None:
        phrase = N.extract_model_phrase(
            "SHURE MVX2UG2 2세대 슈어 XLR to USB-C 오디오 인터페이스 (모바일 지원)",
            brand="SHURE",
        )
        self.assertEqual(phrase, "MVX2UG2")

    def test_trailing_hangul_first_letter_is_trimmed(self) -> None:
        phrase = N.extract_model_phrase(
            "Shure MV88 USB-C C타입 포터블 스테레오 컨덴서 마이크", brand="SHURE"
        )
        self.assertEqual(phrase, "MV88 USB-C")

    def test_letter_only_name_has_no_model_phrase(self) -> None:
        self.assertIsNone(N.extract_model_phrase("TONEX PEDAL Bass Edition"))
        self.assertIsNone(N.extract_model_phrase(""))

    def test_model_compact(self) -> None:
        self.assertEqual(N.model_compact("WL185MB/C-TQG"), "WL185MBCTQG")
        self.assertEqual(N.model_compact("MVX2U G2"), "MVX2UG2")
        self.assertEqual(N.model_compact("SLXD1+"), "SLXD1")
        self.assertIsNone(N.model_compact(None))


class TestVariant(unittest.TestCase):
    def test_light_and_premium_sets_differ(self) -> None:
        light = "SHURE KSM32C 슈어 스튜디오 콘덴서 마이크 라이트 세트"
        premium = "SHURE KSM32C 슈어 스튜디오 콘덴서 마이크 프리미엄 세트"
        self.assertTrue(N.variant_conflict(light, premium))
        self.assertFalse(N.variant_conflict(light, light))

    def test_missing_variant_is_not_a_conflict(self) -> None:
        self.assertFalse(N.variant_conflict("WL185MB/C-TQG", "SHURE WL185MB/C-TQG 무선용 핀마이크"))

    def test_stopwords_are_removed(self) -> None:
        signature = N.variant_signature("SHURE KSM32C 슈어 스튜디오 콘덴서 마이크 라이트 세트")
        self.assertIn("라이트", signature)
        self.assertNotIn("슈어", signature)
        self.assertNotIn("세트", signature)


class TestSimilarity(unittest.TestCase):
    def test_jaccard_identical(self) -> None:
        text = "SHURE KSM32C 슈어 스튜디오 콘덴서 마이크 라이트 세트"
        self.assertEqual(N.jaccard(text, text), 1.0)

    def test_jaccard_disjoint(self) -> None:
        self.assertEqual(N.jaccard("abc", "xyz"), 0.0)

    def test_values_agree_is_case_insensitive(self) -> None:
        self.assertTrue(N.values_agree("Shure", "SHURE"))
        self.assertFalse(N.values_agree("Shure", "PreSonus"))
        self.assertFalse(N.values_agree("Shure", None))


if __name__ == "__main__":
    unittest.main()
