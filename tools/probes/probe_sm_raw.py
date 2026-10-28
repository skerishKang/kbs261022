import re, sys, json, time
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, r"D:\1022\1022-0-computeruse\tools")
from samasound_collect import fetch, strip_tags

SM = "https://www.samamusic.co.kr"

print("=== RAW HTTP: does samamusic HTML contain numeric prices? ===")
h = fetch(f"{SM}/product/list.html?cate_no=42")
if h:
    dp = re.findall(r'data-price="([^"]*)"', h)
    print("  data-price attrs found:", len(dp), "sample:", dp[:8])
    print("  literal '원' price strings:", len(re.findall(r'[0-9][0-9,]{2,}\s*원', h)))
    print("  placeholder {$pcDiscountPrice} count:", h.count('{$pcDiscountPrice}'))
    cards = re.findall(r'<li[^>]*id="anchorBoxId_(\d+)"[^>]*>', h)
    print("  anchorBoxId cards:", len(cards))
    names = re.findall(r'class="name">.*?<span[^>]*>([^<]{3,90})</span>', h, re.S)
    print("  SSR names sample:", [strip_tags(x) for x in names[:4]])
    print("  JSON-LD present:", "application/ld+json" in h)
    for m in re.finditer(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', h, re.S):
        print("   LD:", m.group(1)[:400])

print()
print("=== samamusic category tree (from homepage nav + list pages) ===")
home = fetch(f"{SM}/")
cats = {}
if home:
    for m in re.finditer(r'<a[^>]+href="(/product/list\.html\?cate_no=(\d+))"[^>]*>(.*?)</a>', home, re.S):
        t = strip_tags(m.group(3))
        if t:
            cats.setdefault(int(m.group(2)), (t, m.group(1)))
    # 2단계 카테고리도 시도
    for m in re.finditer(r'<a[^>]+href="(/product/list\.html\?cate_no=(\d+)[^"]*)"[^>]*>(.*?)</a>', home, re.S):
        t = strip_tags(m.group(3))
        if t:
            cats.setdefault(int(m.group(2)), (t, m.group(1)))
print(f"  nav categories found: {len(cats)}")
rows = []
for no in sorted(cats):
    name, href = cats[no]
    html = fetch(f"{SM}/product/list.html?cate_no={no}")
    pages, per = 0, 0
    if html:
        for pm in re.finditer(r'page=(\d+)"', html):
            pages = max(pages, int(pm.group(1)))
        per = len(re.findall(r'id="anchorBoxId_\d+"', html))
    rows.append({"cate_no": no, "name": name, "pages": pages, "per_page": per,
                 "est_products": pages * per})
    print(f"  cate_no={no:<6} {name:<22} pages={pages:<4} per={per:<3} est={pages*per}")
    time.sleep(0.2)

json.dump(rows, open(r"C:\Users\sji\AppData\Local\Temp\opencode\sm_cats.json", "w", encoding="utf-8"),
          ensure_ascii=False, indent=2)
