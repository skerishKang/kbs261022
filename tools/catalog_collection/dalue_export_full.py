#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dalue_export_full.py -- 삼아스토어(cafe24) 공개 검색 API(Dalue/DCSE) 로 **스토어 전체 인덱스** 를 덤프한다.

왜 필요한가
  - 카테고리 목록 크롤은 **공개 진열분**만 잡는다. 스토어 내부 인덱스는 비노출(display=0)·판매중지(selling=0)·
    품절 상품을 더 많이 담는다. "20,000개 상품" 주장과의 간극을 수치로 설명하려면 이 구분이 필수다.
  - API 키는 **스토어 공개 페이지에 이미 노출된 검색 키**다(개인 자격증명 아님).
    하드코딩하지 않고 --api-key / 환경변수 DALUE_API_KEY 로만 받는다.

사용
  export DALUE_API_KEY=...
  python tools/full_catalog/dalue_export_full.py --out .work/full_catalog/triB_dalue_full.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

API = "https://api.dalue.io:10806/dcse/query"
V_FIELDS = (
    "productNo,productName,price,retailPrice,pointsAmount,image,soldOut,pcDiscountPrice,"
    "mobileDiscountPrice,exposureLimitType,exposureGroupList,categoryNos,brandName,display,"
    "selling,productCode,categoryRoot1No,categoryRoot2No,categoryRoot1,categoryRoot2,"
    "simpleDescription,modelName,icon,iconShowPeriod,"
    "listIcon,summaryDescription,options,priceContent"
)


def query(api_key: str, begin: int = 1, size: int = 200, equal: Optional[str] = None,
          mall_id: str = "sama2015", shop_no: str = "1") -> Dict[str, Any]:
    body: Dict[str, str] = {
        "apiKey": api_key, "collName": "products", "query": "*", "begin": str(begin), "size": str(size),
        "mallId": mall_id, "shopNo": shop_no, "mallType": "cafe24",
        "categoryIdFields": "categoryRoot1No,categoryRoot2No",
        "categoryNameFields": "categoryRoot1,categoryRoot2",
        "brandIdField": "brandCode", "brandNameField": "brandName",
        "brandCode": "", "categoryId": "",
        "rangeFields": "pcDiscountPrice", "rangeValues": "0,9999999999",
        "categoryAuthFieldName": "categoryNos", "categoryAuthDevice": "1", "categoryAuthMemberType": "0",
        "aclFlagField": "exposureLimitType", "aclFlagValue": "M", "aclField": "exposureGroupList",
        "aclFieldValue": "0", "aclShow": "0",
        "aclRemoveFields": "price,mobilePrice,pcPrice", "priceField": "pcDiscountPrice",
        "priceClusterNo": "3", "sortField": "", "sortType": "", "tagStat": "1",
        "tagFields": "", "tagSeperator": "|", "vFields": V_FIELDS,
    }
    if equal is not None:
        body["equalFields"] = "display,selling"
        body["equalValues"] = equal
    req = urllib.request.Request(
        API, data=urllib.parse.urlencode(body).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        out = json.loads(r.read().decode("utf-8"))
    hdr = out.get("header", {})
    if hdr.get("code") not in (0, "0"):
        raise RuntimeError(f"Dalue error: {hdr}")
    out["items"] = out.get("result") or out.get("results") or []
    return out


def export_all(api_key: str, mall_id: str = "sama2015", shop_no: str = "1",
               size: int = 200, delay: float = 0.12) -> Dict[str, Any]:
    items: List[Dict[str, Any]] = []
    begin, total = 1, 0
    while True:
        out = query(api_key, begin=begin, size=size, mall_id=mall_id, shop_no=shop_no)
        total = int(out["header"]["totalCount"])
        batch = out["items"]
        items.extend(batch)
        if not batch or len(items) >= total:
            break
        begin += size
        time.sleep(delay)
    return {"header": {"totalCount": total, "fetched": len(items)}, "items": items}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api-key", default=os.environ.get("DALUE_API_KEY", ""))
    ap.add_argument("--mall-id", default="sama2015")
    ap.add_argument("--shop-no", default="1")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    if not args.api_key:
        ap.error("--api-key 또는 환경변수 DALUE_API_KEY 필요")
    out = export_all(args.api_key, args.mall_id, args.shop_no)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print(f"totalCount={out['header']['totalCount']} fetched={out['header']['fetched']} -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
