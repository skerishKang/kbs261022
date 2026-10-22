import re, sys, json, time
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, r"D:\1022\1022-0-computeruse\tools")
from samasound_collect import fetch, strip_tags

SA = "https://www.samasound.co.kr"
SM = "https://www.samamusic.co.kr"

print("=== samasound cate_no=25 : is a SUB-CATEGORY tree exposed in SSR? ===")
h = fetch(f"{SA}/product/list.html?cate_no=25")
checks = {
    "xans-category block": 'xans-element- xans-category' in h,
    "select filter": bool(re.search(r'<select[^>]*name="?category', h, re.I)),
    "option tags": len(re.findall(r'<option', h)),
    "sub-category hrefs (/product/list.html?cate_no=..&sub)": len(re.findall(r'sub_cate|cate_no=\d+&', h)),
    "breadcrumb": bool(re.search(r'location\.pathname|depth|parent_cate', h)),
    "leftCategory module": 'leftCategory' in h,
}
for k, v in checks.items():
    print(f"  {k}: {v}")
print("  -- all <option> samples --")
for m in list(re.finditer(r'<option[^>]*>([^<]{0,60})</option>', h))[:20]:
    print("   ", m.group(1).strip())

print()
print("=== samasound: does /product/list.html?cate_no=23 expose child categories? ===")
h2 = fetch(f"{SA}/product/list.html?cate_no=23")
print("   xans-category:", 'xans-element- xans-category' in h2)
print("   cate_no links in page:", sorted(set(int(m.group(1)) for m in re.finditer(r'cate_no=(\d+)', h2))))

print()
print("=== samamusic total product count via search endpoint ===")
for q in ("", "a"):
    u = f"{SM}/shopSearch/search.html?query={q}&begin=1&size=1&brandeCode="
    hh = fetch(u)
    if not hh:
        print(f"  query={q!r}: FAIL")
        continue
    m = re.search(r'"total"\s*:\s*(\d+)', hh) or re.search(r'totalCount["\']?\s*[:=]\s*(\d+)', hh)
    t = re.search(r'<title>(.*?)</title>', hh, re.S)
    print(f"  query={q!r}: len={len(hh)} total_match={m.group(1) if m else None} title={strip_tags(t.group(1))[:40] if t else '?'}")
    for k in ("totalCount", '"total"', "productCount", "recordCount"):
        for mm in list(re.finditer(re.escape(k) + r'["\']?\s*[:=]\s*["\']?(\d+)', hh))[:3]:
            print(f"    {k} -> {mm.group(1)}")

print()
print("=== samamusic: sub-category tree exposed? ===")
h3 = fetch(f"{SM}/product/list.html?cate_no=42")
print("   xans-category:", 'xans-element- xans-category' in h3)
print("   cate_no links:", sorted(set(int(m.group(1)) for m in re.finditer(r'cate_no=(\d+)', h3))))
