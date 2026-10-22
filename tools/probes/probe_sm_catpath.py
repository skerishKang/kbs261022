import re, sys, json, urllib.request, urllib.parse
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, r"D:\1022\1022-0-computeruse\tools")
from samasound_collect import fetch, strip_tags

SM = "https://www.samamusic.co.kr"
d = fetch(f"{SM}/product/detail.html?product_no=4167&cate_no=42&display_group=1")
print("=== detail page: category-ish elements ===")
for pat in [r'category-lnb[^>]*>', r'xans-layout-category[^>]*>', r'class="[^"]*category[^"]*"',
            r'cate_no=(\d+)', r'category_no=(\d+)']:
    hits = list(re.finditer(pat, d))[:4]
    for m in hits:
        s = max(0, m.start()-120); e = min(len(d), m.end()+180)
        print(f"  [{pat}] ...{re.sub(chr(10)+'+', ' ', d[s:e])}...")
    print("  --")

print()
print("=== detail page: link labels containing a category path ===")
for m in re.finditer(r'<a[^>]+href="([^"]*cate_no=\d+[^"]*)"[^>]*>(.*?)</a>', d, re.S):
    t = strip_tags(m.group(2))
    if t:
        print(f"   {m.group(1)[:60]:<62} {t[:50]}")

print()
print("=== list page cate 84 : child category links ===")
l = fetch(f"{SM}/product/list.html?cate_no=84")
seen = {}
for m in re.finditer(r'<a[^>]+href="([^"]*cate_no=(\d+)[^"]*)"[^>]*>(.*?)</a>', l, re.S):
    t = strip_tags(m.group(3))
    if t:
        seen.setdefault(int(m.group(2)), (t, m.group(1)))
for k in sorted(seen):
    print(f"   cate_no={k:<6} {seen[k][0][:44]:<46} {seen[k][1][:60]}")
