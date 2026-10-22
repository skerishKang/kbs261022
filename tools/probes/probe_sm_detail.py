import re, sys, json, time
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, r"D:\1022\1022-0-computeruse\tools")
from samasound_collect import fetch, strip_tags

SM = "https://www.samamusic.co.kr"

print("=== samamusic DETAIL page ===")
d = fetch(f"{SM}/product/detail.html?product_no=4167&cate_no=42&display_group=1")
print("len", len(d) if d else None)
if d:
    open(r"C:\Users\sji\AppData\Local\Temp\opencode\sm_detail.html", "w", encoding="utf-8").write(d)
    print("title:", strip_tags(re.search(r"<title>(.*?)</title>", d, re.S).group(1)))
    print("JSON-LD:", "application/ld+json" in d)
    for m in re.finditer(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', d, re.S):
        print("  LD:", m.group(1)[:700])
    for kw in ["판매가", "제조사", "모델", "상품명", "옵션", "재고"]:
        for m in list(re.finditer(kw, d))[:2]:
            s = max(0, m.start()-150); e = min(len(d), m.end()+220)
            print(f"  [{kw}] ...{re.sub(chr(10)+'+', ' ', d[s:e])}...")
    print("  data-price attrs:", re.findall(r'data-price="([^"]*)"', d)[:8])
    print("  price numbers:", re.findall(r'[0-9][0-9,]{2,}\s*원', d)[:10])
    imgs = sorted(set(re.findall(r'(https?://[^"\']*?/web/product/[a-z/0-9]*?\d+/[0-9a-f]+\.(?:jpg|png|gif))', d)))[:8]
    print("  images:", imgs)

print()
print("=== samamusic brand view (cate 24) ===")
b = fetch(f"{SM}/product/list.html?cate_no=24")
if b:
    brands = re.findall(r'href="(/brand/[^"]+)"', b)
    print("  /brand/ links:", len(set(brands)))
    for x in sorted(set(brands))[:30]:
        print("   ", x)
    cats = re.findall(r'href="(/product/list\.html\?cate_no=\d+)"', b)
    print("  cate links:", len(set(cats)))
    for m in re.finditer(r'<a[^>]+href="(/product/list\.html\?cate_no=(\d+))"[^>]*>(.*?)</a>', b, re.S):
        t = strip_tags(m.group(3))
        if t:
            print(f"   cate {m.group(2)}: {t[:40]}")
