"""통합 상품 마스터 스키마.

이슈 #8 요구사항 1 의 필수 컬럼을 모두 포함하고, 요구사항 5 의 향후
스토어/ERP 매핑을 위한 확장 컬럼과 출처/품질 기록을 더한다.

핵심 규칙
----------
* 복합키 = ``(source_site, source_product_id)`` (요구사항 2)
* ``cate_no`` 는 사이트별 namespace 로 분리 (요구사항 2)
* ``public_price`` 와 ``dealer_price`` 는 혼합 금지 (요구사항 4)
* 출처가 없는 필드는 ``null`` (요구사항 6)
"""

from __future__ import annotations

import csv
import json
from typing import Any, Iterable, Mapping, Optional, Sequence

SCHEMA_VERSION = "1.0.0"

#: 수집 대상 사이트. ``namespace`` 접두사와 1:1 대응한다.
SITES: dict[str, dict[str, Any]] = {
    "samasound": {
        "namespace": "samasound.cate_no",
        "display_name": "삼아사운드",
        "base_url": "https://www.samasound.co.kr",
        "canonical_host": "samasound.co.kr",
        "business_model": "B2B",
        "list_url_template": "/product/list.html?cate_no={cate_no}&page={page}",
        "detail_url_template": "/product/{slug}/{product_no}/category/{cate_no}/display/{display_group}/",
    },
    "samamusic": {
        "namespace": "samamusic.cate_no",
        "display_name": "삼아스토어",
        "base_url": "https://www.samamusic.co.kr",
        "canonical_host": "samastore.co.kr",
        "business_model": "B2C",
        "list_url_template": "/product/list.html?cate_no={cate_no}&page={page}",
        "detail_url_template": "/product/detail.html?product_no={product_no}&cate_no={cate_no}&display_group={display_group}",
    },
}

#: 사이트별 스펙행 존재 여부. 브라우저 실측 기준.
#: 없는 행은 절대 채우지 않는다 (요구사항 4, 7).
SITE_FIELD_AVAILABILITY: dict[str, dict[str, bool]] = {
    "samasound": {
        "name": True,
        "summary": True,
        "simple_description": True,
        "brand": False,          # 브랜드 스펙행 없음
        "manufacturer": True,    # "제조사"
        "model": False,          # "모델명" 없음 (영문상품명은 원본 증거로만 보존)
        "english_name": True,    # 일부 상품에만 존재
        "origin": True,
        "shipping_fee": False,
        "certification": False,
        "public_price": True,    # 값은 "가격 문의" 문자열 (숫자 없음)
        "options": True,         # 옵션 영역은 있으나 표본 15건은 모두 비어 있음
    },
    "samamusic": {
        "name": True,
        "summary": True,
        "simple_description": True,
        "brand": True,
        "manufacturer": False,   # 제조사 스펙행 없음
        "model": True,
        "english_name": False,
        "origin": True,
        "shipping_fee": True,
        "certification": True,
        "public_price": True,    # 실제 숫자
        "options": True,
    },
}

#: 필수 컬럼 (issue #8 요구사항 1).
REQUIRED_FIELDS: tuple[str, ...] = (
    "source_site",
    "source_product_id",
    "canonical_url",
    "name",
    "brand",
    "manufacturer",
    "model",
    "category_path",
    "specs",
    "image_urls",
    "public_price",
    "dealer_price",
    "availability",
    "extraction_time",
    "source_evidence",
    "verification_status",
)

#: 필수 컬럼 바로 뒤에 오는 출처(메타) 필드.
PROVENANCE_FIELDS: tuple[str, ...] = (
    "extraction_method",
)

#: 전체 마스터 레코드 필드 순서 (CSV 헤더와 동일).
MASTER_FIELDS: tuple[str, ...] = REQUIRED_FIELDS + PROVENANCE_FIELDS + (
    # 식별자 / 정규화 보조
    "source_key",
    "collection_url",
    "public_price_text",
    "price_type",
    "category_namespace",
    "category_path_cate_no",
    "category_leaf_cate_no",
    "options",
    # 파생값 (매칭 전용, 출처 필드 아님)
    "derived",
    # 확장: 향후 스토어/ERP 매핑 (issue #8 요구사항 5)
    "naver_product_id",
    "erp_item_code",
    "smartstore_category_no",
    "mapping_ready",
    # 품질
    "quality_flags",
    "dedupe_group_id",
    "dedupe_confidence",
)

CSV_COLUMNS: tuple[str, ...] = MASTER_FIELDS

VERIFICATION_STATUSES: tuple[str, ...] = (
    "browser_verified",              # ZCode 브라우저로 실제 확인
    "http_verified",                 # HTTP 수집으로 확인
    "browser_http_crossverified",    # 브라우저 + HTTP 양쪽 일치
    "unverified",                    # 미확인
)

PRICE_TYPES: tuple[str, ...] = ("public_selling_price", "inquiry", "unknown")


def source_key(site: str, product_id: str) -> str:
    """복합키 ``(site, product_id)`` 를 문자열로 표현한다."""
    return f"{site}:{product_id}"


def json_schema() -> dict[str, Any]:
    """레코드 1건에 대한 JSON Schema (draft 2020-12)."""
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://github.com/skerishKang/kbs261022/schemas/product-master-record.json",
        "title": "CGI 통합 상품 마스터 레코드",
        "type": "object",
        "required": list(REQUIRED_FIELDS),
        "additionalProperties": False,
        "properties": {
            "source_site": {"type": "string", "enum": sorted(SITES)},
            "source_product_id": {"type": "string", "minLength": 1},
            "source_key": {"type": "string", "pattern": "^[a-z]+:[0-9A-Za-z_-]+$"},
            "canonical_url": {"type": "string", "minLength": 1},
            "collection_url": {"type": ["string", "null"]},
            "name": {"type": "string", "minLength": 1},
            "brand": {"type": ["string", "null"]},
            "manufacturer": {"type": ["string", "null"]},
            "model": {"type": ["string", "null"]},
            "category_path": {"type": "array", "items": {"type": "string"}},
            "category_namespace": {"type": "string", "enum": [s["namespace"] for s in SITES.values()]},
            "category_path_cate_no": {"type": "array", "items": {"type": "string"}},
            "category_leaf_cate_no": {"type": ["string", "null"]},
            "specs": {"type": "object"},
            "options": {"type": "array"},
            "image_urls": {"type": "array", "items": {"type": "string"}},
            "public_price": {"type": ["integer", "null"], "minimum": 0},
            "public_price_text": {"type": ["string", "null"]},
            "price_type": {"type": ["string", "null"], "enum": list(PRICE_TYPES) + [None]},
            "dealer_price": {"type": ["null"], "description": "공개 근거 없음. 항상 null."},
            "availability": {"type": ["null"], "description": "공개 근거 없음. 항상 null."},
            "extraction_time": {"type": "string", "format": "date-time"},
            "extraction_method": {"type": "string"},
            "source_evidence": {"type": "object"},
            "verification_status": {"type": "string", "enum": list(VERIFICATION_STATUSES)},
            "derived": {"type": "object"},
            "naver_product_id": {"type": ["string", "null"]},
            "erp_item_code": {"type": ["string", "null"]},
            "smartstore_category_no": {"type": ["string", "null"]},
            "mapping_ready": {"type": "boolean"},
            "quality_flags": {"type": "array", "items": {"type": "string"}},
            "dedupe_group_id": {"type": ["string", "null"]},
            "dedupe_confidence": {"type": ["string", "null"]},
        },
    }


def _jsonable(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, set):
        return sorted(_jsonable(v) for v in value)
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def to_jsonable(record: Mapping[str, Any]) -> dict[str, Any]:
    """레코드를 JSON 직렬화 가능한 dict 로 변환 (필드 순서 고정)."""
    out: dict[str, Any] = {}
    for field_name in MASTER_FIELDS:
        out[field_name] = _jsonable(record.get(field_name))
    return out


def to_csv_row(record: Mapping[str, Any]) -> dict[str, Any]:
    """레코드를 CSV 1행용 dict 로 변환 (중첩은 JSON 문자열)."""
    row: dict[str, Any] = {}
    for field_name in CSV_COLUMNS:
        value = record.get(field_name)
        if value is None:
            row[field_name] = ""
        elif isinstance(value, (dict, list, tuple, set)):
            row[field_name] = json.dumps(_jsonable(value), ensure_ascii=False, sort_keys=True)
        else:
            row[field_name] = value
    return row


def write_csv(records: Iterable[Mapping[str, Any]], path: str) -> int:
    """레코드 목록을 CSV 로 저장. 반환값은 기록된 행 수."""
    count = 0
    with open(path, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(CSV_COLUMNS))
        writer.writeheader()
        for record in records:
            writer.writerow(to_csv_row(record))
            count += 1
    return count


def write_json(records: Sequence[Mapping[str, Any]], path: str) -> None:
    payload = {
        "schema_version": SCHEMA_VERSION,
        "record_count": len(records),
        "records": [to_jsonable(r) for r in records],
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2, sort_keys=False)
        fh.write("\n")


def load_json(path: str) -> list[dict[str, Any]]:
    """``write_json`` 으로 저장한 파일을 읽는다."""
    with open(path, "r", encoding="utf-8") as fh:
        payload = json.load(fh)
    return list(payload.get("records", []))
