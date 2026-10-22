"""정규화 규칙 — 텍스트 / 가격 / 모델 / 변형(variant).

이 모듈은 *파생* 값(derived)만 만든다. 원천 필드 값 자체를 변경하지 않는다.

용어 구분 (issue #8 요구사항 2 — 제조사/브랜드/모델 혼동 방지)
--------------------------------------------------------------
``brand``        판매자가 상품의 "브랜드" 라벨로 명시한 값.
                 samamusic 만 ``브랜드`` 스펙행을 가진다.
``manufacturer`` 원재료/제조사 라벨. samasound 의 ``제조사`` 스펙행.
                 samasound 에는 ``브랜드`` 행이 없으므로 ``brand`` 는 null 로 둔다.
``model``        모델명을 명시한 스펙행이 있을 때만 채운다.
                 samasound 에는 ``모델명`` 행이 없으므로 ``model`` 은 null 로 둔다.
                 (samasound 의 ``영문상품명`` 은 원본 증거로만 보존한다.)

파생 매칭 키(``model_phrases``)는 ``model`` 필드와 **별개**이며, 교차 사이트
후보 생성에만 사용한다. 매칭이 아니라 출처 필드로 오인될 수 있어
``derived`` 섹션 아래에만 기록한다.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Iterable, Optional, Sequence

# --------------------------------------------------------------------------
# 가격
# --------------------------------------------------------------------------

#: 공개 판매가가 아니라 "문의"로만 표현되는 표시. 숫자 금액을 만들지 않는다.
PRICE_INQUIRY_MARKERS: tuple[str, ...] = (
    "가격 문의",
    "가격문의",
    "별도 문의",
    "문의",
    "전화 문의",
    "가격협의",
    "별도",
)

_PRICE_NUMBER_RE = re.compile(r"([0-9][0-9,\.]*)\s*원")


@dataclass(frozen=True)
class PriceResult:
    """가격 파싱 결과.

    value      정규화된 금액(원). 공개 금액이 없으면 ``None``.
    price_type ``"public_selling_price"`` | ``"inquiry"`` | ``"unknown"``
    raw        화면에 실제로 표시된 문자열.
    """

    value: Optional[int]
    price_type: str
    raw: str

    @property
    def is_public(self) -> bool:
        return self.price_type == "public_selling_price" and self.value is not None


def normalize_price(text: Optional[str]) -> PriceResult:
    """판매가 텍스트를 금액 + 유형으로 정규화한다.

    "가격 문의" 같은 문자열에서는 숫자를 만들지 않고 ``price_type='inquiry'`` 로
    분류한다. 숫자가 전혀 없으면 ``unknown`` 이다.
    """
    if text is None:
        return PriceResult(None, "unknown", "")
    raw = normalize_text(text)
    if not raw:
        return PriceResult(None, "unknown", "")

    m = _PRICE_NUMBER_RE.search(raw)
    if m:
        digits = m.group(1).replace(",", "").replace(".", "")
        try:
            return PriceResult(int(digits), "public_selling_price", raw)
        except ValueError:  # pragma: no cover - 방어적
            return PriceResult(None, "unknown", raw)

    for marker in PRICE_INQUIRY_MARKERS:
        if marker in raw:
            return PriceResult(None, "inquiry", raw)

    return PriceResult(None, "unknown", raw)


# --------------------------------------------------------------------------
# 일반 텍스트
# --------------------------------------------------------------------------

_WS_RE = re.compile(r"\s+")


def normalize_text(value: Optional[str]) -> str:
    """유니코드 정규화 + 공백 축약."""
    if value is None:
        return ""
    text = unicodedata.normalize("NFKC", str(value))
    return _WS_RE.sub(" ", text).strip()


def normalize_brand(value: Optional[str]) -> Optional[str]:
    """브랜드 표기 정규화 (대문자 비교용). 원본 표기를 ``display`` 로 보존한다."""
    text = normalize_text(value)
    if not text:
        return None
    return text.upper()


def normalize_manufacturer(value: Optional[str]) -> Optional[str]:
    """제조사 표기 정규화 (공백 축약만, 대소문자 보존)."""
    text = normalize_text(value)
    return text or None


def normalize_name(value: Optional[str]) -> Optional[str]:
    text = normalize_text(value)
    return text or None


# --------------------------------------------------------------------------
# 모델 표현 후보 (model phrase) 추출
# --------------------------------------------------------------------------

#: 모델 표현에 쓰일 수 있는 ASCII 문자. 한글은 모델 표현을 끊는다.
_MODEL_CHARS = set(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "abcdefghijklmnopqrstuvwxyz"
    "0123456789"
    " -/+.,&()_"
)

#: "2세대" 같은 세대 표기. 모델 표현 뒤에 붙는 숫자를 떼어 내기 위해 사용한다.
_GENERATION_RE = re.compile(r"^\s*\d+\s*세대")

_BRACKETED_RE = re.compile(r"[\(\[][^)\]]*[\)\]]")


def _is_model_run(run: str) -> bool:
    """모델 표현 후보인지 판정: 영문자와 숫자가 모두 있어야 한다."""
    has_alpha = any(c.isalpha() and c.isascii() for c in run)
    has_digit = any(c.isdigit() for c in run)
    return has_alpha and has_digit


def _strip_generation_suffix(text: str) -> str:
    """"MVX2UG2 2세대" -> "MVX2UG2"."""
    out = text
    while True:
        m = _GENERATION_RE.match(out)
        if not m:
            return out.strip()
        out = out[m.end():]


#: 이름 맨 앞에 오는 "대문자만" 토큰. 브랜드 표기로 본다.
#: 숫자를 포함하면 모델 표현일 수 있으므로 제외한다 ("MVX2U G2" 보호).
_LEADING_BRAND_TOKEN_RE = re.compile(r"^([A-Z][A-Z&.\-]{1,14})(?=\s)")


def _model_runs(text: str) -> list[str]:
    """문자열에서 모델 후보 연속 구간들을 뽑는다.

    구간 뒤에 한글이 이어붙는 경우 흔한 오염을 제거한다.
    * "MVX2UG2 2세대" → "MVX2UG2"      (세대 표기)
    * "MV88 USB-C C타입" → "MV88 USB-C"  (한글 단위의 첫 글자가 앞에서 잘린 경우)
    """
    runs: list[str] = []
    buf: list[str] = []
    start = 0
    for index, ch in enumerate(text):
        if ch in _MODEL_CHARS:
            if not buf:
                start = index
            buf.append(ch)
        else:
            if buf:
                runs.append((("".join(buf)), start, index))
                buf = []
    if buf:
        runs.append(("".join(buf), start, len(text)))

    out: list[str] = []
    for run, _, end in runs:
        run = run.strip(" \t-+/.,&()_")
        if not run:
            continue
        tail = text[end:]
        # "… 2" 뒤에 "세대" 가 이어지면 숫자를 잘라 낸다.
        if run[-1].isdigit():
            idx = len(run)
            while idx > 0 and run[idx - 1].isdigit():
                idx -= 1
            if _GENERATION_RE.match(" " + run[idx:] + tail.lstrip()):
                run = run[:idx].strip()
        # "… C" 뒤에 한글이 이어지면(타입/포함 등) 마지막 한글 첫 글자를 잘라 낸다.
        if len(run) >= 2 and run[-1].isalpha() and run[-1].isascii() and run[-2] == " ":
            if tail[:1] and _is_hangul(tail[:1]):
                run = run[:-2].strip()
        if not run or not _is_model_run(run):
            continue
        out.append(run)
    return out


def _is_hangul(ch: str) -> bool:
    return "\uac00" <= ch <= "\ud7a3" or "\u3130" <= ch <= "\u318f"


def extract_model_phrase(name: Optional[str], brand: Optional[str] = None) -> Optional[str]:
    """상품명에서 대표 모델 표현을 추출한다.

    1. ``brand`` 가 주어지고 이름 앞에 있으면 그 표기를 제거한다.
    2. ``brand`` 가 없거나 일치하지 않으면, 이름 맨 앞의 "대문자만" 토큰을
       브랜드 표기로 보고 제거한다. (samasound 는 브랜드 스펙행이 없으므로
       이름에 박힌 "SHURE" 를 제거해야 모델 표현이 잡힌다)
    3. 남은 구간에서 영문자+숫자를 모두 포함하는 연속 구간 중 가장 긴 것을
       대표 모델 표현으로 삼는다.
    """
    text = normalize_text(name)
    if not text:
        return None

    candidates: list[str] = []
    if brand:
        b = normalize_text(brand)
        if b and text.upper().startswith(b.upper()):
            candidates.append(text[len(b):].strip())
    leading = _LEADING_BRAND_TOKEN_RE.match(text)
    if leading:
        without = text[leading.end():].strip()
        if without:
            candidates.append(without)
    candidates.append(text)

    for candidate in candidates:
        runs = _model_runs(candidate)
        if runs:
            return max(runs, key=lambda r: (len(r), r))
    return None


def model_compact(phrase: Optional[str]) -> Optional[str]:
    """모델 표현 비교용 정규화 (영숫자만, 대문자).

    "WL185MB/C-TQG" -> "WL185MBCTQG", "MVX2U G2" -> "MVX2UG2".
    """
    if phrase is None:
        return None
    text = unicodedata.normalize("NFKC", str(phrase))
    compact = "".join(c for c in text if c.isascii() and c.isalnum()).upper()
    return compact or None


def model_phrases(
    name: Optional[str],
    brand: Optional[str] = None,
    source_model: Optional[str] = None,
) -> list[str]:
    """교차 사이트 후보 생성에 쓰는 모델 표현 목록 (파생값).

    ``source_model`` 이 있으면 그것도 포함한다. 정규화Compact 형태는
    ``dedupe`` 모듈에서 비교한다.
    """
    out: list[str] = []
    derived = extract_model_phrase(name, brand)
    if derived:
        out.append(derived)
    if source_model:
        text = normalize_text(source_model)
        if text and text not in out:
            out.append(text)
    return out


# --------------------------------------------------------------------------
# 변형(variant) 서명
# --------------------------------------------------------------------------

#: 변형 판단에서 제외하는 일반 한국어 단어.
VARIANT_STOPWORDS: frozenset[str] = frozenset(
    {
        "슈어",
        "세트",
        "등",
        "용",
        "및",
        "전용",
        "포함",
        "패키지",
        "제품",
        "상품",
        "개",
        "개입",
        "모델",
        "타입",
        "신규",
        "품절",
        "판매",
        "정품",
        "한국",
        "국내",
        "해외",
        "정식",
        "버전",
        "대",
        "소",
        "및",
        "무선",
        "유선",
    }
)

_KOREAN_TOKEN_RE = re.compile(r"[가-힣]+")


def korean_tokens(text: Optional[str]) -> list[str]:
    """문자열에서 한글 단어를 뽑는다."""
    if not text:
        return []
    return _KOREAN_TOKEN_RE.findall(unicodedata.normalize("NFC", str(text)))


def variant_signature(name: Optional[str]) -> frozenset[str]:
    """상품명에서 변형 구분용 한국어 토큰 집합을 만든다.

    "KSM32C ... 라이트 세트" -> {"스튜디오", "콘덴서", "마이크", "라이트"}
    "KSM32C ... 프리미엄 세트" -> {"스튜디오", "콘덴서", "마이크", "프리미엄"}

    같은 모델이 여러 상품으로 파는 경우(예: 라이트/프리미엄 세트)를
    자동 병합으로 오인하지 않도록 사용한다.
    """
    tokens = korean_tokens(normalize_text(name))
    return frozenset(t for t in tokens if t not in VARIANT_STOPWORDS)


def variant_conflict(a: Optional[str], b: Optional[str]) -> bool:
    """두 상품명의 변형 서명이 서로 충돌하는지 판정.

    한쪽이 비어 있으면 충돌로 보지 않는다 (정보 부족 ≠ 충돌).
    """
    sa = variant_signature(a)
    sb = variant_signature(b)
    if not sa or not sb:
        return False
    return sa != sb


# --------------------------------------------------------------------------
# 이름 유사도
# --------------------------------------------------------------------------

_TOKEN_SPLIT_RE = re.compile(r"[^0-9A-Za-z가-힣]+")


def tokenize(text: Optional[str]) -> list[str]:
    """비교용 토큰 목록 (대소문자 무시, 한글 유지)."""
    if not text:
        return []
    normalized = unicodedata.normalize("NFC", normalize_text(text)).lower()
    return [t for t in _TOKEN_SPLIT_RE.split(normalized) if t]


def jaccard(a: Optional[str], b: Optional[str]) -> float:
    """토큰 집합 Jaccard 유사도."""
    ta, tb = set(tokenize(a)), set(tokenize(b))
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def values_agree(a: Optional[str], b: Optional[str]) -> bool:
    """두 표기값이 같은지 (대소문자/공백 무시)."""
    na, nb = normalize_text(a), normalize_text(b)
    if not na or not nb:
        return False
    return na.casefold() == nb.casefold()
