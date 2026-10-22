"""CGI 통합 상품 마스터 (Product Master) — 이슈 #8.

삼아사운드(samasound.co.kr, B2B)와 삼아스토어(samamusic.co.kr, B2C) 두
Cafe24 상점의 공개 상품 정보를 하나의 스키마로 정규화하기 위한 최소 구현.

원칙
----
1. 원천에 없는 값은 채우지 않는다. (issue #8 요구사항 4, 6)
2. 사이트마다 ``cate_no`` 는 별도 namespace 로 관리한다. (요구사항 2)
3. 제조사 / 브랜드 / 모델은 서로 다른 필드로 유지한다. (요구사항 2)
4. 확신 부족한 중복은 자동 병합하지 않는다. (요구사항 3)
"""

__all__ = [
    "normalize",
    "schema",
    "dedupe",
    "validate",
]

SCHEMA_VERSION = "1.0.0"
