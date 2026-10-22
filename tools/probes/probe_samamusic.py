import re, sys, json, time
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, r"D:\1022\1022-0-computeruse\tools")
from samasound_collect import fetch, strip_tags

home = open(r"C:\Users\sji\AppData\Local\Temp\opencode\home.html", encoding="utf-8").read()

print("=== inline scripts mentioning allCate / category ajax ===")
for m in re.finditer(r'<script[^>]*>(.*?)</script>', home, re.S):
    s = m.group(1)
    if re.search(r'allCate|category|Cate', s) and ('ajax' in s.lower() or 'url' in s.lower() or 'get(' in s.lower() or 'Cate' in s):
        t = re.sub(r"\s+", " ", s).strip()
        if len(t) < 2500:
            print(t[:2500])
            print("-----")

print()
print("=== external script srcs (may hold the category loader) ===")
for m in re.finditer(r'<script[^>]+src="([^"]+)"', home):
    print(" ", m.group(1))

print()
print("############### samamusic.co.kr ###############")
s = "https://www.samamusic.co.kr/"
try:
    h = fetch(s, timeout=40)
except Exception as e:
    print("fetch error:", e); h = None
if h:
    open(r"C:\Users\sji\AppData\Local\Temp\opencode\samamusic.html", "w", encoding="utf-8").write(h)
    print("len", len(h))
    t = re.search(r"<title>(.*?)</title>", h, re.S)
    print("title:", strip_tags(t.group(1)) if t else "?")
    print("platform markers:")
    for pat in ["cafe24", "godo", "imweb", "makeshop", "Cafe24", "smartstore", "naver", "shopify", "woocommerce"]:
        if pat.lower() in h.lower():
            print("  -", pat)
    print("--- links (first 60 unique) ---")
    seen = set()
    for m in re.finditer(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', h, re.S):
        href = m.group(1); txt = strip_tags(m.group(2))
        if href in seen: continue
        seen.add(href)
        print(f"  {txt[:40]!r:<44} {href[:100]}")
        if len(seen) > 60: break
else:
    print("SAMAMUSIC FETCH FAILED")
