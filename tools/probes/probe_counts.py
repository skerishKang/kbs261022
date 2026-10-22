import re, sys, json, time, html as htmllib
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, r"D:\1022\1022-0-computeruse\tools")
from samasound_collect import fetch, strip_tags

SA = "https://www.samasound.co.kr"

print("=== samasound detail: category breadcrumb ===")
d = fetch(f"{SA}/product/komplete-26-ultimate/3884/category/23/display/1/")
for kw in [" cate_no=", "location.href", "productCategory", "xans-element- xans-category", "depth", "sub_category"]:
    for m in list(re.finditer(kw, d))[:3]:
        s = max(0, m.start()-220); e = min(len(d), m.end()+260)
        print(f"[{kw}] ...{re.sub(r'[\\s]+', ' ', d[s:e])}...")
    print("--")

print()
print("=== EXACT catalog size for samasound cate_no=23 (전체보기) ===")
total = 0
for page in (1, 112):
    h = fetch(f"{SA}/product/list.html?cate_no=23&page={page}")
    cards = re.findall(r'id="anchorBoxId_(\d+)"', h) if h else []
    print(f"  page {page}: {len(cards)} cards")
    if page == 1:
        total = len(cards)
# 마지막 페이지
h = fetch(f"{SA}/product/list.html?cate_no=23&page=112")
last = re.findall(r'id="anchorBoxId_(\d+)"', h) if h else []
print(f"  page 112 (last): {len(last)} cards  -> total ~= {(112-1)*total + len(last)}")
ids = set()
for page in range(1, 6):
    hh = fetch(f"{SA}/product/list.html?cate_no=23&page={page}")
    if hh:
        ids.update(re.findall(r'id="anchorBoxId_(\d+)"', hh))
print(f"  unique ids over 5 pages: {len(ids)} (dup check ok: {len(ids) == 5*total})")
mx = max(int(i) for i in ids)
print(f"  max product id seen: {mx}")

print()
print("=== EXACT catalog size for samamusic cate_no=1152 (프로모션) + total ===")
SM = "https://www.samamusic.co.kr"
for no in (1152, 42, 379):
    h = fetch(f"{SM}/product/list.html?cate_no={no}")
    pages = max([int(m.group(1)) for m in re.finditer(r'page=(\d+)"', h)] or [0]) if h else 0
    per = len(re.findall(r'id="anchorBoxId_\d+"', h)) if h else 0
    hl = fetch(f"{SM}/product/list.html?cate_no={no}&page={pages}") if pages else None
    lastn = len(re.findall(r'id="anchorBoxId_\d+"', hl)) if hl else 0
    print(f"  cate {no}: pages={pages} per_page={per} last_page_items={lastn} -> total~{(pages-1)*per + lastn if pages else 0}")
