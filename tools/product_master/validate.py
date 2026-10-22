"""마스터 레코드 검증.

두 층위로 나눈다.

1. **구조 검증** — 필수 컬럼 존재, 타입, 복합키 유일성.
2. **정책 검증** — 사이트별 필드 가용성, 가격 정책, null 처리 원칙
   (issue #8 요구사항 2, 4, 6).

정책 검증은 "값이 있는 것"이 아니라 "값이 없어야 하는 것"을 잡는다.
예: samasound 레코드에 ``public_price`` 숫자가 들어 있으면 위반.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Mapping, Optional, Sequence

from .schema import (
    MASTER_FIELDS,
    PRICE_TYPES,
    REQUIRED_FIELDS,
    SITES,
    SITE_FIELD_AVAILABILITY,
    VERIFICATION_STATUSES,
    source_key,
)

_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")


def validate_record(record: Mapping[str, Any]) -> list[str]:
    """레코드 1건의 오류 목록. 오류가 없으면 빈 리스트."""
    errors: list[str] = []

    for field_name in REQUIRED_FIELDS:
        if field_name not in record:
            errors.append(f"missing_required_field:{field_name}")

    unknown = set(record) - set(MASTER_FIELDS)
    for field_name in sorted(unknown):
        errors.append(f"unknown_field:{field_name}")

    site = record.get("source_site")
    if site not in SITES:
        errors.append(f"invalid_source_site:{site!r}")
        return errors

    product_id = record.get("source_product_id")
    if not product_id or not str(product_id).strip():
        errors.append("empty_source_product_id")

    name = record.get("name")
    if not name or not str(name).strip():
        errors.append("empty_name")

    canonical = record.get("canonical_url")
    if not canonical or not str(canonical).startswith(("http://", "https://")):
        errors.append(f"invalid_canonical_url:{canonical!r}")

    if not _ISO_RE.match(str(record.get("extraction_time") or "")):
        errors.append(f"invalid_extraction_time:{record.get('extraction_time')!r}")

    status = record.get("verification_status")
    if status not in VERIFICATION_STATUSES:
        errors.append(f"invalid_verification_status:{status!r}")

    price = record.get("public_price")
    if price is not None and (not isinstance(price, int) or isinstance(price, bool) or price < 0):
        errors.append(f"invalid_public_price:{price!r}")

    price_type = record.get("price_type")
    if price_type is not None and price_type not in PRICE_TYPES:
        errors.append(f"invalid_price_type:{price_type!r}")

    namespace = record.get("category_namespace")
    expected_ns = SITES[site]["namespace"]
    if namespace != expected_ns:
        errors.append(f"category_namespace_mismatch:{namespace!r}!={expected_ns!r}")

    return errors


def validate_policy(record: Mapping[str, Any]) -> list[str]:
    """사이트별 필드 가용성 / 가격 정책 위반 목록."""
    errors: list[str] = []
    site = record.get("source_site")
    if site not in SITES:
        return errors
    availability = SITE_FIELD_AVAILABILITY[site]

    # --- 사이트에 없는 필드는 반드시 null 이어야 한다 (요구사항 2, 7) --------
    if not availability["brand"] and record.get("brand") is not None:
        errors.append(f"brand_not_offered_by_site:{record.get('brand')!r}")
    if not availability["manufacturer"] and record.get("manufacturer") is not None:
        errors.append(f"manufacturer_not_offered_by_site:{record.get('manufacturer')!r}")
    if not availability["model"] and record.get("model") is not None:
        errors.append(f"model_not_offered_by_site:{record.get('model')!r}")
    if not availability["english_name"] and "영문상품명" in (record.get("specs") or {}):
        errors.append("english_name_not_offered_by_site")

    # --- 가격 정책 (요구사항 4) ---------------------------------------------
    if record.get("dealer_price") is not None:
        errors.append(f"dealer_price_must_be_null:{record.get('dealer_price')!r}")
    if record.get("availability") is not None:
        errors.append(f"availability_must_be_null:{record.get('availability')!r}")

    price = record.get("public_price")
    price_type = record.get("price_type")
    if price is None and price_type == "public_selling_price":
        errors.append("price_type_public_but_value_null")
    if price is not None and price_type != "public_selling_price":
        errors.append(f"price_value_without_public_type:{price_type!r}")
    if price_type == "inquiry" and price is not None:
        errors.append("inquiry_price_must_not_carry_number")

    # --- ERP / 스토어 매핑은 아직 금지 (이슈 #8: 스토어 개설 전) ------------
    for field_name in ("naver_product_id", "erp_item_code", "smartstore_category_no"):
        if record.get(field_name) is not None:
            errors.append(f"{field_name}_must_be_null_before_store_opens")
    if record.get("mapping_ready") is True:
        errors.append("mapping_ready_must_be_false_before_store_opens")

    return errors


def validate_dataset(records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """전체 레코드 집합 검증 결과."""
    per_record: list[dict[str, Any]] = []
    seen: dict[str, int] = {}
    structural_errors = 0
    policy_errors = 0

    for index, record in enumerate(records):
        errs = validate_record(record)
        perr = validate_policy(record)
        structural_errors += len(errs)
        policy_errors += len(perr)
        key = source_key(record.get("source_site", ""), str(record.get("source_product_id", "")))
        if key in seen:
            errs.append(f"duplicate_composite_key:{key}")
            structural_errors += 1
        else:
            seen[key] = index
        if errs or perr:
            per_record.append(
                {
                    "source_key": key,
                    "structural_errors": errs,
                    "policy_errors": perr,
                }
            )

    return {
        "record_count": len(records),
        "unique_key_count": len(seen),
        "structural_error_count": structural_errors,
        "policy_error_count": policy_errors,
        "ok": structural_errors == 0 and policy_errors == 0,
        "per_record": per_record,
    }


def format_report(result: Mapping[str, Any]) -> str:
    """검증 결과를 사람이 읽을 수 있는 문자열로."""
    lines = [
        f"records={result['record_count']} unique_keys={result['unique_key_count']} "
        f"structural_errors={result['structural_error_count']} "
        f"policy_errors={result['policy_error_count']}",
        f"RESULT={'PASS' if result['ok'] else 'FAIL'}",
    ]
    for item in result.get("per_record", []):
        lines.append(f"  - {item['source_key']}")
        for e in item.get("structural_errors", []):
            lines.append(f"      structural: {e}")
        for e in item.get("policy_errors", []):
            lines.append(f"      policy: {e}")
    return "\n".join(lines)
