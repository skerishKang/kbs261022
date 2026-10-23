"""CGI 상품 DB 품질 개선 (이슈 #43)."""

from __future__ import annotations

from .quality import (
    CLASS_AUTO,
    CLASS_NONE,
    CLASS_REVIEW,
    DuplicateCandidate,
    Patch,
    QualityResult,
    build_inheritance,
    build_manufacturer_evidence,
    build_result,
    brand_patch,
    manufacturer_patch,
    model_patch,
    same_site_duplicates,
    summarize,
)

__all__ = [
    "CLASS_AUTO",
    "CLASS_REVIEW",
    "CLASS_NONE",
    "Patch",
    "DuplicateCandidate",
    "QualityResult",
    "build_manufacturer_evidence",
    "build_inheritance",
    "build_result",
    "brand_patch",
    "manufacturer_patch",
    "model_patch",
    "same_site_duplicates",
    "summarize",
]
