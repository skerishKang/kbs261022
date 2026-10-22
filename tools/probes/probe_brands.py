import re, sys, json, time
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, r"D:\1022\1022-0-computeruse\tools")
from samasound_collect import fetch, strip_tags, BASE

home = open(r"C:\Users\sji\AppData\Local\Temp\opencode\home.html", encoding="utf-8").read()

print("=== allCate_l fill / ajax endpoints ===")
for m in re.finditer(r'allCate_l', home):
    s = max(0, m.start() - 400); e = min(len(home), m.end() + 400)
    print(re.sub(r"\s+", " ", home[s:e]))
    print("-----")

print()
print("=== brand carousel mapping (cate_no -> brand logo) ===")
pairs = []
for m in re.finditer(
        r'<a[^>]+href="/product/list\.html\?cate_no=(\d+)"[^>]*>\s*<div>\s*<img[^>]+src="([^"]+)"',
        home):
    pairs.append((int(m.group(1)), m.group(2)))
print(f"found {len(pairs)} brand links")
for no, img in pairs:
    print(f"  cate_no={no:<5} logo={img}")

print()
print("=== resolve brand names via category_name in list page ===")
resolved = []
for no, img in pairs:
    html = fetch(f"{BASE}/product/list.html?cate_no={no}")
    name = ""
    if html:
        m = re.search(r'"category_no":(\d+),"category_name":"([^"]*)"', html)
        if m:
            name = m.group(2)
        t = re.search(r"<title>(.*?)</title>", html, re.S)
    pages = 0
    if html:
        for pm in re.finditer(r'page=(\d+)"', html):
            pages = max(pages, int(pm.group(1)))
    resolved.append({"cate_no": no, "brand_name": name, "logo": img, "pages": pages,
                     "est_products": pages * 20})
    print(f"  cate_no={no:<5} {name:<28} pages={pages:<4} est={pages*20:<6} {img}")
    time.sleep(0.15)

json.dump(resolved, open(r"C:\Users\sji\AppData\Local\Temp\opencode\brands.json", "w", encoding="utf-8"),
          ensure_ascii=False, indent=2)
print("\nTOTAL est across brands:", sum(r["est_products"] for r in resolved))
