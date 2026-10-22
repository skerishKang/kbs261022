"""브라우저 원시 덤프 → 통합 상품 마스터 레코드 변환.

원시 덤프는 ZCode 내장 브라우저(IAB)가 실제로 렌더한 화면에서 추출한
필드 사전이다. 이 모듈은 그 값을 **규칙대로** 마스터 레코드로 바꾼다.

원천에 없는 값은 채우지 않는다:
* ``브랜드`` 스펙행이 없으면 ``brand`` 는 null (samasound 전량)
* ``제조사`` 스펙행이 없으면 ``manufacturer`` 는 null (samamusic 전량)
* ``모델명`` 스펙행이 없으면 ``model`` 은 null (samasound 전량)
* 도매가 / 재고는 공개 근거가 없으므로 항상 null
"""

from __future__ import annotations

import re
from typing import Any, Mapping, Optional, Sequence

from . import normalize as N
from .schema import SITES, source_key

#: 사이트별 스펙행 → 마스터 필드 매핑.
SITE_FIELD_MAP: dict[str, dict[str, str]] = {
    "samasound": {
        "상품명": "name",
        "상품요약정보": "summary",
        "상품간략설명": "simple_description",
        "제조사": "manufacturer",
        "영문상품명": "english_name",
        "원산지": "origin",
        "판매가": "public_price_text",
    },
    "samamusic": {
        "상품명": "name",
        "상품요약정보": "summary",
        "상품간략설명": "simple_description",
        "브랜드": "brand",
        "모델명": "model",
        "원산지": "origin",
        "배송비": "shipping_fee",
        "적합인증번호": "certification",
        "안전확인신고번호": "safety_certification",
        "판매가": "public_price_text",
    },
}

#: 마스터에 직접 승격되지 않고 ``specs`` 안에 원본 그대로 보존되는 행.
SPECS_ONLY_FIELDS: tuple[str, ...] = (
    "구매방법",
    "배송주기",
    "원산지",
    "배송비",
    "적합인증번호",
    "안전확인신고번호",
    "영문상품명",
    "공급자적합성확인대상제품",
)

_PRODUCT_NO_RE = {
    "samasound": re.compile(r"/product/[^/]+/(\d+)/"),
    "samamusic": re.compile(r"product_no=(\d+)"),
}

#: 수집 URL 에서 관찰된 cate_no 를 뽑아낸다. 목록/상세 URL 에 실제 존재하는 값만.
_CATE_NO_RE = {
    "samasound": re.compile(r"/category/(\d+)/display/"),
    "samamusic": re.compile(r"cate_no=(\d+)"),
}

#: 브라우저로 계층을 확인한 카테고리 경로만 여기에 등록한다.
#: (site, cate_no) -> (경로 이름, 경로 cate_no)
VERIFIED_CATEGORY_PATHS: dict[tuple[str, str], tuple[list[str], list[str]]] = {
    ("samasound", "42"): (
        ["제품 정보", "브랜드별 보기", "S-Z", "Shure"],
        ["23", "24", "364", "42"],
    ),
    ("samamusic", "671"): (
        ["브랜드", "SHURE"],
        ["24", "671"],
    ),
}

#: 옵션 문자열에서 추가금/품절 표기를 뽑기 위한 패턴.
_OPTION_DELTA_RE = re.compile(r"\(([+-]?[0-9][0-9,]*)\s*원\)")
_SOLDOUT_MARK = "품절"


def _extract_options(dump: Mapping[str, Any]) -> list[dict[str, Any]]:
    """원시 덤프의 옵션 영역을 마스터 옵션 구조로 변환.

    값이 하나도 없으면 빈 리스트. 옵션 테이블은 있어도 항목이 비어 있는
    경우가 많으므로 "옵션 없음" 과 "빈 테이블" 을 구분하지 않는다.
    """
    options: list[dict[str, Any]] = []
    for entry in dump.get("options", []) or []:
        label = N.normalize_text(entry.get("label"))
        text = N.normalize_text(entry.get("text"))
        items = [N.normalize_text(i) for i in (entry.get("items") or [])]
        items = [i for i in items if i and not i.startswith("- 옵션") and i != "옵션선택"]
        values: list[dict[str, Any]] = []
        for item in items:
            if item in values:
                continue
            delta = None
            m = _OPTION_DELTA_RE.search(item)
            if m:
                delta = int(m.group(1).replace(",", ""))
            values.append(
                {
                    "label": item,
                    "price_delta": delta,
                    "soldout": _SOLDOUT_MARK in item,
                }
            )
        if not values:
            # select 옵션 (옵션 항목이 li 로 안 잡히는 경우)
            for sel in dump.get("selects", []) or []:
                for opt in sel.get("options", []) or []:
                    o = N.normalize_text(opt)
                    if not o or "옵션을 선택" in o:
                        continue
                    m = _OPTION_DELTA_RE.search(o)
                    values.append(
                        {
                            "label": o,
                            "price_delta": int(m.group(1).replace(",", "")) if m else None,
                            "soldout": _SOLDOUT_MARK in o,
                        }
                    )
        if not values:
            continue
        options.append({"label": label, "text": text, "values": values})
    return options


def _category_path(site: str, cate_no: Optional[str]) -> tuple[list[str], list[str]]:
    """카테고리 경로.

    브라우저로 계층을 확인한 경우에만 이름을 채운다. 확인하지 않은 cate_no 는
    경로 이름을 비우고 ``category_path_not_verified`` 플래그로 남긴다.
    """
    if not cate_no:
        return [], []
    verified = VERIFIED_CATEGORY_PATHS.get((site, cate_no))
    if verified is None:
        return [], []
    return list(verified[0]), list(verified[1])


def _cate_no_from_url(site: str, url: Optional[str]) -> Optional[str]:
    """수집 URL 에서 관찰된 cate_no 를 추출한다."""
    if not url:
        return None
    m = _CATE_NO_RE[site].search(url)
    return m.group(1) if m else None


def build_record(
    dump: Mapping[str, Any],
    *,
    extraction_time: str,
    extraction_method: str = "browser_zcode_iab",
    verification_status: str = "browser_verified",
) -> Optional[dict[str, Any]]:
    """원시 덤프 1건 → 마스터 레코드 1건.

    ``상품명`` 이 없는 덤프(존재하지 않는 product_no 등)는 ``None`` 을 돌려준다.
    """
    site = dump.get("site")
    if site not in SITES:
        raise ValueError(f"unknown site: {site!r}")

    raw = dict(dump.get("raw_fields") or {})
    field_map = SITE_FIELD_MAP[site]

    name = N.normalize_name(raw.get("상품명"))
    if not name:
        return None

    product_id = dump.get("source_product_id")
    if not product_id:
        m = _PRODUCT_NO_RE[site].search(dump.get("final_url") or "")
        product_id = m.group(1) if m else None
    if not product_id:
        return None
    product_id = str(product_id)

    # --- 스펙행 → 마스터 필드 (존재하는 행만) -------------------------------
    brand = N.normalize_brand(raw.get("브랜드")) if "브랜드" in raw else None
    manufacturer = N.normalize_manufacturer(raw.get("제조사")) if "제조사" in raw else None
    model = N.normalize_name(raw.get("모델명")) if "모델명" in raw else None
    english_name = N.normalize_name(raw.get("영문상품명")) if "영문상품명" in raw else None

    summary = N.normalize_name(raw.get("상품요약정보"))
    simple_description = N.normalize_name(raw.get("상품간략설명"))
    origin = N.normalize_name(raw.get("원산지"))

    price = N.normalize_price(raw.get("판매가"))

    # --- specs: 원본 스펙행 전체 (출처 보존) --------------------------------
    specs: dict[str, Any] = {}
    for label, value in raw.items():
        if label in field_map or label in ("상품명", "판매가"):
            continue
        specs[label] = N.normalize_text(value)
    if english_name:
        specs["영문상품명"] = english_name
    if origin:
        specs["원산지"] = origin
    if summary:
        specs["상품요약정보"] = summary
    if simple_description:
        specs["상품간략설명"] = simple_description

    # --- 카테고리 ------------------------------------------------------------
    cate_no = dump.get("cate_no")
    if cate_no is None:
        cate_no = _cate_no_from_url(site, dump.get("collection_url") or dump.get("final_url"))
    cate_no = str(cate_no) if cate_no is not None else None
    cat_names, cat_ids = _category_path(site, cate_no)

    # --- 이미지 --------------------------------------------------------------
    image_urls = [
        u if u.startswith("http") else ("https:" + u if u.startswith("//") else u)
        for u in (dump.get("image_urls") or [])
    ]

    # --- 옵션 ----------------------------------------------------------------
    options = _extract_options(dump)

    # --- 파생 매칭 키 --------------------------------------------------------
    phrases = N.model_phrases(name, brand=brand, source_model=model)
    derived = {
        "model_phrases": phrases,
        "model_phrase_compact": sorted(
            {c for c in (N.model_compact(p) for p in phrases) if c}
        ),
        "variant_signature": sorted(N.variant_signature(name)),
        "derivation_note": (
            "파생 매칭 전용 값. 원천 'model' 필드와 별개이며 "
            "samasound 는 모델명 스펙행이 없어 model=null 로 유지된다."
        ),
    }

    quality_flags: list[str] = []
    if price.price_type == "inquiry":
        quality_flags.append("public_price_inquiry_only")
    if brand is None and site == "samasound":
        quality_flags.append("no_brand_field_on_site")
    if model is None and site == "samasound":
        quality_flags.append("no_model_field_on_site")
    if manufacturer is None and site == "samamusic":
        quality_flags.append("no_manufacturer_field_on_site")
    if not options:
        quality_flags.append("no_options")
    if dump.get("soldout_text"):
        quality_flags.append("page_mentions_soldout")
    if cate_no and not cat_names:
        quality_flags.append("category_path_not_verified")

    return {
        "source_site": site,
        "source_product_id": product_id,
        "source_key": source_key(site, product_id),
        "canonical_url": dump.get("canonical_url"),
        "collection_url": dump.get("collection_url") or dump.get("final_url"),
        "name": name,
        "brand": brand,
        "manufacturer": manufacturer,
        "model": model,
        "category_path": cat_names,
        "category_namespace": SITES[site]["namespace"],
        "category_path_cate_no": cat_ids,
        "category_leaf_cate_no": cate_no,
        "specs": specs,
        "options": options,
        "image_urls": image_urls,
        "public_price": price.value,
        "public_price_text": price.raw or None,
        "price_type": price.price_type,
        # 공개 근거 없음 → 항상 null (요구사항 4)
        "dealer_price": None,
        "availability": None,
        "extraction_time": extraction_time,
        "extraction_method": extraction_method,
        "source_evidence": {
            "url": dump.get("final_url"),
            "page_title": dump.get("page_title"),
            "observed_fields": {k: N.normalize_text(v) for k, v in raw.items()},
            "option_labels": [o.get("label") for o in dump.get("options", []) or []],
            "notes": "ZCode 내장 브라우저(IAB)로 실제 렌더 화면에서 추출",
        },
        "verification_status": verification_status,
        "derived": derived,
        # 향후 스토어/ERP 매핑 (요구사항 5) — 현재는 전부 null
        "naver_product_id": None,
        "erp_item_code": None,
        "smartstore_category_no": None,
        "mapping_ready": False,
        "quality_flags": quality_flags,
        "dedupe_group_id": None,
        "dedupe_confidence": None,
    }


def build_records(
    dumps: Sequence[Mapping[str, Any]],
    *,
    extraction_time: str,
    extraction_method: str = "browser_zcode_iab",
    verification_status: str = "browser_verified",
) -> list[dict[str, Any]]:
    """원시 덤프 목록 → 마스터 레코드 목록 (商品名 없는 항목은 제외)."""
    out: list[dict[str, Any]] = []
    for dump in dumps:
        record = build_record(
            dump,
            extraction_time=extraction_time,
            extraction_method=extraction_method,
            verification_status=verification_status,
        )
        if record is not None:
            out.append(record)
    return out
