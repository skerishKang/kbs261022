import re, sys, json, urllib.request, urllib.parse, gzip
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, r"D:\1022\1022-0-computeruse\tools")
from samasound_collect import fetch, strip_tags

SA = "https://www.samasound.co.kr"
SM = "https://www.samamusic.co.kr"

print("=== 1) /exec/front/Product/SubCategory ===")
for label, base in (("samasound", SA), ("samamusic", SM)):
    u = f"{base}/exec/front/Product/SubCategory"
    try:
        req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            ct = r.headers.get("Content-Type")
        data = json.loads(raw.decode("utf-8"))
        roots = [d for d in data if d.get("parent_cate_no") == 1]
        print(f"  {label}: 200 ct={ct} nodes={len(data)} roots={len(roots)}")
        print("   sample:", json.dumps(data[0], ensure_ascii=False)[:220])
        print("   root names:", [(d["cate_no"], d["name"]) for d in roots][:12])
        json.dump(data, open(rf"C:\Users\sji\AppData\Local\Temp\opencode\subcat_{label}.json", "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
    except Exception as e:
        print(f"  {label}: ERROR {e}")

print()
print("=== 2) samasound detail breadcrumb (slug URL form) ===")
for u in [f"{SA}/product/komplete-26-ultimate/3884/category/23/display/1/",
          f"{SA}/product/detail.html?product_no=3826"]:
    d = fetch(u)
    m = re.search(r'<div class="xans-element- xans-product xans-product-headcategory[^"]*"[^>]*>(.*?)</div>', d or "", re.S)
    if m:
        items = re.findall(r'<a href="([^"]*)"[^>]*>([^<]*)</a>|<strong><a href="([^"]*)"[^>]*>([^<]*)</a></strong>', m.group(1))
        flat = [t for g in items for t in g if t]
        print(f"  {u.split('samasound.co.kr')[1][:60]}")
        print("    path:", " > ".join(flat))
    else:
        print(f"  {u}: NO BREADCRUMB")

print()
print("=== 3) samamusic sitemap / rss ===")
for p in ("/sitemap.xml", "/rss.xml"):
    h = fetch(SM + p)
    if h:
        n = len(re.findall(r"<url>|<item>", h))
        print(f"  {p}: 200 len={len(h):,} entries={n}")
    else:
        print(f"  {p}: FAIL")

print()
print("=== 4) Dalue JSON API (samamusic) ===")
body = {
    "apiKey": "Ak25dpcSKLXu", "collName": "products", "query": "*", "begin": "1", "size": "3",
    "mallId": "sama2015", "shopNo": "1", "mallType": "cafe24",
    "categoryIdFields": "categoryRoot1No,categoryRoot2No",
    "categoryNameFields": "categoryRoot1,categoryRoot2",
    "brandIdField": "brandCode", "brandNameField": "brandName", "brandCode": "", "categoryId": "",
    "rangeFields": "pcDiscountPrice", "rangeValues": "0,9999999999",
    "categoryAuthFieldName": "categoryNos", "categoryAuthDevice": "1", "categoryAuthMemberType": "0",
    "equalFields": "display,selling", "equalValues": "1,1",
    "aclFlagField": "exposureLimitType", "aclFlagValue": "M", "aclField": "exposureGroupList",
    "aclFieldValue": "0", "aclShow": "0",
    "aclRemoveFields": "price,mobilePrice,pcPrice", "priceField": "pcDiscountPrice",
    "priceClusterNo": "3", "sortField": "", "sortType": "", "tagStat": "1", "tagFields": "", "tagSeperator": "|",
    "vFields": "productNo,productName,price,retailPrice,pointsAmount,image,soldOut,pcDiscountPrice,"
               "mobileDiscountPrice,exposureLimitType,exposureGroupList,categoryNos,brandName,display,"
               "selling,productCode,categoryRoot1No,simpleDescription,modelName,icon,iconShowPeriod,"
               "icon,listIcon,summaryDescription,options,priceContent",
}
data = urllib.parse.urlencode(body).encode()
try:
    req = urllib.request.Request("https://api.dalue.io:10806/dcse/query", data=data,
                                 headers={"Content-Type": "application/x-www-form-urlencoded",
                                          "User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=40) as r:
        out = json.loads(r.read().decode("utf-8"))
    h = out.get("header", {})
    print(f"  200 code={h.get('code')} msg={h.get('message')} totalCount={h.get('totalCount')} count={h.get('count')}")
    for r0 in (out.get("result") or out.get("results") or [])[:3]:
        print("   ", json.dumps({k: r0.get(k) for k in
                                 ("productNo", "productName", "price", "pcDiscountPrice", "brandName",
                                  "modelName", "categoryRoot1No", "categoryNos", "image", "soldOut")},
                                ensure_ascii=False)[:420])
    print("   categoryNames:", out.get("categoryNames"))
except Exception as e:
    print("  ERROR", e)
