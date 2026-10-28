#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
dalue_export.py — samamusic.co.kr(삼아스토어) 공개 JSON 상품 API(Dalue/DCSE) 클라이언트.

CAFE24 의 새(_wg/G2G) 스킨이 검색 화면에서 사용하는 공개 API 이며, 상품 1,969건과
가격/모델명/브랜드/카테고리 경로/이미지/품절여부를 한 번의 요청으로 돌려준다.
페이지 HTML 스캔보다 훨씬 빠르고 정확하다.

사용:
  python tools/dalue_export.py --size 40 --out reports/dalue-samamusic.json
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

API = "https://api.dalue.io:10806/dcse/query"
API_KEY = "Ak25dpcSKLXu"

V_FIELDS = ("productNo,productName,price,retailPrice,pointsAmount,image,soldOut,pcDiscountPrice,"
            "mobileDiscountPrice,exposureLimitType,exposureGroupList,categoryNos,brandName,display,"
            "selling,productCode,categoryRoot1No,simpleDescription,modelName,icon,iconShowPeriod,"
            "icon,listIcon,summaryDescription,options,priceContent")


def query(mall_id: str = "sama2015", shop_no: str = "1", category_id: str = "",
          brand_code: str = "", begin: int = 1, size: int = 40, timeout: int = 40) -> dict:
    body = {
        "apiKey": API_KEY, "collName": "products", "query": "*", "begin": str(begin), "size": str(size),
        "mallId": mall_id, "shopNo": shop_no, "mallType": "cafe24",
        "categoryIdFields": "categoryRoot1No,categoryRoot2No",
        "categoryNameFields": "categoryRoot1,categoryRoot2",
        "brandIdField": "brandCode", "brandNameField": "brandName",
        "brandCode": brand_code, "categoryId": category_id,
        "rangeFields": "pcDiscountPrice", "rangeValues": "0,9999999999",
        "categoryAuthFieldName": "categoryNos", "categoryAuthDevice": "1", "categoryAuthMemberType": "0",
        "equalFields": "display,selling", "equalValues": "1,1",
        "aclFlagField": "exposureLimitType", "aclFlagValue": "M", "aclField": "exposureGroupList",
        "aclFieldValue": "0", "aclShow": "0",
        "aclRemoveFields": "price,mobilePrice,pcPrice", "priceField": "pcDiscountPrice",
        "priceClusterNo": "3", "sortField": "", "sortType": "", "tagStat": "1",
        "tagFields": "", "tagSeperator": "|", "vFields": V_FIELDS,
    }
    req = urllib.request.Request(API, data=urllib.parse.urlencode(body).encode(),
                                 headers={"Content-Type": "application/x-www-form-urlencoded",
                                          "User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read().decode("utf-8"))
    hdr = out.get("header", {})
    if hdr.get("code") not in (0, "0"):
        raise RuntimeError(f"Dalue error: {hdr}")
    out["items"] = out.get("result") or out.get("results") or []
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mall-id", default="sama2015")
    ap.add_argument("--category-id", default="")
    ap.add_argument("--begin", type=int, default=1)
    ap.add_argument("--size", type=int, default=40)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    out = query(args.mall_id, category_id=args.category_id, begin=args.begin, size=args.size)
    hdr = out["header"]
    print(f"code={hdr.get('code')} totalCount={hdr.get('totalCount')} count={hdr.get('count')}")
    for it in out["items"][:5]:
        print("  ", json.dumps({k: it.get(k) for k in
                                ("productNo", "productName", "pcDiscountPrice", "brandName",
                                 "modelName", "categoryNos", "soldOut")}, ensure_ascii=False)[:300])
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, indent=1)
        print(f"[written] {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
